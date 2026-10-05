# FalaTrace 0.2.0-alpha.13

Experimental Linux source release: complete configuration in the Studio, with a guided first use and read-only diagnostics. Alpha.12 call-app identities and alpha.11 consent, revision and export contracts are unchanged.

## Changes

**Configurações.** The Studio sidebar opens a dialog with four tabs; on a computer without a configuration file it opens once automatically on the first tab. See [Configuration and privacy](ONBOARDING.md).

| Tab | Editable |
| --- | --- |
| Gravação automática | Detection on/off, notify-only or record, process on call end, entry/exit timing, one switch per app (Discord, Signal, Telegram and Element opt-in). |
| Captura e áudio | Backend (audio only, GPU Screen Recorder, OBS), audio sources, microphone and system-audio device from PipeWire/PulseAudio, GPU encoder and profile, recordings folder. |
| Processamento e IA | Transcription (Whisper.cpp command/model, OpenAI or Gemini model, language), summary (Ollama URL/model or OpenAI model), local/remote execution, automatic processing. |
| Serviços e diagnóstico | Checks for FFmpeg, Whisper.cpp and model file, Ollama on loopback and installed models, API key presence and recording backend; apply/restart or disable the call monitor, (re)install the tray. |

**Saving.** Only changed fields from an explicit allowlist are published, through the existing revision check, private exact-byte backup and non-overwriting publication. Archive, S3, Proton, remote worker, timesheet, secrets and unknown keys are preserved. API keys are never read into or written by the Studio; it reports only whether `OPENAI_API_KEY`/`GEMINI_API_KEY` is defined in the environment, `calls.env` or the configuration.

**Services.** The call monitor reads its configuration at start; diagnostics flag a monitor running with an older configuration or a unit whose writable recordings folder no longer matches. Service actions are refused while a capture is active and never start a recording. Generated units prefer the stable `~/.local/bin` link of the running release so they follow later updates.

The previous privacy screen remains as **Rotas e privacidade…**.

## Verification

801 offline tests, 0 failures across 114 files; TypeScript, desktop type checks and the CLI build passed, locally and in public CI for the release commit. New coverage: settings read/save (allowlist, preservation, stale and concurrent edits, private files), setup checks (no external host contacted, device parsing, service drift), bridge operations (unit and production process in a disposable HOME) and an offscreen QML journey (`scripts/test-settings-ux.py`, 21 checks over 8 states including first use, save diff, discard, compact window and service apply). Existing `test-desktop-ui.py` and `test-heavy-ux.py` pass.

Known pre-existing issues, not introduced here: `scripts/test-local-ux.py` fails on `frames-result` with and without this change; one `visual-pipeline` test can exceed its 5 s timeout under load and cascade into neighbouring tests (a rerun passed 801/801).

No recording, transcription, provider call, model download or real service change was made to establish these results; the dialog was not exercised on a physical desktop.

## Limits

Backends outside audio/GPU Screen Recorder/OBS are shown read-only until another is chosen. Archive, S3, Proton, remote worker, timesheet and calendar settings are still edited in the configuration file. Diagnostics confirm presence, not model quality or a working real call. All alpha.12 limits remain.

## Installation and rollback

Alpha.12 remains available for rollback. Update only when no capture or processing is active. Existing MCP sessions may need reconnecting to use the new executable. This document describes the release, not an installed-state receipt.
