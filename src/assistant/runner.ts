import { createHash, randomUUID } from "node:crypto";
import type { AppConfig } from "../config/defaults";
import type { AssistantIndexReader } from "../library-index/index";
import { LIBRARY_INDEX_KNOWN_ERRORS } from "../library-index/index";
import type { LibraryIndexReader } from "../library-index/types";
import { type ContextRef, extractCitations, stripPartialMarker } from "./citations";
import { buildChatMessages, buildChatSystemPrompt, MAX_QUESTION_CHARACTERS, MAX_RECIPE_PROMPT_CHARACTERS, threadTitle } from "./prompts";
import { type AssistantReaders, buildContextPack, RETRIEVAL_ERRORS, scopeKey, validateAssistantScope } from "./retrieval";
import { type AssistantThread, THREAD_ERRORS, THREAD_LIMITS, type ThreadMessage, type ThreadStore } from "./threads";
import { type AssistantScope, type ChatCitation, type ChatProvider, destinationKey, ProviderError, type ProviderDestination } from "./types";

/**
 * Runs assistant questions in the background: consent check, retrieval, streaming from the
 * provider, citation check, then the exchange is saved in its thread. The UI polls by run id.
 */

export const ASSISTANT_RUNNER_ERRORS = {
  emptyQuestion: "Escreva uma pergunta.",
  longQuestion: `A pergunta deve ter até ${MAX_QUESTION_CHARACTERS} caracteres.`,
  invalidRecipe: "A receita é inválida.",
  consent: "Confirme o envio para este destino antes de perguntar.",
  busy: "Há perguntas demais em andamento; aguarde uma terminar.",
  runMissing: "Esta pergunta não está mais disponível.",
  closed: "O assistente foi encerrado.",
  failed: "Não foi possível obter a resposta do assistente.",
  refusal: "O modelo se recusou a responder a esta pergunta.",
  empty: "O assistente não devolveu nenhuma resposta.",
  timeout: "A resposta demorou demais e foi interrompida.",
  notSaved: "A resposta não pôde ser salva na conversa."
} as const;

/** Fixed Portuguese messages the assistant core can show (runner, retrieval, threads, index). */
export const ASSISTANT_KNOWN_ERRORS: readonly string[] = [...new Set<string>([
  ...Object.values(ASSISTANT_RUNNER_ERRORS),
  ...Object.values(RETRIEVAL_ERRORS),
  ...Object.values(THREAD_ERRORS),
  ...LIBRARY_INDEX_KNOWN_ERRORS
])];

/** At most this many questions run at once (each holds a provider connection or process). */
export const MAX_CONCURRENT_RUNS = 4;
const MAX_ANSWER_CHARACTERS = 100_000;
const MAX_OUTPUT_TOKENS = 4_096;
const RECIPE_ID = /^(?:custom:)?[a-z0-9][a-z0-9-]{0,80}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type RunStatus = "running" | "done" | "failed" | "cancelled";

export type RunSnapshot = {
  status: RunStatus;
  threadId: string;
  /** Answer so far (while running) or final; markers checked against what was sent. */
  text: string;
  citations: ChatCitation[];
  droppedRefs: string[];
  error?: string;
  /** False when the answer arrived but could not be written to the thread. */
  saved?: boolean;
  /** The provider stopped at its output limit. */
  cutOff?: boolean;
};

export type AssistantPlan = {
  destination: ProviderDestination;
  external: boolean;
  /** Pass back to start() after the person agrees; absent consent is refused for external destinations. */
  consentKey: string;
  contextCharacters: number;
  meetings: Array<{ jobId: string; title: string; date: string; label?: string }>;
  truncated: boolean;
};

export type AssistantRunnerOptions = {
  config: AppConfig;
  index: LibraryIndexReader & Partial<AssistantIndexReader>;
  providerFactory: (config: AppConfig) => ChatProvider;
  readers: AssistantReaders;
  store: ThreadStore;
  now?: () => Date;
  /** Lower than MAX_CONCURRENT_RUNS only (tests, constrained machines). */
  maxConcurrent?: number;
  runTimeoutMs?: number;
  /** How long a finished run stays available to poll. */
  retentionMs?: number;
};

