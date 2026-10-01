import { describe, expect, test } from "bun:test";
import {
  findGnomeCalendarMeeting,
  parseGnomeCalendarEvents,
  type GnomeCalendarEvent
} from "../gnome";

describe("GNOME Calendar integration", () => {
  test("parses and sanitizes CalendarServer event signals", () => {
    const output = String.raw`/org/gnome/Shell/CalendarServer: org.gnome.Shell.CalendarServer.EventsAddedOrUpdated ([('first', 'Evento anterior', int64 1785261600, int64 1785265200, @a{sv} {}), ('calendar-id\nrecurrence-id', 'Daily\nSRE', 1785265200, 1785266100, {})],)`;
    expect(parseGnomeCalendarEvents(output)).toEqual([
      {
        id: "first",
        title: "Evento anterior",
        startAtMs: 1785261600000,
        endAtMs: 1785265200000,
        recurring: false
      },
      {
        id: "calendar-id\nrecurrence-id",
        title: "Daily SRE",
        startAtMs: 1785265200000,
        endAtMs: 1785266100000,
        recurring: true
      }
    ]);
  });

  test("selects the overlapping Daily instead of an adjacent event", async () => {
    const events: GnomeCalendarEvent[] = [
      {
        id: "previous",
        title: "Atividade anterior",
        startAtMs: Date.parse("2026-07-28T18:00:00.000Z"),
        endAtMs: Date.parse("2026-07-28T19:00:00.000Z"),
        recurring: false
      },
      {
        id: "daily\n20260728T190000Z",
        title: "Daily SRE",
        startAtMs: Date.parse("2026-07-28T19:00:00.000Z"),
        endAtMs: Date.parse("2026-07-28T19:15:00.000Z"),
        recurring: true
      }
    ];
    const result = await findGnomeCalendarMeeting(
      "2026-07-28T18:59:59.000Z",
      "2026-07-28T19:19:30.000Z",
      "zen",
      async () => events
    );
    expect(result?.title).toBe("Daily SRE");
    expect(result?.recurring).toBe(true);
    expect(result?.app).toBe("zen");
    expect(result?.confidence).toBeGreaterThan(0.9);
  });

  test("rejects weak matches such as an all-day event", async () => {
    const result = await findGnomeCalendarMeeting(
      "2026-07-28T19:00:00.000Z",
      "2026-07-28T19:20:00.000Z",
      undefined,
      async () => [
        {
          id: "all-day",
          title: "Dia inteiro",
          startAtMs: Date.parse("2026-07-28T03:00:00.000Z"),
          endAtMs: Date.parse("2026-07-29T03:00:00.000Z"),
          recurring: false
        }
      ]
    );
    expect(result).toBeUndefined();
  });

  test("rejects invalid and oversized call ranges", async () => {
    expect(
      findGnomeCalendarMeeting(
        "invalid",
        "2026-07-28T19:20:00.000Z",
        undefined,
        async () => []
      )
    ).rejects.toThrow("Call time range is invalid");
    expect(
      findGnomeCalendarMeeting(
        "2026-07-28T00:00:00.000Z",
        "2026-07-29T00:00:01.000Z",
        undefined,
        async () => []
      )
    ).rejects.toThrow("Call time range is invalid");
  });
});
