# Completion goal and finite roadmap

Alpha.14 checkpoint, 2026-10-06: every option, API keys, model downloads, services and timers are managed from the Studio, with a guided first use, destinations shown before manual processing, an English interface and an install path from source (`make install-studio`). This covers the configuration and disclosure parts of the provider/privacy onboarding item; whether new users can explain where their data goes has not been checked with people. It also adds a source install path for the Studio to the portable release item. CI now renders the real QML offscreen; native journey validation on a physical desktop remains open.

Alpha.13 checkpoint, 2026-10-05: the Studio has a full settings dialog (automatic recording, capture and audio, processing and AI, services and diagnostics) with guided first use, closing the configuration part of the provider/privacy onboarding item. Native journey validation on a physical desktop remains open.

Alpha.12 checkpoint, 2026-10-05: explicit Chromium, Chrome, Brave, Edge, Vivaldi, Opera, Firefox, native Zoom and Teams for Linux identities (Discord, Signal, Telegram and Element opt-in) are implemented with classifier fixtures, closing the identity part of gap-batch item 2. Native acceptance per app/desktop/backend tuple remains open; see [compatibility](COMPATIBILITY.md).

Alpha.11 source checkpoint, 2026-10-03: the isolated G4/G5/G7 compatibility candidate adds
reviewed-view consumers, explicit revision-bound local summary regeneration,
frame consent/result revision binding and non-executable removal planning.
See [snapshot compatibility](REVIEWED-SNAPSHOT-COMPATIBILITY.md). Original
artifacts and prior candidates are preserved. This product is included in the
alpha.11 source release; installation readback remains a separate receipt. This
cut does not complete unified purge, validate models/capture or implement track
selection and replaceable memory. Earlier statements below are historical
checkpoints; see ALPHA11.md for the current delivered source scope.

Roadmap documentation, reviewed 2026-10-01; the alpha.7 application and release artifacts are unchanged. This goal defines the finish line for the product roadmap, not a claim that every item below is already implemented or permission to install, capture or run a provider.

**Goal:** make FalaTrace a reviewable Linux workflow from a deliberately configured automatic recording to recovered context for the user's AI: visible recording controls, searchable recordings, transcript-first summaries, selectively requested frames tied to the actual source, explicit recipient/provider permission, persistent budgets, and data-preserving installation/recovery/deletion. The author already uses the recording/context core continuously. Broader app coverage and new AI/memory/speaker workflows need their own evidence.

“Every browser and calling app” is a direction for extending a maintained compatibility matrix, not a finite verifiable release promise. Initial finish line: the existing Helium/Zen/Slack identities plus explicit Chromium/Firefox/Zoom candidates; one declared Linux desktop/backend/audio tuple per supported row. Meeting-service behavior remains a separate row. Unsupported combinations must explain the limitation and the configured manual route, not silently claim automatic detection.

## Completion gates

| Workstream | Already delivered / evidence | Remaining finite gate |
| --- | --- | --- |
| Recording and context core | Author reports successful continuous use. Source supports configured automation and bounded retrieval. | Native acceptance of each declared app/service/desktop/backend tuple; visible REC, pause, stop, selected screen when video is configured, intended audio sources/tracks, permission denial, interruption and finalized media. No universal reliability percentage without a benchmark. |
| Safe setup and release | Non-overwriting init, preserved identifiers/data, frozen dependency source release, notices and installed alpha.7 readback have prior receipts. | Fresh cold-download install/uninstall and native accessibility/runtime checks before binary or wider-platform claims. Existing cached bootstrap evidence remains distinct. |
| Summary trust and visual context | Production adapters/Studio flow, timestamp/source validation, consent/cancel/cache and persistent budgets have synthetic offline coverage. | A finite consented quality benchmark for supported models; every returned claim must keep observed/estimated/unknown timing and distinguish observation/inference/unsupported content. Real playback/source jump and spontaneous assistant frame choice need native/model evidence. |
| Speakers and subtitles | Alpha.7 displays diarizer text and simultaneous existing cues; stale/unknown status is explicit. | Diagnose one explicit generation attempt without automatic retry; versioned human corrections/undo; timing granularity; deterministic SRT/VTT export. No voice identity or acoustic quality promise from fixture rendering. |
| Tracks and long work | Capture writes separate mix/microphone/desktop tracks when configured; bounded chunking exists. | Explicit existing-track selection, missing-track disclosure and stage checkpoints/cancellation with no duplicate inference or budget reset. Evaluate acoustic quality separately on consented labeled data. |
| Replaceable memory | Existing local text context remains; candidate projects were read only. No durable visual-memory integration is active. | Offline adapter/license/deletion comparison, then a recorded choice. Implement only a compatible chosen contract with source/revision/recipient invalidation, revocation and purge scope; reject an unsuitable backend explicitly. No implicit retention expansion or integration claim for both projects. |
| UX / UI | Coherent Studio/CLI identity and prior synthetic journeys; this documentation update improves PT/EN positioning and web QA. | Run the journey matrix for the chosen native tuples: first use, recording, library/search, source jump, frames/consent/budget, provider/privacy/delete, export and cancel/recover; keyboard/focus/Esc/back/close, errors/partial/empty and responsive states. Keep synthetic/native results separate. |
| Compatibility and truthful positioning | Reviewed code/vendor matrix; author use is attributed prominently in PT/EN. | Initial gap batch in COMPATIBILITY.md, exact tuple receipts and docs matching actual supported behavior. No public claim from installed metadata alone. |

