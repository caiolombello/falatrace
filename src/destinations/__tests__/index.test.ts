import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type AppConfig } from "../../config/defaults";
import { SHARE_MESSAGES, renderShare, type ShareNote } from "../../share/render";
import { AI_APP_LABELS, DeliveryLog, describeDestinations, deliverShare } from "../index";

const JOB = "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b";
// Built at runtime so the fixture never looks like a real webhook to secret scanners.
const WEBHOOK = ["https://hooks.slack.com/services", "T0123ABCD", "B0456EFGH", "x".repeat(24)].join("/");
const note: ShareNote = {
  jobId: JOB,
  title: "Planning",
  date: "2026-10-25T09:00:00.000Z",
  people: [],
  overview: "Plan agreed.",
  decisions: ["Go"],
  actions: [],
  link: `falatrace://recording/${JOB}`
};
const share = () => renderShare(note, { frontmatter: false, language: "en", include: "summary", timeZone: "UTC" });

let root: string;
let config: AppConfig;
let servers: Array<{ stop(force?: boolean): void }> = [];

beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "share-index-"));
  config = structuredClone(DEFAULT_CONFIG);
});
afterEach(async () => {
  for (const server of servers) server.stop(true);
  servers = [];
  await fs.rm(root, { recursive: true, force: true });
});

const serve = (status: number, body: string) => {
  let hits = 0;
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => { hits += 1; return new Response(body, { status }); } });
  servers.push(server);
  return { baseUrl: `http://127.0.0.1:${server.port}`, hits: () => hits };
};

describe("deliverShare", () => {
  test("Notion and Slack need explicit consent; nothing is sent without it", async () => {
    const slack = serve(200, "ok");
    const log = new DeliveryLog({ dir: join(root, "log") });
    await expect(deliverShare({ share: share(), config, request: { destination: "slack" } }, { log, slack: { baseUrl: slack.baseUrl, webhookUrl: WEBHOOK } }))
      .rejects.toThrow(SHARE_MESSAGES.consentRequired);
    await expect(deliverShare({ share: share(), config, request: { destination: "notion" }, consent: false }, { log })).rejects.toThrow(SHARE_MESSAGES.consentRequired);
    expect(slack.hits()).toBe(0);
    const receipt = await deliverShare({ share: share(), config, request: { destination: "slack" }, consent: true }, { log, slack: { baseUrl: slack.baseUrl, webhookUrl: WEBHOOK, sleep: async () => undefined } });
    expect(receipt.result).toBe("sent");
    expect(slack.hits()).toBe(1);
  });

  test("content that differs from the preview is refused", async () => {
    await expect(deliverShare({ share: share(), config, request: { destination: "clipboard", mode: "return" }, expectedSnapshot: "0".repeat(64) }, { log: null }))
      .rejects.toThrow(SHARE_MESSAGES.previewChanged);
    const content = share();
    const receipt = await deliverShare({ share: content, config, request: { destination: "clipboard", mode: "return" }, expectedSnapshot: content.snapshot }, { log: null });
    expect(receipt.content).toBe(content.markdown);
  });

  test("routes Obsidian through the configured vault and folder", async () => {
    const vault = join(root, "vault");
    await fs.mkdir(vault);
    config.destinations.obsidianVault = vault;
    config.destinations.obsidianFolder = "Notes";
    const receipt = await deliverShare({ share: share(), config, request: { destination: "obsidian" }, timeZone: "UTC" }, { log: new DeliveryLog({ dir: join(root, "log") }) });
    expect(receipt.location).toBe(join(vault, "Notes", "2026-10-25 09-00 — Planning.md"));
  });

  test("routes AI apps to the configured app unless the request names one", async () => {
    const opened: string[] = [];
    config.destinations.aiApp = "gemini-web";
    const aiApp = { openUrl: async (url: string) => { opened.push(url); }, run: async () => undefined, env: { WAYLAND_DISPLAY: "w" } };
    await deliverShare({ share: share(), config, request: { destination: "ai-app", clipboard: "system" } }, { log: null, aiApp });
    await deliverShare({ share: share(), config, request: { destination: "ai-app", target: "claude-web", clipboard: "system" } }, { log: null, aiApp });
    expect(opened).toEqual(["https://gemini.google.com/app", "https://claude.ai/new"]);
  });

  test("failed sends are recorded; configuration errors are not", async () => {
    const slack = serve(500, "rollup_error");
    const log = new DeliveryLog({ dir: join(root, "log") });
    await expect(deliverShare({ share: share(), config, request: { destination: "slack" }, consent: true }, { log, slack: { baseUrl: slack.baseUrl, webhookUrl: WEBHOOK } }))
      .rejects.toThrow(SHARE_MESSAGES.slackUnavailable);
    await expect(deliverShare({ share: share(), config, request: { destination: "slack" }, consent: true }, { log, slack: { webhookUrl: "" } }))
      .rejects.toThrow(SHARE_MESSAGES.slackNotConfigured);
    const records = await log.read(JOB);
    expect(records.length).toBe(1);
    expect(records[0]).toMatchObject({ destination: "slack", result: "failed", target: "slack" });
  });

  test("unknown destinations and tampered content are refused", async () => {
    await expect(deliverShare({ share: share(), config, request: { destination: "email" } as never }, { log: null })).rejects.toThrow(SHARE_MESSAGES.unknownDestination);
    await expect(deliverShare({ share: { ...share(), body: "x" }, config, request: { destination: "clipboard", mode: "return" } }, { log: null })).rejects.toThrow(SHARE_MESSAGES.invalidNote);
  });
});

