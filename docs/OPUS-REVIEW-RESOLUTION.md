# FalaTrace — bounded independent Opus review and resolution

Review performed locally on an isolated candidate; alpha.1 and original work preserved. No capture, private media, media-provider calls or credentials were used.

## Independent review evidence

Effective model: `claude-opus-5-5`, canonical name confirmed in the completed CLI result. Duration 268428 ms, one review turn, successful result, no permission denials. Tools and MCP disabled, safe-mode, no persistent session, no API key environment or alternate-provider fallback.

Input: immutable cumulative 16-file patch SHA-256 `5daabb50e2fb299d6cc03ea8168150af15de9a81127a688fe226052d89a67d6d`, plus numbered own-code/fixture sources and eight supporting modules. No config/history/media/secrets. The raw review is retained separately. Opus reviewed the pre-fix artifact; there was no second Opus round or claim of post-fix approval.

## Findings and disposition

| Finding | Evidence / impact | Disposition and regression |
|---|---|---|
| F1 P1: direct pipeline test could spend personal persistent budget | `processJob` derives the fixed app root, while that test only isolated media/session/cache. Running plain `bun test` could write the actual user's budget. Our previous executed full suites already used synthetic HOME/XDG, so this was a latent direct-run defect, not an observed personal-state write. | Fixed: each case sets/restores its own temporary XDG_STATE_HOME. A direct command now passes and asserts 3 automatic / 2 manual inference reservations in that isolated root. No personal budget was read/reset/deleted. |
| F2 P1: Studio stuck at first plan and eventually expired forever | Manual Studio always used round 1 and the same model/source session key, so a changed question was rejected. Expired ledger remained and notes were hidden. | Fixed: consent binds a plan/window scope; separate questions and a fresh hourly review window get separate session checkpoints while retaining the same fixed global-root counter and per-job provider/source identity. Injected clock reaches the ledger. Old notes remain readable with an explicit expired-evidence warning. Regression: A, B, TTL, fresh consent, restart → three vision/summary pairs, six total global attempts; restart adds zero. |
| F3 conditional P1/P2: exhausted/conflicting visual guard aborts optional job processing | Real workers and sync call `processJob` without `options.visual`; only fixtures call that optional pipeline contract. Different Studio/pipeline identity encodings can conflict when combining those surfaces on the same job. | Current active-caller severity P2/design limitation. Chosen fail-closed policy: explicit failure when the guard is exhausted or identity conflicts; no automatic inference fallback. Tests prove zero new chat calls and byte-identical existing summary after both conditions, including a changed session root. Identity normalization is required before a future worker integrates that optional visual contract. No bypass was added. |

No P0 was reported. Consent/source binding, plain-text rendering, duplicate/stale handling, propagated cancellation, atomic leased budget writes and onboarding safeguards had no proven P0/P1 in the reviewed artifact. This is a bounded source review, not a guarantee of absence of vulnerabilities.

## Unknowns kept explicit

- Actual installed Ollama capabilities/cloud/local semantics and semantic model quality were not exercised. Metadata fingerprints are not attestation of weights; show→chat is not an atomic model revision transaction.
- Frame extraction uses preview and confirmation passes and fails closed on byte differences; no semantic quality claim.
- Opus did not receive the native reader implementation. Subsequent source inspection found a 32 MiB response buffer in `src/desktop/main.cpp`, larger than a single bounded JPEG/base64 preview. The 1 MiB limit is outbound requests. This resolves the specific alleged small response-line cap at source level; no new worst-case native load certification was performed.
- Qt validation is offscreen scripted input, not physical keyboard/touch/Orca, playback or capture validation.
- Attempt guard covers app visual flows in the fixed root, not subscriptions, all programs or ordinary nonvisual processing; owner edits/environment changes are outside the promised protection. No financial cap claimed.

## Final verification and artifact

- 362 offline tests, 0 failures, 1657 assertions, 61 files, 54.11 s.
- Direct targeted regressions: 7 tests, 0 failures, 187 assertions; own temporary state inside each pipeline test.
- Qt: 18 screens, 43 checks; receipt matches final QML/coordinator/bridge/budget hashes.
- CLI/Desktop types and CLI build passed; diff whitespace and apply-check against alpha.1 passed.
- Original 161 source hashes and published alpha.1 221 hashes remain intact. No active service or personal config/budget mutation.
- Fixed patch SHA-256: `37a3741352768504ee677bd28652a2e7e0de5d40c63541ffad7598eeeff1d5dc`.

The source-only alpha.2 package is reproducible, preserving MIT own-code and third-party notices and excluding history, configs, media, dependencies and binaries. Only curated synthetic screenshots are included. Future increments require separate publication decisions.
