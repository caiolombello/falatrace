import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeCredentials, parseEnvFile, parseManagerEnvironment, parseSecretLines, readSecret, readSecretFile, redactResolvedSecrets,
  removeSecret, resolveSecretFrom, setSecret, type SecretFiles
} from "../secrets";

const withFiles = async (run: (files: SecretFiles, root: string) => Promise<void>) => {
  const root = await fs.mkdtemp(join(tmpdir(), "falatrace-secrets-"));
  const files: SecretFiles = {
    "secrets.env": join(root, "config", "secrets.env"),
    "worker.env": join(root, "legacy", "worker.env"),
    "calls.env": join(root, "legacy", "calls.env")
  };
  await fs.mkdir(join(root, "legacy"), { recursive: true, mode: 0o700 });
  try { await run(files, root); } finally { await fs.rm(root, { recursive: true, force: true }); }
};

test("env lines accept export, quotes and comments and ignore anything else", () => {
  const values = parseSecretLines([
    "# comment", "export OPENAI_API_KEY='sk-synthetic one'", 'GEMINI_API_KEY="g\\"x"', "EMPTY=", "not a line",
    "RECORDING_CLI_OBS_PASSWORD=plain-value", "BAD=\u0007bell"
  ].join("\n"));
  expect(Object.fromEntries(values)).toEqual({
    OPENAI_API_KEY: "sk-synthetic one", GEMINI_API_KEY: 'g"x', RECORDING_CLI_OBS_PASSWORD: "plain-value"
  });
});

test("key files are read with the rules systemd uses for EnvironmentFile=", () => {
  const values = parseEnvFile([
    "A=sk-\\abc", "B=pass\\", "word", 'C="g-\\q \\" \\\\"', "D='it''s'", "  E = spaced value  ", "; comment",
    'F="multi', 'line"', "export G=exported"
  ].join("\n"));
  expect(Object.fromEntries(values)).toEqual({ A: "sk-abc", B: "password", C: 'g-\\q " \\', D: "its", E: "spaced value", F: "multi\nline", G: "exported" });
  expect(parseSecretLines('F="multi\nline"\nH=ok').has("F")).toBe(false);
});

test("files are read only when they are private regular files of this user", async () => {
  await withFiles(async (files, root) => {
    expect((await readSecretFile("worker.env", files["worker.env"])).exists).toBe(false);
    await fs.writeFile(files["worker.env"], "OPENAI_API_KEY=from-worker\n", { mode: 0o644 });
    const open = await readSecretFile("worker.env", files["worker.env"]);
    expect(open).toMatchObject({ usable: true, tooOpen: true });
    await fs.chmod(files["worker.env"], 0o664);
    expect(await readSecretFile("worker.env", files["worker.env"])).toMatchObject({ usable: false, problem: expect.stringContaining("alterá-lo") });
    await fs.writeFile(join(root, "target.env"), "OPENAI_API_KEY=x\n", { mode: 0o600 });
    await fs.symlink(join(root, "target.env"), files["calls.env"]);
    expect(await readSecretFile("calls.env", files["calls.env"])).toMatchObject({ usable: false, problem: expect.stringContaining("simbólico") });
  });
});

test("a FIFO at a key file path is rejected without waiting for a writer", async () => {
  await withFiles(async (files) => {
    expect(Bun.spawnSync(["mkfifo", "-m", "600", files["worker.env"]]).exitCode).toBe(0);
    const read = readSecretFile("worker.env", files["worker.env"]);
    const result = await Promise.race([read, Bun.sleep(2_000).then(() => "blocked" as const)]);
    if (result === "blocked") {
      // Release the blocked open so the failed run does not hang the suite.
      await fs.open(files["worker.env"], fs.constants.O_WRONLY | fs.constants.O_NONBLOCK).then((handle) => handle.close(), () => undefined);
      await read.catch(() => undefined);
    }
    expect(result).toMatchObject({ exists: true, usable: false, problem: expect.stringContaining("arquivo comum") });
  });
});