describe("describeDestinations", () => {
  test("defaults: only the clipboard and the default web app are ready", async () => {
    const statuses = await describeDestinations(config, { readSecret: async () => undefined, which: async () => undefined });
    expect(statuses.map((status) => [status.destination, status.ready, status.problem])).toEqual([
      ["obsidian", false, SHARE_MESSAGES.obsidianNotConfigured],
      ["notion", false, SHARE_MESSAGES.notionNotConfigured],
      ["slack", false, SHARE_MESSAGES.slackNotConfigured],
      ["clipboard", true, undefined],
      ["ai-app", true, undefined]
    ]);
    expect(statuses.find((status) => status.destination === "ai-app")?.aiApp).toBe("chatgpt-web");
    expect(statuses.filter((status) => status.external).map((status) => status.destination)).toEqual(["notion", "slack"]);
  });

  test("configured destinations are ready with redacted targets", async () => {
    const vault = join(root, "vault");
    await fs.mkdir(vault);
    config.destinations.obsidianVault = vault;
    config.destinations.notionParentId = "0123456789abcdef0123456789abcdef";
    config.destinations.aiApp = "codex-cli";
    const secrets: Record<string, string> = { NOTION_TOKEN: "ntn_x", SLACK_WEBHOOK_URL: WEBHOOK };
    const statuses = await describeDestinations(config, { readSecret: async (name) => secrets[name], which: async (binary) => `/usr/bin/${binary}` });
    for (const status of statuses) expect(status.ready).toBe(true);
    expect(statuses.find((status) => status.destination === "obsidian")?.target).toBe(`${vault}/FalaTrace`);
    expect(statuses.find((status) => status.destination === "notion")?.target).toBe("notion:page/0123456789abcdef0123456789abcdef");
    expect(statuses.find((status) => status.destination === "slack")?.target).toBe("hooks.slack.com/services/T0123ABCD/B0456EFGH/***");
    expect(JSON.stringify(statuses)).not.toContain("x".repeat(24));
    expect(JSON.stringify(statuses)).not.toContain("ntn_x");
  });

  test("explains what is wrong", async () => {
    config.destinations.obsidianVault = join(root, "missing");
    config.destinations.aiApp = "claude-cli";
    const statuses = await describeDestinations(config, {
      readSecret: async (name) => (name === "SLACK_WEBHOOK_URL" ? "http://hooks.slack.com/services/T/B/c" : "token"),
      which: async () => undefined
    });
    const problem = (destination: string) => statuses.find((status) => status.destination === destination)?.problem;
    expect(problem("obsidian")).toBe(SHARE_MESSAGES.obsidianVaultInvalid);
    expect(problem("notion")).toBe(SHARE_MESSAGES.notionNotConfigured);
    expect(problem("slack")).toBe(SHARE_MESSAGES.slackUrlInvalid);
    expect(problem("ai-app")).toBe(SHARE_MESSAGES.aiToolMissing);
  });

  test("every AI app target has a label", () => {
    expect(Object.keys(AI_APP_LABELS).sort()).toEqual(["chatgpt-web", "claude-cli", "claude-desktop", "claude-web", "codex-cli", "gemini-cli", "gemini-web", "opencode-cli"]);
  });
});
