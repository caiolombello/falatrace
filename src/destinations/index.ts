import { promises as fs } from "node:fs";
import { isAbsolute } from "node:path";
import { readSecret } from "../config/secrets";
import type { AiAppTarget, AppConfig } from "../config/defaults";
import { SHARE_MESSAGES, ShareError, assertRenderedShare, type RenderedShare } from "../share/render";
import { deliverAiApp, findOnPath, isAiAppTarget, type AiAppDeps } from "./ai-app";
import { deliverClipboard, type ClipboardDeps } from "./clipboard";
import { DeliveryLog, recordDelivery, type DeliveryReceipt, type DestinationKind } from "./log";
import { deliverNotion, parseNotionPageId, type NotionDeps } from "./notion";
import { deliverObsidian, obsidianFolderParts, type ObsidianDeps } from "./obsidian";
import { deliverSlack, redactSlackWebhook, validateSlackWebhookUrl, type SlackDeps } from "./slack";

export * from "./ai-app";
export * from "./clipboard";
export * from "./log";
export * from "./notion";
export * from "./obsidian";
export * from "./slack";

/** Product names of the AI app targets (not translated). */
export const AI_APP_LABELS: Readonly<Record<AiAppTarget, string>> = Object.freeze({
  "chatgpt-web": "ChatGPT (web)",
  "claude-web": "Claude (web)",
  "claude-desktop": "Claude Desktop",
  "gemini-web": "Gemini (web)",
  "claude-cli": "Claude Code",
  "codex-cli": "Codex CLI",
  "gemini-cli": "Gemini CLI",
  "opencode-cli": "OpenCode"
});

const CLI_BINARIES: Partial<Record<AiAppTarget, string>> = { "claude-cli": "claude", "codex-cli": "codex", "gemini-cli": "gemini", "opencode-cli": "opencode" };

export type ShareDestinationRequest =
  | { destination: "obsidian"; open?: boolean }
  | { destination: "notion" }
  | { destination: "slack" }
  | { destination: "clipboard"; mode: "return" | "system" }
  | { destination: "ai-app"; target?: AiAppTarget; clipboard: "return" | "system"; open?: boolean };

/** Destinations whose content leaves this computer through FalaTrace itself. */
export const EXTERNAL_DESTINATIONS: readonly DestinationKind[] = Object.freeze(["notion", "slack"]);

/**
 * Destinations sent only with the person's consent: Notion and Slack, where FalaTrace sends the
 * content, and the AI app, whose command-line tools read the note and send it to their provider at
 * once. The CLI (`--yes`) and the Studio (consent dialog) use the same list.
 */
export const SHARE_CONSENT_DESTINATIONS: readonly DestinationKind[] = Object.freeze([...EXTERNAL_DESTINATIONS, "ai-app"]);

export type DeliverShareInput = {
  share: RenderedShare;
  config: Pick<AppConfig, "destinations">;
  request: ShareDestinationRequest;
  /** Must be true for Notion and Slack: the user confirmed the destination and the content. */
  consent?: boolean;
  /** Snapshot of the preview the user saw; different content is refused. */
  expectedSnapshot?: string;
  timeZone?: string;
};

export type DeliverShareDeps = {
  /** Delivery history; null turns it off. */
  log?: DeliveryLog | null;
  now?: () => Date;
  obsidian?: ObsidianDeps;
  notion?: NotionDeps;
  slack?: SlackDeps;
  clipboard?: ClipboardDeps;
  aiApp?: AiAppDeps;
};

const FAILURE_CODES = new Set(["auth", "forbidden", "rate-limit", "rejected", "unavailable", "network", "timeout", "partial", "too-large"]);

/** Sends rendered content to one destination, after the consent and preview checks, and records the outcome. */
export const deliverShare = async (input: DeliverShareInput, deps: DeliverShareDeps = {}): Promise<DeliveryReceipt> => {
  const share = assertRenderedShare(input.share);
  const request = input.request;
  if (!request || typeof request !== "object") throw new ShareError(SHARE_MESSAGES.unknownDestination, "invalid");
  if (input.expectedSnapshot !== undefined && input.expectedSnapshot !== share.snapshot) throw new ShareError(SHARE_MESSAGES.previewChanged, "conflict");
  if (EXTERNAL_DESTINATIONS.includes(request.destination) && input.consent !== true) throw new ShareError(SHARE_MESSAGES.consentRequired, "consent");
  const log = deps.log === null ? undefined : deps.log ?? new DeliveryLog();
  const now = deps.now ?? (() => new Date());
  const destinations = input.config.destinations;
  try {
    switch (request.destination) {
      case "obsidian":
        return await deliverObsidian(
          { share, vault: destinations.obsidianVault, folder: destinations.obsidianFolder, open: request.open, timeZone: input.timeZone },
          { log, now, ...deps.obsidian }
        );
      case "notion":
        return await deliverNotion({ share, parentId: destinations.notionParentId }, { log, now, ...deps.notion });
      case "slack":
        return await deliverSlack({ share }, { log, now, ...deps.slack });
      case "clipboard":
        return await deliverClipboard({ share, mode: request.mode }, { log, now, ...deps.clipboard });
      case "ai-app": {
        const target = request.target ?? destinations.aiApp;
        if (!isAiAppTarget(target)) throw new ShareError(SHARE_MESSAGES.aiAppInvalid, "invalid");
        return await deliverAiApp({ share, target, clipboard: request.clipboard, open: request.open }, { log, now, ...deps.aiApp });
      }
      default:
        throw new ShareError(SHARE_MESSAGES.unknownDestination, "invalid");
    }
  } catch (error) {
    if (error instanceof ShareError && FAILURE_CODES.has(error.code)) {
      await recordDelivery(log, share.jobId, {
        at: now().toISOString(), destination: request.destination, target: request.destination, sha256: share.sha256, result: "failed"
      });
    }
    throw error;
  }
};

