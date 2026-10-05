## Unreleased — Studio settings and first-use setup

- Add a **Configurações** dialog to the Studio with four tabs: automatic recording (per-app switches, mode, timing), capture and audio (backend, devices listed from PipeWire/PulseAudio, encoder, profile, recordings folder), processing and AI (transcription/summary providers, models, Ollama URL, local/remote, automatic processing) and services and diagnostics. It opens once automatically when no configuration exists.
- Saving publishes only the changed fields from an explicit allowlist, with the existing revision check, private backup and preservation of unknown keys and secrets. API keys are reported as present/absent with their source, never read or written by the Studio.
- Read-only diagnostics check FFmpeg, Whisper.cpp and its model file, Ollama on loopback with installed models, API key presence and the recording backend, without recording, transcribing or contacting external hosts.
- Apply/restart or disable the call monitor and (re)install the tray from the Studio; refused during an active capture. Diagnostics flag a monitor running with an older configuration or a stale recordings folder. Generated units now prefer the stable `~/.local/bin` link of the running release.
- The previous privacy screen remains available as **Rotas e privacidade…**.

## 0.2.0-alpha.12 — more call apps and a redesigned Studio

- Rebuild the Studio presentation with a single-file component system (buttons, fields, chips, cards, dialogs and inline SVG icons) on the FalaTrace tokens; follow the desktop color scheme and keep the manual light/dark switch.
- Open on a library overview with counts, recent recordings and first-use guidance; empty, loading, error and disconnected states explain what happened and offer the next action.
- Keep capture state, **Gravar…**/**Parar captura** and **Pausar novas gravações**/**Retomar automação…** in the header; capture consent keeps Cancel focused by default.
- Recording view: metadata chips, recording actions in the header, a wider tabbed panel, transcript segments with inline review, a plain-text structured summary with source-time buttons and a structured AI-context view (copying still exports the original JSON). Model and user text are never rendered as rich text.
- Keyboard: the library list joins the Tab order (arrows move, Enter/Space open) and recent-recording cards are focusable.
- Consent, budgets, stale-response guards, the bridge protocol and test-referenced IDs/functions are unchanged. Verification and limits: [UX verification](docs/UX-VERIFICATION.md#studio-redesign--unreleased).
- Load the Studio library faster: meeting titles are read with bounded concurrency, concurrent library reads (forced or not) share one build and a redundant revision check was removed (283 recordings: ~5.5 s → ~1.65 s; identical output). At startup the Studio shows the last complete list from a private presentation-only snapshot (~0.2 s) and replaces it with the fresh list.
- OpenAI summaries size their input to the chosen model's context window, measured in UTF-8 bytes so a single request cannot exceed it in any language (unknown models assume 128k tokens). Meetings longer than the 24k-character default no longer fail as a refused paid multi-request split; checkpoints saved under the earlier budget are reused. Ollama keeps the configured character budget; the explicit paid-budget guard is unchanged.
- Raise the OpenAI summary output cap to 16,384 tokens for reasoning models and report a truncated reply explicitly.
- Default OpenAI summary and timesheet classification model: `gpt-6-luna` (was `gpt-4o-mini`). Existing configurations and recorded jobs keep their model.
- The About dialog shows the installed release directory and commit from its manifest, so local builds with the same version are distinguishable.
- Fix a Studio freeze of ~15–20 s after the library loads: recent recordings were sorted with `Date.parse` on numeric timestamps, which fell back to Qt's slow date parser for every comparison (and left the order wrong). The packaged Studio now also requests the saved library on connection, keeps it when a fresh list fails, and creates the snapshot directory when missing.
- Automatic call detection recognises more apps through one explicit allowlist (`src/calls/apps.ts`): Chromium, Google Chrome, Brave, Microsoft Edge, Vivaldi, Opera, Firefox, the native Zoom client and Teams for Linux are on by default; Discord, Signal, Telegram and Element are opt-in (`callDetection.apps.<id>: true`) because they also carry personal calls. Matching stays exact by process binary/name/ID; Electron apps that announce themselves as "Chromium input" (ChatGPT, editors) are not treated as Chromium, and Snap Chromium is told apart from Chrome on the shared `chrome` binary. Existing app switches are preserved and older network probes remain accepted. Fixture coverage only; native acceptance per app is still pending.
- OpenAI summary limits recognise the verified `gpt-4.1` (1,047,576 tokens) and `gpt-5`/`gpt-5-mini`/`gpt-5-nano` (400,000) context windows.

## 0.2.0-alpha.11 — reviewed source, exports and Studio summary consent

- Add revision-bound transcript/speaker corrections and undo, reviewed consumers and snapshot-bound JSON/Markdown/SRT/WebVTT export.
- Compose explicit local summary plan, destination/input/cost disclosure, consent, generation and cancellation in the Studio; preserve disabled settings and separate frame consent.
- Bind visual evidence to reviewed revisions, reject summary redirects and protect legacy processing from stale writes.
- Preserve configuration through onboarding save/cancel/conflict/recovery; add non-executable removal planning without claiming unified deletion.
- Candidate verification: 759 offline tests, six checks and 8 Qt summary journeys; synthetic inference does not establish real model/capture quality. See [alpha.11 scope](docs/ALPHA11.md).

## 0.2.0-alpha.10 — experimental transcript, audio and title fixes

- Keep verified local transcripts available after later summary failure, with explicit artifact readiness and provenance; never implicitly reprocess on retrieval.
- Refuse paid transcription dispatch for complete digital silence or unknown measurement, preserving the original media; retain short/quiet/late signal eligibility.
- Recover eligible cancelled startup without overlapping captures; surface selected/default audio warnings without automatic retargeting.
- Flush the audio-only FFmpeg output to avoid startup buffering; synthetic PCM/duration/track metadata remain equal to control.
- Preserve existing Studio titles or show date/time/timezone fallback, update headers safely and distinguish older displayed content from current processing.
- Frozen behavior candidate: 607 offline tests passed in one aggregated suite. See [alpha.10 scope and verification limits](docs/ALPHA10.md). Source-only Linux; follow-default/headsets and full native downstream remain unqualified.

## 0.2.0-alpha.9 — experimental detector and Studio reading fixes

- Preserve a known PipeWire node state when a delta omits it; explicitly invalid or unknown state still fails closed. Persisted monitor state must be a string.
- Decode streamed UTF-8 across byte boundaries and enforce the existing 16 MiB parser limit in bytes.
- Keep long captions readable in a bounded scrollable area; improve keyboard focus, two accessible field names, contrast and the footer in short windows.
- Distinguish missing or unresolved media from recording availability; no automatic capture, provider dispatch, retry or driver changes.
- Add synthetic detector, parser and missing-source regressions. The consolidated candidate passed 562 offline tests; these are the frozen candidate results, separate from release checks and CI.
- A deliberately paused synthetic H264 frame was visually confirmed on one AMD/Wayland setup. Forced llvmpipe remained unreliable; broader playback, native capture, physical audio/AVsync, assistive technology and real model quality remain unqualified. See [alpha.9 scope](docs/ALPHA9.md).

## 0.2.0-alpha.8 — experimental caption UI fix

- Keep the caption preference operable during missing-track/loading states; focused Space toggles captions instead of playback.
- Prefer existing segment captions, with a reviewed, explicitly automatic/partial fallback from existing timed diarizer utterances.
- Preserve canonical transcript and speaker artifacts; approximate block text never becomes caption text.
- No automatic provider dispatch, generation, capture, remote-worker repair or acoustic quality certification.

## 0.2.0-alpha.6 — experimental source alpha

- Default omitted timesheet automation and AI classification flags to false, including existing enabled profiles; preserve explicit choices and configuration bytes.
- Keep a pending native-build marker through failure or interruption; retry compilation before execution and clear the marker only after a new regular output exists. Verification covers one serial build runner.
- Resolve exact client codes before aliases; preserve punctuation-distinct codes and refuse ambiguous normalized matches.
- Remove stale client context only after checking a regular file's complete generation marker and identity; preserve unmarked, unreadable unknown and symbolic-link files.
- Document the existing optional local time-entry catalog with custom client/task identities, empty initial catalogs and preserved legacy identifiers. No corporate submission adapter is added.
- Show the running Studio version and local build ID in About, with the connected CLI version and a mismatch notice; align MCP version metadata with the package. Published-version status is not checked over the network.
- Reviewed candidate: 486 offline tests passed, 0 failed, 3,835 assertions across 81 files in 108.98 seconds. See [alpha.6 scope and validation limits](docs/ALPHA6.md). Source-only Linux release; no extra dependencies, bundled models/native runtimes or public binaries.

## 0.2.0-alpha.5 — experimental source alpha

- Persistent, explicit grants for named agents and selected recordings; separate frames-only installation opt-in for current/future registered media, with pause, revocation and operator exclusions.
- Local JPEG retrieval with verified/unknown timestamps, source hashes, private TTL and lifetime installation budgets. No implicit grants or provider authentication claims.
- Separate OpenAI/Google analysis adapters, disabled by default; partial observations, without complete-summary regeneration or durable visual memory.
- Studio navigation, fixed consent/error actions, visible keyboard focus and immediately accessible capture stop.
- Equivalent Portuguese and English landing pages with accessible language links and honest experimental limits.
- 447 offline tests passed. Synthetic fixtures/stub transports do not certify native capture, actual model quality or billing. No extra dependencies or public binary distribution.

## 0.2.0-alpha.2 — experimental source alpha

Production Studio visual consent/adapter/summary path with persistent root guard; Opus-reviewed findings fixed and offline/synthetic validation documented. No installed-model/capture quality certification, or redistributed binaries.

# 0.2.0-alpha.1 — experimental source alpha

- Add source-margin identity, dark/light Studio themes, compact layout, deliberate capture/resume confirmation and stale-response/focus guards.
- Preserve CLI structured output and add journey-level UX verification with synthetic Qt renders.
- Introduce FalaTrace branding and an MIT license for author-owned code; preserve legacy recording-cli configuration/state identifiers.
- Preserve existing configuration on init and separate installation from privileged OS dependencies; uninstall keeps data.
- Default fresh installs to explicit local processing with automation disabled.
- Retain failed media and unknown content; invalidate derived memory before local deletion and report preserved remote scope.
- Add source/parameter fingerprints, private atomic artifacts and fail-closed transcript cache.
- Add bounded long-summary chunks with resumable checksums and global transcript references.
- Add opt-in internal transcript-linked visual selection, budget ledger, selective extraction and explicit frame TTL.
- Propagate cancellation and remove hidden SDK retries; preserve review warnings/provenance.
- Include offline synthetic regression, benchmark and scripted demonstration tools.

Native capture/desktop compatibility and semantic model quality are unvalidated in real environments. Visual selection is an internal API without a CLI toggle. No binary/model/native-runtime distribution is part of this release.

## 0.2.0-alpha.4

- Shareable MIT FalaTrace skill with real command/output references, bounded retrieval, explicit-consent visual guidance and synthetic contract validation.
- Version/help use the package version; previous alpha.3 tag remains unchanged.

## 0.2.0-alpha.3

- Transcript-first scoped review, persistent policy/consent/attempt guards and processing admission. Call-light remains opt-in; native/model/call-performance limits remain explicit.
