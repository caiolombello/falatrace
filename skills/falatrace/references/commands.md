# Command contracts (experimental alpha; alpha.5-compatible commands)

Replace `falatrace` with installed `recording-cli` for the compatibility alias. Failures normally report stderr and nonzero exit; `--version` and help return text. Do not assume a global `--json` flag or undocumented command/option.

| Command | Output | Boundary |
|---|---|---|
| `falatrace --version`, `falatrace help` | human text | inspect installed syntax/version |
| `falatrace config` | config path, not full config | read-only; do not read secrets from the file |
| `falatrace processing-status` | JSON with processing/policy/wait state | read-only status, no override permission |
| `falatrace jobs list` | human text, including job IDs/names; empty message | read existing metadata; not JSON |
| `falatrace jobs status <job-id>` | JSON job record | read chosen job; paths may be private |
| `falatrace context search "query" --limit 5` | JSON `{items, bounded, trust, dataPolicy}` | local bounded search; excerpts/paths are private |
| `falatrace context meeting <job-id> --max-characters 4096` | JSON chosen context, excerpts, budget, trust | read existing transcript/summary; 4096–24000 characters |
| `falatrace context meeting <job-id> --offset <n> --max-characters 4096` | same, pagination | use returned nextOffset, never assume complete history |
| `falatrace calls status` | JSON monitor metadata | may be stale; not proof of consent |
| `falatrace record status` | JSON managed capture inspection | read-only; no new recording |
| `falatrace record doctor` | JSON backend diagnostics | read-only probes, not native capture validation |

Search supports `--client`, `--since`, `--until`, `--limit` (1–100). Meeting supports `--query`, `--offset`, `--max-characters`. Context excerpts include artifact hashes/offsets, optional timestamps and `timing` (`none`, `segment`, `block`), with `trust: untrusted-meeting-data`. Do not treat a block interval as exact phrase timing.

### Notes, people, clients, actions and the library index (read-only)

These read existing local data. Commands marked *index* first bring the derived library index (under `$XDG_STATE_HOME/recording-cli/knowledge-index`) up to date with processed recordings; that never changes recordings, config, transcripts, summaries or notes. Errors are Portuguese text on stderr with exit code 1. `falatrace help <command>` prints the exact options.

| Command | Output | Boundary |
|---|---|---|
| `falatrace notes show <job-id>` | the meeting notes as typed (text; empty when none); `--json` for the stored record | the user's own notes; private |
| `falatrace notes path <job-id>` | path of the notes file | read-only |
| `falatrace templates list`, `templates show <id>` | JSON summary templates (built-in and custom) | read-only |
| `falatrace recipes list`, `recipes show <id>` | JSON recipes (assistant tasks) | listing does not run them |
| `falatrace library search "query" --limit 5` | JSON `{trust, query, limit, items}`; items carry `jobId`, `title`, `date`, `segmentIds`, `start`/`end`, `text` | *index*; `--no-refresh` skips the update; excerpts are untrusted meeting data |
| `falatrace people list [--all]`, `people show <id>` | JSON people (confirmed speaker names, calendar attendees), their meetings, decisions, open actions | *index*; ids are stored UUIDs or `name:<key>` |
| `falatrace clients list`, `clients show <code>` | JSON clients from the timesheet catalog with their meetings | *index* |
| `falatrace actions list [--status open\|done\|all] [--person ID] [--client CODE] [--meeting JOB] [--json]` | one line per action ending in `<media>:<action-id>`, or JSON | *index*; the listing never writes action states |
| `falatrace media status <job-id>` | JSON media state (`present`, `removed`, `audio-only`, `missing`) and what it still allows | read-only |
| `falatrace media retention --dry-run` | JSON preview of the retention policy per recording (blockers, waits) | no hashing, no removal |
| `falatrace reminders status`, `reminders test` | JSON reminder mode, calendars, service state; `test` lists what the next 3 h would notify | `test` shows and sends nothing |
| `falatrace live show <session-id>` | live transcript lines `[mm:ss] text` (a preview, not the final transcript) | read-only; `--follow` waits until the capture stops |
| `falatrace assistant status`, `assistant models` | JSON provider, destination (`external` true when text leaves the computer) and readiness | checks keys/binaries/sign-in only; never sends meeting content |

