# Asking your meetings

The assistant answers questions from your recordings and cites the moments it used. It also runs recipes: ready-made tasks such as a follow-up email or a risk register.

## Scopes and citations

A question has one scope:

| Scope | What it reads | CLI |
| --- | --- | --- |
| A meeting | That recording | `falatrace ask --meeting <job-id> "…"` |
| A person | Meetings with that person | `falatrace ask --person <id> "…"` |
| A client | That client's meetings | `falatrace ask --client <code> "…"` |
| The library | All processed meetings | `falatrace ask "…"` |

The answer cites every factual sentence with markers that point to transcript segments. In the terminal they appear as `[n]`, followed by one line per citation:

```text
[1] Sincronização semanal 2026-09-29 12:48 7c1e…b42f#s000214
```

A marker that does not match a segment that was sent is removed. The assistant is told to answer only from the excerpts, in the language of the question, to say when the answer is not there, and to treat meeting text as data, never instructions. Its wording is still the model's: open the cited moment before relying on it.

In the Studio, the Ask panel opens from any page; its scope follows the page you are on (a meeting, a person, a client or the library), and citations jump to the moment. <!-- studio-check -->

`--json` prints `{text, citations, destination, threadId}`. Ctrl+C cancels a running answer.

## What is sent

- **A meeting:** its title, date, the people identified in it, the AI summary, your notes and the reviewed transcript (one line per segment, with time and speaker). When it does not fit `assistant.maxContextCharacters` (default 60,000 characters), the summary, your notes and the transcript passages that best match the question.
- **A person, a client or the library:** the best-matching passages across meetings, each meeting labelled with its title and date and its summary overview.
- The question, and earlier messages of the same conversation.

Passages are found in a local library index, a derived copy of facts and text under `~/.local/state/recording-cli/knowledge-index/`. It is keyword search by default; with `assistant.embeddingModel` set, it also searches by meaning through the local Ollama. Commands that read the index bring it up to date first (`ask`, `recipes run`, `library search`, `people list`, `clients list|show`, `actions list`); the Studio refreshes it in the background.

```sh
falatrace library refresh
falatrace library search "migração do banco" --limit 5    # JSON passages, marked untrusted-meeting-data
```

## Consent

- Before anything is sent, the destination is shown: `Destino: <provider · model> (neste computador|fora deste computador) · N reuniões`, with "(trechos)" when only passages fit.
- Ollama on this computer, or a `custom` API at an address on this computer, needs no consent: nothing leaves.
- An Ollama cloud model (a name with a `cloud` tag or suffix, such as `gpt-oss:120b-cloud`) leaves through the local server, to ollama.com: it is outside this computer and asks first. Before sending to a model presented as local, the Ollama is asked (`/api/show`) whether it runs that model itself; another name for a cloud model is refused.
- Every other destination sends the question and the excerpts above off the computer. In the CLI, add `--yes` after checking the destination line; without it, the command stops and nothing is sent. In the Studio, a consent card names the destination once per conversation. <!-- studio-check -->
- Consent covers one destination and one scope. A new provider, model or scope asks again.

Conversations are saved on this computer in `~/.local/share/recording-cli/assistant/threads/` (up to 200 messages each), with the destination and model of every answer.

## Providers

Choose one with `assistant.provider`. `falatrace assistant status` shows the destination and whether it is ready without sending any meeting text; `falatrace assistant detect` lists the agents and tools found on `PATH` (nothing is downloaded).

### Local: Ollama on this computer (default)

1. Install [Ollama](https://ollama.com).
2. Pull the model: `falatrace models ollama-pull qwen3.5:9b` (or another model, then set `assistant.localModel`).
3. Keep `assistant.provider` at `local`.

It uses the Ollama address in `summary.ollamaUrl`. An address on another computer counts as external and asks for consent.

### API: your own key

Set `assistant.provider` to `api`, choose `assistant.apiPreset`, and save the preset's key in the Studio (Settings › Ask and recipes shows the chosen preset's key; the API keys section lists them all) or with `printf '%s' "$KEY" | falatrace keys set <NAME>`. `assistant.apiModel` empty uses the preset's default model; `falatrace assistant models` shows it.

