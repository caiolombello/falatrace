import type { AppConfig } from "../config/defaults";
import type { JobRecord } from "../jobs/types";

/**
 * Small helpers shared by the command families in src/cli: output, strict argument parsing,
 * stdin, interrupts and the fixed Portuguese messages of the CLI itself. Machine output is JSON
 * on stdout; errors are thrown and printed on stderr by src/cli/index.ts (exit code 1).
 */

export type CliIO = {
  /** Standard output (answers, JSON). */
  out(text: string): void;
  /** Standard error (notices such as the destination of a question, and errors). */
  err(text: string): void;
};

export const processIO: CliIO = {
  out: (text) => { process.stdout.write(text); },
  err: (text) => { process.stderr.write(text); }
};

export const printLine = (io: CliIO, text = ""): void => io.out(`${text}\n`);
export const printJson = (io: CliIO, value: unknown): void => io.out(`${JSON.stringify(value, null, 2)}\n`);
export const notice = (io: CliIO, text: string): void => io.err(`${text}\n`);

/** Fixed messages of the CLI commands (not of the modules they call). */
export const CLI_MESSAGES = {
  jobIdRequired: "Informe o id da gravação (UUID do job).",
  jobNotFound: "Gravação não encontrada.",
  inputTooLarge: "A entrada passou do limite de tamanho.",
  consentRequired: "Este destino envia o conteúdo para fora deste computador; confira o destino acima e repita com --yes.",
  confirmRequired: "Confirme com --yes.",
  oneScope: "Use só uma opção entre --meeting, --person e --client.",
  questionRequired: "Escreva a pergunta depois das opções.",
  cancelled: "Cancelado.",
  limitInvalid: "--limit precisa ser um número inteiro entre 1 e 100.",
  revInvalid: "--rev precisa ser um número inteiro maior ou igual a zero.",
  templateNotFound: "Modelo de resumo não encontrado.",
  templateNameInvalid: "Dê um nome ao novo modelo com letras ou números.",
  recipeNeedsMeeting: "Esta receita é de uma reunião: informe --meeting <id>.",
  shareDestinationRequired: "Informe o destino com --to clipboard, obsidian, notion, slack ou ai-app.",
  shareIncludeInvalid: "--include precisa ser summary, summary+notes ou full.",
  shareUnreadable: "Esta gravação ainda não tem uma transcrição utilizável para compartilhar.",
  actionRefInvalid: "Informe a ação como <mídia>:<id da ação>, como aparece em actions list.",
  actionStatusInvalid: "--status precisa ser open, done ou all.",
  clientCodesRequired: "Informe ao menos um código de cliente (ou --auto para voltar à escolha automática).",
  sessionRequired: "Informe a sessão com --session <uuid>.",
  liveSessionRequired: "Informe o id da sessão de captura.",
  uriRequired: "Informe um link falatrace://.",
  mediaModeConflict: "Use --dry-run ou --apply, não os dois.",
  mediaNoOption: "Não há como remover a mídia desta gravação agora.",
  unitsUnavailable: "Não foi possível consultar o serviço de lembretes no systemd do usuário.",
  queryRequired: "Escreva o que procurar.",
  assistantModelsUnavailable: "Não foi possível listar os modelos deste provedor agora.",
  chatgptOpenLogin: "Abra este endereço no navegador para entrar com o ChatGPT (a resposta volta para este computador):",
  indexRefreshFailed: "O índice da biblioteca não foi atualizado; o comando usa o índice atual.",
  answerCutOff: "A resposta parou no limite de tamanho do modelo.",
  liveStopped: "A transcrição ao vivo terminou.",
  liveStale: "A transcrição ao vivo parou de responder.",
  liveFailed: "A transcrição ao vivo falhou.",
  mediaPassFailed: "A retenção de mídia não conseguiu concluir algumas gravações; veja os itens acima.",
  mediaUnknownSize: "desconhecido",
  notesStdinHint: "Digite ou cole as notas e pressione Ctrl+D para salvar.",
  notesEmptyInput: "A entrada está vazia e apagaria as notas desta reunião; para apagá-las, repita com --clear."
} as const;

/** Usage lines of each family; fixed text shown when a subcommand is missing or unknown. */
export const CLI_USAGE = {
  notes: "Use: notes show|edit|path <id>",
  templates: "Use: templates list | templates show <id> | templates init <id-base> <nome> | templates delete <id>",
  ask: "Use: ask [--meeting <job-id>|--person <id>|--client <código>] [--yes] [--json] <pergunta>",
  recipes: "Use: recipes list | recipes show <id> | recipes run <id> [--meeting <job-id>] [--yes] [--json]",
  share: "Use: share <job-id> --to clipboard|obsidian|notion|slack|ai-app [--include summary|summary+notes|full] [--yes] [--dry-run]",
  people: "Use: people list | show <id> | rename <id> <nome> | merge <de> <para> | alias <id> add|remove <apelido> | hide|unhide <id>",
  clients: "Use: clients list | show <código> | add <nome> [--code C] [--alias A] | rename <código> <nome> | delete <código> | assign <job-id> <código…>",
  actions: "Use: actions list [--status open|done|all] [--person ID] [--client CÓDIGO] [--meeting JOB] [--json] | actions done|reopen|dismiss <mídia>:<id>",
  reminders: "Use: reminders run|status|test|install-service|uninstall-service",
  live: "Use: live run --session <uuid> | live show <sessão> [--follow] [--json]",
  media: "Use: media retention [--dry-run|--apply] | media remove <job-id> [--keep-audio] --yes | media status <job-id>",
  studio: "Use: studio open <link falatrace://>",
  notify: "Use: notify ready --job <uuid> | notify reminder --event <hash>",
  assistant: "Use: assistant status|detect|login-chatgpt|logout-chatgpt|models",
  library: "Use: library refresh | library search <consulta> [--limit N]"
} as const;

