// Facts about the share destinations that need no delivery code: product names and which
// destinations need consent. The Studio bridge reads them at startup and loads the destinations
// themselves (Notion, Slack, Obsidian, clipboard) only when something is shared.
import type { AiAppTarget } from "../config/defaults";
import type { DestinationKind } from "./log";

/** Product names of the AI app targets (not translated). */
export const AI_APP_LABELS: Readonly<Record<AiAppTarget, string>> = Object.freeze({
  "chatgpt-web": "ChatGPT (web)",
  "claude-web": "Claude (web)",
  "claude-desktop": "Claude Desktop",
  "gemini-web": "Gemini (web)",
  "claude-cli": "Claude Code",
  "codex-cli": "Codex CLI",
  "gemini-cli": "Gemini CLI",
  "opencode-cli": "OpenCode"
});

/** Destinations whose content leaves this computer through FalaTrace itself. */
export const EXTERNAL_DESTINATIONS: readonly DestinationKind[] = Object.freeze(["notion", "slack"]);

/**
 * Destinations sent only with the person's consent: Notion and Slack, where FalaTrace sends the
 * content, and the AI app, whose command-line tools read the note and send it to their provider at
 * once. The CLI (`--yes`) and the Studio (consent dialog) use the same list.
 */
export const SHARE_CONSENT_DESTINATIONS: readonly DestinationKind[] = Object.freeze([...EXTERNAL_DESTINATIONS, "ai-app"]);
