import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXPORT_OVER_CONFIGURATION, exportSettings, isPlaceholderRemoteHost, listConfigBackups, readCredentialStatus, readImportFile, readSettings, restoreConfigBackup,
  saveSettings, validateSettingsPatch, VISUAL_REVIEW_DEFAULTS
} from "../settings";
import { CONFIG_BACKUPS_KEPT } from "../onboarding";
import { DEFAULT_CONFIG } from "../defaults";
import { getConfigPathCandidates } from "../load";

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
    { "remote.host": "-evil" },
    { "remote.host": "evil host" },
    { "obs.host": "192.168.0.10" },
    { "proton.targetFolder": "/my-files/../escape" },
    { "features.namingTemplate": "../escape" },
    { "features.namingTemplate": "a/b" },
    { "transcription.expectedLanguages": ["pt", "pt"] },
    { "transcription.expectedLanguages": ["Portuguese"] },
    { "callDetection.enabled": null },
    { "s3.bucket": "UPPER" },
    { "visualReview.maxInferences": 0 },
    { "timesheet.readyConfidence": 0.2 },
    { "transcription.openaiPrompt": "a\u0000b" },
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

test("credential status reports the source and never the value", async () => {
  await withRoot(async (root) => {
    const files = { "secrets.env": join(root, "secrets.env"), "worker.env": join(root, "worker.env"), "calls.env": join(root, "calls.env") };
    await fs.writeFile(files["calls.env"], "# comment\nGEMINI_API_KEY='synthetic-private-sentinel'\nOPENAI_API_KEY=\n", { mode: 0o600 });
    const status = await readCredentialStatus(DEFAULT_CONFIG, { sessionEnv: {}, files });
    expect(status).toMatchObject({ openai: "missing", gemini: "calls.env" });
    expect(JSON.stringify(status)).not.toContain("synthetic-private-sentinel");
    const session = await readCredentialStatus(DEFAULT_CONFIG, { sessionEnv: { OPENAI_API_KEY: "x" }, files: { ...files, "calls.env": join(root, "absent") } });
    expect(session.openai).toBe("missing");
    expect(session.details.find((detail) => detail.name === "OPENAI_API_KEY")?.sessionOnly).toBe(true);
  });
});

test("the shipped placeholder worker is not offered as configured", async () => {
  await withRoot(async (root) => {
    const path = join(root, "config.json");
    expect((await readSettings(path, {})).readOnly.remoteConfigured).toBe(false);
    for (const host of [DEFAULT_CONFIG.remote.host, "box.invalid", "worker.example", "a.test", "example.com", "sub.example.org"]) {
      expect(isPlaceholderRemoteHost(host)).toBe(true);
    }
    for (const host of ["worker.lan", "10.0.0.5", "vaio"]) expect(isPlaceholderRemoteHost(host)).toBe(false);
    await fs.writeFile(path, JSON.stringify({ remote: { host: "worker.lan" } }));
    expect((await readSettings(path, {})).readOnly.remoteConfigured).toBe(true);
  });
});

test("first use can record the defaults once; later empty saves are refused", async () => {
  await withRoot(async (root) => {
    const path = join(root, "config.json");
    const fresh = await readSettings(path, {});
    expect(fresh.readOnly.backendExplicit).toBe(false);
    await expect(saveSettings(fresh.revision, {}, path)).rejects.toThrow("Nenhuma alteração");
    const saved = await saveSettings(fresh.revision, {}, path, undefined, { initialize: true });
    expect(saved).toMatchObject({ saved: true, exists: true });
    expect(JSON.parse(await fs.readFile(path, "utf8"))).toEqual({});
    const again = await readSettings(path, {});
    await expect(saveSettings(again.revision, {}, path, undefined, { initialize: true })).rejects.toThrow("Nenhuma alteração");
  });
});

