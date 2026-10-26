# Privacy and data

Where FalaTrace keeps your data, what leaves the computer and when, how media retention works, and what deleting a recording does and does not remove. FalaTrace has no account and no hosted service. For the Google Calendar sign-in, see the [privacy policy page](https://caiolombello.github.io/falatrace/en/privacy/).

Record only with the permission of the people involved. Automatic call detection is opt-in and does not establish consent. Do not paste configuration, recordings or transcripts into public issues.

## Where data lives

Paths below are the defaults. `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME` and `XDG_RUNTIME_DIR` move them. The new stores are private: folders only your user can open (0700) and files only your user can read (0600), written atomically and never through a symbolic link.

### Configuration: `~/.config/recording-cli/`

| What | Path |
| --- | --- |
| Settings | `config.json`, and up to 20 `config.json.bak-*` backups |
| API keys, tokens and webhook URLs | `secrets.env` (0600; values are never shown) |
| Custom templates | `templates/<slug>.json` |
| Custom recipes | `recipes/<slug>.json` |
| Client catalog | `timesheet-context.json` (or `timesheet.contextPath`), and up to 10 `.bak-*` backups made by catalog edits |

### Your data: `~/.local/share/recording-cli/`

| What | Path | Contents |
| --- | --- | --- |
| Transcripts, summaries, job files | `jobs/` | Per processed recording |
| Meeting notes | `notes/<id>.json` | Your notepad lines with the time each was typed |
| Template and language per recording | `summary-prefs/<id>.json` | The choices used to regenerate |
| Assistant conversations | `assistant/threads/<uuid>.json` | Questions, answers, citations, destination and model |
| People | `people/people.json` | Your renames, aliases, merges and hidden people |
| Client choices | `client-overrides.json` | Clients you set per recording |
| Action states | `actions/<media-sha256>.json` | Open, done or dismissed per action |
| Calendar links | `calendar-links/<job-id>.json` | Event title, times and guest names (never e-mail addresses); the event id only as a salted hash |
| Reviews, reviewed summaries, exports | `revisions/`, `reviewed-summaries/`, `exports/` | Human corrections and the files you exported |
| Speakers, subtitles | `diarization/`, `subtitles/` | |
| Known voices | `voices/profiles.json` | 512-number signatures per person, never audio. A voice that identifies someone is biometric data under the LGPD. |
| Models | `models/` | Downloaded Whisper and voice models |

### State: `~/.local/state/recording-cli/`

| What | Path | Contents |
| --- | --- | --- |
| Processing queue | `jobs/` | |
| Library index | `knowledge-index/` | A derived copy of facts and transcript passages, plus embeddings when enabled. Rebuilt from the recordings. |
| Per-client AI context | `ai-context/` | |
| Live transcripts | `live/<session>/` | `live.jsonl` with the live lines; not removed automatically |
| Share log | `share-deliveries/<job-id>.json` | Time, destination, redacted target and content hash; never the content |
| ChatGPT sign-in | `chatgpt/oauth.json` | Access and refresh tokens (0600) |
| Google sign-in | `google/oauth.json` | Refresh token (0600) |
| Meeting decisions | `meeting-overrides.json` | Record or skip, until the meeting ends |
| Reminders | `reminders-sent.json`, `calendar-salt` | Sent reminders; the salt that hashes calendar ids |
| First-use milestones | `first-run.json` | When the setup assistant opened and finished, and the first recording and summary. Never sent anywhere. |
| Visual review | `visual-review/` | Budgets, frames and observations |

### Temporary: `$XDG_RUNTIME_DIR/recording-cli/` (cleared at logout)

Without a runtime folder, these go under the state folder instead.

| What | Path | Lifetime |
| --- | --- | --- |
| Assistant workspace | `assistant/` | An empty private folder per question for agents and CLI tools, removed afterwards |
| AI app handoff, clipboard fallback | `handoff/`, `share/` | Removed after a day, on the next share |
| Studio links | `studio-inbox/` | `falatrace://` links for the Studio, dropped after 5 minutes |

### Recordings

Media files live in `recordingsDir` (default `~/Videos/Recordings`). Next to each one, a `<name>.recording/` folder holds the media retention record (`media-retention.json`) and, in audio-only mode, `retained-audio.mka`. Obsidian notes are ordinary files in your vault.

### Outside FalaTrace

ACP agents and CLI tools keep their own history in their own folders (see [assistant](ASSISTANT.md#where-your-questions-end-up)). Providers and destinations keep what they received under their own terms.

## What leaves the computer

Nothing leaves unless a setting or an action of yours says so. Before processing, asking or sharing, the destination is named and, when it is outside this computer, you are asked to consent.

| Feature | On this computer | Leaves when | What is sent |
| --- | --- | --- | --- |
| Capture | Always | Never | |
| Transcription | Whisper.cpp | `transcription.provider` is OpenAI or Gemini | The audio |
| Notes and summaries | Ollama on loopback | OpenAI, or an Ollama on another computer | Transcript, your notes, the template, the calendar title and client names |
| Remote worker | | `processing.defaultTarget` is `remote` | The media and the job manifest; never your notes |
| Asking and recipes | Ollama on loopback | Any other assistant provider | The question, earlier messages of the conversation, and meeting excerpts: title, date, people, summary, notes, transcript lines with speakers |
| Live transcript | Whisper.cpp | `live.provider` is OpenAI or Groq | The audio, in chunks, for every capture while `live.enabled` is on |
| Sharing | Clipboard, Obsidian | Notion, Slack, an AI app | The shared note (see [sharing](SHARING.md#what-is-sent)) |
| Speaker names from the conversation | | When you ask for suggestions | The diarizer's turns, to the summary provider |
| Reminders and briefs | Always | Never; only the calendar is read | Google receives only the time window it is asked about |
| Google Calendar titles | | When connected | The recording's time window |
| Archive, Proton Drive, S3 | | When enabled | Media and results, to those destinations |
| Agents (MCP or CLI) | | When you grant access | Bounded context and frames of the granted recordings |
| Key tests | | When you press Test | A request for the model list; no audio or text |

A cloud-backed agent or AI app may send what it receives to its own provider. Deleting a recording cannot recall data a provider, destination or agent already received.

## Media retention

By default FalaTrace keeps the media. `media.retention` can drop it once the transcript is safe:

| Mode | What stays | What stops working for that recording |
| --- | --- | --- |
| `keep` (default) | Everything | Nothing |
| `audio-only` | All audio tracks, in `retained-audio.mka`; the video is deleted | Frames, visual review and reprocessing. Aligned subtitles only with a remote worker copy. Playback, speaker identification, microphone analysis and voices keep working. |
| `transcript-only` | No media | Playback, frames, speaker identification, voices and reprocessing, unless a verified archive copy exists (playback and speakers then use it) |

Notes, transcript, summaries, regeneration, questions, people, actions, sharing and export keep working in every mode.

A recording is removed only when all of this holds:

- its jobs are finished, and nothing is capturing, processing, identifying speakers or reviewing it;
- it has a verified transcript (a legacy transcript without a receipt is never removed automatically);
- speaker identification, microphone analysis and voice learning are done, or `media.graceDays` (0 to 3,650, default 1) have passed since processing;
- configured archive and full Proton backups are complete;
- the file still has the size and SHA-256 recorded when it was processed, checked before and after hashing.

Removal deletes the media file; it does not go to the Trash. It also removes copies made from it: the Proton restore cache, extracted frames and temporary audio. Remote and backup copies are never touched; archive copies not yet made are cancelled. A record next to the recording keeps the date, mode and hashes, and an interrupted removal resumes on the next run.

```sh
falatrace media status <job-id>                 # present, removed, audio-only or missing, and what still works
falatrace media retention --dry-run             # what the policy would do, without hashing or removing
falatrace media retention --apply [--limit N]   # apply it now; also finishes interrupted removals
falatrace media remove <job-id> [--keep-audio] --yes   # remove one recording's media now
```

When the policy is not `keep`, the background `jobs sync` timer applies it after each sync, hashing at most five recordings per run and waiting for the next run during a capture or a call. The Studio shows removed and audio-only recordings as such and offers removal per recording. <!-- studio-check -->

Separate older settings remove only processing work data: `retention.localCompletedWorkDays` (preview with `falatrace jobs cleanup --dry-run`) and the remote worker's `retention.remote*` days. Expired failed folders are cleaned only when they hold recognized disposable metadata and no media, unknown files, subfolders or links; cleanup is conservative and can keep data for manual review.

## Deleting a recording

Deleting a recording (in `falatrace tui`; the Studio has no delete action) first invalidates the derived AI context, and cancels the deletion if that fails. It then moves the media, its `<name>.recording/` folder and its job folders to the Trash, and removes its calendar link. The Trash keeps a full copy until you empty it.

It does **not** yet remove:

- the meeting notes, summary choices, action states and client choices of that recording;
- assistant conversations that quoted it, its share log and its live transcript lines;
- human revisions, reviewed summaries and exported files;
- remote, archive and backup copies, and the archive catalog;
- anything already sent to a provider, a destination or an agent.

The library index drops the recording on its next refresh, and people pages stop listing it. A unified deletion of every derived file is on the [roadmap](ROADMAP.md).

## Uninstalling

```sh
make uninstall-studio
make uninstall
```

Both remove only the installed programs. Configuration, keys, recordings, jobs, notes and backups stay. Removing services is a separate step: `falatrace calls uninstall-service`, `falatrace reminders uninstall-service`, `falatrace tray uninstall-service` and the `uninstall-timer` commands.
