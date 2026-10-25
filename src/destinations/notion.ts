import { readSecret, redactResolvedSecrets } from "../config/secrets";
import {
  SHARE_MESSAGES,
  ShareError,
  assertRenderedShare,
  parseInlineMarkdown,
  sha256Hex,
  type InlineSegment,
  type RenderedShare,
  type ShareErrorCode,
  type ShareMessage
} from "../share/render";
import { recordDelivery, type DeliveryLog, type DeliveryReceipt } from "./log";

/**
 * Notion: a new page under the configured parent page. The page body goes as `markdown` (API
 * 2026-03-11); when Notion rejects that field the content is converted to blocks and sent in batches
 * of at most 100 blocks and 450 KB (the first batch with the page, the rest appended). Page creation is not idempotent, so only
 * HTTP 429 (request refused, nothing created) is retried.
 */

export const NOTION_API_URL = "https://api.notion.com";
export const NOTION_VERSION = "2026-03-11";
export const NOTION_RICH_TEXT_MAX = 2000;
export const NOTION_BLOCKS_PER_REQUEST = 100;
const RICH_TEXT_PER_BLOCK = 100;
export const NOTION_MAX_BLOCKS = 1000;
/** Notion refuses requests over 500 KB; requests stay under this, measured as the JSON sent. */
export const NOTION_REQUEST_MAX_BYTES = 450_000;
/** One block's JSON stays under this, so a batch can always hold it next to the page fields. */
export const NOTION_BLOCK_MAX_BYTES = 100_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRY_AFTER_MS = 10_000;
const MAX_RATE_RETRIES = 3;
const APPEND_SPACING_MS = 350;

/** Wait asked by a 429's Retry-After (seconds); one second when it is missing or not a number of seconds. */
export const retryAfterMs = (header: string | null): number => {
  const text = (header ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(text)) return 1000;
  return Number(text) * 1000;
};

/** An injected origin may only be the real one or a loopback test server, so the token never goes elsewhere. */
export const checkedBaseUrl = (value: string | undefined, production: string): string => {
  if (value === undefined) return production;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ShareError(SHARE_MESSAGES.invalidOptions, "invalid");
  }
  const loopback = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((!loopback && url.origin !== production) || url.username || url.password || url.search || url.hash) throw new ShareError(SHARE_MESSAGES.invalidOptions, "invalid");
  return url.origin;
};

/** The 32-hex id of a Notion page from an id, a dashed UUID or a page URL; undefined when none is found. */
export const parseNotionPageId = (value: string): string | undefined => {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  const text = value.trim();
  const bare = text.replace(/-/g, "").toLowerCase();
  if (/^[0-9a-f]{32}$/.test(bare)) return bare;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || !(url.hostname === "notion.so" || url.hostname.endsWith(".notion.so") || url.hostname.endsWith(".notion.site"))) return undefined;
  const fromQuery = url.searchParams.get("p");
  if (fromQuery && /^[0-9a-f]{32}$/i.test(fromQuery)) return fromQuery.toLowerCase();
  const last = url.pathname.split("/").filter(Boolean).pop() || "";
  const match = /([0-9a-f]{32})$/i.exec(last.replace(/-/g, ""));
  return match ? match[1].toLowerCase() : undefined;
};

