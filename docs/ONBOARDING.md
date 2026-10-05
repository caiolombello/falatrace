# Configuration and privacy

## Settings (Studio)

Open **Configurações…** in the Studio sidebar. On a computer without a configuration file the Studio opens it once, on the first tab. Nothing is recorded, sent or installed until you save and, for the call monitor, apply.

| Tab | What you can change |
| --- | --- |
| Gravação automática | Turn call detection on/off, notify-only or record, process on call end, entry/exit timing, and one switch per app (browsers; Slack, Zoom, Teams for Linux; Discord, Signal, Telegram and Element are opt-in). |
| Captura e áudio | Backend (audio only, GPU Screen Recorder, OBS), audio sources, microphone and system-audio device (listed from PipeWire/PulseAudio), GPU encoder and video profile, recordings folder. |
| Processamento e IA | Transcription (Whisper.cpp command/model, OpenAI or Gemini model, language), summary (Ollama URL/model or OpenAI model), local/remote execution, automatic processing. External destinations are flagged. |
| Serviços e diagnóstico | Read-only checks (FFmpeg, Whisper.cpp and model file, Ollama on loopback and its installed models, API key presence, recording backend) and the call monitor/tray services: apply and restart, or disable. |

Saving sends only the fields you changed. The bridge accepts an explicit allowlist of fields and values; anything else (archive, S3, Proton, remote worker, timesheet, secrets and unknown keys) is preserved. The same revision check, private exact-byte backup and non-overwriting publication described below apply. API keys are never read into or written by the Studio: it reports whether `OPENAI_API_KEY`/`GEMINI_API_KEY` is defined in the session environment, in `~/.config/recording-cli/calls.env` or in the configuration, never the value.

The call monitor reads its configuration when it starts. After saving recording changes, use **Aplicar e reiniciar monitor**; the diagnostics flag a monitor still running with an older configuration or a unit whose writable recordings folder no longer matches. Service actions are refused while a capture is active and never start a recording themselves. Generated units point to the stable `~/.local/bin` link when it resolves to the running release, so they keep following updates.

Diagnostics do not record, transcribe, download models or contact non-loopback hosts. A passing check is not proof of model quality or of a working real call.

## Routes and local processing choice


Open **Rotas e privacidade…** (in Configurações → Processamento e IA) to review the current routes. Reading, closing, Escape and Cancel do not save it. This screen does not start recording, install models, execute providers or change running services.

The screen lists transcription, summary and local/remote execution separately. A loopback Ollama endpoint does not imply that transcription, archiving or other integrations are local. Archive, S3, Proton and external activity classification settings are disclosed without exposing their credentials, buckets, remote paths or worker names. Retention values are shown as configured, rather than as proof of deletion or a cleanup schedule.

**Salvar escolha local** requires an explicit check and a current configuration revision. It sets transcription to Whisper.cpp, summary to Ollama at `http://127.0.0.1:11434`, execution to local, and automatic processing after recording to disabled. It preserves all other options, including unknown keys, recording rules, archiving, S3, Proton, activity classification and retention. Existing configurations receive a private, exact-byte backup; fresh configuration is published without overwriting a concurrent file. Existing services may read these settings on their next execution.

Whisper.cpp, Ollama and their models must be installed separately. The screen does not validate custom executable behavior, model compatibility or output quality. Chat subscriptions do not imply included API usage.

After a read or save error, re-read the configuration before selecting and saving again. A lost connection during saving leaves the outcome unconfirmed. Reconnecting does not repeat the save; the user must re-read and make a fresh choice. Replies from a closed dialog are ignored. A delayed read does not move keyboard focus away from Cancel. Save disables duplicate activation and closing while its response is pending.

Configuration revisions are opaque 64-character tokens bound to the normalized configuration path, file existence and exact bytes. They detect a changed file or a changed legacy/XDG destination. They are a stale-draft check, not an authorization token or a universal filesystem CAS guarantee. Writers that do not cooperate with the same lease can still race at the filesystem publication boundary.

If publication succeeds but removal of the screen's own staging file fails, the response reports `saved: true` and `cleanupPending: true`; Studio warns that a private temporary copy may remain. Failed publication does not report success. A backup can also remain after a later commit failure. No existing backup is automatically deleted.

Local retention cleanup removes eligible completed-job work data. It is not a complete recording erasure: remote copies, exports and other derivatives can remain. Preview eligible local work cleanup with `falatrace jobs cleanup --dry-run`; this screen does not execute cleanup. A complete erasure interface, human comprehension study and physical display/accessibility validation remain separate roadmap work.

Regression commands use disposable, marked HOME/XDG directories and offline guards:

```sh
bash scripts/test-offline.sh src/config/__tests__/onboarding.test.ts src/desktop/__tests__/g4-onboarding-bridge.test.ts
```

The first file tests production configuration functions with synthetic files and injected failure conditions. The second exercises the production JSONL bridge with synthetic configuration and state sentinels. Native Qt journey evidence uses actual QML and Qt input events, with non-onboarding operations stubbed; its separate end-to-end cases route only onboarding operations to the production bridge. These fixtures do not validate microphone/screen capture, real models, live services or a user's private recording.
