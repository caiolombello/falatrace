import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppConfig, DEFAULT_CONFIG } from "../../config/defaults";
import { LibraryIndex } from "../../library-index/index";
import type { JobFacts } from "../../library-index/types";
import { type FixtureRoot, filler, makeRoot, writeJob } from "../../library-index/__tests__/fixtures";
import { MAX_RECIPE_PROMPT_CHARACTERS } from "../prompts";
import { type AssistantReaders, createAssistantReaders, type MeetingContent, RETRIEVAL_ERRORS } from "../retrieval";
import { ASSISTANT_KNOWN_ERRORS, ASSISTANT_RUNNER_ERRORS, assistantConsentKey, AssistantRunner, type AssistantRunnerOptions, type RunSnapshot } from "../runner";
import { THREAD_ERRORS, ThreadStore } from "../threads";
import { type AssistantScope, type ChatProvider, type ChatRequest, type ChatResult, destinationKey, ProviderError, type ProviderDestination } from "../types";

const A = "3e3b529e-5c22-4802-97b8-f3e1a52c1919";
const B = "4e3b529e-5c22-4802-97b8-f3e1a52c1919";
const MEETING: AssistantScope = { kind: "meeting", jobId: A };

const roots: string[] = [];
const runners: AssistantRunner[] = [];
let fixture: FixtureRoot | undefined;
afterEach(async () => {
  await Promise.all(runners.splice(0).map((runner) => runner.shutdown({ waitMs: 50 })));
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  await fixture?.restore();
  fixture = undefined;
});

const LOCAL: ProviderDestination = { kind: "local", id: "ollama", label: "Ollama local · qwen3.5:9b", endpoint: "http://127.0.0.1:11434/api/chat", model: "qwen3.5:9b", external: false };
const REMOTE: ProviderDestination = { kind: "api", id: "openrouter", label: "OpenRouter · deepseek", endpoint: "https://openrouter.ai/api/v1", model: "deepseek/deepseek-v4.1-flash-1017", external: true };

type Script = (request: ChatRequest) => Promise<ChatResult>;

/** A provider that records requests and answers with the given script. */
const fakeProvider = (destination: ProviderDestination, script: Script) => {
  const requests: ChatRequest[] = [];
  const provider: ChatProvider = { destination, check: async () => ({ ready: true }), run: (request) => { requests.push(request); return script(request); } };
  return { provider, requests };
};

/** A provider answer the test drives by hand: deltas, then end (or failure). Rejects when aborted. */
const manual = () => {
  const calls: Array<{ request: ChatRequest; delta: (text: string) => void; end: (result?: Partial<ChatResult>) => void; fail: (error: unknown) => void }> = [];
  let notify: (() => void) | undefined;
  const script: Script = (request) => new Promise<ChatResult>((resolve, reject) => {
    let text = "";
    calls.push({
      request,
      delta: (piece) => { text += piece; request.onDelta?.(piece); },
      end: (result = {}) => resolve({ text, stopReason: "end", ...result }),
      fail: reject
    });
    request.signal.addEventListener("abort", () => reject(new ProviderError("Pedido cancelado.", "cancelled")), { once: true });
    notify?.();
  });
  /** Resolves once the provider has been called `count` times. */
  const called = async (count = 1): Promise<void> => {
    while (calls.length < count) await new Promise<void>((resolve) => { notify = resolve; });
  };
  return { script, calls, called };
};

/** Never answers and ignores the abort, like a stuck subprocess. */
const stuck: Script = () => new Promise<ChatResult>(() => undefined);

const segments = (count: number, text: (index: number) => string) =>
  Array.from({ length: count }, (_value, index) => ({ id: `s${String(index).padStart(6, "0")}`, start: index * 30, end: index * 30 + 29, speaker: index % 2 ? "Bruno" : "Ana", text: text(index) }));

