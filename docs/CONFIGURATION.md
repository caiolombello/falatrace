# Configuration reference

Everything below can be changed in the Studio under **Settings** (Configurações), section by section. The first-use assistant covers the common choices. The configuration file stays a plain JSON file that can also be edited by hand; the CLI and every background service read the same file.

## Where things live

| What | Path | Notes |
| --- | --- | --- |
| Configuration | `~/.config/recording-cli/config.json` | `$XDG_CONFIG_HOME/recording-cli/config.json` when set; `falatrace config` prints the path in use. |
| API keys and OBS password | `secrets.env` next to the configuration | Private file (0600), written by the Studio or `falatrace keys set`. Values are never shown. |
| Older key files | `~/.config/recording-cli/worker.env`, `calls.env` | Still read; never written. |
| Configuration backups | `config.json.bak-<id>` next to the configuration | One per save; the 20 most recent are kept. |
| Whisper models | `~/.local/share/recording-cli/models/` | Downloads are verified by size and SHA-256. |
| Installed Studio (from source) | `~/.local/share/falatrace/studio/`, `~/.local/bin/recording-studio` | Created by `make install-studio`. |
| Background services | `~/.config/systemd/user/recording-cli-*` | Or wherever the systemd user manager loads units from, when its `XDG_CONFIG_HOME` differs. Each unit carries the XDG directories of the process that installed it, the defaults it falls back to included, and installing creates every folder the unit may write. |

A copy of a working setup is in [`config.example.json`](config.example.json). Missing keys take the defaults listed below, and keys the Studio does not edit are always preserved.

## How changes are saved

- A save sends only the fields you changed. Each field is checked against an allowlist with its own rule; anything else in the file (unknown keys, secrets, settings the Studio does not edit) is kept byte for byte.
- Every save is bound to the revision that was read. If the file changed in the meantime, the save is refused and you are asked to reload.
- Before replacing an existing file, the previous one is copied to a private backup. **Backups and transfer** lists the backups and restores one; restoring also backs up the current file first.
- **Export** writes the configuration without any key or password, and never over the configuration in use. **Import** loads only the fields the Studio edits into the draft, lists rejected values and ignored keys, and saves nothing until you click Save.
- Services read the configuration when they start. After changing recording, folder or interval settings, re-apply the call monitor and timers in **Services and diagnostics**; the diagnostics flag a service still running with an older configuration.

## API keys