export const notionDashedId = (id: string): string =>
  `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;

export type NotionRichText = {
  type: "text";
  text: { content: string; link?: { url: string } };
  annotations?: { bold: true };
};

type TextBlockType = "paragraph" | "heading_1" | "heading_2" | "heading_3" | "bulleted_list_item" | "numbered_list_item" | "quote";

export type NotionBlock =
  | ({ object: "block"; type: TextBlockType } & Record<string, unknown>)
  | { object: "block"; type: "to_do"; to_do: { rich_text: NotionRichText[]; checked: boolean } }
  | { object: "block"; type: "code"; code: { rich_text: NotionRichText[]; language: "plain text" } }
  | { object: "block"; type: "divider"; divider: Record<string, never> };

/** Splits text into pieces of at most `max` UTF-16 units without cutting a surrogate pair. */
export const splitText = (text: string, max = NOTION_RICH_TEXT_MAX): string[] => {
  const pieces: string[] = [];
  let current = "";
  for (const character of text) {
    if (current.length + character.length > max) {
      pieces.push(current);
      current = "";
    }
    current += character;
  }
  if (current) pieces.push(current);
  return pieces;
};

const richText = (segments: InlineSegment[]): NotionRichText[] => {
  const result: NotionRichText[] = [];
  for (const segment of segments) {
    for (const piece of splitText(segment.text)) {
      const item: NotionRichText = { type: "text", text: { content: piece } };
      if (segment.url) item.text.link = { url: segment.url };
      if (segment.bold) item.annotations = { bold: true };
      const previous = result[result.length - 1];
      // Merge plain neighbours with the same look, keeping each piece within the limit.
      if (previous && !previous.text.link && !item.text.link && !!previous.annotations === !!item.annotations &&
          previous.text.content.length + piece.length <= NOTION_RICH_TEXT_MAX) {
        previous.text.content += piece;
      } else {
        result.push(item);
      }
    }
  }
  return result;
};

const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

/** Rich text cut into runs of at most 100 pieces and NOTION_BLOCK_MAX_BYTES; always at least one run. */
const richTextRuns = (rich: NotionRichText[]): NotionRichText[][] => {
  const runs: NotionRichText[][] = [];
  let current: NotionRichText[] = [];
  let bytes = 0;
  for (const item of rich) {
    const size = jsonBytes(item) + 1;
    if (current.length > 0 && (current.length >= RICH_TEXT_PER_BLOCK || bytes + size > NOTION_BLOCK_MAX_BYTES)) {
      runs.push(current);
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += size;
  }
  runs.push(current);
  return runs;
};

const textBlocks = (type: TextBlockType, rich: NotionRichText[]): NotionBlock[] =>
  richTextRuns(rich).map((run): NotionBlock => ({ object: "block", type, [type]: { rich_text: run } }));

const plainRich = (text: string): NotionRichText[] => splitText(text).map((piece) => ({ type: "text", text: { content: piece } }));

/**
 * Notion blocks for Markdown: headings, paragraphs, bullets, numbered items, to-dos, quotes, code
 * fences and dividers. Nested lists are flattened. A first "# heading" equal to `title` is skipped,
 * since it is already the page title.
 */
export const markdownToNotionBlocks = (markdown: string, options: { title?: string } = {}): NotionBlock[] => {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  let index = 0;
  if (lines[0] === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) index = end + 1;
  }
  const blocks: NotionBlock[] = [];
  let paragraph: string[] = [];
  let titleSeen = false;
  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    blocks.push(...textBlocks("paragraph", richText(parseInlineMarkdown(paragraph.join("\n")))));
    paragraph = [];
  };
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    const fence = /^(`{3,}|~{3,})/.exec(trimmed);
    if (fence) {
      flushParagraph();
      const code: string[] = [];
      for (index += 1; index < lines.length && !lines[index].trim().startsWith(fence[1]); index += 1) code.push(lines[index]);
      for (const run of richTextRuns(plainRich(code.join("\n")))) {
        blocks.push({ object: "block", type: "code", code: { rich_text: run, language: "plain text" } });
      }
      continue;
    }
    if (!trimmed) {
      flushParagraph();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      const rich = richText(parseInlineMarkdown(heading[2]));
      const plain = rich.map((item) => item.text.content).join("");
      if (level === 1 && !titleSeen && options.title !== undefined && plain.trim() === options.title.trim()) {
        titleSeen = true;
        continue;
      }
      titleSeen = true;
      blocks.push(...textBlocks(level === 1 ? "heading_1" : level === 2 ? "heading_2" : "heading_3", rich));
      continue;
    }
    if (/^([-*_])(\s*\1){2,}$/.test(trimmed)) {
      flushParagraph();
      blocks.push({ object: "block", type: "divider", divider: {} });
      continue;
    }
    const task = /^[-*+]\s+\[([ xX])\]\s*(.*)$/.exec(trimmed);
    if (task) {
      flushParagraph();
      for (const run of richTextRuns(richText(parseInlineMarkdown(task[2])))) {
        blocks.push({ object: "block", type: "to_do", to_do: { rich_text: run, checked: task[1] !== " " } });
      }
      continue;
    }
    const bullet = /^[-*+]\s+(.*)$/.exec(trimmed);
    if (bullet) {
      flushParagraph();
      blocks.push(...textBlocks("bulleted_list_item", richText(parseInlineMarkdown(bullet[1]))));
      continue;
    }
    const numbered = /^\d{1,9}[.)]\s+(.*)$/.exec(trimmed);
    if (numbered) {
      flushParagraph();
      blocks.push(...textBlocks("numbered_list_item", richText(parseInlineMarkdown(numbered[1]))));
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(trimmed);
    if (quote) {
      flushParagraph();
      blocks.push(...textBlocks("quote", richText(parseInlineMarkdown(quote[1]))));
      continue;
    }
    paragraph.push(trimmed);
  }
  flushParagraph();
  return blocks;
};

