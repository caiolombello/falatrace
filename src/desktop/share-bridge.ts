// Share: preview, then consent for destinations that leave this computer, then send
// (DESIGN-STUDIO §4 "Share"). Sending renders again from the recording and refuses content that
// changed since the preview the person saw; the Studio never hands the bridge content to send.
import { randomUUID } from "node:crypto";
import type { AiAppTarget } from "../config/defaults";
import type { DeliveryReceipt, ShareDestinationRequest } from "../destinations";
import { AI_WEB_URLS, isAiAppTarget } from "../destinations/ai-app";
import { AI_APP_LABELS, SHARE_CONSENT_DESTINATIONS } from "../destinations/consent";
import { DESTINATION_KINDS, type DestinationKind } from "../destinations/log";
import { JobStore } from "../jobs/store";
import {
  renderShare, renderTextShare, SHARE_INCLUDES, SHARE_KNOWN_ERRORS, SHARE_KNOWN_WARNINGS, SHARE_LIMITS, SHARE_MESSAGES, ShareError, type RenderedShare, type ShareInclude
} from "../share";
import { type BridgeCall, type BridgeFamily, bool, invalid, line, matches, oneOf, RECIPE_ID, text, UUID } from "./bridge-family";
import type { BridgeContext } from "./bridge-context";
import { meetingShareNote } from "./meeting-view";
import { studioLanguage } from "./studio-services";

export const SHARE_BRIDGE_OPERATIONS = ["share-preview", "share-send"] as const;

export const SHARE_BRIDGE_MESSAGES = Object.freeze({
  previewFailed: "Não foi possível preparar a prévia para compartilhar.",
  sendFailed: "Não foi possível confirmar o envio; confira o destino antes de tentar de novo.",
  clipboardLabel: "Área de transferência"
});

export const SHARE_BRIDGE_KNOWN_ERRORS: readonly string[] = Object.freeze([
  ...new Set([...Object.values(SHARE_BRIDGE_MESSAGES), ...SHARE_KNOWN_ERRORS, ...SHARE_KNOWN_WARNINGS])
]);

/** Previews kept for sending: the newest few, for a few minutes. */
export const SHARE_PREVIEW_LIMITS = Object.freeze({ kept: 32, maxAgeMs: 10 * 60_000, previewCharacters: 200_000 });
/**
 * Notion and Slack send in several requests (each with its own timeout and rate-limit waits); the
 * whole send stops here, inside the bridge's 30 s request limit, instead of the Studio killing the bridge.
 */
export const SHARE_SEND_DEADLINE_MS = 24_000;
/** Destinations the Studio sends only with the person's consent (DESIGN-STUDIO §2.12). */
export { SHARE_CONSENT_DESTINATIONS };

const ALLOWED: Record<(typeof SHARE_BRIDGE_OPERATIONS)[number], readonly string[]> = {
  "share-preview": ["destination", "include", "jobId", "text", "frontmatter", "title", "recipeId"],
  "share-send": ["previewId", "consent"]
};

const validate = (call: BridgeCall): void => {
  const p = call.payload;
  if (call.op === "share-preview") {
    oneOf(p, "destination", DESTINATION_KINDS);
    oneOf(p, "include", SHARE_INCLUDES);
    matches(p, "jobId", UUID, { optional: true });
    text(p, "text", SHARE_LIMITS.recipeText, { optional: true });
    bool(p, "frontmatter", { optional: true });
    line(p, "title", 200, { optional: true, empty: true });
    matches(p, "recipeId", RECIPE_ID, { optional: true, max: 60 });
    // A meeting note needs its recording; an answer or recipe result brings its own text.
    if (p.jobId === undefined && p.text === undefined) invalid();
    if (p.text !== undefined && !(p.text as string).trim()) invalid();
  } else {
    matches(p, "previewId", UUID);
    bool(p, "consent", { optional: true });
  }
};