test("precedence: explicit environment, then the Studio file, then legacy files", () => {
  const state = (file: "secrets.env" | "worker.env" | "calls.env", value?: string) =>
    ({ file, path: file, exists: !!value, usable: !!value, tooOpen: false, values: new Map(value ? [["OPENAI_API_KEY", value]] : []) });
  const all = [state("secrets.env", "studio"), state("worker.env", "worker"), state("calls.env", "calls")];
  expect(resolveSecretFrom("OPENAI_API_KEY", {}, all)).toEqual({ value: "studio", source: "secrets.env" });
  expect(resolveSecretFrom("OPENAI_API_KEY", { OPENAI_API_KEY: "shell" }, all)).toEqual({ value: "shell", source: "environment" });
  // A unit that loaded worker.env repeats its value in the environment: the Studio key still wins.
  expect(resolveSecretFrom("OPENAI_API_KEY", { OPENAI_API_KEY: "worker" }, all)).toEqual({ value: "studio", source: "secrets.env" });
  expect(resolveSecretFrom("OPENAI_API_KEY", {}, [state("secrets.env"), state("worker.env"), state("calls.env", "calls")])).toEqual({ value: "calls", source: "calls.env" });
  expect(resolveSecretFrom("OPENAI_API_KEY", { OPENAI_API_KEY: "  " }, [])).toEqual({ source: "missing" });
  // systemd still loads a rejected legacy file: its values are dropped from the environment, never used.
  const rejected = { ...state("worker.env"), exists: true, rejectedValues: new Map([["OPENAI_API_KEY", "tampered"]]) };
  expect(resolveSecretFrom("OPENAI_API_KEY", { OPENAI_API_KEY: "tampered" }, [state("secrets.env", "studio"), rejected, state("calls.env")])).toEqual({ value: "studio", source: "secrets.env" });
  expect(resolveSecretFrom("OPENAI_API_KEY", { OPENAI_API_KEY: "tampered" }, [state("secrets.env"), rejected, state("calls.env")])).toEqual({ source: "missing" });
});

test("a rejected legacy file cannot reach processing through a unit's environment", async () => {
  await withFiles(async (files, root) => {
    // systemd unescapes this to "sk-escaped" before the unit sees it.
    await fs.writeFile(join(root, "escaped.env"), "OPENAI_API_KEY=sk-\\escaped\n", { mode: 0o600 });
    await fs.chmod(join(root, "escaped.env"), 0o664);
    expect(await readSecret("OPENAI_API_KEY", { OPENAI_API_KEY: "sk-escaped" }, { ...files, "worker.env": join(root, "escaped.env") })).toBeUndefined();

    await fs.writeFile(files["worker.env"], "OPENAI_API_KEY=from-open-worker\n", { mode: 0o600 });
    await fs.chmod(files["worker.env"], 0o664);
    await fs.writeFile(join(root, "target.env"), "GEMINI_API_KEY=from-linked-calls\n", { mode: 0o600 });
    await fs.symlink(join(root, "target.env"), files["calls.env"]);
    const unitEnv = { OPENAI_API_KEY: "from-open-worker", GEMINI_API_KEY: "from-linked-calls" };
    expect(await readSecret("OPENAI_API_KEY", unitEnv, files)).toBeUndefined();
    expect(await readSecret("GEMINI_API_KEY", unitEnv, files)).toBeUndefined();
    await setSecret("OPENAI_API_KEY", "studio-key", files);
    expect(await readSecret("OPENAI_API_KEY", unitEnv, files)).toBe("studio-key");
    expect(await readSecret("OPENAI_API_KEY", { OPENAI_API_KEY: "shell-key" }, files)).toBe("shell-key");

    const report = await describeCredentials({ sessionEnv: unitEnv, managerEnv: unitEnv, files });
    expect(report).toMatchObject({ openai: "secrets.env", gemini: "missing" });
    expect(report.details.find((detail) => detail.name === "GEMINI_API_KEY")).toMatchObject({ sessionOnly: false });
    expect(report.files.find((file) => file.file === "worker.env")).toMatchObject({ usable: false, problem: expect.stringContaining("alterá-lo") });
    expect(report.files.every((file) => !("rejectedValues" in file))).toBe(true);
    expect(JSON.stringify(report)).not.toContain("from-");
  });
});