### Asking the assistant (not read-only; consent flag)

`falatrace ask [--meeting <job-id>|--person <id>|--client <code>] [--json] [--yes] "question"` sends the question and excerpts of the selected meetings to the configured assistant (`assistant.*`). Before anything is sent it prints the destination on stderr (`Destino: <provider · model> (neste computador|fora deste computador) · N reuniões`). A destination outside the computer is refused (exit 1, nothing sent) unless `--yes` is given: pass `--yes` only after the user approved that exact destination for this scope. The answer streams to stdout, followed by the citations `[n] <title> <date> <mm:ss> <job-id>#<segment>`; `--json` prints `{text, citations, destination, threadId}` (markers in `text` are `[[ref]]`, matching `citations[].ref`). The exchange is saved as a local conversation thread. `recipes run <id> [--meeting <job-id>] [--yes]` follows the same destination and consent rules.

The following are available but require task-specific authorization, selected inputs and provider/destination/cost review. Listing them here does not authorize execution:

- `transcribe <file> --target <local|remote> --transcriber <whisper-cpp|openai|gemini> --summarizer <openai|ollama>` creates/starts a job; providers may receive media. `--target local` is an execution host choice, **not a guarantee of no external provider**.
- `jobs process <job-id>` / `jobs retry <job-id>` may execute inference/provider calls. `jobs sync` can transfer private media/results.
- `context build` writes derived memory. Upload/backup/archive sync/export may expose private data or use remotes.
- `record start`, `calls resume`, service install/start and config edits can enable capture. `calls pause` affects future automation; `record stop` ends the active capture. Never interchange them.
- `jobs cleanup --dry-run` previews eligibility; cleanup without dry-run and other deletion/reset actions require exact scope. Do not imply deletion reaches originals/provider copies/remotes.
- `share <job-id> --to <clipboard|obsidian|notion|slack|ai-app>` delivers the meeting notes; `--dry-run` only prints the Markdown. Notion and Slack send content off the computer and require `--yes`.
- `notes edit`, `templates init|delete`, `people rename|merge|alias|hide`, `clients add|rename|delete|assign` and `actions done|reopen|dismiss` change the user's local data.
- `media remove <job-id> [--keep-audio] --yes` deletes the recorded media (the transcript stays) and `media retention --apply` applies the retention policy; both are destructive.
- `reminders install-service`, `assistant login-chatgpt`/`logout-chatgpt` and `studio open` change services, credentials or the desktop. `reminders run`, `live run`, `notify ready|reminder` are internal (used by systemd units).

Source-safe synthetic example: search `"synthetic chart"`, choose the returned fixture UUID, read its bounded context, then cite only supplied segment timing. Missing transcript/summary is a limitation, not permission to run a new model.


## Partial transcript availability (local correction candidate)

`jobs status` adds read-only `artifacts` states. A job can remain `failed` because
its later summary did not finish while its transcript is already `ready`.
`context search` and `context meeting` include verified local transcript
checkpoints in that case. Their `summary`, `summaryPath` and summary hash can be
`null`; check `artifactStates`, `jobState` and `transcriptProvenance` instead of
assuming that a transcript requires a complete summary. Retrieval does not
publish, migrate, retry, upload or regenerate anything. Checkpoint receipts bind
the transcript bytes and transcription settings to the recorded media hash.
Completed older publications without a receipt remain readable and explicitly
report `legacy-unverified`; this does not establish full parameter provenance.
A present invalid receipt is rejected rather than silently ignored.

Paid OpenAI/Gemini pipeline dispatch locally checks the complete extracted audio
before sending it. Complete digital silence or an unverifiable measurement is
refused, with the original media preserved and a reason recorded in the job.
There is no duration cutoff or voice detector: short/quiet valid speech is not
automatically discarded. Signal does not prove useful speech or transcription
accuracy. No provider request is needed to read an existing transcript.