**Roadmap is complete for the declared scope when:** all remaining chosen implementation items have passing regression evidence; each claimed native tuple has its acceptance receipt; data/consent/budget/source invariants pass; limitations and unsupported combinations are visible; source/artifact hashes and licenses are reviewable; and any publication has its own authorized final gate. A blocked native/model/license gate stays blocked with its exact reason rather than being declared done. No paid API, secret/private-media transfer or expanding active services is implied by this goal.

## Execution order and stop points

1. **This documentation batch:** reviewed value-first PT/EN copy, precise compatibility matrix, small gap proposal and web QA. Only documentation is published; no application integration, capture, provider execution or installation is enabled. Application work continues through separate reviewed increments.
2. **Next local implementation candidate:** diagnostics/fixtures, two explicit browser identities, one native-app identity, backend boundary and migration tests. Preserve default disabled/notify-only behavior and the original WIP. Ship no compatibility claim until the applicable native gate passes.
3. **Source and correction candidate:** reliable subtitle operation evidence, human corrections, timing/export and explicit track selection with synthetic fixtures. Keep original media/transcript and stable IDs intact.
4. **Context candidate:** evaluate selected model/assistant behavior separately; then finite memory adapter choice/contract with deletion and isolation proof. Do not enable new data sharing through old grants.
5. **Native validation and distribution:** deliberately consented calls/fixtures, frozen install, accessibility and environment matrix. Publish only the reviewed supported scope under separate authorization for each new increment.

## Existing workstream detail

The alpha prioritizes safe recording state, traceable context and explicit data boundaries.

1. **Native recording validation:** test supported desktops/backends with specific user consent; verify visible REC, pause future automation versus stop current capture, interruption recovery, and bounded dependencies. Done when real tests pass with private recordings retained locally.
2. **Reviewable summaries:** source jumps per claim, original versus approximate timestamps, uncertainty and provider/destination displayed. Done when a seeded unsupported claim is visibly flagged and a reviewer can reach its source; evaluate model quality separately from scripted fixtures.
3. **Visual context in the UI:** alpha.3 implements a locally tested opt-in transcript-first adapter with requests tied to validated timestamps, persistent frame/inference/byte budgets, cancellation, hash/cache, TTL and explicit cleanup. Synthetic selections, scoped results, budgets, cancel/error and explicit consent have offline coverage. Native playback and semantic model validation remain pending; see ALPHA3.md.
4. **Provider / privacy onboarding:** show local/external destination, dependencies, retention and deletion scope before processing. Done when new users can explain where their data goes and existing config remains intact.
5. **Portable release:** reproducible source install, cold download, runtime/license notices, native accessibility and desktop validation. Done before shipping binaries or broader-platform claims. Source-only Linux alpha stays explicit until then.

No chat/API entitlement is bundled. Costs and latency depend on configured providers; retries/cancellation do not retract data already accepted by them. Remote unified deletion and complete multi-file transactional publication remain future work.


## Speaker corrections and subtitles — local candidate, partially implemented

