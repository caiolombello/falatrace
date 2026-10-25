// Notepad lines: splitting the text a person typed, classifying markdown-ish
// prefixes, and reconciling a new version of the text with the stored entries so
// that every line keeps its id and timestamp across edits.

export const NOTE_LIMITS = Object.freeze({
  maxEntries: 500,
  maxLineChars: 2000,
  /** UTF-8 bytes of all lines joined with "\n". */
  maxTotalBytes: 64 * 1024,
  /** Raw notepad text accepted before splitting (blank lines and trailing spaces are dropped later). */
  maxInputChars: 1024 * 1024,
  /** Entry ids are n000001..n999999 and are never reused. */
  maxSeq: 999_999,
  /** A note more than a day after the media started is not on the media timeline. */
  maxOffsetSeconds: 24 * 60 * 60,
  /** Notes typed shortly after the capture stopped still belong to its last moment. */
  afterEndGraceSeconds: 120
});

export const NOTES_ERRORS = Object.freeze({
  conflict: "As notas mudaram em outra janela; recarregue antes de salvar.",
  lineTooLong: "Uma linha das notas passou de 2000 caracteres; divida-a em linhas menores.",
  tooManyLines: "As notas passaram de 500 linhas; apague ou junte algumas antes de salvar.",
  tooLarge: "As notas passaram de 64 KiB; apague ou resuma algumas antes de salvar.",
  invalidText: "O texto das notas é inválido.",
  invalidId: "Identificador de notas inválido.",
  invalidRev: "Revisão das notas inválida.",
  invalidTime: "Horário inválido para as notas.",
  invalidMediaTime: "Horário da gravação inválido para as notas.",
  invalidSourcePath: "Caminho da gravação inválido para as notas.",
  invalidTitle: "Título das notas inválido.",
  corrupted: "As notas desta reunião estão corrompidas; o arquivo foi mantido sem alterações.",
  unsafeDir: "A pasta das notas não é segura; ela precisa ser privada e não pode ser um link.",
  unsafeFile: "O arquivo das notas não é seguro; ele não pode ser um link nem um arquivo especial.",
  busy: "As notas estão sendo salvas por outro processo; tente de novo em instantes.",
  idsExhausted: "As notas desta reunião atingiram o limite de identificadores; copie o texto, apague as notas e cole de novo."
});

/** Every fixed user-facing message of the notes module (for the bridge whitelist and i18n). */
export const NOTES_KNOWN_ERRORS: readonly string[] = Object.freeze(Object.values(NOTES_ERRORS));

export type NoteEntry = {
  /** n000001.. stable across edits, never reused. */
  id: string;
  /** When the line was first typed (ISO). */
  createdAt: string;
  /** Seconds since the media started, or null when the note is not on the media timeline. */
  offsetSeconds: number | null;
  /** One line, ≤2000 characters, trailing spaces removed. */
  text: string;
};

export type NoteLineKind = "heading" | "action" | "bullet" | "text";
export type ParsedNoteLine = { kind: NoteLineKind; body: string; level?: number; done?: boolean };

const NOTE_ID = /^n\d{6}$/;
const HEADING = /^\s*(#{1,6})\s+(\S.*)$/u;
const ACTION = /^\s*(?:[-*+•]\s+)?\[([ xX]?)\](?:\s+(.*)|$)/u;
const BULLET = /^\s*(?:[-*+•]|\d{1,3}[.)])\s+(.*)$/u;

export const isNoteEntryId = (value: unknown): value is string =>
  typeof value === "string" && NOTE_ID.test(value) && value !== "n000000";
export const noteEntryId = (seq: number): string => `n${String(seq).padStart(6, "0")}`;
export const noteEntryNumber = (id: string): number => (isNoteEntryId(id) ? Number(id.slice(1)) : 0);

// Line breaks: LF, CR, CRLF, VT, FF, NEL, LINE SEPARATOR, PARAGRAPH SEPARATOR.
const isLineBreakCode = (code: number): boolean =>
  code === 0x0a || code === 0x0d || code === 0x0b || code === 0x0c || code === 0x85 || code === 0x2028 || code === 0x2029;