| Name | Used for |
| --- | --- |
| `OPENAI_API_KEY` | OpenAI transcription or summaries, speaker identification, AI timesheet classification. |
| `GEMINI_API_KEY` | Gemini transcription. |
| `RECORDING_CLI_OBS_PASSWORD` | The OBS WebSocket password. |
| `GOOGLE_CLIENT_SECRET` | The secret of your own Google OAuth desktop client, for the Google Calendar sign-in (see Integrations). |
| `OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `XAI_API_KEY`, `GROQ_API_KEY`, `MISTRAL_API_KEY`, `DEEPSEEK_API_KEY`, `TOGETHER_API_KEY` | The assistant (questions, chat, recipes) through that provider's API. `GROQ_API_KEY` also serves the Groq live transcript. `OPENAI_API_KEY` and `GEMINI_API_KEY` serve the OpenAI and Gemini presets. |
| `CUSTOM_API_KEY` | The OpenAI-compatible API set in `assistant.apiBaseUrl`. |
| `NOTION_TOKEN` | Sharing a note to Notion (an internal integration token with access to the parent page). |
| `SLACK_WEBHOOK_URL` | Sharing a note to Slack (an incoming webhook URL on `hooks.slack.com`). |

Keys are write-only: the Studio and the CLI save, test and remove them, and report only where each one comes from. The first source that has a value wins:

1. The session environment, unless the value equals one in `worker.env` or `calls.env`.
2. `secrets.env`.
3. `worker.env`.
4. `calls.env`.

A key file that other users can change, that belongs to another user, that is a link or that is too large is ignored, and its values are not used even when a service loads that file into its environment. Background services do not see keys that exist only in your terminal session, and the diagnostics say so. When the user services' environment cannot be read, the diagnostics and the key section say that a key set there would take precedence, and **Test** tests no key until it can be read. A legacy `openai.apiKey` in `config.json` is still read; saving the key in the Studio lets you remove it from the file. **Test** asks the provider only for its model list: no audio or text is sent.

```sh
falatrace keys status
printf '%s' "$KEY" | falatrace keys set OPENAI_API_KEY
falatrace keys test openai
falatrace keys remove OPENAI_API_KEY
```

## Settings by Studio section

Values are listed as accepted by the Studio. Defaults are what a missing key means.

### Automatic recording

| Field | Values | Default | Notes |
| --- | --- | --- | --- |
| `callDetection.enabled` | true, false | false | Detects when an app uses the microphone or camera. It does not identify the service, tab or participants. |
| `callDetection.mode` | `notify-only`, `record`, `obs` | `notify-only` | `record` uses the backend chosen in Capture and audio; `obs` only controls OBS. |
| `callDetection.enqueueOnStop` | true, false | true | In OBS mode, queue the recording when the call ends. |
| `callDetection.apps.<id>` | true, false | see below | One switch per app. |
| `callDetection.entryDebounceSeconds` | 1–120 | 5 | Confirm the call after this long. |
| `callDetection.exitTimeoutSeconds` | 1–300 | 15 | End after the app stops using the microphone for this long. |

App ids on by default: `slack`, `zen`, `helium`, `chromium`, `chrome`, `brave`, `edge`, `vivaldi`, `opera`, `firefox`, `zoom`, `teams`. Off by default because they also carry personal calls: `discord`, `signal`, `telegram`, `element`.

### Capture and audio

| Field | Values | Default | Notes |
| --- | --- | --- | --- |
| `backend` | `audio`, `gpu-screen-recorder`, `obs` | `simple` (legacy) | The Studio offers the three current backends. Older values load, but automatic recording treats them as OBS. |
| `capture.audioSource` | `both`, `microphone`, `desktop`, `none` | `both` | |
| `capture.microphone` | `default` or a PipeWire/PulseAudio source name | `default` | The Studio lists the devices it finds. |
| `capture.desktop` | `default` or a monitor source name | `default` | |
| `capture.encoder` | `gpu`, `cpu` | `gpu` | GPU Screen Recorder only. |
| `capture.profile` | `standard`, `call-light` | standard | GPU Screen Recorder only; call-light lowers resolution and frame rate. |
| `capture.framerate` | 1–60 | 30 | |
| `recordingsDir` | absolute path | `~/Videos/Recordings` | Changing it does not move existing recordings. |

The **audio test** records five seconds with the saved sources, reports the level of each track and deletes the file.

### Processing and AI

| Field | Values | Default | Notes |
| --- | --- | --- | --- |
| `transcription.provider` | `whisper-cpp`, `openai`, `gemini` | `whisper-cpp` | OpenAI and Gemini receive the audio. |
| `transcription.whisperCpp.command` | command or absolute path | `whisper-cli` | Point to a Vulkan or CUDA build to use the GPU. |
| `transcription.whisperCpp.modelPath` | absolute path | models folder, `ggml-large-v3-turbo-q5_0.bin` | Set automatically by **Use this model** after a download. |
| `transcription.whisperCpp.threads` | 1–256 | 8 | |
| `transcription.openaiModel` | model name | `gpt-transcribe` | |
| `transcription.geminiModel` | model name | `gemini-3.5-transcribe` | |
| `transcription.language` | `auto` or a language code | `pt` | |
| `transcription.expectedLanguages` | list of codes | empty | Helps OpenAI with multilingual calls. |
| `transcription.openaiPrompt` | text, up to 8,000 characters | empty | Vocabulary and context; sent to OpenAI with the audio. |
| `summary.provider` | `ollama`, `openai` | `ollama` | OpenAI receives the transcript. Also the destination when you ask the Studio to look for speaker names in the conversation (shown before sending). |
| `summary.ollamaUrl` | HTTPS URL, or HTTP on this computer (`127.0.0.1`, `localhost`, `[::1]`); no credentials | `http://127.0.0.1:11434` | A non-loopback address receives the transcript. |
| `summary.ollamaModel` | model name | `qwen3.5:9b` | |
| `summary.openaiModel` | model name | `gpt-6-luna` | |
| `summary.maxInputCharacters` | 4,096–200,000 | 24,000 | Ollama only; OpenAI sizes input to the model. |
| `processing.defaultTarget` | `local`, `remote` | `local` | `remote` needs a configured worker. |
| `processing.autoEnqueue` | true, false | false | Process every new recording. Automatic recordings also need the background timer. |
| `processing.notifyOnCompletion` | true, false | true | Desktop notification when a job finishes or fails; clicking it opens the recording in the Studio. |
| `processing.fastPath` | true, false | false | Process a recording as soon as it stops, instead of waiting for the timer. Only with local providers (Whisper.cpp and Ollama on this computer). |
| `summary.language` | `auto`, `pt-BR`, `en`, `es` | `auto` | Language of new summaries; `auto` follows the predominant language of the conversation. Existing summaries keep theirs until regenerated. |
| `summary.template` | `auto`, a template id or `custom:<slug>` | `auto` | Default structure of the notes. `auto` picks one per meeting (see Notes and templates). |
| `summary.templateDetection` | `ai`, `keywords` | `ai` | When the calendar title and keywords do not decide, `ai` lets the summary request pick the template; `keywords` falls back to the general template. No extra request is made either way. |
| `summary.useNotes` | true, false | true | Use the notes typed during the meeting as the skeleton of the summary. |