The isolated G5/G7 candidate implements versioned human overlays, stable IDs,
explicit editor CAS, undo and controlled context invalidation, together with local
JSON/Markdown/SRT/WebVTT export and snapshot-bound previews. Original artifacts
are preserved; edited words do not acquire a new acoustic alignment. See
[Human review and export](HUMAN-REVIEW-EXPORT.md) for contracts and limits. This
candidate is now included in alpha.11 source; installation is separately verified, and real model quality and native playback are
not inferred from offline fixtures. Legacy consumers now use reviewed views;
explicit summary regeneration and revision-bound frames have production routes
tested with stubs. Studio now composes the same explicit plan/consent/run/cancel
contract through its Summary tab, without enabling disabled settings. Automatic
regeneration and unified export purge remain gaps; real model quality is unvalidated.
Original APIs remain historical, and repeated frame analysis can be refused by
the existing persisted identity lock. The criteria below remain
separate; text-only completion does not close the entire roadmap.

The following items are planned in priority order. They require separate implementation and validation; adding this section does not enable transcription, diarization or paid inference.

1. **P1 — Versioned human corrections.** Preserve stable recording/segment/speaker IDs and the original transcript. Store each human correction of a name or attribution with revision and provenance; propagate the corrected view to bounded context, summaries and exports, invalidating affected derived artifacts. Done when synthetic corrections, undo and concurrent revisions produce consistent views without rewriting historical evidence or treating an unconfirmed voice label as a confirmed person.
2. **P1 — Explicit timing provenance and granularity.** Carry provider/source, word/segment/block granularity and verified/estimated/unknown precision through every artifact and UI. Preserve existing timestamps without inventing word alignment. Done when fixtures for native word timing, approximate blocks and missing timing render/export their actual limits; measured accuracy remains a separate benchmark.
3. **P1 — Subtitle export; overlapping cue display delivered in alpha.7.** Alpha.7 displays simultaneous existing cues, including supplied speaker labels. Provide SRT/VTT export preserving canonical text and timestamps, with explicit format limitations and deterministic conversion. Done when overlaps, boundaries, Unicode, multiline cues and round-trip fixtures retain all content; no hidden retranscription or provider call occurs during export.
4. **P2 — Explicit microphone/desktop track selection.** Inspect and select existing mix/microphone/desktop tracks, preserving source metadata and fallback choices. A track is not a person. Done when multi-track and single-track synthetic media select the requested track predictably and missing tracks fail visibly without changing originals or silently assigning identities.
5. **P2 — Acoustic validation and CPU checkpoints.** Evaluate diarization/alignment separately with consented, labeled samples; report error/uncertainty instead of claiming quality from fixtures. Add durable checkpoints between transcription, alignment, diarization and derived processing, respecting call/capture activity and cancellation. Done when interrupted offline work resumes without duplicate provider work, active calls defer the next heavy stage, and pre-consented native measurements report CPU/latency bounds.

Compatibility criteria for every item: preserve legacy files and identifiers; make migration explicit and reversible; do not enable biometric identification or voice enrollment by default; do not infer a real name from a voice, channel or camera image. No change here authorizes capture, external uploads or paid API use.


## Replaceable memory adapters — planned, not implemented

Evaluate [ai-memory](https://github.com/akitaonrails/ai-memory) first as an integration candidate; compare [OptMem](https://github.com/VictorTaelin/OptMem) as an experimental alternative before selecting a backend or promising support for both. This is a roadmap item, not an installed integration. Preserve the existing local knowledge store and recording evidence; do not enable hooks, embeddings, migration or provider calls implicitly.

**P1 — Offline adapter comparison.** Define a versioned, replaceable import/export contract using synthetic fixtures. Every remembered claim must retain recording ID, media/transcript hashes, source timestamp and timing precision, revision, and observation versus inference. Human name corrections must update the derived view without changing the original evidence. Treat recalled text as untrusted data, never executable instructions or authority over consent.

Done when both candidates have a documented compatibility matrix covering license/notices, local isolation and cross-project boundaries, correction/undo, revocation, deletion and derived-index invalidation, schema migration and round-trip export. Measure retrieval quality, storage, latency, context/token budgets and any model cost with reproducible fixtures before choosing. Backend changes and session restarts must not reset persistent budgets or restore revoked material. External processing remains explicit and separately consented.

**Deletion gate:** OptMem currently documents an append-only original log; `forget` discards a summary that may be rebuilt from that log. That is not demonstrated removal of the original entry. ai-memory also documents preserved git/version history. Evaluate purge, backups, indexes and previously exported copies explicitly for both; neither repository's retention design establishes FalaTrace deletion compliance. Verify pinned licenses before redistribution or dependency adoption, including OptMem's license status, which was not established by this bounded README inspection.

Source review: official repository READMEs inspected on 2026-10-01. No package was downloaded, installed or activated and no private memory was sent to either project.
