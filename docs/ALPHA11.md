# FalaTrace 0.2.0-alpha.11

Experimental Linux source release: reviewable transcripts and speakers, exports, safer configuration journeys and explicit Studio summary regeneration. The approved product snapshot contains 353 files and local BuildId `302b9086ef3a`; release version and documentation change the final source fingerprint without changing that product code.

## Changes

Human edits use stable IDs and revision-bound private sidecars, with concurrent-edit guards and monotonic undo. Original transcript, diarization and media are preserved. An identical speaker code in another source is not an identity match: human linkage must be explicit. Revised views feed library/search/context/player consumers and exports. Edited words do not acquire new acoustic alignment; unsupported captions are refused.

JSON/Markdown/SRT/WebVTT export previews bind to an exact snapshot and preserve timing granularity, overlap, Unicode and uncertainty. A newly regenerated summary invalidates an old export preview. Exported copies outside the application remain independently retained.

The Summary tab composes production plan/consent/run/cancel contracts. It displays configured local Ollama model, loopback destination, revision, input size/context and request limit before explicit consent. Monetary cost is unknown; no free-compute claim is made. Settings and automatic processing are not enabled. Frames require their existing separate consent. Results bind to the reviewed snapshot; original artifacts remain available. Notes without source timing and acoustic labels are provenance metadata, excluded from model input.

Summary limits persist across session/restart: 32 lifetime plan slots per recording, at most 8 provider requests per plan. This is not a global token/spend budget. Double actions deduplicate; cancelled/stale requests do not publish; model errors/revision conflicts require a new explicit plan. Cancellation cannot retract input already accepted by a provider. Local Ollama summary transport refuses redirects, preserving the disclosed destination.

Visual previews/consent/results bind to the reviewed revision. Existing persistent visual limits remain; new consent/session does not reset consumption. An existing provider/model/transcript lock may refuse reanalysis after edits. No new frame consent or automatic inference is added.

Configuration onboarding preserves existing options/secrets and supports cancel, conflict detection, uncertain save recovery and explicit destinations/dependencies. Removal planning is a non-executable dry-run with inventory/ownership checks. Legacy deletion still preserves documented sidecars/remotes/auxiliary state; unified purge is not implemented.

## Verification

Approved candidate: 759 offline tests, 0 failures, 6468 assertions across 107 files; six type/build/diff checks. Final versioned release checks and CI are recorded separately for their exact commit. The Studio summary journey passed 8/8 real-QML offscreen cases with 194 checks and 45 native Qt input events. Controller/bridge/parser/persistent summary contracts are production; model responses and navigation/status/detail presentation are synthetic fixtures. Full production detail JSONL, physical desktop, playback and AT-SPI are not qualified by this proof.

Cases cover explicit consent, double-click deduplication, Cancel/Esc/selection/late results, revision conflict and model error. Regression tests cover EOF during asynchronous preflight, cancellation in a saturated queue, immediate abort before a delayed source read and cancelled plans registering late. Eight consent-indicator states measured from actual PNGs have minimum border/background 5.041:1 and check/fill 6.025:1; this is not whole-product WCAG certification. Prior G4/G5/G7 receipts remain separate and overlapping counts are not summed.

No real model, capture, private meeting reprocessing, purge or external provider was executed to establish these results. A source release does not authorize any of them. Quality/precision of actual ASR, speakers, summaries and visual interpretation requires separate consented evaluation.

## Limits

Linux source distribution only. Native capture/backend compatibility, physical audio/AVsync, playback/source jump/client frame acceptance, assistive technology, complete unified deletion, track selection, durable execution completeness, replaceable memory evaluation and cold-download installation remain open gates. The earlier narrowly scoped AMD synthetic H264/frame evidence is historical, not a new hardware test. Headset/default-follow remains unimplemented; existing capture keeps its startup source.

No dependency, model, runtime binary, private configuration/media/transcript, operational receipt, Library artifact ID or private Git history is bundled. MIT applies to original code; third-party notices remain. Existing persisted recording-cli identifiers and explicit provider choices are preserved. Chat subscriptions do not automatically include API usage.

## Installation and rollback

The alpha.10 release remains available. Update application/skill only in a freshly qualified safe maintenance window. Active captures and processing are not stopped to create that window. Refresh only previously active passive monitors after safe pause acknowledgement, retaining prior application/skill and rollback receipts. Restore prior unpaused automation with a fresh acknowledgement and verify timer/profile states. Never restore jobs/configuration/media/grants/budgets from stale state snapshots. Do not blindly repeat an APPLY after maintenance has started; reconcile the retained ledger first.

This source document describes the procedure, not an installed-state receipt. About/CLI/MCP and actual monitor bindings must be checked separately after installation. Existing MCP sessions may need reconnecting to use the new executable.