// Other control characters (tab excepted) never belong in a note line.
const isControlCode = (code: number): boolean => (code < 0x20 && code !== 0x09) || (code >= 0x7f && code <= 0x9f);
const hasControl = (value: string): boolean => {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (isControlCode(code) || isLineBreakCode(code)) return true;
  }
  return false;
};
const withoutControl = (value: string): string => {
  if (!hasControl(value)) return value;
  let out = "";
  for (let index = 0; index < value.length; index++) if (!isControlCode(value.charCodeAt(index))) out += value[index];
  return out;
};
const physicalLines = (text: string): string[] => {
  const lines: string[] = [];
  let begin = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (let index = begin; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (!isLineBreakCode(code)) continue;
    lines.push(text.slice(begin, index));
    if (code === 0x0d && text.charCodeAt(index + 1) === 0x0a) index++;
    begin = index + 1;
  }
  lines.push(text.slice(begin));
  return lines;
};

/** A stored line is canonical: one line, no control characters, no trailing spaces, not blank. */
export const isCanonicalNoteLine = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= NOTE_LIMITS.maxLineChars &&
  !hasControl(value) && value === value.trimEnd() && value.trim() !== "";

const totalBytes = (lines: readonly string[]): number =>
  lines.reduce((sum, line) => sum + Buffer.byteLength(line, "utf8"), 0) + Math.max(0, lines.length - 1);

/**
 * Splits the whole notepad into non-empty lines: any line break style, trailing spaces
 * removed, control characters dropped, markdown prefixes and leading indentation kept.
 */
export const splitNoteLines = (text: unknown): string[] => {
  if (typeof text !== "string") throw new Error(NOTES_ERRORS.invalidText);
  if (text.length > NOTE_LIMITS.maxInputChars) throw new Error(NOTES_ERRORS.tooLarge);
  const lines: string[] = [];
  for (const raw of physicalLines(text)) {
    const line = withoutControl(raw).normalize("NFC").trimEnd();
    if (!line.trim()) continue;
    if (line.length > NOTE_LIMITS.maxLineChars) throw new Error(NOTES_ERRORS.lineTooLong);
    lines.push(line);
    if (lines.length > NOTE_LIMITS.maxEntries) throw new Error(NOTES_ERRORS.tooManyLines);
  }
  if (totalBytes(lines) > NOTE_LIMITS.maxTotalBytes) throw new Error(NOTES_ERRORS.tooLarge);
  return lines;
};

/** Checks the limits of an entry list that was built elsewhere (count, line shape, total size). */
export const noteLinesWithinLimits = (lines: readonly string[]): boolean =>
  lines.length <= NOTE_LIMITS.maxEntries && lines.every(isCanonicalNoteLine) && totalBytes(lines) <= NOTE_LIMITS.maxTotalBytes;

export const parseNoteLine = (text: string): ParsedNoteLine => {
  const heading = HEADING.exec(text);
  if (heading) return { kind: "heading", body: heading[2].trim(), level: heading[1].length };
  const action = ACTION.exec(text);
  if (action) return { kind: "action", body: (action[2] || "").trim(), done: action[1] === "x" || action[1] === "X" };
  const bullet = BULLET.exec(text);
  if (bullet) return { kind: "bullet", body: bullet[1].trim() };
  return { kind: "text", body: text.trim() };
};

/** `# …` heading, `[ ]`/`- [ ]`/`[x]` action, `- `/`* ` (or `1.`) bullet, anything else text. */
export const classifyNoteLine = (text: string): NoteLineKind => parseNoteLine(text).kind;

/** `text.slice(0, length)` that never cuts a surrogate pair (an emoji) in half. */
export const sliceNoteText = (text: string, length: number): string => {
  if (text.length <= length) return text;
  const last = text.charCodeAt(length - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? length - 1 : length);
};

/** Heading texts in order, for template detection. */
export const noteHeadings = (notes: { entries: readonly Pick<NoteEntry, "text">[] } | undefined | null, limit = 20): string[] =>
  (notes?.entries || []).map((entry) => parseNoteLine(entry.text)).filter((line) => line.kind === "heading" && line.body)
    .slice(0, limit).map((line) => sliceNoteText(line.body, 120));

