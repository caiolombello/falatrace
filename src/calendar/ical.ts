// A small iCalendar (RFC 5545) reader for the events a desktop calendar keeps: the VEVENTs of
// one payload, their times in their own time zone, and the occurrences of a recurring event
// inside a window. Only what meetings use is supported: DAILY/WEEKLY/MONTHLY/YEARLY rules with
// INTERVAL, COUNT, UNTIL, BYDAY (with ordinals), BYMONTHDAY, BYMONTH, BYSETPOS and WKST, plus
// EXDATE and moved or cancelled occurrences (RECURRENCE-ID). A rule using anything else keeps
// only its first occurrence.

export type ICalProperty = { name: string; params: Record<string, string>; value: string };

/** A DATE or DATE-TIME as written: wall-clock fields and how to read them. */
export type ICalTime = {
  year: number; month: number; day: number; hour: number; minute: number; second: number;
  /** "utc": ends in Z; "zoned": has a TZID this machine knows; "floating": local time; "date": a whole day. */
  kind: "utc" | "zoned" | "floating" | "date";
  zone?: string;
};

export type ICalAttendee = { name?: string; email?: string; partstat?: string };

export type ICalEvent = {
  uid: string;
  summary: string;
  start: ICalTime;
  /** Milliseconds; 0 when the event gives neither DTEND nor DURATION. */
  durationMs: number;
  rrule?: string;
  exdates: ICalTime[];
  rdates: ICalTime[];
  recurrenceId?: ICalTime;
  cancelled: boolean;
  attendees: ICalAttendee[];
  organizerEmail?: string;
};

export const ICAL_LIMITS = { maxEvents: 200, maxProperties: 5_000, maxAttendees: 500, maxPeriods: 50_000, maxValueLength: 64 * 1024 } as const;

// ── Lines and properties ────────────────────────────────────────────────────────

/** Unfolds continuation lines (CRLF or LF followed by a space or tab). */
const unfold = (text: string): string[] => text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n");

const parseLine = (line: string): ICalProperty | undefined => {
  // The value starts at the first ':' outside a quoted parameter value.
  let quoted = false;
  let colon = -1;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === '"') quoted = !quoted;
    else if (char === ":" && !quoted) { colon = index; break; }
  }
  if (colon <= 0) return undefined;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  if (value.length > ICAL_LIMITS.maxValueLength) return undefined;
  const parts: string[] = [];
  let current = "";
  quoted = false;
  for (const char of head) {
    if (char === '"') { quoted = !quoted; continue; }
    if (char === ";" && !quoted) { parts.push(current); current = ""; continue; }
    current += char;
  }
  parts.push(current);
  const name = (parts.shift() ?? "").toUpperCase();
  if (!/^[A-Z0-9-]+$/.test(name)) return undefined;
  const params: Record<string, string> = {};
  for (const part of parts) {
    const equals = part.indexOf("=");
    if (equals > 0) params[part.slice(0, equals).toUpperCase()] = part.slice(equals + 1);
  }
  return { name, params, value };
};

/** TEXT values: \n, \N, \, \; and \\ escapes. */
export const unescapeText = (value: string): string =>
  value.replace(/\\([nN,;\\])/g, (_match, char: string) => (char === "n" || char === "N" ? "\n" : char));

// ── Time zones ──────────────────────────────────────────────────────────────────

const formatters = new Map<string, Intl.DateTimeFormat | null>();

const formatterFor = (zone: string): Intl.DateTimeFormat | null => {
  if (formatters.has(zone)) return formatters.get(zone) ?? null;
  let formatter: Intl.DateTimeFormat | null = null;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric"
    });
  } catch {
    formatter = null;
  }
  formatters.set(zone, formatter);
  return formatter;
};

/**
 * The IANA name behind a TZID: as is, or the last "Area/City" of a prefixed one such as
 * "/freeassociation.sourceforge.net/Tzfile/America/Sao_Paulo". Undefined when unknown here.
 */
