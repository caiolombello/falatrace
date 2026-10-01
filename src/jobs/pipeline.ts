import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { hashFile } from "./store";
import { writePrivateArtifact } from "./artifacts";
import { join } from "node:path";
import type { AppConfig } from "../config/defaults";
import { summarizeWithOllama } from "../summary/ollama";
import { summarizeWithOpenAI } from "../summary/openai";
import { runVisualSession, type LocalVisualAdapter } from "../visual/session";
import { summarizeInChunks } from "../summary/chunks";
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

export const processJob = async (
  config: AppConfig,
  manifest: JobManifest,
  sourcePath: string,
  outputDir: string,
  options: { signal?: AbortSignal; visual?: { root: string; adapter: LocalVisualAdapter; ttlSeconds?: number } } = {}
): Promise<void> => {
  options.signal?.throwIfAborted();
  await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
  let transcriptionWorkDir: string | undefined;
  try {
    const reusable = await loadReusableTranscript(outputDir, manifest);
    let transcript = reusable?.transcript;
    if (transcript) assertUsableTranscript(transcript);
    if (await hashFile(sourcePath) !== manifest.source.sha256) throw new Error("Source media hash differs from manifest; no provider request");
    if (!transcript) {
      await probeMedia(sourcePath, options.signal);
      transcriptionWorkDir = await fs.mkdtemp(join(outputDir,".transcription-"));
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
    options.signal?.throwIfAborted();
    if (await hashFile(sourcePath) !== manifest.source.sha256) throw new Error("Source changed during transcription; artifacts not published");
    if (!reusable) {
      const raw = JSON.stringify(transcript, null, 2);
      await writePrivateArtifact(join(outputDir,"transcript.json"),raw);
      await writePrivateArtifact(join(outputDir,"transcript-receipt.json"),JSON.stringify({version:1,identity:transcriptionIdentity(manifest),transcriptSha256:digest(raw)}));
    }
    await writePrivateArtifact(join(outputDir, "transcript.md"), formatTranscriptMarkdown(transcript));

    const visual = options.visual ? await runVisualSession({
      mediaHash: manifest.source.sha256, transcript, durationSeconds: await probeMedia(sourcePath, options.signal), sourcePath,
      root: options.visual.root, adapter: options.visual.adapter, ttlSeconds: options.visual.ttlSeconds, signal: options.signal
    }) : undefined;
    const visualEvidence = visual?.observations.length ? {
      adapterIdentity: options.visual!.adapter.identity, expiresAt: visual.expiresAt,
      observations: visual.observations.map(({timestampSeconds,frameSha256,text,uncertainty}) => ({timestampSeconds,frameSha256,text,uncertainty}))
    } : undefined;
    const summary = await summarizeInChunks({
      transcript, mediaHash: manifest.source.sha256, context: manifest.summary.context, visual: visualEvidence,
      maxCharacters: config.summary.maxInputCharacters, provider: manifest.summary.provider,
      model: manifest.summary.model, adapterIdentity: manifest.summary.provider === "ollama" ? config.summary.ollamaUrl : "openai-chat", cacheDir: join(outputDir, ".summary-chunks"), signal: options.signal,
      adapter: (part, signal) => manifest.summary.provider === "openai"
        ? summarizeWithOpenAI(config, part.text, manifest.summary.model, manifest.summary.context, part.evidence, signal)
        : summarizeWithOllama(config, part.text, manifest.summary.model, manifest.summary.context, part.evidence, signal)
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
    const summaryJson=JSON.stringify(summary,null,2);
    // Sidecars bind to exact summary bytes; summary.json is the final commit file.
    await writePrivateArtifact(join(outputDir,"summary.md"),formatSummaryMarkdown(summary));
    if (visualEvidence) await writePrivateArtifact(join(outputDir,"visual-evidence.json"),JSON.stringify({version:1,summarySha256:digest(summaryJson),mediaSha256:manifest.source.sha256,...visualEvidence},null,2));
    else await fs.unlink(join(outputDir,"visual-evidence.json")).catch(error=>{if(error.code!=='ENOENT')throw error;});
    await writePrivateArtifact(join(outputDir,"summary.json"),summaryJson);
  } finally {
    if (transcriptionWorkDir) await fs.rm(transcriptionWorkDir, {recursive:true,force:true});
  }
};
