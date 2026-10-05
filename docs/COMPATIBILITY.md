# Compatibility — inspected code, reported use and validation

Documentation update, reviewed 2026-10-01. Application baseline: `v0.2.0-alpha.7`, commit `95746e89690f78e8cda269f3a08c9324317a3beb`. This document adds no detector, app integration or platform support. The tagged alpha.7 application and release artifacts are unchanged.

Caio Barbieri reports using the recording and context-recovery core continuously and successfully. That is real-use evidence from its author. The exact browser/service/desktop/backend/version tuple was not collected here. It is neither a quantified reliability benchmark nor evidence for every environment. No private config, call, browser history, recording or transcription was inspected in this review.

## What “compatible” must mean

Record these independently: calling service runs in the app; FalaTrace recognizes the local app signal; configured capture starts visibly with permission; selected screen is captured when video is configured, and the intended configured audio sources/tracks are captured; stop finalizes usable media; context preserves source/timing; pause, interruption and recovery preserve data. An installed package or vendor-supported browser proves none of the remaining steps.

Evidence labels: **implemented** means a source path exists; **fixture** means synthetic behavior was exercised; **author report** means the attributed experience above; **native validated** requires a recorded exact real tuple and lifecycle result; **planned** means no feature/support claim yet. This review establishes no new native validation.

## Browser and calling-app matrix