export const resolveZone = (tzid: string | undefined): string | undefined => {
  if (!tzid) return undefined;
  const clean = tzid.replace(/^"|"$/g, "").trim();
  if (!clean || clean.length > 200) return undefined;
  if (formatterFor(clean)) return clean;
  const segments = clean.split("/").filter(Boolean);
  for (let take = Math.min(3, segments.length); take >= 1; take--) {
    const candidate = segments.slice(-take).join("/");
    if (formatterFor(candidate)) return candidate;
  }
  return undefined;
};

const zoneOffsetMs = (zone: string, utcMs: number): number => {
  const formatter = formatterFor(zone);
  if (!formatter) return 0;
  const fields: Record<string, number> = {};
  for (const part of formatter.formatToParts(new Date(utcMs))) if (part.type !== "literal") fields[part.type] = Number(part.value);
  const asUtc = Date.UTC(fields.year ?? 1970, (fields.month ?? 1) - 1, fields.day ?? 1, fields.hour ?? 0, fields.minute ?? 0, fields.second ?? 0);
  return asUtc - (utcMs - (((utcMs % 1000) + 1000) % 1000));
};

/** The instant of a wall-clock time in a zone; a time skipped by a DST change moves forward. */
const zonedToUtc = (zone: string, year: number, month: number, day: number, hour: number, minute: number, second: number): number => {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const first = zoneOffsetMs(zone, guess);
  const utc = guess - first;
  const second_ = zoneOffsetMs(zone, utc);
  return second_ === first ? utc : guess - second_;
};

const toMs = (time: ICalTime, fields: Pick<ICalTime, "year" | "month" | "day" | "hour" | "minute" | "second"> = time): number => {
  const { year, month, day, hour, minute, second } = fields;
  if (time.kind === "utc") return Date.UTC(year, month - 1, day, hour, minute, second);
  if (time.kind === "zoned" && time.zone) return zonedToUtc(time.zone, year, month, day, hour, minute, second);
  return new Date(year, month - 1, day, hour, minute, second).getTime();
};

export const icalTimeToMs = (time: ICalTime): number => toMs(time);

// ── Values ──────────────────────────────────────────────────────────────────────

const DATE_TIME = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/;

export const parseICalTime = (value: string, params: Record<string, string> = {}): ICalTime | undefined => {
  const match = DATE_TIME.exec(value.trim());
  if (!match) return undefined;
  const [, y, mo, d, h, mi, s, z] = match;
  const time = { year: Number(y), month: Number(mo), day: Number(d), hour: Number(h ?? 0), minute: Number(mi ?? 0), second: Number(s ?? 0) };
  if (time.month < 1 || time.month > 12 || time.day < 1 || time.day > 31 || time.hour > 23 || time.minute > 59 || time.second > 60) return undefined;
  if (h === undefined || params.VALUE?.toUpperCase() === "DATE") return { ...time, hour: 0, minute: 0, second: 0, kind: "date" };
  if (z) return { ...time, kind: "utc" };
  const zone = resolveZone(params.TZID);
  return zone ? { ...time, kind: "zoned", zone } : { ...time, kind: "floating" };
};

const DURATION = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

export const parseDurationMs = (value: string): number | undefined => {
  const match = DURATION.exec(value.trim());
  if (!match || value.trim() === "P" || value.trim().endsWith("T")) return undefined;
  const [, sign, weeks, days, hours, minutes, seconds] = match;
  const ms = ((Number(weeks ?? 0) * 7 + Number(days ?? 0)) * 86_400 + Number(hours ?? 0) * 3_600 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0)) * 1000;
  return sign === "-" ? -ms : ms;
};

const mailto = (value: string): string | undefined => {
  const address = value.replace(/^mailto:/i, "").trim().toLowerCase();
  return /^[^\s@]{1,128}@[^\s@]{1,253}$/.test(address) ? address : undefined;
};

// ── Events ──────────────────────────────────────────────────────────────────────

