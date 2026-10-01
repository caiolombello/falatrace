# Persistent opt-in + agent retrieval — alpha.5

Introduced in alpha.5. No installed grants, client connections, credentials or API dispatch are enabled automatically.

## Finite slices

1. Persistent user opt-in, local retrieval independent of new summary/inference, public CLI contract and image-bearing MCP tool contract; synthetic regression tests. Target of this slice.
2. Optional configured OpenAI/Google analysis adapters with exact destination/model capability and stub-only validation; separate opt-in recipient. No automatic API/key setup or paid inference.
3. Optional local derived observations/memory with provenance, uncertainty and source/revocation invalidation. No default durable raw-frame memory.

No old five-minute receipt becomes a persistent authorization. Alpha.4 remains installed/public while this is reviewed.

## One explicit choice, then on-demand tools

Opt-in states the recipient (local agent client or specific provider), data (bounded context and/or frames), recording IDs or configured recording workspace, limits and derived retention. Keep pause/revoke visible. Within that choice, requests/restart/cache expiry do not cause per-image consent; scope or destination changes require a new user choice. Exhausted budgets report usage and limits; never reset counters/namespace/cache to bypass them.

The caller may request only registered recording IDs and bounded timestamps; no arbitrary filesystem path. Silent/missing-transcript video remains usable for authorized frame retrieval. A client lacking vision gets a declared limitation, not silent API fallback. Existing source hash changes invalidate access/results. Revalidate authorization after admission queue and before returning pixels. Heavy work still yields to call/recording priority.

## Tool surface

| Tool | Result / truthful boundary |
|---|---|
| `capabilities` | supported operations, recipient/vision expectations, limits and unavailable analysis/memory clearly reported |
| `search` | bounded records inside active authorized scope only; no global private-content scan by default |
| `get_context` | existing selected transcript/summary excerpts, omissions/timing/provenance, no new summary or provider |
| `get_frames` | local pixels with source/hash, requested and decoded timestamp when verifiable, declared precision, MIME/dimensions, segment IDs where available and omissions; zero inference |
| `analyze_context` | separately authorized provider analysis in later slice; current retrieval contract must report unavailable, never fake analysis |

CLI returns JSON and private derived files in the shared filesystem; MCP returns actual image blocks plus provenance JSON. MCP image content uses `type: image`, base64 `data`, `mimeType`; a bare local path is not an image result. [MCP tools specification](https://modelcontextprotocol.io/specification/2025-06-18/server/tools).

Future OpenAI analysis uses Responses image inputs; future Google analysis uses generateContent inline image data, each with an explicitly selected model and recipient. Neither is entitlement from an agent/chat subscription. [OpenAI image inputs](https://developers.openai.com/api/docs/guides/images-vision), [Google generateContent](https://ai.google.dev/api/generate-content).

## Required evidence

Synthetic media/fixtures only: persistent opt-in across processes and cache expiry; no per-frame reauthorization; zero inference/re-summary in retrieval; revoke while queued; mismatched scope/recipient; source changed; VFR/start offset without invented precision; concurrency/idempotent cache and persistent attempts; missing transcript; client without vision. CLI/transport/frontmatter updates follow actual implemented commands, not planned names.

This is the experimental alpha.5 contract. Tool connection/agent settings and new installed grants are not activated automatically. Metadata assertions are not authentication against the filesystem owner, and already delivered copies cannot be retracted by revoke.

## Implemented first-slice boundary

Implemented commands: `agent-context capabilities`, `authorize`, `status`, `pause`, `resume`, `revoke`, `get-frames`, `serve`. Registered recording IDs are resolved through existing JobStore/ArchiveStore, not demo data. Grants persist, are frames-only for a named local agent and do not auto-convert legacy receipts. A workspace-snapshot storage type exists, but ordinary CLI grants accept selected existing recording IDs only. A separate explicit installation grant is documented below; installation alone never authorizes future recordings.

FFmpeg extracts real JPEGs without transcript/provider prerequisites. Actual decoder `showinfo` PTS plus ffprobe container start offset determines normalized time when verifiable. No transcript was supplied to this retrieval, so segment IDs are unavailable, not invented. CLI JSON/private files and experimental stdio MCP image content work; no client connection is installed. MCP supports only protocol2025-06-18/get_frames, sequential requests; cancellation notifications are not supported yet. CLI cancellation is implemented.

Persistent app-ledger preview attempts reuse the same canonical user-installation root as Studio, across grants, cache expiry and restart. Normal cache hit is idempotent; concurrent duplicate requests fail clearly before work. Decode misses/failures consume attempts without refund. Default policy16previews/24inferences is not a subscription/global machine/API cap. Explicit config changes retain counters. User-owned state can be deliberately edited/deleted; this is not a tamper-proof multi-user quota system.

TTL cleanup is bounded and lazy for managed entries on retrieval, not a daemon. Revocation revalidates after queue and before return, but cannot reclaim delivered copies. Interrupted scratch may remain. Source metadata/storage are trusted local-user boundaries; no protection against a hostile filesystem owner is claimed.

Studio offers persistent opt-in and agent-scoped search/context/frames with the same explicit data grant, status, pause/revoke and optional preview. Reopening does not renew budgets. Separate OpenAI/Google analysis adapters are present with API dispatch disabled by default; they do not enable memory or full-summary regeneration. Existing local-Ollama Studio analysis remains a separate workflow. Synthetic tests do not validate real client integration/vision, billing, capture, playback or semantic quality.

## Explicit installation-wide frames opt-in

Alpha.5 additionally supports `agent-context authorize-installation --recipient codex-openai|claude-anthropic|gemini-google --include-future --exclude-secrets --consent`. This is a separate frames-only opt-in covering current/future registered media in this installation. It never enables API analysis or transcript/summary retrieval. Ordinary per-recording grants stay fixed. Installation grants can list only opaque recording IDs with `agent-context recordings --grant UUID --recipient NAME [--offset N] [--limit N]`. MCP exposes only `list_recordings` and `get_frames` for this scope.

Pause/revoke use existing commands. `agent-context exclude-recording --grant UUID --recording UUID` blocks a sensitive recording for that grant, including cached/pending access; apply the exclusion to every recipient that must not receive it. Exclusion increments revision, so subsequent previews for other recordings may require fresh extraction and consume the same lifetime budget. Exclusions persist; no automatic un-exclude. Finalized registered sources and hashes are verified on each retrieval; missing, unsealed, changed or out-of-installation media is refused. Source versions intentionally replaced in the registered catalog are covered by this broad scope; in-flight changes are refused.

A recipient label is not cryptographic provider authentication. The local stdio launcher fixes the recipient/grant, and requests cannot select another one. Other processes with the same OS-account filesystem access are outside this identity boundary. No client connector is installed by the package. Codex/Claude/Gemini clients require their own supported setup and session refresh; this does not imply the hosted ChatGPT/Claude/Gemini websites can access local tools.

Secret exclusion is an operator obligation, not automatic detection/redaction. Exclude recordings known to contain passwords, keys or other secrets before letting assistants retrieve them. Images already delivered may be uploaded by that assistant to its provider and cannot be recalled. This option does not guarantee that unreviewed media is secret-free.