const blockRich = (block: NotionBlock): NotionRichText[] | undefined =>
  block.type === "paragraph" ? ((block as Record<string, unknown>).paragraph as { rich_text: NotionRichText[] }).rich_text : undefined;

/**
 * Fits long content (usually a full transcript) under NOTION_MAX_BLOCKS by joining runs of
 * paragraphs into one paragraph per 100 rich-text pieces (and NOTION_BLOCK_MAX_BYTES). Throws when
 * even that is too much.
 */
export const packNotionBlocks = (blocks: NotionBlock[], maxBlocks = NOTION_MAX_BLOCKS): NotionBlock[] => {
  if (blocks.length <= maxBlocks) return blocks;
  const packed: NotionBlock[] = [];
  // JSON size of the last packed paragraph, kept as an upper bound (merging neighbours only shrinks it).
  let previousBytes = 0;
  for (const block of blocks) {
    const rich = blockRich(block);
    const previous = packed[packed.length - 1];
    const previousRich = previous ? blockRich(previous) : undefined;
    const richBytes = rich ? jsonBytes(rich) : 0;
    if (rich && previousRich && previousBytes + richBytes + 64 <= NOTION_BLOCK_MAX_BYTES) {
      const merged = richText([
        ...previousRich.map((item) => ({ text: item.text.content, bold: !!item.annotations, url: item.text.link?.url })),
        { text: "\n\n", bold: false },
        ...rich.map((item) => ({ text: item.text.content, bold: !!item.annotations, url: item.text.link?.url }))
      ]);
      if (merged.length <= RICH_TEXT_PER_BLOCK) {
        ((previous as Record<string, unknown>).paragraph as { rich_text: NotionRichText[] }).rich_text = merged;
        previousBytes += richBytes + 64;
        continue;
      }
    }
    packed.push(rich ? { object: "block", type: "paragraph", paragraph: { rich_text: rich.slice() } } : block);
    previousBytes = richBytes;
  }
  if (packed.length > maxBlocks) throw new ShareError(SHARE_MESSAGES.notionTooLarge, "too-large");
  return packed;
};

/**
 * Request batches of at most 100 blocks whose JSON fits in `maxBytes` (the first batch also carries
 * the page fields, given as `firstOverhead` bytes). Throws when a single block cannot fit.
 */
export const batchNotionBlocks = (
  blocks: NotionBlock[],
  maxBytes = NOTION_REQUEST_MAX_BYTES,
  firstOverhead = 0,
  maxCount = NOTION_BLOCKS_PER_REQUEST
): NotionBlock[][] => {
  const batches: NotionBlock[][] = [];
  let current: NotionBlock[] = [];
  let bytes = firstOverhead + 2;
  for (const block of blocks) {
    const size = jsonBytes(block) + 1;
    if (current.length > 0 && (current.length >= maxCount || bytes + size > maxBytes)) {
      batches.push(current);
      current = [];
      bytes = 2;
    }
    if (bytes + size > maxBytes) throw new ShareError(SHARE_MESSAGES.notionTooLarge, "too-large");
    current.push(block);
    bytes += size;
  }
  if (current.length > 0 || batches.length === 0) batches.push(current);
  return batches;
};

