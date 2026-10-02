# FalaTrace 0.2.0-alpha.9

Experimental Linux source release: focused detector and Studio reading improvements. The existing automatic-recording and AI access controls remain explicit and configurable.

## Changes

Properties-only PipeWire deltas preserve a node's last valid state. New nodes without a known live state and deltas containing explicitly invalid or unknown state fail closed. Persisted monitor state accepts a string rather than stringifying arrays or other values. The streamed JSON parser preserves UTF-8 characters split across byte chunks and enforces the existing 16 MiB bound in UTF-8 bytes.

Long captions stay inside a bounded scrollable region, retaining keyboard focus and transcript source navigation. Contrast, accessible names for two existing fields and the footer in windows at or below 720 pixels high are improved. Missing or unresolved media receives an accurate message; this does not recover a lost source or alter a recording catalog.

No new provider, dependency, grant, configuration migration, automatic retry or recording action is introduced. Existing source timestamps and automatic/partial caption disclosures remain intact. No global or product renderer override is added.

## Verification

The consolidated pre-release candidate passed one complete offline aggregate: 562 tests, zero failures and 4,453 assertions across 87 files, with no excluded files. These are frozen candidate results; final release checks and CI are separate. Cache-only frozen-lock bootstrap, project/desktop typechecks, compiled CLI and local Studio metadata are verified for release preparation. CI records the exact public commit. Source and skill assets carry SHA-256 checksums; native binaries remain local and are not distributed by this release.

Synthetic fixtures cover omitted/invalid node state, attribution boundaries, UTF-8 chunking and the byte limit, missing sources, captions and CLI contracts. Production QML was exercised with synthetic catalog/transcript/resolver stubs; decoder and playback time were real in the narrowly scoped temporal checks. Overlapping cues and a source jump retained their temporal reference.

A deliberately paused synthetic H264/frame38 near 2.533 seconds was visually confirmed on one AMD/radeonsi/Wayland setup. The same diagnostic under forced llvmpipe showed black video and a single repaint did not repair it; earlier mixed results are retained. Removing the test process's software override selected a working AMD context without changing product code or drivers. This identifies one working combination, not a universal fix or an internal driver diagnosis.

## Limits

General playback/codec/display compatibility, physical audio/AVsync, deliberate native capture, AT-SPI/screen-reader behavior and actual ASR/summary/vision quality remain unqualified. Keyboard/focus checks do not certify screen-reader behavior. Do not rely on generated notes or speaker labels without reviewing their source and uncertainty.

This release does not repair operational subtitle workers or recover historical missing media. No private recordings, transcripts, configuration, operational receipts or original private history are included. Linux source distribution only; other platforms and redistributed native runtimes/binaries are outside these claims. Chat subscriptions do not automatically include API usage.

## Installation and rollback

The alpha.8 tag and release remain intact. A deliberate update retains the prior release and skill, swaps application/skill only during freshly verified IDLE, and refreshes only the three previously active passive monitors after a paused-IDLE acknowledgement. Capture, jobs and timer schedules are not stopped or rewritten. Prior pause state is restored and acknowledged.

Rollback must cover application, skill and any monitors already migrated. Changing the application pointer alone does not change an existing monitor process. Revalidate IDLE, retained artifacts and concurrency before rollback; never restore configuration, jobs, media, grants or consumption from stale state snapshots.
