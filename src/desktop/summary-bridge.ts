// Notes generation status, per-recording template/language choices and summary templates
// (DESIGN-STUDIO §4 "Summary", "Templates"; the plan/run/cancel route stays in bridge.ts).
import { SUMMARY_LANGUAGES } from "../config/defaults";
import { JobStore } from "../jobs/store";
import { RecordingSessionStore } from "../recording/session";
import { findSummaryPrefsForJob, SUMMARY_PREFS_KNOWN_ERRORS, SummaryPrefsStore, type SummaryPrefs } from "../summary/prefs";
import type { StudioSummaryFlow } from "../summary/studio";
import {
  BUILT_IN_TEMPLATES, deleteCustomTemplate, inspectCustomTemplates, saveCustomTemplate, sectionTitle, TEMPLATE_KNOWN_ERRORS, templateName, type SummaryTemplate
} from "../templates";
import { type BridgeCall, type BridgeFamily, boundedObject, integer, invalid, matches, TEMPLATE_ID, UUID, uuidKey } from "./bridge-family";
import type { BridgeContext } from "./bridge-context";
import { studioLanguage } from "./studio-services";

export const SUMMARY_BRIDGE_OPERATIONS = [
  "summary-status", "summary-prefs-read", "summary-prefs-save", "templates-list", "templates-save", "templates-delete"
] as const;

/** Existing summary refusals (also shown by summary-plan/run); translated in i18n.js. */
export const SUMMARY_CONFLICT_MESSAGE = "A revisão ou sua origem mudou. Prepare um novo plano antes de gerar; o original foi preservado.";
export const SUMMARY_FAILED_MESSAGE = "Resumo não confirmado ou cancelado. Confira modelo local, destino, limite e consentimento. Não repita uma tentativa incerta; releia antes de preparar outro plano. Original preservado.";

export const SUMMARY_BRIDGE_MESSAGES = Object.freeze({
  unavailable: "Esta geração de notas não está mais disponível; releia as notas da reunião.",
  prefsFailed: "Não foi possível ler ou salvar o modelo e o idioma escolhidos para esta reunião.",
  templatesFailed: "Não foi possível ler ou salvar os modelos de resumo. Nada foi alterado."
});

export const SUMMARY_BRIDGE_KNOWN_ERRORS: readonly string[] = Object.freeze([
  ...new Set([SUMMARY_CONFLICT_MESSAGE, SUMMARY_FAILED_MESSAGE, ...Object.values(SUMMARY_BRIDGE_MESSAGES), ...SUMMARY_PREFS_KNOWN_ERRORS, ...TEMPLATE_KNOWN_ERRORS])
]);

/** A stored template file is at most 64 KiB; the request line is bounded by 1 MiB anyway. */
const TEMPLATE_MAX_BYTES = 64 * 1024;

const ALLOWED: Record<(typeof SUMMARY_BRIDGE_OPERATIONS)[number], readonly string[]> = {
  "summary-status": ["requestId"],
  "summary-prefs-read": [],
  "summary-prefs-save": ["expectedRev", "templateId", "language"],
  "templates-list": [],
  "templates-save": ["template", "expectedVersion"],
  "templates-delete": ["id", "expectedVersion"]
};

const validate = (call: BridgeCall): void => {
  const p = call.payload;
  if (call.op === "summary-status") {
    if (call.key !== undefined && call.key !== "") uuidKey(call);
    matches(p, "requestId", UUID);
  } else if (call.op === "summary-prefs-read") {
    uuidKey(call);
  } else if (call.op === "summary-prefs-save") {
    uuidKey(call);
    integer(p, "expectedRev", 0, 1_000_000_000);
    if (p.templateId !== undefined && p.templateId !== "auto") matches(p, "templateId", TEMPLATE_ID, { max: 60 });
    if (p.language !== undefined && (typeof p.language !== "string" || !(SUMMARY_LANGUAGES as readonly string[]).includes(p.language))) invalid();
  } else if (call.op === "templates-save") {
    boundedObject(p, "template", TEMPLATE_MAX_BYTES);
    integer(p, "expectedVersion", 1, 999_999, { optional: true });
  } else if (call.op === "templates-delete") {
    matches(p, "id", TEMPLATE_ID, { max: 60 });
    integer(p, "expectedVersion", 1, 999_999);
  }
};

/** The status of a run started by summary-run: messages are ours, never raw exception text. */
export const summaryStatus = (flow: StudioSummaryFlow, call: BridgeCall) => {
  let status: ReturnType<StudioSummaryFlow["status"]>;
  try { status = flow.status(call.payload.requestId as string); }
  catch { throw new Error(SUMMARY_BRIDGE_MESSAGES.unavailable); }
  if (call.key && status.jobId !== call.key.toLowerCase()) throw new Error(SUMMARY_BRIDGE_MESSAGES.unavailable);
  return {
    jobId: status.jobId, requestId: status.requestId, status: status.status,
    ...(status.status === "failed" ? { error: status.conflict ? SUMMARY_CONFLICT_MESSAGE : SUMMARY_FAILED_MESSAGE } : {}),
    ...(status.receipt ? { notesUsed: status.receipt.notesUsed, generatedAt: status.receipt.generatedAt } : {})
  };
};