/** The VEVENTs of a payload, without their alarms. Invalid events are left out. */
export const parseICalEvents = (text: string): ICalEvent[] => {
  const events: ICalEvent[] = [];
  let properties: ICalProperty[] | undefined;
  let nested = 0;
  let count = 0;
  for (const raw of unfold(text)) {
    if (++count > ICAL_LIMITS.maxProperties * 10) break;
    const line = raw.trimEnd();
    if (!line) continue;
    const upper = line.toUpperCase();
    if (upper === "BEGIN:VEVENT") { properties = []; nested = 0; continue; }
    if (!properties) continue;
    if (upper.startsWith("BEGIN:")) { nested++; continue; }
    if (upper.startsWith("END:")) {
      if (nested > 0) { nested--; continue; }
      if (upper === "END:VEVENT") {
        const event = buildEvent(properties);
        if (event) events.push(event);
        properties = undefined;
        if (events.length >= ICAL_LIMITS.maxEvents) break;
      }
      continue;
    }
    if (nested > 0 || properties.length >= ICAL_LIMITS.maxProperties) continue;
    const property = parseLine(line);
    if (property) properties.push(property);
  }
  return events;
};

const buildEvent = (properties: ICalProperty[]): ICalEvent | undefined => {
  const first = (name: string) => properties.find((property) => property.name === name);
  const uid = first("UID")?.value.trim();
  const dtstart = first("DTSTART");
  const start = dtstart ? parseICalTime(dtstart.value, dtstart.params) : undefined;
  if (!uid || uid.length > 1024 || !start) return undefined;
  const dtend = first("DTEND");
  const end = dtend ? parseICalTime(dtend.value, dtend.params) : undefined;
  const duration = first("DURATION");
  let durationMs = 0;
  if (end) durationMs = toMs(end) - toMs(start);
  else if (duration) durationMs = parseDurationMs(duration.value) ?? 0;
  else if (start.kind === "date") durationMs = 86_400_000;
  const times = (name: string): ICalTime[] => properties.filter((property) => property.name === name)
    .flatMap((property) => property.value.split(",").map((value) => parseICalTime(value, property.params)).filter((time): time is ICalTime => !!time));
  const recurrence = first("RECURRENCE-ID");
  const organizer = first("ORGANIZER");
  return {
    uid,
    summary: unescapeText(first("SUMMARY")?.value ?? ""),
    start,
    durationMs: Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0,
    ...(first("RRULE") ? { rrule: first("RRULE")?.value } : {}),
    exdates: times("EXDATE"),
    rdates: times("RDATE"),
    ...(recurrence ? { recurrenceId: parseICalTime(recurrence.value, recurrence.params) } : {}),
    cancelled: first("STATUS")?.value.trim().toUpperCase() === "CANCELLED",
    attendees: properties.filter((property) => property.name === "ATTENDEE").slice(0, ICAL_LIMITS.maxAttendees).map((property) => ({
      ...(property.params.CN ? { name: unescapeText(property.params.CN) } : {}),
      ...(mailto(property.value) ? { email: mailto(property.value) } : {}),
      ...(property.params.PARTSTAT ? { partstat: property.params.PARTSTAT.toUpperCase() } : {})
    })),
    ...(organizer && mailto(organizer.value) ? { organizerEmail: mailto(organizer.value) } : {})
  };
};

// ── Recurrence ──────────────────────────────────────────────────────────────────

const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;
const DAY_MS = 86_400_000;

/** Days since 1970-01-01 for a calendar date, and back. */
const dayNumber = (year: number, month: number, day: number): number => Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
const fromDayNumber = (days: number): { year: number; month: number; day: number } => {
  const date = new Date(days * DAY_MS);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
};
/** 0 = Sunday. */
const weekday = (days: number): number => (((days + 4) % 7) + 7) % 7;
const daysInMonth = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate();

type Rule = {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  count?: number;
  until?: ICalTime;
  byDay: Array<{ ordinal?: number; weekday: number }>;
  byMonthDay: number[];
  byMonth: number[];
  bySetPos: number[];
  weekStart: number;
};

