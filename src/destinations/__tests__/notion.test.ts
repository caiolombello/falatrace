import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SHARE_MESSAGES, ShareError, renderShare, type ShareNote } from "../../share/render";
import { DeliveryLog } from "../log";
import {
  NOTION_API_URL,
  NOTION_BLOCK_MAX_BYTES,
  NOTION_REQUEST_MAX_BYTES,
  NOTION_VERSION,
  batchNotionBlocks,
  checkedBaseUrl,
  deliverNotion,
  markdownToNotionBlocks,
  notionDashedId,
  notionMarkdown,
  packNotionBlocks,
  parseNotionPageId,
  retryAfterMs,
  splitText,
  type NotionBlock,
  type NotionRichText
} from "../notion";

const JOB = "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b";
const PARENT = "0123456789abcdef0123456789abcdef";
const PAGE = "fedcba9876543210fedcba9876543210";
const TOKEN = "ntn_secret_token_value_1234567890";

const note = (overrides: Partial<ShareNote> = {}): ShareNote => ({
  jobId: JOB,
  title: "Kickoff",
  date: "2026-10-25T14:00:00.000Z",
  people: ["Ana"],
  overview: "Summary text.",
  decisions: ["Decision one"],
  actions: [{ text: "Send deck", owner: "Ana", dueDate: "", done: false }, { text: "Done thing", owner: "", dueDate: "", done: true }],
  link: `falatrace://recording/${JOB}`,
  ...overrides
});
const share = (overrides: Partial<ShareNote> = {}, include: "summary" | "full" = "summary") =>
  renderShare(note(overrides), { frontmatter: true, language: "en", include, timeZone: "UTC" });

type Seen = { method: string; path: string; headers: Headers; body: Record<string, unknown> };
type Handler = (request: Seen, index: number) => Response | Promise<Response>;

let servers: Array<{ stop(force?: boolean): void }> = [];
let root: string;

const serve = (handler: Handler) => {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const entry: Seen = {
        method: request.method,
        path: new URL(request.url).pathname,
        headers: request.headers,
        body: (await request.json().catch(() => ({}))) as Record<string, unknown>
      };
      seen.push(entry);
      return handler(entry, seen.length - 1);
    }
  });
  servers.push(server);
  return { baseUrl: `http://127.0.0.1:${server.port}`, seen };
};

const created = () => Response.json({ object: "page", id: notionDashedId(PAGE), url: `https://www.notion.so/Kickoff-${PAGE}` });
const rejectMarkdown = () => Response.json({ object: "error", status: 400, code: "validation_error", message: "body failed validation: body.markdown should be not present." }, { status: 400 });
const appended = () => Response.json({ object: "list", results: [] });

const noSleep: number[] = [];
const deps = (baseUrl: string, extra: Partial<Parameters<typeof deliverNotion>[1]> = {}) => ({
  baseUrl,
  token: TOKEN,
  sleep: async (ms: number) => { noSleep.push(ms); },
  log: new DeliveryLog({ dir: join(root, "log") }),
  ...extra
});

const allRichText = (blocks: NotionBlock[]): NotionRichText[] =>
  blocks.flatMap((block) => ((block as Record<string, unknown>)[block.type] as { rich_text?: NotionRichText[] }).rich_text ?? []);

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "share-notion-"));
  noSleep.length = 0;
});
afterEach(async () => {
  for (const server of servers) server.stop(true);
  servers = [];
  await fs.rm(root, { recursive: true, force: true });
});

