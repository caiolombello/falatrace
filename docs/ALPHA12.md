# FalaTrace 0.2.0-alpha.12

Experimental Linux source release: automatic call detection for more browsers and calling apps, a redesigned Studio and summary/startup fixes. Alpha.11 contracts (reviewed views, exports, consent, persistent limits) are unchanged.

## Changes

**Call app identities.** Detection now reads one explicit allowlist ([apps](../src/calls/apps.ts)) shared by the classifier, configuration, network telemetry, `calls inspect`, tray, TUI, notifications, timesheet and job validation.

| Identity | Matched by (exact, after lowercasing) | Fresh default |
| --- | --- | --- |
| Slack, Zen, Helium | Unchanged from alpha.11 | On |
| Chromium | `chromium`, `chromium-browser`; Snap `chrome` only when `application.name` starts with “Chromium”; `org.chromium.Chromium` | On |
| Google Chrome, Brave, Edge, Vivaldi, Opera | `chrome`/`google-chrome[-stable]`, `brave[-browser]`, `msedge`/`microsoft-edge`, `vivaldi[-bin]`, `opera` and their Flatpak IDs | On |
| Firefox | `firefox`, `firefox-bin`, `firefox-esr`, name `firefox`, `org.mozilla.firefox` | On |
| Zoom desktop | `zoom`, `zoom.real`, name `ZOOM VoiceEngine`, `us.zoom.Zoom` | On |
| Teams for Linux (unofficial wrapper) | `teams-for-linux` | On |
| Discord, Signal, Telegram, Element | Exact binaries/IDs | **Off** (opt-in) |

Electron apps such as ChatGPT or editors announce `application.name` “Chromium input”; that generic name is deliberately not an identity, so their dictation does not start a recording. Messengers that also carry personal calls stay off until `callDetection.apps.<id>` is set to `true`. Existing app switches are preserved and missing ones take the registry default; with detection already enabled in `record` mode, the browsers, Zoom and Teams for Linux start recording on microphone/camera use after the update, exactly like Helium/Zen did. Network probes from an older release (reporting only Slack/Zen/Helium) remain accepted.

**Studio.** Redesigned component system, library overview and keyboard order; faster library loading with a presentation-only startup snapshot; About shows the installed release and commit; a startup freeze caused by slow date parsing is fixed. See [UX verification](UX-VERIFICATION.md#studio-redesign--unreleased).

**Summaries.** OpenAI input is bounded in UTF-8 bytes against the model context window, earlier checkpoints are reused, reasoning models get a 16,384-token output cap, and `gpt-6-luna` is the fresh default. Existing configuration and recorded jobs keep their model.

## Verification

784 offline tests, 0 failures across 111 files; TypeScript and desktop type checks and the CLI build passed, locally and in public CI for the release commit. App identities are covered by classifier fixtures built from PipeWire property shapes, including the Electron “Chromium input” negative observed on the author's machine. No call was started, no app capturing the microphone was launched and no recording was made to establish these results.

Author evidence: Zoom calls were already recorded automatically through Zoom web inside Helium in earlier alphas. That is not native Zoom client evidence.

## Limits

Native acceptance of each new identity (real call, mute, end, route change, finalized media) is pending per app/desktop/backend tuple. Identity names come from documented packaging conventions; if an app does not trigger, `falatrace calls inspect` during a call shows the sanitized stream metadata to correct the allowlist. The detector still cannot tell which service, tab or meeting is active, and any microphone/camera use by an enabled app (dictation, camera preview) satisfies the same heuristic.

All alpha.11 limits remain: Linux source distribution only; native capture/backend compatibility, physical audio/AV sync, playback/source jump, assistive technology, unified deletion, track selection, replaceable memory and cold-download installation are open gates. No dependency, model, runtime binary, private configuration/media/transcript or private history is bundled.

## Installation and rollback

Alpha.11 remains available for rollback. Update only when no capture or processing is active; do not stop either to create an update window. Existing MCP sessions may need reconnecting to use the new executable. This document describes the release, not an installed-state receipt.
