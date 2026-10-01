import { promises as fs } from "node:fs";
import { resolve } from "node:path";
import * as readline from "node:readline";
import { createInterface as createPrompt } from "node:readline/promises";
import {
  readCallStatus,
  type CallMonitorStatus
} from "../calls/status";
import type { AppConfig } from "../config/defaults";
import { runCommand } from "../jobs/command";
import { queueAlignedSubtitles } from "../subtitles/service";
import { JobStore } from "../jobs/store";
import { retryJob, syncJob } from "../jobs/sync";
import type { JobRecord, JobState } from "../jobs/types";
import { RecordingSessionStore } from "../recording/session";
import { readState as readLegacyRecordingState } from "../recording/state";
import { refreshAiContextIfEnabled } from "../knowledge/context";
import { loadTimesheetContext } from "../timesheet/context";
import { formatClock, formatHours, formatTimeEntry } from "../timesheet/format";
import {
  parseLocalDateTime,
  splitTimeEntry,
  type TimeEntryChanges,
  updateTimeEntry
} from "../timesheet/operations";
import { reconcileTimeEntryForJob } from "../timesheet/reconcile";
import { TimeEntryStore } from "../timesheet/store";
import type { TimeEntry, TimesheetContext } from "../timesheet/types";
import {
  buildLibrary,
  assertExistingJobArtifactPath,
  deleteJobArtifacts,
  deleteRecording,
  getArtifactAvailability,
  getManagedArtifactPath,
  readArtifact,
  type ArtifactAvailability,
  type ArtifactKind,
  type LibraryEntry
} from "./library";
import {
  findCompletedRemoteJob,
  playLibraryEntry,
  removeVerifiedLocalSource,
  searchTranscript,
  type TranscriptSearchResult
} from "./media";
import {
  cycleLibraryStateFilter,
  filterLibraryEntries,
  libraryStateFilterLabel,
  type LibraryStateFilter
} from "./search";

const ALT_SCREEN_ON = "\u001b[?1049h";
const ALT_SCREEN_OFF = "\u001b[?1049l";
const CURSOR_HIDE = "\u001b[?25l";
const CURSOR_SHOW = "\u001b[?25h";
const CLEAR_SCREEN = "\u001b[2J\u001b[H";
const RESET = "\u001b[0m";
const BOLD = "\u001b[1m";
const REVERSE = "\u001b[7m";
const MIN_WIDE_COLUMNS = 100;

type Key = {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  shift?: boolean;
};

type DeletePrompt =
  | "choose"
  | "confirm-artifacts"
  | "confirm-recording"
  | "confirm-local-source"
  | "confirm-time-entry"
  | null;
type TuiSection = "library" | "timesheet";
export type TuiOptions = {
  initialSection?: TuiSection;
  readActiveRecordingPath?: () => Promise<string | undefined>;
};

export const isRetryKey = (key: Key): boolean =>
  key.sequence === "R" || (key.name === "r" && key.shift === true);

export const isProcessKey = (key: Key): boolean =>
  key.sequence === "P" || (key.name === "p" && key.shift === true);

export const selectInitialArtifactView = (
  availability: ArtifactAvailability
): ArtifactKind => availability.summary || !availability.transcript
  ? "summary"
  : "transcript";

export const buildLibraryActionLine = (failedJob: boolean): string =>
  `↑↓ · / lista · f estado · b texto · n/N · p tocar · r ler · P job${
    failedJob ? " · R retry" : ""
  } · ?`;

export type TuiLayout = {
  listHeight: number;
  rowsPerEntry: number;
  visibleEntries: number;
  contentHeight: number;
};

export const getTuiLayout = (_columns: number, rows: number): TuiLayout => {
  const safeRows = Math.max(12, rows || 24);
  const listHeight = Math.min(
    9,
    Math.max(6, Math.floor((safeRows - 9) * 0.45))
  );
  const rowsPerEntry = 1;
  return {
    listHeight,
    rowsPerEntry,
    visibleEntries: Math.max(1, Math.floor(listHeight / rowsPerEntry)),
    contentHeight: Math.max(3, safeRows - listHeight - 10)
  };
};

export const sanitizeTerminalText = (value: string): string =>
  value.replace(/\r/g, "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");

export const buildLibraryHeader = (
  visible: number,
  total: number,
  state: LibraryStateFilter,
  query: string,
  columns: number
): string => {
  const count = visible === total ? `${total}` : `${visible}/${total}`;
  const prefix = `FalaTrace · ${count} gravações · filtro ${libraryStateFilterLabel(state)} · busca `;
  const available = Math.max(1, columns - prefix.length);
  const cleanQuery = sanitizeTerminalText(query).replaceAll("\n", " ").trim();
  const label = cleanQuery ? `“${cleanQuery}”` : "—";
  return `${prefix}${label.length <= available
    ? label
    : `${label.slice(0, Math.max(0, available - 1))}…`}`;
};

type JobEnqueuer = Pick<JobStore, "enqueue">;

export const readActiveRecordingPath = async (): Promise<string | undefined> => {
  const session = await new RecordingSessionStore().read();
  if (session && session.phase !== "stopped") return session.outputPath;
  return (await readLegacyRecordingState())?.outputPath;
};

export const enqueueSelectedRecording = async (
  config: AppConfig,
  store: JobEnqueuer,
  entry: Pick<LibraryEntry, "sourcePath" | "sourceExists">,
  activeRecording: () => Promise<string | undefined> = readActiveRecordingPath
): Promise<JobRecord> => {
  if (!entry.sourceExists) {
    throw new Error("A gravação selecionada não está disponível localmente.");
  }
  const activePath = await activeRecording();
  if (activePath && resolve(activePath) === resolve(entry.sourcePath)) {
    throw new Error("A gravação selecionada ainda está em andamento.");
  }
  return store.enqueue(config, entry.sourcePath);
};

export const formatJobContent = (
  job: Pick<JobRecord, "id" | "state" | "error">,
  content: string
): string => {
  if (job.state !== "failed") return content;
  const reason = job.error?.trim() || "Motivo não informado pelo worker.";
  return `JOB COM FALHA\nMotivo: ${reason}\nID: ${job.id}\n\n${content}`;
};

export const formatLibraryEntryName = (
  entry: Pick<
    LibraryEntry,
    "sourceExists" | "relativePath" | "meetingTitle"
  >
): string =>
  `${entry.sourceExists ? "" : "[ausente] "}${
    entry.meetingTitle ? `${entry.meetingTitle} · ` : ""
  }${entry.relativePath}`;

export const formatStorageLocation = (
  entry: Pick<LibraryEntry, "sourceExists" | "jobs" | "archive">
): string => {
  const remote = Boolean(findCompletedRemoteJob(entry)) || entry.archive?.vaio.state === "completed";
  if (entry.archive?.proton.state === "completed") {
    return [entry.sourceExists ? "local" : "", remote ? "vaio" : "", "Proton verificado"].filter(Boolean).join(" + ");
  }
  if (entry.sourceExists && remote) return "local + vaio";
  if (entry.sourceExists) return "somente local";
  if (remote) return "somente no vaio";
  return "arquivo ausente";
};

export const parseEditorCommand = (value: string): string[] => {
  if (!value.trim() || value.length > 1000 || /[\r\n\0]/.test(value)) {
    throw new Error("EDITOR/VISUAL is empty or invalid");
  }
  const result: string[] = [];
  let current = "";
  let quote: "single" | "double" | null = null;
  let escaped = false;
  for (const character of value.trim()) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\" && quote !== "single") {
      escaped = true;
    } else if (character === "'" && quote !== "double") {
      quote = quote === "single" ? null : "single";
    } else if (character === '"' && quote !== "single") {
      quote = quote === "double" ? null : "double";
    } else if (/\s/.test(character) && quote === null) {
      if (current) result.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  if (escaped || quote !== null) throw new Error("EDITOR/VISUAL contains an unfinished escape or quote");
  if (current) result.push(current);
  if (result.length === 0) throw new Error("EDITOR/VISUAL did not contain a command");
  return result;
};

const fit = (value: string, width: number): string => {
  const clean = sanitizeTerminalText(value).replaceAll("\n", " ");
  if (clean.length > width) return `${clean.slice(0, Math.max(0, width - 1))}…`;
  return clean.padEnd(width);
};