type Preview = {
  id: string; destination: DestinationKind; include: ShareInclude; jobId?: string; text?: string; title?: string; recipeId?: string;
  frontmatter: boolean; snapshot: string; createdAt: number;
  /** Where the preview said the content goes (vault, Notion page, Slack channel, AI app): consent covers only that. */
  target?: string; aiApp?: AiAppTarget;
};

const previews = new Map<string, Preview>();

const prune = (now: number): void => {
  for (const [id, preview] of previews) if (now - preview.createdAt > SHARE_PREVIEW_LIMITS.maxAgeMs) previews.delete(id);
  while (previews.size > SHARE_PREVIEW_LIMITS.kept) {
    const oldest = previews.keys().next().value;
    if (oldest === undefined) break;
    previews.delete(oldest);
  }
};

/** Renders what a preview describes, from the recording and the configuration as they are now. */
const render = async (preview: Omit<Preview, "id" | "snapshot" | "createdAt">, context: BridgeContext): Promise<RenderedShare> => {
  const config = await context.studio.config();
  const language = studioLanguage(config);
  if (preview.text !== undefined) {
    return renderTextShare({
      title: preview.title ?? "", text: preview.text, language, frontmatter: preview.frontmatter,
      ...(preview.jobId ? { jobId: preview.jobId } : {}), ...(preview.recipeId ? { recipeId: preview.recipeId } : {})
    }, context.deps.now);
  }
  const job = await (context.deps.jobs ?? new JobStore()).get(preview.jobId!);
  const services = await context.studio.services(config);
  const { note, language: summaryLanguage } = await meetingShareNote(job, services, preview.include);
  return renderShare(note, { frontmatter: preview.frontmatter, language: summaryLanguage ?? language, include: preview.include });
};

const destinationLabel = (destination: DestinationKind, aiApp: AiAppTarget | undefined): string =>
  destination === "obsidian" ? "Obsidian" : destination === "notion" ? "Notion" : destination === "slack" ? "Slack"
    : destination === "clipboard" ? SHARE_BRIDGE_MESSAGES.clipboardLabel : aiApp && isAiAppTarget(aiApp) ? AI_APP_LABELS[aiApp] : "";

/**
 * The Studio copies returned content itself and opens returned addresses with the desktop; it cannot
 * open a terminal, so an AI app that is a command-line tool is opened here (its handoff file is private).
 */
const requestFor = (destination: DestinationKind, aiApp: AiAppTarget | undefined): ShareDestinationRequest =>
  destination === "clipboard" ? { destination, mode: "return" }
    : destination === "ai-app" ? { destination, ...(aiApp ? { target: aiApp } : {}), clipboard: "return", open: aiApp !== undefined && !(aiApp in AI_WEB_URLS) && aiApp !== "claude-desktop" }
      : destination === "obsidian" ? { destination, open: false } : { destination };

const sharePreview = async (call: BridgeCall, context: BridgeContext) => {
  const p = call.payload;
  const now = (context.deps.now ?? (() => new Date()))().getTime();
  const draft = {
    destination: p.destination as DestinationKind, include: p.include as ShareInclude, frontmatter: p.frontmatter === true,
    ...(typeof p.jobId === "string" ? { jobId: p.jobId.toLowerCase() } : {}),
    ...(typeof p.text === "string" ? { text: p.text } : {}),
    ...(typeof p.title === "string" ? { title: p.title } : {}),
    ...(typeof p.recipeId === "string" ? { recipeId: p.recipeId } : {})
  };
  const share = await render(draft, context);
  const config = await context.studio.config();
  // The destinations (Notion, Slack, Obsidian, clipboard) load on first use; the bridge starts without them.
  const { describeDestinations } = await import("../destinations");
  const status = (await describeDestinations(config, context.deps.destinations)).find((item) => item.destination === draft.destination);
  const preview: Preview = {
    ...draft, id: randomUUID(), snapshot: share.snapshot, createdAt: now,
    ...(status?.target ? { target: status.target } : {}), ...(status?.aiApp ? { aiApp: status.aiApp } : {})
  };
  prune(now);
  previews.set(preview.id, preview);
  const markdown = share.markdown;
  return {
    previewId: preview.id,
    markdown: markdown.slice(0, SHARE_PREVIEW_LIMITS.previewCharacters),
    ...(markdown.length > SHARE_PREVIEW_LIMITS.previewCharacters ? { truncated: true } : {}),
    chars: markdown.length,
    external: SHARE_CONSENT_DESTINATIONS.includes(draft.destination),
    destinationLabel: destinationLabel(draft.destination, status?.aiApp),
    ready: status?.ready ?? false,
    ...(status?.problem ? { problem: status.problem } : {}),
    ...(status?.target ? { target: status.target } : {})
  };
};

