# FalaTrace 0.2.0-alpha.18

Experimental Linux source release that improves Ask: calendar-aware recall with transcript fallback, streamed Antigravity answers, and formatted Markdown answers with checked citations in the Studio, plus four fixes from the review of that work. Everything else is alpha.15, alpha.16 and alpha.17, described in [ALPHA15.md](ALPHA15.md), [ALPHA16.md](ALPHA16.md) and [ALPHA17.md](ALPHA17.md).

## Changes

**Calendar-aware recall with transcript fallback.** A question about a period could select old lexical matches while missing the meetings of the requested week, and a keyword miss silently omitted relevant meetings. Ask now prioritizes meetings in the requested local calendar period while keeping relevant older excerpts, and broad questions and keyword misses also read reviewed transcript passages within the shared context budget, including when the question and the recording use different languages. The prompt keeps speaker attribution and deadline interpretation explicit: answers distinguish meeting dates from deadlines and leave the user's speaker identity unconfirmed unless established.

**Antigravity streaming.** The subscription CLI buffered the Antigravity answer until the process exited. It now forwards answer deltas before `agy` exits, keeps thoughts and tool output out of the answer, and checks the final result without duplicating streamed text. When an output callback (for example `onDelta` while streaming) throws, the child process tree is stopped at once with the configured signals and grace, instead of hanging until the turn timeout; the no-error contract of the runner is unchanged.

**Markdown in the Studio.** Ask renders an allowlist of Markdown — headings, emphasis, lists, tables and code — during streaming and when reopening conversations. Checked citations open the recording moment; copying and sharing keep the original Markdown; source buttons keep keyboard access. Raw HTML blocks are escaped once and shown as text (Bun 1.4 already escapes them, so a second pass turned `<details>` into literal `&amp;lt;` entities); images and external links stay inert.

**Consent for whole transcripts.** Questions with a calendar period, or without a search hit, enter broad recall, which reads reviewed transcripts and can send a whole meeting's speech to an external provider while the consent card said only "trechos". The context pack, the plan and the bridge now expose `fullTranscripts`, and the consent card warns "Esta pergunta pode enviar a transcrição completa das reuniões, não apenas trechos." when it is true — including when one chosen meeting fits the context budget whole; a truncated meeting (windows only) keeps the previous wording. The consent key semantics are unchanged.

**Broad recall gap markers.** The final assembly of a library pack deduplicated identical lines, so only the first […] gap marker between non-contiguous windows survived and the model read separate passages as continuous speech. The marker is now exempt from deduplication, matching the meeting scope.

## Verification

On the release machine: type checks, the desktop type check, Biome lint (0 errors, 587 warnings) and the CLI build pass. The offline suite ran 2,560 passing and 68 failing tests across 248 files (32,236 assertions); 67 failures are environment-only — the local FFmpeg 8.1.3 lacks libx264 for the synthetic-video tests, the local bun is a wrapper around another binary that child-process fixtures re-execute without bun mode (the ACP fake agents, the bridge and CLI child runs, and the QA runner that requires an executable named `bun`), and `/usr/bin/strace` is not installed. The remaining failure is a timing-dependent test in `src/archive/__tests__/proton.test.ts`: when two retry attempts land in the same millisecond, the rotation order falls to a random-id tie-break; it passed 6 of 6 runs in isolation on the same machine and is unchanged by this release.

Public CI on PR #10's head (59e0f34, the same source tree this release ships) recorded 2,628 offline passes, 0 failures across 248 files (33,041 assertions), with the type, desktop type, Biome and build checks passing, and all 18 Studio journeys passing (975 assertions; ask-ux 117 across 12 screens). The PR #10 body additionally reports ChatGPT and Antigravity exercised locally with partial answer delivery observed before completion; that was not repeated for this release.

## Limits

Model answer quality and the behavior of every external provider are not certified by these checks. The whole-transcript warning is informative: it changes what the consent card says, not what the consent covers. Everything listed in [ALPHA15.md](ALPHA15.md#limits) still applies.

## Installation and rollback

Same as alpha.17: update only when no capture or processing is active, and reconnect existing MCP sessions to use the new executable. Configurations, data and services from alpha.17 are unchanged. Alpha.17 remains available for rollback. This document describes the release, not an installed-state receipt.
