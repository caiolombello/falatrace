# Configuration and privacy

## First use and settings (Studio)

On a computer without a configuration file the Studio opens a six-step setup assistant: language and consent, capture (with a five-second audio test), processing (three presets, model downloads and the OpenAI key when needed), automatic recording, review, and the services to start. Nothing is saved or installed until **Concluir**/**Finish**, the OpenAI key included; closing the assistant discards it. The audio test and model downloads run only from their own buttons. The first save writes every explicit choice, so a later default change cannot alter it. Step-by-step instructions: [quickstart](QUICKSTART.md).

Afterwards, **Configurações…**/**Settings…** in the sidebar edits every option in ten sections. The full field list, values and defaults are in the [configuration reference](CONFIGURATION.md).

| Section | What you can change |
| --- | --- |
| Gravação automática | Call detection on/off, notify-only, record or OBS, queue on call end, entry/exit timing, one switch per app (browsers; Slack, Zoom, Teams for Linux; Discord, Signal, Telegram and Element are opt-in). |
| Captura e áudio | Backend (audio only, GPU Screen Recorder, OBS), audio sources and devices (listed from PipeWire/PulseAudio), a five-second audio test, encoder, profile, frame rate, recordings folder. |
| Processamento e IA | Presets, transcription (Whisper.cpp command/model/threads, OpenAI or Gemini model, language, expected languages, vocabulary), summary (Ollama URL/model/limit or OpenAI model), local/remote execution, automatic processing and completion notifications. External destinations are flagged. |
| Chaves de API | Save, test and remove `OPENAI_API_KEY`, `GEMINI_API_KEY` and the OBS WebSocket password. Write-only. |
| Modelos | Download and verify official Whisper models; pull the Ollama model on this computer. Explicit consent per download. |
| Integrações | OBS, remote worker (with an SSH connection test), originals archive, Proton Drive backup and legacy S3. |
| Recursos opcionais | Timesheet, per-client AI context and the GNOME Calendar title. |
| Avançado | Studio language, detection sampling and test mode, capture timeout, folder naming, legacy GNOME options, visual review limits, retention and the background check interval. |
| Serviços e diagnóstico | Read-only checks with a link to the section that fixes each problem; apply, restart or disable the call monitor, tray and the processing, archive and backup timers. |
| Backups e transferência | List and restore configuration backups; export without keys; import into the draft. |

Saving sends only the fields you changed. The bridge accepts an explicit allowlist of fields and values; anything else (secrets and unknown keys) is preserved. The same revision check, private exact-byte backup and non-overwriting publication described below apply.

API keys are kept in `secrets.env` next to the configuration (permission 600) and reach background processing. The Studio and `falatrace keys` save, test and remove them but never read a value back; they report only the source in use (`secrets.env`, `worker.env`, `calls.env`, the user's systemd environment or a legacy `openai.apiKey` in the configuration) and warn when a key exists only in the Studio's session, when a key file is readable by other users, or when an older source shadows the Studio key.

The call monitor and timers read their configuration when they start. After saving recording, folder or interval changes, apply them in **Serviços e diagnóstico**; the diagnostics flag a service still running with an older configuration. Service actions are refused while a capture is active and never start a recording themselves. Generated units point to the stable `~/.local/bin` link when it resolves to the running release, so they keep following updates.

Diagnostics do not record, transcribe, download models or contact non-loopback hosts. A passing check is not proof of model quality or of a working real call.

## Routes and local processing choice

Open **Rotas e privacidade…** (in Configurações → Processamento e IA) to review the current routes. Reading, closing, Escape and Cancel do not save it. This screen does not start recording, install models, execute providers or change running services.

The screen lists transcription, summary and local/remote execution separately. A loopback Ollama endpoint does not imply that transcription, archiving or other integrations are local. Archive, S3, Proton and external activity classification settings are disclosed without exposing their credentials, buckets, remote paths or worker names. Retention values are shown as configured, rather than as proof of deletion or a cleanup schedule.

**Salvar escolha local** requires an explicit check and a current configuration revision. It sets transcription to Whisper.cpp, summary to Ollama at `http://127.0.0.1:11434`, execution to local, and automatic processing after recording to disabled. It preserves all other options, including unknown keys, recording rules, archiving, S3, Proton, activity classification and retention. Existing configurations receive a private, exact-byte backup; fresh configuration is published without overwriting a concurrent file. Existing services may read these settings on their next execution.

Whisper.cpp, Ollama and their models must be installed separately. The screen does not validate custom executable behavior, model compatibility or output quality. Chat subscriptions do not imply included API usage.

After a read or save error, re-read the configuration before selecting and saving again. A lost connection during saving leaves the outcome unconfirmed. Reconnecting does not repeat the save; the user must re-read and make a fresh choice. Replies from a closed dialog are ignored. A delayed read does not move keyboard focus away from Cancel. Save disables duplicate activation and closing while its response is pending.

Configuration revisions are opaque 64-character tokens bound to the normalized configuration path, file existence and exact bytes. They detect a changed file or a changed legacy/XDG destination. They are a stale-draft check, not an authorization token or a universal filesystem CAS guarantee. Writers that do not cooperate with the same lease can still race at the filesystem publication boundary.

If publication succeeds but removal of the screen's own staging file fails, the response reports `saved: true` and `cleanupPending: true`; Studio warns that a private temporary copy may remain. Failed publication does not report success. A backup can also remain after a later commit failure. Each save keeps the 20 most recent backups and removes older ones; a backup created by the current save is never the one removed.

Local retention cleanup removes eligible completed-job work data. It is not a complete recording erasure: remote copies, exports and other derivatives can remain. Preview eligible local work cleanup with `falatrace jobs cleanup --dry-run`; this screen does not execute cleanup. A complete erasure interface, human comprehension study and physical display/accessibility validation remain separate roadmap work.

Regression commands use disposable, marked HOME/XDG directories and offline guards:

```sh
bash scripts/test-offline.sh src/config/__tests__/onboarding.test.ts src/desktop/__tests__/g4-onboarding-bridge.test.ts
```

The first file tests production configuration functions with synthetic files and injected failure conditions. The second exercises the production JSONL bridge with synthetic configuration and state sentinels. Native Qt journey evidence uses actual QML and Qt input events, with non-onboarding operations stubbed; its separate end-to-end cases route only onboarding operations to the production bridge. These fixtures do not validate microphone/screen capture, real models, live services or a user's private recording.
