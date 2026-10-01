# FalaTrace 0.2.0-alpha.7 — speaker text, simultaneous captions and honest subtitle status

Experimental Linux source release. This increment fixes presentation and operation-status reporting. It does not fix the underlying subtitle generation failure, certify speaker identities or establish acoustic/model quality. Own code remains MIT; dependency lock and third-party notices are unchanged. Native runtimes, model weights, dependencies and binaries are not redistributed.

## What changed

- The Speakers tab shows the text returned for each diarizer turn beside its existing speaker label and source interval. It is explicitly automatic text for review, separate from the canonical transcript. The additional text fields are bounded to 256 KiB; omitted text is disclosed without dropping the remaining turns or changing the sidecar.
- Caption display includes every active cue within its half-open interval `[start,end)`, keeping existing speaker IDs when present. It no longer selects only the first overlapping cue or retains caption text from the previous recording after switching or returning to the library.
- An absent/collected subtitle unit or failed status inspection is `unknown`, not evidence that generation finished. Studio releases its pending flag and reports that aligned captions/status are unavailable while preserving the original transcript. An observed failed service remains distinct. No retry is triggered automatically.

The internal Studio bridge adds `subtitleMessage` and the `unknown` operation state. Bridge and UI must be updated together; generation commands and legacy recording-cli configuration/state namespaces remain unchanged. Existing speaker labels do not imply validated identities. The caption fix displays existing cues; it does not generate speaker-aligned subtitles, word timing or a new SRT/VTT export.

## Subtitle diagnosis and next manual attempt

A small private recent-recording inspection found absent aligned caches and no recoverable subtitle-unit journal evidence. Those observations do not establish the operational cause and no private examples or logs are included here. The current transient worker can be collected after failure, and generation cleanup removes staging logs; no durable operation history is added in this release.

For a future user-initiated attempt, identify the exact `subtitleId` selected by Studio (archive UUID can differ from job UUID), retain only the request time and sanitized stage/exit state, and inspect that exact FalaTrace unit. Keep raw journal/worker messages in memory only; do not save or publish them. A queue acknowledgment is not completion. A missing unit with no journal is unknown. No diagnostic step should start capture, transcription, diarization, retry, remote inference or API dispatch automatically. Any new generation remains an explicit separate user action.

## Verification

Release gates include the offline regression suite, TypeScript/desktop checks, frozen-lock bootstrap using existing cache, source/secret scan, artifact hashes and native build/version readback. Exact final results are recorded in the release/CI receipts. Synthetic cases exercise speaker text/provenance/partial disclosure, overlaps, interval boundaries, reactive recording switches and collected/unknown subtitle states.

Existing synthetic QML renders demonstrate the local speaker display and caption switch logic; they do not certify real playback, capture, audio synchronization or speaker assignment. The guided synthetic Codex test established interpretation of two selected frames only; it does not establish spontaneous frame choice in real meetings. Real subtitle generation cause, acoustic quality, model semantics, billing and broad native/platform compatibility remain unvalidated.

No inference, capture, new opt-in or paid API is needed to install this increment. Installation preserves existing explicit grants, lifetime consumption, configuration and data; it does not create a grant, enable a provider or renew budgets. Delivered image copies cannot be recalled. Preserve prior releases for rollback and perform updates only while idle, never by stopping a call or recording.

The [alpha.6 notes](ALPHA6.md) document previous consent/build/client/cleanup fixes and About behavior, which remain in effect. Speaker corrections, new subtitle exports and replaceable memory adapters remain roadmap work. See [LICENSE](../LICENSE), [third-party notices](../THIRD-PARTY-NOTICES.md) and [skill installation](../skills/README.md).