test("remote processing needs a real worker, but older files are not blocked from unrelated saves", async () => {
  await withRoot(async (root) => {
    const path = join(root, "config.json");
    const draft = await readSettings(path, {});
    await expect(saveSettings(draft.revision, { "processing.defaultTarget": "remote" }, path)).rejects.toThrow("Configure o worker remoto");
    await expect(saveSettings(draft.revision, { "archive.enabled": true }, path)).rejects.toThrow("Configure o worker remoto");
    await saveSettings(draft.revision, { "processing.defaultTarget": "remote", "remote.host": "worker.lan" }, path);
    await fs.writeFile(path, JSON.stringify({ processing: { defaultTarget: "remote" } }));
    const old = await readSettings(path, {});
    await saveSettings(old.revision, { "callDetection.enabled": true }, path);
    expect(JSON.parse(await fs.readFile(path, "utf8")).callDetection).toEqual({ enabled: true });
  });
});

test("visual limits are written as a complete lifetime policy and optional keys can be removed", async () => {
  await withRoot(async (root) => {
    const path = join(root, "config.json");
    await fs.writeFile(path, JSON.stringify({ remote: { host: "worker.lan", user: "me", identityFile: "/home/me/.ssh/id" } }));
    const draft = await readSettings(path, {});
    expect(draft.values["visualReview.maxInferences"]).toBe(VISUAL_REVIEW_DEFAULTS.maxInferences);
    expect(draft.readOnly.visualPolicyDeclared).toBe(false);
    await saveSettings(draft.revision, { "visualReview.maxPreviews": 4, "remote.user": null, "remote.identityFile": null }, path);
    const written = JSON.parse(await fs.readFile(path, "utf8"));
    expect(written.visualReview).toEqual({ maxInferences: VISUAL_REVIEW_DEFAULTS.maxInferences, maxPreviews: 4, period: "lifetime" });
    expect(written.remote).toEqual({ host: "worker.lan" });
    expect((await readSettings(path, {})).readOnly.visualPolicyDeclared).toBe(true);
  });
});

test("an audio device name the Studio lists can be saved", async () => {
  await withRoot(async (root) => {
    const path = join(root, "config.json");
    await fs.writeFile(path, "{}");
    const draft = await readSettings(path, {});
    await saveSettings(draft.revision, { "capture.microphone": "alsa_input.usb-Mic+Line.analog-stereo" }, path);
    expect(JSON.parse(await fs.readFile(path, "utf8")).capture.microphone).toBe("alsa_input.usb-Mic+Line.analog-stereo");
  });
});

test("editing a visual limit keeps unknown keys next to it", async () => {
  await withRoot(async (root) => {
    const path = join(root, "config.json");
    await fs.writeFile(path, JSON.stringify({ visualReview: { maxInferences: 3, maxPreviews: 2, period: "lifetime", future: { keep: true } } }));
    const draft = await readSettings(path, {});
    await saveSettings(draft.revision, { "visualReview.maxInferences": 5 }, path);
    expect(JSON.parse(await fs.readFile(path, "utf8")).visualReview).toEqual({ maxInferences: 5, maxPreviews: 2, period: "lifetime", future: { keep: true } });
  });
});

test("empty text is an edit only for fields that accept it", async () => {
  await withRoot(async (root) => {
    const path = join(root, "config.json");
    await fs.writeFile(path, JSON.stringify({ transcription: { openaiPrompt: "FalaTrace, Proton" }, s3: { bucket: "my-bucket", prefix: "recordings/" } }));
    const draft = await readSettings(path, {});
    expect([...draft.emptyAllowed].sort()).toEqual(["s3.bucket", "s3.prefix", "transcription.openaiPrompt"]);
    await saveSettings(draft.revision, { "transcription.openaiPrompt": "", "s3.bucket": "", "s3.prefix": "" }, path);
    const written = JSON.parse(await fs.readFile(path, "utf8"));
    expect([written.transcription.openaiPrompt, written.s3.bucket, written.s3.prefix]).toEqual(["", "", ""]);
    expect(() => validateSettingsPatch({ "summary.ollamaModel": "" })).toThrow();
  });
});

