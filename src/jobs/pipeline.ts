import { withHeavyAdmission, cliAdmissionWait } from '../runtime/heavy-admission';
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { getDefaultJobStateDir, hashFile } from "./store";
import { writePrivateArtifact } from "./artifacts";
import { hasSavedRevision } from "../revisions/service";
import { withRevisionLease, RevisionConflictError } from "../revisions";
import { join, dirname } from "node:path";
import type { AppConfig } from "../config/defaults";
import { summarizeWithOllama } from "../summary/ollama";
import { summarizeWithOpenAI } from "../summary/openai";
import { runVisualSession, type LocalVisualAdapter, type ManualVisualConsent } from "../visual/session";
import {validatePipelineVisualReview,withPipelineVisualClaim,pipelineSessionIdentity,commitPipelineVisualReview} from '../visual/pipeline-review';
import {VisualAppBudget} from "../visual/app-budget";
import { summarizeInChunks } from "../summary/chunks";
import { summaryInputLimit } from "../summary/budget";
import { transcribeWithOpenAI } from "../transcription/openai";
import { transcribeWithGemini } from "../transcription/gemini";
import { transcribeWithWhisperCpp } from "../transcription/whisperCpp";
import { formatSummaryMarkdown, formatTranscriptMarkdown } from "./format";
import { probeMedia } from "./media";
import {
  type JobManifest,
  type Transcript,
  validateTranscript
} from "./types";

export const assertUsableTranscript = (transcript: Transcript): void => {
  const hasText =
    transcript.text.trim().length > 0 ||
    transcript.segments.some((segment) => segment.text.trim().length > 0);
  if (!hasText) {
    throw new Error(
      "Transcrição vazia: o áudio pode estar ausente ou silencioso, ou o provedor retornou uma resposta vazia"
    );
  }
};

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const transcriptionIdentity = (manifest: JobManifest): string => digest(JSON.stringify({media:manifest.source.sha256,transcription:manifest.transcription}));
const assertUnreviewedPublication = async (jobId: string): Promise<void> => {
  if (await hasSavedRevision(jobId)) throw new RevisionConflictError("Revisão humana existente: o processamento original foi recusado. Use a regeneração vinculada à revisão; os artefatos foram preservados.");
};
const publishOriginal = async <T>(jobId: string, publish: () => Promise<T>): Promise<T> =>
  withRevisionLease(jobId, async () => { await assertUnreviewedPublication(jobId); return publish(); });
const loadReusableTranscript = async (outputDir: string, manifest: JobManifest): Promise<{transcript:Transcript;legacy:boolean} | null> => {
  const path = join(outputDir, "transcript.json");
  const stat = await fs.lstat(path).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 20*1024*1024) throw new Error("Unsafe transcript cache; preserved, no provider retry");
  const raw = await fs.readFile(path,"utf8");
  // Corrupt or incompatible caches fail closed: never silently repeat a potentially paid upload.
  const transcript = validateTranscript(JSON.parse(raw));
  if (transcript.provider !== manifest.transcription.provider || transcript.model !== manifest.transcription.model || transcript.language !== manifest.transcription.language) throw new Error("Transcript cache settings mismatch; explicit regeneration required");
  const receiptPath=join(outputDir,"transcript-receipt.json");
  const receiptStat=await fs.lstat(receiptPath).catch(error=>{if(error.code==='ENOENT')return undefined;throw error;});
  if(!receiptStat)return {transcript,legacy:true};
  if(!receiptStat.isFile()||receiptStat.isSymbolicLink()||receiptStat.size>4096)throw new Error("Unsafe transcript receipt");
  const receipt=JSON.parse(await fs.readFile(receiptPath,"utf8"));
  if(receipt.version!==1||receipt.identity!==transcriptionIdentity(manifest)||receipt.transcriptSha256!==digest(raw))throw new Error("Transcript cache identity/hash mismatch; preserved, no provider retry");
  return {transcript,legacy:false};
};