/** The notepad text again, one entry per line. */
export const notesText = (notes: { entries: readonly Pick<NoteEntry, "text">[] } | undefined | null): string =>
  (notes?.entries || []).map((entry) => entry.text).join("\n");

// Line similarity for edits: character bigrams of the line body (prefix, case and accents ignored).
const comparable = (text: string): string => {
  const { body } = parseNoteLine(text);
  return (body || text).normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 256);
};
const bigrams = (value: string): number[] => {
  const out: number[] = [];
  for (let index = 0; index + 1 < value.length; index++) out.push(value.charCodeAt(index) * 65_536 + value.charCodeAt(index + 1));
  return out.sort((a, b) => a - b);
};
type Shape = { text: string; grams: number[] };
const shape = (line: string): Shape => { const text = comparable(line); return { text, grams: bigrams(text) }; };
const similarity = (a: Shape, b: Shape): number => {
  if (a.text === b.text) return 1;
  let common = 0;
  for (let i = 0, j = 0; i < a.grams.length && j < b.grams.length;) {
    if (a.grams[i] === b.grams[j]) { common++; i++; j++; } else if (a.grams[i] < b.grams[j]) i++; else j++;
  }
  const dice = a.grams.length + b.grams.length ? (2 * common) / (a.grams.length + b.grams.length) : 0;
  // Continuing to type at the end of a line is an edit even when the line grows a lot.
  const [short, long] = a.text.length <= b.text.length ? [a.text, b.text] : [b.text, a.text];
  return short.length >= 2 && long.startsWith(short) ? Math.max(dice, 0.8) : dice;
};

/** 0..1 similarity used to decide whether a changed line is an edit of an old one. */
export const noteLineSimilarity = (a: string, b: string): number => similarity(shape(a), shape(b));

export const NOTE_MATCHING = Object.freeze({
  /** Minimum similarity for pairing two changed lines of a gap as an edit. */
  editSimilarity: 0.4,
  /** Above this many old×new pairs in one gap, lines are not compared (only equal counts pair by position). */
  maxGapPairs: 40_000,
  /** Above this many old×new lines the LCS table is skipped (only common prefix/suffix match). */
  maxLcsCells: 1_000_000
});

export type NoteLineMatchKind = "same" | "moved" | "edited" | "new";
export type NoteLineMatch = {
  /** For each new line, the index of the old line it continues, or -1. */
  oldIndex: number[];
  kind: NoteLineMatchKind[];
};

// Longest common subsequence of line ids, after trimming the common prefix and suffix.
const lcsPairs = (a: readonly number[], b: readonly number[]): Array<[number, number]> => {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const pairs: Array<[number, number]> = [];
  for (let index = 0; index < start; index++) pairs.push([index, index]);
  const n = endA - start, m = endB - start;
  if (n > 0 && m > 0 && (n + 1) * (m + 1) <= NOTE_MATCHING.maxLcsCells) {
    const width = m + 1;
    const table = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i * width + j] = a[start + i] === b[start + j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
      }
    }
    for (let i = 0, j = 0; i < n && j < m;) {
      if (a[start + i] === b[start + j]) { pairs.push([start + i, start + j]); i++; j++; }
      else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) i++;
      else j++;
    }
  }
  for (let offset = 0; offset < a.length - endA; offset++) pairs.push([endA + offset, endB + offset]);
  return pairs;
};

// Union-find over gap keys, so lines between the same unchanged neighbours form one group.
class Groups {
  private readonly parent = new Map<string, string>();
  find(key: string): string {
    let root = key;
    for (let up = this.parent.get(root); up !== undefined && up !== root; up = this.parent.get(root)) root = up;
    if (!this.parent.has(root)) this.parent.set(root, root);
    for (let node = key; node !== root;) { const next = this.parent.get(node) ?? root; this.parent.set(node, root); node = next; }
    return root;
  }
  union(a: string, b: string): void {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }
}

