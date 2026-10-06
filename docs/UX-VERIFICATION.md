Current alpha.7 verification and limits: [ALPHA7.md](ALPHA7.md#verification). The historical matrix below describes earlier releases and is not the current feature inventory.

This original matrix documents published alpha.1. The alpha.2 changes and exact validation are in ALPHA2-LOCAL-REVIEW.md and OPUS-REVIEW-RESOLUTION.md.

# UX/UI verification — alpha.1 baseline and alpha.2 increment

This matrix reviews the existing product journeys and identifies missing controls. It is not a claim that every planned feature ships. Tests use synthetic data and stubs; no user capture, private media or paid API. Physical keyboard input, Orca, portal capture and real-model quality remain unverified.

| Journey | Acceptance criterion | Verification | Result / limit |
|---|---|---|---|
| Installation / first use | Explicit dependencies; init preserves existing/invalid config; private permissions; uninstall preserves data | Offline installation regressions, frozen lock with 17 exact cached packages | Passed. Network cold install and native binary distribution unverified |
| Consent / capture | Deliberate confirmation; cancel creates no capture; active/unknown/stopped states distinct | Real Qt component, synthetic backend, consent assertions | Passed modal/cancel/guard checks. Real capture not started |
| Automatic recordings | Pause future captures separately from stopping current capture; resume deliberate | Existing automation tests, CLI pause/resume regression; Studio pause control and resume consent | Passed offline state behavior. Real desktop detection remains experimental |
| Library / navigation | Search, explicit empty/loading/error, Back clears stale detail and focuses search | 11 Qt renders plus programmatic QML checks | Passed render/selection/Back checks. OS key-event navigation and assistive technology unverified |
| Transcript / playback | Original text distinct from aligned subtitles; temporal references do not invent timing | Canonical transcript tests; synthetic transcript render; text-focus guard | Passed offline boundary. Video decoding, actual seek and audio playback unverified in software offscreen |
| Summary / context | Provider/config disclosed, plain text, uncertainty/provenance retained; stale response cannot cross recordings | Summary regressions and real QML stale-context/copy-buffer checks | Passed. Summary source-chip UI and full interactive review flow remain incomplete |
| Frames / budget | Transcript-first requests, validated ranges, persistent budget/cache/TTL; no silent remote inference | Generated synthetic video, adapters/stubs, offline visual tests and benchmark | Internal opt-in API passed. No complete Studio/CLI frame toggle or actual model-quality validation |
| Jobs / retry / recover | No duplicate pending requests; preserve state on failure; explicit retry/recover | Reactive pending map; queue/singleton/capture regressions; rendered disabled controls | Passed code checks. Full physical double-click/reconnection journey unverified |
| Providers / privacy | No implied local processing with external endpoints; no automatic entitlement assumptions | Defaults/config tests and consent/summary disclosure | Passed existing behavior. Full visual provider onboarding/settings screen not shipped |
| Retention / deletion | Scope explicit; unknown files and failures preserved; invalidate derived memory before removal | Synthetic retention/deletion regressions | Passed. Local removal does not delete remote copies or retract accepted provider data; unified remote deletion not shipped |
| Export / CLI | Stable structured output, no ANSI contamination, helpful nonzero errors; commands retained | CLI help/calls-status/context-error/automation contract regression | Passed. Commands with human output do not silently become JSON; existing JSON contracts are unchanged |
| Accessibility / responsive | State uses text/shape; contrast-safe tokens; focus, cancel/Back, compact layout | Real Qt dark/light/900×640 renders; browser 16/24/32 comparison; mobile landing 360px | Render and programmatic focus checks passed. Complete WCAG/Orca certification, OS key events, fractional scale/high-contrast theme remain unverified |

## UI safety changes

- Confirmation before manual capture and before resuming future automatic capture rules.
- REC text plus elapsed time and a recording-specific red; static source anchor is separate.
- Capture state is unknown until read successfully; unavailable backend does not imply “stopped”.
- Pending requests update reactively; repeated process/retry actions are disabled.
- Transcript/context selection clears the copy buffer and ignores stale responses from older selections.
- Text-focused controls suppress player shortcuts. Escape/Back navigation is configured; programmatic Back was tested.
- Errors, provider labels and synthetic/user text remain plain text. Hover tooltip errors were fixed.
- Dark/light themes, compact player controls, legible placeholder text and hidden empty-job panel reduce clutter.

## Repeatable verification

`bash scripts/test-offline.sh` isolates HOME/XDG, blocks capture/service/remote commands and blocks external model endpoints. Baseline after the UX implementation: 347 tests passed, zero failed, across 57 files (1,402 assertions).

For the native UI, use an existing SDK/runtime: `bun run desktop:build`, then `python3 scripts/test-desktop-ui.py /tmp/falatrace-ui-review`. The script generates a synthetic video with FFmpeg, refuses capture operations and renders the actual QML with test-only timer instrumentation. Nine assertions and eleven screenshot states passed. Screenshot save succeeded; the existing combined media smoke returns 5 when `mediaReady=false`. This is explicitly not a successful video-playback smoke.

Public screenshots are curated output from that fixture. Workflow illustrations are separately labeled **Synthetic example / Interface concept**, never product screenshots. No model-semantic benchmark is claimed.


## Alpha.2 increment

The Studio confirmation uses the production Ollama visual/summary adapters; verification replaced HTTP transport with fixtures. Explicit model capability checks and bound consent precede inference. Persistent root limits are 24 inference attempts and 16 previews; plan/window checkpoints support different questions and fresh consent after TTL without resetting the root counter. Historical notes remain readable with expired-evidence warnings. Onboarding read/cancel/save preserves unknown config keys and writes only on deliberate save.

Final validation: 362 offline tests, zero failures, 1657 assertions; 18 Qt synthetic renders and 43 checks. Actual installed-model quality, native capture/playback, physical keyboard/touch/Orca, retention automation and complete provider onboarding remain unvalidated/incomplete. See ALPHA2-LOCAL-REVIEW.md for detailed evidence and OPUS-REVIEW-RESOLUTION.md for findings.

## Studio redesign — unreleased

Presentation-only rebuild of `src/desktop/Main.qml`, still a single file so the build fingerprint, fixtures and packaging keep loading one QML document. The logic layer (state, consent, budgets, generation/stale guards, bridge protocol, `captionTextAt`/`captionHasFocus`, the subtitle-status line and every ID/function used by tests or `main.cpp`) was copied unchanged; presentation blocks were replaced.

Verification on a Fedora host without the Ubuntu Qt SDK:

- Offline suite: 732 of 759 tests passed. The same 27 tests failed with the unchanged QML on this host, because its FFmpeg lacks the `libx264` encoder and `strace` is absent; no new failure. Typecheck and `desktop:check` passed. The QML-reading tests (captions, caption focus, subtitle status) and the desktop bridge tests passed 48/48.
- Native UX scripts (`test-desktop-ui`, `test-local-ux`, `test-heavy-ux`, `test-planner-ux`, `test-scope-ux`) ran their unmodified fixtures and production modules through a local PySide6 port of `main.cpp` (same argv, JSONL validation, timeouts and snapshot receipts), not through the shipped binary: 84 of 85 assertions passed. The failing `invalid config visible and saving blocked` assertion fails identically with the unchanged QML: since alpha.11 onboarding read errors are reported in `onboardingError`, while the script still expects `uxError`.
- `qmllint` reports the same five warnings as the unchanged QML, all caused by the native `Recording` module being unavailable to the linter.
- Rendered checks with a synthetic backend: light/dark, 1320×820 and 900×640, library overview, empty, loading, error, disconnected, recording, paused, missing media, block timing, every dialog; no horizontal overflow at either size; keyboard Tab order walked with real Qt key events.

Limits: MpvQt video decoding and playback, the compiled `recording-studio` binary, real capture, physical keyboard/touch, screen readers (Orca), fractional scaling and high-contrast themes were not exercised. Model and user content remain plain text.

## Settings, assistant, processing and English — alpha.14

The Studio QML is now split into component and dialog files. Journeys run the real QML through `scripts/studio-qml-runner.py`, a PySide6 port of `main.cpp` (same argv, JSONL validation, timeouts, reconnection and snapshot receipts), offscreen with software rendering and synthetic bridges. CI runs them with PySide6 6.11.2 pinned by hash. `bash scripts/test-studio-journeys.sh` runs all of them. They fail when the QML does not load or logs a `ReferenceError`; the settings, process, agent and local journeys also fail on `TypeError` and binding warnings.

| Journey | Screens | Assertions | What it covers |
| --- | --- | --- | --- |
| `settings-ux` | 53 | 197 | First use opens the assistant; recommended defaults; picking the local preset over a saved OpenAI setup diagnoses the draft and offers the missing Ollama model; the assistant and Settings still stop the call monitor when the service status cannot be read; Finish waits for a running model download and for an unanswered download request; a failed key write keeps the assistant on review with the key; Finish waits for the OpenAI key an OpenAI setup needs, and for the Gemini key a Gemini setup needs; review flags the missing local models of the recommended defaults, leads to the step that offers them, and the last page does not say all set; the same for missing FFmpeg, automatic recording on a backend that cannot record, an unconfigured remote worker, a call monitor or processing timer left off, also with an unknown state, and a running monitor left on an earlier configuration; a model downloaded while transcription uses OpenAI stays unselected until **Usar este modelo**; a lost key request unlocks the key fields, and a lost key test unlocks the Test buttons; a lost connection stops the assistant until it reads the configuration again, also when that reread fails; Settings diagnoses the draft and flags a diagnostic the draft outgrew; Finish waits for an Ollama pull started in the assistant; a list pending from before a save does not keep the library on the previous folder; a double click starts one download; an installed recommended model is offered when the configured file is missing; save and restore list the library again; a double-clicked restore sends one restore; a saved key whose status cannot be read again is still reported as saved; audio test; an OpenAI key typed in the assistant waits for Finish (closing sends no key; Finish sends the configuration, then the key once); the assistant cancels a running download and still applies the reviewed services after a save that returns no values; a stopped timer shows as stopped; a restore whose reread fails still reports success and reads again; the assistant stops an installed monitor when detection is turned off; two running downloads are both polled; all ten sections; a cleared vocabulary is saved as empty text while a cleared required field stays an unfinished edit; a cancelled download refreshes the model it named; presets; write-only keys (the value never appears in output; the receipt keeps only its SHA-256); model download with explicit consent; Settings lists and pulls Ollama models at the draft's address and refuses a pull from a list read at another one; the key section warns when the user services' environment cannot be read; remote and OBS checks; nullable fields; services and timers; backup restore; save sends exactly the diff; compact layout; discard; saved English; live language preview and discard; assistant in English. A guard fails the journey on any save, service, key, download or restore the mode did not intend. |
| `process-ux` | 7 | 26 | **Process…** for local, external, remote, changed-plan, retry, nothing-to-do and completed recordings; a remote plan names the worker; `recording-process` is sent only after consent and only with the plan's consent key. |
| `agent-ux` | 3 | 11 | Connection commands for the active agent grant only; none for revoked or provider grants; no authorization change. |
| `desktop-ui` | 13 | 16 | Previous library, detail, consent and capture states, the main window in English, and a legacy stop that reports a warning. |
| `local-ux`, `scope-ux`, `planner-ux`, `heavy-ux` | 31 | 73 | Unchanged journeys; the synthetic frames modes now wait for the preview and result instead of fixed delays, while the real-flow modes and the scope and planner journeys still use fixed delays. |

`src/desktop/__tests__/i18n.test.ts` fails if any `t()` literal lacks an English entry, if an entry loses placeholders or joining spaces, or if real diagnostic, capture, queue, model and key-test messages come out in Portuguese.

Limits: the shipped `recording-studio` binary, MpvQt playback, real capture, real providers and model downloads, physical keyboard and screen readers were not exercised. Native file dialogs are loaded on demand and were not opened. The system-Qt build path was not compiled on a machine with Qt 6.10 and MpvQt.