const SUPPORTED_PARTS = new Set(["FREQ", "INTERVAL", "COUNT", "UNTIL", "BYDAY", "BYMONTHDAY", "BYMONTH", "BYSETPOS", "WKST"]);

const integers = (value: string | undefined, min: number, max: number): number[] | undefined => {
  if (value === undefined) return [];
  const list = value.split(",").map((item) => Number(item));
  return list.every((item) => Number.isInteger(item) && Math.abs(item) >= min && Math.abs(item) <= max) ? list : undefined;
};

export const parseRRule = (value: string, params: Record<string, string> = {}): Rule | undefined => {
  const parts: Record<string, string> = {};
  for (const part of value.split(";")) {
    const equals = part.indexOf("=");
    if (equals <= 0) continue;
    parts[part.slice(0, equals).toUpperCase()] = part.slice(equals + 1).toUpperCase();
  }
  if (Object.keys(parts).some((key) => !SUPPORTED_PARTS.has(key))) return undefined;
  const freq = parts.FREQ;
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY" && freq !== "YEARLY") return undefined;
  const interval = parts.INTERVAL === undefined ? 1 : Number(parts.INTERVAL);
  const count = parts.COUNT === undefined ? undefined : Number(parts.COUNT);
  if (!Number.isInteger(interval) || interval < 1 || interval > 1000) return undefined;
  if (count !== undefined && (!Number.isInteger(count) || count < 1)) return undefined;
  const until = parts.UNTIL === undefined ? undefined : parseICalTime(parts.UNTIL, params);
  if (parts.UNTIL !== undefined && !until) return undefined;
  const byDay: Rule["byDay"] = [];
  for (const item of parts.BYDAY ? parts.BYDAY.split(",") : []) {
    const match = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(item.trim());
    if (!match) return undefined;
    const ordinal = match[1] === undefined ? undefined : Number(match[1]);
    if (ordinal !== undefined && (ordinal === 0 || Math.abs(ordinal) > 53)) return undefined;
    byDay.push({ ...(ordinal !== undefined ? { ordinal } : {}), weekday: WEEKDAYS.indexOf(match[2] as (typeof WEEKDAYS)[number]) });
  }
  const byMonthDay = integers(parts.BYMONTHDAY, 1, 31);
  const byMonth = integers(parts.BYMONTH, 1, 12);
  const bySetPos = integers(parts.BYSETPOS, 1, 366);
  if (!byMonthDay || !byMonth || !bySetPos || byMonth.some((month) => month < 1)) return undefined;
  const weekStart = parts.WKST ? WEEKDAYS.indexOf(parts.WKST as (typeof WEEKDAYS)[number]) : 1;
  if (weekStart < 0) return undefined;
  // Ordinals only make sense within a month or a year; a yearly BYDAY without BYMONTH is not supported.
  if (byDay.some((day) => day.ordinal !== undefined) && (freq === "DAILY" || freq === "WEEKLY")) return undefined;
  if (freq === "YEARLY" && byDay.length && !byMonth.length) return undefined;
  return { freq, interval, ...(count !== undefined ? { count } : {}), ...(until ? { until } : {}), byDay, byMonthDay, byMonth, bySetPos, weekStart };
};

/** The days of a month that match BYDAY / BYMONTHDAY (or the start's day), as day numbers. */
const monthDays = (rule: Rule, year: number, month: number, startDay: number): number[] => {
  const length = daysInMonth(year, month);
  const first = dayNumber(year, month, 1);
  const byMonthDay = rule.byMonthDay.map((day) => (day > 0 ? day : length + day + 1)).filter((day) => day >= 1 && day <= length);
  let byDay: number[] | undefined;
  if (rule.byDay.length) {
    byDay = [];
    for (const { ordinal, weekday: wanted } of rule.byDay) {
      const matching: number[] = [];
      for (let day = 1; day <= length; day++) if (weekday(first + day - 1) === wanted) matching.push(day);
      if (ordinal === undefined) byDay.push(...matching);
      else {
        const pick = ordinal > 0 ? matching[ordinal - 1] : matching[matching.length + ordinal];
        if (pick !== undefined) byDay.push(pick);
      }
    }
  }
  let days: number[];
  if (byDay && rule.byMonthDay.length) days = byDay.filter((day) => byMonthDay.includes(day));
  else if (byDay) days = byDay;
  else if (rule.byMonthDay.length) days = byMonthDay;
  else days = startDay <= length ? [startDay] : [];
  return [...new Set(days)].sort((a, b) => a - b).map((day) => first + day - 1);
};

