import { promises as fs, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Fake subscription CLIs (claude, codex, gemini, opencode, agy) as small POSIX shell scripts in a
// temporary PATH. Each run records its argv (NUL-separated), working directory, directory
// listing, stdin and environment under $FAKE_CLI_LOG, then behaves as $FAKE_CLI_MODE says.

const RECORD = `
log="$FAKE_CLI_LOG"
printf '%s\\0' "$@" > "$log.argv"
pwd > "$log.cwd"
ls -A > "$log.ls"
env > "$log.env"
cat > "$log.stdin"
`;

/** Ignores SIGINT once (records it), exits on SIGTERM: shows the INT → TERM escalation. */
const SLOW = `
if [ "$FAKE_CLI_MODE" = "slow" ]; then
  trap 'echo INT >> "$log.signals"' INT
  trap 'echo TERM >> "$log.signals"; exit 143' TERM
  echo $$ > "$log.pid"
  while true; do sleep 1 & wait $!; done
fi
`;

const CLAUDE = `#!/bin/sh
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then
  case "$FAKE_CLAUDE_AUTH" in
    none) echo '{"loggedIn":false,"authMethod":"none"}'; exit 1 ;;
    garbage) echo 'not json'; exit 0 ;;
    *) echo '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}'; exit 0 ;;
  esac
fi
${RECORD}
${SLOW}
case "$FAKE_CLI_MODE" in
  error) echo '{"type":"result","subtype":"success","is_error":true,"result":"Invalid API key · Please run /login"}'; exit 1 ;;
  garbage) echo 'Segmentation fault'; exit 0 ;;
  warning) echo 'warning: something odd'; echo '{"type":"result","subtype":"success","is_error":false,"result":"Depois do aviso."}' ;;
  empty) echo '{"type":"result","subtype":"success","is_error":false,"result":"   "}' ;;
  huge) printf '{"type":"result","subtype":"success","is_error":false,"result":"'; head -c 1000010 /dev/zero | tr '\\0' a; printf '"}\\n' ;;
  max) echo '{"type":"result","subtype":"success","is_error":false,"result":"Cortado","stop_reason":"max_tokens"}' ;;
  *) echo '{"type":"result","subtype":"success","is_error":false,"result":"Resposta do Claude.","usage":{"input_tokens":120,"output_tokens":7}}' ;;
esac
`;

const CODEX = `#!/bin/sh
if [ "$1" = "login" ] && [ "$2" = "status" ]; then
  if [ "$FAKE_CODEX_AUTH" = "none" ]; then echo 'Not logged in' >&2; exit 1; fi
  echo 'Logged in using ChatGPT'; exit 0
fi
${RECORD}
${SLOW}
out=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-o" ]; then out="$2"; fi
  shift
done
case "$FAKE_CLI_MODE" in
  error) echo 'error: not logged in' >&2; exit 1 ;;
  nofile) exit 0 ;;
  symlink) ln -s "$FAKE_CLI_TARGET" "$out"; exit 0 ;;
  *) printf 'Resposta do Codex.\\n' > "$out" ;;
esac
`;

const GEMINI = `#!/bin/sh
${RECORD}
${SLOW}
case "$FAKE_CLI_MODE" in
  auth) echo 'Please set an Auth method' >&2; exit 41 ;;
  error) echo '{"response":null,"error":{"type":"ApiError","message":"quota"}}'; exit 0 ;;
  *) echo '{"response":"Resposta do Gemini.","stats":{"models":{}}}' ;;
esac
`;

const OPENCODE = `#!/bin/sh
${RECORD}
${SLOW}
case "$FAKE_CLI_MODE" in
  error) echo '{"type":"error","error":{"name":"ProviderAuthError"}}'; exit 0 ;;
  *)
    echo '{"type":"step_start","part":{}}'
    echo 'not json'
    echo '{"type":"text","part":{"text":"Parte um."}}'
    echo '{"type":"tool_use","part":{"tool":"read"}}'
    echo '{"type":"text","part":{"text":"Parte dois."}}'
    echo '{"type":"step_finish","part":{}}'
    ;;
esac
`;

/** Antigravity CLI 1.4: stream-json events in, stream-json events out, one "result" at the end. */
const AGY = `#!/bin/sh
${RECORD}
${SLOW}
echo '{"event":"init","init":{"cwd":"/w","tools":["read_file","run_command"],"permission_mode":"always-proceed"}}'
case "$FAKE_CLI_MODE" in
  auth) echo '{"event":"result","result":{"status":"ERROR","response":"","error":"Print mode: auth error: not signed in"}}'; echo 'AGY_ERROR' >&2; exit 3 ;;
  error) echo '{"event":"result","result":{"status":"ERROR","response":"","error":"model unavailable"}}'; exit 3 ;;
  nofinal) echo '{"event":"step_update","step_update":{"step_type":"agent_response","text_delta":"Parcial"}}' ;;
  streaming)
    printf '%s' '{"event":"step_update","step_update":{"step_type":"agent_response","text_delta":"Ação '
    printf '%s\\n' 'confirmada"}}'
    echo '{"event":"step_update","step_update":{"step_type":"thought","text_delta":"pensamento privado"}}'
    echo '{"event":"step_update","step_update":{"step_type":"tool_result","text_delta":"resultado de ferramenta"}}'
    echo ready > "$log.partial"
    while [ ! -f "$log.release" ]; do sleep 0.02; done
    printf '%s' '{"event":"result","result":{"status":"SUCCESS","response":"Ação confirmada."}}'
    ;;
  *)
    echo '{"event":"step_update","step_update":{"step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"Resposta "}}'
    echo 'not json'
    echo '{"event":"result","result":{"conversation_id":"c1","status":"SUCCESS","response":"Resposta do Antigravity.","num_turns":1,"usage":{"input_tokens":150,"output_tokens":9}}}'
    ;;
esac
`;

export const FAKE_CLI_SCRIPTS = { claude: CLAUDE, codex: CODEX, gemini: GEMINI, opencode: OPENCODE, agy: AGY } as const;

export type FakeCliRun = { argv: string[]; cwd: string; listing: string; stdin: string; env: Map<string, string> };

/** Writes the fake CLIs into dir/bin (only the ones named) and returns that directory. */
export const installFakeClis = async (dir: string, names: Array<keyof typeof FAKE_CLI_SCRIPTS> = ["claude", "codex", "gemini", "opencode"]): Promise<string> => {
  const bin = join(dir, "bin");
  await fs.mkdir(bin, { recursive: true });
  for (const name of names) await fs.writeFile(join(bin, name), FAKE_CLI_SCRIPTS[name], { mode: 0o755 });
  return bin;
};

/**
 * A new PATH directory whose tools run the fakes in `bin` with `vars` (FAKE_CLI_MODE…) set.
 * Agents and CLIs get a minimal environment, so a fake's own settings travel in its wrapper,
 * never through the environment the provider is given. Tools in `bin` that are not executable
 * are left out, as they would be on a real PATH.
 */
export const wrapFakeTools = (bin: string, vars: Record<string, string>): string => {
  const wrapped = mkdtempSync(join(dirname(bin), "path-"));
  const exports = Object.entries(vars).map(([name, value]) => `export ${name}='${value.replaceAll("'", "'\\''")}'\n`).join("");
  for (const name of readdirSync(bin)) {
    if ((statSync(join(bin, name)).mode & 0o111) === 0) continue;
    writeFileSync(join(wrapped, name), `#!/bin/sh\n${exports}exec '${join(bin, name)}' "$@"\n`, { mode: 0o755 });
  }
  return wrapped;
};

/** What the last run of a fake CLI recorded. */
export const readFakeCliRun = async (log: string): Promise<FakeCliRun> => {
  const read = (suffix: string) => fs.readFile(`${log}.${suffix}`, "utf8");
  const argv = (await read("argv")).split("\0");
  argv.pop();
  const env = new Map<string, string>();
  for (const line of (await read("env")).split("\n")) {
    const index = line.indexOf("=");
    if (index > 0) env.set(line.slice(0, index), line.slice(index + 1));
  }
  return { argv, cwd: (await read("cwd")).trim(), listing: (await read("ls")).trim(), stdin: await read("stdin"), env };
};
