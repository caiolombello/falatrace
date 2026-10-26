import type { AppServices } from "../app/context";
import type { AssistantPlan, AssistantRunner, RunSnapshot } from "../assistant/runner";
import type { AssistantScope, ChatCitation } from "../assistant/types";
import type { JobFacts } from "../library-index/types";
import { CLI_MESSAGES, type CliIO, clockText, errorMessage, type Interrupt, localDay, notice, oneLine, type ParsedArgs, printJson, terminalText } from "./shared";

/**
 * Asking the assistant from a terminal (`ask`, `recipes run`): plan, show the destination, refuse
 * an external destination without --yes, then stream the answer and list the citations.
 */

/** The parts of the app services a question uses (src/app/context.ts builds the real ones). */
export type QuestionServices = {
  index: Pick<AppServices["index"], "refresh" | "getFacts">;
  runner: Pick<AssistantRunner, "plan" | "start" | "poll" | "cancel">;
  close(): Promise<void>;
};

export type QuestionDeps = {
  io: CliIO;
  sleep: (ms: number) => Promise<void>;
  interrupt: () => Interrupt;
  /** How often the running answer is read. */
  pollMs?: number;
};

export type CitationLine = ChatCitation & { n: number; date: string };

/** `--meeting`, `--person` or `--client` (at most one); the library when none. */
export const scopeFromArgs = (parsed: ParsedArgs): AssistantScope => {
  const meeting = parsed.values["--meeting"], person = parsed.values["--person"], client = parsed.values["--client"];
  if ([meeting, person, client].filter((value) => value !== undefined).length > 1) throw new Error(CLI_MESSAGES.oneScope);
  if (meeting !== undefined) return { kind: "meeting", jobId: meeting.toLowerCase() };
  if (person !== undefined) return { kind: "person", personId: person };
  if (client !== undefined) return { kind: "client", clientCode: client };
  return { kind: "library" };
};

export const SCOPE_OPTIONS = ["--meeting", "--person", "--client"] as const;

/** One line naming where the question goes, printed before anything is sent. */
export const destinationLine = (plan: AssistantPlan): string => {
  const { destination } = plan;
  const where = destination.external ? "fora deste computador" : "neste computador";
  const subscription = destination.subscription ? ` · ${oneLine(destination.subscription, 200)}` : "";
  const meetings = plan.meetings.length === 1 ? "1 reunião" : `${plan.meetings.length} reuniões`;
  return `Destino: ${oneLine(destination.label, 200)}${subscription} (${where}) · ${meetings}${plan.truncated ? " (trechos)" : ""}`;
};

/** The answer with its checked markers `[[ref]]` shown as `[n]`, n being the citation's place in the list. */
export const renderAnswer = (text: string, citations: readonly ChatCitation[]): string => {
  const numbers = new Map(citations.map((citation, index) => [citation.ref, index + 1]));
  return text.replace(/\[\[([^[\]\n]{1,40})\]\]/g, (match, ref: string) => {
    const number = numbers.get(ref);
    return number === undefined ? match : `[${number}]`;
  });
};

/**
 * The answer as the terminal shows it: checked markers as `[n]`, control characters neutralised
 * (the model's text is untrusted), and trailing spaces held back, since a marker that turns out
 * unknown may still remove them. Streaming and the final text go through the same function, so
 * what was already printed stays a prefix of the final answer.
 */
export const displayAnswer = (text: string, citations: readonly ChatCitation[]): string =>
  terminalText(renderAnswer(text, citations)).replace(/\s+$/, "");

/** `[n] <title> <date> <mm:ss> <job-id>#<segment>` */
export const citationLine = (citation: CitationLine): string =>
  `[${citation.n}] ${oneLine(citation.title, 160) || "-"} ${citation.date || "-"} ${clockText(citation.start)} ${citation.jobId}#${citation.segmentId}`;

