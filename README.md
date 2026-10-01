<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/falatrace-wordmark-dark.svg">
  <img src="docs/assets/falatrace-wordmark-light.svg" alt="FalaTrace" width="364">
</picture>

# FalaTrace — experimental Linux source alpha

Linux tools for authorized recording, meeting search and notes linked to source timestamps. FalaTrace 0.2.0-alpha.2 is an experimental source alpha. Native capture, desktop compatibility, model quality and redistributed binaries have not been certified.

## Current verification

This source alpha passed 362 offline tests (0 failures, 1,657 assertions across 61 files), plus the final coordinator subset and 18 Qt synthetic renders / 43 checks. CLI and desktop TypeScript checks and CLI build passed. Capture backends were inspected and exercised through synthetic fixtures; real desktop capture and semantic model quality have not been certified.

## Install deliberately

Requires Bun, FFmpeg and the dependencies in `package.json`. Bun 1.4.0 with bun.lock is the tested installation path. A fresh node_modules installation of 17 exact locked packages from a local cache, plus standalone build/install/init/uninstall, passed. Download on a machine without a cache remains untested. The legacy pnpm lock is not the canonical installation path.

```sh
bun install --frozen-lockfile
bun run typecheck
bun run build
make install-cli INSTALL_PREFIX="$HOME/.local"
falatrace init
```

`make install` installs the CLI without implicitly running sudo/apt. OS dependencies are a separate explicit `make install-deps` action. Qt library, GTK/mpv playback, Whisper.cpp/models and desktop capture backends have additional requirements; verify them before choosing that workflow. Windows/macOS are not supported in this release scope.

`init` creates a private config only when missing; existing and invalid configs are preserved. XDG_CONFIG_HOME is honored; an existing legacy config is preserved if the new destination has no config. Defaults disable automatic enqueue, select a local worker and an Ollama summary endpoint on loopback. Ollama/Whisper and their models must be installed separately; nothing downloads a model automatically. Existing explicit API/remote configuration remains in effect. API subscriptions and chat subscriptions are separate: no bundled API entitlement is assumed.

```sh
falatrace config
falatrace record doctor
falatrace help
```

Do not paste configuration into public issues. Review destinations and providers before recording or processing. New capture requires operator authorization and appropriate participant consent. Automatic call detection is heuristic, opt-in and does not establish consent.

## Summaries and AI context

Transcript text falls back to valid segment text when the aggregate text is empty. New summaries can reference actual segment IDs, source timestamps and SHA-256 hashes. Approximate block timing is labeled. Missing or uncertain references trigger review. Reference validation proves structural traceability, not that the model's interpretation is correct. Long transcripts are preplanned into at most eight chunks, each within the configurable character budget and 1,000 segments, up to 8,000 source segments. Global segment IDs survive chunking; oversized sentences retain approximate original intervals. Completed chunks have checksummed private checkpoints. Deterministic merging requires human review; no hidden reduction model call occurs. Automatic multi-chunk OpenAI summaries are refused without an explicit paid-budget policy.

`context search`, `context meeting`, and per-client context export provide bounded interfaces to your assistants. Meeting content is untrusted historical data. Before deleting a recording, invalidation must succeed or deletion is cancelled. Deletion invalidates derived context for application consumers until a full rebuild. Previously exported files or copies already held by other apps remain outside this guarantee.

Studio visual requests now use the production local adapter and summary path after explicit model capability checks and bound consent. Verification used synthetic video and completely stubbed HTTP transport; no installed-model quality is certified. See docs/ALPHA2-LOCAL-REVIEW.md for data disclosure, fixed-root 24-inference/16-preview guard, persistence and limits. There is no new CLI toggle. The selector receives bounded transcript windows; requested frames must reference supplied segments and nearby timestamps. A persistent ledger enforces two rounds, eight frames, four selection/inspection inference requests (failed calls count), 2 MiB per frame and 8 MiB total. Local metadata preflight calls are separate from inference counts. The Ollama visual adapter accepts only credential-free loopback and verified local model metadata; cloud or unknown models are refused before chat. No model is downloaded or contacted automatically.

Frames have a configurable 60-second to 24-hour TTL (default one hour). Expired evidence falls back to transcript-only with review warnings and zero visual inference. Explicit cleanup deletes only verified derived frames and retains the budget ledger and observation metadata; it is not a scheduled service and does not erase original media. A sidecar is associated with summary.json only when its summarySha256 matches. Publication is atomic per file, not a multi-file transaction.