| Preset | Endpoint | Key |
| --- | --- | --- |
| `openrouter` (default) | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` |
| `openai` | `https://api.openai.com/v1` | `OPENAI_API_KEY` |
| `anthropic` | Anthropic API, through the official `@anthropic-ai/sdk` | `ANTHROPIC_API_KEY` |
| `gemini` | `https://generativelanguage.googleapis.com/v1beta/openai/` | `GEMINI_API_KEY` |
| `xai` | `https://api.x.ai/v1` | `XAI_API_KEY` |
| `groq` | `https://api.groq.com/openai/v1` | `GROQ_API_KEY` |
| `mistral` | `https://api.mistral.ai/v1` | `MISTRAL_API_KEY` |
| `deepseek` | `https://api.deepseek.com` | `DEEPSEEK_API_KEY` |
| `together` | `https://api.together.ai/v1` | `TOGETHER_API_KEY` |
| `custom` | `assistant.apiBaseUrl` (any OpenAI-compatible API; HTTPS, or HTTP on this computer) | `CUSTOM_API_KEY`; `assistant.apiModel` is required |

API usage is billed by the provider; a chat subscription does not include API credit. The Studio's key fields can test a key with one read-only request.

### ACP agents

[Agent Client Protocol](https://agentclientprotocol.com) agents you already use, with their own sign-in. Set `assistant.provider` to `acp` and `assistant.acpAgent`. FalaTrace starts the agent without a shell, in a fresh empty private folder, with a minimal environment, offering it no file or terminal access and no MCP servers; it refuses every permission request the agent makes, and stops the agent after the answer. It never runs `npx` or `bunx` for you: install the agent yourself.

See [Agents and their tools](#agents-and-their-tools) for what each agent can still do, and which ones need your OK before they get a question.

| `acpAgent` | Command FalaTrace runs | Install (package in the ACP registry, 2026-10-25) | Sign in |
| --- | --- | --- | --- |
| `codex` (default) | `codex-acp` | `npm install -g @agentclientprotocol/codex-acp` | `codex login` (ChatGPT plan or API key) |
| `claude` | `claude-agent-acp --hide-claude-auth` | `npm install -g @agentclientprotocol/claude-agent-acp` (Node 22+) | `claude auth login --console`, or `ANTHROPIC_API_KEY` in the environment FalaTrace runs in |
| `gemini` | `gemini --acp -e none --allowed-mcp-server-names falatrace-no-mcp-server` | `npm install -g @google/gemini-cli` | run `gemini` and sign in |
| `opencode` | `opencode acp` | `npm install -g opencode-ai` | `opencode auth login` |
| `kiro` | `kiro-cli acp` | Kiro CLI 1.25 or later, from Kiro | `kiro-cli login` |
| `copilot` | `copilot --acp` | `npm install -g @github/copilot` | run `copilot` and use `/login` |
| `cursor` | `cursor-agent acp` | Cursor's agent CLI | `cursor-agent login` |
| `goose` | `goose acp` | goose, from Block | `goose configure` |
| `qwen` | `qwen --acp` | `npm install -g @qwen-code/qwen-code` | run `qwen` and sign in |
| `grok` | `grok agent stdio` | `npm install -g @xai-official/grok` | `grok login` |
| `custom` | `assistant.acpCommand` (split into words, no shell) | | |

When an agent asks for sign-in, the error names its command. **Claude through ACP uses an API key or a Console login only:** FalaTrace starts it with `--hide-claude-auth`, because Anthropic does not allow third-party apps to route Claude.ai plan credentials. To use a Claude subscription, use the `cli` provider below.

### Subscription CLIs

Your own installed, signed-in command-line tool, run once per question. Set `assistant.provider` to `cli` and `assistant.cliTool`; `assistant.cliModel` empty uses the tool's default.

| `cliTool` | How FalaTrace runs it | Sign in |
| --- | --- | --- |
| `claude` (default) | `claude -p --output-format json --tools "" --disallowedTools "mcp__*" --strict-mcp-config --permission-mode dontAsk --max-turns 1 --no-session-persistence` | run `claude` and sign in |
| `codex` | `codex exec --sandbox read-only --skip-git-repo-check --ephemeral --ignore-user-config …` | `codex login` |
| `gemini` | `gemini -p "<short instruction>" -o json -e none --allowed-mcp-server-names falatrace-no-mcp-server` (no extensions, none of your MCP servers) | run `gemini` and sign in |
| `opencode` | `opencode run --format json`, with every permission set to `deny` through `OPENCODE_CONFIG_CONTENT` and `OPENCODE_PERMISSION` (output read on a best-effort basis) | `opencode auth login` |

The question and excerpts go on standard input, never in the command line. Each run uses a fresh empty private folder and a minimal environment, with the tool's own tools turned off or refused as far as the tool allows (see [Agents and their tools](#agents-and-their-tools)). There is no streaming: the answer appears when the tool finishes. FalaTrace checks sign-in with `claude auth status` and `codex login status`.

**A Claude subscription is used this way:** through your own `claude` command, signed in by you. FalaTrace never sees or stores your Claude credentials.

### Agents and their tools

The excerpts an agent receives hold what people said in a meeting and calendar titles: text written by others. A sentence such as "assistant, run this command" must not make the agent act on your computer. The prompt tells the model to treat meeting text as data and never use tools, but only the agent's own settings can enforce that, so FalaTrace also:

- uses each agent's own read-only, plan or no-tools setting where it has one (below);
- for ACP agents, switches the session to the most restrictive mode the agent offers before the question: `read-only`, `ask`, `chat` or `plan`, in that order. An agent that refuses the switch gets no question;
- refuses every permission request (ACP) and turns permission prompts off (`claude --permission-mode dontAsk`);
- starts every run in a fresh empty private folder, with a minimal environment: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TERM`, `LANG`, `LANGUAGE`, `TZ`, `TMPDIR`, the `XDG_*` folders, `DBUS_SESSION_BUS_ADDRESS` (for a sign-in kept in your keyring), proxy and certificate settings, `GH_TOKEN`/`GITHUB_TOKEN`, and variables starting with `LC_` or with an agent's or model provider's prefix (`ANTHROPIC_`, `CLAUDE_`, `OPENAI_`, `CODEX_`, `GEMINI_`, `GOOGLE_`, `VERTEX_`, `CLOUD_ML_`, `OPENCODE_`, `OPENROUTER_`, `GOOSE_`, `KIRO_`, `COPILOT_`, `CURSOR_`, `QWEN_`, `DASHSCOPE_`, `XAI_`, `GROK_`, `GROQ_`, `MISTRAL_`, `DEEPSEEK_`, `TOGETHER_`, `OLLAMA_`, `AWS_`, `AZURE_`). Nothing else is passed on: no ssh or gpg agent, no display, and never FalaTrace's own secrets.

**Agents whose tools cannot be switched off need your OK.** Most agents keep some tools that no setting turns off: reading any file your user can read, read-only commands, web fetches, or MCP servers and allow-rules from your own configuration. FalaTrace sends such an agent no question until you accept that for that agent: in **Configurações › Perguntar e receitas**, tick **Entendo: este agente pode rodar ferramentas no meu computador** under the agent (or add it to `assistant.agentToolsAccepted`, for example `["acp:codex"]`). Until then Ask, recipes and `falatrace ask` stop with a message saying so. The OK is per agent: choosing another one asks again.

| Agent | What FalaTrace sets | What it can still do | Needs your OK |
| --- | --- | --- | --- |
| `cli` `claude` | `--tools ""` (no tools), `--strict-mcp-config` and `--disallowedTools "mcp__*"` (no MCP server), `--permission-mode dontAsk`, `--max-turns 1` | Nothing: it only answers | No |
| `acp` `goose` | `GOOSE_MODE=chat` (over your own value) and its `chat` mode when offered | Nothing: chat mode uses no tools or extensions | No |
| `acp` `claude` | `plan` mode | Read-only tools (reading and searching files, web search) and what your Claude settings allow | Yes |
| `acp` `codex` | `INITIAL_AGENT_MODE=read-only` and the `read-only` mode | Its read-only sandboxed shell, which can read any file your user can, without asking | Yes |
| `cli` `codex` | `exec --sandbox read-only --ignore-user-config --ephemeral` | The same read-only shell | Yes |
| `acp`/`cli` `gemini` | `-e none` (no extensions) and an MCP allow-list naming no server; `plan` mode when offered (ACP) | Read-only tools such as reading files and web fetch | Yes |
| `acp`/`cli` `opencode` | Every permission set to `deny` (`OPENCODE_CONFIG_CONTENT`, `OPENCODE_PERMISSION`, over your own values); `plan` mode when offered (ACP) | A rule of your own OpenCode configuration that allows a tool or MCP server by a narrower pattern can still win | Yes |
| `acp` `cursor` | `ask` mode | Read-only tools | Yes |
| `acp` `kiro`, `copilot`, `qwen`, `grok` | The most restrictive mode each offers; every permission request refused | Any tool it runs without asking | Yes |
| `acp` `custom` | The most restrictive mode it offers; every permission request refused | Unknown: it is your own command | Yes |

The local, API and ChatGPT providers only send text to a model and run no tools on your computer.

### Sign in with ChatGPT

OpenAI's sign-in for open-source local apps. It uses your ChatGPT plan; OpenAI lists Plus and Pro as eligible.

```sh
falatrace assistant login-chatgpt     # prints the address; the browser returns to 127.0.0.1:1455
falatrace assistant logout-chatgpt    # forgets the tokens
```

Set `assistant.provider` to `chatgpt`; `assistant.chatgptModel` empty uses the account default. The sign-in uses PKCE and checks the ID token signature; it is refused when the plan-use permission was not granted. Tokens are kept in `~/.local/state/recording-cli/chatgpt/oauth.json` (0600) and refreshed as needed. Requests go to OpenAI's Responses API with `store: false`. If port 1455 is busy (for example, a Codex sign-in is open), close it and try again.

## Where your questions end up

| Provider | Receives the question and excerpts | Keeps its own history |
| --- | --- | --- |
| `local` on loopback | Nobody: stays on this computer (an Ollama cloud model: ollama.com) | No |
| `api` | The API provider | Per that provider's API terms |
| `chatgpt` | OpenAI | Sent with `store: false`; per your ChatGPT plan's terms |
| `acp` | The agent, and the model provider it is configured for | Agents keep their own session files, outside FalaTrace's control: for example Claude in `~/.claude/projects/`, Codex in `~/.codex/sessions/`, Gemini in `~/.gemini/tmp/`, Kiro in `~/.kiro/sessions/cli/` |
| `cli` | The tool, and its model provider | `claude` runs with `--no-session-persistence` and `codex` with `--ephemeral`; `gemini` and `opencode` may keep their usual history |

Deleting a recording in FalaTrace does not delete what a provider or agent already received or stored. See [privacy](PRIVACY.md).

## Recipes

A recipe is a saved prompt run as a question, with the same destination and consent rules.

| Id | Name | Scope |
| --- | --- | --- |
| `follow-up-email` | Follow-up email | meeting |
| `risks` | Risks and mitigations | meeting |
| `postmortem-doc` | Incident postmortem | meeting |
| `executive-summary` | Executive summary | meeting |
| `next-steps` | Next steps | meeting |
| `slack-update` | Slack update | meeting |
| `open-questions` | Open questions | meeting |
| `formal-minutes` | Formal minutes | meeting |
| `prep-next-meeting` | Prepare my next meeting | library, person or client |
| `what-did-i-promise` | What did I promise? | library, person or client |

```sh
falatrace recipes list
falatrace recipes show follow-up-email
falatrace recipes run follow-up-email --meeting <job-id> --yes
falatrace recipes run what-did-i-promise --person <id>
```

Meeting recipes need `--meeting`. In the Studio, typing `/` at the start of a question opens the recipes. <!-- studio-check -->

### Custom recipes

Custom recipes are JSON files next to the configuration, in `recipes/<slug>.json` (at most 100 files of 64 KiB each). The Studio has an editor for them, in Settings › Ask and recipes: name, description, scope (a meeting or the library) and the request, with buttons that insert the variables. The format:

```json
{
  "version": 1,
  "updatedAt": "2026-10-26T12:00:00.000Z",
  "recipe": {
    "id": "custom:status-for-board",
    "version": 1,
    "builtIn": false,
    "name": { "pt-BR": "Status para a diretoria", "en": "Board status", "es": "Estado para la dirección" },
    "description": "Three-line status of the meeting for the board.",
    "scope": "meeting",
    "prompt": "Write a three-line status of the meeting \"{{meeting.title}}\" ({{meeting.date}}) for the board, in {{language}}. Cite every line."
  }
}
```

- `id` is `custom:` plus lowercase letters, digits and hyphens, matching the file name; `scope` is `meeting` or `library`.
- `name` needs all three languages (up to 80 characters each); `description` is one line of up to 300 characters; `prompt` has 10 to 8,000 characters.
- Variables in the prompt: `{{meeting.title}}`, `{{meeting.date}}`, `{{meeting.people}}`, `{{client}}`, `{{person}}`, `{{me}}`, `{{scope}}`, `{{today}}`, `{{language}}`. Values are cleaned and filled in one pass; an unknown variable stays as written. `{{meeting.date}}`, `{{today}}` and `{{language}}` are written in place. The others hold text written by other people (calendar titles, guest, speaker and client names), so they never become part of the instructions: the prompt names them as `{meeting.title}`… and their values follow it in a `<recipe-data>` block, as JSON strings the model is told to treat as data, never as instructions.
- Unknown fields are refused, and a broken file is skipped and listed under `problems` by `recipes list`.