The three **presets** fill these fields: everything on this computer (Whisper.cpp and Ollama), local transcription with an OpenAI summary, or everything through OpenAI. Any recording can be processed later with **Process…**, which shows where the audio and text go before asking for consent.

### Notes and templates

| Field | Values | Default | Notes |
| --- | --- | --- | --- |
| `notes.enabled` | true, false | true | Shows the notepad while a capture runs. Notes stay on this computer, next to the recording's other private data, and are sent only with the summary request, to the summary provider. |

Built-in templates: general, 1:1, daily/stand-up, planning, retrospective, sales discovery, incident postmortem, hiring interview and user research. Custom templates are JSON files in `templates/` next to the configuration, created and edited in **Settings › Notes and templates**. A template is chosen per meeting in this order: your choice on the recording, the default above, the calendar title, keywords in the transcript, then (with `ai`) the summary request itself. The Studio shows which one was used and why.

### Assistant

| Field | Values | Default | Notes |
| --- | --- | --- | --- |
| `assistant.provider` | `local`, `api`, `acp`, `cli`, `chatgpt` | `local` | Where questions, chat and recipes go. `local` uses the Ollama server of the summary settings. Every other choice sends the question and the meeting excerpts it needs to that destination; the Studio names it before the first question. |
| `assistant.localModel` | model name | `qwen3.5:9b` | Ollama model for `local`. |
| `assistant.apiPreset` | `openai`, `openrouter`, `gemini`, `xai`, `groq`, `mistral`, `deepseek`, `together`, `anthropic`, `custom` | `openrouter` | API for `api`. Each preset uses its own key (see API keys). |
| `assistant.apiBaseUrl` | HTTPS URL, or HTTP on this computer; no credentials | empty | Only for `custom`: an OpenAI-compatible endpoint. |
| `assistant.apiModel` | model name | empty | Empty uses the preset's default model. |
| `assistant.acpAgent` | `claude`, `codex`, `gemini`, `opencode`, `kiro`, `copilot`, `cursor`, `goose`, `qwen`, `grok`, `custom` | `codex` | Agent for `acp` (Agent Client Protocol). It must be installed and signed in on its own; FalaTrace starts it with no file or terminal access, in an empty folder. |
| `assistant.acpCommand` | command line, no shell | empty | Only for `custom`. |
| `assistant.cliTool` | `claude`, `codex`, `gemini`, `opencode` | `claude` | Tool for `cli`: FalaTrace runs your installed, signed-in tool once per question, with its tools turned off. This is how a Claude subscription is used: through your own `claude` command. |
| `assistant.cliModel` | model name | empty | Empty uses the tool's default. |
| `assistant.chatgptModel` | model name | empty | For `chatgpt` (Sign in with ChatGPT, Plus or Pro). Empty uses the account default. |
| `assistant.maxContextCharacters` | 8,000–400,000 | 60,000 | Upper bound of meeting text sent with one question. |
| `assistant.embeddingModel` | Ollama embedding model | empty | Adds meaning-based library search through the local Ollama. Empty keeps keyword search. |

