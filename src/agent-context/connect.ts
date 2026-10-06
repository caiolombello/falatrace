import { getServiceLaunchCommand } from "../runtime/launcher";

/**
 * Commands that register FalaTrace's local stdio MCP server with an assistant client
 * for one existing grant. Nothing is installed or run here: the user copies the command
 * into a terminal of their own. The server name includes the recipient so several
 * grants can coexist.
 *
 * Syntax checked against the official docs on 2026-10-05:
 * Claude Code `claude mcp add [options] <name> -- <command> [args...]`;
 * Codex `codex mcp add <name> -- <command>` or `[mcp_servers.<name>]` in ~/.codex/config.toml;
 * Gemini CLI `mcpServers` in ~/.gemini/settings.json.
 */
export type AssistantConnection = {
  serverName: string;
  claude: string;
  codexCommand: string;
  codexToml: string;
  geminiSettings: string;
  geminiSettingsPath: string;
};

const shellQuote = (value: string): string => (/^[A-Za-z0-9_./:=@%+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`);

export const buildAssistantConnection = (
  grant: { id: string; recipient: { id: string }; status?: string },
  launch: string[] = getServiceLaunchCommand()
): AssistantConnection => {
  if (!/^[a-f0-9-]{36}$/i.test(grant.id) || !/^[-a-z0-9._]{1,64}$/.test(grant.recipient.id)) throw new Error("Permissão inválida.");
  const [command, ...prefix] = launch;
  const args = [...prefix, "agent-context", "serve", "--grant", grant.id, "--recipient", grant.recipient.id];
  const serverName = `falatrace-${grant.recipient.id.replace(/[^a-z0-9-]/g, "-")}`.slice(0, 64);
  const line = [command, ...args].map(shellQuote).join(" ");
  return {
    serverName,
    claude: `claude mcp add --scope user --transport stdio ${serverName} -- ${line}`,
    codexCommand: `codex mcp add ${serverName} -- ${line}`,
    codexToml: `[mcp_servers.${serverName}]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}\n`,
    geminiSettings: JSON.stringify({ mcpServers: { [serverName]: { command, args } } }, null, 2),
    geminiSettingsPath: "~/.gemini/settings.json"
  };
};