const processJobOwned = async (
  config: AppConfig,
  manifest: JobManifest,
  sourcePath: string,
  outputDir: string,
  options: { signal?: AbortSignal; visual?: { root: string; adapter: LocalVisualAdapter; ttlSeconds?: number; manual?: ManualVisualConsent; review?:{id:string;consent:boolean;consentKey:string} } } = {}
): Promise<void|{committedGrantId:string}> => {
  options.signal?.throwIfAborted();
  await assertUnreviewedPublication(manifest.id);
  await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
  let transcriptionWorkDir: string | undefined;
  try {
    const reusable = await loadReusableTranscript(outputDir, manifest);
    let transcript = reusable?.transcript;
    if(options.visual&&(!transcript||!options.visual.review))throw Error('Pipeline visual review requires an existing transcript and fresh scoped preview consent');
    if (transcript) assertUsableTranscript(transcript);
    if (await hashFile(sourcePath) !== manifest.source.sha256) throw new Error("Source media hash differs from manifest; no provider request");
    if (!transcript) {
      await probeMedia(sourcePath, options.signal);
      transcriptionWorkDir = await fs.mkdtemp(join(outputDir,".transcription-"));
      await assertUnreviewedPublication(manifest.id);
      transcript =
        manifest.transcription.provider === "openai"
          ? await transcribeWithOpenAI(
              config,
              sourcePath,
              transcriptionWorkDir,
              manifest.transcription.model,
              manifest.transcription.language,
              manifest.transcription.prompt,
              manifest.transcription.languages,
              manifest.transcription.keywords,
              options.signal
            )
          : manifest.transcription.provider === "gemini"
            ? await transcribeWithGemini(
                sourcePath,
                transcriptionWorkDir,
                manifest.transcription.model,
                manifest.transcription.language,
                options.signal
              )
            : await transcribeWithWhisperCpp(
              config,
              sourcePath,
              transcriptionWorkDir,
              manifest.transcription.model,
              manifest.transcription.language,
              options.signal
          );
    }
    assertUsableTranscript(transcript);
    const transcriptSnapshot = transcript;
    options.signal?.throwIfAborted();
    if (await hashFile(sourcePath) !== manifest.source.sha256) throw new Error("Source changed during transcription; artifacts not published");
    await publishOriginal(manifest.id, async () => { if (!reusable) {
      const raw = JSON.stringify(transcriptSnapshot, null, 2);
      await writePrivateArtifact(join(outputDir,"transcript.json"),raw);
      await writePrivateArtifact(join(outputDir,"transcript-receipt.json"),JSON.stringify({version:1,identity:transcriptionIdentity(manifest),transcriptSha256:digest(raw)}));
    }
    await writePrivateArtifact(join(outputDir, "transcript.md"), formatTranscriptMarkdown(transcriptSnapshot));
    });

    if(options.visual&&manifest.summary.provider!=='ollama')throw Error('Scoped visual pipeline supports local Ollama summary only');
    const summaryIdentity=JSON.stringify({provider:manifest.summary.provider,model:manifest.summary.model,endpoint:config.summary.ollamaUrl});
    const validateReview=async()=>options.visual?validatePipelineVisualReview({...options.visual.review!,transcript:transcript!,mediaHash:manifest.source.sha256,duration:await probeMedia(sourcePath,options.signal),adapter:options.visual.adapter,adapterIdentity:options.visual.adapter.identity,summaryIdentity,policy:config.visualReview,signal:options.signal}):undefined;
    const scoped=await validateReview();
    if(options.visual?.manual&&(options.visual.manual.consent!==true||options.visual.manual.planKey!==scoped!.review.planKey||digest(JSON.stringify(options.visual.manual.requests))!==digest(JSON.stringify(scoped!.review.requests))))throw Error('Legacy pipeline consent differs from approved preview');
    const appBudget=options.visual?new VisualAppBudget(join(dirname(getDefaultJobStateDir()),'visual-review')):undefined;
    const budgetIdentity=digest(JSON.stringify({media:manifest.source.sha256,transcript,visualAdapter:options.visual?.adapter.identity,summaryProvider:manifest.summary.provider,summaryModel:manifest.summary.model}));
    const visualAdapter=options.visual?{...options.visual.adapter,identity:pipelineSessionIdentity(options.visual.adapter.identity,scoped!.review),
      select:async()=>{throw Error('Pipeline selection requires separate scoped planner/preview; cannot infer images in one call');},
      inspect:async(input:Parameters<LocalVisualAdapter['inspect']>[0],signal?:AbortSignal)=>{const approved=await validateReview();if(digest(JSON.stringify(input.frames.map(({file,timestampSeconds,sha256,bytes})=>({file,timestampSeconds,sha256,bytes}))))!==digest(JSON.stringify(approved!.review.frames)))throw Error('Pipeline frames changed after consent');await appBudget!.reserve('inference',manifest.id,budgetIdentity,config.visualReview,true,scoped!.review.policyRevision);signal?.throwIfAborted();await assertUnreviewedPublication(manifest.id);return options.visual!.adapter.inspect(input,signal);}
    }:undefined;
    const visual = options.visual ? await runVisualSession({
      mediaHash: manifest.source.sha256, transcript, durationSeconds: await probeMedia(sourcePath, options.signal), sourcePath,
      root: options.visual.root, adapter: visualAdapter!, ttlSeconds: options.visual.ttlSeconds, manual: {requests:scoped!.review.requests,planKey:scoped!.review.planKey,consent:true,origin:scoped!.review.origin==='planner'?'planner':undefined}, signal: options.signal
    }) : undefined;
    if(options.visual&&(visual?.expired||!visual?.observations.length||visual.expiresAt<=Date.now()))throw Error('Pipeline visual evidence expired/unavailable; no summary inference permitted');
    const visualEvidence = visual?.observations.length ? {
      adapterIdentity: options.visual!.adapter.identity, expiresAt: visual.expiresAt,
      observations: visual.observations.map(({timestampSeconds,frameSha256,text,uncertainty}) => ({timestampSeconds,frameSha256,text,uncertainty}))
    } : undefined;
    const inputLimit = summaryInputLimit(config, manifest.summary.provider, manifest.summary.model);
    const summary = await summarizeInChunks({
      transcript, segmentIds:scoped?.scope.segments.map(s=>s.id), mediaHash: manifest.source.sha256, context: scoped?undefined:manifest.summary.context, visual: visualEvidence,
      maxCharacters: inputLimit.max, inputUnit: inputLimit.unit, legacyMaxCharacters: config.summary.maxInputCharacters, provider: manifest.summary.provider,
      model: manifest.summary.model, adapterIdentity: manifest.summary.provider === "ollama" ? config.summary.ollamaUrl : "openai-chat", cacheDir: join(outputDir, ".summary-chunks"), signal: options.signal,
      adapter: async(part, signal) => {
        await assertUnreviewedPublication(manifest.id);
        if(appBudget){await validateReview();await appBudget.reserve('inference',manifest.id,budgetIdentity,config.visualReview,true,scoped!.review.policyRevision);}
        await assertUnreviewedPublication(manifest.id);
        signal?.throwIfAborted();return manifest.summary.provider === "openai"
        ? summarizeWithOpenAI(config, part.text, manifest.summary.model, scoped?undefined:manifest.summary.context, part.evidence, signal)
        : summarizeWithOllama(config, part.text, manifest.summary.model, scoped?undefined:manifest.summary.context, part.evidence, signal);
      }
    });
    if (visualEvidence) {
      summary.support!.reviewRequired = true;
      summary.limitations = [...(summary.limitations || []), "Evidência visual seletiva requer revisão; um frame representa somente seu instante e suas observações não são prova semântica."];

    }
    if (reusable?.legacy) {
      summary.support!.reviewRequired = true;
      summary.limitations = [...(summary.limitations || []), "Transcrição legada: mídia verificada, parâmetros originais completos não comprovados; revisar antes de reutilizar decisões."];
    }
    if (visual?.expired) {
      summary.support!.reviewRequired = true;
      summary.limitations = [...(summary.limitations || []), "Evidência visual expirada; este resumo utiliza somente a transcrição e requer revisão das referências visuais."];
    }
    options.signal?.throwIfAborted();
    if (await hashFile(sourcePath) !== manifest.source.sha256) throw new Error("Source changed during summary; artifacts not published");
    if(options.visual)await validateReview();
    if(scoped)summary.limitations=[...(summary.limitations||[]),"Resumo parcial do intervalo selecionado; restante omitido."];
    const summaryPrefix=scoped?"visual-summary":"summary";
    const summaryJson=JSON.stringify(summary,null,2);
    // Sidecars bind to exact summary bytes; summary.json is the final commit file.
    const publish=async()=>{
    await writePrivateArtifact(join(outputDir,summaryPrefix+".md"),formatSummaryMarkdown(summary));
    if (visualEvidence) await writePrivateArtifact(join(outputDir,scoped?'visual-summary-evidence.json':'visual-evidence.json'),JSON.stringify({version:1,summarySha256:digest(summaryJson),mediaSha256:manifest.source.sha256,...visualEvidence},null,2));
    else await fs.unlink(join(outputDir,scoped?'visual-summary-evidence.json':'visual-evidence.json')).catch(error=>{if(error.code!=='ENOENT')throw error;});
    await writePrivateArtifact(join(outputDir,summaryPrefix+".json"),summaryJson);
    };return await publishOriginal(manifest.id, async () => {
      if(scoped)return await commitPipelineVisualReview(scoped.review.id,scoped.review.consentKey,{jobId:manifest.id,outputDir,sessionRoot:options!.visual!.root},publish);
      await publish();
    });
  } finally {
    if (transcriptionWorkDir) await fs.rm(transcriptionWorkDir, {recursive:true,force:true});
  }
};

