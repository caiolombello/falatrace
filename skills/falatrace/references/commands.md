# Command contracts (experimental alpha.4)

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

The following are available but require task-specific authorization, selected inputs and provider/destination/cost review. Listing them here does not authorize execution:

- `transcribe <file> --target <local|remote> --transcriber <whisper-cpp|openai|gemini> --summarizer <openai|ollama>` creates/starts a job; providers may receive media. `--target local` is an execution host choice, **not a guarantee of no external provider**.
- `jobs process <job-id>` / `jobs retry <job-id>` may execute inference/provider calls. `jobs sync` can transfer private media/results.
- `context build` writes derived memory. Upload/backup/archive sync/export may expose private data or use remotes.
- `record start`, `calls resume`, service install/start and config edits can enable capture. `calls pause` affects future automation; `record stop` ends the active capture. Never interchange them.
- `jobs cleanup --dry-run` previews eligibility; cleanup without dry-run and other deletion/reset actions require exact scope. Do not imply deletion reaches originals/provider copies/remotes.

Source-safe synthetic example: search `"synthetic chart"`, choose the returned fixture UUID, read its bounded context, then cite only supplied segment timing. Missing transcript/summary is a limitation, not permission to run a new model.