const wrapText = (value: string, width: number): string[] => {
  const lines: string[] = [];
  for (const paragraph of sanitizeTerminalText(value).split("\n")) {
    if (paragraph.length === 0) {
      lines.push("");
      continue;
    }
    let remaining = paragraph;
    while (remaining.length > width) {
      let splitAt = remaining.lastIndexOf(" ", width);
      if (splitAt < Math.floor(width / 2)) splitAt = width;
      lines.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).trimStart();
    }
    lines.push(remaining);
  }
  return lines;
};

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GiB`;
};

const formatShortDate = (timestamp: number): string => {
  const date = new Date(timestamp);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const jobStatusLabels: Record<JobState, string> = {
  pending: "[·] Pendente",
  transferring: "[⇡] Enviando",
  queued: "[→] Na fila",
  processing: "[~] Processando",
  completed: "[✓] Concluído",
  failed: "[!] Falhou"
};

export const formatJobStatus = (
  job?: Pick<JobRecord, "state">
): string => job ? jobStatusLabels[job.state] : "[–] Sem job";

export const findLinkedTimeEntries = (
  entry: Pick<LibraryEntry, "sourcePath">,
  timeEntries: TimeEntry[],
  job?: Pick<JobRecord, "id">
): TimeEntry[] => {
  const recordingMatches = timeEntries.filter(
    (timeEntry) => timeEntry.source.recordingPath === entry.sourcePath
  );
  if (!job) return recordingMatches;
  const jobMatches = timeEntries.filter(
    (timeEntry) => timeEntry.source.jobId === job.id
  );
  return jobMatches.length > 0 ? jobMatches : recordingMatches;
};

export const formatLinkedClient = (entries: TimeEntry[]): string => {
  const assigned = entries.filter((entry) => entry.clientCode);
  const clients = [...new Set(assigned.map((entry) => entry.clientCode!))];
  if (clients.length === 0) return "—";
  if (clients.length > 1) return `${clients.length} clientes`;
  const confirmed = assigned.every((entry) =>
    entry.lockedFields.includes("client")
  );
  return `${confirmed ? "=" : "~"}${clients[0]}`;
};

export const formatLinkedDuration = (entries: TimeEntry[]): string => {
  if (entries.some((entry) => entry.status === "capturing")) return "em curso";
  const total = entries.reduce(
    (sum, entry) => sum + (entry.hours || 0),
    0
  );
  if (total <= 0) return "—";
  const minutes = Math.round(total * 60);
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return hours > 0
    ? `${hours}h${remaining > 0 ? String(remaining).padStart(2, "0") : ""}`
    : `${remaining}min`;
};

export const formatTimeEntryStatus = (
  entries: TimeEntry[],
  job?: Pick<JobRecord, "id">
): string => {
  if (entries.length === 0) return "[–] Sem horas";
  const stale =
    Boolean(job) &&
    entries.some((entry) => entry.source.jobId) &&
    entries.every((entry) => entry.source.jobId !== job!.id);
  if (stale) return "[↺] Desatualizado";
  if (entries.some((entry) => entry.status === "capturing")) {
    return "[●] Em curso";
  }
  if (entries.some((entry) => entry.classificationStatus === "failed")) {
    if (entries.some((entry) => entry.classificationSource === "openai")) {
      return "[!] OpenAI falhou";
    }
    return "[!] Classif. falhou";
  }
  if (entries.some((entry) => entry.classificationStatus === "pending")) {
    return "[·] Classificar";
  }
  if (entries.some((entry) => entry.status === "draft")) return "[!] Revisar";
  if (entries.every((entry) => entry.status === "synced")) return "[✓] Enviado";
  return "[✓] Pronto";
};

const formatCallStatus = (status: CallMonitorStatus | null): string => {
  if (!status) return "chamada: estado indisponível";
  if (status.recordingWarning) return `chamada: atenção · ${status.recordingWarning}`;
  if (status.recordingOwned) return `chamada: gravando${status.recordingBackend === "audio" ? " áudio" : status.recordingBackend === "gpu-screen-recorder" ? " tela e áudio" : " no OBS"}`;
  const application =
    status.app === "slack"
      ? "Slack"
      : status.app === "zen"
        ? "Zen"
        : status.app === "helium"
          ? "Helium"
          : "";
  if (status.state === "IN_CALL") return `chamada: em andamento${application ? ` · ${application}` : ""}`;
  if (status.state === "CANDIDATE") return `chamada: confirmando${application ? ` · ${application}` : ""}`;
  if (status.state === "ENDING") return "chamada: encerrando";
  return "chamada: monitorando";
};

const artifactMarker = (
  availability: ArtifactAvailability,
  kind: ArtifactKind
): string => availability[kind] ? "✓" : "–";

export const buildHelpLines = (
  section: TuiSection,
  columns: number
): string[] => {
  const commands =
    section === "library"
      ? [
          "↑/↓ ou j/k  Selecionar gravação",
          "/           Buscar título, caminho, cliente ou data; vazio limpa",
          "f           Filtrar por estado; todos limpa",
          "b           Buscar na transcrição; n/N avança/volta",
          "Tab, t, s   Alternar transcrição e resumo",
          "v           Trocar versão de processamento",
          "PgUp/PgDn  Rolar o documento",
          "e           Editar o artefato aberto",
          "p           Reproduzir no player no trecho selecionado",
          "L           Gerar legendas precisas no VAIO em segundo plano",
          "l           Liberar somente o espaço do vídeo local",
          "r           Atualizar a biblioteca (somente leitura)",
          "P           Processar somente o job selecionado",
          "R           Repetir um job com falha",
          "d           Excluir com confirmação e Lixeira",
          "h           Abrir apontamentos"
        ]
      : [
          "↑/↓ ou j/k  Selecionar apontamento",
          "PgUp/PgDn  Rolar os detalhes",
          "e           Revisar e confirmar campos",
          "x           Dividir atividades detectadas",
          "R           Repetir classificação com falha",
          "d           Excluir somente o apontamento",
          "h           Voltar à biblioteca"
        ];
  return [
    `AJUDA · ${section === "library" ? "Biblioteca" : "Apontamentos"}`,
    "Os símbolos acompanham o texto; a interface não depende somente de cor.",
    "",
    ...commands,
    "",
    "Campos: = confirmado manualmente · ~ sugestão automática (origem nos detalhes) · ↺ ligado a outra versão",
    "",
    "Pressione ? ou Esc para fechar."
  ].flatMap((line) => wrapText(line, columns));
};

class RecordingTui {
  private section: TuiSection = "library";
  private allEntries: LibraryEntry[] = [];
  private entries: LibraryEntry[] = [];
  private timeEntries: TimeEntry[] = [];
  private timesheetContext?: TimesheetContext;
  private callStatus: CallMonitorStatus | null = null;
  private selectedIndex = 0;
  private timeSelectedIndex = 0;
  private versionIndex = 0;
  private view: ArtifactKind = "summary";
  private viewChosen = false;
  private artifacts: ArtifactAvailability = {
    transcript: false,
    summary: false
  };
  private content = "";
  private contentOffset = 0;
  private message = "";
  private libraryQuery = "";
  private libraryStateFilter: LibraryStateFilter = "all";
  private transcriptQuery = "";
  private transcriptMatches: TranscriptSearchResult[] = [];
  private transcriptMatchIndex = -1;
  private deletePrompt: DeletePrompt = null;
  private retryPrompt: "job" | "classification" | null = null;
  private processPrompt = false;
  private splitPrompt = false;
  private helpVisible = false;
  private operationInProgress = false;
  private running = false;
  private resolveFinished?: () => void;
  private keyQueue = Promise.resolve();
  private readonly readActiveRecording: () => Promise<string | undefined>;

  constructor(
    private readonly config: AppConfig,
    private readonly store: JobStore,
    private readonly timeStore: TimeEntryStore,
    options: TuiOptions = {}
  ) {
    this.section = options.initialSection || "library";
    this.readActiveRecording = options.readActiveRecordingPath || readActiveRecordingPath;
  }

  async start(): Promise<void> {
    if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
      throw new Error("The TUI requires an interactive terminal");
    }
    await this.reloadLibrary();
    await this.reloadTimesheet();
    this.running = true;
    this.enterTerminal();
    readline.emitKeypressEvents(process.stdin);
    this.attachInput();
    this.render();
    await new Promise<void>((resolve) => {
      this.resolveFinished = resolve;
    });
  }

  private currentEntry(): LibraryEntry | undefined {
    return this.entries[this.selectedIndex];
  }

  private currentJob(): JobRecord | undefined {
    return this.currentEntry()?.jobs[this.versionIndex];
  }

  private currentTimeEntry(): TimeEntry | undefined {
    return this.timeEntries[this.timeSelectedIndex];
  }

  private async reloadLibrary(): Promise<void> {
    const previousSource = this.currentEntry()?.sourcePath;
    const previousJob = this.currentJob()?.id;
    [this.allEntries, this.callStatus] = await Promise.all([
      buildLibrary(this.config, this.store),
      readCallStatus().catch(() => null)
    ]);
    this.applyLibraryFilters(previousSource);
    if (previousSource) {
      const entryIndex = this.entries.findIndex((entry) => entry.sourcePath === previousSource);
      if (entryIndex >= 0) this.selectedIndex = entryIndex;
    }
    this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.entries.length - 1));
    const entry = this.currentEntry();
    const jobIndex = previousJob ? entry?.jobs.findIndex((job) => job.id === previousJob) ?? -1 : -1;
    this.versionIndex = jobIndex >= 0 ? jobIndex : 0;
    await this.loadContent();
  }

  private applyLibraryFilters(preferredSource?: string): void {
    const selectedSource = preferredSource || this.currentEntry()?.sourcePath;
    this.entries = filterLibraryEntries(this.allEntries, this.timeEntries, {
      query: this.libraryQuery,
      state: this.libraryStateFilter
    });
    const selected = selectedSource
      ? this.entries.findIndex((entry) => entry.sourcePath === selectedSource)
      : -1;
    this.selectedIndex = selected >= 0
      ? selected
      : Math.min(this.selectedIndex, Math.max(0, this.entries.length - 1));
    this.versionIndex = 0;
    this.viewChosen = false;
  }

  private async reloadTimesheet(): Promise<void> {
    const previousId = this.currentTimeEntry()?.id;
    [this.timeEntries, this.timesheetContext] = await Promise.all([
      this.timeStore.list(),
      loadTimesheetContext(this.config)
    ]);
    if (previousId) {
      const index = this.timeEntries.findIndex((entry) => entry.id === previousId);
      if (index >= 0) this.timeSelectedIndex = index;
    }
    this.timeSelectedIndex = Math.min(
      this.timeSelectedIndex,
      Math.max(0, this.timeEntries.length - 1)
    );
    this.applyLibraryFilters();
    await this.loadContent();
  }

  private async loadContent(): Promise<void> {
    this.contentOffset = 0;
    if (this.section === "timesheet") {
      this.clearTranscriptSearch();
      this.artifacts = { transcript: false, summary: false };
      const entry = this.currentTimeEntry();
      this.content = entry
        ? formatTimeEntry(entry, this.timesheetContext)
        : "Nenhum apontamento encontrado.\n\nAs chamadas e gravações vinculadas aparecerão aqui para revisão.";
      return;
    }
    const job = this.currentJob();
    if (!job) {
      this.clearTranscriptSearch();
      this.artifacts = { transcript: false, summary: false };
      this.content = this.entries.length === 0
        ? this.allEntries.length > 0
          ? "Nenhuma gravação corresponde à busca e ao filtro atuais.\n\nUse / com uma busca vazia e percorra f até ‘todos’ para limpar."
          : "Nenhuma gravação encontrada.\n\nNovas gravações aparecerão aqui sem exigir processamento."
        : "Esta gravação ainda não possui job.\n\nPressione P para criar e processar somente esta gravação, com confirmação.";
      return;
    }
    this.artifacts = await getArtifactAvailability(job);
    if (!this.viewChosen) {
      this.view = selectInitialArtifactView(this.artifacts);
    }
    try {
      this.content = formatJobContent(job, await readArtifact(job, this.view));
    } catch (err) {
      this.content = formatJobContent(
        job,
        `Erro ao ler ${this.view}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (this.view === "transcript" && this.transcriptQuery) {
      this.transcriptMatches = searchTranscript(this.content, this.transcriptQuery);
      this.transcriptMatchIndex = Math.min(
        Math.max(0, this.transcriptMatchIndex),
        Math.max(0, this.transcriptMatches.length - 1)
      );
      this.focusTranscriptMatch();
    } else if (this.view !== "transcript") {
      this.clearTranscriptSearch();
    }
  }

  private clearTranscriptSearch(): void {
    this.transcriptQuery = "";
    this.transcriptMatches = [];
    this.transcriptMatchIndex = -1;
  }

  private currentTranscriptMatch(): TranscriptSearchResult | undefined {
    return this.transcriptMatches[this.transcriptMatchIndex];
  }

  private focusTranscriptMatch(): void {
    const match = this.currentTranscriptMatch();
    if (!match) return;
    const columns = Math.max(40, process.stdout.columns || 100);
    const wrapped = wrapText(this.content, columns);
    const lineIndex = this.transcriptMatchLineIndex(wrapped);
    if (lineIndex >= 0) {
      this.contentOffset = Math.max(0, lineIndex - 1);
    }
  }

  private transcriptMatchLineIndex(lines: string[]): number {
    const match = this.currentTranscriptMatch();
    if (!match) return -1;
    if (match.startSeconds !== undefined) {
      const timestamp = `[${this.formatTimestamp(match.startSeconds)}]`;
      const timestampLine = lines.findIndex((line) => line.includes(timestamp));
      if (timestampLine >= 0) return timestampLine;
    }
    const needle = sanitizeTerminalText(match.text).trim().slice(0, 24);
    return needle ? lines.findIndex((line) => line.includes(needle)) : -1;
  }

  private moveTranscriptMatch(offset: number): void {
    if (this.transcriptMatches.length === 0) {
      this.message = "Use b para buscar na transcrição selecionada.";
      return;
    }
    this.transcriptMatchIndex = (
      this.transcriptMatchIndex + offset + this.transcriptMatches.length
    ) % this.transcriptMatches.length;
    this.focusTranscriptMatch();
    const match = this.currentTranscriptMatch();
    this.message = `Trecho ${this.transcriptMatchIndex + 1}/${this.transcriptMatches.length}${
      match?.startSeconds === undefined ? " · sem timestamp" : ` · ${this.formatTimestamp(match.startSeconds)}`
    }.`;
  }

  private formatTimestamp(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remaining = Math.floor(seconds % 60);
    return hours > 0
      ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`
      : `${minutes}:${String(remaining).padStart(2, "0")}`;
  }

  private enterTerminal(): void {
    process.stdout.write(`${ALT_SCREEN_ON}${CURSOR_HIDE}`);
    process.stdin.setRawMode!(true);
    process.stdin.resume();
  }

  private leaveTerminal(): void {
    if (process.stdin.isTTY) process.stdin.setRawMode?.(false);
    process.stdout.write(`${CURSOR_SHOW}${ALT_SCREEN_OFF}`);
  }

  private attachInput(): void {
    process.stdin.on("keypress", this.onKeypress);
    process.stdout.on("resize", this.onResize);
    process.on("SIGINT", this.onSignal);
    process.on("SIGTERM", this.onSignal);
    process.on("SIGHUP", this.onSignal);
  }

  private detachInput(): void {
    process.stdin.off("keypress", this.onKeypress);
    process.stdout.off("resize", this.onResize);
    process.off("SIGINT", this.onSignal);
    process.off("SIGTERM", this.onSignal);
    process.off("SIGHUP", this.onSignal);
  }

  private readonly onResize = (): void => this.render();

  private readonly onSignal = (): void => this.finish();

  private readonly onKeypress = (_text: string, key: Key): void => {
    this.keyQueue = this.keyQueue
      .then(() => this.handleKey(key))
      .catch((err) => {
        this.message = err instanceof Error ? err.message : String(err);
        this.operationInProgress = false;
        this.deletePrompt = null;
        this.retryPrompt = null;
        this.processPrompt = false;
        this.splitPrompt = false;
        this.render();
      });
  };

  private finish(): void {
    if (!this.running) return;
    this.running = false;
    this.detachInput();
    this.leaveTerminal();
    process.stdin.pause();
    this.resolveFinished?.();
  }

  private async handleKey(key: Key): Promise<void> {
    if (!this.running) return;
    if (key.ctrl && key.name === "c") {
      this.finish();
      return;
    }
    if (this.helpVisible) {
      if (
        key.name === "escape" ||
        key.name === "q" ||
        key.sequence === "q" ||
        key.sequence === "?"
      ) {
        this.helpVisible = false;
        this.render();
      }
      return;
    }
    if (this.deletePrompt) {
      await this.handleDeletePrompt(key);
      return;
    }
    if (this.retryPrompt) {
      await this.handleRetryPrompt(key);
      return;
    }
    if (this.processPrompt) {
      await this.handleProcessPrompt(key);
      return;
    }
    if (this.splitPrompt) {
      await this.handleSplitPrompt(key);
      return;
    }
    if (key.sequence === "?" || key.name === "f1") {
      this.helpVisible = true;
      this.render();
      return;
    }
    if (key.name === "q" || key.sequence === "q" || key.name === "escape") {
      this.finish();
      return;
    }
    if (key.sequence === "h") {
      this.section = this.section === "library" ? "timesheet" : "library";
      this.contentOffset = 0;
      await this.loadContent();
      this.render();
      return;
    }
    if (this.section === "library" && key.sequence === "/") {
      await this.promptLibrarySearch();
    } else if (this.section === "library" && key.sequence === "f") {
      const previous = this.currentEntry()?.sourcePath;
      this.libraryStateFilter = cycleLibraryStateFilter(this.libraryStateFilter);
      this.applyLibraryFilters(previous);
      await this.loadContent();
      this.message = this.libraryStateFilter === "all"
        ? "Filtro de estado limpo."
        : `Filtro: ${libraryStateFilterLabel(this.libraryStateFilter)}.`;
    } else if (this.section === "library" && key.sequence === "b") {
      if (!this.currentJob()) {
        this.message = "Esta gravação ainda não possui transcrição.";
      } else {
        this.view = "transcript";
        this.viewChosen = true;
        await this.loadContent();
        if (!this.artifacts.transcript) {
          this.message = "A transcrição desta versão ainda não está disponível.";
        } else {
          await this.promptTranscriptSearch();
        }
      }
    } else if (
      this.section === "library" &&
      (key.sequence === "n" || key.sequence === "N")
    ) {
      this.moveTranscriptMatch(key.sequence === "N" ? -1 : 1);
    } else if (key.name === "down" || key.sequence === "j") {
      await this.moveSelection(1);
    } else if (key.name === "up" || key.sequence === "k") {
      await this.moveSelection(-1);
    } else if (key.name === "pageup") {
      this.contentOffset = Math.max(0, this.contentOffset - this.contentPageSize());
    } else if (key.name === "pagedown") {
      this.contentOffset += this.contentPageSize();
    } else if (
      this.section === "library" &&
      (key.name === "tab" || key.name === "return")
    ) {
      this.viewChosen = true;
      this.view = this.view === "transcript" ? "summary" : "transcript";
      await this.loadContent();
    } else if (this.section === "library" && key.sequence === "t") {
      this.viewChosen = true;
      this.view = "transcript";
      await this.loadContent();
    } else if (this.section === "library" && key.sequence === "s") {
      this.viewChosen = true;
      this.view = "summary";
      await this.loadContent();
    } else if (this.section === "library" && key.sequence === "v") {
      const jobs = this.currentEntry()?.jobs || [];
      if (jobs.length > 1) {
        this.versionIndex = (this.versionIndex + 1) % jobs.length;
        this.viewChosen = false;
        this.clearTranscriptSearch();
        await this.loadContent();
      }
    } else if (key.sequence === "e") {
      if (this.section === "timesheet") {
        await this.editCurrentTimeEntry();
      } else {
        await this.editCurrentArtifact();
      }
    } else if (this.section === "library" && key.sequence === "p") {
      await this.playCurrentRecording();
    } else if (this.section === "library" && (key.sequence === "L" || (key.name === "l" && key.shift))) {
      const entry = this.currentEntry();
      const id = entry?.archive?.vaio.state === "completed" ? entry.archive.id : entry ? findCompletedRemoteJob(entry, this.currentJob())?.id : undefined;
      if (!id) this.message = "Aguarde a cópia do vídeo no VAIO antes de gerar as legendas precisas.";
      else {
        try {
          await queueAlignedSubtitles(id);
          this.message = "Legendas em geração no VAIO. Ao terminar, abra novamente o player com p.";
        } catch (error) { this.message = `Falha ao iniciar as legendas: ${error instanceof Error ? error.message : String(error)}`; }
      }
    } else if (this.section === "library" && key.sequence === "l") {
      const entry = this.currentEntry();
      if (!entry) {
        this.message = "Nenhuma gravação selecionada.";
      } else if (!entry.sourceExists) {
        this.message = findCompletedRemoteJob(entry, this.currentJob())
          ? "Este vídeo já está somente no vaio."
          : "O vídeo local não existe e não há uma cópia concluída no vaio.";
      } else if (!findCompletedRemoteJob(entry, this.currentJob())) {
        this.message = "Não há uma cópia concluída no vaio; o vídeo local será preservado.";
      } else {
        this.deletePrompt = "confirm-local-source";
      }
    } else if (key.sequence === "d") {
      if (this.section === "timesheet") {
        if (this.currentTimeEntry()) this.deletePrompt = "confirm-time-entry";
      } else if (this.currentEntry()) {
        this.deletePrompt = "choose";
      }
    } else if (this.section === "timesheet" && key.sequence === "x") {
      const entry = this.currentTimeEntry();
      if (!entry?.activityPlan) {
        this.message = "Este apontamento não possui múltiplas atividades detectadas.";
      } else if (!entry.activityPlan.splittable) {
        this.message =
          "Divisão indisponível: os intervalos das atividades não são confiáveis.";
      } else {
        this.splitPrompt = true;
      }
    } else if (this.section === "library" && isProcessKey(key)) {
      const job = this.currentJob();
      if (!job) {
        if (!this.currentEntry()?.sourceExists) {
          this.message = "A gravação selecionada não está disponível localmente.";
        } else {
          this.processPrompt = true;
        }
      } else if (job.state === "failed") {
        this.message = "Este job falhou; use R para tentar novamente.";
      } else if (job.state === "completed") {
        this.message = "Este job já foi concluído.";
      } else if (job.state === "processing") {
        this.message = "Este job já está em processamento.";
      } else {
        this.processPrompt = true;
      }
    } else if (isRetryKey(key)) {
      if (this.section === "timesheet") {
        const entry = this.currentTimeEntry();
        if (!entry) {
          this.message = "Nenhum apontamento selecionado.";
        } else if (entry.classificationStatus !== "failed") {
          this.message = "Somente classificações com falha podem ser repetidas.";
        } else if (!entry.source.jobId) {
          this.message = "Este apontamento não possui job para reclassificação.";
        } else {
          this.retryPrompt = "classification";
        }
      } else {
        const job = this.currentJob();
        if (!job) {
          this.message = "Esta gravação não possui job para tentar novamente.";
        } else if (job.state !== "failed") {
          this.message = "Somente jobs com falha podem ser tentados novamente.";
        } else {
          this.retryPrompt = "job";
        }
      }
    } else if (key.sequence === "r") {
      void this.refreshReadOnly();
    }
    this.render();
  }

  private async moveSelection(offset: number): Promise<void> {
    if (this.section === "timesheet") {
      if (this.timeEntries.length === 0) return;
      this.timeSelectedIndex = Math.max(
        0,
        Math.min(this.timeEntries.length - 1, this.timeSelectedIndex + offset)
      );
    } else {
      if (this.entries.length === 0) return;
      this.selectedIndex = Math.max(
        0,
        Math.min(this.entries.length - 1, this.selectedIndex + offset)
      );
      this.versionIndex = 0;
      this.viewChosen = false;
      this.clearTranscriptSearch();
    }
    await this.loadContent();
  }

  private async promptLibrarySearch(): Promise<void> {
    if (this.operationInProgress) return;
    this.operationInProgress = true;
    this.detachInput();
    this.leaveTerminal();
    process.stdin.pause();
    const prompt = createPrompt({ input: process.stdin, output: process.stdout });
    try {
      const value = await prompt.question(
        `Buscar na biblioteca [${sanitizeTerminalText(this.libraryQuery) || "sem busca"}]: `
      );
      if (value.length > 200 || /[\r\n\0]/.test(value)) {
        throw new Error("A busca deve ter no máximo 200 caracteres.");
      }
      const previous = this.currentEntry()?.sourcePath;
      this.libraryQuery = value.trim();
      this.applyLibraryFilters(previous);
      await this.loadContent();
      this.message = this.libraryQuery
        ? `${this.entries.length} resultado(s) para “${sanitizeTerminalText(this.libraryQuery)}”.`
        : "Busca limpa.";
    } finally {
      prompt.close();
      if (this.running) {
        this.enterTerminal();
        this.attachInput();
      }
      this.operationInProgress = false;
    }
  }

  private async promptTranscriptSearch(): Promise<void> {
    if (this.operationInProgress) return;
    this.operationInProgress = true;
    this.detachInput();
    this.leaveTerminal();
    process.stdin.pause();
    const prompt = createPrompt({ input: process.stdin, output: process.stdout });
    try {
      const value = await prompt.question(
        `Buscar nesta transcrição [${sanitizeTerminalText(this.transcriptQuery) || "sem busca"}]: `
      );
      if (value.length > 200 || /[\r\n\0]/.test(value)) {
        throw new Error("A busca deve ter no máximo 200 caracteres.");
      }
      this.transcriptQuery = value.trim();
      this.transcriptMatches = this.transcriptQuery
        ? searchTranscript(this.content, this.transcriptQuery)
        : [];
      this.transcriptMatchIndex = this.transcriptMatches.length > 0 ? 0 : -1;
      this.focusTranscriptMatch();
      const match = this.currentTranscriptMatch();
      this.message = !this.transcriptQuery
        ? "Busca na transcrição limpa."
        : !match
          ? `Nenhum trecho contém “${sanitizeTerminalText(this.transcriptQuery)}”.`
          : `${this.transcriptMatches.length} trecho(s); selecionado 1/${this.transcriptMatches.length}${
              match.startSeconds === undefined ? " sem timestamp" : ` em ${this.formatTimestamp(match.startSeconds)}`
            }.`;
    } finally {
      prompt.close();
      if (this.running) {
        this.enterTerminal();
        this.attachInput();
      }
      this.operationInProgress = false;
    }
  }

  private async refreshReadOnly(): Promise<void> {
    if (this.operationInProgress || !this.running) return;
    this.operationInProgress = true;
    this.message = "Atualizando dados locais…";
    this.render();
    try {
      await this.reloadLibrary();
      await this.reloadTimesheet();
      this.message = "Biblioteca atualizada em modo somente leitura.";
    } catch (err) {
      this.message = `Falha ao atualizar: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      this.operationInProgress = false;
      this.render();
    }
  }

  private async editCurrentArtifact(): Promise<void> {
    if (this.operationInProgress) return;
    const job = this.currentJob();
    if (!job) {
      this.message = "Esta gravação ainda não possui artefatos editáveis.";
      return;
    }
    const path = getManagedArtifactPath(job, this.view);
    const stat = await assertExistingJobArtifactPath(job, path).catch((err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    });
    if (!stat || !stat.isFile()) {
      this.message = `${this.view}.md ainda não está disponível para edição.`;
      return;
    }
    const editor = parseEditorCommand(process.env.VISUAL || process.env.EDITOR || "nano");
    this.operationInProgress = true;
    this.detachInput();
    this.leaveTerminal();
    process.stdin.pause();
    try {
      await runCommand(editor[0], [...editor.slice(1), path], { inherit: true });
      this.message = `${this.view}.md salvo.`;
    } finally {
      if (this.running) {
        this.enterTerminal();
        this.attachInput();
        await this.loadContent();
      }
      this.operationInProgress = false;
    }
  }

  private async editCurrentTimeEntry(): Promise<void> {
    if (this.operationInProgress) return;
    const entry = this.currentTimeEntry();
    if (!entry) {
      this.message = "Nenhum apontamento selecionado.";
      return;
    }
    this.operationInProgress = true;
    this.detachInput();
    this.leaveTerminal();
    process.stdin.pause();
    const prompt = createPrompt({ input: process.stdin, output: process.stdout });
    try {
      console.log("Edite os campos. Enter preserva o valor atual; '-' limpa o campo.");
      console.log();
      console.log(
        `Clientes: ${sanitizeTerminalText(this.timesheetContext?.clients.map((client) => `${client.code}=${client.name}`).join(" · ") || "catálogo vazio")}`
      );
      console.log(
        `Tipos: ${sanitizeTerminalText(this.timesheetContext?.taskTypes.map((taskType) => `${taskType.id}=${taskType.name}`).join(" · ") || "catálogo vazio")}`
      );
      console.log();
      const client = await prompt.question(`Cliente [${entry.clientCode || "?"}]: `);
      const taskType = await prompt.question(
        `Tipo [${entry.taskTypeId || "?"}]: `
      );
      const date = await prompt.question(`Data [${entry.activityDate}]: `);
      const start = await prompt.question(`Início [${formatClock(entry.startAt)}]: `);
      const end = await prompt.question(`Fim [${formatClock(entry.endAt)}]: `);
      const hours = await prompt.question(`Horas [${formatHours(entry.hours)}]: `);
      const card = await prompt.question(`Card [${entry.cardId || "—"}]: `);
      const description = await prompt.question(
        `Descrição [${sanitizeTerminalText(entry.description || "?").replaceAll("\n", " ").slice(0, 300)}]: `
      );
      const selectedDate = date.trim() || entry.activityDate;
      const changes: TimeEntryChanges = {};
      if (client.trim()) changes.client = client.trim() === "-" ? null : client.trim();
      if (taskType.trim()) {
        changes.taskType = taskType.trim() === "-" ? null : taskType.trim();
      }
      if (date.trim()) changes.activityDate = selectedDate;
      if (start.trim()) {
        changes.startAt =
          start.trim() === "-" ? null : parseLocalDateTime(selectedDate, start.trim());
      }
      if (end.trim()) {
        changes.endAt =
          end.trim() === "-" ? null : parseLocalDateTime(selectedDate, end.trim());
      }
      const effectiveStart =
        changes.startAt === undefined ? entry.startAt : changes.startAt || undefined;
      const effectiveEnd =
        changes.endAt === undefined ? entry.endAt : changes.endAt || undefined;
      if (
        effectiveStart &&
        effectiveEnd &&
        new Date(effectiveEnd).getTime() <= new Date(effectiveStart).getTime()
      ) {
        changes.endAt = new Date(
          new Date(effectiveEnd).getTime() + 24 * 60 * 60 * 1_000
        ).toISOString();
      }
      if (hours.trim()) {
        changes.hours =
          hours.trim() === "-" ? null : Number(hours.trim().replace(",", "."));
      }
      if (card.trim()) changes.cardId = card.trim() === "-" ? null : card.trim();
      if (description.trim()) {
        changes.description =
          description.trim() === "-" ? null : description.trim();
      }
      await updateTimeEntry(this.config, this.timeStore, entry.id, changes);
      await this.reloadTimesheet();
      this.message = "Apontamento atualizado.";
    } finally {
      prompt.close();
      if (this.running) {
        this.enterTerminal();
        this.attachInput();
        await this.loadContent();
      }
      this.operationInProgress = false;
    }
  }

  private async handleDeletePrompt(key: Key): Promise<void> {
    const prompt = this.deletePrompt;
    if (key.name === "escape" || key.sequence === "q") {
      this.deletePrompt = null;
      this.message = "Exclusão cancelada.";
    } else if (prompt === "choose") {
      if (key.sequence === "a" && this.currentJob()) {
        this.deletePrompt = "confirm-artifacts";
      } else if (key.sequence === "g") {
        this.deletePrompt = "confirm-recording";
      }
    } else if (key.sequence === "n") {
      this.deletePrompt = null;
      this.message = "Exclusão cancelada.";
    } else if (
      key.sequence === "y" &&
      (prompt === "confirm-artifacts" ||
        prompt === "confirm-recording" ||
        prompt === "confirm-local-source" ||
        prompt === "confirm-time-entry")
    ) {
      if (prompt === "confirm-time-entry") {
        const entry = this.currentTimeEntry();
        if (entry) {
          await this.timeStore.remove(entry.id);
          await refreshAiContextIfEnabled(this.config);
          await this.reloadTimesheet();
          this.message = "Apontamento local excluído.";
        }
        this.deletePrompt = null;
      } else if (prompt === "confirm-local-source") {
        await this.performLocalSourceRemoval();
      } else {
        await this.performDelete(prompt);
      }
    }
    this.render();
  }

  private async handleRetryPrompt(key: Key): Promise<void> {
    if (key.name === "escape" || key.sequence === "q" || key.sequence === "n") {
      this.retryPrompt = null;
      this.message = "Retry cancelado.";
    } else if (key.sequence === "y") {
      if (this.retryPrompt === "classification") {
        await this.performClassificationRetry();
      } else {
        await this.performRetry();
      }
    }
    this.render();
  }

  private async handleProcessPrompt(key: Key): Promise<void> {
    if (key.name === "escape" || key.sequence === "q" || key.sequence === "n") {
      this.processPrompt = false;
      this.message = "Processamento cancelado.";
    } else if (key.sequence === "y") {
      await this.performProcess();
    }
    this.render();
  }

  private async handleSplitPrompt(key: Key): Promise<void> {
    if (key.name === "escape" || key.sequence === "q" || key.sequence === "n") {
      this.splitPrompt = false;
      this.message = "Divisão cancelada.";
    } else if (key.sequence === "y") {
      await this.performSplit();
    }
    this.render();
  }

  private async performSplit(): Promise<void> {
    if (this.operationInProgress) return;
    const entry = this.currentTimeEntry();
    if (!entry?.activityPlan?.splittable) {
      this.splitPrompt = false;
      this.message = "O apontamento selecionado não pode mais ser dividido.";
      return;
    }
    this.operationInProgress = true;
    this.splitPrompt = false;
    try {
      const entries = await splitTimeEntry(
        this.config,
        this.timeStore,
        entry.id
      );
      await this.reloadTimesheet();
      this.message = `Apontamento dividido em ${entries.length} atividades; o total de horas foi preservado.`;
    } catch (err) {
      this.message = `Falha ao dividir: ${err instanceof Error ? err.message : String(err)}`;
      await this.reloadTimesheet();
    } finally {
      this.operationInProgress = false;
    }
  }

  private async performRetry(): Promise<void> {
    if (this.operationInProgress) return;
    const job = this.currentJob();
    if (!job || job.state !== "failed") {
      this.retryPrompt = null;
      this.message = "O job selecionado não está mais com falha.";
      return;
    }
    this.operationInProgress = true;
    this.retryPrompt = null;
    this.message = `Retomando job ${job.id.slice(0, 8)}…`;
    this.render();
    try {
      await retryJob(this.store, job.id);
      await syncJob(this.config, this.store, job.id);
      await this.reloadLibrary();
      await this.reloadTimesheet();
      const updated = await this.store.get(job.id);
      this.message = `Retry solicitado; estado atual: ${updated.state}.`;
    } catch (err) {
      this.message = `Falha ao tentar novamente: ${err instanceof Error ? err.message : String(err)}`;
      await this.reloadLibrary();
    } finally {
      this.operationInProgress = false;
    }
  }

  private async performProcess(): Promise<void> {
    if (this.operationInProgress) return;
    const entry = this.currentEntry();
    let job = this.currentJob();
    if (!entry) {
      this.processPrompt = false;
      this.message = "Nenhuma gravação selecionada.";
      return;
    }
    if (job && !["pending", "transferring", "queued"].includes(job.state)) {
      this.processPrompt = false;
      this.message = "O job selecionado não está mais disponível para processamento.";
      return;
    }
    this.operationInProgress = true;
    this.processPrompt = false;
    this.message = job
      ? `Processando somente o job ${job.id.slice(0, 8)}…`
      : "Criando o job somente para a gravação selecionada…";
    this.render();
    try {
      if (!job) {
        job = await enqueueSelectedRecording(
          this.config,
          this.store,
          entry,
          this.readActiveRecording
        );
      }
      const updated = await syncJob(this.config, this.store, job.id);
      await this.reloadLibrary();
      await this.reloadTimesheet();
      this.message = `Job selecionado atualizado; estado atual: ${updated.state}.`;
    } catch (err) {
      this.message = `Falha ao processar o job selecionado: ${err instanceof Error ? err.message : String(err)}`;
      await this.reloadLibrary();
    } finally {
      this.operationInProgress = false;
    }
  }

  private async performClassificationRetry(): Promise<void> {
    if (this.operationInProgress) return;
    const entry = this.currentTimeEntry();
    if (
      !entry?.source.jobId ||
      entry.classificationStatus !== "failed"
    ) {
      this.retryPrompt = null;
      this.message = "A classificação selecionada não pode mais ser repetida.";
      return;
    }
    this.operationInProgress = true;
    this.retryPrompt = null;
    this.message = "Reclassificando apontamento…";
    this.render();
    try {
      const job = await this.store.get(entry.source.jobId);
      const classified = await reconcileTimeEntryForJob(
        this.config,
        job,
        this.timeStore,
        { force: true }
      );
      if (!classified) throw new Error("O apontamento não pôde ser classificado");
      await refreshAiContextIfEnabled(this.config);
      await this.reloadTimesheet();
      this.message =
        classified.classificationStatus === "completed"
          ? "Classificação atualizada; revise as sugestões antes de confirmar."
          : `Classificação não concluída: ${classified.classificationError || "motivo não informado"}`;
    } catch (err) {
      this.message = `Falha ao reclassificar: ${err instanceof Error ? err.message : String(err)}`;
      await this.reloadTimesheet();
    } finally {
      this.operationInProgress = false;
    }
  }

  private async playCurrentRecording(): Promise<void> {
    if (this.operationInProgress) return;
    const entry = this.currentEntry();
    if (!entry) {
      this.message = "Nenhuma gravação selecionada.";
      return;
    }
    this.operationInProgress = true;
    const match = this.currentTranscriptMatch();
    const startSeconds = match?.startSeconds;
    this.message = entry.sourceExists
      ? startSeconds === undefined
        ? "Abrindo o vídeo local no player…"
        : `Abrindo o vídeo local em ${this.formatTimestamp(startSeconds)}…`
      : "Validando e montando o arquivo do vaio em modo somente leitura…";
    this.render();
    try {
      const result = await playLibraryEntry(
        this.config,
        entry,
        this.currentJob(),
        startSeconds === undefined ? {} : { startSeconds }
      );
      if (match && startSeconds === undefined) {
        this.message = "Trecho sem timestamp; o player foi aberto do início.";
      } else {
        const position = startSeconds === undefined
          ? ""
          : ` em ${this.formatTimestamp(startSeconds)}`;
        this.message = result.location === "local"
          ? `Vídeo local aberto no player${position}.`
          : result.location === "proton"
            ? `Vídeo restaurado do Proton, verificado e aberto no player${position}.`
            : `Vídeo do vaio aberto no player${position} via SSHFS somente leitura.`;
      }
    } catch (err) {
      this.message = `Falha ao reproduzir: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      this.operationInProgress = false;
    }
  }

  private async performLocalSourceRemoval(): Promise<void> {
    if (this.operationInProgress) return;
    const entry = this.currentEntry();
    if (!entry) return;
    this.operationInProgress = true;
    this.deletePrompt = null;
    this.message = "Conferindo tamanho e SHA-256 no vaio antes de remover o vídeo local…";
    this.render();
    try {
      const result = await removeVerifiedLocalSource(
        this.config,
        entry,
        this.currentJob()
      );
      await this.reloadLibrary();
      this.message =
        `${formatBytes(result.bytesFreed)} liberados; catálogo e artefatos locais foram preservados.`;
    } catch (err) {
      this.message =
        `Vídeo local preservado: ${err instanceof Error ? err.message : String(err)}`;
      await this.reloadLibrary();
    } finally {
      this.operationInProgress = false;
    }
  }

  private async performDelete(prompt: Exclude<DeletePrompt, "choose" | null>): Promise<void> {
    if (this.operationInProgress) return;
    const entry = this.currentEntry();
    if (!entry) return;
    this.operationInProgress = true;
    try {
      if (prompt === "confirm-artifacts") {
        const job = this.currentJob();
        if (!job) throw new Error("Nenhum job selecionado");
        const result = await deleteJobArtifacts(this.config, entry, job, this.store);
        this.message = result.keptSharedArtifacts
          ? "Job removido; artefatos compartilhados com outra versão foram preservados."
          : "Transcrição e resumo enviados para a Lixeira; gravação preservada.";
        this.message += result.scope.aiContext === "failed" ? " Memória de IA não pôde ser invalidada; reconstrua antes de usar." : " Memória de IA requer rebuild se existente; remotos, catálogo e estado auxiliar preservados.";
      } else {
        const result = await deleteRecording(this.config, entry, this.store);
        this.message = result.keptSharedArtifacts
          ? "Gravação enviada para a Lixeira; artefatos compartilhados foram preservados."
          : "Gravação e artefatos locais enviados para a Lixeira.";
        this.message += result.scope.aiContext === "failed" ? " Memória de IA não pôde ser invalidada; reconstrua antes de usar." : " Memória de IA requer rebuild se existente; remotos, catálogo e estado auxiliar preservados.";
      }
      this.deletePrompt = null;
      await this.reloadLibrary();
    } finally {
      this.operationInProgress = false;
    }
  }

  private contentPageSize(): number {
    const rows = Math.max(12, process.stdout.rows || 24);
    const columns = Math.max(40, process.stdout.columns || 100);
    return getTuiLayout(columns, rows).contentHeight;
  }

  private render(): void {
    if (!this.running) return;
    const columns = Math.max(40, process.stdout.columns || 100);
    const rows = Math.max(12, process.stdout.rows || 24);
    if (this.helpVisible) {
      const help = buildHelpLines(this.section, columns).slice(0, rows);
      while (help.length < rows) help.push("");
      process.stdout.write(
        `${CLEAR_SCREEN}${help.map((line, index) =>
          index === 0
            ? `${BOLD}${fit(line, columns)}${RESET}`
            : fit(line, columns)
        ).join("\n")}`
      );
      return;
    }

    const { listHeight, contentHeight, rowsPerEntry, visibleEntries } =
      getTuiLayout(columns, rows);
    const selected = this.currentEntry();
    const job = this.currentJob();
    const lines: string[] = [];

    if (this.section === "timesheet") {
      this.renderTimesheet(lines, columns, rows, listHeight, contentHeight);
      process.stdout.write(`${CLEAR_SCREEN}${lines.join("\n")}`);
      return;
    }

    const activeJobs = this.allEntries.filter((entry) =>
      entry.jobs.some((candidate) =>
        ["pending", "transferring", "queued", "processing"].includes(
          candidate.state
        )
      )
    ).length;
    const failedJobs = this.allEntries.filter((entry) =>
      entry.jobs.some((candidate) => candidate.state === "failed")
    ).length;
    const header = buildLibraryHeader(
      this.entries.length,
      this.allEntries.length,
      this.libraryStateFilter,
      this.libraryQuery,
      columns
    );
    lines.push(`${BOLD}${fit(header, columns)}${RESET}`);
    lines.push(fit(
      `${activeJobs} em andamento · ${failedJobs} falha(s) · ${formatCallStatus(this.callStatus)} · [h] apontamentos`,
      columns
    ));
    lines.push("─".repeat(columns));
    const wide = columns >= MIN_WIDE_COLUMNS;
    const listStart = Math.max(
      0,
      Math.min(
        this.selectedIndex - visibleEntries + 1,
        this.entries.length - visibleEntries
      )
    );
    if (wide) {
      const titleWidth = Math.max(8, columns - 68);
      lines.push(
        `  ${fit("PROCESSAMENTO", 15)} ${fit("DATA", 11)} ${fit("DURAÇÃO", 8)} ${fit("CLIENTE", 11)} ${fit("APONTAMENTO", 16)} ${fit("TÍTULO / ARQUIVO", titleWidth)}`
      );
    } else {
      lines.push(
        fit(
          "  ESTADO          DATA        TÍTULO / ARQUIVO",
          columns
        )
      );
    }
    for (let itemRow = 0; itemRow < visibleEntries; itemRow += 1) {
      const entryIndex = listStart + itemRow;
      const entry = this.entries[entryIndex];
      if (!entry) {
        for (let row = 0; row < rowsPerEntry; row += 1) {
          lines.push(" ".repeat(columns));
        }
        continue;
      }
      const latestJob = entry.jobs[0];
      const linked = findLinkedTimeEntries(entry, this.timeEntries, latestJob);
      const title = `${
        entry.sourceExists
          ? ""
          : findCompletedRemoteJob(entry)
            ? "[vaio] "
            : "[arquivo ausente] "
      }${entry.meetingTitle ? `IA · ${entry.meetingTitle}` : entry.relativePath}`;
      const selectedRow = entryIndex === this.selectedIndex;
      const decorate = (line: string): string =>
        selectedRow ? `${REVERSE}${line}${RESET}` : line;
      if (wide) {
        const titleWidth = Math.max(8, columns - 68);
        const line = `${selectedRow ? ">" : " "} ${fit(formatJobStatus(latestJob), 15)} ${fit(formatShortDate(entry.modifiedAt), 11)} ${fit(formatLinkedDuration(linked), 8)} ${fit(formatLinkedClient(linked), 11)} ${fit(formatTimeEntryStatus(linked, latestJob), 16)} ${fit(title, titleWidth)}`;
        lines.push(decorate(line));
      } else {
        lines.push(
          decorate(fit(
            `${selectedRow ? ">" : " "} ${fit(formatJobStatus(latestJob), 15)} ${fit(formatShortDate(entry.modifiedAt), 11)} ${title}`,
            columns
          ))
        );
      }
    }
    while (lines.length < listHeight + 3) {
      lines.push(" ".repeat(columns));
    }
    lines.push("─".repeat(columns));

    if (selected) {
      const version = job ? `${this.versionIndex + 1}/${selected.jobs.length}` : "-";
      const provider = job
        ? `${job.transcription.provider} → ${job.summary.provider}`
        : "sem processamento";
      const target = job?.target === "remote" ? "remoto" : "local";
      lines.push(
        fit(
          `${this.view === "transcript" ? "[T]" : " T "} Transcrição ${artifactMarker(this.artifacts, "transcript")}  ${this.view === "summary" ? "[S]" : " S "} Resumo ${artifactMarker(this.artifacts, "summary")} · versão ${version} · ${formatJobStatus(job)} · ${provider} · ${target}`,
          columns
        )
      );
      lines.push(
        fit(
          `Arquivo: ${selected.relativePath} · ${formatBytes(selected.size)} · ${formatStorageLocation(selected)}`,
          columns
        )
      );
      const linked = findLinkedTimeEntries(selected, this.timeEntries, job);
      if (selected.archive) {
        const labels = { pending: "pendente", failed: "falhou", completed: "verificado" };
        lines.push(fit(`Backup do vídeo: vaio ${labels[selected.archive.vaio.state]} · Proton ${labels[selected.archive.proton.state]}`, columns));
      }
      const transcriptMatch = this.currentTranscriptMatch();
      const detail = transcriptMatch
        ? `Busca “${sanitizeTerminalText(this.transcriptQuery)}” · trecho ${this.transcriptMatchIndex + 1}/${this.transcriptMatches.length} · ${
            transcriptMatch.startSeconds === undefined
              ? "sem timestamp"
              : this.formatTimestamp(transcriptMatch.startSeconds)
          } · n/N navega · p toca`
        : `Cliente ${formatLinkedClient(linked)} · duração ${formatLinkedDuration(linked)} · apontamento ${formatTimeEntryStatus(linked, job)}${selected.meetingTitle ? " · título sugerido por IA" : ""}`;
      lines.push(
        fit(
          detail,
          columns
        )
      );
    } else {
      lines.push(fit("Nenhuma gravação encontrada.", columns));
      lines.push(fit("A biblioteca continua sendo a tela inicial.", columns));
      lines.push("");
    }

    const wrapped = wrapText(this.content, columns);
    const maxOffset = Math.max(0, wrapped.length - contentHeight);
    this.contentOffset = Math.min(this.contentOffset, maxOffset);
    const transcriptMatchLine = this.transcriptMatchLineIndex(wrapped);
    for (let row = 0; row < contentHeight; row += 1) {
      const contentIndex = this.contentOffset + row;
      const line = fit(wrapped[contentIndex] || "", columns);
      lines.push(
        contentIndex === transcriptMatchLine
          ? `${REVERSE}${line}${RESET}`
          : line
      );
    }

    if (this.deletePrompt === "choose") {
      lines.push(fit("Excluir: [a] transcrição/resumo desta versão  [g] gravação + todos artefatos  [Esc] cancelar", columns));
      lines.push(fit("Lixeira local; remotos, catálogo e estado auxiliar preservados. Memória de IA será invalidada.", columns));
    } else if (this.deletePrompt === "confirm-artifacts") {
      lines.push(fit("Confirmar exclusão dos artefatos desta versão? [y] sim  [n/Esc] não", columns));
      lines.push(fit("Original/remotos preservados; memória compacta requer rebuild. Exportações externas não são removidas.", columns));
    } else if (this.deletePrompt === "confirm-recording") {
      lines.push(fit("Confirmar exclusão da gravação e de TODOS os artefatos locais? [y] sim  [n/Esc] não", columns));
      lines.push(fit("Lixeira local; remotos e estado auxiliar preservados. Memória compacta requer rebuild.", columns));
    } else if (this.deletePrompt === "confirm-local-source") {
      lines.push(fit("Liberar espaço removendo permanentemente SOMENTE o vídeo local? [y] sim  [n/Esc] não", columns));
      lines.push(fit("O vaio será validado por tamanho e SHA-256; catálogo, transcrição e resumo serão preservados.", columns));
    } else if (this.retryPrompt) {
      lines.push(
        fit(
          this.retryPrompt === "classification"
            ? "Repetir a classificação deste apontamento? [y] sim  [n/Esc] não"
            : "Tentar processar novamente este job? [y] sim  [n/Esc] não",
          columns
        )
      );
      lines.push(
        fit(
          this.retryPrompt === "classification"
            ? "Campos confirmados manualmente serão preservados; a operação pode gerar custo de API."
            : "Uma transcrição válida será reutilizada; a operação ainda pode gerar custo de API.",
          columns
        )
      );
    } else if (this.processPrompt) {
      lines.push(fit(
        job
          ? "Processar somente o job selecionado? [y] sim  [n/Esc] não"
          : "Criar e processar um job só para esta gravação? [y] sim  [n/Esc] não",
        columns
      ));
      lines.push(fit("A operação pode transferir mídia ou gerar custo de API.", columns));
    } else {
      lines.push(fit(this.message || "Pronto.", columns));
      lines.push(
        fit(
          buildLibraryActionLine(job?.state === "failed"),
          columns
        )
      );
    }
    process.stdout.write(`${CLEAR_SCREEN}${lines.join("\n")}`);
  }

  private renderTimesheet(
    lines: string[],
    columns: number,
    _rows: number,
    listHeight: number,
    contentHeight: number
  ): void {
    const ready = this.timeEntries.filter((entry) => entry.status === "ready").length;
    const review = this.timeEntries.filter((entry) => entry.status === "draft").length;
    const failed = this.timeEntries.filter(
      (entry) => entry.classificationStatus === "failed"
    ).length;
    lines.push(`${BOLD}${fit(
      `FalaTrace · Apontamentos  ${this.timeEntries.length} itens · ${ready} pronto(s) · ${review} revisar · ${failed} falha(s) · [h] gravações`,
      columns
    )}${RESET}`);
    lines.push("─".repeat(columns));
    const wide = columns >= MIN_WIDE_COLUMNS;
    const rowsPerEntry = wide ? 1 : 2;
    const visibleEntries = Math.max(1, Math.floor(listHeight / rowsPerEntry));
    const listStart = Math.max(
      0,
      Math.min(
        this.timeSelectedIndex - visibleEntries + 1,
        this.timeEntries.length - visibleEntries
      )
    );
    if (wide) {
      const descriptionWidth = Math.max(8, columns - 66);
      lines.push(
        `  ${fit("APONTAMENTO", 16)} ${fit("DATA", 10)} ${fit("DURAÇÃO", 8)} ${fit("CLIENTE", 11)} ${fit("ORIGEM", 12)} ${fit("CLASSIF.", 11)} ${fit("DESCRIÇÃO", descriptionWidth)}`
      );
    } else {
      lines.push(
        fit(
          "APONTAMENTOS · estado / data · duração · cliente · classificação / descrição",
          columns
        )
      );
    }
    for (let itemRow = 0; itemRow < visibleEntries; itemRow += 1) {
      const index = listStart + itemRow;
      const entry = this.timeEntries[index];
      if (!entry) {
        for (let row = 0; row < rowsPerEntry; row += 1) {
          lines.push(" ".repeat(columns));
        }
        continue;
      }
      const selectedRow = index === this.timeSelectedIndex;
      const decorate = (line: string): string =>
        selectedRow ? `${REVERSE}${line}${RESET}` : line;
      const source =
        entry.source.kind === "call"
          ? entry.source.app === "slack"
            ? "Chamada Slack"
            : entry.source.app === "zen"
              ? "Chamada Zen"
              : entry.source.app === "helium"
                ? "Chamada Helium"
                : "Chamada"
          : entry.source.kind === "timer"
            ? "Timer"
            : "Manual";
      const classification =
        entry.classificationStatus === "completed"
          ? entry.classificationSource === "openai"
            ? "OpenAI"
            : entry.classificationSource === "rules"
              ? "regras"
              : "origem ?"
          : entry.classificationStatus === "pending"
            ? "aguardando"
            : entry.classificationStatus === "failed"
              ? "falhou"
              : "manual";
      if (wide) {
        const descriptionWidth = Math.max(8, columns - 66);
        const line = `${selectedRow ? ">" : " "} ${fit(formatTimeEntryStatus([entry]), 16)} ${fit(entry.activityDate, 10)} ${fit(formatLinkedDuration([entry]), 8)} ${fit(formatLinkedClient([entry]), 11)} ${fit(source, 12)} ${fit(classification, 11)} ${fit(entry.description || "Sem descrição", descriptionWidth)}`;
        lines.push(decorate(line));
      } else {
        lines.push(
          decorate(
            fit(
              `${selectedRow ? ">" : " "} ${formatTimeEntryStatus([entry])} · ${entry.activityDate} · ${formatLinkedDuration([entry])} · ${formatLinkedClient([entry])} · ${classification}`,
              columns
            )
          )
        );
        lines.push(
          decorate(fit(`  ${entry.description || "Sem descrição"}`, columns))
        );
      }
    }
    while (lines.length < listHeight + 3) {
      lines.push(" ".repeat(columns));
    }
    lines.push("─".repeat(columns));
    const wrapped = wrapText(this.content, columns);
    const maxOffset = Math.max(0, wrapped.length - contentHeight);
    this.contentOffset = Math.min(this.contentOffset, maxOffset);
    for (let row = 0; row < contentHeight; row += 1) {
      lines.push(fit(wrapped[this.contentOffset + row] || "", columns));
    }
    if (this.deletePrompt === "confirm-time-entry") {
      lines.push(
        fit("Confirmar exclusão deste apontamento local? [y] sim  [n/Esc] não", columns)
      );
      lines.push(fit("A gravação, transcrição e resumo serão preservados.", columns));
    } else if (this.splitPrompt) {
      const count = this.currentTimeEntry()?.activityPlan?.activities.length || 0;
      lines.push(
        fit(
          `Dividir este apontamento em ${count} atividades? [y] sim  [n/Esc] não`,
          columns
        )
      );
      lines.push(
        fit("A soma das horas será preservada; início e fim ficarão opcionais.", columns)
      );
    } else if (this.retryPrompt === "classification") {
      lines.push(
        fit("Repetir a classificação deste apontamento? [y] sim  [n/Esc] não", columns)
      );
      lines.push(
        fit("Campos confirmados serão preservados; a operação pode gerar custo de API.", columns)
      );
    } else {
      lines.push(fit(this.message || "Pronto.", columns));
      lines.push(
        fit(
          `↑/↓ navegar · e revisar · x dividir · d excluir · r atualizar${this.currentTimeEntry()?.classificationStatus === "failed" ? " · R reclassificar" : ""} · h gravações · ? ajuda · q sair`,
          columns
        )
      );
    }
  }
}

export const runTui = async (
  config: AppConfig,
  store = new JobStore(),
  timeStore = new TimeEntryStore(),
  options: TuiOptions = {}
): Promise<void> => {
  await new RecordingTui(config, store, timeStore, options).start();
};