const shareSend = async (call: BridgeCall, context: BridgeContext) => {
  const now = (context.deps.now ?? (() => new Date()))().getTime();
  prune(now);
  const preview = previews.get(call.payload.previewId as string);
  if (!preview) throw new Error(SHARE_MESSAGES.previewChanged);
  const config = await context.studio.config();
  const { deliverShare, describeDestinations } = await import("../destinations");
  // Consent was given for the destination the preview named. Another Notion page, Slack channel, vault
  // or AI app set since then is a new destination: the person previews (and agrees) again.
  const status = (await describeDestinations(config, context.deps.destinations)).find((item) => item.destination === preview.destination);
  if (status?.target !== preview.target || status?.aiApp !== preview.aiApp) throw new Error(SHARE_MESSAGES.previewChanged);
  if (SHARE_CONSENT_DESTINATIONS.includes(preview.destination) && call.payload.consent !== true) throw new Error(SHARE_MESSAGES.consentRequired);
  const share = await render(preview, context);
  const deadline = AbortSignal.timeout(context.deps.shareSendDeadlineMs ?? SHARE_SEND_DEADLINE_MS);
  // Rate-limit waits end at the deadline too; the next request then stops at once.
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
    if (deadline.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    deadline.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
  const deps = {
    ...context.deps.share,
    notion: { signal: deadline, sleep, ...context.deps.share?.notion },
    slack: { signal: deadline, sleep, ...context.deps.share?.slack }
  };
  let receipt: DeliveryReceipt;
  try {
    receipt = await deliverShare({
      share, config, request: requestFor(preview.destination, preview.aiApp), consent: call.payload.consent === true, expectedSnapshot: preview.snapshot
    }, deps);
  } catch (error) {
    // Stopped by the deadline before an answer: like a request timeout, the outcome is not confirmed.
    if (deadline.aborted && error instanceof ShareError && error.code === "network") throw new ShareError(SHARE_MESSAGES.timeout, "timeout");
    throw error;
  }
  previews.delete(preview.id);
  return {
    kind: receipt.result,
    destination: receipt.destination,
    ...(receipt.location ? { path: receipt.location } : {}),
    ...(receipt.url ? { url: receipt.url } : {}),
    ...(receipt.content !== undefined ? { content: receipt.content } : {}),
    opened: receipt.result === "opened",
    warnings: receipt.warnings.filter((warning) => SHARE_KNOWN_WARNINGS.includes(warning))
  };
};

export const shareBridge: BridgeFamily<BridgeContext> = {
  operations: SHARE_BRIDGE_OPERATIONS,
  allowedPayload: ALLOWED,
  validate,
  async handle(call, context) {
    if (call.op === "share-preview") return sharePreview(call, context);
    if (call.op === "share-send") return shareSend(call, context);
    return invalid();
  },
  knownErrors: SHARE_BRIDGE_KNOWN_ERRORS,
  fallback: (op) => op === "share-send" ? SHARE_BRIDGE_MESSAGES.sendFailed : SHARE_BRIDGE_MESSAGES.previewFailed
};

/** Forgets every preview (tests). */
export const clearSharePreviews = (): void => previews.clear();
