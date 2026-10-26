import { afterEach, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../config/defaults";
import type { AssistantPlan, RunSnapshot } from "../../assistant/runner";
import type { AssistantScope, ChatCitation, ProviderDestination } from "../../assistant/types";
import type { JobFacts } from "../../library-index/types";
import { RECIPE_MESSAGES, RecipeStore } from "../../recipes";
import { citationLine, renderAnswer } from "../answer";
import { runAskCli } from "../ask";
import { runRecipesCli } from "../recipes";
import { CLI_MESSAGES, CLI_USAGE } from "../shared";
import { captureIO, manualInterrupt, tempRoot } from "./cli-helpers";

const JOB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LOCAL: ProviderDestination = { kind: "local", id: "ollama", label: "Ollama · qwen3.5:9b", endpoint: "http://127.0.0.1:11434", model: "qwen3.5:9b", external: false };
const EXTERNAL: ProviderDestination = { kind: "api", id: "openrouter", label: "OpenRouter · synthetic-model", endpoint: "https://openrouter.ai/api/v1", model: "synthetic-model", external: true };
const citation = (segment: string, start: number): ChatCitation => ({ ref: segment, jobId: JOB, segmentId: segment, start, end: start + 4, title: "Revisão semanal" });
const C1 = citation("s000003", 65), C2 = citation("s000007", 3_725);
const running = (text: string, citations: ChatCitation[] = []): RunSnapshot => ({ status: "running", threadId: "t1", text, citations, droppedRefs: [] });

type Call = [string, unknown?];

const fakeServices = (options: { destination?: ProviderDestination; snapshots?: RunSnapshot[]; refreshFails?: boolean; facts?: Partial<JobFacts> } = {}) => {
  const calls: Call[] = [];
  const snapshots = [...(options.snapshots ?? [{ status: "done", threadId: "t1", text: "Resposta [[s000003]].", citations: [C1], droppedRefs: [], saved: true } as RunSnapshot])];
  let cancelled = false;
  const destination = options.destination ?? LOCAL;
  const plan: AssistantPlan = {
    destination, external: destination.external, consentKey: "c".repeat(64), contextCharacters: 120, truncated: false,
    meetings: [{ jobId: JOB, title: "Revisão semanal", date: "2026-10-25T12:00:00.000Z" }]
  };
  return {
    calls,
    services: {
      index: {
        refresh: async () => { calls.push(["refresh"]); if (options.refreshFails) throw new Error("busy"); return {}; },
        getFacts: async () => (options.facts ? { jobId: JOB, ...options.facts } as JobFacts : undefined)
      } as never,
      runner: {
        plan: async (input: unknown) => { calls.push(["plan", input]); return plan; },
        start: async (input: unknown) => { calls.push(["start", input]); return { runId: "r1", threadId: "t1" }; },
        poll: (): RunSnapshot => {
          if (cancelled) return { status: "cancelled", threadId: "t1", text: "", citations: [], droppedRefs: [] };
          return snapshots.length > 1 ? snapshots.shift()! : snapshots[0]!;
        },
        cancel: (runId: string) => { calls.push(["cancel", runId]); cancelled = true; return true; }
      } as never,
      close: async () => { calls.push(["close"]); }
    }
  };
};

const askDeps = (fake: ReturnType<typeof fakeServices>, interrupt = manualInterrupt()) => {
  const capture = captureIO();
  return {
    capture, interrupt,
    deps: { io: capture.io, loadConfig: async () => structuredClone(DEFAULT_CONFIG), services: () => fake.services, sleep: async () => undefined, interrupt: interrupt.interrupt }
  };
};

test("ask streams the answer, then lists each citation as [n] title date mm:ss job#segment", async () => {
  const fake = fakeServices({
    snapshots: [
      running("A decisão foi lançar"),
      running("A decisão foi lançar [[s000003]] em", [C1]),
      { status: "done", threadId: "t1", text: "A decisão foi lançar [[s000003]] em março [[s000007]].", citations: [C1, C2], droppedRefs: [], saved: true }
    ]
  });
  const { deps, capture, interrupt } = askDeps(fake);
  await runAskCli(["ask", "o", "que", "decidimos?"], deps);
  expect(capture.out()).toBe(
    "A decisão foi lançar [1] em março [2].\n\n" +
    `[1] Revisão semanal 2026-10-25 01:05 ${JOB}#s000003\n[2] Revisão semanal 2026-10-25 1:02:05 ${JOB}#s000007\n`
  );
  expect(capture.err()).toBe("Destino: Ollama · qwen3.5:9b (neste computador) · 1 reunião\n");
  const start = fake.calls.find(([name]) => name === "start")![1] as { scope: AssistantScope; question: string; consentKey: string };
  expect(start).toEqual({ scope: { kind: "library" }, question: "o que decidimos?", consentKey: "c".repeat(64) });
  expect(fake.calls.map(([name]) => name)).toEqual(["refresh", "plan", "start", "close"]);
  expect(interrupt.disposed()).toBe(1);
});

test("ask refuses an external destination without --yes, after showing it, and sends with --yes", async () => {
  const refused = fakeServices({ destination: { ...EXTERNAL, subscription: "plano synthetic" } });
  const first = askDeps(refused);
  await expect(runAskCli(["ask", "--meeting", JOB.toUpperCase(), "resuma"], first.deps)).rejects.toThrow(CLI_MESSAGES.consentRequired);
  expect(first.capture.err()).toBe("Destino: OpenRouter · synthetic-model · plano synthetic (fora deste computador) · 1 reunião\n");
  expect(first.capture.out()).toBe("");
  expect(refused.calls.map(([name]) => name)).toEqual(["refresh", "plan", "close"]);
  expect((refused.calls[1]![1] as { scope: AssistantScope }).scope).toEqual({ kind: "meeting", jobId: JOB });
  const accepted = fakeServices({ destination: EXTERNAL });
  const second = askDeps(accepted);
  await runAskCli(["ask", "--meeting", JOB, "--yes", "resuma"], second.deps);
  expect(accepted.calls.map(([name]) => name)).toContain("start");
  expect(second.capture.out()).toContain("Resposta [1].");
});

test("ask --json prints {text, citations, destination} and nothing else on stdout", async () => {
  const fake = fakeServices({ destination: EXTERNAL });
  const { deps, capture } = askDeps(fake);
  await runAskCli(["ask", "--client", "ACME", "--yes", "--json", "riscos?"], deps);
  const value = JSON.parse(capture.out());
  expect(value.text).toBe("Resposta [[s000003]].");
  expect(value.citations).toEqual([{ ...C1, n: 1, date: "2026-10-25" }]);
  expect(value.destination).toEqual(EXTERNAL);
  expect((fake.calls[1]![1] as { scope: AssistantScope }).scope).toEqual({ kind: "client", clientCode: "ACME" });
});

test("ask reports a failed answer, stops on interrupt, and checks its arguments", async () => {
  const failed = fakeServices({ snapshots: [{ status: "failed", threadId: "t1", text: "", citations: [], droppedRefs: [], error: "O modelo se recusou a responder a esta pergunta." }] });
  await expect(runAskCli(["ask", "pergunta"], askDeps(failed).deps)).rejects.toThrow("O modelo se recusou a responder a esta pergunta.");
  expect(failed.calls[failed.calls.length - 1]?.[0]).toBe("close");
  const slow = fakeServices({ snapshots: [running("parcial"), running("parcial")] });
  const interrupt = manualInterrupt();
  interrupt.fire();
  const { deps, capture } = askDeps(slow, interrupt);
  await expect(runAskCli(["ask", "pergunta"], deps)).rejects.toThrow(CLI_MESSAGES.cancelled);
  expect(slow.calls.map(([name]) => name)).toContain("cancel");
  expect(capture.out()).not.toContain("[1]");
  const unused = fakeServices();
  await expect(runAskCli(["ask"], askDeps(unused).deps)).rejects.toThrow(CLI_USAGE.ask);
  await expect(runAskCli(["ask", "--yes"], askDeps(unused).deps)).rejects.toThrow(CLI_MESSAGES.questionRequired);
  await expect(runAskCli(["ask", "--meeting", JOB, "--person", "name:ana", "x"], askDeps(unused).deps)).rejects.toThrow(CLI_MESSAGES.oneScope);
  expect(unused.calls).toEqual([]);
  // An index that cannot be refreshed leaves the current one in use.
  const stale = fakeServices({ refreshFails: true });
  const staleRun = askDeps(stale);
  await runAskCli(["ask", "pergunta"], staleRun.deps);
  expect(staleRun.capture.err()).toContain(CLI_MESSAGES.indexRefreshFailed);
});

test("answers render only checked markers, and a citation without a time shows --:--", () => {
  expect(renderAnswer("a [[s000003]][[m2:s000001]] b [[x]]", [C1])).toBe("a [1][[m2:s000001]] b [[x]]");
  expect(citationLine({ ...C1, start: undefined, n: 3, date: "" })).toBe(`[3] Revisão semanal - --:-- ${JOB}#s000003`);
});

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

const recipesDeps = async (fake: ReturnType<typeof fakeServices>, context = {}) => {
  const root = await tempRoot("falatrace-recipes-cli-");
  roots.push(root);
  const capture = captureIO();
  const contexts: AssistantScope[] = [];
  return {
    capture, contexts,
    deps: {
      io: capture.io, loadConfig: async () => structuredClone(DEFAULT_CONFIG), recipes: () => new RecipeStore({ dir: join(root, "recipes") }),
      services: () => fake.services,
      context: async (_config: unknown, scope: AssistantScope) => { contexts.push(scope); return context; },
      now: () => new Date("2026-10-25T15:00:00.000Z"), sleep: async () => undefined, interrupt: manualInterrupt().interrupt
    }
  };
};

test("recipes list and show read built-in and custom recipes", async () => {
  const { deps, capture } = await recipesDeps(fakeServices());
  await runRecipesCli(["recipes", "list"], deps);
  const listed = JSON.parse(capture.out());
  expect(listed.recipes.map((item: { id: string }) => item.id)).toEqual(expect.arrayContaining(["follow-up-email", "what-did-i-promise"]));
  const shown = await recipesDeps(fakeServices());
  await runRecipesCli(["recipes", "show", "risks"], shown.deps);
  expect(JSON.parse(shown.capture.out())).toMatchObject({ id: "risks", scope: "meeting", builtIn: true });
  await expect(runRecipesCli(["recipes", "show", "nope"], shown.deps)).rejects.toThrow(RECIPE_MESSAGES.notFound);
});

test("recipes run fills the recipe from the meeting and runs it like a question, with the same consent", async () => {
  const facts = {
    title: "Revisão semanal", date: "2026-10-25T12:00:00.000Z", language: "pt",
    speakers: [{ speakerId: "S01", label: "Ana Souza", confirmed: true }], attendees: [{ name: "Eu Mesmo", self: true }],
    clients: [{ code: "ACME", name: "Acme", source: "manual", confidence: 1 }]
  } as unknown as JobFacts;
  const fake = fakeServices({ destination: EXTERNAL });
  const { deps, capture, contexts } = await recipesDeps(fake, { facts });
  await expect(runRecipesCli(["recipes", "run", "follow-up-email"], deps)).rejects.toThrow(CLI_MESSAGES.recipeNeedsMeeting);
  await expect(runRecipesCli(["recipes", "run", "follow-up-email", "--meeting", JOB], deps)).rejects.toThrow(CLI_MESSAGES.consentRequired);
  await runRecipesCli(["recipes", "run", "follow-up-email", "--meeting", JOB, "--yes", "em", "inglês"], deps);
  expect(contexts).toEqual([{ kind: "meeting", jobId: JOB }, { kind: "meeting", jobId: JOB }]);
  const start = fake.calls.find(([name]) => name === "start")![1] as { question: string; recipe: { id: string; prompt: string } };
  expect(start.recipe.id).toBe("follow-up-email");
  expect(start.question).toBe("em inglês");
  expect(start.recipe.prompt).toContain("Revisão semanal");
  expect(start.recipe.prompt).not.toContain("{{meeting.title}}");
  expect(capture.out()).toContain("Resposta [1].");
  // Library recipes run over the library, or the meetings of a person.
  const person = fakeServices();
  const personRun = await recipesDeps(person, { person: { name: "Ana Souza" } });
  await runRecipesCli(["recipes", "run", "what-did-i-promise", "--person", "name:ana souza"], personRun.deps);
  const personStart = person.calls.find(([name]) => name === "start")![1] as { scope: AssistantScope; recipe: { prompt: string } };
  expect(personStart.scope).toEqual({ kind: "person", personId: "name:ana souza" });
  await expect(runRecipesCli(["recipes", "run", "nope", "--yes"], personRun.deps)).rejects.toThrow(RECIPE_MESSAGES.notFound);
  await expect(runRecipesCli(["recipes", "run", "what-did-i-promise", "--meeting", JOB], personRun.deps)).rejects.toThrow(RECIPE_MESSAGES.scopeMismatch);
});
