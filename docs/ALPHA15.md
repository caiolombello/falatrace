# FalaTrace 0.2.0-alpha.15

Experimental Linux source release: you type short notes during a meeting, and after it the AI completes them with what was said, in the format of that kind of meeting, every line it adds citing the moment of the recording. You can ask your meetings with citations, follow people, clients and action items, get a reminder with a brief before a calendar meeting, share the notes, and see a live transcript while you record. The Studio was rebuilt around the notes. Speaker name suggestions, known voices and the direct Google Calendar connection, built after alpha.14, ship here too. Recording, transcription, notes and questions run on this computer by default. Questions, shares and manual processing name any destination outside it first and ask for consent; a provider chosen in the settings, for automatic processing or the live transcript, applies to every recording until you change it. Alpha.14 settings, alpha.13 setup and alpha.11 consent, revision and export contracts are unchanged.

## Changes

**Notes during the meeting.** Starting a recording in the Studio opens a notepad; **Notes** next to the recording status opens it for a recording that started on its own. Each line keeps the moment it was typed, measured from the start of the recording, and keeps it when edited in place. It saves 800 ms after typing stops, on Enter, when you leave it and before the recording stops; two windows never overwrite each other. Afterwards the notepad is **My notes** on the meeting page. Notes are private files on this computer. See [notes and templates](NOTES-AND-TEMPLATES.md).

**AI notes that complete yours.** The summary request carries the transcript with segment ids, your notes with the segments around the moment each was typed, and the template. The model keeps every note as your item, completes it with what was said citing segments, marks uncertain items and never attributes its lines to you. FalaTrace checks every note and segment id against what was sent (an unknown one fails the summary) and lists notes the model did not use instead of dropping them. The meeting page tells your lines from the AI's; a citation plays its moment, Shift+click shows it in the transcript.

**Templates and language.** Nine built-in templates (general, 1:1, stand-up, planning, retrospective, sales discovery, incident postmortem, hiring interview, user research) and your own, edited in Settings or as JSON files. A meeting gets your choice, the default, a template matched from the calendar title, transcript keywords or note headings, or the model's pick in the same request. `summary.language` writes in the conversation's language or a fixed one. Regeneration from the reviewed transcript, with another template or language, keeps your notes and runs only with Ollama on this computer.

**Ask your meetings.** Questions about a meeting, a person, a client or the whole library are answered only from excerpts found in a local library index, citing every sentence with markers checked against what was sent. The Studio's Ask panel opens beside the page (Ctrl+J); `/` lists recipes, ten built-in ones and your own.

| Destination | Where the question and excerpts go | Before sending |
| --- | --- | --- |
| Ollama on this computer (default) | Nowhere | Nothing to confirm |
| Ollama cloud model (a `cloud` tag or suffix) | ollama.com, through the local server | Consent (and for summaries, no fast path) |
| API key: OpenAI, OpenRouter, Anthropic (official SDK), Gemini, xAI, Groq, Mistral, DeepSeek, Together, or a custom OpenAI-compatible address | That provider (a custom address on this computer stays local) | Consent |
| ACP agent: Codex, Claude, Gemini CLI, OpenCode, Kiro, Copilot, Cursor, goose, Qwen, Grok or a custom command | The agent's own provider | Consent, and a one-time OK per agent in Settings for agents that can still run tools (all but goose) |
| Subscription CLI: `claude`, `codex`, `gemini`, `opencode` | The tool's provider | Consent, and the same one-time OK for `codex`, `gemini` and `opencode` |
| Sign in with ChatGPT | OpenAI, under your ChatGPT plan | Consent |

Agents and CLIs start in an empty private folder, with a minimal environment that holds no FalaTrace secrets, in their most restrictive mode (read-only, plan or chat), and every tool permission they ask for is refused. Consent covers one destination and one scope, once per conversation in the Studio and with `--yes` in the CLI; a changed custom agent command asks again. Recipes put meeting titles and names in a data block, never in the task. See [assistant](ASSISTANT.md).

**People, clients and actions.** People come from confirmed speaker names, calendar guests and known voices, and can be renamed, given aliases, merged and hidden. Clients come from the timesheet catalog, editable with a backup, plus a client choice per recording. Every action item (summary actions and unchecked note to-dos) has an open, done or dismissed status that survives regeneration. The Studio has a page for each. See [people, clients and actions](PEOPLE-CLIENTS-ACTIONS.md).

