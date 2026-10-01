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
