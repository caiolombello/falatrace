# FalaTrace 0.2.0-alpha.20

Experimental Linux source release that reorganizes the Studio's AI settings — one group for every place that chooses an AI, an overview of where each part runs, and a shorter way to choose who answers questions — plus a round of interface polish. Everything else is alpha.15 to alpha.19, described in [ALPHA15.md](ALPHA15.md) to [ALPHA19.md](ALPHA19.md).

## Changes

**Every AI choice in one group.** Choosing an AI was spread over six Settings sections in two groups: who transcribes and summarizes (Processamento e IA), who answers questions (Perguntar e receitas, filed under meetings), the keys, the local model downloads, the live transcript and optional features. The list now has four groups — Reuniões, *Inteligência artificial*, Gravação and Sistema — and the AI group holds the new **Visão geral da IA**, Perguntar e receitas, Processamento e IA, Transcrição ao vivo, Chaves de API and **Modelos locais** (was Modelos; the messages that point to it say so). Section indices keep their meaning; the overview is section 16.

**Where each part runs.** Visão geral da IA reads the draft and shows, for the transcription of recordings, notes and summaries, questions and the live transcript, who does it (provider and model) and whether it stays on this computer or leaves it; a chosen external provider without its key says "Falta a chave". Each row opens the page that changes it; the number of saved API keys and the local models come last. Nothing is saved from this page.

**A shorter way to choose who answers questions.** Perguntar e receitas showed five large cards at once (local Ollama, API, ACP agent, command-line subscription, Sign in with ChatGPT), with Claude, Codex and Gemini named in two of them and the chosen card's fields pushing the others out of view. There are now three short choices — *Neste computador*, *Sua conta ou ferramenta* and *Uma chave de API* — and the chosen one's settings in one panel below them. *Sua conta ou ferramenta* lists Sign in with ChatGPT and the Claude Code, Codex, Gemini (agy) and OpenCode command-line tools together, connected first, each with its install and sign-in state and whose account and cost it uses; only the ChatGPT sign-in promises no usage charge. An ACP agent, the context size and meaning-based search are under **Mais opções**, which opens by itself when an ACP agent is the choice. The saved values (`local`, `api`, `acp`, `cli`, `chatgpt`) and the tools confirmation are unchanged.

**Installed tools named correctly.** The bridge dropped each detected tool's command, so the tool list read "Claude Code (undefined) · conectado" and the agy note for Gemini never showed. `assistant-detect` now sends `command` and `cliFound`.

**Polish.** "Modelo padrão" and "Modelos" in Notas e resumos read "Modelo de notas padrão" and "Modelos de notas", apart from the AI models. Settings pages and every scrolling dialog show their scroll bar whenever there is more to scroll, in a fixed gutter. Text fields, combo boxes and text areas get borders of at least 3:1 (`controlBorder`). The footer says "1 alteração não salva" / "N alterações não salvas" instead of "alteração(ões) não salva(s)". Home hides a plan chip that has no label.

**Notes correction.** docs/ALPHA19.md said the desktop type check passed on the release machine; it fails there for the same environment reason as the type check (a `node_modules` without the Anthropic SDK) and passes in CI. The document and the alpha.19 release text now say so.

## Verification

Every Settings section was rendered offscreen (PySide6 6.11, synthetic bridge with the real `settings-read` result of a synthetic configuration and synthetic tool detection) at the top, middle and end of its scroll, and Perguntar e receitas with each of the five choices, at 1366×768 in both themes and at 900×640, 1920×1080 and 1324×1416, before and after; the whole Studio (800 scenes) and the dialogs were rendered again after the change, with no new clipping, overlap, low-contrast text, binding or polish loop. An independent visual QA pass by a second model reviewed the settings before the change, then rejected one round (the subscription card promised no usage charge for tools that may bill by usage) and approved the corrected wording.

On the release machine (Fedora 44 KDE, Bun 1.4.0) the offline suite gave the same 34 environment-only failures as untouched alpha.19 there (its `node_modules` lacks the Anthropic SDK, FFmpeg lacks libx264, strace is not installed), with 2,594 passing tests across 248 files; Biome reports 0 errors (587 warnings, unchanged). All 18 Studio journeys pass (975 assertions across 207 screens), run with Qt logging sent to standard error, which Fedora's default `qtlogging.ini` hides; one of them (`agent-ux`) caught a scroll-bar gutter that looped the layout of Acesso para IA during this work, fixed before the release. The type checks report the Anthropic SDK missing from that machine's `node_modules`, as on alpha.19. Public CI runs the install, type checks, lint, offline suite, build and journeys on the pull request.

## Limits

The checks use synthetic data and a synthetic tool detection: real sign-ins, real agents and real billing were not exercised, and what each tool costs depends on the account it is signed in to. Keyboard use of the new controls was not tested with real key presses. Everything listed in [ALPHA15.md](ALPHA15.md#limits) still applies.

## Installation and rollback

Same as alpha.19: update only when no capture or processing is active, and reconnect existing MCP sessions to use the new executable. Configurations, data and services from alpha.19 are unchanged; no setting was renamed or moved in the configuration file. Alpha.19 remains available for rollback. This document describes the release, not an installed-state receipt.