const applySetPos = (rule: Rule, days: number[]): number[] => {
  if (!rule.bySetPos.length) return days;
  const sorted = [...days].sort((a, b) => a - b);
  return [...new Set(rule.bySetPos.map((position) => (position > 0 ? sorted[position - 1] : sorted[sorted.length + position])).filter((day): day is number => day !== undefined))]
    .sort((a, b) => a - b);
};

/** The first day of the n-th period after the start. */
const periodFirstDay = (rule: Rule, start: ICalTime, period: number): number => {
  const startDays = dayNumber(start.year, start.month, start.day);
  switch (rule.freq) {
    case "DAILY": return startDays + period * rule.interval;
    case "WEEKLY": return startDays - ((weekday(startDays) - rule.weekStart + 7) % 7) + period * rule.interval * 7;
    case "MONTHLY": {
      const index = start.year * 12 + (start.month - 1) + period * rule.interval;
      return dayNumber(Math.floor(index / 12), (index % 12) + 1, 1);
    }
    case "YEARLY": return dayNumber(start.year + period * rule.interval, 1, 1);
  }
};

/** The candidate days of the n-th period after the start (each list sorted). */
const periodDays = (rule: Rule, start: ICalTime, period: number): number[] => {
  const startDays = dayNumber(start.year, start.month, start.day);
  const inMonths = (days: number[]) => (rule.byMonth.length ? days.filter((days_) => rule.byMonth.includes(fromDayNumber(days_).month)) : days);
  switch (rule.freq) {
    case "DAILY": {
      const day = startDays + period * rule.interval;
      const date = fromDayNumber(day);
      if (rule.byMonthDay.length && !rule.byMonthDay.some((value) => (value > 0 ? value : daysInMonth(date.year, date.month) + value + 1) === date.day)) return [];
      if (rule.byDay.length && !rule.byDay.some((entry) => entry.weekday === weekday(day))) return [];
      return inMonths([day]);
    }
    case "WEEKLY": {
      const weekBegin = startDays - ((weekday(startDays) - rule.weekStart + 7) % 7) + period * rule.interval * 7;
      const wanted = rule.byDay.length ? rule.byDay.map((entry) => entry.weekday) : [weekday(startDays)];
      return applySetPos(rule, inMonths([...new Set(wanted.map((day) => weekBegin + ((day - rule.weekStart + 7) % 7)))].sort((a, b) => a - b)));
    }
    case "MONTHLY": {
      const index = start.year * 12 + (start.month - 1) + period * rule.interval;
      const year = Math.floor(index / 12);
      const month = (index % 12) + 1;
      if (rule.byMonth.length && !rule.byMonth.includes(month)) return [];
      return applySetPos(rule, monthDays(rule, year, month, start.day));
    }
    case "YEARLY": {
      const year = start.year + period * rule.interval;
      const months = rule.byMonth.length ? rule.byMonth : [start.month];
      return applySetPos(rule, months.flatMap((month) => monthDays(rule, year, month, start.day)).sort((a, b) => a - b));
    }
  }
};

export type Occurrence = { startMs: number; endMs: number; /** The occurrence's original start, its RECURRENCE-ID. */ originalStartMs: number };

/**
 * Occurrences of an event that overlap [fromMs, toMs). A rule FalaTrace cannot read keeps only
 * the event's own first occurrence. EXDATEs are removed; `replaced` holds the original starts of
 * occurrences that a RECURRENCE-ID event moved or cancelled.
 */
