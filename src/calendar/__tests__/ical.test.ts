import { expect, test } from "bun:test";
import { expandEvent, icalTimeToMs, parseICalEvents, parseICalTime, parseRRule, resolveZone } from "../ical";

const vevent = (lines: string[]): string =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VTIMEZONE", "TZID:America/Sao_Paulo", "BEGIN:STANDARD", "RRULE:FREQ=YEARLY;BYDAY=3SU;BYMONTH=10", "END:STANDARD", "END:VTIMEZONE",
    "BEGIN:VEVENT", ...lines, "END:VEVENT", "END:VCALENDAR"].join("\r\n");

const iso = (ms: number) => new Date(ms).toISOString();
const window = (from: string, to: string) => [Date.parse(from), Date.parse(to)] as const;
const starts = (text: string, from: string, to: string, replaced?: Set<number>) => {
  const [event] = parseICalEvents(text);
  const [a, b] = window(from, to);
  return expandEvent(event!, a, b, replaced).map((occurrence) => iso(occurrence.startMs));
};

test("properties: folded lines, escaped text, quoted parameters, alarms ignored", () => {
  const [event] = parseICalEvents(vevent([
    "UID:abc@google.com", "SUMMARY:Planejamento\\, financeiro\\; Q4 \\n e", " mais", "DTSTART;TZID=America/Sao_Paulo:20261027T193200",
    "DTEND;TZID=America/Sao_Paulo:20261027T200700",
    'ATTENDEE;CN="Silva, Ana";PARTSTAT=ACCEPTED:mailto:Ana@Example.com', "ATTENDEE;CN=Caio;PARTSTAT=DECLINED:mailto:caio@ops.team",
    "ORGANIZER:mailto:boss@ops.team", "BEGIN:VALARM", "TRIGGER:-PT10M", "SUMMARY:alarme", "END:VALARM", "STATUS:CONFIRMED"
  ]));
  expect(event!.summary).toBe("Planejamento, financeiro; Q4 \n emais");
  expect(event!.start).toEqual({ year: 2026, month: 10, day: 27, hour: 19, minute: 32, second: 0, kind: "zoned", zone: "America/Sao_Paulo" });
  expect(event!.durationMs).toBe(35 * 60_000);
  expect(iso(icalTimeToMs(event!.start))).toBe("2026-10-27T22:32:00.000Z");
  expect(event!.attendees).toEqual([{ name: "Silva, Ana", email: "ana@example.com", partstat: "ACCEPTED" }, { name: "Caio", email: "caio@ops.team", partstat: "DECLINED" }]);
  expect(event!.organizerEmail).toBe("boss@ops.team");
  expect(event!.cancelled).toBe(false);
});

test("times: UTC, all-day, floating, DURATION and prefixed time zone names", () => {
  expect(parseICalTime("20261027T170000Z")).toMatchObject({ kind: "utc", hour: 17 });
  expect(parseICalTime("20261027", { VALUE: "DATE" })).toMatchObject({ kind: "date", day: 27 });
  expect(parseICalTime("20261027T090000")).toMatchObject({ kind: "floating" });
  expect(parseICalTime("20261327T090000")).toBeUndefined();
  expect(resolveZone("/freeassociation.sourceforge.net/Tzfile/America/Sao_Paulo")).toBe("America/Sao_Paulo");
  expect(resolveZone("Not/A_Zone")).toBeUndefined();
  const [event] = parseICalEvents(vevent(["UID:d", "SUMMARY:x", "DTSTART:20261027T170000Z", "DURATION:PT1H30M"]));
  expect(event!.durationMs).toBe(90 * 60_000);
});

test("weekly on weekdays until a date, in São Paulo time", () => {
  const text = vevent(["UID:daily", "SUMMARY:Daily", "DTSTART;TZID=America/Sao_Paulo:20260901T093000", "DTEND;TZID=America/Sao_Paulo:20260901T094500",
    "RRULE:FREQ=WEEKLY;UNTIL=20261030T235959Z;BYDAY=MO,TU,WE,TH,FR;WKST=SU"]);
  expect(starts(text, "2026-10-23T00:00:00Z", "2026-10-28T00:00:00Z")).toEqual(["2026-10-23T12:30:00.000Z", "2026-10-26T12:30:00.000Z", "2026-10-27T12:30:00.000Z"]);
  // UNTIL ends the series.
  expect(starts(text, "2026-11-02T00:00:00Z", "2026-11-03T00:00:00Z")).toEqual([]);
});