type Recipe = { id: string; prompt: string };

type Run = {
  id: string;
  threadId: string;
  scope: AssistantScope;
  status: RunStatus;
  text: string;
  refs: Map<string, ContextRef>;
  answer?: { text: string; citations: ChatCitation[]; droppedRefs: string[] };
  error?: string;
  saved?: boolean;
  cutOff?: boolean;
  controller: AbortController;
  finishedAt?: number;
  done: Promise<void>;
};

/** Consent binds the destination (provider, endpoint, model) to the scope of the question. */
export const assistantConsentKey = (destination: ProviderDestination, scope: AssistantScope): string =>
  createHash("sha256").update(destinationKey(destination) + scopeKey(scope)).digest("hex");

const KNOWN = new Set<string>(ASSISTANT_KNOWN_ERRORS);

const localDay = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

/** Control characters other than tab and line breaks become spaces (threads refuse them). */
const plainText = (value: string): string => value.replace(/[^\P{Cc}\t\n\r]/gu, " ");

const checkQuestion = (value: unknown, recipe: boolean): string => {
  if (value !== undefined && typeof value !== "string") throw new Error(ASSISTANT_RUNNER_ERRORS.emptyQuestion);
  const question = plainText(value ?? "").trim();
  if (question.length > MAX_QUESTION_CHARACTERS) throw new Error(ASSISTANT_RUNNER_ERRORS.longQuestion);
  if (!question && !recipe) throw new Error(ASSISTANT_RUNNER_ERRORS.emptyQuestion);
  return question;
};

const checkRecipe = (value: unknown): Recipe | undefined => {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(ASSISTANT_RUNNER_ERRORS.invalidRecipe);
  const { id, prompt } = value as { id?: unknown; prompt?: unknown };
  if (typeof id !== "string" || !RECIPE_ID.test(id) || typeof prompt !== "string" || !prompt.trim() || prompt.length > MAX_RECIPE_PROMPT_CHARACTERS) {
    throw new Error(ASSISTANT_RUNNER_ERRORS.invalidRecipe);
  }
  return { id, prompt };
};

/** What retrieval ranks by: the recipe's task plus the person's words. */
const retrievalQuery = (question: string, recipe?: Recipe): string => recipe ? `${recipe.prompt}\n${question}` : question;

/** A message safe to show: provider and known messages as they are, anything else generic. */
const visibleError = (error: unknown): string =>
  error instanceof ProviderError ? error.message.slice(0, 500)
    : error instanceof Error && KNOWN.has(error.message) ? error.message : ASSISTANT_RUNNER_ERRORS.failed;

export class AssistantRunner {
  private readonly runs = new Map<string, Run>();
  private readonly now: () => Date;
  private closed = false;