test("a rejected key file too large to read in full makes every environment value untrusted", async () => {
  await withFiles(async (files) => {
    // More than systemd's limit of comments-like padding, then a key at the very end.
    await fs.writeFile(files["worker.env"], "", { mode: 0o600 });
    await fs.truncate(files["worker.env"], 64 * 1024 * 1024);
    await fs.appendFile(files["worker.env"], "\nOPENAI_API_KEY=sk-late\n");
    await fs.chmod(files["worker.env"], 0o664);
    expect(await readSecret("OPENAI_API_KEY", { OPENAI_API_KEY: "sk-late" }, files)).toBeUndefined();
    expect(await readSecret("OPENAI_API_KEY", { OPENAI_API_KEY: "sk-other" }, files)).toBeUndefined();
    await setSecret("OPENAI_API_KEY", "studio-key", files);
    expect(await readSecret("OPENAI_API_KEY", { OPENAI_API_KEY: "sk-late" }, files)).toBe("studio-key");
  });
});

test("diagnostics resolve keys in the environment a processing unit really gets", async () => {
  await withFiles(async (files) => {
    // worker.env, loaded by EnvironmentFile=, replaces the manager's value inside the unit.
    await fs.writeFile(files["worker.env"], "OPENAI_API_KEY=worker-key\n", { mode: 0o600 });
    const managerEnv = { OPENAI_API_KEY: "manager-key", GEMINI_API_KEY: "manager-gemini" };
    expect(await describeCredentials({ sessionEnv: {}, managerEnv, files })).toMatchObject({ openai: "worker.env", gemini: "environment" });
    await setSecret("OPENAI_API_KEY", "studio-key", files);
    const report = await describeCredentials({ sessionEnv: {}, managerEnv, files });
    expect(report.openai).toBe("secrets.env");
    expect(report.details.find((detail) => detail.name === "OPENAI_API_KEY")).toMatchObject({ shadowsStudioKey: false });
    expect(JSON.stringify(report)).not.toMatch(/worker-key|manager-key|studio-key|manager-gemini/);
  });
});

test("the OBS password is reported from the call monitor's environment, which loads calls.env", async () => {
  await withFiles(async (files) => {
    await fs.writeFile(files["calls.env"], "RECORDING_CLI_OBS_PASSWORD=calls-password\n", { mode: 0o600 });
    const managerEnv = { RECORDING_CLI_OBS_PASSWORD: "manager-password", OPENAI_API_KEY: "manager-key" };
    const report = await describeCredentials({ sessionEnv: {}, managerEnv, files });
    // calls.env replaces the manager's value inside the monitor; processing keys still follow worker.env.
    expect(report.details.find((detail) => detail.name === "RECORDING_CLI_OBS_PASSWORD")?.source).toBe("calls.env");
    expect(report.openai).toBe("environment");
    // Both legacy files set it: the monitor, which loads calls.env, gets that value; processing keys keep worker.env first.
    await fs.writeFile(files["worker.env"], "RECORDING_CLI_OBS_PASSWORD=worker-password\nOPENAI_API_KEY=worker-key\n", { mode: 0o600 });
    await fs.writeFile(files["calls.env"], "RECORDING_CLI_OBS_PASSWORD=calls-password\nOPENAI_API_KEY=calls-key\n", { mode: 0o600 });
    const monitor = { RECORDING_CLI_OBS_PASSWORD: "calls-password", OPENAI_API_KEY: "calls-key" };
    expect(await readSecret("RECORDING_CLI_OBS_PASSWORD", monitor, files)).toBe("calls-password");
    expect(await readSecret("OPENAI_API_KEY", {}, files)).toBe("worker-key");
    const both = await describeCredentials({ sessionEnv: {}, managerEnv: {}, files });
    expect(both.details.find((detail) => detail.name === "RECORDING_CLI_OBS_PASSWORD")?.source).toBe("calls.env");
    expect(both.openai).toBe("worker.env");
    expect(JSON.stringify(report)).not.toMatch(/calls-password|manager-password|manager-key/);
  });
});

