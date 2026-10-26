# Development

How to build, test and release FalaTrace from a source checkout. User documentation starts at the [README](../README.md).

## Install from source

Bun 1.4.0 with `bun.lock` is the tested installation path. The lock pins every package by version and hash, including Biome, a development-only linter, and its optional per-platform binaries; an installation fetches only the binary for its platform. `--ignore-scripts` keeps package install scripts from running. A fresh `node_modules` installation from a local cache, plus the standalone build, install, init and uninstall, passed in earlier releases; a download on a machine without a cache is still untested. The legacy pnpm lock is not the canonical installation path.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run typecheck
bun run build
make install-cli INSTALL_PREFIX="$HOME/.local"
falatrace init
```

- `make install` installs the CLI without running sudo or apt. OS dependencies are a separate, explicit `make install-deps` (Ubuntu packages for capture and the tray).
- `make install-studio` builds the Studio with the local Qt headers (system packages, or `bun run desktop:setup`, which downloads them into a user cache) and adds the `recording-studio` launcher, a menu entry and the icon, without sudo or downloads. `make uninstall-studio` and `make uninstall` remove only what they installed.
- `bun run desktop` builds and runs the Qt shell with an existing local SDK. The tested native runtime was Qt 6.10.2 with MpvQt on Linux; it is not bundled, and runtime compatibility across distributions is not universal.
- Qt, GTK/mpv playback, Whisper.cpp and its models, and the desktop capture backends have their own requirements. Windows and macOS are not supported.
- `falatrace init` creates a private configuration only when none exists. Existing and invalid configurations are preserved, `XDG_CONFIG_HOME` is honored, and an existing legacy configuration is kept when the new location has none. Defaults disable automatic processing and point summaries at Ollama on loopback. No command downloads a model on its own.

## Checks before a commit

```sh
bun run typecheck
bun run desktop:check
bun run lint
bash scripts/test-offline.sh
bun run build
```

- `bun run lint` runs Biome on the files listed in `biome.json` `files.includes`. Add every new source and test file there. Lint errors fail CI; warnings do not.
- TypeScript is strict with `lib` ES2021: `.at()`, `Object.hasOwn`, `findLast` and `toSorted` do not type-check.
- `SOURCE-MANIFEST.json` lists every tracked file with its SHA-256. Regenerate it after `git add`:

  ```sh
  python3 -c "import json,hashlib,subprocess;m=json.load(open('SOURCE-MANIFEST.json'));fs=sorted(p for p in subprocess.check_output(['git','ls-files']).decode().splitlines() if p!='SOURCE-MANIFEST.json');m['files']=[{'path':p,'sha256':hashlib.sha256(open(p,'rb').read()).hexdigest(),'bytes':len(open(p,'rb').read())} for p in fs];open('SOURCE-MANIFEST.json','w').write(json.dumps(m,indent=2)+'\n')"
  ```

## The offline test harness

Always run tests through `bash scripts/test-offline.sh [paths…]`. A plain `bun test` fails closed on purpose (`bunfig.toml` preloads the same guard).

- The script creates a private root under `/tmp` with its own `HOME`, XDG directories, `TMPDIR` and a marker nonce, and runs Bun with `env -i` and a minimal `PATH`.
- Capture, service and cloud commands (`ssh`, `systemctl`, `systemd-run`, `pactl`, `pw-dump`, `obs`, `notify-send`, `flatpak`, `gpu-screen-recorder`, `wf-recorder`, `aws`, `rclone` and others) are replaced by stubs that exit 97. `rsync` only accepts local paths under `/tmp`.
- `scripts/offline-network.ts` refuses any `fetch` to a host other than loopback, and also loopback ports 11434 (Ollama) and 4455 (OBS). Fake servers in tests use `Bun.serve({ port: 0 })`.
- Commands the stubs do not cover (`xdg-open`, `wl-copy`, `claude`, `codex`, `gemini`, `opencode`, `kiro-cli`, `ffmpeg` for live work…) must be injected in tests. Code that touches the outside world takes injectable fetch, spawn, clock and store directories.
- Build configurations with `structuredClone(DEFAULT_CONFIG)` and temporary folders with `fs.mkdtemp(join(tmpdir(), "x-"))`.
- Do not run integration tests with production credentials, active capture or cloud services. Some tests use local sockets and local rsync fixtures.

`scripts/test-heavy-regressions.py` is a separate fixed subset with its own blocked-command list.

## Studio journeys

The journeys render the real QML offscreen against synthetic bridges and assert on its state. CI runs them with PySide6 pinned by hash in `scripts/studio-requirements.txt`. Locally:

```sh
python3 -m venv /tmp/qt && /tmp/qt/bin/python -m pip install --require-hashes --no-deps -r scripts/studio-requirements.txt
FALATRACE_QML_PYTHON=/tmp/qt/bin/python bash scripts/test-studio-journeys.sh /tmp/falatrace-journeys
```

- Each journey is `scripts/test-<name>.py` and must be listed in `scripts/test-studio-journeys.sh`; a missing file is skipped silently. There are 18: `settings-ux`, `process-ux`, `agent-ux`, `desktop-ui`, `local-ux`, `scope-ux`, `planner-ux`, `heavy-ux`, `speakers-ux`, `retention-ux`, `notes-ux`, `live-ux`, `ask-ux`, `home-ux`, `entities-ux`, `share-ux`, `templates-ux` and `video-ux`. [UX verification](UX-VERIFICATION.md) lists what each one covers.
- Journeys patch `src/desktop/Main.qml` by removing its final `}` and appending timers, so `Main.qml` must end with the root `}`. QML files must stay flat in `src/desktop/`.
- No journey waits a fixed delay. Every step waits for the state it needs with a bounded condition ("wait until X or N ms"), so a reply that never comes fails that step's checks instead of hanging the run or passing by luck. Build the steps with `qml_steps()` from `scripts/studio_fixture.py`: it runs them in order, each once its condition holds, and sets `qaSnapshotReady` after the last one so the PySide6 runner takes the snapshot then; `RECORDING_DESKTOP_SNAPSHOT_MS` is only the deadline. Check the output with `require_assertion_lines()`, so a run that ended before its last step fails.
- Journeys with several modes (ask, home, entities, share, templates, retention, video) use `run_journey_modes()`: each mode is a window size, a theme and a list of `(name, ready, body)` steps. `ux_step()` turns a step into an assertion line, and a ready condition that never held counts as a failed check. The stub reads its mode from `FALATRACE_TEST_MODE` and logs each request to `FALATRACE_REQUEST_LOG`, so the journey can also check what was sent. `finish_journey()` writes the receipt.
- A step that needs a real key press sets `qaKeys` (Qt key codes, such as `qaKeys = [Qt.Key_Space]`). The PySide6 runner activates the window and presses each key through the window system, so window shortcuts and the focused control see it as they would a person's key; the next step waits for its effect. Four modes use it: `video-ux` `keys`, `notes-ux` `tab`, and `ask-ux` `long` and `library-consent`.
- The native shell has neither hook: it takes the snapshot at the deadline and cannot press keys, so the steps above time out on it. `scripts/studio_fixture.py` prefers `dist/desktop/recording-studio` when it is built; set `FALATRACE_STUDIO_RUNNER=pyside` to run the journeys through the PySide6 runner, as CI does. `video-ux` also needs the runner's stand-in player.
- While a smoke recording is selected, `Main.qml` rereads its detail every 5 seconds. A journey's stub answers `detail` with everything the real bridge would return at that point, such as a visual review that has finished. Otherwise a slow run loses that state partway through.
- Unknown operations in journey stubs answer `ok: false`. Every new bridge operation also goes into `OPERATIONS` in `src/desktop/bridge.ts`, and every new fixed Portuguese message into its module's `*_KNOWN_ERRORS` and an English entry in `src/desktop/i18n.js`.

Optional native check with the built shell: `bun run desktop:build`, then `python3 scripts/test-desktop-ui.py /tmp/falatrace-ui-review`. It uses a synthetic backend and refuses capture operations. Earlier native renders covered light and dark themes, the compact 900×640 layout, summary, consent, empty, loading, error, REC and paused states; real keyboard input, Orca, portal capture and video decoding were not verified. See [UX verification](UX-VERIFICATION.md).

## Benchmarks and the synthetic demo

```sh
bun run benchmarks/offline.ts
bun run benchmarks/synthetic-demo.ts /tmp/new-synthetic-demo-directory
```

The demo needs a new output directory and generates a three-second test video with scripted transcript and model replies. It proves plumbing and cache reuse, not capture or model quality. Never pass production media.

## CI

The public workflow runs on `main` and pull requests: install, type checks, lint, the offline suite and the build, plus the Studio journeys. Action SHAs are pinned and token persistence is disabled. Passing CI does not validate native capture, real providers or model quality.

## Releases

- During development, `CHANGELOG.md` has a top `## Unreleased — <theme>` section: bold lead-ins, CLI commands, and a final **Checks.** bullet with the test and journey counts.
- A release commit `chore(release): 0.2.0-alpha.N` bumps `package.json` and `SOURCE-MANIFEST.json`, renames the CHANGELOG heading, adds `docs/ALPHA<N>.md` (changes, verification, limits, installation and rollback), and updates the README version line, `skills/falatrace/SKILL.md`, `skills/README.md`, the ROADMAP checkpoint, `docs/UX-VERIFICATION.md`, `THIRD-PARTY-NOTICES.md` when dependencies changed, and both landing pages (announce bar, install commands, tag and tarball links, counts).
- Commits follow Conventional Commits (`feat(notes): …`, `fix(bridge): …`, `docs(site): …`).

## Packaging boundaries

MIT applies to code authored by Caio Barbieri; third-party notices and licenses stay their own. Dependencies, native runtimes and models are not bundled. Compiling a standalone binary locally is supported; distributing that binary needs a separate review of the embedded runtime's obligations. The npm package is private: FalaTrace is distributed as source through GitHub. No private configuration, recording or history belongs in the package.
