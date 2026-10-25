import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SHARE_MESSAGES, renderShare, renderTextShare, type ShareError, type ShareNote } from "../../share/render";
import { DeliveryLog } from "../log";
import {
  SLACK_MARKDOWN_MAX,
  SLACK_SECTION_MAX,
  deliverSlack,
  escapeSlackText,
  markdownToMrkdwn,
  redactSlackWebhook,
  slackMarkdown,
  splitForSlack,
  validateSlackWebhookUrl
} from "../slack";

const JOB = "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b";
// Built at runtime so the fixture never looks like a real webhook to secret scanners.
const WEBHOOK = ["https://hooks.slack.com/services", "T0123ABCD", "B0456EFGH", "x".repeat(24)].join("/");

const note = (overrides: Partial<ShareNote> = {}): ShareNote => ({
  jobId: JOB,
  title: "Sprint review",
  date: "2026-10-25T14:00:00.000Z",
  people: ["Ana"],
  overview: "Shipped search & filters <beta>.",
  decisions: ["Keep the <!channel> alias out"],
  actions: [{ text: "Write release notes", owner: "Ana", dueDate: "2026-10-27", done: false }],
  link: `falatrace://recording/${JOB}`,
  ...overrides
});
const share = (overrides: Partial<ShareNote> = {}) => renderShare(note(overrides), { frontmatter: false, language: "en", include: "summary", timeZone: "UTC" });

type Seen = { path: string; body: { text: string; blocks: Array<{ type: string; text: unknown }> } };
let servers: Array<{ stop(force?: boolean): void }> = [];
let root: string;
const slept: number[] = [];

const serve = (handler: (request: Seen, index: number) => Response) => {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) => {
      const entry = { path: new URL(request.url).pathname, body: (await request.json()) as Seen["body"] };
      seen.push(entry);
      return handler(entry, seen.length - 1);
    }
  });
  servers.push(server);
  return { baseUrl: `http://127.0.0.1:${server.port}`, seen };
};

const deps = (baseUrl: string, extra: Partial<Parameters<typeof deliverSlack>[1]> = {}) => ({
  baseUrl,
  webhookUrl: WEBHOOK,
  sleep: async (ms: number) => { slept.push(ms); },
  log: new DeliveryLog({ dir: join(root, "log") }),
  ...extra
});

const ok = () => new Response("ok");

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "share-slack-"));
  slept.length = 0;
});
afterEach(async () => {
  for (const server of servers) server.stop(true);
  servers = [];
  await fs.rm(root, { recursive: true, force: true });
});

describe("validateSlackWebhookUrl", () => {
  test("accepts only https://hooks.slack.com/services/…", () => {
    expect(validateSlackWebhookUrl(WEBHOOK).toString()).toBe(WEBHOOK);
  });

  const rejected = [
    WEBHOOK.replace("https:", "http:"),
    "https://hooks.slack.com.evil.example/services/T0123ABCD/B0456EFGH/abc",
    "https://evil.example/services/T0123ABCD/B0456EFGH/abc",
    "https://evil.example/?u=https://hooks.slack.com/services/T/B/c",
    "https://user:pass@hooks.slack.com/services/T0123ABCD/B0456EFGH/abc",
    "https://user@hooks.slack.com/services/T0123ABCD/B0456EFGH/abc",
    "https://hooks.slack.com:8443/services/T0123ABCD/B0456EFGH/abc",
    "https://hooks.slack.com:443/services/T0123ABCD/B0456EFGH/abc",
    "https://HOOKS.SLACK.COM/services/T0123ABCD/B0456EFGH/abc",
    "https://hooks.slack.com/services/T0123ABCD/B0456EFGH/abc?x=1",
    "https://hooks.slack.com/services/T0123ABCD/B0456EFGH/abc#frag",
    "https://hooks.slack.com/triggers/T0123ABCD/123/abc",
    "https://hooks.slack.com/services/T0123ABCD/B0456EFGH",
    "https://hooks.slack.com/services/../../api/x/y",
    "https://hooks.slack.com/services/T0123ABCD/B0456EFGH/abc/extra",
    " https://hooks.slack.com/services/T0123ABCD/B0456EFGH/abc",
    "https://hooks.slack.com/services/T0123ABCD/B0456EFGH/abc\n",
    "hooks.slack.com/services/T0123ABCD/B0456EFGH/abc",
    "javascript:alert(1)"
  ];
  for (const url of rejected) {
    test(`rejects ${JSON.stringify(url)}`, () => {
      expect(() => validateSlackWebhookUrl(url)).toThrow(SHARE_MESSAGES.slackUrlInvalid);
    });
  }

  test("a missing URL asks for configuration", () => {
    expect(() => validateSlackWebhookUrl(undefined)).toThrow(SHARE_MESSAGES.slackNotConfigured);
    expect(() => validateSlackWebhookUrl("")).toThrow(SHARE_MESSAGES.slackNotConfigured);
  });

  test("redaction keeps workspace and channel ids, never the token", () => {
    expect(redactSlackWebhook(validateSlackWebhookUrl(WEBHOOK))).toBe("hooks.slack.com/services/T0123ABCD/B0456EFGH/***");
  });
});