  constructor(private readonly options: AssistantRunnerOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /** What would be sent and where, without sending anything. */
  async plan(input: { scope: AssistantScope; question: string; recipeId?: string; recipe?: Recipe; signal?: AbortSignal }): Promise<AssistantPlan> {
    if (this.closed) throw new Error(ASSISTANT_RUNNER_ERRORS.closed);
    const scope = validateAssistantScope(input.scope);
    const recipe = checkRecipe(input.recipe);
    if (input.recipeId !== undefined && (typeof input.recipeId !== "string" || !RECIPE_ID.test(input.recipeId))) throw new Error(ASSISTANT_RUNNER_ERRORS.invalidRecipe);
    const question = checkQuestion(input.question, Boolean(recipe || input.recipeId));
    const destination = this.options.providerFactory(this.options.config).destination;
    const pack = await buildContextPack({ scope, question, query: retrievalQuery(question, recipe), index: this.options.index,
      config: this.options.config, readers: this.options.readers, signal: input.signal, now: this.now() });
    return { destination, external: destination.external, consentKey: assistantConsentKey(destination, scope), contextCharacters: pack.text.length,
      meetings: pack.meetings, truncated: pack.truncated };
  }

  /** Starts a question; returns at once. Poll the run for the streamed answer. */
  async start(input: { scope: AssistantScope; question: string; threadId?: string; recipe?: Recipe; consentKey?: string }): Promise<{ runId: string; threadId: string }> {
    if (this.closed) throw new Error(ASSISTANT_RUNNER_ERRORS.closed);
    this.purge();
    const scope = validateAssistantScope(input.scope);
    const recipe = checkRecipe(input.recipe);
    const question = checkQuestion(input.question, Boolean(recipe));
    if (input.threadId !== undefined && (typeof input.threadId !== "string" || !UUID.test(input.threadId))) throw new Error(THREAD_ERRORS.notFound);
    if (this.running().length >= Math.min(MAX_CONCURRENT_RUNS, this.options.maxConcurrent ?? MAX_CONCURRENT_RUNS)) throw new Error(ASSISTANT_RUNNER_ERRORS.busy);
    const config = structuredClone(this.options.config);
    const provider = this.options.providerFactory(config);
    const destination = provider.destination;
    // A loopback Ollama keeps everything on this computer; anything else needs the consent shown by plan().
    if (destination.external && input.consentKey !== assistantConsentKey(destination, scope)) throw new Error(ASSISTANT_RUNNER_ERRORS.consent);
    const runId = randomUUID();
    const threadId = (input.threadId ?? randomUUID()).toLowerCase();
    let release!: () => void;
    const run: Run = { id: runId, threadId, scope, status: "running", text: "", refs: new Map(), controller: new AbortController(),
      done: new Promise<void>((resolve) => { release = resolve; }) };
    // Reserved before any await, so the concurrency limit holds for simultaneous starts.
    this.runs.set(runId, run);
    let thread: AssistantThread | undefined;
    try {
      if (input.threadId !== undefined) thread = await this.followedThread(run);
      if (this.closed) throw new Error(ASSISTANT_RUNNER_ERRORS.closed);
    } catch (error) {
      this.runs.delete(runId);
      release();
      throw error;
    }
    void this.execute(run, { question, recipe, thread, provider, config }).finally(release);
    return { runId, threadId };
  }

  poll(runId: string): RunSnapshot {
    this.purge();
    const run = typeof runId === "string" ? this.runs.get(runId) : undefined;
    if (!run) throw new Error(ASSISTANT_RUNNER_ERRORS.runMissing);
    const base = { status: run.status, threadId: run.threadId };
    if (run.status === "done" && run.answer) {
      return { ...base, ...run.answer, saved: run.saved ?? false, ...(run.cutOff ? { cutOff: true } : {}), ...(run.error ? { error: run.error } : {}) };
    }
    const partial = extractCitations(stripPartialMarker(run.text), run.refs);
    return { ...base, text: partial.text, citations: partial.citations, droppedRefs: partial.droppedRefs, ...(run.error ? { error: run.error } : {}) };
  }

  /** Stops a running question. Returns false when it was not running. */
  cancel(runId: string): boolean {
    const run = typeof runId === "string" ? this.runs.get(runId) : undefined;
    if (run?.status !== "running") return false;
    this.finish(run, "cancelled");
    run.controller.abort();
    return true;
  }

  /** Cancels everything and waits (briefly) for the runs to settle. */
  async shutdown(options: { waitMs?: number } = {}): Promise<void> {
    this.closed = true;
    const pending = [...this.runs.values()];
    for (const run of pending) this.cancel(run.id);
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A provider that ignores the abort must not hold the process open.
    await Promise.race([Promise.all(pending.map((run) => run.done)), new Promise<void>((resolve) => { timer = setTimeout(resolve, options.waitMs ?? 5_000); })]);
    clearTimeout(timer);
    this.runs.clear();
  }

  private running(): Run[] {
    return [...this.runs.values()].filter((run) => run.status === "running");
  }

  /**
   * The thread a follow-up question continues. A new conversation is saved when its first answer
   * arrives, so while that answer is still running its id is accepted without a file.
   */
  private async followedThread(run: Run): Promise<AssistantThread | undefined> {
    const pending = [...this.runs.values()].find((other) => other !== run && other.status === "running" && other.threadId === run.threadId);
    let thread: AssistantThread | undefined;
    try { thread = await this.options.store.read(run.threadId); }
    catch (error) { if (!pending || !(error instanceof Error) || error.message !== THREAD_ERRORS.notFound) throw error; }
    const owner = thread?.scope ?? pending!.scope;
    if (scopeKey(owner) !== scopeKey(run.scope)) throw new Error(THREAD_ERRORS.otherScope);
    if (thread && thread.messages.length + 2 > THREAD_LIMITS.messages) throw new Error(THREAD_ERRORS.full);
    return thread;
  }

  private purge(): void {
    const keep = this.options.retentionMs ?? 10 * 60_000;
    const now = this.now().getTime();
    for (const [id, run] of this.runs) if (run.finishedAt !== undefined && now - run.finishedAt > keep) this.runs.delete(id);
  }

  /** First outcome wins: a late provider answer never revives a cancelled or timed-out run. */
  private finish(run: Run, status: Exclude<RunStatus, "running">, error?: string): void {
    if (run.status !== "running") return;
    run.status = status;
    if (error) run.error = error;
    run.finishedAt = this.now().getTime();
  }

  private async execute(run: Run, input: { question: string; recipe?: Recipe; thread?: AssistantThread; provider: ChatProvider; config: AppConfig }): Promise<void> {
    const { question, recipe, thread, provider, config } = input;
    const { scope } = run;
    // A provider that ignores the abort still frees its slot when the time is up.
    const timer = setTimeout(() => { this.finish(run, "failed", ASSISTANT_RUNNER_ERRORS.timeout); run.controller.abort(); }, this.options.runTimeoutMs ?? 15 * 60_000);
    const signal = run.controller.signal;
    try {
      const now = this.now();
      const pack = await buildContextPack({ scope, question, query: retrievalQuery(question, recipe), index: this.options.index, config,
        readers: this.options.readers, signal, now });
      run.refs = pack.refs;
      signal.throwIfAborted();
      const result = await provider.run({
        system: buildChatSystemPrompt({ scope, today: localDay(now) }),
        messages: buildChatMessages({ pack, question, recipe, history: thread?.messages }),
        signal,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        onDelta: (delta) => {
          if (run.status !== "running" || typeof delta !== "string" || run.text.length >= MAX_ANSWER_CHARACTERS) return;
          run.text = (run.text + delta).slice(0, MAX_ANSWER_CHARACTERS);
        }
      });
      if (run.status !== "running") return;
      if (result.stopReason === "cancelled") { this.finish(run, "cancelled"); return; }
      const finalText = plainText(typeof result.text === "string" && result.text.trim() ? result.text : run.text).slice(0, MAX_ANSWER_CHARACTERS);
      if (!finalText.trim()) { this.finish(run, "failed", result.stopReason === "refusal" ? ASSISTANT_RUNNER_ERRORS.refusal : ASSISTANT_RUNNER_ERRORS.empty); return; }
      const answer = extractCitations(finalText, pack.refs);
      run.text = finalText;
      run.answer = answer;
      run.cutOff = result.stopReason === "length";
      run.saved = await this.save(run, { question, recipe, provider, answer });
      this.finish(run, "done");
    } catch (error) {
      this.finish(run, "failed", visibleError(error));
    } finally {
      clearTimeout(timer);
    }
  }

  private async save(run: Run, input: { question: string; recipe?: Recipe; provider: ChatProvider; answer: { text: string; citations: ChatCitation[] } }): Promise<boolean> {
    const { destination } = input.provider;
    const at = this.now();
    const meta = { destination: { label: destination.label.slice(0, 200), model: destination.model.slice(0, 200) }, ...(input.recipe ? { recipeId: input.recipe.id } : {}) };
    const messages: ThreadMessage[] = [
      { role: "user", text: input.question || `/${input.recipe!.id}`, citations: [], createdAt: at.toISOString(), ...meta },
      { role: "assistant", text: input.answer.text, citations: input.answer.citations, createdAt: at.toISOString(), ...meta }
    ];
    try {
      await this.options.store.appendOrCreate({ id: run.threadId, scope: run.scope, title: threadTitle(input.question, input.recipe),
        destinationKey: destinationKey(destination), messages, now: at });
      return true;
    } catch {
      run.error = ASSISTANT_RUNNER_ERRORS.notSaved;
      return false;
    }
  }
}