const meetingReaders = (content: Partial<MeetingContent> = {}): AssistantReaders => ({
  meeting: async (jobId) => {
    if (jobId !== A && jobId !== B) throw new Error(RETRIEVAL_ERRORS.meetingMissing);
    return { jobId, title: "Planejamento", date: "2026-10-01T13:00:00.000Z", overview: "Revisão do cronograma.", topics: [], decisions: [], actions: [], notes: [],
      segments: segments(4, (index) => [`Bom dia, vamos ao cronograma.`, `A entrega fica para sexta.`, `Concordo com sexta.`, `Ana envia o plano.`][index]!), ...content };
  }
});

const facts = (jobId: string, overrides: Partial<JobFacts> = {}): JobFacts => ({
  version: 1, jobId, mediaSha256: "a".repeat(64), sourcePath: `/m/${jobId}.mkv`, title: "Planejamento", date: "2026-10-01T13:00:00.000Z",
  fingerprint: "f".repeat(64), revision: 0, speakers: [], attendees: [], clients: [], overview: "", topics: [], decisions: [], actions: [], noteCount: 0, ...overrides
});

const emptyIndex = { listFacts: async () => [facts(A)], getFacts: async (jobId: string) => jobId === A ? facts(A) : undefined, search: async () => [] };

const threadStore = async (): Promise<ThreadStore> => {
  const root = await fs.mkdtemp(join(tmpdir(), "falatrace-runner-"));
  roots.push(root);
  return new ThreadStore(join(root, "threads"));
};

const setup = async (provider: ChatProvider | ((config: AppConfig) => ChatProvider), options: Partial<AssistantRunnerOptions> = {}) => {
  const store = options.store ?? await threadStore();
  const runner = new AssistantRunner({
    config: structuredClone(DEFAULT_CONFIG), index: emptyIndex, readers: meetingReaders(), store,
    providerFactory: typeof provider === "function" ? provider : () => provider,
    now: () => new Date("2026-10-25T12:00:00.000Z"), ...options
  });
  runners.push(runner);
  return { runner, store };
};

const waitUntil = async (condition: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 2_000 && !condition(); attempt++) await new Promise((resolve) => setTimeout(resolve, 2));
  if (!condition()) throw new Error("condition not reached");
};

