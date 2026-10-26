import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { assertQaIsolation } from "../../../scripts/qa-isolation-guard";
import { NOTES_ERRORS, NotesStore } from "../../notes";
import { LIVE_MESSAGES } from "../../live/store";
import { LIVE_PROVIDERS } from "../../config/defaults";
import { UPCOMING_ERRORS } from "../../calendar/upcoming";
import { MEDIA_RETENTION_MESSAGES } from "../../media-retention";
import { TEMPLATE_KNOWN_ERRORS, TEMPLATE_MESSAGES, BUILT_IN_TEMPLATES } from "../../templates";
import { SHARE_MESSAGES } from "../../share";
import { SUMMARY_PREFS_ERRORS } from "../../summary/prefs";
import { StudioSummaryFlow } from "../../summary/studio";
import { ASSISTANT_RUNNER_ERRORS } from "../../assistant/runner";
import { RECIPE_MESSAGES } from "../../recipes";
import { type ChatProvider, ProviderError } from "../../assistant/types";
import { COMMON_PROVIDER_MESSAGES } from "../../assistant/providers/common";
import { ASSISTANT_BRIDGE_MESSAGES } from "../assistant-bridge";
import { CLIENT_OVERRIDE_ERRORS } from "../../clients";
import { queueStudioOpen } from "../open-request";
import { familyOf, handleStudioSummaryOperation, parseRequest } from "../bridge";
import { reviewedSummaryProviderForConfig } from "../../summary/reviewed";
import type { RecordingSummary } from "../../jobs/types";
import type { BridgeContext } from "../bridge-context";
import { familyError } from "../bridge-family";
import { NOTES_BRIDGE_MESSAGES } from "../notes-bridge";
import { SUMMARY_BRIDGE_MESSAGES } from "../summary-bridge";
import { clearSharePreviews } from "../share-bridge";
import { clearMediaTasks, MEDIA_BRIDGE_MESSAGES } from "../media-bridge";
import { HOME_BRIDGE_MESSAGES, searchSnippet } from "../home-bridge";
import { familyFixture, fakeProvider, type FamilyFixture } from "./families-fixture";

assertQaIsolation();

const fixtures: FamilyFixture[] = [];
afterEach(async () => {
  clearSharePreviews();
  clearMediaTasks();
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});
const setup = async (options: Parameters<typeof familyFixture>[0] = {}): Promise<FamilyFixture> => {
  const fixture = await familyFixture(options);
  fixtures.push(fixture);
  return fixture;
};

