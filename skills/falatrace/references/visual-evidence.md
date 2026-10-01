# Visual evidence and truthful scope

Studio uses production planner/FFmpeg/local Ollama adapters. Offline tests use generated video/config and HTTP stubs; production responses are not hardcoded, but actual semantic model quality has not been validated.

Prerequisites: finalized local recording, existing transcript, compatible Ollama models on loopback and explicit user action. Existing OpenAI/Gemini configuration is preserved; it does not automatically satisfy visual prerequisites. Never move keys or replace providers to make a demo work.

Select an explicit transcript interval within displayed limits. Planner may return frames, none or abstain. Inspect the proposed original segment IDs and timestamps; each frame must be inside that interval. Preview/extraction precedes separate consent to inference with the shown provider/model/bytes. The partial summary stays separate from the complete summary. Preserve absolute times, source IDs, frame/hash provenance and uncertainty; omitted context is not supplied to scoped inference. A source jump or valid hash is evidence linkage, not proof that the model's claim is true.

No supported public visual CLI command exists. Developer API: `preparePipelineVisualReview` creates an inactive, five-minute preview receipt; `processJob(...visual.review)` requires the exact consent key/current adapter tuple/source/scope/policy and an existing canonical transcript. One execution is bound to job/output/session root; matching completed results may be returned without reinference, changed/missing results need fresh preview. Model metadata fingerprinting is not atomic weight pinning.

Persistent lifetime guards default to 24 inference attempts/16 previews (explicit policy may change them). Scope is user installation/config namespace, not global machine/provider/subscription. Attempts survive failures/restarts and new consent. Never delete/reset state, change namespace/cache root or restart to bypass a limit. Previously recorded policy revision changes invalidate consent; old-format migration limitations are documented in release notes.

Cancellation/expiry/model failure does not publish a fabricated summary. Wait for calls/capture/heavy admission; unknown activity is not idle. Do not change admission overrides automatically. Call-light trades video detail for load and remains opt-in with no measured call improvement claim. Native playback/PTS, microphone/screen/call quality and model robustness still need separate consented validation.

Cache/receipt cleanup is bounded and lazy for recognized derived formats. It is not comprehensive remote deletion or a background TTL promise; unknown/legacy formats and interrupted scratch can remain. Do not perform recovery/removal just to make the budget available again.
