import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { configureDefaultAudio } from "../src/config/audio";

const tempDirs: string[] = [];

const fixture = async (value: unknown): Promise<string> => {
  const dir = await fs.mkdtemp(join("/tmp", "recording-cli-audio-"));
  tempDirs.push(dir);
  const path = join(dir, "config.json");
  await fs.writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  return path;
};

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

test("configura microfone e desktop preservando chaves desconhecidas e cria backup", async () => {
  const path = await fixture({
    recordingsDir: "/tmp/recordings",
    backend: "simple",
    capture: { audioSource: "both", microphone: "old-mic", desktop: "old-desktop", framerate: 30, encoder: "gpu", startupTimeoutSeconds: 90 },
    futureSetting: { enabled: true }
  });
  const result = await configureDefaultAudio({ path });
  expect(result.changed).toBe(true);
  expect(result.backupPath).toBeTruthy();
  const updated = JSON.parse(await fs.readFile(path, "utf8"));
  expect(updated.capture.microphone).toBe("default");
  expect(updated.capture.desktop).toBe("default");
  expect(updated.futureSetting).toEqual({ enabled: true });
  expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
  expect(result.backupPath && JSON.parse(await fs.readFile(result.backupPath, "utf8")).capture.microphone).toBe("old-mic");
});

test("é idempotente e não cria backup quando os defaults já estão configurados", async () => {
  const path = await fixture({ capture: { microphone: "default", desktop: "default" } });
  const result = await configureDefaultAudio({ path });
  expect(result).toEqual({ path, changed: false });
});

test("cria configuração quando o arquivo ainda não existe", async () => {
  const dir = await fs.mkdtemp(join("/tmp", "recording-cli-audio-"));
  tempDirs.push(dir);
  const path = join(dir, "config.json");
  const result = await configureDefaultAudio({ path });
  expect(result.changed).toBe(true);
  expect(result.backupPath).toBeUndefined();
  const updated = JSON.parse(await fs.readFile(path, "utf8"));
  expect(updated.capture.microphone).toBe("default");
  expect(updated.capture.desktop).toBe("default");
  expect(await fs.readdir(dir)).toEqual(["config.json"]);
});

test("não publica nem cria backup para JSON inválido", async () => {
  const dir = await fs.mkdtemp(join("/tmp", "recording-cli-audio-"));
  tempDirs.push(dir);
  const path = join(dir, "config.json");
  await fs.writeFile(path, "{ inválido", { mode: 0o600 });
  await expect(configureDefaultAudio({ path })).rejects.toThrow();
  expect(await fs.readFile(path, "utf8")).toBe("{ inválido");
  expect((await fs.readdir(dir)).filter((name) => name.includes(".bak-")).length).toBe(0);
});

test("aborta se o arquivo mudar durante a atualização e preserva a edição concorrente", async () => {
  const path = await fixture({ capture: { microphone: "old", desktop: "old" }, future: { enabled: true } });
  await expect(configureDefaultAudio({
    path,
    beforeCommit: async () => {
      await fs.writeFile(path, JSON.stringify({ capture: { microphone: "concurrent", desktop: "concurrent" } }), { mode: 0o600 });
    }
  })).rejects.toThrow(/alterada durante/);
  const current = JSON.parse(await fs.readFile(path, "utf8"));
  expect(current.capture.microphone).toBe("concurrent");
  expect((await fs.readdir(dirname(path))).some((name) => name.includes(".bak-"))).toBe(false);
});

test("rejeita caminho de configuração que seja symlink", async () => {
  const dir = await fs.mkdtemp(join("/tmp", "recording-cli-audio-"));
  tempDirs.push(dir);
  const target = await fixture({ capture: { microphone: "old", desktop: "old" } });
  const path = join(dir, "config.json");
  await fs.symlink(target, path);
  await expect(configureDefaultAudio({ path })).rejects.toThrow();
});

test("não sobrescreve criação concorrente quando a configuração ainda não existe", async () => {
  const dir = await fs.mkdtemp(join("/tmp", "recording-cli-audio-"));
  tempDirs.push(dir);
  const path = join(dir, "config.json");
  await expect(configureDefaultAudio({
    path,
    beforeCommit: async () => {
      await fs.writeFile(path, JSON.stringify({ future: { owner: "other" }, capture: { microphone: "other", desktop: "other" } }), { flag: "wx", mode: 0o600 });
    }
  })).rejects.toThrow();
  expect(JSON.parse(await fs.readFile(path, "utf8"))).toEqual({
    future: { owner: "other" }, capture: { microphone: "other", desktop: "other" }
  });
});