describe("deliverNotion", () => {
  test("creates a page with markdown under the parent page", async () => {
    const { baseUrl, seen } = serve(() => created());
    const content = share();
    const receipt = await deliverNotion({ share: content, parentId: PARENT }, deps(baseUrl));
    expect(receipt).toMatchObject({ destination: "notion", result: "created", target: `notion:page/${PARENT}`, url: `https://www.notion.so/Kickoff-${PAGE}` });
    expect(seen.length).toBe(1);
    const [request] = seen;
    expect(request.method).toBe("POST");
    expect(request.path).toBe("/v1/pages");
    expect(request.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(request.headers.get("notion-version")).toBe(NOTION_VERSION);
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(request.body.parent).toEqual({ page_id: notionDashedId(PARENT) });
    expect(request.body.properties).toEqual({ title: { title: [{ type: "text", text: { content: "Kickoff" } }] } });
    expect(request.body.children).toBeUndefined();
    const markdown = request.body.markdown as string;
    expect(markdown.startsWith("**Date:**")).toBe(true);
    expect(markdown).not.toContain("# Kickoff");
    expect(markdown).not.toContain("falatrace_snapshot");
    expect(markdown).toContain(`Open in FalaTrace: falatrace://recording/${JOB}`);
    expect(markdown).not.toContain("](falatrace://");
    const logged = await new DeliveryLog({ dir: join(root, "log") }).read(JOB);
    expect(logged[0]).toMatchObject({ destination: "notion", result: "created", location: receipt.url });
  });

  test("accepts a pasted page URL as the parent", async () => {
    const { baseUrl, seen } = serve(() => created());
    await deliverNotion({ share: share(), parentId: `https://www.notion.so/acme/Meetings-${PARENT}?pvs=4` }, deps(baseUrl));
    expect(seen[0].body.parent).toEqual({ page_id: notionDashedId(PARENT) });
  });

  test("falls back to blocks when markdown is rejected, in batches of 100", async () => {
    const decisions = Array.from({ length: 180 }, (_, index) => `Decision ${index}`);
    const { baseUrl, seen } = serve((request, index) => (index === 0 ? rejectMarkdown() : request.method === "POST" ? created() : appended()));
    const receipt = await deliverNotion({ share: share({ decisions }), parentId: PARENT }, deps(baseUrl));
    expect(receipt.result).toBe("created");
    expect(seen.map((request) => `${request.method} ${request.path}`)).toEqual([
      "POST /v1/pages",
      "POST /v1/pages",
      `PATCH /v1/blocks/${notionDashedId(PAGE)}/children`
    ]);
    const first = seen[1].body.children as NotionBlock[];
    const second = seen[2].body.children as NotionBlock[];
    expect(seen[1].body.markdown).toBeUndefined();
    expect(first.length).toBe(100);
    expect(second.length).toBeLessThanOrEqual(100);
    const blocks = [...first, ...second];
    // Title heading skipped (it is the page title); meta paragraph, summary heading and text, decisions, actions, divider, link.
    expect(blocks[0].type).toBe("paragraph");
    expect(blocks.filter((block) => block.type === "bulleted_list_item").length).toBe(180);
    expect(blocks.filter((block) => block.type === "to_do").map((block) => (block as { to_do: { checked: boolean } }).to_do.checked)).toEqual([false, true]);
    expect(blocks.filter((block) => block.type === "heading_2").length).toBe(3);
    expect(blocks.some((block) => block.type === "divider")).toBe(true);
    const text = allRichText(blocks).map((item) => item.text.content).join("");
    expect(text).toContain(`Open in FalaTrace: falatrace://recording/${JOB}`);
    expect(noSleep.length).toBe(1);
  });

  test("long text is split into rich-text pieces of at most 2000 characters", async () => {
    const overview = `${"word ".repeat(900)}end`;
    const { baseUrl, seen } = serve((_, index) => (index === 0 ? rejectMarkdown() : created()));
    await deliverNotion({ share: share({ overview }), parentId: PARENT }, deps(baseUrl));
    const blocks = seen[1].body.children as NotionBlock[];
    const paragraph = blocks.find((block) => block.type === "paragraph" && allRichText([block]).map((item) => item.text.content).join("").startsWith("word")) as NotionBlock;
    const pieces = allRichText([paragraph]);
    expect(pieces.length).toBe(3);
    for (const piece of pieces) expect(piece.text.content.length).toBeLessThanOrEqual(2000);
    expect(pieces.map((piece) => piece.text.content).join("")).toBe(overview.trim());
    for (const piece of allRichText(blocks)) expect(piece.text.content.length).toBeLessThanOrEqual(2000);
  });

  test("a full transcript is packed under 1000 blocks and appended in order", async () => {
    const transcript = Array.from({ length: 1500 }, (_, index) => ({ at: "00:01", speaker: "Ana", text: `line ${index}` }));
    const { baseUrl, seen } = serve((request, index) => (index === 0 ? rejectMarkdown() : request.method === "POST" ? created() : appended()));
    await deliverNotion({ share: share({ transcript }, "full"), parentId: PARENT }, deps(baseUrl));
    const batches = seen.slice(1).map((request) => request.body.children as NotionBlock[]);
    const blocks = batches.flat();
    expect(blocks.length).toBeLessThanOrEqual(1000);
    for (const batch of batches) expect(batch.length).toBeLessThanOrEqual(100);
    for (const block of blocks) expect(allRichText([block]).length).toBeLessThanOrEqual(100);
    const text = allRichText(blocks).map((item) => item.text.content).join("");
    expect(text.indexOf("line 0")).toBeLessThan(text.indexOf("line 1499"));
    expect(text).toContain("line 777");
  });

  test("large content is sent in requests under Notion's 500 KB limit, in order", async () => {
    // ~780,000 characters of three-byte text: about 2.3 MB of JSON, far past one request.
    const transcript = Array.from({ length: 200 }, (_, index) => ({ at: "00:01", speaker: "Ana", text: `L${index}: ${"会議".repeat(1950)}` }));
    const sizes: number[] = [];
    const seen: Array<{ method: string; body: Record<string, unknown> }> = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        const raw = await request.text();
        sizes.push(Buffer.byteLength(raw, "utf8"));
        seen.push({ method: request.method, body: JSON.parse(raw) as Record<string, unknown> });
        return request.method === "POST" ? created() : appended();
      }
    });
    servers.push(server);
    const receipt = await deliverNotion({ share: share({ transcript }, "full"), parentId: PARENT }, deps(`http://127.0.0.1:${server.port}`));
    expect(receipt.result).toBe("created");
    // The markdown body would not fit either, so blocks go straight away.
    expect(seen[0].method).toBe("POST");
    expect(seen[0].body.markdown).toBeUndefined();
    expect(seen.slice(1).every((request) => request.method === "PATCH")).toBe(true);
    expect(seen.length).toBeGreaterThan(2);
    for (const size of sizes) expect(size).toBeLessThanOrEqual(NOTION_REQUEST_MAX_BYTES);
    const blocks = seen.flatMap((request) => request.body.children as NotionBlock[]);
    for (const block of blocks) expect(JSON.stringify(block).length).toBeLessThan(NOTION_BLOCK_MAX_BYTES);
    const text = allRichText(blocks).map((item) => item.text.content).join("");
    const positions = [0, 57, 123, 199].map((index) => text.indexOf(`L${index}: `));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((left, right) => left - right)).toEqual(positions);
  });

  test("a 429 without Retry-After waits a second instead of retrying at once", async () => {
    const { baseUrl, seen } = serve((_, index) => (index === 0 ? new Response("{}", { status: 429 }) : created()));
    await deliverNotion({ share: share(), parentId: PARENT }, deps(baseUrl));
    expect(seen.length).toBe(2);
    expect(noSleep).toEqual([1000]);
    expect(retryAfterMs(null)).toBe(1000);
    expect(retryAfterMs("")).toBe(1000);
    expect(retryAfterMs("Wed, 21 Oct 2026 07:28:00 GMT")).toBe(1000);
    expect(retryAfterMs("-1")).toBe(1000);
    expect(retryAfterMs("0")).toBe(0);
    expect(retryAfterMs(" 2 ")).toBe(2000);
  });

  test("retries only HTTP 429, honouring Retry-After", async () => {
    const { baseUrl, seen } = serve((_, index) => (index === 0 ? new Response("{}", { status: 429, headers: { "Retry-After": "2" } }) : created()));
    await deliverNotion({ share: share(), parentId: PARENT }, deps(baseUrl));
    expect(seen.length).toBe(2);
    expect(noSleep).toEqual([2000]);
    const always = serve(() => new Response("{}", { status: 429, headers: { "Retry-After": "0" } }));
    await expect(deliverNotion({ share: share(), parentId: PARENT }, deps(always.baseUrl))).rejects.toThrow(SHARE_MESSAGES.notionRateLimited);
    expect(always.seen.length).toBe(4);
    const long = serve(() => new Response("{}", { status: 429, headers: { "Retry-After": "120" } }));
    await expect(deliverNotion({ share: share(), parentId: PARENT }, deps(long.baseUrl))).rejects.toThrow(SHARE_MESSAGES.notionRateLimited);
    expect(long.seen.length).toBe(1);
    const failing = serve(() => new Response("{}", { status: 503 }));
    await expect(deliverNotion({ share: share(), parentId: PARENT }, deps(failing.baseUrl))).rejects.toThrow(SHARE_MESSAGES.notionUnavailable);
    expect(failing.seen.length).toBe(1);
  });

  const statusCases: Array<[number, string]> = [
    [401, SHARE_MESSAGES.notionAuth],
    [403, SHARE_MESSAGES.notionNoAccess],
    [404, SHARE_MESSAGES.notionNoAccess],
    [400, SHARE_MESSAGES.notionRejected],
    [413, SHARE_MESSAGES.notionTooLarge],
    [500, SHARE_MESSAGES.notionUnavailable],
    [302, SHARE_MESSAGES.notionUnavailable]
  ];
  for (const [status, message] of statusCases) {
    test(`maps HTTP ${status}`, async () => {
      const { baseUrl } = serve(() => new Response(JSON.stringify({ object: "error", code: "x", message: "nope" }), { status, headers: status === 302 ? { Location: "https://evil.example/" } : {} }));
      await expect(deliverNotion({ share: share(), parentId: PARENT }, deps(baseUrl))).rejects.toThrow(message);
    });
  }

  test("error details never carry the token", async () => {
    const { baseUrl } = serve(() => Response.json({ object: "error", code: "unauthorized", message: `API token ${TOKEN} is invalid.` }, { status: 401 }));
    try {
      await deliverNotion({ share: share(), parentId: PARENT }, deps(baseUrl));
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ShareError);
      expect((error as ShareError).detail).toContain("[redacted]");
      expect((error as ShareError).detail).not.toContain(TOKEN);
      expect((error as Error).message).not.toContain(TOKEN);
    }
  });

  test("network failures and timeouts are reported plainly", async () => {
    const closed = serve(() => created());
    servers.pop()?.stop(true);
    await expect(deliverNotion({ share: share(), parentId: PARENT }, deps(closed.baseUrl))).rejects.toThrow(SHARE_MESSAGES.networkFailed);
    const slow = serve(async () => {
      await new Promise((done) => setTimeout(done, 500));
      return created();
    });
    await expect(deliverNotion({ share: share(), parentId: PARENT }, deps(slow.baseUrl, { timeoutMs: 50 }))).rejects.toThrow(SHARE_MESSAGES.timeout);
  });

  test("a failed append after the page exists is a partial delivery naming the page", async () => {
    const decisions = Array.from({ length: 150 }, (_, index) => `Decision ${index}`);
    const { baseUrl } = serve((request, index) => (index === 0 ? rejectMarkdown() : request.method === "POST" ? created() : new Response("{}", { status: 500 })));
    try {
      await deliverNotion({ share: share({ decisions }), parentId: PARENT }, deps(baseUrl));
      throw new Error("expected failure");
    } catch (error) {
      expect((error as Error).message).toBe(SHARE_MESSAGES.notionPartial);
      expect((error as ShareError).code).toBe("partial");
      expect((error as ShareError).detail).toContain(PAGE);
    }
  });

  test("refuses missing or unsafe configuration before any request", async () => {
    const { baseUrl, seen } = serve(() => created());
    await expect(deliverNotion({ share: share(), parentId: "" }, deps(baseUrl))).rejects.toThrow(SHARE_MESSAGES.notionNotConfigured);
    await expect(deliverNotion({ share: share(), parentId: "not-an-id" }, deps(baseUrl))).rejects.toThrow(SHARE_MESSAGES.notionParentInvalid);
    await expect(deliverNotion({ share: share(), parentId: PARENT }, deps(baseUrl, { token: "" }))).rejects.toThrow(SHARE_MESSAGES.notionNotConfigured);
    await expect(deliverNotion({ share: share(), parentId: PARENT }, deps(baseUrl, { token: "abc\r\nX-Evil: 1" }))).rejects.toThrow(SHARE_MESSAGES.notionNotConfigured);
    expect(seen.length).toBe(0);
  });

  test("a response without a page id is not trusted", async () => {
    const { baseUrl } = serve(() => Response.json({ object: "page" }));
    await expect(deliverNotion({ share: share(), parentId: PARENT }, deps(baseUrl))).rejects.toThrow(SHARE_MESSAGES.notionUnavailable);
    const noUrl = serve(() => Response.json({ object: "page", id: PAGE, url: "javascript:alert(1)" }));
    const receipt = await deliverNotion({ share: share(), parentId: PARENT }, deps(noUrl.baseUrl));
    expect(receipt.url).toBe(`https://www.notion.so/${PAGE}`);
  });
});

