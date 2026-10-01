# Experimental alpha.3

Source release integrating processing admission and transcript-first visual review. Native capture, model quality, playback accuracy and improved call performance are not established by this release.

## Processing and calls

Heavy tasks share a cross-process FIFO admission guard. New tasks wait when recording/call metadata reports activity or is unknown; cancellation preserves media. Environment policy overrides are explicit. Existing configuration, providers, automation choices and `recording-cli` state identifiers remain compatible.

Call-light is opt-in: `capture.profile: "call-light"` or `record start --capture-profile call-light`, GPU only, up to 15 FPS and proportional 1280×720 output. Standard remains unchanged without an explicit profile. Lower detail can reduce frame usefulness. Device/encoder support and call audio/latency gains require native testing; no such improvement is claimed.

## Transcript-first evidence

Studio requires finalized local media, an existing transcript, loopback Ollama and compatible local models. Select an explicit interval; the planner can propose frames, choose none or abstain. Preview precedes separate inference consent. Scoped summaries preserve original IDs, timestamps, provenance and uncertainty; omitted transcript/context is not supplied. Originals and full summaries remain separate.

Existing OpenAI/Gemini processing selections are preserved, not automatically replaced. Credentials are not moved. Visual review is local Ollama only in this alpha. Opening Studio does not execute models. Stub tests demonstrate integration, not semantic quality.

The experimental programmatic contract is `preparePipelineVisualReview`, then `processJob(...visual.review)` with exact consent. Source, adapter tuple, scope/plan, policy and five-minute receipt are bound. No one-call select-and-send shortcut or new public visual CLI command. One execution per consent, bound to job/destination/session; replay needs intact result hashes. Model metadata fingerprints are not atomic weight pinning: retag between verification and request remains possible.

## Limits and retention

Shared lifetime defaults: 24 inference attempts/16 previews; explicit `visualReview` policy may set 1–1000. Counters survive failures/restarts. Scope is user installation/config namespace, not global provider/financial/subscription hardcap. Different config namespaces fail closed. Previously declared policy removal is refused once recorded in this format; old budget formats lacking that declaration have an upgrade limitation if the key is removed before first upgrade read.

Recognized derived planner cache/receipts have bounded lazy cleanup. Unknown/legacy formats and SIGKILL scratch may remain; legacy cache recovery requires explicit hash and opt-in. No background TTL guarantee, complete partial-summary history or unified local/remote deletion. Cleanup QA executed only against disposable fixtures.

## Migration

Back up configuration/state, inventory originals, retain the old installation and choose an idle point. Keep `recording-cli`/`recording-studio` compatibility aliases and existing config/state namespaces. Do not stop an ongoing call/capture or replace credentials. Installation does not activate call-light or cloud upload. Source distribution is not a certified binary package.

## Evidence

Before publication: 417 tests/71 files, zero failures, 3,414 assertions; typecheck/desktop check/build; real Qt offscreen 24 screens/56 checks with generated synthetic video/config and HTTP stubs. No microphone/screen capture or actual provider inference. Opus 5.5 source-only verification found no demonstrated remaining blocker in four specified repairs, not approval of native/model/release semantics; a subsequent owner-binding defense has regression coverage. Release CI status is verified for the exact commit separately.

Native audio/capture/call load, physical keyboard/playback/PTS, semantic/injection quality of models, all-provider onboarding, additional platforms and distributed binaries remain unvalidated.
