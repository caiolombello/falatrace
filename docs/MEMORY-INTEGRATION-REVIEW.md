# Memory boundary — finite local verification

Status: inspected, **no visual-memory integration implemented or activated**. The earlier provider-analysis patch, 439-test full run and final 12-test adapter run remain unchanged. No real account configuration, memory files, transcripts, recordings, credentials or APIs were inspected. This review reads source and tests synthetic fixtures only.

## What already exists

`knowledge/context.ts` builds optional client-oriented compact Markdown from completed job summaries and timesheet assignment, with bounded size and sanitization. Default `aiContext.enabled` is false; `refreshAiContextIfEnabled` requires it before automatic building. `knowledge/meetings.ts` retrieves canonical summary/transcript excerpts with artifact hashes, offsets and explicit segment/block/unknown timing. It does not read provider-analysis results or agent frame caches.

`AgentRetrieval.getContext` gates canonical meeting retrieval by recipient, context data permission, recording ID, source path/hash and grant revision, before and after reading. Its MCP transport remains explicitly bound to a local agent grant. Existing broad client Markdown readers are a separate local-user interface, not recipients of the new per-recording agent grant; one cannot infer sharing permission from a client assignment.

`ProviderAnalysis` retains a short-lived private result cache, not durable knowledge. Repeating the same request ID and fingerprint under the same provider grant can retrieve it after authorization/source revalidation. It expires lazily (default five minutes) while attempt/cost receipts persist. Current `get_context`/search and client memory do not expose these observations. An agent grant cannot be substituted for the provider grant. Thus visual results currently have model/frame/source/timestamp provenance, but are **not retrievable as agent memory under the existing context permission**.

## Revocation, source changes and deletion

Provider cache delivery rechecks the provider grant, revision and source version, including after asynchronous cache reads. Pause/revoke prevents delivery; deletion or a changed registered source/path/hash prevents validation. Agent context retrieval also validates the authorized source. Neither statement means that revocation physically erases copies already delivered or every private cache artifact: cache retention remains TTL/lazy and providers may retain accepted data.

Existing local deletion invalidates compact client AI context before media/job changes. Its reader refuses invalidated context until a full rebuild; concurrent deletion cannot be silently cleared by another rebuild. Failed invalidation aborts deletion before altering source/jobs. These existing mechanisms do not yet provide per-grant revocation semantics for a future aggregate of visual observations.

## Why there is no narrow automatic bridge

Durable retention goes beyond the five-minute analysis cache. Copying provider output into client Markdown would change retention, cross recipient boundaries and omit explicit grant/source invalidation semantics. The current grant data schema permits only `context` and `frames`; neither is permission to store/share a new durable observation corpus. The suggestion to consider memory did not authorize activation or expanded data sharing. No nominal feature flag was added for an unimplemented feature.

A separate future, explicitly chosen design is needed:

1. Disabled by default, explicit derived-observation retention and recipient/data scope; do not convert old grants or auto-build from API results.
2. Store only bounded derived text by default, never raw JPEG/video. Record recording UUID, media source hash/version, originating request/grant/model, artifact/hash and verified/unknown decoded timestamp.
3. Distinguish model-derived descriptions from inferences and user-confirmed facts. Model self-reported uncertainty is not a probability or verification; inference must not silently become an observed fact. Preserve abstention/partial status.
4. Queries revalidate source and current recipient authorization; pause/revoke, deletion, source replacement, artifact changes and expiry invalidate delivery. Define retention/deletion separately from permission revocation, preserving accounting receipts.
5. Keep per-recording grants isolated from aggregate client memory unless a new explicit aggregate scope is chosen. No global transcript/frame scan, automatic provider call or whole-summary regeneration is required.

That is a next-step proposal, not implemented functionality or permission to execute it. The functional phase is closed for this finite slice; do not open more features before the requested final visual review.

## Evidence

Focused existing suites: knowledge/context, knowledge/meetings, knowledge/deletion, agent-context/retrieval, provider-analysis/adapters. **36 pass, 0 fail, 315 assertions, 5 files, 10.62s** with synthetic fixtures, isolated HOME/XDG, network-blocking preload and stub provider transport. The log is `memory-integration-boundary-tests.log`. Tests substantiate current boundaries; they do not validate a future visual-memory implementation.

Native capture, microphone/device permission, playback, real client/model image understanding, API access/billing and semantic summary quality remain unvalidated by these fixtures. Alpha.5 does not implement durable visual memory or enable it on installation.