describe("Notion helpers", () => {
  test("an injected origin can only be the real API or a loopback test server", async () => {
    expect(checkedBaseUrl(undefined, NOTION_API_URL)).toBe(NOTION_API_URL);
    expect(checkedBaseUrl("https://api.notion.com/", NOTION_API_URL)).toBe(NOTION_API_URL);
    expect(checkedBaseUrl("http://127.0.0.1:4567", NOTION_API_URL)).toBe("http://127.0.0.1:4567");
    for (const value of ["https://evil.example", "http://api.notion.com", "https://api.notion.com.evil.example", "http://user:pw@127.0.0.1:1", "not a url"]) {
      expect(() => checkedBaseUrl(value, NOTION_API_URL)).toThrow(SHARE_MESSAGES.invalidOptions);
    }
    await expect(deliverNotion({ share: share(), parentId: PARENT }, { token: TOKEN, baseUrl: "https://evil.example" })).rejects.toThrow(SHARE_MESSAGES.invalidOptions);
  });

  test("parseNotionPageId", () => {
    expect(parseNotionPageId(PARENT)).toBe(PARENT);
    expect(parseNotionPageId(notionDashedId(PARENT).toUpperCase())).toBe(PARENT);
    expect(parseNotionPageId(`https://www.notion.so/acme/Meeting-Notes-${PARENT}`)).toBe(PARENT);
    expect(parseNotionPageId(`https://acme.notion.site/${PARENT}`)).toBe(PARENT);
    expect(parseNotionPageId(`https://www.notion.so/acme?p=${PARENT}&pm=s`)).toBe(PARENT);
    expect(parseNotionPageId(`http://www.notion.so/${PARENT}`)).toBeUndefined();
    expect(parseNotionPageId(`https://evil.example/${PARENT}`)).toBeUndefined();
    expect(parseNotionPageId("https://www.notion.so/no-id-here")).toBeUndefined();
    expect(parseNotionPageId("")).toBeUndefined();
  });

  test("markdownToNotionBlocks covers the Markdown FalaTrace and the assistant write", () => {
    const blocks = markdownToNotionBlocks([
      "---", "title: \"x\"", "---",
      "# Title", "", "# Another H1", "## H2", "#### H4",
      "Para **bold** and [link](https://x.example/a) and [app](falatrace://recording/y) \\# escaped",
      "second line of the same paragraph", "",
      "- [ ] todo", "* [x] done", "- bullet", "+ plus", "1. first", "2) second", "> quote", "***",
      "```ts", "const a = 1;", "```"
    ].join("\n"), { title: "Title" });
    expect(blocks.map((block) => block.type)).toEqual([
      "heading_1", "heading_2", "heading_3", "paragraph", "to_do", "to_do", "bulleted_list_item", "bulleted_list_item",
      "numbered_list_item", "numbered_list_item", "quote", "divider", "code"
    ]);
    const paragraph = allRichText([blocks[3]]);
    expect(paragraph).toEqual([
      { type: "text", text: { content: "Para " } },
      { type: "text", text: { content: "bold" }, annotations: { bold: true } },
      { type: "text", text: { content: " and " } },
      { type: "text", text: { content: "link", link: { url: "https://x.example/a" } } },
      { type: "text", text: { content: " and app: falatrace://recording/y # escaped\nsecond line of the same paragraph" } }
    ]);
    expect((blocks[12] as { code: { rich_text: NotionRichText[]; language: string } }).code.rich_text[0].text.content).toBe("const a = 1;");
  });

  test("splitText never cuts a surrogate pair", () => {
    const pieces = splitText(`${"a".repeat(1999)}😀b`, 2000);
    expect(pieces).toEqual(["a".repeat(1999), "😀b"]);
    expect(splitText("")).toEqual([]);
  });

  test("packNotionBlocks keeps small content untouched and refuses what cannot fit", () => {
    const few = markdownToNotionBlocks("a\n\nb");
    expect(packNotionBlocks(few, 10)).toBe(few);
    const many = markdownToNotionBlocks(Array.from({ length: 30 }, (_, index) => `p${index}`).join("\n\n"));
    const packed = packNotionBlocks(many, 5);
    expect(packed.length).toBe(1);
    expect(allRichText(packed).map((item) => item.text.content).join("")).toBe(Array.from({ length: 30 }, (_, index) => `p${index}`).join("\n\n"));
    const headings = markdownToNotionBlocks(Array.from({ length: 30 }, (_, index) => `## h${index}`).join("\n"));
    expect(() => packNotionBlocks(headings, 5)).toThrow(SHARE_MESSAGES.notionTooLarge);
  });

  test("packed and converted blocks stay under the per-block byte budget", () => {
    // 60 paragraphs of ~6 KB of JSON each: packing them all into one would exceed the budget.
    const big = markdownToNotionBlocks(Array.from({ length: 60 }, (_, index) => `${index} ${"çã".repeat(990)}`).join("\n\n"));
    const packed = packNotionBlocks(big, 20);
    expect(packed.length).toBeGreaterThan(1);
    expect(packed.length).toBeLessThanOrEqual(20);
    for (const block of packed) expect(Buffer.byteLength(JSON.stringify(block), "utf8")).toBeLessThanOrEqual(NOTION_BLOCK_MAX_BYTES + 1000);
    // One paragraph of 100 pieces of three-byte text is split by bytes, not only by piece count.
    const huge = markdownToNotionBlocks("会".repeat(100 * 2000));
    expect(huge.length).toBeGreaterThan(1);
    for (const block of huge) expect(Buffer.byteLength(JSON.stringify(block), "utf8")).toBeLessThanOrEqual(NOTION_BLOCK_MAX_BYTES + 7000);
    expect(allRichText(huge).map((item) => item.text.content).join("")).toBe("会".repeat(100 * 2000));
  });

  test("batchNotionBlocks limits each request by count and by bytes", () => {
    const small = markdownToNotionBlocks(Array.from({ length: 250 }, (_, index) => `p${index}`).join("\n\n"));
    expect(batchNotionBlocks(small).map((batch) => batch.length)).toEqual([100, 100, 50]);
    const heavy = markdownToNotionBlocks(Array.from({ length: 10 }, (_, index) => `${index} ${"x".repeat(1990)}`).join("\n\n"));
    const batches = batchNotionBlocks(heavy, 5_000, 1_000);
    expect(batches.flat()).toEqual(heavy);
    expect(batches[0].length).toBe(1);
    for (const [index, batch] of batches.entries()) {
      expect(Buffer.byteLength(JSON.stringify(batch), "utf8") + (index === 0 ? 1_000 : 0)).toBeLessThanOrEqual(5_000);
    }
    expect(() => batchNotionBlocks(heavy, 500)).toThrow(SHARE_MESSAGES.notionTooLarge);
    expect(batchNotionBlocks([])).toEqual([[]]);
  });

  test("notionMarkdown drops the title heading and custom-scheme links", () => {
    expect(notionMarkdown("# My \\<b> title\n\ntext [x](falatrace://recording/1) [y](https://ok.example)", "My <b> title")).toBe("text x: falatrace://recording/1 [y](https://ok.example)");
  });
});