**Reminders and a brief.** An optional user service notifies shortly before a Google or GNOME calendar meeting, with **Gravar** or **Pular esta gravação** depending on the recording mode and up to three lines on what earlier meetings left open. Home shows the same choices. A "record" decision covers that meeting's own call only, never a call already going on, and a pause set after it wins. Calendar ids are stored as salted hashes. See [reminders and live transcript](REMINDERS-AND-LIVE.md).

**Live transcript.** Off by default. A separate, low-priority FFmpeg process transcribes the capture in chunks with Whisper.cpp on this computer, or with OpenAI (about US$0.27/h) or Groq (about US$0.04/h). With a provider outside this computer, the setting is consent for every capture's audio; turning it back on during a capture asks again, naming the provider. Lines are pruned 30 days after the capture and deleted with the recording.

**Share.** A meeting's notes as Markdown to the clipboard, an Obsidian vault (never over your edits), a Notion page, a Slack webhook or an AI app, after a preview. Notion, Slack and AI apps need consent each time, bound to the destination the preview showed. AI apps on the web and Claude Desktop get the note through the clipboard, never in an address or a command line. See [sharing](SHARING.md).

**Media retention.** `media.retention` can keep only the audio, or only the transcript, once the transcript is verified, jobs are settled, backups are complete and speaker work is done or `media.graceDays` passed. With the archive on, a recording the archive never registered is kept until `falatrace archive backfill` registers it. **Remove media now…** removes one recording's media after a plan and a confirmation. See [privacy and data](PRIVACY.md#media-retention).

**A redesigned Studio.**

| Page | What it shows |
| --- | --- |
| Sidebar | Home, Actions, People, Clients, and the meetings grouped by day, with search through titles, people, clients and transcripts. |
| Home | The next calendar meetings with their brief and the record or skip choice, the open actions, notes being made, and the first-notes card. |
| Meeting | Its notes (Full or My notes), the template chip, **Generate again…**, **Send** and **Ask**; the transcript, speakers and agent access on tabs; the player in a strip below. |
| Recording | The notepad, with an optional live transcript beside it; **Stop and generate notes**. |
| Ask | A panel beside the page, with the destination and consent shown first, earlier conversations and recipes. |
| Actions, People, Clients | Filters, grouping, ticking with undo, editing, and recipe buttons. |
| Settings | Sixteen sections in three groups, six of them new: notes and summaries, Ask and recipes, calendar and reminders, live transcript, sharing, privacy and retention. Each provider choice says in one line what leaves the computer and what it costs. Template and recipe editors; keys for the new providers, tested with one read-only request. |

A video recording shows **Watch the recording** and opens with the video expanded; an audio-only one shows **Listen to the recording**. Cinema mode puts the notes beside the video, or below it in a narrow window; full screen (F or a double click) keeps the captions and the speaker overlay, and Esc leaves it first. A shortcuts dialog opens with F1. Tooltips show plain text.

**Setup quick start.** **Quick start (recommended)** goes straight to the review with audio only, processing on this computer, the fast path on (a recording is processed as soon as it stops) and automatic recording off. **Download what is missing** starts the Whisper and Ollama downloads early, with their size and an estimate; Finish waits for them or finishes by itself when they end. **Record a 1-minute test** records a short conversation that stops by itself and opens the meeting, and Home says how long the first notes took. A clickable "Notas prontas" notification opens a meeting through a `falatrace://` link.