| App / family | Automatic app identity in alpha.7 | Calling-service distinction | Capture and evidence | Next status |
| --- | --- | --- | --- | --- |
| Helium | Exact binary/name `helium` or ID `helium`; enabled switch | None: microphone/video activity is the signal | Implemented + classifier fixture; manual/configured backend is separate. No exact native tuple here. | Keep current identity; test negatives and lifecycle. |
| Zen | Exact binary/name `zen` or ID `app.zen_browser.zen` | None | Implemented + classifier fixture. Being Firefox based does not cover Firefox itself. | Same gate. |
| Slack desktop | Exact binary/name `slack` | No huddle/room check | Implemented + fixture; not evidence for every Slack package/version. | Native mute/end/route acceptance pending. |
| Chromium, Chrome, Brave, Edge, Vivaldi, Opera (unreleased) | Exact binaries: `chromium`/`chromium-browser` (plus Snap `chrome` when `application.name` starts with “Chromium”), `chrome`/`google-chrome[-stable]`, `brave[-browser]`, `msedge`/`microsoft-edge`, `vivaldi[-bin]`, `opera`, or their Flatpak IDs. On by default. | None | Implemented + classifier fixture. The generic “Chromium input” name used by Electron apps is deliberately not an identity. No native tuple. | Native lifecycle acceptance per browser. |
| Firefox (unreleased) | Binary `firefox`/`firefox-bin`/`firefox-esr`, name `firefox` or ID `org.mozilla.firefox`. On by default. | None | Implemented + classifier fixture. Zen keeps its own identity. | Same gate. |
| Zoom desktop, Teams for Linux (unreleased) | Zoom: binary `zoom`/`zoom.real`, name `ZOOM VoiceEngine`, ID `us.zoom.Zoom`. Teams for Linux (unofficial wrapper): binary `teams-for-linux`. On by default. | None | Implemented + classifier fixture. Before this, author Zoom calls were recorded as Zoom web inside Helium. | Native mute/end/route acceptance pending. |
| Discord, Signal, Telegram, Element (unreleased) | Exact binaries/IDs; **off by default** (opt-in per app) because they also carry personal calls. | None | Implemented + classifier fixture. | Native acceptance after explicit opt-in. |
| Other native clients (Webex, Skype, Microsoft's retired `teams` binary…) | No identity | None | No positive detector fixture. Use manual capture. | Add one explicit row at a time. |
| Meet / Teams web / Zoom web / Jitsi in Helium or Zen | Only enclosing browser activity can match | Cannot identify which service, tab, meeting or person | Vendor web support and FalaTrace detection/capture are separate evidence. | Test each chosen service/browser tuple. |
| Teams desktop on Linux / third-party wrappers | No identity | None | Microsoft no longer supports its native Linux client; unofficial wrappers must be evaluated separately. [Microsoft client availability](https://learn.microsoft.com/en-us/microsoftteams/teams-client-desktop-admin). | Prefer supported web route for initial planning. |
| Safari, mobile browsers, Windows/macOS calling apps | No corresponding FalaTrace capture implementation established by this Linux source release | None | A responsive landing is not desktop/mobile recording support. | Outside the initial Linux compatibility batch. |

Identity matching is equality after lowercasing, not a configurable regex. Identities live in one allowlist ([apps](../src/calls/apps.ts)); each has its own `callDetection.apps.<id>` switch, existing switches are preserved and new identities take their registry default. Running attributed input audio or video is required; playback alone is ignored. Dictation, camera preview or other microphone use can satisfy the same heuristic. Mute behavior depends on whether the app retains its running capture nodes. Confidence ranks candidates; it is not an entry threshold or measured accuracy. Multiple tabs are not separated. See [classifier](../src/calls/classifier.ts), [types](../src/calls/types.ts), [state machine](../src/calls/stateMachine.ts) and [runtime](../src/calls/runtime.ts).

Fresh defaults disable detection and select `notify-only`, with 5-second entry debounce and 15-second exit timeout. Existing settings are preserved, not inferred from these defaults. Network socket counters are telemetry; they do not add a process-only or service-specific fallback. `calls run --dry-run` still observes live streams and writes state: it is not a pure offline test. [Defaults](../src/config/defaults.ts), [network](../src/calls/network.ts).

## Vendor prerequisites are not FalaTrace certification

Official pages checked 2026-10-01; requirements may change. These describe the calling product only:

| Service | Vendor-documented route | Implication for the first validation batch |
| --- | --- | --- |
| Google Meet | Current Chrome, Firefox, Edge or Safari; Ubuntu/Debian-based Linux among supported OS families. [Meet requirements](https://support.google.com/meet/answer/7317473?hl=en). | Start with Linux Chromium-family and Firefox-family browser tuples; derived browsers still need their own evidence. |
| Teams web | Latest three Chrome/Edge/Firefox versions on desktop Linux; Safari is listed for macOS. Mobile browser and VDI support are restricted. [Teams web prerequisites](https://learn.microsoft.com/en-us/microsoftteams/teams-client-web). | Plan Linux web acceptance, not a native Linux Teams support promise. |
| Zoom web / desktop | Web table lists Chrome/Edge 102+, Firefox 105+, Safari 16.4+; separate Linux desktop requirements. [Zoom web](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0058323), [Zoom desktop](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0060748). | Validate web and native client separately. These minima are not FalaTrace-tested versions. |
| Slack huddles | Feature-specific page lists desktop/mobile apps, Chrome on Mac/Windows/Linux and Firefox on Mac/Windows. General Slack browser requirements are broader. [Use huddles](https://slack.com/help/articles/4402059015315-Use-huddles-in-Slack), [system requirements](https://slack.com/help/articles/115002037526-System-requirements-for-using-Slack). | Do not equate general Slack browser support with Linux huddle support. |

## Capture, audio and desktop matrix

| Path | Alpha.7 code boundary | Evidence / native acceptance needed |
| --- | --- | --- |
| Shared automatic `record` controller | Accepts audio, GPU Screen Recorder and OBS aliases; `simple` maps to OBS here. It does not inherit the manual GNOME/wlroots fallback. | Implemented; validate configured backend rather than infer auto-start from fresh defaults. [Controller](../src/recording/controller.ts). |
| Managed audio | FFmpeg pulse input via selected microphone and sink monitor. “Both” requires two distinct present sources and writes mix/microphone/desktop tracks. | Command/fake-pactl fixtures; native two-sided audio, route changes and finalization pending. [Capture](../src/recording/capture.ts). |
| GPU Screen Recorder | Native or present Flatpak; FalaTrace uses portal/restoration token, H.264/AAC/MKV, explicit encoder and no silent CPU fallback. | Command fixtures are not portal/driver/encoder certification. Upstream documents X11/Wayland support; portal path avoids special root capture permission. [Official recorder docs](https://git.dec05eba.com/gpu-screen-recorder/about/). |
| Portal | Source selection/authorization can be required; a restoration token does not guarantee silent restoration forever. | Portal documentation says failed restoration or withdrawn permission can prompt again. Test selection, cancel, revoke and retry per backend. [ScreenCast specification](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html). |
| OBS | Requires configured scene, audio sources and permitted local control. Existing capture ownership must be respected. | Fake OBS tests; no new OBS connection/launch here. |
| Manual `simple` | Capability resolver can select compatible OBS, GNOME or wlroots; Plasma Wayland requires deliberate backend setup. | Different route from shared automatic controller. [Capabilities](../src/recording/capabilities.ts), [simple](../src/recording/simple.ts). |
| PipeWire / desktop session | Detector consumes JSON node metadata, not meeting semantics. Desktop recognition is prerequisite logic, not distribution certification. | [Official pw-dump manual](https://pipewire.pages.freedesktop.org/pipewire/page_man_pw-dump_1.html); test graph changes, versions and sandbox attribution separately. |

No screen-to-audio downgrade is promised after capture failure. Existing failed/cancelled managed-capture paths preserve nonempty media/state rather than claiming successful capture. Neither this review nor these vendor pages authorizes starting a real call, granting a portal permission, recording devices or installing apps.

## First finite gap batch — proposed

1. **Truthful detection diagnostics and fixture pack.** Cover exact/name/ID/case variants; unsupported and full-path identities; dictation/camera preview; explicit live=false; inactive states; real mute values; overlapping apps and app switch during candidate/active/ending. Report “possible call activity” where metadata cannot prove a meeting. Done when no fixture is relabeled as a native/service result and unsupported identity explains its fallback.
2. **Two browser-family identities, then one native app.** Candidate order: Chromium and Firefox, then Zoom. Preserve Slack/Zen/Helium and existing config; use explicit metadata allowlists with opt-in switches, no arbitrary process/URL/history scan. Pure fixtures first. Done locally when migration and negative/positive metadata cases are deterministic; support claims wait for native acceptance. Chrome/Edge/Brave derivatives are not silently inherited.
3. **Backend and lifecycle gate for one exact tuple.** Before widening coverage, regression-test automatic/manual `simple` differences with injected probes/controllers, pause-future versus stop-current, muted/camera-off continuity, source loss, cancel/permission-denied and interrupted finalization. Native acceptance later requires deliberately consented test participants/content, visible REC, selected screen when video is configured, intended configured audio sources/tracks, usable file, source timestamp and safe recovery. Record versions/backend/config fields explicitly disclosed for the test, without private titles, URLs, tokens or media publication.

The batch adds no generic all-browser/all-app guarantee. After one representative native tuple passes, extend the matrix one finite row at a time and keep failures/unknowns visible. See [completion goal and roadmap](ROADMAP.md).
