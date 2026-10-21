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

## Speaker name suggestions — unreleased

The Speakers tab can suggest names for the diarized speakers (S01, S02…). A
suggestion never changes a label: **Usar** opens the review above prefilled, and
**Aplicar sugestões** saves one ordinary revision for speakers that still have the
diarizer's default label and a single suggested name. Undo works as for any edit.

- **Microphone (local).** Right after a diarization, and on request, FalaTrace
  compares the levels of the microphone and computer tracks of its own captures.
  The speaker heard on the microphone while the computer is quiet is suggested as
  the owner, with the account's full name or "Você". Recordings without separate
  tracks, without computer audio or with more than two microphone speakers get a
  reason instead. Untitled three-track files are accepted only when the first
  track carries the other two.
- **Conversation (explicit).** Only when you tick it in **Sugerir nomes…**, the
  diarizer's turns, the S01/S02 labels and the owner's name (when the microphone
  found it) go to the configured summary model, which is shown before sending.
  One request, no automatic retry. A returned name is kept only when its quote is
  a literal excerpt of the cited turn and contains every word of the name; the
  owner's name is never attributed to another speaker. A name said in a meeting
  can still belong to someone else, so check before applying.

- **Known voices (local, off by default).** With `speakers.voices` on and voice
  recognition downloaded from Models, each diarized speaker gets a 512-number
  signature computed on this computer from its longest turns that no one else
  overlaps: the owner from the microphone track, the others from the computer
  track, otherwise the mix. When a revision names a speaker, that signature joins
  the person with that name; renaming or undoing the name moves or removes it,
  and a person with no signature left is forgotten. In other recordings the
  closest confirmed sample of each person is compared (cosine similarity at least
  0.55 and 0.12 ahead of the next person) and shown as "voz · N% de semelhança".
  Samples a recording taught are never used to recognize that same recording.
  Signatures live in `$XDG_DATA_HOME/recording-cli/voices/profiles.json` (0600),
  never audio; **Models › Vozes conhecidas** and `falatrace voices list|delete`
  remove a person or everyone. A voice that identifies someone is biometric data
  under the LGPD: tell people, and delete the voice of anyone who asks.

Suggestions are stored privately beside the diarization
(`$XDG_DATA_HOME/recording-cli/diarization/<id>.speakers.json`, mode 0600) and
bind to the exact diarization file: a new diarization makes them stale. CLI:
`speakers suggest <id> [--conversation]`, `speakers queue <id>` and
`speakers status <id>`. Offline checks cover the scoring, quote validation,
consent binding, the production bridge and an offscreen Studio journey; real
voices, calls and provider quality are unverified.

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
