import { loadConfig } from "../config/load";
import { getSecretFiles, isSecretName, parseManagerEnvironment, removeSecret, setSecret } from "../config/secrets";
import { readCredentialStatus } from "../config/settings";
import { defaultKeyTestDeps, testProviderKey } from "../config/credential-test";
import { runCommand } from "../jobs/command";

export const KEYS_HELP = `API keys (stored in a private secrets.env; values are never printed):
  keys status                    Where each key comes from for background processing
  keys set <NAME>                Read the value from standard input and save it
  keys remove <NAME>             Remove a key saved by FalaTrace
  keys test <openai|gemini>      Ask the provider whether the key is accepted (lists models only)
  NAME: OPENAI_API_KEY, GEMINI_API_KEY or RECORDING_CLI_OBS_PASSWORD
`;

const managerEnv = () => runCommand("systemctl", ["--user", "show-environment"], { timeoutMs: 5_000 })
  .then(({ stdout }) => parseManagerEnvironment(stdout), () => null);

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 8192) throw new Error("Valor grande demais.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
};

export const runKeysCli = async (args: string[]): Promise<void> => {
  const [, subcommand, name] = args;
  if (subcommand === "status" || !subcommand) {
    const { config } = await loadConfig();
    const status = await readCredentialStatus(config, { managerEnv: await managerEnv() });
    console.log(JSON.stringify({ secretsFile: getSecretFiles()["secrets.env"], ...status }, null, 2));
    return;
  }
  if (subcommand === "set") {
    if (!isSecretName(name)) throw new Error("Use OPENAI_API_KEY, GEMINI_API_KEY ou RECORDING_CLI_OBS_PASSWORD.");
    if (process.stdin.isTTY) process.stderr.write(`Cole o valor de ${name} e pressione Ctrl+D: `);
    await setSecret(name, await readStdin());
    console.log(JSON.stringify({ name, saved: true, file: getSecretFiles()["secrets.env"] }));
    return;
  }
  if (subcommand === "remove") {
    if (!isSecretName(name)) throw new Error("Use OPENAI_API_KEY, GEMINI_API_KEY ou RECORDING_CLI_OBS_PASSWORD.");
    console.log(JSON.stringify({ name, ...await removeSecret(name) }));
    return;
  }
  if (subcommand === "test") {
    if (name !== "openai" && name !== "gemini") throw new Error("Use: keys test openai | keys test gemini");
    const { config } = await loadConfig();
    console.log(JSON.stringify(await testProviderKey(name, defaultKeyTestDeps(managerEnv, config.openai.apiKey))));
    return;
  }
  throw new Error("Use: keys status | keys set <NAME> | keys remove <NAME> | keys test <openai|gemini>");
};
