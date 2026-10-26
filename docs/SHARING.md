# Sharing

Send a meeting's notes to Obsidian, Notion, Slack, the clipboard or an AI app. You always see the content first. Destinations outside this computer need your consent for each share.

## What is sent

A Markdown note built from the meeting:

- title, date, people and client, and the template used;
- the overview and the notes by section (your items and the AI items, as plain text);
- decisions, and the open and done actions as `- [ ]` and `- [x]` (dismissed actions, and actions no longer in the current summary, stay out);
- with `summary+notes` (the default), your notes as you typed them;
- with `full`, also the transcript, one line per segment with time and speaker;
- a `falatrace://recording/<job-id>` link back to the recording.

Meeting text is cleaned of markup that the destination could execute. Obsidian notes also carry YAML frontmatter (`title`, `date`, `falatrace_job`, `participants`, `client`, `template`, `tags: ["falatrace"]`, `source` and a `falatrace_snapshot` hash).

From the terminal:

```sh
falatrace share <job-id> --to obsidian --dry-run                 # prints the Markdown, sends nothing
falatrace share <job-id> --to notion --include summary --yes
falatrace share <job-id> --to clipboard --include full
```

`--to` is `clipboard`, `obsidian`, `notion`, `slack` or `ai-app`; `--include` is `summary`, `summary+notes` or `full`.

## Consent

| Destination | Leaves this computer | Consent |
| --- | --- | --- |
| Clipboard | No (until you paste it somewhere) | Not needed |
| Obsidian | No: a file in your vault | Not needed |
| Notion | Yes: Notion's servers | `--yes`, or the consent step in the Studio |
| Slack | Yes: Slack's servers | `--yes`, or the consent step in the Studio |
| AI app | Yes: the app sends the note to its own AI provider | `--yes`, or the consent step in the Studio |

The CLI prints the destination (`Destino: … (fora deste computador)`) and stops without `--yes`. In the Studio, sharing goes preview, then consent, then send; the button names what it will do, and a share is refused if the destination changed after the preview. <!-- studio-check --> A vault on a synced folder (for example Obsidian Sync or a cloud drive) is synced by that tool, not by FalaTrace.

## Destinations

### Obsidian

1. Set `destinations.obsidianVault` to your vault folder (an existing, real folder; not a link).
2. Optionally change `destinations.obsidianFolder` (default `FalaTrace`), a folder inside the vault.

Each share writes `<vault>/<folder>/<YYYY-MM-DD HH-mm — title>.md` (names up to 120 characters). FalaTrace never overwrites your edits: sharing the same content again reuses the file; a file you did not change since FalaTrace wrote it is replaced; otherwise a new `… (2).md` is created. Vault files are ordinary files (readable by others like the rest of your vault). The Studio can open the note in Obsidian afterwards; the CLI does not. <!-- studio-check -->

### Notion

1. In Notion, create an internal integration and copy its token.
2. Open the page that will hold the notes and connect the integration to it.
3. Set `destinations.notionParentId` to that page's id (the 32 hexadecimal characters at the end of its link).
4. Save the token as `NOTION_TOKEN`: in the Studio's Settings › Sharing (or the API keys section), or `printf '%s' "$TOKEN" | falatrace keys set NOTION_TOKEN`.

Each share creates a new page under the parent and prints its link. Long notes are sent in batches. In the Studio a share has 24 seconds; a very large note can stop partway, leaving a partial page in Notion that you can delete.

### Slack

1. In Slack, create an incoming webhook for the channel (an app with Incoming Webhooks).
2. Save its URL as `SLACK_WEBHOOK_URL` (`falatrace keys set SLACK_WEBHOOK_URL` reads it from standard input). It must start with `https://hooks.slack.com/services/`.

The note is posted to that channel; a long note is split into several posts (up to 12,000 characters each). A note that would need more than 10 posts is refused; share it with `--include summary` instead. The webhook URL is a secret: logs keep only `hooks.slack.com/services/T…/B…/***`.

### Clipboard

The Studio copies the note itself. The CLI uses `wl-copy`, `xclip` or `xsel`; without them, it writes a private file and prints its path.

### AI apps

`destinations.aiApp` chooses the app (default `chatgpt-web`):

| Value | What happens |
| --- | --- |
| `chatgpt-web`, `claude-web`, `gemini-web` | The note is copied, and the app's page opens in the browser. Meeting text never goes into the address. You paste and send it. |
| `claude-desktop` | Claude Desktop opens with a new chat filled in (up to 14,000 characters; a longer note is copied instead). You send it. |
| `claude-cli`, `codex-cli`, `gemini-cli`, `opencode-cli` | The note is written to a private file in a folder of its own, and a terminal opens there with the tool and the prompt "Leia o arquivo <nome> (contexto de uma reunião registrada no FalaTrace) e me ajude com ele." The tool reads the file and sends it to its provider right away. |

Whichever app you use, it sends the note to its own AI provider under that app's terms. That is why FalaTrace asks for consent, even though it does not send anything itself.

## What FalaTrace keeps

- A delivery log per recording in `~/.local/state/recording-cli/share-deliveries/<job-id>.json`: time, destination, the target with secrets removed, the content's SHA-256 and the result. Never the content itself. The 200 most recent deliveries are kept.
- Clipboard fallback files and AI app handoff files live in `$XDG_RUNTIME_DIR/recording-cli/` (cleared at logout), or under `~/.local/state/recording-cli/` without a runtime folder. They are removed after a day, on the next share.

Deleting a note in FalaTrace, or the recording, does not remove what a destination already received. See [privacy](PRIVACY.md).