export const CLI_KNOWN_ERRORS: readonly string[] = Object.freeze([...Object.values(CLI_MESSAGES), ...Object.values(CLI_USAGE)]);

/** Prefix of the dynamic "unknown option" message (the option follows). */
export const UNKNOWN_OPTION = "Opção desconhecida:";
/** Prefix of the dynamic "option without a value" message (the option follows). */
export const MISSING_VALUE = "Falta o valor de";

export type ArgsSpec = {
  /** Options that take one value (`--to x`). */
  values?: readonly string[];
  /** Options that may repeat, each with one value (`--alias a --alias b`). */
  lists?: readonly string[];
  /** Options without a value (`--yes`). */
  flags?: readonly string[];
};

export type ParsedArgs = {
  positionals: string[];
  values: Record<string, string>;
  lists: Record<string, string[]>;
  flags: Set<string>;
};

/**
 * Strict parser for the arguments after the subcommand. Unknown options are refused, so a typo
 * never runs a command with a different meaning. Everything after `--` is positional.
 */
export const parseArgs = (args: readonly string[], spec: ArgsSpec = {}): ParsedArgs => {
  const result: ParsedArgs = { positionals: [], values: {}, lists: {}, flags: new Set() };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") {
      result.positionals.push(...args.slice(index + 1));
      break;
    }
    if (!arg.startsWith("--") || arg === "-") {
      result.positionals.push(arg);
      continue;
    }
    if (spec.flags?.includes(arg)) {
      result.flags.add(arg);
      continue;
    }
    const isValue = spec.values?.includes(arg);
    if (!isValue && !spec.lists?.includes(arg)) throw new Error(`${UNKNOWN_OPTION} ${arg.slice(0, 60)}`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${MISSING_VALUE} ${arg}.`);
    index += 1;
    if (isValue) result.values[arg] = value;
    else result.lists[arg] = [...(result.lists[arg] ?? []), value];
  }
  return result;
};

/** An integer option within bounds, or undefined when absent. */
export const integerOption = (parsed: ParsedArgs, name: string, minimum: number, maximum: number, message: string): number | undefined => {
  const raw = parsed.values[name];
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(message);
  return value;
};

const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A job id as typed (UUID v4), lowercased. */
export const requireJobId = (value: string | undefined): string => {
  if (!value || !JOB_ID.test(value)) throw new Error(CLI_MESSAGES.jobIdRequired);
  return value.toLowerCase();
};

export const isJobId = (value: unknown): value is string => typeof value === "string" && JOB_ID.test(value);

/** Reads a job; a missing job file becomes the Portuguese "not found" message. */
export const readJob = async (jobs: { get(id: string): Promise<JobRecord> }, id: string | undefined): Promise<JobRecord> => {
  const jobId = requireJobId(id);
  try {
    return await jobs.get(jobId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") throw new Error(CLI_MESSAGES.jobNotFound);
    throw error;
  }
};

/** Reads standard input as UTF-8, refusing more than `maxBytes`. */
export const readStdinText = async (maxBytes: number, stream: AsyncIterable<Buffer | string> = process.stdin): Promise<string> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error(CLI_MESSAGES.inputTooLarge);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
};

export type Interrupt = { signal: AbortSignal; dispose(): void };

/** SIGINT or SIGTERM aborts the returned signal; dispose removes the handlers. */
export const processInterrupt = (): Interrupt => {
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return {
    signal: controller.signal,
    dispose: () => {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
  };
};

export const defaultLoadConfig = async (): Promise<AppConfig> => (await (await import("../config/load")).loadConfig()).config;

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** `12:03`, or `1:02:03` past one hour; `--:--` when unknown. */
export const clockText = (seconds: number | undefined): string => {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "--:--";
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600), minutes = Math.floor((total % 3600) / 60), rest = total % 60;
  const pad = (value: number): string => String(value).padStart(2, "0");
  return hours ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${pad(minutes)}:${pad(rest)}`;
};

/** Local calendar day (YYYY-MM-DD) of an ISO time; the input itself when it does not parse. */
export const localDay = (iso: string | undefined): string => {
  const ms = typeof iso === "string" ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(ms)) return iso || "";
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};

/** Explicit bidirectional embeddings, overrides and isolates: they reorder what the terminal shows. */
const BIDI_CONTROLS = /[\u202a-\u202e\u2066-\u2069]/g;

/** One line for terminal output: control characters become spaces, bidirectional overrides are dropped. */
export const oneLine = (text: string, max = 300): string =>
  text.replace(/[\p{Cc}\u2028\u2029]+/gu, " ").replace(BIDI_CONTROLS, "").replace(/\s+/g, " ").trim().slice(0, max);

/**
 * Untrusted multi-line text (a model's answer) made safe to print on a terminal: line breaks and
 * tabs stay, any other control character (ESC sequences that move the cursor, set the title or
 * write the clipboard) becomes a space, and explicit bidirectional overrides are dropped.
 */
export const terminalText = (text: string): string =>
  text.replace(/\r\n?|[\u2028\u2029\u0085]/g, "\n").replace(/[^\P{Cc}\n\t]/gu, " ").replace(BIDI_CONTROLS, "");

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
