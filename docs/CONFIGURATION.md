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
| `summary.provider` | `ollama`, `openai` | `ollama` | OpenAI receives the transcript. |
| `summary.ollamaUrl` | HTTPS URL, or HTTP on this computer (`127.0.0.1`, `localhost`, `[::1]`); no credentials | `http://127.0.0.1:11434` | A non-loopback address receives the transcript. |
| `summary.ollamaModel` | model name | `qwen3.5:9b` | |
| `summary.openaiModel` | model name | `gpt-6-luna` | |
| `summary.maxInputCharacters` | 4,096–200,000 | 24,000 | Ollama only; OpenAI sizes input to the model. |
| `processing.defaultTarget` | `local`, `remote` | `local` | `remote` needs a configured worker. |
| `processing.autoEnqueue` | true, false | false | Process every new recording. Automatic recordings also need the background timer. |
| `processing.notifyOnCompletion` | true, false | true | Desktop notification when a job finishes or fails. |

The three **presets** fill these fields: everything on this computer (Whisper.cpp and Ollama), local transcription with an OpenAI summary, or everything through OpenAI. Any recording can be processed later with **Process…**, which shows where the audio and text go before asking for consent.

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

### Integrations

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