### Reminders and live transcript

| Field | Values | Default | Notes |
| --- | --- | --- | --- |
| `reminders.mode` | `auto`, `on`, `off` | `auto` | Notification shortly before a calendar meeting. `auto` turns it on when recordings are not automatic (call detection off or `notify-only`), offering **Record**; with automatic recording it stays off unless set to `on`, and then offers **Skip this recording**. Needs Google Calendar or the GNOME calendar. |
| `reminders.leadMinutes` | 1–15 | 2 | |
| `reminders.brief` | true, false | true | Adds what earlier meetings with the same people, series or client left open (actions, last decisions). Built from local data only. |
| `live.enabled` | true, false | false | Live transcript while a capture runs. A preview: the final transcript is still made after the meeting. |
| `live.provider` | `whisper-cpp`, `openai`, `groq` | `whisper-cpp` | Whisper.cpp is free and uses this computer's CPU. OpenAI (about US$0.27 per hour with `gpt-transcribe`) and Groq (about US$0.04 per hour with `whisper-large-v3-turbo`) receive the audio in chunks; prices checked 2026-10-25. |
| `live.chunkSeconds` | 5–60 | 15 | Shorter chunks show text sooner and cost more CPU or requests. |
| `live.whisperModelPath` | absolute path | models folder, `ggml-base.bin` | A small model keeps up in real time on most CPUs. |
| `live.whisperThreads` | 1–64 | 2 | |
| `live.openaiModel` | model name | `gpt-transcribe` | |
| `live.groqModel` | model name | `whisper-large-v3-turbo` | |

### Privacy and retention

| Field | Values | Default | Notes |
| --- | --- | --- | --- |
| `media.retention` | `keep`, `audio-only`, `transcript-only` | `keep` | After a verified transcript, `audio-only` drops the video and `transcript-only` deletes the media. Playback (for `transcript-only`), frames, speaker identification and reprocessing stop working for that recording; notes, transcript, summary, chat and export keep working. Remote and backup copies are not touched. |
| `media.graceDays` | 0–3650 | 1 | Wait this long after processing, so speakers can still be named and voices learned. |

### Share destinations

| Field | Values | Default | Notes |
| --- | --- | --- | --- |
| `destinations.obsidianVault` | absolute path | empty | Obsidian vault that receives notes as Markdown files. |
| `destinations.obsidianFolder` | relative folder | `FalaTrace` | Folder inside the vault. |
| `destinations.notionParentId` | 32 hexadecimal characters | empty | Notion page that receives new pages. Needs `NOTION_TOKEN`. |
| `destinations.aiApp` | `chatgpt-web`, `claude-web`, `claude-desktop`, `gemini-web`, `claude-cli`, `codex-cli`, `gemini-cli`, `opencode-cli` | `chatgpt-web` | App used by **Open in my AI**: the note is copied, and the app or a terminal with the tool opens. Nothing is sent until you send it there. |

Slack uses `SLACK_WEBHOOK_URL`. Every share shows the destination and the content before sending.

### Models

Official whisper.cpp models from Hugging Face. Each download is checked against the published size and SHA-256; a different file with the same name is kept, never overwritten. Ollama models are pulled only through an Ollama on this computer.

| Id | Size | Notes |
| --- | --- | --- |
| `tiny` | 74 MiB | Very fast, less accurate. |
| `base` | 141 MiB | Fast, basic accuracy. |
| `small` | 465 MiB | Balanced for modest CPUs. |
| `medium-q5_0` | 514 MiB | Accurate, quantized. |
| `large-v3-turbo-q5_0` | 547 MiB | Recommended default. |
| `large-v3-turbo-q8_0` | 834 MiB | Turbo with a bit more accuracy. |
| `large-v3-turbo` | 1.5 GiB | Turbo without quantization; more memory. |
| `large-v3` | 2.9 GiB | Highest accuracy; slow without a GPU. |

