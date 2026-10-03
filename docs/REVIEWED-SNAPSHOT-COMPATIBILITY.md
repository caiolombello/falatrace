# Reviewed snapshots — local compatibility candidate

Release checkpoint: the product described here is included in the alpha.11 source release. Earlier local-only preparation statements are historical. Installation, real model/native validation and complete purge remain separately qualified; see [alpha.11 scope](ALPHA11.md).

This candidate is local only, over the uninstalled G4/G5/G7 candidate. The public
and installed alpha.10 are unchanged. Production code is tested with synthetic
files and adapter/HTTP stubs; no real provider, capture, user-data purge or remote
operation was executed. Native/model quality is a separate acceptance gate.

## Current views and historical evidence

The library/TUI, search, meeting context, player, export and Studio visual planner
read the current reviewed transcript. Names cross canonical/acoustic namespaces
only through an explicit human assignment. Changed words do not gain original
caption alignment. Original artifact readers remain historical APIs. External
exports are independent copies. Automatic batch client context retains its
completed-job selection; on-demand meeting context can show a usable partial job.

Current summary reads recheck the job, original receipt, media checksum and full
review snapshot, without taking a revision publication lease. Stale generated
results remain stored but are unavailable as current results. Source media must
still be available for a current generated summary; archived historical text is
not silently promoted to freshly verified evidence. Hashes verify provenance,
not semantic correctness, real identity or acoustic alignment.

The original pipeline and remote artifact pulls refuse saved human journals.
Classification that still relies on original artifacts is refused for reviewed
jobs before the legacy classifier is called; prior time entries are preserved.
Checks surround cooperating publication, including local work-to-artifact
copying. Remote original publication holds the revision lease during the existing
bounded transfer; no new download staging or multi-file transaction is claimed.
These leases do not lock arbitrary external writers.

## Explicit summary regeneration

`summary-review plan <job-id> --input '{"requestId":"review-1","maxRequests":2}'`
records an immutable plan. Read its exact reviewed snapshot, destination, input
scope and consent key before `summary-review run <job-id> --input
'{"requestId":"review-1","consent":true,"consentKey":"<plan-key>"}'`.
These commands are functional production routes, not scripted output. The default
adapter requires explicitly configured loopback Ollama; this candidate has not
executed that adapter against a real model. Credentials or provider/destination
overrides cannot be passed through this CLI input.
HTTP redirections are refused by the Ollama summary transport, preserving the
configured recipient rather than replaying transcript input to another endpoint.

The plan uses reviewed transcript text only. Untimed human notes and acoustic
labels remain provenance metadata and are not sent to the model. Segment times
and source IDs remain inherited evidence. Chunked results are marked for review;
assembling chunks does not validate global consistency. A usable verified local
work transcript may be summarized after another stage failed without marking
the job completed or rewriting the original summary.

Plans, request states, checkpoints and results are private sidecars. There are
32 lifetime request slots per job and at most eight dispatched provider calls
per plan; the chosen budget must fit all chunks. Attempts are reserved before
dispatch. Caches are accepted only for the same input/provider fingerprints.
Completed retries return the same verified result. Uncertain dispatch is not
automatically retried; cancelled IDs stay terminal. New IDs still consume the
persisted job limit. These counters are not a global token or monetary budget.
Starting another session or process does not reset them.

`summary-review show` reads without inference. `summary-review cancel` records
cancellation; it cannot retract input already accepted by a provider. Regeneration
uses the existing heavy-work admission controls before acquiring publication
leases. Human edits remain possible during inference. Changed input, cancelled
requests or stale results cannot publish as the current revision. The current
summary appears in existing readers and JSON/Markdown exports.

Studio's Summary tab now has **Regenerate summary**. The user chooses a one-to-eight
request limit, explicitly prepares a local plan, reads the configured model and
loopback destination, then confirms that exact plan before generation. The dialog
shows unknown monetary cost rather than promising free compute. It includes any
already configured job context and excludes untimed notes and acoustic labels.
There is no model/provider override, automatic generation, new frame consent, or
configuration write: disabled automations and external-provider settings remain
unchanged. Unsupported or unavailable local configuration refuses the operation.

Cancel, Escape, closing the dialog, changing recordings and disconnecting abort
the active request and invalidate pending presentation. Cancellation is persisted;
an already completed result stays preserved, and input already dispatched cannot
be retracted. Late responses cannot appear under another recording. A model error
or revision conflict requires rereading before explicitly preparing another plan;
there is no automatic retry. The controller composes the same production contracts
as the CLI. Its constructor-only adapter injection is used by synthetic tests,
and is not selectable through Studio or JSONL requests. Real model quality remains
unvalidated; adding this button does not close the full product roadmap.

## Frames and consent after edits

Studio supplies the reviewed transcript to its existing production FFmpeg/Ollama
flow. Scope, planner cache, preview consent, visual session and persisted result
are linked to the human revision, including a new head with identical text.
Publication rechecks the snapshot under the revision lease. An edit while a
request is waiting or a stub is responding requires a fresh preview and does not
refund consumed attempts. Original legacy results are accepted only in their
unreviewed scope. Results still distinguish selective visual observations and
model inference and retain frame hashes and timestamps.

The existing persistent visual budget is unchanged: installation-wide lifetime
limits plus a pinned per-job provider/model/transcript identity. A job already
bound to an older transcript can refuse another visual analysis after a text
correction, even with a new preview. This cut does not reset counters, switch
identity scopes or promise unrestricted re-review. Model quality, real playback
and delivery to a real AI client remain unvalidated here.

## Removal and retention are explicit planning

`removal-plan show <job-id>` returns a dry-run with `executable:false`.
`removal-plan validate <job-id> --input '<returned-plan>'` rereads exact owned
paths and source/state fingerprints. Changed revision, summary, export, job,
root or inventory makes the plan stale. There is no execution or purge command.

Recognized managed journals, reviewed summaries and export bundles can be
inventoried. Unknown, unsafe, opaque or unowned files are preserved; they are not
proof that deletion is complete. Original media, archive catalog, auxiliary state,
remote copies and external exports are preserved and reported explicitly. The
planner does not contact remotes or invalidate AI context. Existing deletion
continues its legacy local scope and preserves new sidecars. Work retention skips
unsafe roots, source mismatches and potential snapshot references, preserving a
sole usable work transcript. Unified purge requires a separate implementation,
consent and native acceptance gate.

## Offline verification and limits

Run `bash scripts/test-offline.sh` with existing cached dependencies. The runner
uses marked disposable HOME/XDG, provider/device/service guards and synthetic
fixtures. Scoped tests verify revision drift, cancellation, orphan recovery,
budget persistence, partial transcripts, current exports and planning protection.
JSON machine contracts stay deterministic: exit 0 success, 2 stale snapshot and
1 invalid/unavailable input. No mutation of original media/configuration or
automatic provider invocation is part of a read, preview or plan.
