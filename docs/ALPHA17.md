# FalaTrace 0.2.0-alpha.17

Experimental Linux source release that adds KOrganizer as a calendar, runs the Antigravity CLI behind the Gemini choice, and fixes four alpha.16 defects. Everything else is alpha.15 and alpha.16, described in [ALPHA15.md](ALPHA15.md) and [ALPHA16.md](ALPHA16.md).

## Changes

**KOrganizer calendar.** On KDE there is no GNOME Shell calendar, so recordings got no meeting title and reminders had no calendar unless Google Calendar was connected. `calendar.kde` (off by default; **Agenda e lembretes** and **Calendário** in Settings) reads KOrganizer's events from Akonadi's SQLite database (`akonadiserverrc`, `akonadi.db`), opened read-only, and from the payloads Akonadi keeps in `file_db_data`. Only the calendars checked in KOrganizer (`korganizerrc`, `GlobalCollectionSelection`) are read. A small iCalendar reader (`src/calendar/ical.ts`) expands recurring events in their own time zone: DAILY, WEEKLY, MONTHLY and YEARLY rules with INTERVAL, COUNT, UNTIL, BYDAY with ordinals, BYMONTHDAY, BYMONTH, BYSETPOS and WKST, plus EXDATE and occurrences moved or cancelled through RECURRENCE-ID. All-day entries, cancelled events and invitations the calendar's account declined are left out. The new `kde-calendar` source names recordings (after Google, before GNOME), feeds reminders and pre-meeting briefs, and is accepted wherever meeting sources are validated. Event and series ids are hashed with the installation salt like the other calendars.

**The Gemini choice runs agy.** Google replaced the Gemini CLI with the Antigravity CLI (`agy`) for personal accounts, so the Gemini choice showed "not installed" on machines with agy. The subscription CLI choice `gemini` now runs `agy --input-format stream-json --output-format stream-json --sandbox --disable-slash-commands -p=` whenever agy is installed, and the legacy `gemini` only where it is not. The question goes on standard input as one `{"event":"user"}` line, never in the command line, and the answer is read from the final `result` event; a sign-in problem is told by that event, since agy has no status command. agy cannot switch its own tools off and follows the user's `toolPermission`, so `cli:gemini` still answers only once accepted in `assistant.agentToolsAccepted`. agy keeps the conversation in its own history. `AGY_` settings reach the child.

**Installed agents told apart.** Settings › Perguntar e receitas showed installed tools as "not installed" or "not signed in". Claude Agent and Codex over ACP now say when the `claude` or `codex` CLI is installed and only the `claude-agent-acp` or `codex-acp` adapter is missing. Gemini over ACP says that agy answers through the command line only (agy has no ACP mode). A CLI without a status command (OpenCode, agy) shows as found instead of "not signed in".

**Sign in with ChatGPT.** OpenAI's documentation for Sign in with ChatGPT requires `resource=https://api.openai.com/v1` on the authorization code exchange and on every refresh, as on the authorization request. FalaTrace left it out, so the sign-in ended with "O ChatGPT não confirmou o login". Both token requests now carry it, and the fake auth server in the tests refuses a token request without it.

**Proton Drive backup.** `runCommand` kept only the last 100,000 characters of a command's output. The `proton-drive` listing of a month with about a hundred recordings is larger than that, so its head was cut and every archive run failed with "Proton Drive returned invalid JSON for list". `runCommand` can now read stdout whole up to a limit, decoded once so a character split between chunks stays intact, and fails clearly past it; `proton-drive` uses 64 MB. Error messages keep the previous 100,000-character bound.

**Known voices on FFmpeg 8.** On FFmpeg 8.0, `aselect` lets every frame through whatever its expression, even `aselect=0`, so each speaker's audio became the whole track. Each segment is now cut with `atrim`, exact to the sample, and a speaker's segments are joined with `concat`. The two known-voice tests that failed on alpha.16 with FFmpeg 8.0.1 pass.

## Verification

The offline suite ran locally with 2,603 passing tests across 247 files and none failing, on FFmpeg 8.0.1. Type, desktop type, Biome lint (0 errors) and the CLI build pass. The new tests cover each change: the iCalendar reader against the recurrence patterns of a real KOrganizer calendar (weekdays, first Thursday, last Friday every two months, COUNT with EXDATE across a DST change, moved occurrences), the Akonadi reader against a database with the same schema (selection, external payloads, exceptions, declines, other backends refused), stdin-only agy runs against a fake agy, the ChatGPT token requests, whole `proton-drive` output, and sample-exact speaker cuts.

On the release machine (KDE, Akonadi schema 42, Qt 6.10.2): the KOrganizer reader returned the events of two real days in about 0.2 s, also under the read-only home of the FalaTrace services; detection reported `gemini` as `agy`, Claude and Codex with only the ACP adapter missing and OpenCode as found; and one question through the Gemini choice was answered by the real agy 1.4.8.

## Limits

Akonadi on MySQL or PostgreSQL is not read. Recurrence rules with BYHOUR, BYMINUTE, BYSECOND, BYWEEKNO or BYYEARDAY, or a yearly BYDAY without BYMONTH, keep only their first occurrence. A time zone this computer does not know is read as local time. agy runs with its own tools available (its terminal sandboxed) and with the user's permission setting, and it keeps conversations in its history. The ChatGPT fix follows OpenAI's documentation and the fake server; a real sign-in was not completed before the release. Everything listed in [ALPHA15.md](ALPHA15.md#limits) still applies.

## Installation and rollback

Same as alpha.16: update only when no capture or processing is active, and reconnect existing MCP sessions to use the new executable. Configurations, data and services from alpha.16 are unchanged; `calendar.kde` defaults to off. Alpha.16 remains available for rollback. This document describes the release, not an installed-state receipt.