const datedCitations = async (citations: readonly ChatCitation[], plan: AssistantPlan, index: QuestionServices["index"]): Promise<CitationLine[]> => {
  const dates = new Map(plan.meetings.map((meeting) => [meeting.jobId, meeting.date]));
  const facts = new Map<string, JobFacts | undefined>();
  const lines: CitationLine[] = [];
  for (const [position, citation] of citations.entries()) {
    let date = dates.get(citation.jobId);
    if (date === undefined) {
      if (!facts.has(citation.jobId)) facts.set(citation.jobId, await index.getFacts(citation.jobId).catch(() => undefined));
      date = facts.get(citation.jobId)?.date;
    }
    lines.push({ ...citation, n: position + 1, date: localDay(date) });
  }
  return lines;
};

/** Brings the index up to date first; a failure (busy, unreadable job) leaves the current index in use. */
export const refreshIndex = async (services: Pick<QuestionServices, "index">, io: CliIO): Promise<void> => {
  try {
    await services.index.refresh();
  } catch {
    notice(io, CLI_MESSAGES.indexRefreshFailed);
  }
};

export type QuestionInput = {
  scope: AssistantScope;
  question: string;
  recipe?: { id: string; prompt: string };
  yes: boolean;
  json: boolean;
};

/**
 * Runs one question to the end. Stdout gets only the answer (or the JSON); the destination line and
 * notices go to stderr. An external destination without `yes` is refused before anything is sent.
 */
export const askQuestion = async (services: QuestionServices, input: QuestionInput, deps: QuestionDeps): Promise<RunSnapshot> => {
  const { io } = deps;
  const plan = await services.runner.plan({ scope: input.scope, question: input.question, ...(input.recipe ? { recipe: input.recipe } : {}) });
  notice(io, destinationLine(plan));
  if (plan.external && !input.yes) throw new Error(CLI_MESSAGES.consentRequired);
  const { runId } = await services.runner.start({
    scope: input.scope, question: input.question, ...(input.recipe ? { recipe: input.recipe } : {}), consentKey: plan.consentKey
  });
  const interrupt = deps.interrupt();
  let printed = "";
  let snapshot: RunSnapshot;
  try {
    for (;;) {
      // Ctrl+C stops the question (the provider is aborted); checked on every read, so it is never missed.
      if (interrupt.signal.aborted) {
        services.runner.cancel(runId);
        const last = services.runner.poll(runId);
        snapshot = last.status === "running" ? { ...last, status: "cancelled" } : last;
        break;
      }
      snapshot = services.runner.poll(runId);
      if (snapshot.status !== "running") break;
      if (!input.json) {
        const visible = displayAnswer(snapshot.text, snapshot.citations);
        if (visible.startsWith(printed) && visible.length > printed.length) {
          io.out(visible.slice(printed.length));
          printed = visible;
        }
      }
      await deps.sleep(deps.pollMs ?? 150);
    }
  } finally {
    interrupt.dispose();
  }
  if (snapshot.status === "cancelled") {
    if (printed) io.out("\n");
    throw new Error(CLI_MESSAGES.cancelled);
  }
  if (snapshot.status === "failed") {
    if (printed) io.out("\n");
    throw new Error(snapshot.error || CLI_MESSAGES.cancelled);
  }
  const citations = await datedCitations(snapshot.citations, plan, services.index);
  if (input.json) {
    printJson(io, { text: snapshot.text, citations, destination: plan.destination, threadId: snapshot.threadId });
  } else {
    const final = displayAnswer(snapshot.text, snapshot.citations);
    io.out(final.startsWith(printed) ? final.slice(printed.length) : `\n${final}`);
    io.out("\n");
    if (citations.length) io.out(`\n${citations.map(citationLine).join("\n")}\n`);
  }
  if (snapshot.cutOff) notice(io, CLI_MESSAGES.answerCutOff);
  if (snapshot.saved === false && snapshot.error) notice(io, snapshot.error);
  return snapshot;
};

/** Closes the services whatever happened; a failure to close never hides the command's own error. */
export const withServices = async <T>(services: QuestionServices, work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } finally {
    await services.close().catch((error: unknown) => errorMessage(error));
  }
};