test("saving is write-only, private and preserves other lines; removal touches only secrets.env", async () => {
  await withFiles(async (files) => {
    await setSecret("OPENAI_API_KEY", "sk-synthetic-private", files);
    await setSecret("RECORDING_CLI_OBS_PASSWORD", "it's \"quoted\" $x", files);
    expect((await fs.stat(files["secrets.env"])).mode & 0o777).toBe(0o600);
    const content = await fs.readFile(files["secrets.env"], "utf8");
    expect(content.startsWith("# FalaTrace")).toBe(true);
    expect(await readSecret("RECORDING_CLI_OBS_PASSWORD", {}, files)).toBe("it's \"quoted\" $x");
    await setSecret("OPENAI_API_KEY", "sk-replaced", files);
    expect((await fs.readFile(files["secrets.env"], "utf8")).match(/OPENAI_API_KEY=/g)).toHaveLength(1);
    expect(await readSecret("OPENAI_API_KEY", {}, files)).toBe("sk-replaced");
    for (const [name, value] of [["PATH", "x"], ["OPENAI_API_KEY", ""], ["OPENAI_API_KEY", "a\nb"], ["OPENAI_API_KEY", "x".repeat(5000)]]) {
      await expect(setSecret(name, value, files)).rejects.toThrow();
    }
    await fs.writeFile(files["calls.env"], "OPENAI_API_KEY=legacy\n", { mode: 0o600 });
    expect(await removeSecret("OPENAI_API_KEY", files)).toEqual({ removed: true });
    expect(await removeSecret("OPENAI_API_KEY", files)).toEqual({ removed: false });
    expect(await fs.readFile(files["calls.env"], "utf8")).toBe("OPENAI_API_KEY=legacy\n");
    expect(await readSecret("OPENAI_API_KEY", {}, files)).toBe("legacy");
    expect(redactResolvedSecrets("error with legacy inside")).toBe("error with [redacted] inside");
  });
});

test("the report names the source background processing uses and flags session-only keys", async () => {
  await withFiles(async (files) => {
    const empty = await describeCredentials({ sessionEnv: { GEMINI_API_KEY: "session" }, managerEnv: null, files });
    expect(empty).toMatchObject({ openai: "missing", gemini: "missing", managerEnvironment: "unavailable" });
    expect(empty.details.find((detail) => detail.name === "GEMINI_API_KEY")).toMatchObject({ sessionOnly: true });
    expect(JSON.stringify(empty)).not.toContain("session\"");

    await setSecret("OPENAI_API_KEY", "studio-key", files);
    const shadowed = await describeCredentials({ sessionEnv: {}, managerEnv: { OPENAI_API_KEY: "manager-key" }, files });
    expect(shadowed.openai).toBe("environment");
    expect(shadowed.details.find((detail) => detail.name === "OPENAI_API_KEY")).toMatchObject({ savedInStudio: true, shadowsStudioKey: true });
    expect(JSON.stringify(shadowed)).not.toContain("studio-key");
    expect(JSON.stringify(shadowed)).not.toContain("manager-key");

    await removeSecret("OPENAI_API_KEY", files);
    expect((await describeCredentials({ sessionEnv: {}, managerEnv: {}, configApiKey: true, files })).openai).toBe("config");
  });
});

test("systemd show-environment output is parsed by name", () => {
  expect(parseManagerEnvironment("HOME=/home/u\nOPENAI_API_KEY='a b'\nbad line\n=x\n")).toEqual({ HOME: "/home/u", OPENAI_API_KEY: "a b" });
});