export type DestinationStatus = {
  destination: DestinationKind;
  /** Ready to use as configured. */
  ready: boolean;
  /** Redacted description of where it goes. */
  target?: string;
  /** A SHARE_KNOWN_ERRORS message explaining what is missing. */
  problem?: string;
  /** FalaTrace itself sends the content off this computer. */
  external: boolean;
  aiApp?: AiAppTarget;
};

export type DescribeDestinationsDeps = {
  readSecret?: (name: "NOTION_TOKEN" | "SLACK_WEBHOOK_URL") => Promise<string | undefined>;
  which?: (binary: string) => Promise<string | undefined>;
  env?: NodeJS.ProcessEnv;
};

/** What the Share dialog can offer, without reading or sending any meeting content. */
export const describeDestinations = async (config: Pick<AppConfig, "destinations">, deps: DescribeDestinationsDeps = {}): Promise<DestinationStatus[]> => {
  const secret = deps.readSecret ?? ((name: "NOTION_TOKEN" | "SLACK_WEBHOOK_URL") => readSecret(name));
  const { obsidianVault, obsidianFolder, notionParentId, aiApp } = config.destinations;
  const statuses: DestinationStatus[] = [];

  let obsidianProblem: string | undefined;
  if (!obsidianVault) obsidianProblem = SHARE_MESSAGES.obsidianNotConfigured;
  else {
    const stat = isAbsolute(obsidianVault) ? await fs.lstat(obsidianVault).catch(() => undefined) : undefined;
    if (!stat?.isDirectory() || stat.isSymbolicLink()) obsidianProblem = SHARE_MESSAGES.obsidianVaultInvalid;
    else {
      try {
        obsidianFolderParts(obsidianFolder);
      } catch {
        obsidianProblem = SHARE_MESSAGES.obsidianFolderInvalid;
      }
    }
  }
  statuses.push({
    destination: "obsidian", ready: !obsidianProblem, external: false,
    ...(obsidianVault ? { target: obsidianFolder ? `${obsidianVault.replace(/\/+$/, "")}/${obsidianFolder}` : obsidianVault } : {}),
    ...(obsidianProblem ? { problem: obsidianProblem } : {})
  });

  const parent = notionParentId ? parseNotionPageId(notionParentId) : undefined;
  const notionToken = await secret("NOTION_TOKEN").catch(() => undefined);
  const notionProblem = !notionToken || !notionParentId ? SHARE_MESSAGES.notionNotConfigured : !parent ? SHARE_MESSAGES.notionParentInvalid : undefined;
  statuses.push({
    destination: "notion", ready: !notionProblem, external: true,
    ...(parent ? { target: `notion:page/${parent}` } : {}),
    ...(notionProblem ? { problem: notionProblem } : {})
  });

  let slackTarget: string | undefined;
  let slackProblem: string | undefined;
  try {
    slackTarget = redactSlackWebhook(validateSlackWebhookUrl(await secret("SLACK_WEBHOOK_URL").catch(() => undefined)));
  } catch (error) {
    slackProblem = error instanceof ShareError ? error.message : SHARE_MESSAGES.slackNotConfigured;
  }
  statuses.push({
    destination: "slack", ready: !slackProblem, external: true,
    ...(slackTarget ? { target: slackTarget } : {}),
    ...(slackProblem ? { problem: slackProblem } : {})
  });

  statuses.push({ destination: "clipboard", ready: true, external: false, target: "clipboard" });

  let aiProblem: string | undefined;
  if (!isAiAppTarget(aiApp)) aiProblem = SHARE_MESSAGES.aiAppInvalid;
  else {
    const binary = CLI_BINARIES[aiApp];
    if (binary && !(await (deps.which ?? ((name: string) => findOnPath(name, deps.env ?? process.env)))(binary))) aiProblem = SHARE_MESSAGES.aiToolMissing;
  }
  statuses.push({
    destination: "ai-app", ready: !aiProblem, external: false, target: `ai-app:${aiApp}`,
    ...(isAiAppTarget(aiApp) ? { aiApp } : {}),
    ...(aiProblem ? { problem: aiProblem } : {})
  });
  return statuses;
};