**Speaker names and Google Calendar.** The microphone track of FalaTrace's own captures suggests the account's name for the speaker heard there (local only); on request, the diarizer's turns can go to the summary model to find names said in the conversation. With `speakers.voices` on, confirmed names teach local voice signatures (never audio) that suggest names in later recordings. With your own Google Cloud OAuth client, a call's title and the invited names come from Google Calendar directly. Applying a suggestion is one human revision. See [human review and export](HUMAN-REVIEW-EXPORT.md#speaker-name-suggestions--alpha15).

**Alpha.14 known issue fixed.** When queueing failed right after a legacy capture (wf-recorder, hybrid, FFmpeg only or GNOME) was stopped, the stop failed and claimed the state was kept for a retry, leaving the recording without a job. The stop now returns the recording with a warning that it was not queued. The warning still says to use "Processar…", which the redesigned Studio calls **Generate notes…** ("Gerar notas…").

**CLI.** New commands: `notes`, `templates`, `ask`, `library`, `assistant`, `recipes`, `people`, `clients`, `actions`, `reminders`, `live`, `share`, `media`, `studio open`, `speakers` and `voices`, plus `google connect`. `falatrace help` is in Portuguese, opens with a one-line pitch and lists commands by task; streamed answers are made terminal-safe.

## Verification

2,583 offline tests, 0 failures across 243 files (32,550 `expect()` calls), up from 931 tests in 129 files at alpha.14. TypeScript (`bun run typecheck`), the desktop type check (`bun run desktop:check`), Biome lint (`bunx biome lint --max-diagnostics=0`: 0 errors) and the CLI build (`bun run build`) passed. A guides test ties the README, the quickstarts and the guides to the code: links and anchors, every cited command and flag, every Studio button a guide names, and the provider, template, recipe and data-location tables.

The real QML ran offscreen in 18 Studio journeys, 205 screens and 955 assertions, through `scripts/studio-qml-runner.py` (a PySide6 port of the native shell, PySide6 6.11.2) against synthetic bridges. Every step waits for the state it needs with a bounded condition, never a fixed delay, and four modes press real keys through the window system.

| Journey | Assertions | Journey | Assertions |
| --- | --- | --- | --- |
| `settings-ux` | 279 | `retention-ux` | 35 |
| `process-ux` | 31 | `notes-ux` | 61 |
| `agent-ux` | 11 | `live-ux` | 37 |
| `desktop-ui` | 16 | `ask-ux` | 97 |
| `local-ux` | 43 | `home-ux` | 42 |
| `scope-ux` | 13 | `entities-ux` | 47 |
| `planner-ux` | 12 | `share-ux` | 42 |
| `heavy-ux` | 5 | `templates-ux` | 98 |
| `speakers-ux` | 36 | `video-ux` | 50 |

What each journey covers is in [UX verification](UX-VERIFICATION.md#notes-ask-and-a-redesigned-studio--alpha15).

Each part was reviewed before it was merged, and the whole change again before tagging. Every defect below was fixed with a test that fails without the fix.

- **Module reviews.** Notes: 4 defects (a flat recordings folder could attach one recording's notes to another, half an emoji could reach the model, two raw errors). Templates: 8 (a calendar match lost to a rounding error, notes starting with `#` silently dropped, limits the prompt did not state, unsafe folder permissions, unbounded reads).
- **Integration reviews**, 57 defects: pipeline 6 (a resumed regeneration lost its template, notes could push a meeting past OpenAI's single request), calls and recording 5 (a reminder's **Gravar** started a capture inside a short-lived helper), media retention 4 (a removed recording's frame analysis sent a billed request with no images), CLI 9 (model output reached the terminal unfiltered while streaming, an empty `notes edit` wiped the notes), Studio bridge 7 (a share went to whatever the settings said at send time, not where the preview said), and the Studio in three parts, 26 (a second action of one meeting always failed, declining the test recording made the next real one stop after a minute, leaving a meeting cancelled its regeneration, summary consent failed open, Ask kept unpolled runs alive, the player decided video from the previous file). The docs review fixed 9 statements (one said agents only read granted recordings; the CLI reads any processed one) and added the guides test; a review of the journey timing fixed 2 more races and a gap in the developer docs.
- **Final review.** Five lenses over the whole change (what leaves the computer, data integrity, lifecycle, security and the Studio) confirmed 28 findings after rejecting two, and rated 15 more as low. All 28 were fixed, with three of the low ones and part of a fourth: Ollama cloud models were treated as local; ACP agents and CLIs kept their own tools and environment; live transcription to a cloud provider started without consent bound to that provider; **Generate notes…** did not say the notes go to the provider; Ask's consent said "NaN reuniões"; a meeting's "record" decision recorded the call already going on and outlived a pause; custom agent arguments were outside the consent key; recipes put titles and names in the task; tooltips rendered rich text, so a calendar title could fetch a remote image; live transcripts were never pruned or deleted; Claude Desktop received the note on a command line; retention could delete media the archive never registered, and a stale regeneration blocked it forever; capture notes became unreachable after 2,000 newer notes files; the capture's end was never stored on its notes; a fast-path job could be stranded by its unit's time limit; planning new notes outlived the Studio's 30-second request limit; a recording at its 32-request limit failed with a generic message; turning notes or live on needed a restart; the template picker opened off-screen and with a stale list; actions needing removed media stayed on; window shortcuts took Space and the arrows from focused controls; Ask's cards fell below the fold. A review of those fixes found 5 more defects (an Ollama cloud model through a custom local API, a notes label, a changelog claim, the arrows after a click on a tab, the focus after **Send** on Ask's consent card), also fixed.

No recording, transcription, provider call, model download or real service change was made to establish these results.

## Limits

- Not exercised: real providers, ACP agents, subscription CLIs and Sign in with ChatGPT accounts; real captures and calls; real Notion, Slack, Obsidian and AI apps; Google and GNOME calendars; notification buttons on a real desktop; model quality (templates, notes, answers, voice matching on Portuguese speech).
- The Studio journeys use the PySide6 port with an inert player: the compiled `recording-studio` binary, MpvQt decoding and playback, screen readers, fractional scaling and high-contrast themes were not exercised. The real-key steps (`video-ux` `keys`, `notes-ux` `tab`, `ask-ux` `long` and `library-consent`) exist only in the PySide6 runner and time out on the native shell; run the journeys with `FALATRACE_STUDIO_RUNNER=pyside` where the native shell is built.
- The agent lockdown settings (session modes, `GOOSE_MODE`, `INITIAL_AGENT_MODE`, `OPENCODE_PERMISSION`, `gemini -e none`) come from vendor documentation and were not checked against the real binaries. Goose is the only ACP agent that runs without the one-time OK, relying on its chat mode. Accepting a custom ACP command covers any custom command line: changing it asks for Ask consent again, not for the OK.
- Deleting a recording (in `falatrace tui`) still keeps its notes, summary choices, action and client states, human revisions and exports. The live transcript of a capture that never became a job stays until the 30-day prune, which can also remove the only text of a recording left unprocessed for 30 days.
- A meeting's "record" decision remembers in memory that it was used: a call monitor restarted during the meeting forgets it, and a call that drops and is rejoined more than 15 seconds later counts as a new call and is not recorded under the decision.
- With the archive on, retention keeps media the archive never registered until `falatrace archive backfill`; the Studio has no backfill action.
- The **Generate notes…** plan and the older onboarding review judge an Ollama model's locality by its name, so a cloud model copied under another name looks local there (Ask and the fast path ask the server). Ollama servers that report no model details are treated as cloud, and with Ollama down a regeneration asks for consent naming the local Ollama; both fail closed.
- Low-severity findings left open: turning the live transcript off and on within its stop grace period reports it running while the worker exits; on closing the Studio, a running question is cancelled after slower shutdown steps, so its provider process can be left behind; client alias edits are not serialized with other catalog edits; a template choice a recording inherits from an earlier one with the same file path cannot be saved from the Studio; the conversation list and the library index cover at most 2,000 conversations and the newest 2,000 jobs; the larger v2 prompt can push a meeting near OpenAI's single-request budget into several parts, which OpenAI summaries refuse without a paid-budget policy; a symbolic link as the `recording-cli` data or state folder makes some new stores refuse to write.
- Studio: dialogs opened from a menu (media removal, person and client edits) do not give the focus back to where they were opened; the header's **Generate notes…** is disabled without a reason when the media is gone; "Parar e gerar notas" names notes even when processing is not automatic (the page then says to generate them later); some things have different names on different screens.
- All alpha.14 limits not listed as fixed remain.

## Installation and rollback

Alpha.14 remains available for rollback. Update only when no capture or processing is active. Existing configurations load unchanged; the new sections take their defaults (notes on, questions through Ollama on this computer, reminders automatic but only with the service installed, live transcript off, media kept, fast path off unless the quick start turns it on). Install the reminders service only if you want it (`falatrace reminders install-service`, or Settings › Calendar and reminders). After updating, apply the call monitor and timers again if the diagnostics flag them; existing MCP sessions may need reconnecting. Existing summaries keep their format until regenerated. Before rolling back, uninstall the reminders service (alpha.14 has no `reminders` command). Alpha.14's summary reader takes the fields it knows from summaries made by alpha.15 (checked in its code, not by running it), and the new files listed in [privacy and data](PRIVACY.md) stay on disk unused. This document describes the release, not an installed-state receipt.
