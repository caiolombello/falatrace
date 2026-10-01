# Lean roadmap

The alpha prioritizes safe recording state, traceable context and explicit data boundaries.

1. **Native recording validation:** test supported desktops/backends with specific user consent; verify visible REC, pause future automation versus stop current capture, interruption recovery, and bounded dependencies. Done when real tests pass with private recordings retained locally.
2. **Reviewable summaries:** source jumps per claim, original versus approximate timestamps, uncertainty and provider/destination displayed. Done when a seeded unsupported claim is visibly flagged and a reviewer can reach its source; evaluate model quality separately from scripted fixtures.
3. **Visual context in the UI:** alpha.3 implements a locally tested opt-in transcript-first adapter with requests tied to validated timestamps, persistent frame/inference/byte budgets, cancellation, hash/cache, TTL and explicit cleanup. Synthetic selections, scoped results, budgets, cancel/error and explicit consent have offline coverage. Native playback and semantic model validation remain pending; see ALPHA3.md.
4. **Provider / privacy onboarding:** show local/external destination, dependencies, retention and deletion scope before processing. Done when new users can explain where their data goes and existing config remains intact.
5. **Portable release:** reproducible source install, cold download, runtime/license notices, native accessibility and desktop validation. Done before shipping binaries or broader-platform claims. Source-only Linux alpha stays explicit until then.

No chat/API entitlement is bundled. Costs and latency depend on configured providers; retries/cancellation do not retract data already accepted by them. Remote unified deletion and complete multi-file transactional publication remain future work.


## Speaker corrections and subtitles — planned, not implemented

The following items are planned in priority order. They require separate implementation and validation; adding this section does not enable transcription, diarization or paid inference.

1. **P1 — Versioned human corrections.** Preserve stable recording/segment/speaker IDs and the original transcript. Store each human correction of a name or attribution with revision and provenance; propagate the corrected view to bounded context, summaries and exports, invalidating affected derived artifacts. Done when synthetic corrections, undo and concurrent revisions produce consistent views without rewriting historical evidence or treating an unconfirmed voice label as a confirmed person.
2. **P1 — Explicit timing provenance and granularity.** Carry provider/source, word/segment/block granularity and verified/estimated/unknown precision through every artifact and UI. Preserve existing timestamps without inventing word alignment. Done when fixtures for native word timing, approximate blocks and missing timing render/export their actual limits; measured accuracy remains a separate benchmark.
3. **P1 — Complete overlapping cues and subtitle export.** Display all simultaneous active cues, including speaker labels where available. Provide SRT/VTT export preserving canonical text and timestamps, with explicit format limitations and deterministic conversion. Done when overlaps, boundaries, Unicode, multiline cues and round-trip fixtures retain all content; no hidden retranscription or provider call occurs during export.
4. **P2 — Explicit microphone/desktop track selection.** Inspect and select existing mix/microphone/desktop tracks, preserving source metadata and fallback choices. A track is not a person. Done when multi-track and single-track synthetic media select the requested track predictably and missing tracks fail visibly without changing originals or silently assigning identities.
5. **P2 — Acoustic validation and CPU checkpoints.** Evaluate diarization/alignment separately with consented, labeled samples; report error/uncertainty instead of claiming quality from fixtures. Add durable checkpoints between transcription, alignment, diarization and derived processing, respecting call/capture activity and cancellation. Done when interrupted offline work resumes without duplicate provider work, active calls defer the next heavy stage, and pre-consented native measurements report CPU/latency bounds.

Compatibility criteria for every item: preserve legacy files and identifiers; make migration explicit and reversible; do not enable biometric identification or voice enrollment by default; do not infer a real name from a voice, channel or camera image. No change here authorizes capture, external uploads or paid API use.


## Replaceable memory adapters — planned, not implemented

Evaluate [ai-memory](https://github.com/akitaonrails/ai-memory) first as an integration candidate; compare [OptMem](https://github.com/VictorTaelin/OptMem) as an experimental alternative before selecting a backend or promising support for both. This is a roadmap item, not an installed integration. Preserve the existing local knowledge store and recording evidence; do not enable hooks, embeddings, migration or provider calls implicitly.

**P1 — Offline adapter comparison.** Define a versioned, replaceable import/export contract using synthetic fixtures. Every remembered claim must retain recording ID, media/transcript hashes, source timestamp and timing precision, revision, and observation versus inference. Human name corrections must update the derived view without changing the original evidence. Treat recalled text as untrusted data, never executable instructions or authority over consent.

Done when both candidates have a documented compatibility matrix covering license/notices, local isolation and cross-project boundaries, correction/undo, revocation, deletion and derived-index invalidation, schema migration and round-trip export. Measure retrieval quality, storage, latency, context/token budgets and any model cost with reproducible fixtures before choosing. Backend changes and session restarts must not reset persistent budgets or restore revoked material. External processing remains explicit and separately consented.

**Deletion gate:** OptMem currently documents an append-only original log; `forget` discards a summary that may be rebuilt from that log. That is not demonstrated removal of the original entry. ai-memory also documents preserved git/version history. Evaluate purge, backups, indexes and previously exported copies explicitly for both; neither repository's retention design establishes FalaTrace deletion compliance. Verify pinned licenses before redistribution or dependency adoption, including OptMem's license status, which was not established by this bounded README inspection.

Source review: official repository READMEs inspected on 2026-10-01. No package was downloaded, installed or activated and no private memory was sent to either project.