Cancellation reaches transcription, extraction and summary requests; it cannot retract data already accepted by a provider or guarantee cleanup of its entire subprocess tree. Corrupt/incompatible transcript cache fails closed instead of silently uploading again. Source hashes are checked before and after processing; receipts bind new transcripts to parameters. Legacy transcripts remain usable with explicit uncertainty about original parameters. New artifact files are private and atomically replaced.

## Retention and removal

Expired failed directories are cleaned only when they contain disposable recognized metadata and no media, unknown files, subdirectories or symlinks. Cleanup is conservative and can retain data for manual review. Use dry-run first.

Local deletion moves local artifacts to Trash and reports that remote copies, archive catalog and auxiliary state are preserved. It does not promise remote erasure. Uninstall removes only the installed CLI:

```sh
make uninstall INSTALL_PREFIX="$HOME/.local"
```

Configuration, recordings, jobs and backups remain. Removing optional services is a separate explicit operation.

## Development and release gates

```sh
bash scripts/test-offline.sh
bun run typecheck
bun run desktop:check
bun run build
bun run benchmarks/offline.ts
bun run benchmarks/synthetic-demo.ts /tmp/new-synthetic-demo-directory
```

The demo requires a new output directory and generates a three-second test video plus scripted transcript/model responses. It proves plumbing and cache reuse, not capture or semantic model quality. Never pass production media.

Tests must run with synthetic HOME/XDG and fixture media. Some tests use local sockets and local rsync fixtures. Do not run integration tests with production credentials or active capture/cloud services. The audit harness blocks those commands and external fetches; it is included in scripts/test-offline.sh. A manual-only CI draft is prepared but was not executed; action SHAs are pinned and token persistence disabled; the workflow still requires review before any manual run.

MIT applies to code authored by Caio Barbieri; third-party notices and licenses remain unchanged. Dependencies, native runtimes and models are not bundled. Compiling a standalone binary locally is supported by the build command; distributing that binary requires a separate review of embedded runtime obligations. Native capture and real-model quality remain experimental. Preserve existing persisted `recording-cli` identifiers; legacy archive schema keys are retained for compatibility. No public history, private config or media belongs in the package.

## Migration and scope

The executable is `falatrace`; the existing `recording-cli` repository and installed executable are not renamed or removed. Existing configuration/state/service identifiers remain `recording-cli` for compatibility. Do not run both applications against the same active job/capture state. Installation does not replace the old executable; use explicit CLI commands to inspect the configured providers and paths. Existing provider/remote choices remain in effect.

The npm package is private because this alpha is distributed as source through GitHub, not published to npm. Linux is the only target. MIT covers user-owned code; see [LICENSE](LICENSE) and [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Studio and first use

`bun run desktop` builds the Qt shell using an existing local SDK; `bun run desktop:setup` is a separate explicit dependency-download operation. The tested native runtime was Qt 6.10.2 + MpvQt on Linux; it is not bundled, and Ubuntu runtime compatibility is not universal. The legacy launcher/binary name `recording-studio` is retained. The Studio supports dark/light themes, search, transcript, summary/context, explicit capture confirmation, automation pause/resume and a return to the library. Closing the window keeps configured background services running; **Parar** ends the current capture, while **Pausar novas gravações** affects future automatic captures only.

Before recording: `falatrace init`, `falatrace config`, `falatrace record doctor`. Inspect the audio/provider settings and participants’ permission. Existing settings are preserved, including external providers. Check `calls status` and `record status`; use `calls pause` and `record stop` deliberately. No install/init command starts capture.

Synthetic native Qt renders cover light/dark, compact (900×640), summary, consent, empty, loading, error, REC and paused states. Nine programmatic QML checks passed; real keyboard input, Orca, portal capture and video decode remain unverified. See [UX verification](docs/UX-VERIFICATION.md). Optional repeatable native check: build the desktop with the existing SDK, then `python3 scripts/test-desktop-ui.py /tmp/falatrace-ui-review`; it uses only a synthetic backend and refuses capture operations.

[Landing page](https://caiolombello.github.io/falatrace/) · [Roadmap](docs/ROADMAP.md) · [Identity](branding/README.md)