// Monotonic pairing inside one gap maximising total similarity; pairs below the threshold are not edits.
const pairBySimilarity = (olds: readonly Shape[], news: readonly Shape[]): Array<[number, number]> => {
  const p = olds.length, q = news.length, width = q + 1;
  const score = new Float64Array((p + 1) * width);
  const sim = new Float64Array(p * q);
  for (let i = 0; i < p; i++) for (let j = 0; j < q; j++) sim[i * q + j] = similarity(olds[i], news[j]);
  for (let i = p - 1; i >= 0; i--) {
    for (let j = q - 1; j >= 0; j--) {
      const s = sim[i * q + j];
      const paired = s >= NOTE_MATCHING.editSimilarity ? s + score[(i + 1) * width + j + 1] : -1;
      score[i * width + j] = Math.max(paired, score[(i + 1) * width + j], score[i * width + j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  for (let i = 0, j = 0; i < p && j < q;) {
    const s = sim[i * q + j];
    const skipOld = score[(i + 1) * width + j], skipNew = score[i * width + j + 1];
    if (s >= NOTE_MATCHING.editSimilarity && s + score[(i + 1) * width + j + 1] >= Math.max(skipOld, skipNew) - 1e-9) {
      pairs.push([i, j]); i++; j++;
    } else if (skipNew >= skipOld) j++;
    else i++;
  }
  return pairs;
};

// Pairs the unmatched lines of one gap: similar lines first (in order), then whatever is left
// between those pairs is an in-place edit when old and new counts are equal there.
const pairGap = (olds: readonly Shape[], news: readonly Shape[]): Array<[number, number]> => {
  if (olds.length * news.length > NOTE_MATCHING.maxGapPairs) {
    return olds.length === news.length ? olds.map((_, index): [number, number] => [index, index]) : [];
  }
  const pairs: Array<[number, number]> = [];
  let lastOld = -1, lastNew = -1;
  for (const [oi, nj] of [...pairBySimilarity(olds, news), [olds.length, news.length] as [number, number]]) {
    const gapOld = oi - lastOld - 1;
    if (gapOld > 0 && gapOld === nj - lastNew - 1) for (let step = 1; step <= gapOld; step++) pairs.push([lastOld + step, lastNew + step]);
    if (oi < olds.length) pairs.push([oi, nj]);
    lastOld = oi; lastNew = nj;
  }
  return pairs;
};

/**
 * Decides which old line each new line continues.
 * 1. Identical lines in order (LCS) keep their identity; identical lines that moved keep it too.
 * 2. The remaining lines are grouped by the unchanged lines around them (the "gap"). Inside a gap,
 *    similar lines are paired in order (a typo fix next to a pasted block keeps its timestamp), and
 *    where old and new counts are equal between those pairs, lines are in-place edits by position.
 */
export const matchNoteLines = (oldLines: readonly string[], newLines: readonly string[]): NoteLineMatch => {
  const ids = new Map<string, number>();
  const idOf = (line: string): number => { let id = ids.get(line); if (id === undefined) { id = ids.size; ids.set(line, id); } return id; };
  const a = oldLines.map(idOf), b = newLines.map(idOf);
  const oldToNew = new Array<number>(a.length).fill(-1);
  const oldIndex = new Array<number>(b.length).fill(-1);
  const kind = new Array<NoteLineMatchKind>(b.length).fill("new");
  for (const [i, j] of lcsPairs(a, b)) { oldToNew[i] = j; oldIndex[j] = i; kind[j] = "same"; }

  const pool = new Map<number, number[]>();
  a.forEach((id, i) => { if (oldToNew[i] < 0) { const queue = pool.get(id) || []; queue.push(i); pool.set(id, queue); } });
  b.forEach((id, j) => {
    if (oldIndex[j] >= 0) return;
    const i = pool.get(id)?.shift();
    if (i !== undefined) { oldToNew[i] = j; oldIndex[j] = i; kind[j] = "moved"; }
  });

  // Gap keys: the nearest matched old line before ("p") and after ("n"), in old-line numbering.
  const prevOld = new Array<number>(a.length), nextOld = new Array<number>(a.length);
  for (let i = 0, last = -1; i < a.length; i++) { prevOld[i] = last; if (oldToNew[i] >= 0) last = i; }
  for (let i = a.length - 1, last = a.length; i >= 0; i--) { nextOld[i] = last; if (oldToNew[i] >= 0) last = i; }
  const prevNew = new Array<number>(b.length), nextNew = new Array<number>(b.length);
  for (let j = 0, last = -1; j < b.length; j++) { prevNew[j] = last; if (oldIndex[j] >= 0) last = oldIndex[j]; }
  for (let j = b.length - 1, last = a.length; j >= 0; j--) { nextNew[j] = last; if (oldIndex[j] >= 0) last = oldIndex[j]; }

  const groups = new Groups();
  for (let i = 0; i < a.length; i++) if (oldToNew[i] < 0) groups.union(`p${prevOld[i]}`, `n${nextOld[i]}`);
  for (let j = 0; j < b.length; j++) if (oldIndex[j] < 0) groups.union(`p${prevNew[j]}`, `n${nextNew[j]}`);
  const members = new Map<string, { olds: number[]; news: number[] }>();
  const member = (key: string) => { const root = groups.find(key); let group = members.get(root); if (!group) { group = { olds: [], news: [] }; members.set(root, group); } return group; };
  for (let i = 0; i < a.length; i++) if (oldToNew[i] < 0) member(`p${prevOld[i]}`).olds.push(i);
  for (let j = 0; j < b.length; j++) if (oldIndex[j] < 0) member(`p${prevNew[j]}`).news.push(j);

  for (const { olds, news } of members.values()) {
    if (!olds.length || !news.length) continue;
    const pairs = pairGap(olds.map((i) => shape(oldLines[i])), news.map((j) => shape(newLines[j])));
    for (const [oi, nj] of pairs) { oldIndex[news[nj]] = olds[oi]; kind[news[nj]] = "edited"; }
  }
  return { oldIndex, kind };
};

/**
 * Seconds from the media start to `at`, rounded to 0.1 s and never negative; null without a
 * media start, when `at` is long after the capture stopped, or absurdly far from the start.
 */
export const mediaOffsetSeconds = (at: Date, mediaStartedAt?: string, mediaEndedAt?: string): number | null => {
  if (!mediaStartedAt) return null;
  const start = Date.parse(mediaStartedAt);
  let time = at.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(time)) return null;
  if (mediaEndedAt) {
    const end = Date.parse(mediaEndedAt);
    if (Number.isFinite(end) && end >= start) {
      if (time > end + NOTE_LIMITS.afterEndGraceSeconds * 1000) return null;
      time = Math.min(time, end);
    }
  }
  const seconds = Math.max(0, (time - start) / 1000);
  return seconds > NOTE_LIMITS.maxOffsetSeconds ? null : Math.round(seconds * 10) / 10;
};

export type NoteReconcileContext = { now: Date; mediaStartedAt?: string; mediaEndedAt?: string; seq: number };

/**
 * Builds the entries for a new version of the notepad. Unchanged, moved and edited lines keep
 * their id, createdAt and offset; new lines get the next id, createdAt = now and the media offset.
 */
export const reconcileNoteEntries = (
  previous: readonly NoteEntry[],
  lines: readonly string[],
  context: NoteReconcileContext
): { entries: NoteEntry[]; seq: number } => {
  const { oldIndex } = matchNoteLines(previous.map((entry) => entry.text), lines);
  const createdAt = context.now.toISOString();
  const offsetSeconds = mediaOffsetSeconds(context.now, context.mediaStartedAt, context.mediaEndedAt);
  let seq = context.seq;
  const entries = lines.map((text, index): NoteEntry => {
    const old = oldIndex[index] >= 0 ? previous[oldIndex[index]] : undefined;
    if (old) return { id: old.id, createdAt: old.createdAt, offsetSeconds: old.offsetSeconds, text };
    seq += 1;
    if (seq > NOTE_LIMITS.maxSeq) throw new Error(NOTES_ERRORS.idsExhausted);
    return { id: noteEntryId(seq), createdAt, offsetSeconds, text };
  });
  return { entries, seq };
};

/** Offsets again from each entry's createdAt after the media reference changed; untimed entries stay untimed. */
export const rebaseNoteOffsets = (entries: readonly NoteEntry[], mediaStartedAt?: string, mediaEndedAt?: string): NoteEntry[] =>
  entries.map((entry) => entry.offsetSeconds === null ? { ...entry }
    : { ...entry, offsetSeconds: mediaOffsetSeconds(new Date(entry.createdAt), mediaStartedAt, mediaEndedAt) });
