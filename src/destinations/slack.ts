import { readSecret, redactResolvedSecrets } from "../config/secrets";
import {
  SHARE_MESSAGES,
  ShareError,
  assertRenderedShare,
  parseInlineMarkdown,
  sha256Hex,
  type RenderedShare,
  type ShareErrorCode,
  type ShareMessage
} from "../share/render";
import { recordDelivery, type DeliveryLog, type DeliveryReceipt } from "./log";
import { checkedBaseUrl, retryAfterMs } from "./notion";

/**
 * Slack incoming webhook. The webhook URL is a secret, so it must point at hooks.slack.com over
 * HTTPS before anything is sent (otherwise the secret and the meeting could go to any host). Each
 * post carries a `markdown` block (≤12,000 characters) and a mrkdwn `text` fallback; longer content
 * is split into several posts. When Slack refuses the markdown block, the post is retried with
 * section blocks. Posts are not idempotent: only HTTP 429 is retried.
 */

export const SLACK_MARKDOWN_MAX = 12_000;
export const SLACK_SECTION_MAX = 3_000;
export const SLACK_TEXT_MAX = 39_000;
export const SLACK_MAX_POSTS = 10;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_RETRY_AFTER_MS = 10_000;
const MAX_RATE_RETRIES = 3;
const POST_SPACING_MS = 1_100;
const WEBHOOK_PATH = /^\/services\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{1,128}$/;

/** The webhook URL, or a ShareError: https only, host exactly hooks.slack.com, no credentials, port, query or fragment. */
export const validateSlackWebhookUrl = (value: string | undefined): URL => {
  if (!value) throw new ShareError(SHARE_MESSAGES.slackNotConfigured, "config");
  const invalid = new ShareError(SHARE_MESSAGES.slackUrlInvalid, "config");
  if (typeof value !== "string" || value.length > 512 || /[\s\p{Cc}]/u.test(value)) throw invalid;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid;
  }
  if (url.protocol !== "https:" || url.hostname !== "hooks.slack.com" || url.username || url.password || url.port ||
      url.search || url.hash || !WEBHOOK_PATH.test(url.pathname) || !value.startsWith("https://hooks.slack.com/services/")) {
    throw invalid;
  }
  return url;
};

/** "hooks.slack.com/services/T…/B…/***": enough to recognise the workspace and channel, never the token. */
export const redactSlackWebhook = (url: URL): string => {
  const [, , team, channel] = url.pathname.split("/");
  return `hooks.slack.com/services/${team}/${channel}/***`;
};

/** The three characters Slack requires escaped in message text. */
export const escapeSlackText = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Slack mrkdwn for FalaTrace Markdown: headings and **bold** become *bold*, task and bullet markers become symbols. */
export const markdownToMrkdwn = (markdown: string): string => {
  const inline = (text: string): string =>
    parseInlineMarkdown(text).map((segment) => {
      const label = escapeSlackText(segment.text);
      const content = segment.url ? `<${escapeSlackText(segment.url)}|${label.replace(/\|/g, "¦")}>` : label;
      return segment.bold && content.trim() ? `*${content}*` : content;
    }).join("");
  return markdown.replace(/\r\n?/g, "\n").split("\n").map((line) => {
    const trimmed = line.trim();
    const heading = /^#{1,6}\s+(.*)$/.exec(trimmed);
    if (heading) return `*${inline(heading[1].replace(/\*\*/g, ""))}*`;
    if (/^([-*_])(\s*\1){2,}$/.test(trimmed)) return "";
    const task = /^[-*+]\s+\[([ xX])\]\s*(.*)$/.exec(trimmed);
    if (task) return `${task[1] === " " ? "☐" : "☑"} ${inline(task[2])}`;
    const bullet = /^[-*+]\s+(.*)$/.exec(trimmed);
    if (bullet) return `• ${inline(bullet[1])}`;
    return inline(trimmed);
  }).join("\n").replace(/\n{3,}/g, "\n\n").trim();
};

/** Markdown for the markdown block: custom-scheme links as text, FalaTrace's "\<" unescaped, then & < > escaped. */
export const slackMarkdown = (markdown: string): string =>
  escapeSlackText(markdown.replace(/\[([^\]\n]{1,500})\]\(((?!https?:\/\/)[^)\s]{1,4000})\)/gi, "$1: $2").replace(/\\</g, "<")).trim();

/** Splits text at paragraph, then line, then word boundaries into pieces whose measured length is at most `max`. */
export const splitForSlack = (text: string, max: number, measure: (value: string) => number = (value) => value.length): string[] => {
  const pieces: string[] = [];
  let current = "";
  const push = (unit: string, separator: string): void => {
    const candidate = current ? `${current}${separator}${unit}` : unit;
    if (measure(candidate) <= max) {
      current = candidate;
      return;
    }
    if (current) pieces.push(current);
    current = "";
    if (measure(unit) <= max) {
      current = unit;
      return;
    }
    // A unit too long on its own: lines, then words, then characters.
    const finer = unit.includes("\n") ? unit.split("\n") : unit.includes(" ") ? unit.split(" ") : Array.from(unit);
    const finerSeparator = unit.includes("\n") ? "\n" : unit.includes(" ") ? " " : "";
    for (const part of finer) push(part, finerSeparator);
  };
  for (const paragraph of text.split("\n\n")) push(paragraph, "\n\n");
  if (current) pieces.push(current);
  return pieces.filter((piece) => piece.trim().length > 0);
};

