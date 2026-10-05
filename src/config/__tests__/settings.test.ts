import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCredentialStatus, readSettings, saveSettings, validateSettingsPatch } from "../settings";
import { DEFAULT_CONFIG } from "../defaults";

const withRoot = async (run: (root: string) => Promise<void>) => {
  const root = await fs.mkdtemp(join(tmpdir(), "falatrace-settings-"));
  try { await run(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
};

test("reading never writes and exposes no secrets", async () => {
  await withRoot(async (root) => {
    const path = join(root, "config.json");
    const fresh = await readSettings(path, {});
    expect(fresh.exists).toBe(false);
    expect(await fs.stat(path).catch(() => null)).toBeNull();
    expect(fresh.values["callDetection.enabled"]).toBe(false);
    expect(fresh.values["callDetection.apps.zoom"]).toBe(true);
    expect(fresh.values["callDetection.apps.discord"]).toBe(false);
    expect(fresh.apps.find((app) => app.id === "firefox")).toMatchObject({ label: "Firefox", kind: "browser" });

    const secret = "synthetic-private-sentinel";
    await fs.writeFile(path, JSON.stringify({ openai: { apiKey: secret }, obs: { password: secret }, summary: { provider: "openai" } }));
    const read = await readSettings(path, {});
    expect(JSON.stringify(read)).not.toContain(secret);
    expect(read.credentials.openai).toBe("config");
  });
});

test("saving only touches allowlisted fields and preserves unknown keys and secrets", async () => {
  await withRoot(async (root) => {
    const path = join(root, "config.json");
    const original = {
      future: { sentinel: 1 },
      openai: { apiKey: "synthetic-private-sentinel", model: "x" },
      callDetection: { enabled: false, apps: { slack: false } },
      capture: { framerate: 24 },
      remote: { host: "worker.invalid" }
    };
    await fs.writeFile(path, JSON.stringify(original));
    const draft = await readSettings(path, {});
    const saved = await saveSettings(draft.revision, {
      "callDetection.enabled": true,
      "callDetection.mode": "record",
      "callDetection.apps.zoom": false,
      "backend": "audio",
      "capture.microphone": "alsa_input.pci-0000_00_1f.3.analog-stereo",
      "transcription.provider": "whisper-cpp",
      "summary.ollamaModel": "qwen3:8b"
    }, path);
    expect(saved).toMatchObject({ saved: true, backupCreated: true, needsReload: false });
    const result = JSON.parse(await fs.readFile(path, "utf8"));
    expect(result.future).toEqual(original.future);
    expect(result.openai).toEqual(original.openai);
    expect(result.remote).toEqual(original.remote);
    expect(result.capture.framerate).toBe(24);
    expect(result.callDetection).toEqual({ enabled: true, mode: "record", apps: { slack: false, zoom: false } });
    expect(result.backend).toBe("audio");
    expect(result.summary).toEqual({ ollamaModel: "qwen3:8b" });
    expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
    const backup = (await fs.readdir(root)).find((name) => name.startsWith("config.json.bak-"))!;
    expect(JSON.parse(await fs.readFile(join(root, backup), "utf8"))).toEqual(original);
    expect("values" in saved && saved.values["callDetection.apps.slack"]).toBe(false);
  });
});

test("a fresh configuration is created privately from the patch only", async () => {
  await withRoot(async (root) => {
    const path = join(root, "nested", "config.json");
    const draft = await readSettings(path, {});
    await saveSettings(draft.revision, { "callDetection.enabled": true }, path);
    expect(JSON.parse(await fs.readFile(path, "utf8"))).toEqual({ callDetection: { enabled: true } });
    expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
  });
});

test("stale revisions, invalid combinations and concurrent edits are refused without writing", async () => {
  await withRoot(async (root) => {
    const path = join(root, "config.json");
    await fs.writeFile(path, "{}");
    const draft = await readSettings(path, {});
    await fs.writeFile(path, '{"later":1}');
    await expect(saveSettings(draft.revision, { "callDetection.enabled": true }, path)).rejects.toThrow("mudou");
    expect(await fs.readFile(path, "utf8")).toBe('{"later":1}');

    const current = await readSettings(path, {});
    // OBS mode requires OBS to be enabled elsewhere; the full config validator refuses it.
    await expect(saveSettings(current.revision, { "callDetection.mode": "obs" }, path)).rejects.toThrow();
    await expect(saveSettings(current.revision, { "callDetection.enabled": true }, path, async () => {
      await fs.writeFile(path, '{"concurrent":true}');
    })).rejects.toThrow("mudou");
    expect(JSON.parse(await fs.readFile(path, "utf8"))).toEqual({ concurrent: true });
  });
});

test("patches are restricted to known fields and valid values", () => {
  for (const patch of [
    null, [], {},
    { "openai.apiKey": "sk-test" },
    { "obs.password": "x" },
    { "remote.host": "evil" },
    { "__proto__.polluted": true },
    { "callDetection.apps.skype": true },
    { "callDetection.enabled": "yes" },
    { "callDetection.entryDebounceSeconds": 0 },
    { backend: "simple" },
    { recordingsDir: "relative/dir" },
    { recordingsDir: "/tmp/a\nb" },
    { "capture.microphone": "bad name; rm -rf" },
    { "summary.ollamaUrl": "http://user:pass@127.0.0.1:11434" },
    { "summary.ollamaUrl": "file:///etc/passwd" },
    { "transcription.language": "Portuguese" }
  ]) {
    expect(() => validateSettingsPatch(patch)).toThrow();
  }
  expect(validateSettingsPatch({ "summary.ollamaUrl": "http://127.0.0.1:11434", "transcription.language": "pt-BR" }))
    .toEqual({ "summary.ollamaUrl": "http://127.0.0.1:11434", "transcription.language": "pt-BR" });
});

test("credential status reports only the source of each key", async () => {
  await withRoot(async (root) => {
    const envFile = join(root, "calls.env");
    await fs.writeFile(envFile, "# comment\nGEMINI_API_KEY='synthetic-private-sentinel'\nOPENAI_API_KEY=\n");
    const status = await readCredentialStatus(DEFAULT_CONFIG, {}, envFile);
    expect(status).toEqual({ openai: "missing", gemini: "calls.env" });
    expect(await readCredentialStatus(DEFAULT_CONFIG, { OPENAI_API_KEY: "x" }, join(root, "absent"))).toEqual({ openai: "environment", gemini: "missing" });
  });
});