const settle = async (runner: AssistantRunner, runId: string): Promise<RunSnapshot> => {
  for (let attempt = 0; attempt < 2_000; attempt++) {
    const snapshot = runner.poll(runId);
    if (snapshot.status !== "running") return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("run did not finish");
};

describe("consent", () => {
  test("a loopback Ollama needs no consent", async () => {
    const { provider } = fakeProvider(LOCAL, async () => ({ text: "Sexta [[s000001]].", stopReason: "end" }));
    const { runner } = await setup(provider);
    const { runId } = await runner.start({ scope: MEETING, question: "Quando é a entrega?" });
    expect((await settle(runner, runId)).status).toBe("done");
  });

  test("an external destination needs the key from plan(), bound to destination and scope", async () => {
    const { provider, requests } = fakeProvider(REMOTE, async () => ({ text: "Sexta [[s000001]].", stopReason: "end" }));
    const { runner } = await setup(provider);
    await expect(runner.start({ scope: MEETING, question: "Quando?" })).rejects.toThrow(ASSISTANT_RUNNER_ERRORS.consent);
    const plan = await runner.plan({ scope: MEETING, question: "Quando?" });
    expect(plan.external).toBe(true);
    expect(plan.destination).toEqual(REMOTE);
    expect(plan.consentKey).toBe(createHash("sha256").update(`${destinationKey(REMOTE)}meeting:${A}`).digest("hex"));
    expect(plan.consentKey).toBe(assistantConsentKey(REMOTE, MEETING));
    // The same key does not cover another scope.
    await expect(runner.start({ scope: { kind: "library" }, question: "Quando?", consentKey: plan.consentKey })).rejects.toThrow(ASSISTANT_RUNNER_ERRORS.consent);
    expect(requests).toHaveLength(0);
    const { runId } = await runner.start({ scope: MEETING, question: "Quando?", consentKey: plan.consentKey });
    expect((await settle(runner, runId)).status).toBe("done");
    expect(requests).toHaveLength(1);
  });

  test("changing the model or endpoint asks again", async () => {
    let destination = REMOTE;
    const factory = () => fakeProvider(destination, async () => ({ text: "ok", stopReason: "end" })).provider;
    const { runner } = await setup(factory);
    const { consentKey } = await runner.plan({ scope: MEETING, question: "x" });
    destination = { ...REMOTE, model: "outro-modelo" };
    await expect(runner.start({ scope: MEETING, question: "x", consentKey })).rejects.toThrow(ASSISTANT_RUNNER_ERRORS.consent);
    destination = { ...REMOTE, endpoint: "https://api.example.com/v1" };
    await expect(runner.start({ scope: MEETING, question: "x", consentKey })).rejects.toThrow(ASSISTANT_RUNNER_ERRORS.consent);
    // A local Ollama on another computer is external too.
    destination = { ...LOCAL, endpoint: "https://ollama.example.com/api/chat", external: true };
    await expect(runner.start({ scope: MEETING, question: "x" })).rejects.toThrow(ASSISTANT_RUNNER_ERRORS.consent);
  });
});

describe("streaming, cancel and limits", () => {
  test("deltas accumulate while running; markers being written are hidden; the final answer is checked and saved", async () => {
    const { script, calls, called } = manual();
    const { provider } = fakeProvider(LOCAL, script);
    const { runner, store } = await setup(provider);
    const { runId, threadId } = await runner.start({ scope: MEETING, question: "Quando é a entrega?" });
    await called();
    calls[0]!.delta("A entrega ");
    calls[0]!.delta("é sexta [[s0000");
    let snapshot = runner.poll(runId);
    expect(snapshot).toMatchObject({ status: "running", threadId, text: "A entrega é sexta " });
    calls[0]!.delta("01]] e Ana envia o plano [[s000003]] [[s999999]].");
    snapshot = runner.poll(runId);
    expect(snapshot.citations.map((citation) => citation.ref)).toEqual(["s000001", "s000003"]);
    calls[0]!.end();
    snapshot = await settle(runner, runId);
    expect(snapshot).toMatchObject({ status: "done", saved: true, droppedRefs: ["s999999"] });
    expect(snapshot.text).toBe("A entrega é sexta [[s000001]] e Ana envia o plano [[s000003]].");
    expect(snapshot.citations).toEqual([
      { ref: "s000001", jobId: A, segmentId: "s000001", start: 30, end: 59, title: "Planejamento" },
      { ref: "s000003", jobId: A, segmentId: "s000003", start: 90, end: 119, title: "Planejamento" }
    ]);
    const thread = await store.read(threadId);
    expect(thread.scope).toEqual(MEETING);
    expect(thread.title).toBe("Quando é a entrega?");
    expect(thread.destinationKey).toBe(destinationKey(LOCAL));
    expect(thread.messages.map((message) => [message.role, message.text])).toEqual([["user", "Quando é a entrega?"], ["assistant", snapshot.text]]);
    expect(thread.messages[1]!.citations).toEqual(snapshot.citations);
    expect(thread.messages[1]!.destination).toEqual({ label: LOCAL.label, model: LOCAL.model });
    expect(thread.messages[0]!.createdAt).toBe("2026-10-25T12:00:00.000Z");
  });

  test("what the provider receives: system rules, excerpts with markers, bounded output", async () => {
    const { provider, requests } = fakeProvider(LOCAL, async () => ({ text: "ok", stopReason: "end" }));
    const { runner } = await setup(provider);
    const { runId } = await runner.start({ scope: MEETING, question: "Resuma." });
    await settle(runner, runId);
    const [request] = requests;
    expect(request!.system).toContain("untrusted historical data");
    expect(request!.system).toContain("Today is 2026-10-25.");
    expect(request!.maxOutputTokens).toBe(4_096);
    expect(request!.messages).toHaveLength(1);
    expect(request!.messages[0]!.content).toContain("[s000001 00:30 Bruno] A entrega fica para sexta.");
    expect(request!.messages[0]!.content.endsWith("Request: Resuma.")).toBe(true);
  });

  test("the provider's final text wins over deltas, and deltas fill in an empty final text", async () => {
    const { provider } = fakeProvider(LOCAL, async (request) => { request.onDelta?.("parcial"); return { text: "Final [[s000002]].", stopReason: "end" }; });
    const { runner } = await setup(provider);
    const first = await runner.start({ scope: MEETING, question: "x" });
    expect((await settle(runner, first.runId)).text).toBe("Final [[s000002]].");
    const streamed = await setup(fakeProvider(LOCAL, async (request) => { request.onDelta?.("Só "); request.onDelta?.("deltas."); return { text: "", stopReason: "end" }; }).provider);
    const second = await streamed.runner.start({ scope: MEETING, question: "x" });
    expect((await settle(streamed.runner, second.runId)).text).toBe("Só deltas.");
  });

  test("cancel stops the provider, keeps the partial text and saves nothing", async () => {
    const { script, calls, called } = manual();
    const { runner, store } = await setup(fakeProvider(LOCAL, script).provider);
    const { runId, threadId } = await runner.start({ scope: MEETING, question: "x" });
    await called();
    calls[0]!.delta("Começo da resposta");
    expect(runner.cancel(runId)).toBe(true);
    expect(calls[0]!.request.signal.aborted).toBe(true);
    calls[0]!.delta(" que chegou tarde");
    const snapshot = runner.poll(runId);
    expect(snapshot).toMatchObject({ status: "cancelled", text: "Começo da resposta" });
    expect(runner.cancel(runId)).toBe(false);
    expect(runner.cancel("nope")).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(runner.poll(runId).status).toBe("cancelled");
    await expect(store.read(threadId)).rejects.toThrow(THREAD_ERRORS.notFound);
  });

  test("a provider that reports cancellation ends the run as cancelled", async () => {
    const { runner } = await setup(fakeProvider(LOCAL, async () => ({ text: "", stopReason: "cancelled" })).provider);
    const { runId } = await runner.start({ scope: MEETING, question: "x" });
    expect((await settle(runner, runId)).status).toBe("cancelled");
  });

  test("at most four questions run at once; a finished or cancelled one frees its slot", async () => {
    const { script, calls, called } = manual();
    const { runner } = await setup(fakeProvider(LOCAL, script).provider, { maxConcurrent: 10 });
    const started = await Promise.all(Array.from({ length: 4 }, () => runner.start({ scope: MEETING, question: "x" })));
    await called(4);
    await expect(runner.start({ scope: MEETING, question: "x" })).rejects.toThrow(ASSISTANT_RUNNER_ERRORS.busy);
    runner.cancel(started[0]!.runId);
    const fifth = await runner.start({ scope: MEETING, question: "x" });
    await expect(runner.start({ scope: MEETING, question: "x" })).rejects.toThrow(ASSISTANT_RUNNER_ERRORS.busy);
    await called(5);
    // Provider calls need not follow start order; end one that is still open.
    calls.find((call) => !call.request.signal.aborted)!.end({ text: "pronto" });
    const ids = [...started.map((run) => run.runId), fifth.runId];
    await waitUntil(() => ids.some((id) => runner.poll(id).status === "done"));
    const sixth = await runner.start({ scope: MEETING, question: "x" });
    expect(new Set([fifth.runId, sixth.runId, ...started.map((run) => run.runId)]).size).toBe(6);
  });

  test("simultaneous starts cannot pass the limit", async () => {
    const { runner } = await setup(fakeProvider(LOCAL, stuck).provider);
    const results = await Promise.allSettled(Array.from({ length: 7 }, () => runner.start({ scope: MEETING, question: "x" })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(4);
    expect(results.filter((result) => result.status === "rejected").map((result) => (result as PromiseRejectedResult).reason.message))
      .toEqual(new Array(3).fill(ASSISTANT_RUNNER_ERRORS.busy));
  });

  test("a provider that ignores the abort is timed out and frees its slot", async () => {
    const { runner } = await setup(fakeProvider(LOCAL, stuck).provider, { maxConcurrent: 1, runTimeoutMs: 20 });
    const { runId } = await runner.start({ scope: MEETING, question: "x" });
    await expect(runner.start({ scope: MEETING, question: "x" })).rejects.toThrow(ASSISTANT_RUNNER_ERRORS.busy);
    expect(await settle(runner, runId)).toMatchObject({ status: "failed", error: ASSISTANT_RUNNER_ERRORS.timeout });
    await runner.start({ scope: MEETING, question: "x" });
  });

  test("finished runs stay available for ten minutes", async () => {
    let now = new Date("2026-10-25T12:00:00.000Z").getTime();
    const { runner } = await setup(fakeProvider(LOCAL, async () => ({ text: "ok", stopReason: "end" })).provider, { now: () => new Date(now) });
    const { runId } = await runner.start({ scope: MEETING, question: "x" });
    await settle(runner, runId);
    now += 10 * 60_000;
    expect(runner.poll(runId).status).toBe("done");
    now += 1;
    expect(() => runner.poll(runId)).toThrow(ASSISTANT_RUNNER_ERRORS.runMissing);
    expect(() => runner.poll(42 as unknown as string)).toThrow(ASSISTANT_RUNNER_ERRORS.runMissing);
  });

  test("shutdown cancels runs and refuses new work", async () => {
    const { script, called } = manual();
    const { runner } = await setup(fakeProvider(LOCAL, script).provider);
    const { runId } = await runner.start({ scope: MEETING, question: "x" });
    await called();
    await runner.shutdown({ waitMs: 100 });
    await expect(runner.start({ scope: MEETING, question: "x" })).rejects.toThrow(ASSISTANT_RUNNER_ERRORS.closed);
    await expect(runner.plan({ scope: MEETING, question: "x" })).rejects.toThrow(ASSISTANT_RUNNER_ERRORS.closed);
    expect(() => runner.poll(runId)).toThrow(ASSISTANT_RUNNER_ERRORS.runMissing);
  });

  test("shutdown does not wait forever for a provider that ignores the abort", async () => {
    const { runner } = await setup(fakeProvider(LOCAL, stuck).provider);
    await runner.start({ scope: MEETING, question: "x" });
    const before = Date.now();
    await runner.shutdown({ waitMs: 30 });
    expect(Date.now() - before).toBeLessThan(2_000);
  });
});

describe("outcomes and errors", () => {
  const outcome = async (script: Script, options: Partial<AssistantRunnerOptions> = {}) => {
    const { runner, store } = await setup(fakeProvider(LOCAL, script).provider, options);
    const { runId, threadId } = await runner.start({ scope: MEETING, question: "Pergunta" });
    return { snapshot: await settle(runner, runId), store, threadId };
  };

  test("a provider error is shown as it is; anything else is generic", async () => {
    expect((await outcome(async () => { throw new ProviderError("A chave da OpenRouter foi recusada.", "auth"); })).snapshot)
      .toMatchObject({ status: "failed", error: "A chave da OpenRouter foi recusada." });
    expect((await outcome(async () => { throw new Error("ECONNRESET at socket 0x7f stack…"); })).snapshot)
      .toMatchObject({ status: "failed", error: ASSISTANT_RUNNER_ERRORS.failed });
    expect((await outcome(async () => undefined as unknown as ChatResult)).snapshot)
      .toMatchObject({ status: "failed", error: ASSISTANT_RUNNER_ERRORS.failed });
  });

  test("refusals, empty answers and cut-off answers", async () => {
    expect((await outcome(async () => ({ text: "", stopReason: "refusal" }))).snapshot).toMatchObject({ status: "failed", error: ASSISTANT_RUNNER_ERRORS.refusal });
    expect((await outcome(async () => ({ text: "   ", stopReason: "end" }))).snapshot).toMatchObject({ status: "failed", error: ASSISTANT_RUNNER_ERRORS.empty });
    const cut = await outcome(async () => ({ text: "Resposta longa que", stopReason: "length" }));
    expect(cut.snapshot).toMatchObject({ status: "done", cutOff: true, saved: true });
  });

  test("retrieval errors are shown in Portuguese", async () => {
    const { runner } = await setup(fakeProvider(LOCAL, async () => ({ text: "ok", stopReason: "end" })).provider);
    const { runId } = await runner.start({ scope: { kind: "meeting", jobId: "5e3b529e-5c22-4802-97b8-f3e1a52c1919" }, question: "x" });
    expect(await settle(runner, runId)).toMatchObject({ status: "failed", error: RETRIEVAL_ERRORS.meetingMissing });
    const empty = await setup(fakeProvider(LOCAL, async () => ({ text: "ok", stopReason: "end" })).provider, { index: { ...emptyIndex, listFacts: async () => [] } });
    const library = await empty.runner.start({ scope: { kind: "library" }, question: "x" });
    expect(await settle(empty.runner, library.runId)).toMatchObject({ status: "failed", error: RETRIEVAL_ERRORS.noMeetings });
  });

  test("an answer that cannot be saved is still shown", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "falatrace-runner-"));
    roots.push(root);
    await fs.writeFile(join(root, "file"), "x");
    const { snapshot } = await outcome(async () => ({ text: "Sexta [[s000001]].", stopReason: "end" }), { store: new ThreadStore(join(root, "file", "threads")) });
    expect(snapshot).toMatchObject({ status: "done", saved: false, error: ASSISTANT_RUNNER_ERRORS.notSaved, text: "Sexta [[s000001]]." });
  });

  test("control characters in the answer are neutralized before saving", async () => {
    const { snapshot, store, threadId } = await outcome(async () => ({ text: "Linha 1\nLinha\u0007 2\u0000", stopReason: "end" }));
    expect(snapshot).toMatchObject({ status: "done", saved: true, text: "Linha 1\nLinha  2 " });
    expect((await store.read(threadId)).messages[1]!.text).toBe("Linha 1\nLinha  2 ");
  });

  test("questions and recipes are validated before anything runs", async () => {
    const { provider, requests } = fakeProvider(LOCAL, async () => ({ text: "ok", stopReason: "end" }));
    const { runner } = await setup(provider);
    await expect(runner.start({ scope: MEETING, question: "   " })).rejects.toThrow(ASSISTANT_RUNNER_ERRORS.emptyQuestion);
    await expect(runner.start({ scope: MEETING, question: 42 as unknown as string })).rejects.toThrow(ASSISTANT_RUNNER_ERRORS.emptyQuestion);
    await expect(runner.start({ scope: MEETING, question: "x".repeat(4_001) })).rejects.toThrow(ASSISTANT_RUNNER_ERRORS.longQuestion);
    await expect(runner.start({ scope: { kind: "meeting", jobId: "../etc" } as AssistantScope, question: "x" })).rejects.toThrow(RETRIEVAL_ERRORS.scope);
    await expect(runner.start({ scope: MEETING, question: "", recipe: { id: "Bad Id", prompt: "x" } })).rejects.toThrow(ASSISTANT_RUNNER_ERRORS.invalidRecipe);
    await expect(runner.start({ scope: MEETING, question: "", recipe: { id: "risks", prompt: "  " } })).rejects.toThrow(ASSISTANT_RUNNER_ERRORS.invalidRecipe);
    await expect(runner.start({ scope: MEETING, question: "", recipe: { id: "risks", prompt: "x".repeat(MAX_RECIPE_PROMPT_CHARACTERS + 1) } })).rejects.toThrow(ASSISTANT_RUNNER_ERRORS.invalidRecipe);
    await expect(runner.start({ scope: MEETING, question: "x", threadId: "not-a-uuid" })).rejects.toThrow(THREAD_ERRORS.notFound);
    await expect(runner.plan({ scope: MEETING, question: "", recipeId: "Bad" })).rejects.toThrow(ASSISTANT_RUNNER_ERRORS.invalidRecipe);
    expect(requests).toHaveLength(0);
  });

  test("a recipe runs without a question and is recorded in the thread", async () => {
    const { provider, requests } = fakeProvider(LOCAL, async () => ({ text: "Riscos: atraso [[s000001]].", stopReason: "end" }));
    const { runner, store } = await setup(provider);
    const plan = await runner.plan({ scope: MEETING, question: "", recipeId: "risks" });
    expect(plan.contextCharacters).toBeGreaterThan(0);
    const { runId, threadId } = await runner.start({ scope: MEETING, question: "", recipe: { id: "risks", prompt: "Liste os riscos citados." } });
    expect((await settle(runner, runId)).status).toBe("done");
    expect(requests[0]!.messages[0]!.content).toContain('Task (recipe "risks"):\nListe os riscos citados.');
    const thread = await store.read(threadId);
    expect(thread.title).toBe("risks");
    expect(thread.messages.map((message) => [message.text, message.recipeId])).toEqual([["/risks", "risks"], ["Riscos: atraso [[s000001]].", "risks"]]);
  });

  test("every runner error is a known, translatable message", () => {
    for (const message of [...Object.values(ASSISTANT_RUNNER_ERRORS), ...Object.values(RETRIEVAL_ERRORS), ...Object.values(THREAD_ERRORS)]) {
      expect(ASSISTANT_KNOWN_ERRORS).toContain(message);
    }
    expect(new Set(ASSISTANT_KNOWN_ERRORS).size).toBe(ASSISTANT_KNOWN_ERRORS.length);
  });
});