```sh
falatrace models list
falatrace models download large-v3-turbo-q5_0
falatrace models ollama-pull qwen3.5:9b
```

`ollama-pull` uses `summary.ollamaUrl`, or the address after `--url`; either must be an Ollama on this computer. The Studio's Models section lists and pulls into the address in its draft, saved or not.

**Voice recognition** (`eres2net-base`, about 48 MiB) is downloaded only on request, from the Models section or with `falatrace models voice-download eres2net-base`: the sherpa-onnx native runtime from its npm package (`sherpa-onnx-linux-x64` 1.13.8) and the 3D-Speaker ERes2Net speaker-embedding model from the sherpa-onnx release, both Apache-2.0. The archive, each runtime file and the model are checked against pinned sizes and SHA-256 before they are published under `~/.local/share/recording-cli/models/voice/`, and the runtime is loaded only while its files are the ones that check recorded. Linux x86-64 only. It is not a project dependency and is never installed with FalaTrace.

### Integrations

**Google Calendar** reads the event a recording belongs to: its title goes into the summary, as with the GNOME calendar, and the names invited to it can complete names said in the conversation when you ask for speaker name suggestions. Only the recording's time window is sent to Google; invited names are never stored in the job or sent with the summary. It uses an OAuth client of your own Google Cloud project, since FalaTrace ships none: create a project, enable the Google Calendar API, set up the consent screen and create an OAuth client of type **Desktop app**. Save its ID here and its secret as `GOOGLE_CLIENT_SECRET` (API keys or this section), then **Connect Google account**: the browser opens Google's consent page and returns to a one-shot server on `127.0.0.1` (PKCE). The scopes are `openid email` and `calendar.events.owned.readonly`. Only the refresh token is kept, in `~/.local/state/recording-cli/google/oauth.json` (0600); **Disconnect** revokes it and deletes the file. While the consent screen is in testing mode, Google ends the access after 7 days; published without verification it shows a warning and accepts up to 100 users.

| Field | Values | Default | Notes |
| --- | --- | --- | --- |
| `google.clientId` | empty, or an ID ending in `.apps.googleusercontent.com` | empty | The client of your own Cloud project. |
| `google.calendar` | true, false | false | Uses the connected account for meeting titles and invited names; with GNOME Calendar also on, Google is tried first. |

```sh
falatrace google connect      # prints the consent URL and opens the browser
falatrace google status
falatrace google disconnect
```

| Field | Values | Default | Notes |
| --- | --- | --- | --- |
| `obs.enabled` | true, false | false | |
| `obs.autoLaunch` | true, false | false | Open OBS when recording starts. |
| `obs.host` | `127.0.0.1`, `localhost`, `::1` | `127.0.0.1` | OBS is only controlled on this computer. |
| `obs.port` | 1–65535 | 4455 | The password is the `RECORDING_CLI_OBS_PASSWORD` key. |
| `remote.host` | host name | placeholder | A worker with Whisper.cpp and Ollama reached over SSH with a key; it must be in `known_hosts`. |
| `remote.user` | user name or empty | empty | |
| `remote.port` | 1–65535 | 22 | |
| `remote.identityFile` | absolute path or empty | empty | |
| `remote.archiveDir` | absolute or `~/` path | `~/Videos/RecordingArchive` | |
| `archive.enabled` | true, false | false | Keep verified copies of original recordings. Needs at least one destination below. |
| `archive.vaio` | true, false | true | Copy to the remote worker. |
| `archive.proton` | true, false | true | Copy to Proton Drive. |
| `archive.syncIntervalMinutes` | 1–1440 | 5 | |
| `proton.enabled` | true, false | false | Back up results with rclone. |
| `proton.targetFolder` | path under `/my-files` | `/my-files/RecordingArchive` | |
| `proton.policy` | `artifacts`, `full` | `artifacts` | `full` includes the media. |
| `s3.enabled` | true, false | false | Legacy upload commands only. Needs `s3.bucket`. |
| `s3.bucket` | bucket name | empty | |
| `s3.region` | region | `us-east-1` | |
| `s3.prefix` | prefix | `recordings/` | |
| `s3.profile` | AWS CLI profile or empty | empty | |

