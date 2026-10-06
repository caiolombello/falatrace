import { expect, test } from "bun:test";
import { buildAssistantConnection } from "../connect";

const grant = { id: "123e4567-e89b-42d3-a456-426614174000", recipient: { id: "claude-anthropic" } };

test("assistant commands register the local stdio server for one grant", () => {
  const connection = buildAssistantConnection(grant, ["/home/u/.local/bin/falatrace"]);
  const serve = "/home/u/.local/bin/falatrace agent-context serve --grant 123e4567-e89b-42d3-a456-426614174000 --recipient claude-anthropic";
  expect(connection.serverName).toBe("falatrace-claude-anthropic");
  expect(connection.claude).toBe(`claude mcp add --scope user --transport stdio falatrace-claude-anthropic -- ${serve}`);
  expect(connection.codexCommand).toBe(`codex mcp add falatrace-claude-anthropic -- ${serve}`);
  expect(connection.codexToml).toContain('command = "/home/u/.local/bin/falatrace"');
  expect(JSON.parse(connection.geminiSettings)).toEqual({ mcpServers: { "falatrace-claude-anthropic": {
    command: "/home/u/.local/bin/falatrace", args: ["agent-context", "serve", "--grant", grant.id, "--recipient", "claude-anthropic"]
  } } });
});

test("source runs and paths with spaces are quoted for the shell", () => {
  const connection = buildAssistantConnection({ ...grant, recipient: { id: "codex.openai" } }, ["/usr/bin/bun", "/home/u/my repo/src/cli/index.ts"]);
  expect(connection.claude).toContain("/usr/bin/bun '/home/u/my repo/src/cli/index.ts' agent-context serve");
  expect(connection.serverName).toBe("falatrace-codex-openai");
});

test("malformed grants are refused", () => {
  expect(() => buildAssistantConnection({ id: "x", recipient: { id: "a" } }, ["/f"])).toThrow("inválida");
  expect(() => buildAssistantConnection({ ...grant, recipient: { id: "Bad Name" } }, ["/f"])).toThrow("inválida");
});
