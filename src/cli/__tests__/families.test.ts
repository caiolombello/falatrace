import { expect, test } from "bun:test";
import { version as productVersion } from "../../../package.json";
import { CLI_FAMILY_NAMES, familyLoader } from "../families";
import { commandHelp, HELP_COMMANDS, mainHelp } from "../help";
import {
  CLI_KNOWN_ERRORS, CLI_MESSAGES, CLI_USAGE, MISSING_VALUE, oneLine, parseArgs, readJob, readStdinText, requireJobId, terminalText, UNKNOWN_OPTION
} from "../shared";

test("the overview starts with the banner and pitch, then groups tasks, without the old duplicated list", () => {
  const help = mainHelp(productVersion);
  const lines = help.split("\n");
  expect(lines[0]).toBe(`FalaTrace ${productVersion} (Linux, experimental)`);
  expect(lines[1]).toContain("Notas de reunião");
  // Strings the CLI contract tests rely on.
  for (const text of ["FalaTrace", "context meeting", "calls pause"]) expect(help).toContain(text);
  const groups = ["Gravar", "Processar", "Notas e resumos", "Perguntar", "Pessoas e ações", "Compartilhar", "Configurar", "Serviços", "Avançado/legado"];
  const positions = groups.map((group) => lines.indexOf(group));
  expect(positions.every((position) => position > 0)).toBe(true);
  expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  expect(help).not.toContain("Additional commands");
  expect(help).not.toContain("\u001b");
  // Every family is reachable from the overview.
  for (const family of CLI_FAMILY_NAMES) expect(help).toContain(`${family} `);
});

test("every command family has its own details and a loader; other commands are left to index.ts", async () => {
  for (const family of CLI_FAMILY_NAMES) {
    expect(commandHelp(family)).toBeString();
    expect(HELP_COMMANDS).toContain(family);
    const load = familyLoader(family);
    expect(load).toBeFunction();
    expect(await load!()).toBeFunction();
  }
  for (const command of ["record", "keys", "models", "review", "summary-review", "time", "calls", "context"]) expect(commandHelp(command)).toBeString();
  for (const command of ["record", "jobs", "calls", "help", "toString", "constructor", undefined]) expect(familyLoader(command)).toBeUndefined();
  expect(commandHelp("toString")).toBeUndefined();
  expect(commandHelp("nope")).toBeUndefined();
});

test("arguments are parsed strictly: unknown options and missing values are refused", () => {
  const parsed = parseArgs(["a", "--to", "slack", "--yes", "b", "--alias", "x", "--alias", "y", "--", "--not-an-option"], {
    values: ["--to"], flags: ["--yes"], lists: ["--alias"]
  });
  expect(parsed.positionals).toEqual(["a", "b", "--not-an-option"]);
  expect(parsed.values).toEqual({ "--to": "slack" });
  expect(parsed.lists).toEqual({ "--alias": ["x", "y"] });
  expect([...parsed.flags]).toEqual(["--yes"]);
  expect(() => parseArgs(["--bogus"], {})).toThrow(UNKNOWN_OPTION);
  expect(() => parseArgs(["--to"], { values: ["--to"] })).toThrow(`${MISSING_VALUE} --to.`);
  expect(() => parseArgs(["--to", "--yes"], { values: ["--to"], flags: ["--yes"] })).toThrow(MISSING_VALUE);
});

test("untrusted text reaches the terminal without control sequences or bidirectional overrides", () => {
  const hostile = "Título\u001b]0;pwned\u0007 \u009b2J‮etirw‬⁦x⁩\r\nfim";
  expect(oneLine(hostile)).toBe("Título ]0;pwned 2Jetirwx fim");
  expect(terminalText(hostile)).toBe("Título ]0;pwned   2Jetirwx\nfim");
  expect(terminalText("a\tb\nc\r\nd\re f")).toBe("a\tb\nc\nd\ne\nf");
});

test("job ids, stdin limits and missing jobs give the CLI's Portuguese messages", async () => {
  expect(requireJobId("AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA")).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  expect(() => requireJobId("../x")).toThrow(CLI_MESSAGES.jobIdRequired);
  expect(() => requireJobId(undefined)).toThrow(CLI_MESSAGES.jobIdRequired);
  const missing = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  await expect(readJob({ get: async () => { throw missing; } }, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).rejects.toThrow(CLI_MESSAGES.jobNotFound);
  const chunks = async function* () { yield Buffer.from("abc"); yield "def"; };
  expect(await readStdinText(10, chunks())).toBe("abcdef");
  await expect(readStdinText(4, chunks())).rejects.toThrow(CLI_MESSAGES.inputTooLarge);
  // Every fixed message and usage line is listed for translation.
  for (const message of [...Object.values(CLI_MESSAGES), ...Object.values(CLI_USAGE)]) expect(CLI_KNOWN_ERRORS).toContain(message);
});
