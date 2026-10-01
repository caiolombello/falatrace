# Alpha.5 — bounded agent access and bilingual landing

Experimental source release for Linux. Installation does not create grants, connect assistants, enable visual APIs or include future recordings automatically. Existing configuration, media and the recording-cli namespace remain compatible. Own code remains MIT; third-party notices are unchanged. No new dependency is added.

## What is functional

Production Studio/CLI → registered recording → explicit recipient/data grant → source/hash validation → FFmpeg JPEG extraction → local timestamp/provenance. One consent remains valid inside its existing-recording scope; pause/revoke prevents subsequent delivery. Local retrieval does not run a model. Returned images may be uploaded by a cloud-backed assistant; the recipient must be explicitly chosen. There is no guaranteed secret detection/redaction.

Agent grants and provider grants are separate. OpenAI Responses/Google generateContent adapters are implemented, disabled by default before credential access. A transcription/summary provider configuration does not enable visual analysis. Tests replace network transport with stubs. Live model access, capabilities, cost and consent must be verified before activation. Provider results are partial observations or abstention, not complete-summary regeneration or durable memory. Context/frames are untrusted data, never instructions.

The existing local Ollama Studio preview/analysis workflow remains separate. Its explicit model/scope/preview consent and admission gates remain in force. No new capture or inference occurs at startup.

## Persistent budget and retention

The canonical ledger is lifetime, per user installation, shared by Studio/CLI/grants. Restart, new request IDs, cache expiry and new grants do not renew allowance. Defaults are 16 extractions and 24 inferences; explicit policy changes retain counters. Grant request limits and idempotent attempt receipts add constraints. Unknown cost is not zero and is not permitted by a finite known-cost ceiling. Estimates are not provider billing caps or a global quota across other clients/machines. The local filesystem owner can alter state; this is an operational guard, not an adversarial billing system.

Agent/provider caches default to five minutes with lazy cleanup on access. Legacy visual evidence has its separate configurable TTL. Revocation does not retract already delivered copies or erase provider-retained data. Durable visual memory is not implemented; observations are not silently copied into client summaries.

## Studio and website

The library has priority. Capture/job tools move to a dialog while active capture has an immediately visible stop button. Agent versus provider paths show destination, data, scope, budget and state. Authorization and error actions stay visible; keyboard focus is explicit; stale async responses cannot change a different grant's result. Onboarding save/cancel preserves existing configuration. This is not a complete device/provider setup wizard.

The landing has equivalent [Portuguese](https://caiolombello.github.io/falatrace/) and [English](https://caiolombello.github.io/falatrace/en/) pages, canonical/hreflang metadata and native accessible language links. Commands are unchanged. Studio screenshots are actual Qt UI with synthetic inputs; Studio itself remains Portuguese.

## Verification

Release validation receipts accompany release preparation. Final release rerun: 447 tests passed, 0 failed, 3,642 assertions across 75 files (104.41 s). TypeScript, desktop checks, CLI/standalone/native build and frozen-cache bootstrap passed. A stale version literal in the skill contract test was updated for alpha.5 before this rerun. TypeScript/desktop checks, frozen dependency bootstrap, build/version and synthetic skill contracts are release gates.

| Journey | Checked offline | Remaining limit |
|---|---|---|
| Setup/config/removal | Non-overwriting init, safe uninstall, onboarding save/cancel | Full device/provider onboarding and cold network installation |
| Capture/automation | Consent, unknown/active/paused UI, stop via keyboard stub | Physical capture, audio, desktop portals and real calls |
| Library/context | Empty/loading/error/search/back, stale response handling | Assistive technology and all physical navigation combinations |
| Frames/access | Real FFmpeg synthetic video, source hashes/PTS, persistent grant, revoke/cancel/cache/budget | Real assistant integration and model image interpretation |
| Provider observations | Official adapter contracts, stub transport, idempotence, privacy/revocation | Live access, billing, model quality and full-summary integration |
| UI/landing | Qt light/dark/compact, focus, PT/EN mobile/desktop/keyboard | Orca, fractional scaling, native media playback |

Offscreen snapshots can return native smoke exit 5 with mediaReady=false. UI assertions are assessed separately; this does not pass playback. No private recording, screen/microphone capture or live provider inference is used for verification.

## Explicit installation-wide frames opt-in

Alpha.5 additionally supports `agent-context authorize-installation --recipient codex-openai|claude-anthropic|gemini-google --include-future --exclude-secrets --consent`. This is a separate frames-only opt-in covering current/future registered media in this installation. It never enables API analysis or transcript/summary retrieval. Ordinary per-recording grants stay fixed. Installation grants can list only opaque recording IDs with `agent-context recordings --grant UUID --recipient NAME [--offset N] [--limit N]`. MCP exposes only `list_recordings` and `get_frames` for this scope.

Pause/revoke use existing commands. `agent-context exclude-recording --grant UUID --recording UUID` blocks a sensitive recording for that grant, including cached/pending access; apply the exclusion to every recipient that must not receive it. Exclusion increments revision, so subsequent previews for other recordings may require fresh extraction and consume the same lifetime budget. Exclusions persist; no automatic un-exclude. Finalized registered sources and hashes are verified on each retrieval; missing, unsealed, changed or out-of-installation media is refused. Source versions intentionally replaced in the registered catalog are covered by this broad scope; in-flight changes are refused.

A recipient label is not cryptographic provider authentication. The local stdio launcher fixes the recipient/grant, and requests cannot select another one. Other processes with the same OS-account filesystem access are outside this identity boundary. No client connector is installed by the package. Codex/Claude/Gemini clients require their own supported setup and session refresh; this does not imply the hosted ChatGPT/Claude/Gemini websites can access local tools.

Secret exclusion is an operator obligation, not automatic detection/redaction. Exclude recordings known to contain passwords, keys or other secrets before letting assistants retrieve them. Images already delivered may be uploaded by that assistant to its provider and cannot be recalled. This option does not guarantee that unreviewed media is secret-free.

The new installation scope received an independent read-only Opus review. Two blockers (non-string ID validation and CLI fall-through after mutation) and three bounded-catalog/cache findings were fixed before release, with actual CLI/MCP and synthetic-video regression tests. No post-fix model approval or live-client semantic validation is claimed.