test("backups are listed, restored with a backup of the current file and rotated", async () => {
  await withRoot(async (root) => {
    const path = join(root, "config.json");
    await fs.writeFile(path, JSON.stringify({ callDetection: { enabled: false } }));
    let draft = await readSettings(path, {});
    await saveSettings(draft.revision, { "callDetection.enabled": true }, path);
    await fs.writeFile(join(root, "config.json.bak-not-ours"), "{}");
    const backups = await listConfigBackups(path);
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatchObject({ valid: true });
    draft = await readSettings(path, {});
    const restored = await restoreConfigBackup(draft.revision, backups[0].name, path);
    expect(restored.backupCreated).toBe(true);
    expect(JSON.parse(await fs.readFile(path, "utf8"))).toEqual({ callDetection: { enabled: false } });
    await expect(restoreConfigBackup((await readSettings(path, {})).revision, "../config.json", path)).rejects.toThrow("inválida");
    for (let index = 0; index < CONFIG_BACKUPS_KEPT + 3; index += 1) {
      const current = await readSettings(path, {});
      await saveSettings(current.revision, { "callDetection.entryDebounceSeconds": 2 + (index % 50) }, path);
    }
    expect((await listConfigBackups(path)).length).toBe(CONFIG_BACKUPS_KEPT);
    expect(await fs.readFile(join(root, "config.json.bak-not-ours"), "utf8")).toBe("{}");
  });
});

test("export omits credentials and import returns only allowlisted, valid fields", async () => {
  await withRoot(async (root) => {
    const path = join(root, "config.json");
    await fs.writeFile(path, JSON.stringify({ openai: { apiKey: "synthetic-private-sentinel", model: "x" }, obs: { password: "secret", port: 4455 }, future: { a: 1 }, callDetection: { enabled: true } }));
    const target = join(root, "exported.json");
    expect(await exportSettings(target, path)).toEqual({ exported: target, credentialsOmitted: true });
    const exported = await fs.readFile(target, "utf8");
    expect(exported).not.toContain("synthetic-private-sentinel");
    expect(exported).not.toContain("secret");
    expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
    await expect(exportSettings("relative.json", path)).rejects.toThrow(".json");
    await expect(exportSettings(join(root, "missing", "x.json"), path)).rejects.toThrow("não existe");
    // Never over the active configuration, however it is spelled, nor over one that would become active.
    await fs.symlink(root, join(root, "alias"));
    for (const destination of [path, `${root}/./config.json`, `${root}//config.json`, join(root, "alias", "config.json"), ...getConfigPathCandidates()]) {
      await expect(exportSettings(destination, path)).rejects.toThrow(EXPORT_OVER_CONFIGURATION);
    }
    expect(await fs.readFile(path, "utf8")).toContain("synthetic-private-sentinel");

    const incoming = join(root, "incoming.json");
    await fs.writeFile(incoming, JSON.stringify({ callDetection: { enabled: false, entryDebounceSeconds: 999 }, backend: "audio", future: 1, openai: { apiKey: "k" }, visualReview: { maxInferences: 5, maxPreviews: 6, period: "lifetime" } }));
    expect((await readImportFile(incoming)).rejected).toEqual(["callDetection.entryDebounceSeconds"]);
    await fs.writeFile(incoming, JSON.stringify({ callDetection: { enabled: false, entryDebounceSeconds: 7 }, backend: "audio", future: 1, openai: { apiKey: "k" }, visualReview: { maxInferences: 5, maxPreviews: 6, period: "lifetime" } }));
    const imported = await readImportFile(incoming);
    expect(imported.values).toMatchObject({ "callDetection.enabled": false, "callDetection.entryDebounceSeconds": 7, backend: "audio", "visualReview.maxInferences": 5, "visualReview.maxPreviews": 6 });
    expect(imported.ignored).toEqual(["future"]);
    // A bad visual limit is rejected on its own instead of blocking the whole save later.
    await fs.writeFile(incoming, JSON.stringify({ callDetection: { enabled: false }, visualReview: { maxInferences: "many", maxPreviews: 6 } }));
    const partial = await readImportFile(incoming);
    expect(partial.rejected).toEqual(["visualReview.maxInferences"]);
    expect(partial.values).toEqual({ "callDetection.enabled": false, "visualReview.maxPreviews": 6 });
    expect(() => validateSettingsPatch(partial.values)).not.toThrow();
    expect(imported.credentialsIgnored).toBe(true);
    expect(JSON.stringify(imported)).not.toContain('"k"');
  });
});