/** Runs an operation exactly as the bridge does: parse (allowlist + validation), then the family handler. */
const run = async (context: BridgeContext, op: string, payload?: Record<string, unknown>, key?: string): Promise<any> => {
  const parsed = parseRequest({ id: 1, op, ...(key === undefined ? {} : { key }), ...(payload === undefined ? {} : { payload }) });
  const family = familyOf(op)!;
  return family.handle({ id: 1, op, ...(parsed.key === undefined ? {} : { key: parsed.key }), payload: (parsed.payload || {}) as Record<string, unknown> }, context);
};
/** The message the Studio would see for a failed operation. */
const shown = async (context: BridgeContext, op: string, payload?: Record<string, unknown>, key?: string): Promise<string> => {
  try { await run(context, op, payload, key); } catch (error) { return familyError(familyOf(op)!, op, error); }
  throw new Error(`${op} did not fail`);
};
const until = async <T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> => {
  for (let attempt = 0; attempt < 400; attempt++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not reached");
};

describe("notes and live transcript", () => {
  test("notes are read and saved whole, with a revision check; notes of a later job are found by the recording", async () => {
    const f = await setup();
    const read = await run(f.context, "notes-read", undefined, f.job.id);
    expect(read).toMatchObject({ id: f.job.id, rev: 2, text: "# Pauta\n- [ ] Bruno manda a ata" });
    expect(read.entries.map((entry: { id: string; at?: string }) => [entry.id, entry.at])).toEqual([["n000001", "00:02"], ["n000002", "00:12"]]);
    const saved = await run(f.context, "notes-save", { text: `${read.text}\n- decisão: março`, expectedRev: read.rev, title: "Planejamento" }, f.job.id);
    expect(saved).toMatchObject({ rev: 3, saved: true, title: "Planejamento" });
    expect(saved.entries).toHaveLength(3);
    expect(await shown(f.context, "notes-save", { text: "outra janela", expectedRev: 2 }, f.job.id)).toBe(NOTES_ERRORS.conflict);
    const empty = await run(f.context, "notes-read", undefined, randomUUID());
    expect(empty).toMatchObject({ rev: 0, text: "", entries: [], updatedAt: null });
  });

  test("notes typed during the active capture get its media time and recording file", async () => {
    const sessionId = randomUUID();
    const started = new Date(Date.now() - 30_000).toISOString();
    const f = await setup({ deps: { sessions: { read: async () => ({ version: 1, id: sessionId, owner: "manual", backend: "audio", phase: "recording", outputPath: "/home/user/recordings/live.mkv",
      startedAt: started, mediaStartedAt: started }) } } });
    const saved = await run(f.context, "notes-save", { text: "primeira nota", expectedRev: 0 }, sessionId);
    expect(saved.rev).toBe(1);
    expect(saved.entries[0].offsetSeconds).toBeGreaterThanOrEqual(29);
    const stored = await new NotesStore().read(sessionId);
    expect(stored).toMatchObject({ mediaStartedAt: started, sourcePath: "/home/user/recordings/live.mkv" });
    expect(stored?.mediaEndedAt).toBeUndefined();
  });

  test("notes saved right after the capture stopped also get the end of its media", async () => {
    const sessionId = randomUUID();
    const started = new Date(Date.now() - 120_000).toISOString();
    const ended = new Date(Date.now() - 10_000).toISOString();
    const f = await setup({ deps: { sessions: { read: async () => ({ version: 1, id: sessionId, owner: "manual", backend: "audio", phase: "stopped", outputPath: "/home/user/recordings/after.mkv",
      startedAt: started, mediaStartedAt: started, endedAt: ended }) } } });
    await run(f.context, "notes-save", { text: "nota depois de parar", expectedRev: 0 }, sessionId);
    expect(await new NotesStore().read(sessionId)).toMatchObject({ mediaStartedAt: started, mediaEndedAt: ended, sourcePath: "/home/user/recordings/after.mkv" });
    // Another key is not this capture: nothing of the session is copied.
    const other = randomUUID();
    await run(f.context, "notes-save", { text: "outra reunião", expectedRev: 0 }, other);
    const stored = await new NotesStore().read(other);
    expect(stored?.mediaStartedAt).toBeUndefined();
    expect(stored?.sourcePath).toBeUndefined();
  });

  test("live transcript reads empty before the worker writes; turning it on needs the setting and consent for cloud providers", async () => {
    const calls: string[][] = [];
    const f = await setup({ deps: { live: { run: async (command: string, args: string[]) => { calls.push([command, ...args]); return { stdout: "", stderr: "" }; } } } });
    const session = randomUUID();
    expect(await run(f.context, "live-read", { sinceSeq: 0 }, session)).toEqual({ lines: [], lastSeq: 0, hasMore: false, status: "idle", stale: false });
    expect(await shown(f.context, "live-set", { enabled: true }, session)).toBe(LIVE_MESSAGES.disabled);
    // Every provider but the local whisper.cpp sends the audio away: consent first (then the setting is checked).
    for (const provider of LIVE_PROVIDERS) {
      f.config.live.provider = provider;
      expect(await shown(f.context, "live-set", { enabled: true }, session)).toBe(provider === "whisper-cpp" ? LIVE_MESSAGES.disabled : NOTES_BRIDGE_MESSAGES.liveConsent);
    }
    f.config.live.provider = "groq";
    expect(await shown(f.context, "live-set", { enabled: true }, session)).toBe(NOTES_BRIDGE_MESSAGES.liveConsent);
    // Stopping never needs consent and only queues the stop.
    expect(await run(f.context, "live-set", { enabled: false }, session)).toMatchObject({ enabled: false, status: "stopped", external: true });
    expect(calls).toEqual([["systemctl", "--user", "stop", "--no-block", `recording-cli-live-${session}.service`]]);
  });
});

describe("summary status, choices and templates", () => {
  test("an unknown run is reported as unavailable; choices are saved per recording with a revision", async () => {
    const f = await setup();
    expect(await shown(f.context, "summary-status", { requestId: randomUUID() }, f.job.id)).toBe(SUMMARY_BRIDGE_MESSAGES.unavailable);
    expect(await run(f.context, "summary-prefs-read", undefined, f.job.id)).toEqual({ id: f.job.id, rev: 0 });
    const saved = await run(f.context, "summary-prefs-save", { expectedRev: 0, templateId: "postmortem", language: "en" }, f.job.id);
    expect(saved).toMatchObject({ id: f.job.id, rev: 1, templateId: "postmortem", language: "en" });
    expect(await run(f.context, "summary-prefs-read", undefined, f.job.id)).toMatchObject({ rev: 1, templateId: "postmortem", language: "en" });
    expect(await shown(f.context, "summary-prefs-save", { expectedRev: 0, templateId: "general" }, f.job.id)).toBe(SUMMARY_PREFS_ERRORS.conflict);
    const cleared = await run(f.context, "summary-prefs-save", { expectedRev: 1, templateId: "auto", language: "auto" }, f.job.id);
    expect(cleared.templateId).toBeUndefined();
  });

  test("templates list the built-ins and custom ones; custom templates are saved and deleted with their version", async () => {
    const dir = await fs.mkdtemp(join(process.env.TMPDIR!, "templates-"));
    const f = await setup({ deps: { templatesDir: dir } });
    const listed = await run(f.context, "templates-list");
    expect(listed.default).toBe("auto");
    expect(listed.templates.map((item: { id: string }) => item.id)).toEqual(BUILT_IN_TEMPLATES.map((template) => template.id));
    const postmortem = listed.templates.find((item: { id: string }) => item.id === "postmortem");
    expect(postmortem).toMatchObject({ name: "Postmortem de incidente", builtIn: true });
    expect(postmortem.sectionTitles).toContain("Causa raiz");
    const draft = { ...postmortem.template, id: "custom:revisao-de-incidente", builtIn: false, name: { "pt-BR": "Revisão de incidente", en: "Incident review", es: "Revisión de incidente" } };
    const saved = await run(f.context, "templates-save", { template: draft });
    expect(saved.template).toMatchObject({ id: "custom:revisao-de-incidente", version: 1, builtIn: false, name: "Revisão de incidente" });
    expect((await run(f.context, "templates-list")).templates.map((item: { id: string }) => item.id)).toContain("custom:revisao-de-incidente");
    // A built-in id is not a custom template: refused with the module's own message.
    expect(TEMPLATE_KNOWN_ERRORS).toContain(await shown(f.context, "templates-save", { template: { ...draft, id: "postmortem" } }));
    expect(await shown(f.context, "templates-delete", { id: "custom:revisao-de-incidente", expectedVersion: 7 })).toBe(TEMPLATE_MESSAGES.conflict);
    expect(await run(f.context, "templates-delete", { id: "custom:revisao-de-incidente", expectedVersion: 1 })).toEqual({ id: "custom:revisao-de-incidente", deleted: true });
    await fs.rm(dir, { recursive: true, force: true });
  });

  test("a run started with summary-run is polled to its outcome and then refreshes the library", async () => {
    const f = await setup();
    const flow = new StudioSummaryFlow({ identity: reviewedSummaryProviderForConfig(f.config), summarize: async () => ({ ...f.summary, overview: "Notas novas." }) as RecordingSummary });
    const family = (await import("../summary-bridge")).summaryBridge(flow);
    const call = (requestId: string) => ({ id: 1, op: "summary-status", key: f.job.id, payload: { requestId } });
    await expect(family.handle(call(randomUUID()), f.context)).rejects.toThrow(SUMMARY_BRIDGE_MESSAGES.unavailable);
    const requestId = randomUUID();
    const plan: any = await handleStudioSummaryOperation(flow, parseRequest({ id: 2, op: "summary-plan", key: f.job.id, payload: { requestId, maxRequests: 1, templateId: "planning", language: "pt-BR" } }), f.job, f.config);
    // What the Studio discloses before running: template, language, notes and destination.
    expect(plan).toMatchObject({ external: false, template: { id: "planning", source: "user", confidence: 1 }, language: "pt-BR", notesUsed: true, notesCount: 2, destination: { where: "Ollama neste computador" } });
    expect(await handleStudioSummaryOperation(flow, parseRequest({ id: 3, op: "summary-run", key: f.job.id, payload: { requestId, consent: true, consentKey: plan.consentKey } }), f.job, f.config))
      .toEqual({ jobId: f.job.id, requestId, status: "running" });
    const before = f.invalidations;
    const done = await until(() => family.handle(call(requestId), f.context) as Promise<any>, (value) => value.status !== "running");
    expect(done).toMatchObject({ jobId: f.job.id, requestId, status: "completed", notesUsed: true });
    expect(f.invalidations).toBeGreaterThan(before);
    await flow.shutdown();
  });
});

describe("assistant and recipes", () => {
  test("a question is planned, needs consent for an external destination, streams, and keeps numbered citations", async () => {
    const provider = fakeProvider(true);
    const f = await setup({ provider });
    const scope = { kind: "meeting", jobId: f.job.id };
    const plan = await run(f.context, "assistant-plan", { scope, question: "O que foi decidido?" });
    expect(plan).toMatchObject({ ready: true, destination: { label: "Fake · synthetic-model", kind: "api", external: true }, truncated: false });
    expect(plan.consentKey).toMatch(/^[a-f0-9]{64}$/);
    expect(plan.contextCharacters).toBeGreaterThan(0);
    expect(plan.meetings.map((meeting: { jobId: string }) => meeting.jobId)).toEqual([f.job.id]);
    expect(await shown(f.context, "assistant-start", { scope, question: "O que foi decidido?" })).toBe(ASSISTANT_RUNNER_ERRORS.consent);
    const started = await run(f.context, "assistant-start", { scope, question: "O que foi decidido?", consentKey: plan.consentKey });
    expect(started.runId).toMatch(/^[0-9a-f-]{36}$/);
    const done = await until(() => run(f.context, "assistant-poll", { runId: started.runId }), (value) => value.status !== "running");
    expect(done).toMatchObject({ status: "done", threadId: started.threadId, text: "Decidiram adiar o lançamento para março [1].", saved: true });
    expect(done.citations).toEqual([{ n: 1, jobId: f.job.id, segmentId: "s000001", start: 4, title: "Planejamento do lançamento", date: "2026-10-20T13:00:00.000Z" }]);
    expect(provider.requests).toHaveLength(1);
    const threads = await run(f.context, "assistant-threads", { scope });
    expect(threads.threads.map((thread: { id: string }) => thread.id)).toEqual([started.threadId]);
    const thread = await run(f.context, "assistant-thread", { threadId: started.threadId });
    expect(thread.messages.map((message: { role: string }) => message.role)).toEqual(["user", "assistant"]);
    expect(thread.messages[1]).toMatchObject({ text: "Decidiram adiar o lançamento para março [1].", citations: [{ n: 1, segmentId: "s000001" }] });
    expect(await run(f.context, "assistant-thread-delete", { threadId: started.threadId })).toEqual({ threadId: started.threadId, deleted: true });
    expect(await run(f.context, "assistant-cancel", { runId: started.runId })).toEqual({ runId: started.runId, cancelled: false });
  });

  test("recipes run with their prompt filled from the meeting, and refuse a scope they do not fit", async () => {
    const provider = fakeProvider(false, "Assunto: próximos passos [[s000002]]");
    const f = await setup({ provider });
    const recipes = await run(f.context, "recipes-list");
    expect(recipes.recipes.map((recipe: { id: string }) => recipe.id)).toContain("follow-up-email");
    const scope = { kind: "meeting", jobId: f.job.id };
    const started = await run(f.context, "assistant-start", { scope, question: "", recipeId: "follow-up-email" });
    const done = await until(() => run(f.context, "assistant-poll", { runId: started.runId }), (value) => value.status !== "running");
    expect(done.status).toBe("done");
    expect(done.citations[0]).toMatchObject({ n: 1, segmentId: "s000002" });
    const sent = provider.requests[0]!.messages.map((message) => message.content).join("\n");
    expect(sent).toContain("Planejamento do lançamento");
    expect(sent).not.toContain("{{meeting.title}}");
    expect(await shown(f.context, "assistant-start", { scope: { kind: "library" }, question: "", recipeId: "follow-up-email" })).toBe(RECIPE_MESSAGES.scopeMismatch);
    expect(await shown(f.context, "assistant-plan", { scope, question: "", recipeId: "custom:nao-existe" })).toBe(RECIPE_MESSAGES.notFound);
  });

  test("a provider failure shows only known messages; anything else becomes the generic one", async () => {
    const failing = (message: string): ChatProvider => ({ ...fakeProvider(false), run: async () => { throw new ProviderError(message, "unavailable"); } });
    for (const [message, expected] of [["texto cru do provedor com detalhes internos", ASSISTANT_BRIDGE_MESSAGES.failed], [COMMON_PROVIDER_MESSAGES.timeout, COMMON_PROVIDER_MESSAGES.timeout]] as const) {
      const f = await setup({ provider: failing(message) });
      const started = await run(f.context, "assistant-start", { scope: { kind: "meeting", jobId: f.job.id }, question: "O que foi decidido?" });
      const done = await until(() => run(f.context, "assistant-poll", { runId: started.runId }), (value) => value.status !== "running");
      expect(done).toMatchObject({ status: "failed", error: expected });
    }
  });

  test("tools are detected from PATH only and ChatGPT reports signed out", async () => {
    const f = await setup({ deps: { detect: { which: () => null, run: async () => ({ code: 1, stdout: "", stderr: "" }) } as never } });
    const detected = await run(f.context, "assistant-detect");
    expect(detected.acp.every((agent: { found: boolean }) => agent.found === false)).toBe(true);
    expect(detected.cli.every((tool: { found: boolean; signedIn: unknown }) => !tool.found && tool.signedIn === null)).toBe(true);
    expect(detected.chatgpt).toEqual({ signedIn: false });
    expect(await run(f.context, "assistant-chatgpt-status")).toEqual({ state: "idle" });
  });
});

describe("share", () => {
  test("the clipboard gets the previewed note; a preview of changed content is refused", async () => {
    const f = await setup();
    const preview = await run(f.context, "share-preview", { destination: "clipboard", include: "summary+notes", jobId: f.job.id });
    expect(preview).toMatchObject({ external: false, destinationLabel: "Área de transferência", ready: true });
    expect(preview.markdown).toContain("Planejamento do lançamento");
    expect(preview.markdown).toContain("Adiar o lançamento para março.");
    expect(preview.markdown).toContain("Bruno manda a ata");
    expect(preview.chars).toBe(preview.markdown.length);
    const sent = await run(f.context, "share-send", { previewId: preview.previewId });
    expect(sent).toMatchObject({ kind: "returned", destination: "clipboard", opened: false, warnings: [] });
    expect(sent.content).toBe(preview.markdown);
    // Sent once: the preview is gone.
    expect(await shown(f.context, "share-send", { previewId: preview.previewId })).toBe(SHARE_MESSAGES.previewChanged);
    const again = await run(f.context, "share-preview", { destination: "clipboard", include: "summary", jobId: f.job.id });
    await fs.writeFile(join(f.job.artifactDir, "summary.json"), "{}");
    expect(await shown(f.context, "share-send", { previewId: again.previewId })).not.toBe("");
  });

  test("Notion and Slack are external: the preview says what is missing and sending needs consent", async () => {
    const f = await setup({ deps: { destinations: { readSecret: async () => undefined } } });
    const preview = await run(f.context, "share-preview", { destination: "slack", include: "summary", jobId: f.job.id });
    expect(preview).toMatchObject({ external: true, destinationLabel: "Slack", ready: false, problem: SHARE_MESSAGES.slackNotConfigured });
    expect(await shown(f.context, "share-send", { previewId: preview.previewId })).toBe(SHARE_MESSAGES.consentRequired);
  });

  test("an AI app on the web gets the content and its address back; a command-line one opens its terminal here", async () => {
    const handoffDir = await fs.mkdtemp(join(process.env.TMPDIR!, "handoff-"));
    const launched: Array<{ command: string[]; workingDirectory: string }> = [];
    const opened: string[] = [];
    const which = async () => "/usr/bin/codex";
    const share = { log: null, aiApp: { which, handoffDir, launchTerminal: async (command: string[], options: { workingDirectory: string }) => { launched.push({ command, ...options }); },
      openUrl: async (url: string) => { opened.push(url); } } };
    const web = await setup({ config: (config) => { config.destinations.aiApp = "chatgpt-web"; }, deps: { share } });
    const webPreview = await run(web.context, "share-preview", { destination: "ai-app", include: "summary", jobId: web.job.id });
    // The AI app needs consent (DESIGN-STUDIO §2.12): nothing is handed over without it.
    expect(webPreview).toMatchObject({ external: true, ready: true, destinationLabel: "ChatGPT (web)", target: "ai-app:chatgpt-web" });
    expect(await shown(web.context, "share-send", { previewId: webPreview.previewId })).toBe(SHARE_MESSAGES.consentRequired);
    const webSent = await run(web.context, "share-send", { previewId: webPreview.previewId, consent: true });
    expect(webSent).toMatchObject({ kind: "returned", url: "https://chatgpt.com/", opened: false });
    expect(webSent.content).toContain("Planejamento do lançamento");
    expect(opened).toEqual([]);
    const cli = await setup({ config: (config) => { config.destinations.aiApp = "codex-cli"; }, deps: { share, destinations: { which } } });
    const cliPreview = await run(cli.context, "share-preview", { destination: "ai-app", include: "summary", jobId: cli.job.id });
    expect(cliPreview).toMatchObject({ external: true, ready: true, destinationLabel: "Codex CLI" });
    // The command-line tool reads the note and sends it to its provider as soon as it starts.
    expect(await shown(cli.context, "share-send", { previewId: cliPreview.previewId })).toBe(SHARE_MESSAGES.consentRequired);
    expect(launched).toEqual([]);
    const cliSent = await run(cli.context, "share-send", { previewId: cliPreview.previewId, consent: true });
    expect(cliSent).toMatchObject({ kind: "opened", opened: true });
    expect(cliSent.content).toBeUndefined();
    expect(cliSent.path.startsWith(handoffDir)).toBe(true);
    expect(launched).toHaveLength(1);
    expect(launched[0]!.command[0]).toBe("codex");
    expect(await fs.readFile(cliSent.path, "utf8")).toContain("Planejamento do lançamento");
    await fs.rm(handoffDir, { recursive: true, force: true });
  });

  test("consent covers the destination the preview named: another AI app or Notion page set since asks again", async () => {
    const opened: string[] = [];
    const parentA = "0123456789abcdef0123456789abcdef";
    const parentB = "fedcba9876543210fedcba9876543210";
    const created: string[] = [];
    const notionFetch = async (_url: string | URL | Request, init?: RequestInit) => {
      created.push(JSON.parse(String(init?.body)).parent.page_id);
      return new Response(JSON.stringify({ id: "11111111111111111111111111111111", url: "https://www.notion.so/11111111111111111111111111111111" }), { status: 200 });
    };
    const f = await setup({
      config: (config) => { config.destinations.aiApp = "chatgpt-web"; config.destinations.notionParentId = parentA; },
      deps: {
        destinations: { readSecret: async (name) => name === "NOTION_TOKEN" ? "secret_synthetic_token" : undefined },
        share: { log: null, aiApp: { openUrl: async (url: string) => { opened.push(url); } }, notion: { token: "secret_synthetic_token", fetch: notionFetch as typeof fetch } }
      }
    });
    const preview = await run(f.context, "share-preview", { destination: "ai-app", include: "summary", jobId: f.job.id });
    expect(preview).toMatchObject({ external: true, destinationLabel: "ChatGPT (web)", target: "ai-app:chatgpt-web" });
    f.config.destinations.aiApp = "claude-web";
    // Agreed for ChatGPT; Claude is another destination, even with consent.
    expect(await shown(f.context, "share-send", { previewId: preview.previewId, consent: true })).toBe(SHARE_MESSAGES.previewChanged);
    const again = await run(f.context, "share-preview", { destination: "ai-app", include: "summary", jobId: f.job.id });
    expect(again).toMatchObject({ destinationLabel: "Claude (web)", target: "ai-app:claude-web" });
    expect(await run(f.context, "share-send", { previewId: again.previewId, consent: true })).toMatchObject({ kind: "returned", url: "https://claude.ai/new" });
    const notion = await run(f.context, "share-preview", { destination: "notion", include: "summary", jobId: f.job.id });
    expect(notion).toMatchObject({ external: true, ready: true, target: `notion:page/${parentA}` });
    f.config.destinations.notionParentId = parentB;
    expect(await shown(f.context, "share-send", { previewId: notion.previewId, consent: true })).toBe(SHARE_MESSAGES.previewChanged);
    expect(created).toEqual([]);
    f.config.destinations.notionParentId = parentA;
    expect(await run(f.context, "share-send", { previewId: notion.previewId, consent: true })).toMatchObject({ kind: "created", destination: "notion" });
    expect(created).toHaveLength(1);
    expect(created[0]!.replace(/-/g, "")).toBe(parentA);
    expect(opened).toEqual([]);
  });

  test("a Notion send that does not answer stops at the bridge's deadline instead of the Studio's 30 s limit", async () => {
    let requests = 0;
    const hanging = (_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      requests += 1;
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    const f = await setup({
      config: (config) => { config.destinations.notionParentId = "0123456789abcdef0123456789abcdef"; },
      deps: {
        shareSendDeadlineMs: 50,
        destinations: { readSecret: async (name) => name === "NOTION_TOKEN" ? "secret_synthetic_token" : undefined },
        share: { log: null, notion: { token: "secret_synthetic_token", fetch: hanging as typeof fetch } }
      }
    });
    const preview = await run(f.context, "share-preview", { destination: "notion", include: "summary", jobId: f.job.id });
    const started = Date.now();
    expect(await shown(f.context, "share-send", { previewId: preview.previewId, consent: true })).toBe(SHARE_MESSAGES.timeout);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(requests).toBe(1);
  });

  test("an answer is shared as text with its title", async () => {
    const f = await setup();
    const preview = await run(f.context, "share-preview", { destination: "clipboard", include: "summary", text: "Resposta do assistente [1].", title: "Pergunta sobre o lançamento", jobId: f.job.id });
    expect(preview.markdown).toContain("# Pergunta sobre o lançamento");
    expect(preview.markdown).toContain("Resposta do assistente [1].");
  });
});

describe("actions, people and clients", () => {
  test("actions of the summary are listed with counts and marked done", async () => {
    const f = await setup();
    const open = await run(f.context, "actions-list", { status: "open", jobId: f.job.id });
    // The model's action and the note it came from ("- [ ] …") are both listed.
    expect(open.items.map((action: { origin: string }) => action.origin).sort()).toEqual(["model", "note"]);
    const item = open.items.find((action: { origin: string }) => action.origin === "model");
    expect(item).toMatchObject({ jobId: f.job.id, text: "Bruno manda a ata", owner: "Bruno", dueDate: "sexta", status: "open", matchState: "current", ownerPersonIds: ["name:bruno lima"] });
    expect(open.counts).toMatchObject({ open: 2, done: 0 });
    const set = await run(f.context, "action-set", { mediaSha256: item.mediaSha256, actionId: item.actionId, status: "done", expectedRev: item.rev });
    expect(set.item).toMatchObject({ actionId: item.actionId, status: "done" });
    const done = await run(f.context, "actions-list", { status: "done", jobId: f.job.id });
    expect(done.items.map((action: { actionId: string }) => action.actionId)).toEqual([item.actionId]);
    expect(await shown(f.context, "action-set", { mediaSha256: item.mediaSha256, actionId: item.actionId, status: "open", expectedRev: item.rev })).toBe("As ações mudaram em outra janela; recarregue e tente de novo.");
  });

  test("people come from the calendar attendees and can be renamed; the user is marked", async () => {
    const f = await setup();
    const listed = await run(f.context, "people-list");
    const ana = listed.people.find((person: { name: string }) => person.name === "Ana Souza");
    // Other recordings of this test run met the same people: only this one is checked.
    expect(ana).toMatchObject({ id: "name:ana souza", self: false });
    expect(listed.people.find((person: { name: string }) => person.name === "Pessoa Dona")?.self).toBe(true);
    const detail = await run(f.context, "person-detail", { personId: ana.id });
    expect(detail.meetings.map((meeting: { jobId: string }) => meeting.jobId)).toContain(f.job.id);
    const renamed = await run(f.context, "person-edit", { personId: ana.id, op: "rename", value: "Ana S. Souza" });
    expect(renamed).toMatchObject({ changed: true });
    expect(renamed.personId).toMatch(/^[0-9a-f-]{36}$/);
    const after = await run(f.context, "people-list");
    expect(after.people.find((person: { id: string }) => person.id === renamed.personId)?.name).toBe("Ana S. Souza");
  });

  test("clients are added to the catalog and assigned to a meeting", async () => {
    const f = await setup();
    expect(await run(f.context, "clients-list")).toMatchObject({ clients: [], editable: true });
    const added = await run(f.context, "client-edit", { op: "add", code: "ACME", name: "Acme Ltda" });
    expect(added).toMatchObject({ code: "ACME", client: { code: "ACME", name: "Acme Ltda" } });
    await run(f.context, "client-edit", { op: "alias-add", code: "ACME", value: "acme corp" });
    const assigned = await run(f.context, "meeting-client-set", { clientCodes: ["ACME"] }, f.job.id);
    expect(assigned).toEqual({ jobId: f.job.id, clients: [{ code: "ACME", name: "Acme Ltda", source: "manual" }] });
    const clients = await run(f.context, "clients-list");
    expect(clients.clients[0]).toMatchObject({ code: "ACME", aliases: ["acme corp"], meetingCount: 1 });
    expect((await run(f.context, "client-detail", { clientCode: "ACME" })).meetings[0].jobId).toBe(f.job.id);
    expect(await shown(f.context, "meeting-client-set", { clientCodes: ["NOPE"] }, f.job.id)).toBe(CLIENT_OVERRIDE_ERRORS.unknownClient);
    const automatic = await run(f.context, "meeting-client-set", { automatic: true }, f.job.id);
    expect(automatic.clients).toEqual([]);
  });
});

describe("home, links, first run and search", () => {
  test("home without a calendar lists open actions and notes being generated", async () => {
    const f = await setup();
    const home = await run(f.context, "home-read");
    expect(home).toMatchObject({ upcoming: [], calendarConnected: false, reminderMode: "on" });
    // At most five open actions (other recordings of this test run have some too); the total counts them all.
    expect(home.openActions.length).toBeGreaterThan(0);
    expect(home.openActions.length).toBeLessThanOrEqual(5);
    expect(home.openActionsTotal).toBeGreaterThanOrEqual(2);
    expect(home.openActions[0]).toMatchObject({ status: "open", matchState: "current" });
  });

  test("upcoming meetings show their plan, template and brief; a decision is kept for the meeting", async () => {
    const stateDir = await fs.mkdtemp(join(process.env.TMPDIR!, "overrides-"));
    const start = new Date(Date.now() + 30 * 60_000);
    const event = { id: `gnome-event-${randomUUID()}`, title: "Planejamento do lançamento", startAtMs: start.getTime(), endAtMs: start.getTime() + 3_600_000, recurring: false };
    const f = await setup({
      config: (config) => { config.calendar.enabled = true; },
      deps: { upcoming: { gnome: async () => [event], salt: async () => "b".repeat(64) }, overrides: { stateDir } }
    });
    const home = await run(f.context, "home-read");
    expect(home.calendarConnected).toBe(true);
    expect(home.upcoming).toHaveLength(1);
    const upcoming = home.upcoming[0];
    expect(upcoming).toMatchObject({ title: "Planejamento do lançamento", plan: "notify", template: { id: "planning", source: "calendar" } });
    // Earlier meetings with the same people and title (this test run has several such recordings).
    expect(upcoming.brief.recentMeetings.length).toBeGreaterThan(0);
    expect(upcoming.brief.recentMeetings.every((meeting: { title: string }) => meeting.title === "Planejamento do lançamento")).toBe(true);
    expect(upcoming.brief.lines.length).toBeGreaterThan(0);
    const skipped = await run(f.context, "meeting-override", { eventIdHash: upcoming.eventIdHash, decision: "skip" });
    expect(skipped).toMatchObject({ saved: true, plan: "skip" });
    expect((await run(f.context, "home-read")).upcoming[0].plan).toBe("skip");
    // Without a call monitor that records, "record" asks the Studio to start a capture itself.
    expect(await run(f.context, "meeting-override", { eventIdHash: upcoming.eventIdHash, decision: "record" })).toMatchObject({ saved: false, startCapture: true });
    expect(await run(f.context, "meeting-override", { eventIdHash: upcoming.eventIdHash, decision: "clear" })).toMatchObject({ saved: true, plan: "notify" });
    expect(await shown(f.context, "meeting-override", { eventIdHash: "c".repeat(64), decision: "skip" })).toBe(HOME_BRIDGE_MESSAGES.eventGone);
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  test("a calendar that does not answer stops at the bridge's deadline: Home answers without it", async () => {
    let signalled = false;
    const f = await setup({
      config: (config) => { config.google.calendar = true; config.google.clientId = "123456789012-abcdefghijklmnop.apps.googleusercontent.com"; },
      deps: {
        calendarDeadlineMs: 50,
        upcoming: {
          salt: async () => "b".repeat(64),
          // Like a token renewal or an event list that never answers: only the abort ends it.
          google: (_from, _to, signal) => new Promise((_resolve, reject) => {
            signalled = signal !== undefined;
            signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          })
        }
      }
    });
    const started = Date.now();
    const home = await run(f.context, "home-read");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(signalled).toBe(true);
    expect(home).toMatchObject({ upcoming: [], calendarConnected: true, calendarError: UPCOMING_ERRORS.unavailable });
    expect(await shown(f.context, "meeting-override", { eventIdHash: "c".repeat(64), decision: "skip" })).toBe(HOME_BRIDGE_MESSAGES.eventGone);
  });

  test("links queued for the Studio are taken once; the first-run celebration is dismissed once", async () => {
    const dir = await fs.mkdtemp(join(process.env.TMPDIR!, "inbox-"));
    const stateDir = await fs.mkdtemp(join(process.env.TMPDIR!, "first-run-"));
    const f = await setup({ deps: { inbox: { dir: join(dir, "inbox") }, firstRun: { stateDir } } });
    await queueStudioOpen(`falatrace://recording/${f.job.id}`, { dir: join(dir, "inbox") });
    expect(await run(f.context, "inbox-take")).toEqual({ uris: [`falatrace://recording/${f.job.id}`] });
    expect(await run(f.context, "inbox-take")).toEqual({ uris: [] });
    const dismissed = await run(f.context, "first-run-dismiss");
    expect(dismissed.firstRun.celebrationDismissedAt).toMatch(/^\d{4}-/);
    expect((await run(f.context, "first-run-dismiss")).firstRun.celebrationDismissedAt).toBe(dismissed.firstRun.celebrationDismissedAt);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  test("library search returns segments with their meeting, time and a snippet", async () => {
    const f = await setup();
    const result = await run(f.context, "library-search", { query: "orçamento ata", limit: 5 });
    const hit = result.hits.find((item: { jobId: string }) => item.jobId === f.job.id);
    expect(hit).toMatchObject({ key: f.source, title: "Planejamento do lançamento", date: "2026-10-20T13:00:00.000Z", kind: "segments" });
    expect(hit.snippet).toContain("orçamento");
    expect(searchSnippet("a ".repeat(300) + "palavra-chave aqui", "chave")).toMatch(/^….*chave aqui$/);
  });
});

describe("media removal", () => {
  test("planning and removing are start + poll; unknown requests are refused", async () => {
    const f = await setup();
    expect(await shown(f.context, "media-status", { requestId: randomUUID() })).toBe(MEDIA_BRIDGE_MESSAGES.unavailable);
    const started = await run(f.context, "media-plan", undefined, f.source);
    expect(started).toMatchObject({ status: "running" });
    const plan = await until(() => run(f.context, "media-status", { requestId: started.requestId }), (value) => value.status !== "running");
    expect(plan).toMatchObject({ kind: "plan", status: "completed", key: f.source });
    expect(plan.options.map((option: { mode: string }) => option.mode)).toEqual(["transcript-only", "audio-only"]);
    expect(plan.options[1].bytesFreed).toBeNull();
    expect(plan.consentKey).toMatch(/^[a-f0-9]{64}$/);
    expect(f.invalidations).toBeGreaterThan(0);
  });

  test("a second plan of the same recording joins the running one; a removal with a stale consent removes nothing", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let hashes = 0;
    const hashFile = async (path: string): Promise<string> => {
      hashes += 1;
      await gate;
      return createHash("sha256").update(await fs.readFile(path)).digest("hex");
    };
    const f = await setup({ deps: { retention: { hashFile } } });
    const first = await run(f.context, "media-plan", undefined, f.source);
    await until(async () => hashes, (count) => count > 0);
    // Planning hashes the whole media: a second click while it runs gets the same request.
    const second = await run(f.context, "media-plan", undefined, f.source);
    expect(second.requestId).toBe(first.requestId);
    release();
    const plan = await until(() => run(f.context, "media-status", { requestId: first.requestId }), (value) => value.status !== "running");
    expect(plan).toMatchObject({ status: "completed", kind: "plan" });
    const removal = await run(f.context, "media-remove", { mode: "transcript-only", consentKey: "0".repeat(64) }, f.source);
    const outcome = await until(() => run(f.context, "media-status", { requestId: removal.requestId }), (value) => value.status !== "running");
    expect(outcome).toMatchObject({ kind: "remove", status: "failed", error: MEDIA_RETENTION_MESSAGES.planChanged });
    expect(outcome.removed).toBeUndefined();
    expect((await fs.stat(f.source)).isFile()).toBe(true);
  });
});

describe("list and detail fields from the index", () => {
  test("detail carries the notes document built from the v2 summary, action state and notes", async () => {
    const f = await setup();
    const { detailExtras } = await import("../meeting-view");
    const extras: any = await detailExtras({ job: f.job, config: f.config, studio: f.studio, summaryReady: true });
    expect(extras.notes).toMatchObject({ id: f.job.id, rev: 2 });
    expect(extras.calendar).toEqual({ title: "Planejamento do lançamento", startAt: "2026-10-20T13:00:00.000Z", endAt: "2026-10-20T14:00:00.000Z" });
    // The user is not listed; names follow the people store (another test may have renamed Ana).
    expect(extras.people).toHaveLength(2);
    expect(extras.people.map((person: { name: string }) => person.name)).toContain("Bruno Lima");
    const doc = extras.notesDoc;
    expect(doc).toMatchObject({ version: 2, language: "pt-BR", stale: null, template: { id: "planning", source: "calendar", confidence: 0.8 },
      overview: { text: "Reunião sobre o lançamento.", citations: [{ segmentId: "s000001", start: 4 }] } });
    expect(doc.sections.map((section: { heading: string }) => section.heading)).toEqual(["Decisões", "Próximos passos"]);
    expect(doc.sections[0].items[0]).toMatchObject({ kind: "decision", origin: "ai", at: "00:04", uncertain: false });
    const action = doc.sections[1].items[0];
    // The user's own item is tied to the action of its note.
    expect(action).toMatchObject({ kind: "action", origin: "user", at: "00:12", uncertain: true, noteIds: ["n000002"], action: { status: "open", owner: "" } });
    expect(doc.unusedNotes).toEqual([{ text: "Pauta", at: "00:02" }]);
    // Notes edited after the summary make it stale for notes.
    await new NotesStore().save(f.job.id, { text: "# Pauta\n- [ ] Bruno manda a ata\n- nova", expectedRev: 2 });
    expect(((await detailExtras({ job: f.job, config: f.config, studio: f.studio, summaryReady: true })) as any).notesDoc.stale).toBe("notes");
  });

  test("list items get people, client, duration, notes and open actions from the snapshot only", async () => {
    const f = await setup();
    const { listItemExtras } = await import("../meeting-view");
    const entry = (await f.context.library.find(f.source)).entry;
    expect(listItemExtras(entry, f.studio)).toMatchObject({ jobId: f.job.id, people: ["Ana Souza", "Bruno Lima"], hasNotes: true, openActions: 2, durationSeconds: 16 });
  });
});