describe("deliverSlack", () => {
  test("posts a markdown block with an escaped mrkdwn text fallback", async () => {
    const { baseUrl, seen } = serve(() => ok());
    const receipt = await deliverSlack({ share: share() }, deps(baseUrl));
    expect(receipt).toMatchObject({ destination: "slack", result: "sent", posts: 1, target: "hooks.slack.com/services/T0123ABCD/B0456EFGH/***" });
    expect(seen.length).toBe(1);
    expect(seen[0].path).toBe(`/services/T0123ABCD/B0456EFGH/${"x".repeat(24)}`);
    const { text, blocks } = seen[0].body;
    expect(blocks.length).toBe(1);
    expect(blocks[0].type).toBe("markdown");
    const markdown = blocks[0].text as string;
    expect(markdown.startsWith("# Sprint review")).toBe(true);
    expect(markdown).toContain("Shipped search &amp; filters &lt;beta&gt;.");
    expect(markdown).toContain("&lt;!channel&gt;");
    expect(markdown).not.toMatch(/<[!@#]/);
    expect(markdown).toContain(`Open in FalaTrace: falatrace://recording/${JOB}`);
    expect(text.startsWith("*Sprint review*")).toBe(true);
    expect(text).toContain("☐ Write release notes (Ana · due 2026-10-27)");
    expect(text).toContain("• Keep the &lt;!channel&gt; alias out");
    expect(text).not.toMatch(/<[!@#]/);
    const logged = await new DeliveryLog({ dir: join(root, "log") }).read(JOB);
    expect(logged[0]).toMatchObject({ destination: "slack", result: "sent", target: "hooks.slack.com/services/T0123ABCD/B0456EFGH/***" });
    expect(JSON.stringify(logged)).not.toContain("x".repeat(24));
  });

  test("long content is split into several posts of at most 12,000 characters", async () => {
    const decisions = Array.from({ length: 160 }, (_, index) => `Decision ${index} ${"détail & <x> ".repeat(14)}`);
    const { baseUrl, seen } = serve(() => ok());
    const receipt = await deliverSlack({ share: share({ decisions }) }, deps(baseUrl));
    expect(seen.length).toBeGreaterThan(1);
    expect(receipt.posts).toBe(seen.length);
    for (const request of seen) expect((request.body.blocks[0].text as string).length).toBeLessThanOrEqual(SLACK_MARKDOWN_MAX);
    const joined = seen.map((request) => request.body.blocks[0].text as string).join("\n\n");
    expect(joined).toContain("Decision 0 ");
    expect(joined).toContain("Decision 159 ");
    expect(joined.indexOf("Decision 0 ")).toBeLessThan(joined.indexOf("Decision 159 "));
    expect(slept.length).toBe(seen.length - 1);
  });

  test("retries with section blocks of at most 3000 characters when Slack refuses the markdown block", async () => {
    const decisions = Array.from({ length: 40 }, (_, index) => `Decision ${index} ${"lorem ipsum ".repeat(15)}`);
    const { baseUrl, seen } = serve((request) => (request.body.blocks[0].type === "markdown" ? new Response("invalid_blocks", { status: 400 }) : ok()));
    const receipt = await deliverSlack({ share: share({ decisions }) }, deps(baseUrl));
    expect(receipt.result).toBe("sent");
    expect(seen.length).toBe(2);
    const sections = seen[1].body.blocks as Array<{ type: string; text: { type: string; text: string } }>;
    expect(sections.length).toBeGreaterThan(1);
    for (const section of sections) {
      expect(section.type).toBe("section");
      expect(section.text.type).toBe("mrkdwn");
      expect(section.text.text.length).toBeLessThanOrEqual(SLACK_SECTION_MAX);
    }
  });

  const statusCases: Array<[number, string, string]> = [
    [403, "invalid_token", SHARE_MESSAGES.slackAuth],
    [404, "no_service", SHARE_MESSAGES.slackAuth],
    [410, "channel_is_archived", SHARE_MESSAGES.slackArchived],
    [400, "invalid_payload", SHARE_MESSAGES.slackRejected],
    [500, "rollup_error", SHARE_MESSAGES.slackUnavailable],
    [302, "", SHARE_MESSAGES.slackUnavailable]
  ];
  for (const [status, body, message] of statusCases) {
    test(`maps HTTP ${status} ${body}`, async () => {
      const { baseUrl } = serve(() => new Response(body, { status, headers: status === 302 ? { Location: "https://evil.example/" } : {} }));
      await expect(deliverSlack({ share: share() }, deps(baseUrl))).rejects.toThrow(message);
    });
  }

  test("429 is retried after Retry-After; other failures are not", async () => {
    const { baseUrl, seen } = serve((_, index) => (index === 0 ? new Response("rate_limited", { status: 429, headers: { "Retry-After": "1" } }) : ok()));
    await deliverSlack({ share: share() }, deps(baseUrl));
    expect(seen.length).toBe(2);
    expect(slept).toEqual([1000]);
    const always = serve(() => new Response("rate_limited", { status: 429, headers: { "Retry-After": "0" } }));
    await expect(deliverSlack({ share: share() }, deps(always.baseUrl))).rejects.toThrow(SHARE_MESSAGES.slackRateLimited);
    expect(always.seen.length).toBe(4);
  });

  test("a 429 without Retry-After waits a second instead of retrying at once", async () => {
    const { baseUrl, seen } = serve((_, index) => (index === 0 ? new Response("rate_limited", { status: 429 }) : ok()));
    await deliverSlack({ share: share() }, deps(baseUrl));
    expect(seen.length).toBe(2);
    expect(slept).toEqual([1000]);
  });

  test("a failure after the first post is reported as partial", async () => {
    const decisions = Array.from({ length: 160 }, (_, index) => `Decision ${index} ${"x".repeat(150)}`);
    const { baseUrl } = serve((_, index) => (index === 0 ? ok() : new Response("rollup_error", { status: 500 })));
    try {
      await deliverSlack({ share: share({ decisions }) }, deps(baseUrl));
      throw new Error("expected failure");
    } catch (error) {
      expect((error as Error).message).toBe(SHARE_MESSAGES.slackPartial);
      expect((error as ShareError).code).toBe("partial");
    }
  });

  test("content needing more than 10 posts is refused before sending", async () => {
    const text = Array.from({ length: 1200 }, (_, index) => `Paragraph ${index} ${"y".repeat(120)}`).join("\n\n");
    const { baseUrl, seen } = serve(() => ok());
    const big = renderTextShare({ title: "Huge", text, language: "en", jobId: JOB });
    await expect(deliverSlack({ share: big }, deps(baseUrl))).rejects.toThrow(SHARE_MESSAGES.slackTooLarge);
    expect(seen.length).toBe(0);
  });

  test("the test origin override cannot point the webhook elsewhere", async () => {
    await expect(deliverSlack({ share: share() }, deps("https://evil.example"))).rejects.toThrow(SHARE_MESSAGES.invalidOptions);
  });

  test("an invalid webhook URL stops before any request, and errors never carry it", async () => {
    const { baseUrl, seen } = serve(() => ok());
    await expect(deliverSlack({ share: share() }, deps(baseUrl, { webhookUrl: "https://evil.example/services/T/B/c" }))).rejects.toThrow(SHARE_MESSAGES.slackUrlInvalid);
    await expect(deliverSlack({ share: share() }, deps(baseUrl, { webhookUrl: "" }))).rejects.toThrow(SHARE_MESSAGES.slackNotConfigured);
    expect(seen.length).toBe(0);
    const closed = serve(() => ok());
    servers.pop()?.stop(true);
    try {
      await deliverSlack({ share: share() }, deps(closed.baseUrl));
      throw new Error("expected failure");
    } catch (error) {
      expect((error as Error).message).toBe(SHARE_MESSAGES.networkFailed);
      expect(String((error as ShareError).detail ?? "")).not.toContain("x".repeat(24));
    }
  });
});

describe("Slack formatting", () => {
  test("escapeSlackText escapes & < >", () => {
    expect(escapeSlackText("a & b <c> <!here> <@U1>")).toBe("a &amp; b &lt;c&gt; &lt;!here&gt; &lt;@U1&gt;");
  });

  test("markdownToMrkdwn converts headings, bold, tasks, bullets and links", () => {
    expect(markdownToMrkdwn("# Title\n\n**Date:** today\n- [ ] todo\n- [x] done\n- item\n[site](https://x.example/a?b=1&c=2) [app](falatrace://recording/1)\n---")).toBe(
      "*Title*\n\n*Date:* today\n☐ todo\n☑ done\n• item\n<https://x.example/a?b=1&amp;c=2|site> app: falatrace://recording/1"
    );
  });

  test("slackMarkdown unescapes FalaTrace's \\< before escaping", () => {
    expect(slackMarkdown("\\<b>x</b> & [a](falatrace://recording/1)")).toBe("&lt;b&gt;x&lt;/b&gt; &amp; a: falatrace://recording/1");
  });

  test("splitForSlack splits at paragraphs, then lines, then words, then characters", () => {
    expect(splitForSlack("aaa\n\nbbb\n\nccc", 8)).toEqual(["aaa\n\nbbb", "ccc"]);
    expect(splitForSlack("one two three four", 9)).toEqual(["one two", "three", "four"]);
    expect(splitForSlack("x".repeat(25), 10)).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
    expect(splitForSlack("l1\nl2\nl3", 5)).toEqual(["l1\nl2", "l3"]);
    for (const piece of splitForSlack("&&&& &&&& &&&&", 12, (value) => escapeSlackText(value).length)) expect(escapeSlackText(piece).length).toBeLessThanOrEqual(12);
  });
});