export type SlackDeliverInput = { share: RenderedShare };

export type SlackDeps = {
  fetch?: typeof fetch;
  /** Defaults to readSecret("SLACK_WEBHOOK_URL"). */
  webhookUrl?: string;
  /** Tests only: send to this origin (same path) after the real URL has been validated. */
  baseUrl?: string;
  log?: DeliveryLog;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  timeoutMs?: number;
};

type SlackResponse = { status: number; text: string };

export const deliverSlack = async (input: SlackDeliverInput, deps: SlackDeps = {}): Promise<DeliveryReceipt> => {
  const share = assertRenderedShare(input.share);
  const secret = deps.webhookUrl ?? (await readSecret("SLACK_WEBHOOK_URL"));
  const url = validateSlackWebhookUrl(secret);
  const endpoint = deps.baseUrl === undefined ? url.toString() : `${checkedBaseUrl(deps.baseUrl, "https://hooks.slack.com")}${url.pathname}`;
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const now = deps.now ?? (() => new Date());
  const redact = (text: string): string => redactResolvedSecrets(text.split(url.toString()).join("[redacted]").split(url.pathname).join("[redacted]"));

  const rawChunks = splitForSlack(share.body.trim(), SLACK_MARKDOWN_MAX, (value) => slackMarkdown(value).length);
  if (rawChunks.length === 0) throw new ShareError(SHARE_MESSAGES.invalidNote, "invalid");
  if (rawChunks.length > SLACK_MAX_POSTS) throw new ShareError(SHARE_MESSAGES.slackTooLarge, "too-large");

  const post = async (payload: unknown): Promise<SlackResponse> => {
    for (let attempt = 0; ; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("timeout")), deps.timeoutMs ?? REQUEST_TIMEOUT_MS);
      const forward = (): void => controller.abort(deps.signal?.reason);
      deps.signal?.addEventListener("abort", forward, { once: true });
      let response: Response;
      let text = "";
      try {
        if (deps.signal?.aborted) throw new Error("aborted");
        response = await doFetch(endpoint, {
          method: "POST",
          redirect: "manual",
          signal: controller.signal,
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify(payload)
        });
        text = (await response.text()).slice(0, 2000);
      } catch (error) {
        if (controller.signal.aborted && !deps.signal?.aborted) throw new ShareError(SHARE_MESSAGES.timeout, "timeout");
        throw new ShareError(SHARE_MESSAGES.networkFailed, "network", redact(String((error as Error)?.message ?? error)));
      } finally {
        clearTimeout(timer);
        deps.signal?.removeEventListener("abort", forward);
      }
      if (response.status === 429 && attempt < MAX_RATE_RETRIES) {
        const wait = retryAfterMs(response.headers.get("retry-after"));
        if (wait <= MAX_RETRY_AFTER_MS) {
          await sleep(wait);
          continue;
        }
      }
      return { status: response.status, text };
    }
  };

  const errorFor = (response: SlackResponse): ShareError => {
    const detail = redact(`${response.status} ${response.text}`.trim());
    const error = (message: ShareMessage, code: ShareErrorCode): ShareError => new ShareError(message, code, detail);
    if (response.status === 410 || /channel_is_archived/.test(response.text)) return error(SHARE_MESSAGES.slackArchived, "forbidden");
    if (response.status === 403 || response.status === 404 || /invalid_token|no_service|no_active_hooks|channel_not_found|action_prohibited/.test(response.text)) {
      return error(SHARE_MESSAGES.slackAuth, "auth");
    }
    if (response.status === 429) return error(SHARE_MESSAGES.slackRateLimited, "rate-limit");
    if (response.status === 400 || response.status === 413) return error(SHARE_MESSAGES.slackRejected, "rejected");
    return error(SHARE_MESSAGES.slackUnavailable, "unavailable");
  };

  const sentBodies: string[] = [];
  for (const [index, raw] of rawChunks.entries()) {
    if (index > 0) await sleep(POST_SPACING_MS);
    const markdown = slackMarkdown(raw);
    const mrkdwn = markdownToMrkdwn(raw);
    const text = mrkdwn.length > SLACK_TEXT_MAX ? `${mrkdwn.slice(0, SLACK_TEXT_MAX - 1)}…` : mrkdwn || markdown.slice(0, SLACK_TEXT_MAX);
    try {
      let response = await post({ text, blocks: [{ type: "markdown", text: markdown }] });
      if (response.status === 400 && /invalid_blocks/.test(response.text)) {
        const sections = splitForSlack(mrkdwn, SLACK_SECTION_MAX).map((part) => ({ type: "section", text: { type: "mrkdwn", text: part } }));
        response = await post({ text, blocks: sections.slice(0, 50) });
      }
      if (response.status !== 200) throw errorFor(response);
    } catch (error) {
      if (index > 0 && error instanceof ShareError) throw new ShareError(SHARE_MESSAGES.slackPartial, "partial", `${index}/${rawChunks.length} ${error.detail ?? ""}`.trim());
      throw error;
    }
    sentBodies.push(markdown);
  }
  const at = now().toISOString();
  const target = redactSlackWebhook(url);
  const sha256 = sha256Hex(sentBodies.join("\n\n"));
  await recordDelivery(deps.log, share.jobId, { at, destination: "slack", target, sha256, result: "sent" });
  return { at, destination: "slack", target, sha256, result: "sent", posts: sentBodies.length, warnings: [] };
};
