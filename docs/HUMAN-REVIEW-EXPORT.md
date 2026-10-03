# Human review and local export — local candidate

Release checkpoint: the product described here is included in the alpha.11 source release. Earlier local-only preparation statements are historical. Installation, real model/native validation and complete purge remain separately qualified; see [alpha.11 scope](ALPHA11.md).

This increment is a local candidate over alpha.10, not an installed or published
release. Studio and CLI use production revision/export services. Tests use
synthetic recordings, disposable HOME/XDG directories and blocked providers.

## Review without replacing evidence

Open a recording in Studio and choose **Revisar** on a transcript segment,
**Revisar** beside a speaker name, or **Revisar atribuição** on a diarizer turn.
**Nota** adds an untimed human annotation. Saving checks the recording identity,
original artifact hashes and the revision you read. Conflicts require a new read;
there is no automatic overwrite of a newer edit. Cancel/Esc discards the draft.
An uncertain save or disconnection requires rereading before another attempt.

Text edits are permitted only when the original segment's literal character range
can be located in the original full text in source order. Otherwise add an untimed
note. Edits do not split/reorder segments, change intervals, align new words or
verify that a name identifies a person. Speaker assignments remain human labels;
the original acoustic result stays pending validation.

Canonical and acoustic speaker IDs belong to separate sources. Matching IDs do
not link voices: an acoustic name appears on a canonical segment only after
explicit human assignment. Original captions retain their source's own labels.

Original media, transcript JSON/receipt/Markdown, summary and diarization files
are preserved. A private sidecar overlays the reviewed view, with stable
`sNNNNNN`/`tNNNNNN` IDs and a canonical ID bound to recording and raw transcript
hash. History is monotonic. **Desfazer** appends a revision restoring the previous
active edit; consecutive undo reaches the original state, without implicit redo.
Returning to identical text does not revive an obsolete editor's revision.

Limits reject further growth instead of silently removing history: 100 revisions,
4 MiB journal, 64 operations per save, 20 notes, 2,000 characters per note and
10,000 characters per segment edit. The new files use 0600 permissions under a
0700 product directory; symlink paths and unsafe existing state are refused.

If the first diarization appears after text-only edits, the acoustic base can
expand once while preserving that history. An old editor must reread the new
base. An existing acoustic hash is never silently reassigned to another result.

## Derived results and scope

Saving invalidates controlled compact client context before publishing the
revision. Builds and revision commits share the publication lease; controlled
reads recheck invalidation after asynchronous reads. A stale build cannot overwrite
a newer revision's context and advertise it as fresh. Studio hides old summary
and visual-summary results; meeting search/context and export expose the reviewed
transcript and revision provenance. Old summaries stay stale after undo too:
restoring text is not a new validation of generated claims.

No model is called automatically and the original summary is not overwritten.
Evidence-bound summaries must match source media, the historical producer's
normalized-transcript hash and referenced segment intervals. Legacy summaries
without support remain explicitly unverified historical evidence.

TUI Markdown, library titles, search, meeting context and the existing Studio
visual planner now consume the current reviewed transcript. A current generated
summary is preferred only when its source and revision still match. The player
uses an in-memory reviewed view; changed words without new alignment are shown
as text with a warning rather than timed original captions. Read-only original
artifact APIs remain historical; uncontrolled external exports are not updated.
The legacy
`diarization name` command is compatible and records history but obtains its
current head internally; it cannot detect a stale human editor. Use the new
versioned review commands for editor CAS. Leases coordinate product writers;
they are not a universal lock against arbitrary external filesystem changes.

## Export what was previewed

Choose **Exportar**, an explicit format and an explicit source track. The
transcript track uses canonical evidence plus human edits. The diarization track
uses the diarizer's own timed utterances and reviewed names/assignments. A lexical
match never replaces the diarizer's text with canonical block text.

JSON/Markdown preserve full original and reviewed text, notes, IDs, source hashes,
revision and summary verification. SRT/WebVTT preserve overlaps and original
intervals with deterministic millisecond rounding. Unsupported/unknown/block
timing, intervals collapsing after rounding and unrepresentable subtitle payloads
fail explicitly. Edited transcript words require new alignment evidence before
subtitle export; choose JSON/Markdown meanwhile. No retranscription is requested.
The unmodified diarizer track remains a separate, explicitly selected source.

The preview is bounded and says when it is partial. Saving requires its revision,
base and snapshot hash, including summary content. A changed summary therefore
invalidates the preview even when the transcript is unchanged. Files are private
local, content-addressed bundles in the product's XDG data export directory.
Repeated identical saves reuse verified bytes; an existing divergent bundle is
preserved and refused. Each bundle includes the output, full snapshot and JSON
manifest with hashes and format limitations. No arbitrary destination or silent
overwrite is accepted; nothing is sent to another app.

Copies already exported remain separate snapshots and are not refreshed by a
later edit. A new removal planner inventories managed snapshots and reports what
would remain, but does not execute their deletion. Existing deletion preserves
new sidecars; existing work retention refuses unsafe paths or snapshot references.
Unified deletion and remaining distribution/native validation remain separate
roadmap criteria. See [Reviewed snapshot compatibility](REVIEWED-SNAPSHOT-COMPATIBILITY.md).

## CLI and reproducible offline checks

`review show <job-id>` returns the production reviewed view as JSON. Use its
revision/base in `review apply <job-id> --input '<JSON>'` with explicit
`operations`, or `review undo ...` with only `expectedRevision` and `base`.
Malformed apply cannot select undo. `export preview <job-id> --format json
--track transcript` returns the snapshot identity; `export save ... --input
'<JSON>'` requires `expectedRevision`, `expectedBase` and
`expectedSnapshotSha256`. Read the current response before constructing a save.

Success writes JSON to stdout. Errors write bounded JSON to stderr: exit 2 for
revision/snapshot conflict, 1 for invalid/unavailable input, 0 for success.
Source selection is explicit. Existing commands/config identifiers are preserved.

With the existing dependencies available, run `bash scripts/test-offline.sh`.
The runner creates marked temporary HOME/XDG, blocks capture/service/cloud
commands and preloads the network/isolation guards. Abstract Unix QA leases need
an appropriately scoped sandbox permission; do not disable the production lease.
Synthetic fixtures do not validate real model quality, capture, playback,
physical accessibility, another platform or an installed release.
