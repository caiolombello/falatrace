# Evidence and limits

What FalaTrace's references prove, what the tests cover, and what is still unverified. Release-by-release results are in the [changelog](../CHANGELOG.md) and the `ALPHA*.md` notes; the app and service matrix is in [compatibility](COMPATIBILITY.md).

## Status

FalaTrace 0.2.0-alpha.14 is an experimental source alpha for Linux. General native capture, desktop compatibility, model quality and redistributed binaries remain unqualified. The offline suite and the Studio journeys use synthetic data, stubbed providers and a synthetic HOME; they do not exercise a real call, a real model or the native Studio binary. The author uses the recording and context core every day; that is a report of real use, not a reliability measurement.

## Citations prove where, not whether

- New summaries and notes reference real transcript segment IDs, source timestamps and SHA-256 hashes. A reference is checked against the segments that were sent; an unknown ID makes the summary fail instead of being kept.
- Approximate block timing is labeled. Missing or uncertain references mark the summary for review.
- Reference validation proves structural traceability, not that the model understood the conversation. Read the cited moment before relying on a line.
- Your own notes are kept as your items. An AI item is never attributed to you, and notes the model did not use are listed separately. Whether a model follows a template well, or places a note under the right heading, depends on the model and was not measured.
- Answers from the assistant cite `[n]` markers that point to segments sent with the question; markers that do not match are removed. The answer's wording is the model's.

## Long meetings

- Transcript text falls back to valid segment text when the aggregate text is empty.
- Long transcripts are planned into at most eight parts, each within the configurable character budget and 1,000 segments, up to 8,000 source segments. Global segment IDs survive the split; an oversized sentence keeps its approximate original interval.
- Completed parts have checksummed private checkpoints. Merging parts is deterministic and requires human review; no hidden reduction request is made.
- Automatic multi-part OpenAI summaries are refused without an explicit paid-budget policy. OpenAI summaries size their input to the model's context window, so most meetings fit in one request; notes that do not fit are listed as unused, never dropped.

## Processing safety

- Cancellation reaches transcription, extraction and summary requests. It cannot retract data a provider already accepted, or guarantee cleanup of every subprocess.
- A corrupt or incompatible transcript cache fails closed instead of silently uploading again.
- Source hashes are checked before and after processing, and receipts bind new transcripts to their parameters. Legacy transcripts stay usable with explicit uncertainty about their original parameters.
- New artifact files are private and atomically replaced. Publication is atomic per file, not a multi-file transaction.
- Paid OpenAI and Gemini transcription first checks the extracted audio locally; complete digital silence or an unverifiable measurement is refused, with the original kept.

## Context for agents

- `context search`, `context meeting` and per-client context export give your assistants bounded access. Meeting content is untrusted historical data, never instructions.
- Before a recording is deleted, derived context is invalidated, or the deletion is cancelled. Context for application consumers then stays invalid until a full rebuild. Files exported earlier, and copies other apps already hold, are outside this guarantee.
- [Agent access](../skills/falatrace/references/agent-frames.md) (alpha.5) gives named local agents explicit grants for selected recordings, with pause, revoke and bounded frames. Installation does not create a grant or connect an agent, and future recordings are not included unless you opt in to the separate installation-wide frames grant. An agent backed by a cloud model may send what it receives to its provider. Retrieval itself runs no model.
- OpenAI and Google [visual analysis adapters](../skills/falatrace/references/provider-analysis.md) need a separate provider, model, data and budget grant plus a runtime opt-in; dispatch is off by default, before any credential is read. A transcription or summary provider setting does not authorize visual dispatch. Results are partial observations with locally bound timestamps, not a regenerated summary or durable memory.
- The [FalaTrace skill](../skills/README.md) teaches agents bounded retrieval and the existing CLI contracts. It grants no permission to capture, upload, infer or delete, and contains only synthetic examples.

## Visual review in the Studio

- Studio visual requests use the production local adapter and summary path after explicit model capability checks and bound consent. Verification used synthetic video and fully stubbed HTTP; no installed model's quality is certified. See [ALPHA2-LOCAL-REVIEW.md](ALPHA2-LOCAL-REVIEW.md) for data disclosure, persistence and limits.
- The selector receives bounded transcript windows; requested frames must reference supplied segments and nearby timestamps.
- A persistent ledger enforces two rounds, eight frames, four selection or inspection requests (failed calls count), 2 MiB per frame and 8 MiB in total. The installation-wide limits of 24 inferences and 16 previews are configurable. Local metadata checks are counted separately.
- The Ollama visual adapter accepts only credential-free loopback and verified local model metadata; cloud or unknown models are refused before chat. No model is downloaded or contacted automatically. There is no CLI toggle for this flow.
- Frames have a configurable time to live from 60 seconds to 24 hours (default one hour). Expired evidence falls back to transcript-only with review warnings and no visual inference. Explicit cleanup deletes only verified derived frames and keeps the budget ledger and observation metadata; it is not a scheduled service and never erases original media. A sidecar belongs to `summary.json` only when its `summarySha256` matches.
- Bounded evidence and processing admission arrived in [alpha.3](ALPHA3.md). Call-light capture is opt-in and has no demonstrated call-performance benefit.

## New features in this batch

These are covered by unit tests, production-bridge tests and CLI contract tests with synthetic data. None was exercised against the real service or tool:

- **Assistant providers.** Ollama, the API presets, ACP agents, subscription CLIs and Sign in with ChatGPT are tested against fake servers and fake processes. Real accounts, plan limits, model quality and each agent's current command-line behaviour are unverified. Plan eligibility and terms are set by each vendor and can change.
- **Templates and language.** Template choice by calendar title and keywords is a heuristic; language detection may pick English for a meeting that mixes Portuguese and English equally.
- **People and clients.** People are grouped by normalized name; two different people with the same name are merged until you separate them. You are recognized as yourself only through the calendar, where the event marks your own attendance; never by voice or by name.
- **Reminders.** Notification buttons depend on the desktop's notification server; libnotify action output and GNOME's handling were not checked on a real desktop.
- **Live transcript.** A preview with chunk-level timing. Its accuracy and real-time factor depend on the CPU and model; the final transcript is still made after the meeting.
- **Sharing.** Notion, Slack and the AI apps were tested against fake endpoints and launchers.
- **Media retention.** Eligibility, removal and resumption are tested with synthetic files and an injected FFmpeg runner.
- **The redesigned Studio.** Under construction; its journeys arrive with it. <!-- studio-check -->

## Not yet demonstrated

- Automatic detection of each app in real calls, and capture across Linux desktops, backends and audio setups.
- Real transcription, speaker, summary, note and visual quality with installed models.
- Screen readers, varied display scaling, a cold install on a machine without a package cache, binary distribution and other platforms.
- A unified deletion that removes every derived file of a recording (see [privacy](PRIVACY.md#deleting-a-recording)).
