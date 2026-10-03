# Alpha.10 — transcript access, audio startup and Studio titles

Experimental Linux source release. This cut contains the already reviewed transcript/capture, audio diagnostics, buffering and title deltas; no new provider, model, capture permission or dependency is enabled.

## Changes

- Read verified local transcript checkpoints in Studio/CLI/context even if later summary work fails. Artifact availability and provenance remain separate from overall job state; reading does not retry transcription or invoke a provider. Invalid receipts are rejected; completed legacy publications without receipts are explicitly unverified.
- Before paid OpenAI/Gemini dispatch, measure the full extracted audio locally. Digital silence or unknown/unreadable measurement refuses dispatch and preserves media. Quiet/short/late signal remains eligible; a signal is not proof of speech or transcription quality.
- Recover one eligible cancelled startup when the call detector returns, preserving the fragment before a replacement and preventing overlap. Pause/deny does not authorize recovery.
- Surface selected/default source warnings and explicit unknown health; manual audio checks sample initial/final windows by track/channel. Source roles are metadata, not verified speaker identity. No live PCM sampler or automatic retargeting was added.
- Flush FFmpeg audio output so the tested FLAC/Matroska startup produces visible bytes promptly, including synthetic silence and low signal. Fixtures preserve decoded PCM, duration and track metadata versus control; I/O cost remains unmeasured.
- Show an existing title literally or “Gravação — date/time/timezone”; dates are existing metadata, not certified capture start time. Update headers under the existing selection guard and mark older displayed content separately from a newer processing job. No physical rename or AI title generation.

## Verification

The frozen behavior candidate passed one aggregated offline suite: **607 tests, 0 failures, 4,836 assertions across 95 files**, 162.91 seconds on the local Linux toolchain. Project/Studio types and CLI/native Studio builds passed. Versioned-cut and remote CI results are reported separately; counts are never added together. Tests use synthetic media/fixtures and stub providers. No model quality, entitlement, billing, hardware or universal platform claim follows from them.

Independent static/documentary integration review found no material issue. The cumulative diff reconstructed all 324 behavior-candidate files from public alpha.9; stop/enqueue/ack contracts and compatible regressions remain preserved. Native Controller.stop with full downstream, native cancellation recovery and stop plus downstream failure/restart were not newly exercised.

A previous private-server synthetic audio test used the final backend argv without a harness flush override: 144,400 decoded samples / 18.05 seconds, A detected/B not detected, original source and recorder PID retained after changing the private default, with a warning. This proves that bounded scope, not absence of B, physical audibility, microphones, headsets or installed end-to-end capture. All own resources were cleaned up.

The physical H264/frame38 PASS on the specific AMD setup from alpha.9 is preserved; graphics/driver diagnosis was not reopened. The title QML renders use a synthetic backend with mediaReady=false and do not establish a playback regression. Six synthetic Qt screenshots validate scoped title/status/focus states; programmatic focus is not OS keyboard/accessibility certification.

## Distribution and remaining limits

MIT applies to original code; third-party notices remain. Source/skill/lock only: no binaries, native runtimes, model weights, private config/media/transcripts or private Git history. Use bun.lock with --frozen-lockfile --ignore-scripts and explicit existing requirements. Other platforms and remote download/bootstrap environments remain unqualified.

Follow-default/headsets is a separate unresolved proposal: the running capture retains its concrete source selected at startup. Physical audio/AVsync, complete device/provider onboarding, assistive technology, semantic model quality and the larger product roadmap remain open. Installation/init does not start capture or authorize remote inference.