export const processJob = (...args: Parameters<typeof processJobOwned>): Promise<void> =>
  withHeavyAdmission('pipeline',args[1].id,async()=>{const [config,manifest,sourcePath,outputDir,options]=args;await assertUnreviewedPublication(manifest.id);if(!options?.visual){await processJobOwned(...args);return;}const grant=options.visual.review;if(!grant)throw Error('Pipeline requires scoped preview consent');const cached=await loadReusableTranscript(outputDir,manifest);if(!cached)throw Error('Pipeline visual review requires existing transcript');if(await hashFile(sourcePath)!==manifest.source.sha256)throw Error('Pipeline source changed');await validatePipelineVisualReview({...grant,transcript:cached.transcript,mediaHash:manifest.source.sha256,duration:await probeMedia(sourcePath,options.signal),adapter:options.visual.adapter,adapterIdentity:options.visual.adapter.identity,summaryIdentity:JSON.stringify({provider:manifest.summary.provider,model:manifest.summary.model,endpoint:config.summary.ollamaUrl}),policy:config.visualReview,signal:options.signal});return withPipelineVisualClaim(grant.id,grant.consentKey,{jobId:manifest.id,outputDir,sessionRoot:options.visual.root},()=>processJobOwned(...args));},{signal:args[4]?.signal,onWait:cliAdmissionWait});