const prefsView = (id: string, prefs: SummaryPrefs | undefined) => ({
  id: prefs?.id ?? id.toLowerCase(), rev: prefs?.rev ?? 0,
  ...(prefs?.templateId ? { templateId: prefs.templateId } : {}),
  ...(prefs?.language ? { language: prefs.language } : {}),
  ...(prefs?.updatedAt && prefs.rev ? { updatedAt: prefs.updatedAt } : {})
});

/** The recording file a choice belongs to, so a job created later for the same file finds it. */
const sourcePathOf = async (id: string, context: BridgeContext): Promise<string | undefined> => {
  const job = await (context.deps.jobs ?? new JobStore()).get(id).catch(() => undefined);
  if (job) return job.sourcePath;
  const session = await (context.deps.sessions ?? new RecordingSessionStore()).read().catch(() => null);
  return session?.id.toLowerCase() === id ? session.outputPath : undefined;
};

const templateItem = (template: SummaryTemplate, language: "pt-BR" | "en") => ({
  id: template.id,
  name: templateName(template, language),
  description: template.description,
  builtIn: template.builtIn,
  sectionTitles: template.sections.map((section) => sectionTitle(section, language)),
  version: template.version,
  /** The whole template, for the editor (custom templates start as a copy of one). */
  template
});

const listTemplatesView = async (context: BridgeContext) => {
  const config = await context.studio.config();
  const language = studioLanguage(config);
  const { templates, problems } = await inspectCustomTemplates(context.deps.templatesDir ? { dir: context.deps.templatesDir } : undefined);
  return {
    templates: [...BUILT_IN_TEMPLATES, ...templates].map((template) => templateItem(template, language)),
    default: config.summary.template,
    problems: problems.map(({ file, reason }) => ({ file, reason }))
  };
};

export const summaryBridge = (flow: StudioSummaryFlow): BridgeFamily<BridgeContext> => ({
  operations: SUMMARY_BRIDGE_OPERATIONS,
  allowedPayload: ALLOWED,
  validate,
  async handle(call, context) {
    const p = call.payload;
    const dir = context.deps.templatesDir ? { dir: context.deps.templatesDir } : {};
    if (call.op === "summary-status") {
      const status = summaryStatus(flow, call);
      // New notes change the library's artifact states and the recording's indexed facts.
      if (status.status === "completed") {
        context.library.invalidate();
        context.studio.refreshJobs([status.jobId]);
      }
      return status;
    }
    if (call.op === "summary-prefs-read") {
      const id = call.key!.toLowerCase();
      const store = new SummaryPrefsStore();
      const own = await store.read(id);
      if (own) return prefsView(id, own);
      const job = await (context.deps.jobs ?? new JobStore()).get(id).catch(() => undefined);
      return prefsView(id, job ? await findSummaryPrefsForJob(job, store) : undefined);
    }
    if (call.op === "summary-prefs-save") {
      const id = call.key!.toLowerCase();
      const sourcePath = await sourcePathOf(id, context);
      const saved = await new SummaryPrefsStore().save(id, {
        expectedRev: p.expectedRev as number,
        ...(typeof p.templateId === "string" ? { templateId: p.templateId } : {}),
        ...(typeof p.language === "string" ? { language: p.language as SummaryPrefs["language"] } : {}),
        ...(sourcePath ? { sourcePath } : {}),
        ...(context.deps.now ? { now: context.deps.now() } : {})
      });
      return prefsView(id, saved.rev ? saved : undefined);
    }
    if (call.op === "templates-list") return listTemplatesView(context);
    if (call.op === "templates-save") {
      const language = studioLanguage(await context.studio.config());
      const saved = await saveCustomTemplate(p.template, { ...dir, ...(p.expectedVersion !== undefined ? { expectedVersion: p.expectedVersion as number } : {}) });
      return { template: templateItem(saved, language) };
    }
    if (call.op === "templates-delete") {
      return { id: p.id, deleted: await deleteCustomTemplate(p.id as string, { ...dir, expectedVersion: p.expectedVersion as number }) };
    }
    return invalid();
  },
  knownErrors: SUMMARY_BRIDGE_KNOWN_ERRORS,
  fallback: (op) => op === "summary-status" ? SUMMARY_FAILED_MESSAGE : op.startsWith("summary-prefs") ? SUMMARY_BRIDGE_MESSAGES.prefsFailed : SUMMARY_BRIDGE_MESSAGES.templatesFailed
});