describe("threads", () => {
  test("a follow-up sends the earlier turns without their markers and appends to the thread", async () => {
    let turn = 0;
    const { provider, requests } = fakeProvider(LOCAL, async () => ({ text: ++turn === 1 ? "Sexta [[s000001]]." : "Ana envia o plano [[s000003]].", stopReason: "end" }));
    const { runner, store } = await setup(provider);
    const first = await runner.start({ scope: MEETING, question: "Quando é a entrega?" });
    await settle(runner, first.runId);
    const second = await runner.start({ scope: MEETING, question: "E quem envia o plano?", threadId: first.threadId.toUpperCase() });
    expect(second.threadId).toBe(first.threadId);
    await settle(runner, second.runId);
    expect(requests[1]!.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(requests[1]!.messages[1]!.content).toBe("Sexta.");
    const thread = await store.read(first.threadId);
    expect(thread.messages.map((message) => message.text)).toEqual(["Quando é a entrega?", "Sexta [[s000001]].", "E quem envia o plano?", "Ana envia o plano [[s000003]]."]);
    expect(thread.title).toBe("Quando é a entrega?");
  });

  test("a thread of another scope or an unknown thread is refused", async () => {
    const { runner } = await setup(fakeProvider(LOCAL, async () => ({ text: "ok", stopReason: "end" })).provider);
    const first = await runner.start({ scope: MEETING, question: "x" });
    await settle(runner, first.runId);
    await expect(runner.start({ scope: { kind: "meeting", jobId: B }, question: "y", threadId: first.threadId })).rejects.toThrow(THREAD_ERRORS.otherScope);
    await expect(runner.start({ scope: MEETING, question: "y", threadId: "6e3b529e-5c22-4802-97b8-f3e1a52c1919" })).rejects.toThrow(THREAD_ERRORS.notFound);
  });

  test("a follow-up asked while the first answer is still coming lands in the same new thread", async () => {
    const { script, calls, called } = manual();
    const { runner, store } = await setup(fakeProvider(LOCAL, script).provider);
    const first = await runner.start({ scope: MEETING, question: "Primeira" });
    const second = await runner.start({ scope: MEETING, question: "Segunda", threadId: first.threadId });
    await expect(runner.start({ scope: { kind: "library" }, question: "Outra", threadId: first.threadId })).rejects.toThrow(THREAD_ERRORS.otherScope);
    await called(2);
    calls[1]!.end({ text: "Resposta 2" });
    calls[0]!.end({ text: "Resposta 1" });
    await settle(runner, first.runId);
    await settle(runner, second.runId);
    const thread = await store.read(first.threadId);
    expect(thread.messages.map((message) => message.text)).toEqual(["Segunda", "Resposta 2", "Primeira", "Resposta 1"]);
  });
});

describe("with the real index", () => {
  test("library questions label meetings m1..mN and citations resolve to recordings", async () => {
    fixture = await makeRoot();
    const budget = await writeJob(fixture, { name: "orcamento", createdAt: "2026-10-01T13:00:00.000Z",
      segments: [{ start: 0, end: 8, text: "Aprovamos o orçamento de marketing com corte de dez por cento.", speaker: "S1" }, ...filler("campanha", 6, 9)],
      summary: { title: "Orçamento de marketing", overview: "Orçamento aprovado com corte.", topics: [], decisions: [], actionItems: [] } });
    const migration = await writeJob(fixture, { name: "migracao", createdAt: "2026-10-05T13:00:00.000Z",
      segments: [{ start: 0, end: 8, text: "A migração do banco de dados fica para a próxima sprint.", speaker: "S2" }, ...filler("migração", 4, 9)],
      summary: { title: "Migração do banco", overview: "Migração adiada.", topics: [], decisions: [], actionItems: [] } });
    const config = structuredClone(DEFAULT_CONFIG);
    const index = new LibraryIndex(config);
    await index.refresh();
    const { provider, requests } = fakeProvider(LOCAL, async (request) => {
      const content = request.messages[request.messages.length - 1]!.content;
      const label = (title: string) => new RegExp(`## (m\\d+) — "${title}"`).exec(content)![1];
      return { text: `O orçamento foi aprovado [[${label("Orçamento de marketing")}:s000000]] e a migração adiada [[${label("Migração do banco")}:s000000]] [[m9:s000001]].`, stopReason: "end" };
    });
    const { runner, store } = await setup(provider, { config, index, readers: createAssistantReaders() });
    const plan = await runner.plan({ scope: { kind: "library" }, question: "orçamento e migração" });
    expect(plan.meetings.map((meeting) => meeting.label)).toEqual(["m1", "m2"]);
    expect(new Set(plan.meetings.map((meeting) => meeting.jobId))).toEqual(new Set([budget.id, migration.id]));
    const { runId, threadId } = await runner.start({ scope: { kind: "library" }, question: "orçamento e migração" });
    const snapshot = await settle(runner, runId);
    expect(snapshot.status).toBe("done");
    expect(snapshot.droppedRefs).toEqual(["m9:s000001"]);
    expect(snapshot.citations.map((citation) => [citation.jobId, citation.segmentId, citation.title])).toEqual([
      [budget.id, "s000000", "Orçamento de marketing"], [migration.id, "s000000", "Migração do banco"]
    ]);
    expect(requests[0]!.messages[0]!.content).toMatch(/\[m\d:s000000 00:00 S1\] Aprovamos o orçamento/);
    expect((await store.list({ scope: { kind: "library" } })).map((thread) => thread.id)).toEqual([threadId]);
    // Deleting the meeting later strips its citations from the saved answer.
    expect(await store.removeThreadsForJob(budget.id)).toEqual({ removed: 0, scrubbed: 1 });
    const saved = (await store.read(threadId)).messages[1]!;
    expect(saved.citations.map((citation) => citation.jobId)).toEqual([migration.id]);
    expect(saved.text).not.toContain(`:s000000]] e a`);
  });

  test("a meeting question under a small budget sends a window around the answer", async () => {
    fixture = await makeRoot();
    const lines = Array.from({ length: 400 }, (_value, index) => ({ start: index * 10, end: index * 10 + 9,
      text: index === 250 ? "Decidimos trocar o fornecedor de pagamentos por causa das taxas altas." : `Comentário ${index} sobre o andamento geral do projeto e próximos passos combinados.` }));
    const job = await writeJob(fixture, { name: "longa", segments: lines });
    const config = structuredClone(DEFAULT_CONFIG);
    config.assistant.maxContextCharacters = 8_000;
    const { provider, requests } = fakeProvider(LOCAL, async () => ({ text: "Pelas taxas [[s000250]].", stopReason: "end" }));
    const { runner } = await setup(provider, { config, index: new LibraryIndex(config), readers: createAssistantReaders() });
    const plan = await runner.plan({ scope: { kind: "meeting", jobId: job.id }, question: "por que trocar o fornecedor de pagamentos?" });
    expect(plan.truncated).toBe(true);
    expect(plan.contextCharacters).toBeLessThanOrEqual(8_000);
    const { runId } = await runner.start({ scope: { kind: "meeting", jobId: job.id }, question: "por que trocar o fornecedor de pagamentos?" });
    const snapshot = await settle(runner, runId);
    expect(snapshot.citations.map((citation) => citation.segmentId)).toEqual(["s000250"]);
    expect(requests[0]!.messages[0]!.content).toContain("[s000250 41:40] Decidimos trocar o fornecedor");
  });
});