export const expandEvent = (event: ICalEvent, fromMs: number, toMs_: number, replaced: ReadonlySet<number> = new Set()): Occurrence[] => {
  const startMs = toMs(event.start);
  const make = (ms: number): Occurrence => ({ startMs: ms, endMs: ms + event.durationMs, originalStartMs: ms });
  const overlaps = (occurrence: Occurrence) => occurrence.startMs < toMs_ && occurrence.endMs > fromMs;
  const rule = event.rrule ? parseRRule(event.rrule, {}) : undefined;
  const excluded = new Set(event.exdates.filter((time) => time.kind !== "date").map((time) => toMs(time)));
  const excludedDays = new Set(event.exdates.filter((time) => time.kind === "date").map((time) => dayNumber(time.year, time.month, time.day)));
  const keep = (ms: number, day: number) => !excluded.has(ms) && !excludedDays.has(day) && !replaced.has(ms);
  const startDay = dayNumber(event.start.year, event.start.month, event.start.day);
  const result: Occurrence[] = [];
  const extra = event.rdates.map((time) => toMs(time.kind === "date" ? { ...time, hour: event.start.hour, minute: event.start.minute, second: event.start.second, kind: event.start.kind, zone: event.start.zone } : time));
  if (!rule) {
    for (const ms of [startMs, ...(event.rrule ? [] : extra)]) {
      const occurrence = make(ms);
      if (keep(ms, startDay) && overlaps(occurrence)) result.push(occurrence);
    }
    return result.sort((a, b) => a.startMs - b.startMs);
  }
  // The rule runs on the start's wall clock: a 09:00 meeting stays at 09:00 across DST changes.
  const untilMs = rule.until ? (rule.until.kind === "date" ? toMs({ ...rule.until, hour: 23, minute: 59, second: 59, kind: event.start.kind === "utc" ? "utc" : event.start.kind, zone: event.start.zone }) : toMs(rule.until)) : undefined;
  let generated = 0;
  let started = false;
  // A day of slack on each side covers any time zone offset.
  const firstDay = Math.floor(fromMs / DAY_MS) - 1;
  const lastDay = Math.floor(toMs_ / DAY_MS) + 1;
  const untilDay = untilMs === undefined ? undefined : Math.floor(untilMs / DAY_MS) + 1;
  for (let period = 0; period < ICAL_LIMITS.maxPeriods; period++) {
    if (periodFirstDay(rule, event.start, period) > lastDay) break;
    const days = periodDays(rule, event.start, period);
    // Without COUNT, a period wholly before the window changes nothing: skip its time zone math.
    const lastOfPeriod = days[days.length - 1];
    if (rule.count === undefined && startDay < firstDay && lastOfPeriod !== undefined && lastOfPeriod < firstDay) {
      started = true;
      if (untilDay !== undefined && (days[0] as number) > untilDay) break;
      continue;
    }
    let past = false;
    for (const day of days) {
      if (day < startDay) continue;
      const date = fromDayNumber(day);
      const ms = toMs(event.start, { ...date, hour: event.start.hour, minute: event.start.minute, second: event.start.second });
      if (untilMs !== undefined && ms > untilMs) { past = true; break; }
      if (!started && ms !== startMs) {
        // DTSTART is always the first occurrence, even when the rule would not produce it.
        started = true;
        generated++;
        if (keep(startMs, startDay) && overlaps(make(startMs))) result.push(make(startMs));
        if (rule.count !== undefined && generated >= rule.count) { past = true; break; }
      }
      started = true;
      generated++;
      if (keep(ms, day) && overlaps(make(ms))) result.push(make(ms));
      if (rule.count !== undefined && generated >= rule.count) { past = true; break; }
      if (ms >= toMs_) { past = true; break; }
    }
    if (past) break;
  }
  for (const ms of extra) {
    const occurrence = make(ms);
    if (!excluded.has(ms) && !replaced.has(ms) && overlaps(occurrence) && !result.some((item) => item.startMs === ms)) result.push(occurrence);
  }
  return result.sort((a, b) => a.startMs - b.startMs);
};