/** Markdown for the `markdown` field: custom-scheme links become plain text, the title heading is dropped. */
export const notionMarkdown = (body: string, title: string): string => {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const first = lines.findIndex((line) => line.trim() !== "");
  if (first >= 0 && /^#\s/.test(lines[first]) && lines[first].slice(1).trim().replace(/\\(.)/g, "$1") === title.trim()) lines.splice(first, 1);
  return lines.join("\n").replace(/\[([^\]\n]{1,500})\]\(((?!https?:\/\/)[^)\s]{1,4000})\)/gi, "$1: $2").trim();
};

export type NotionDeliverInput = {
  share: RenderedShare;
  /** destinations.notionParentId, a dashed id or a page URL. */
  parentId: string;
};

export type NotionDeps = {
  fetch?: typeof fetch;
  /** Defaults to readSecret("NOTION_TOKEN"). */
  token?: string;
  /** Tests point this at a local server; production always uses NOTION_API_URL. */
  baseUrl?: string;
  log?: DeliveryLog;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  timeoutMs?: number;
};

type NotionResponse = { status: number; body: unknown; retryAfterMs?: number };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const redact = (text: string, token: string): string => redactResolvedSecrets(token.length >= 4 ? text.split(token).join("[redacted]") : text);


export const deliverNotion = async (input: NotionDeliverInput, deps: NotionDeps = {}): Promise<DeliveryReceipt> => {
  const share = assertRenderedShare(input.share);
  if (input.parentId === "" || input.parentId === undefined) throw new ShareError(SHARE_MESSAGES.notionNotConfigured, "config");
  const parent = parseNotionPageId(input.parentId);
  if (!parent) throw new ShareError(SHARE_MESSAGES.notionParentInvalid, "config");
  const token = deps.token ?? (await readSecret("NOTION_TOKEN"));
  if (!token || /[\s\p{Cc}]/u.test(token) || token.length > 4096) throw new ShareError(SHARE_MESSAGES.notionNotConfigured, "config");
  const doFetch = deps.fetch ?? fetch;
  const base = checkedBaseUrl(deps.baseUrl, NOTION_API_URL);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const now = deps.now ?? (() => new Date());

  const request = async (method: "POST" | "PATCH", path: string, payload: unknown): Promise<NotionResponse> => {
    for (let attempt = 0; ; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error("timeout")), deps.timeoutMs ?? REQUEST_TIMEOUT_MS);
      const forward = (): void => controller.abort(deps.signal?.reason);
      deps.signal?.addEventListener("abort", forward, { once: true });
      let response: Response;
      try {
        if (deps.signal?.aborted) throw new Error("aborted");
        response = await doFetch(`${base}${path}`, {
          method,
          redirect: "manual",
          signal: controller.signal,
          headers: {
            Authorization: `Bearer ${token}`,
            "Notion-Version": NOTION_VERSION,
            "Content-Type": "application/json",
            Accept: "application/json"
          },
          body: JSON.stringify(payload)
        });
      } catch (error) {
        clearTimeout(timer);
        deps.signal?.removeEventListener("abort", forward);
        if (controller.signal.aborted && !deps.signal?.aborted) throw new ShareError(SHARE_MESSAGES.timeout, "timeout");
        throw new ShareError(SHARE_MESSAGES.networkFailed, "network", redact(String((error as Error)?.message ?? error), token));
      }
      let body: unknown;
      try {
        const text = await response.text();
        body = text.length <= 1_000_000 ? JSON.parse(text) : undefined;
      } catch {
        body = undefined;
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
      return { status: response.status, body };
    }
  };

  const errorFor = (response: NotionResponse): ShareError => {
    const body = isObject(response.body) ? response.body : {};
    const detail = redact(`${response.status} ${typeof body.code === "string" ? body.code : ""} ${typeof body.message === "string" ? body.message : ""}`.trim(), token);
    const error = (message: ShareMessage, code: ShareErrorCode): ShareError => new ShareError(message, code, detail);
    if (response.status === 401) return error(SHARE_MESSAGES.notionAuth, "auth");
    if (response.status === 403 || response.status === 404) return error(SHARE_MESSAGES.notionNoAccess, "forbidden");
    if (response.status === 429) return error(SHARE_MESSAGES.notionRateLimited, "rate-limit");
    if (response.status === 413) return error(SHARE_MESSAGES.notionTooLarge, "too-large");
    if (response.status === 400 || response.status === 422) return error(SHARE_MESSAGES.notionRejected, "rejected");
    return error(SHARE_MESSAGES.notionUnavailable, "unavailable");
  };

  const pageOf = (response: NotionResponse): { id: string; url: string } => {
    const body = isObject(response.body) ? response.body : {};
    const id = typeof body.id === "string" ? body.id.replace(/-/g, "").toLowerCase() : "";
    if (!/^[0-9a-f]{32}$/.test(id)) throw new ShareError(SHARE_MESSAGES.notionUnavailable, "unavailable", "page id missing");
    const url = typeof body.url === "string" && /^https:\/\/[^\s]+$/.test(body.url) && body.url.length <= 2048 ? body.url : `https://www.notion.so/${id}`;
    return { id, url };
  };

  const title = share.title.slice(0, NOTION_RICH_TEXT_MAX);
  const pageBase = {
    parent: { page_id: notionDashedId(parent) },
    properties: { title: { title: [{ type: "text", text: { content: title } }] } }
  };
  const markdown = notionMarkdown(share.body, share.title);
  const sha256 = sha256Hex(share.body);
  let page: { id: string; url: string } | undefined;

  // Measured as sent: JSON escapes (every line break is two bytes) can double the Markdown's size.
  if (jsonBytes({ ...pageBase, markdown }) <= NOTION_REQUEST_MAX_BYTES) {
    const response = await request("POST", "/v1/pages", { ...pageBase, markdown });
    if (response.status >= 200 && response.status < 300) {
      page = pageOf(response);
    } else {
      const body = isObject(response.body) ? response.body : {};
      const rejectsMarkdown = response.status === 400 && typeof body.message === "string" && /markdown/i.test(body.message);
      if (!rejectsMarkdown) throw errorFor(response);
    }
  }
  if (!page) {
    const blocks = packNotionBlocks(markdownToNotionBlocks(share.body, { title: share.title }));
    // Batches respect both Notion limits: 100 blocks and 500 KB per request.
    const [first, ...rest] = batchNotionBlocks(blocks, NOTION_REQUEST_MAX_BYTES, jsonBytes(pageBase));
    const response = await request("POST", "/v1/pages", { ...pageBase, children: first });
    if (response.status < 200 || response.status >= 300) throw errorFor(response);
    page = pageOf(response);
    for (const batch of rest) {
      await sleep(APPEND_SPACING_MS);
      let appended: NotionResponse;
      try {
        appended = await request("PATCH", `/v1/blocks/${notionDashedId(page.id)}/children`, { children: batch });
      } catch (error) {
        throw new ShareError(SHARE_MESSAGES.notionPartial, "partial", `${page.url} ${(error as ShareError).detail ?? ""}`.trim());
      }
      if (appended.status < 200 || appended.status >= 300) throw new ShareError(SHARE_MESSAGES.notionPartial, "partial", `${page.url} ${appended.status}`);
    }
  }
  const at = now().toISOString();
  const target = `notion:page/${parent}`;
  await recordDelivery(deps.log, share.jobId, { at, destination: "notion", target, sha256, result: "created", location: page.url });
  return { at, destination: "notion", target, sha256, result: "created", location: page.url, url: page.url, warnings: [] };
};