**Test connection** checks the worker over SSH and lists its tools; **Test the OBS connection** checks the WebSocket with the password the call monitor uses, and says so instead when the user services' environment cannot be read.

### Optional features

| Field | Values | Default | Notes |
| --- | --- | --- | --- |
| `timesheet.enabled` | true, false | false | |
| `timesheet.automaticFromCalls` | true, false | false | |
| `timesheet.aiClassification` | true, false | false | Sends the client catalog, summary and a transcript excerpt to OpenAI. |
| `timesheet.aiModel` | model name | `gpt-6-luna` | |
| `timesheet.readyConfidence` | 0.5–1 | 0.8 | |
| `timesheet.contextPath` | absolute path | `~/.config/recording-cli/timesheet-context.json` | Create it with `falatrace time init-context`. |
| `aiContext.enabled` | true, false | false | |
| `aiContext.autoBuild` | true, false | true | |
| `aiContext.maxMeetingsPerClient` | 1–100 | 12 | |
| `aiContext.maxCharactersPerClient` | 8,000–200,000 | 18,000 | |
| `calendar.enabled` | true, false | false | Reads the GNOME Calendar event title when a recording is queued. |
| `speakers.voices` | true, false | false | Recognizes known voices and learns from speaker names you confirm. Needs voice recognition from Models. Stores 512-number signatures per person in `~/.local/share/recording-cli/voices/profiles.json` (0600), never audio; a voice that identifies someone is biometric data under the LGPD. Manage or delete them in Models › Known voices or with `falatrace voices`. |

### Advanced

| Field | Values | Default | Notes |
| --- | --- | --- | --- |
| `studio.language` | `auto`, `pt-BR`, `en` | `auto` | `auto` uses Portuguese for `pt_*` and bare `C`/`POSIX` locales, English otherwise. |
| `callDetection.networkSampleSeconds` | 1–60 | 5 | |
| `callDetection.dryRun` | true, false | false | Detect and log without recording or notifying; the diagnostics say so. |
| `capture.startupTimeoutSeconds` | 5–300 | 90 | |
| `features.namingTemplate` | `YYYY`, `MM`, `DD`, `HH`, `mm`, `[title]` and separators | `YYYY-MM-DD_HH-mm_[title]` | |
| `gnome.framerate` | 1–60 | 30 | Legacy GNOME backends. |
| `gnome.drawCursor` | true, false | true | Legacy GNOME backends. |
| `gnome.audioSource` | `both`, `microphone`, `desktop`, `none` | `both` | Legacy GNOME backends. |
| `visualReview.maxInferences` | 1–1000 | 24 | Lifetime limit for the whole installation, written together with `period: "lifetime"`. |
| `visualReview.maxPreviews` | 1–1000 | 16 | Same. |
| `retention.localCompletedWorkDays` | 0–3650 | 7 | 0 turns the limit off. Only work data is removed, never the original. |
| `retention.remoteIncomingDays` | 0–3650 | 2 | |
| `retention.remoteResultsDays` | 0–3650 | 30 | |
| `retention.remoteFailuresDays` | 0–3650 | 30 | |
| `processing.syncIntervalMinutes` | 1–1440 | 5 | How often the background timer checks the queue. |

`falatrace jobs cleanup --dry-run` shows what retention would remove.

## Services and timers

| Service | What it does | Studio | CLI |
| --- | --- | --- | --- |
| `recording-cli-calls.service` | Call monitor for automatic recording. | Apply and restart, or disable. | `falatrace calls install-service` / `uninstall-service` |
| `recording-cli-tray.service` | Tray indicator (REC, pause, stop). | Install or restart, or remove. | `falatrace tray install-service` / `uninstall-service` |
| `recording-cli-sync.timer` | Processes the queue in the background. | Turn on or reapply, or turn off. | `falatrace jobs install-timer` / `uninstall-timer` |
| `recording-cli-archive.timer` | Retries original media copies. | Same. | `falatrace archive install-timer` / `uninstall-timer` |
| `recording-cli-proton-backup.timer` | Backs up results to Proton Drive. | Same. | `falatrace backup install-timer` / `uninstall-timer` |

Service actions are refused while a capture is active and never start a recording. Turning a timer off keeps the queue.