test("monthly on the first Thursday and every two months on the last Friday", () => {
  const first = vevent(["UID:m1", "SUMMARY:x", "DTSTART;TZID=America/Sao_Paulo:20260402T140000", "DTEND;TZID=America/Sao_Paulo:20260402T150000", "RRULE:FREQ=MONTHLY;BYDAY=1TH"]);
  expect(starts(first, "2026-10-01T00:00:00Z", "2026-11-30T00:00:00Z")).toEqual(["2026-10-01T17:00:00.000Z", "2026-11-05T17:00:00.000Z"]);
  const last = vevent(["UID:m2", "SUMMARY:x", "DTSTART;TZID=America/Sao_Paulo:20260130T100000", "DTEND;TZID=America/Sao_Paulo:20260130T110000", "RRULE:FREQ=MONTHLY;INTERVAL=2;BYDAY=-1FR"]);
  // Jan, Mar, May, Jul, Sep, Nov: the last Friday of September and of November 2026.
  expect(starts(last, "2026-08-01T00:00:00Z", "2026-12-31T00:00:00Z")).toEqual(["2026-09-25T13:00:00.000Z", "2026-11-27T13:00:00.000Z"]);
});

test("COUNT, EXDATE, moved occurrences and the DST change of New York", () => {
  const text = vevent(["UID:ny", "SUMMARY:x", "DTSTART;TZID=America/New_York:20261026T090000", "DTEND;TZID=America/New_York:20261026T093000",
    "RRULE:FREQ=DAILY;COUNT=10", "EXDATE;TZID=America/New_York:20261028T090000,20261029T090000"]);
  const all = starts(text, "2026-10-20T00:00:00Z", "2026-12-01T00:00:00Z");
  // 10 generated, 2 excluded; 09:00 stays 09:00 after DST ends on Nov 1 (UTC-4 → UTC-5).
  expect(all).toHaveLength(8);
  expect(all[0]).toBe("2026-10-26T13:00:00.000Z");
  expect(all).not.toContain("2026-10-28T13:00:00.000Z");
  expect(all[all.length - 1]).toBe("2026-11-04T14:00:00.000Z");
  // An occurrence moved by a RECURRENCE-ID event is left to that event.
  const moved = starts(text, "2026-10-26T00:00:00Z", "2026-10-27T23:00:00Z", new Set([Date.parse("2026-10-27T13:00:00Z")]));
  expect(moved).toEqual(["2026-10-26T13:00:00.000Z"]);
});

test("yearly by month and day, DTSTART kept first, and unsupported rules keep only the first occurrence", () => {
  const yearly = vevent(["UID:y", "SUMMARY:x", "DTSTART:20241104T150000Z", "DTEND:20241104T160000Z", "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU"]);
  // DTSTART (a Monday) is the first occurrence, then the first Sunday of each November.
  expect(starts(yearly, "2024-01-01T00:00:00Z", "2026-12-31T00:00:00Z")).toEqual(["2024-11-04T15:00:00.000Z", "2025-11-02T15:00:00.000Z", "2026-11-01T15:00:00.000Z"]);
  const hourly = vevent(["UID:h", "SUMMARY:x", "DTSTART:20261027T100000Z", "DTEND:20261027T103000Z", "RRULE:FREQ=DAILY;BYHOUR=10,14"]);
  expect(starts(hourly, "2026-10-27T00:00:00Z", "2026-10-29T00:00:00Z")).toEqual(["2026-10-27T10:00:00.000Z"]);
  expect(parseRRule("FREQ=HOURLY")).toBeUndefined();
  expect(parseRRule("FREQ=WEEKLY;BYDAY=1MO")).toBeUndefined();
});

test("an old weekly series is expanded up to the window only, quickly", () => {
  const text = vevent(["UID:old", "SUMMARY:x", "DTSTART;TZID=America/Sao_Paulo:20000103T080000", "DTEND;TZID=America/Sao_Paulo:20000103T083000", "RRULE:FREQ=WEEKLY;BYDAY=MO"]);
  const began = performance.now();
  expect(starts(text, "2026-10-26T00:00:00Z", "2026-10-27T00:00:00Z")).toEqual(["2026-10-26T11:00:00.000Z"]);
  expect(performance.now() - began).toBeLessThan(500);
});
