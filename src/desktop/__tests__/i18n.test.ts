import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG, type AppConfig } from "../../config/defaults";
import { checkAutomation, checkProcessing, type SetupProbe } from "../../config/setup-checks";
import { testProviderKey } from "../../config/credential-test";
import { describeDestinations } from "../../jobs/manual";
import { WHISPER_MODELS } from "../../models/downloads";
import { translateCaptureMessage } from "../../recording/messages";
import { waitMessage } from "../../runtime/heavy-admission";
import { OBS_PASSWORD_UNKNOWN, SETTINGS_KNOWN_ERRORS, settingsErrorMessage, SETTINGS_OPERATIONS } from "../settings-bridge";

/**
 * The Studio's English comes from src/desktop/i18n.js, keyed by the Portuguese text.
 * These checks keep it complete: every t("…") in the QML has an entry, entries keep the
 * placeholders and edge whitespace the QML relies on, and the messages the bridge really
 * produces come out in English.
 */
const desktop = join(import.meta.dir, "..");
const source = readFileSync(join(desktop, "i18n.js"), "utf8").replace(/^\.pragma library\s*$/m, "");
const i18n = new Function(`${source}\nreturn { EN, PATTERNS, translate, sentences };`)() as {
  EN: Record<string, string>;
  PATTERNS: Array<[string, string, number[]]>;
  translate: (text: string) => string;
  sentences: (text: string) => string[];
};
const PORTUGUESE = /[ãõçáéíóúâêôàÃÕÇÁÉÍÓÚÂÊÔ]|\b(não|nenhum|você|gravação|configuração)\b/i;
const english = (text: string): string => {
  const value = i18n.translate(text);
  // Proper names keep their accents; only the surrounding text must be English.
  expect(value.replace(/“[^”]*”|[A-Za-z0-9_.-]+\.(?:env|json)/g, ""), text).not.toMatch(PORTUGUESE);
  return value;
};

const qmlKeys = (): string[] => {
  const keys = new Set<string>();
  const call = /\bt[f]?\(\s*"((?:[^"\\]|\\.)*)"/g;
  for (const name of readdirSync(desktop).filter((file) => file.endsWith(".qml"))) {
    for (const match of readFileSync(join(desktop, name), "utf8").matchAll(call)) keys.add(JSON.parse(`"${match[1]}"`));
  }
  return [...keys];
};

test("every literal passed to t() or tf() in the QML has an English entry", () => {
  const keys = qmlKeys();
  expect(keys.length).toBeGreaterThan(900);
  expect(keys.filter((key) => Object.getOwnPropertyDescriptor(i18n.EN, key) === undefined)).toEqual([]);
});

test("entries keep placeholders, line breaks and the spaces used to join fragments", () => {
  const edges = (text: string) => [text.length - text.trimStart().length, text.length - text.trimEnd().length, (text.match(/\n/g) || []).length];
  const placeholders = (text: string) => (text.match(/%\d/g) || []).sort();
  for (const [pt, en] of Object.entries(i18n.EN)) {
    expect(en.length, pt).toBeGreaterThan(0);
    expect(edges(en), pt).toEqual(edges(pt));
    expect(placeholders(en), pt).toEqual(placeholders(pt));
  }
});

test("patterns compile and translate the parts that are Portuguese", () => {
  for (const [pattern] of i18n.PATTERNS) expect(() => new RegExp(pattern)).not.toThrow();
  expect(i18n.translate("Gravação — 05/10/2026, 12:00 BRT")).toBe("Recording — 05/10/2026, 12:00 BRT");
  expect(i18n.translate("Uma chave definida em worker.env tem prioridade sobre a salva pelo Studio.")).toBe("A key set in worker.env takes priority over the one saved by the Studio.");
  expect(i18n.translate("A transcrição usa a OpenAI, mas OPENAI_API_KEY não foi encontrada. Salve a chave em Chaves de API.")).toBe("Transcription uses OpenAI, but OPENAI_API_KEY was not found. Save the key in API keys.");
  expect(i18n.translate("Áudio do sistema ficou em silêncio: toque algum som durante o teste para conferir.")).toBe("System audio was silent: play some sound during the test to check.");
  // Unknown text stays as it is; a known sentence inside it is still translated.
  expect(i18n.translate("Texto qualquer")).toBe("Texto qualquer");
  expect(i18n.translate("Algo inesperado. Nenhuma alteração para salvar.")).toBe("Algo inesperado. No changes to save.");
  expect(i18n.sentences("Uma frase. Outra! Fim… Ok")).toEqual(["Uma frase.", "Outra!", "Fim…", "Ok"]);
});

test("settings errors the bridge can show are translated", () => {
  for (const message of SETTINGS_KNOWN_ERRORS) english(message);
  for (const op of SETTINGS_OPERATIONS) english(settingsErrorMessage(op));
});

const probe = (overrides: Partial<SetupProbe> = {}): SetupProbe => ({
  resolve: async () => null,
  isFile: async () => false,
  isExecutable: async () => false,
  ollamaModels: async () => [],
  run: async () => ({ stdout: "", stderr: "" }),
  ...overrides
} as SetupProbe);
const config = (change: (value: AppConfig) => void = () => {}): AppConfig => {
  const value = structuredClone(DEFAULT_CONFIG);
  change(value);
  return value;
};
const missing = { openai: "missing", gemini: "missing", details: [] } as never;

test("diagnostic labels and details are translated in every state", async () => {
  const runs = [
    await checkProcessing(config((c) => { c.transcription.provider = "whisper-cpp"; c.summary.provider = "ollama"; }), missing, probe()),
    await checkProcessing(config((c) => { c.transcription.provider = "whisper-cpp"; c.summary.provider = "ollama"; }), missing,
      probe({ resolve: async (name) => `/usr/bin/${name}`, isFile: async () => true, ollamaModels: async () => [DEFAULT_CONFIG.summary.ollamaModel] })),
    await checkProcessing(config((c) => { c.transcription.provider = "whisper-cpp"; c.summary.provider = "ollama"; }), missing, probe({ ollamaModels: async () => ["other:1b"] })),
    await checkProcessing(config((c) => { c.transcription.provider = "whisper-cpp"; c.summary.ollamaUrl = "http://worker.lan:11434"; }), missing, probe({ ollamaModels: async () => { throw new Error("offline"); } })),
    await checkProcessing(config((c) => { c.transcription.provider = "openai"; c.summary.provider = "openai"; }), missing, probe()),
    await checkProcessing(config((c) => { c.transcription.provider = "gemini"; c.summary.provider = "openai"; }),
      { openai: "secrets.env", gemini: "worker.env", details: [{ name: "GEMINI_API_KEY", source: "worker.env", sessionOnly: false, shadowsStudioKey: true, savedInStudio: true }], files: [{ file: "worker.env", tooOpen: true }] } as never, probe()),
    await checkProcessing(config((c) => { c.transcription.provider = "openai"; c.processing.defaultTarget = "remote"; }),
      { openai: "missing", gemini: "missing", details: [{ name: "OPENAI_API_KEY", source: "missing", sessionOnly: true, shadowsStudioKey: false, savedInStudio: false }] } as never, probe())
  ];
  const timer = (state: Record<string, boolean>) => ({ installed: false, enabled: false, active: false, outdated: false, nextRunAt: null, lastResult: null, ...state });
  const monitor = { installed: true, enabled: true, active: true, outdated: false, staleConfig: false };
  const services = (state: Record<string, boolean>, calls: typeof monitor | null = null) => ({ calls, tray: null, sync: timer(state), archive: timer(state), backup: timer(state) }) as never;
  const automation = [
    checkAutomation(config((c) => { c.callDetection.enabled = true; c.callDetection.mode = "record"; c.backend = "simple"; }), null),
    checkAutomation(config((c) => { c.callDetection.enabled = true; c.callDetection.mode = "record"; c.backend = "audio"; c.processing.autoEnqueue = true; c.processing.defaultTarget = "remote"; c.archive.enabled = true; c.proton.enabled = true; }), services({})),
    checkAutomation(config((c) => { c.callDetection.enabled = true; c.callDetection.mode = "obs"; c.processing.autoEnqueue = true; }), services({ installed: true, enabled: true, outdated: true })),
    checkAutomation(config((c) => { c.callDetection.enabled = true; c.callDetection.mode = "record"; c.backend = "gpu-screen-recorder"; c.processing.autoEnqueue = true; }), services({ installed: true, enabled: true })),
    checkAutomation(config((c) => { c.callDetection.enabled = true; c.callDetection.mode = "record"; c.backend = "gpu-screen-recorder"; }), services({}, monitor)),
    checkAutomation(config((c) => { c.callDetection.enabled = true; c.callDetection.mode = "record"; c.backend = "audio"; }), services({}, { ...monitor, active: false })),
    checkAutomation(config((c) => { c.archive.enabled = true; c.proton.enabled = true; }), services({ installed: true, enabled: true })),
    checkAutomation(config((c) => { c.archive.enabled = true; c.proton.enabled = true; c.processing.autoEnqueue = true; }), null)
  ];
  const checks = [...runs.flat(), ...automation.flat()];
  expect(checks.length).toBeGreaterThan(15);
  for (const check of checks) { english(check.label); english(check.detail); }
});

test("capture, queue, model, key-test and destination messages are translated", async () => {
  const capture = [
    "OBS recording is disabled; set obs.enabled=true after configuring OBS manually", "OBS recording is restricted to a loopback WebSocket host",
    "No compatible recording backend was detected for this desktop session", "GPU Screen Recorder is not installed (native or Flatpak)",
    "Microphone and desktop must use different audio sources", "This backend does not support the shared automatic recording controller",
    "Audio device unavailable: alsa_input.usb (microphone)", "Audio device unavailable: alsa_output.hdmi.monitor (desktop)",
    "simple is a legacy backend and is not selected automatically", "Backend wf-recorder has no portable implementation"
  ];
  for (const message of capture) english(translateCaptureMessage(message));
  for (const reason of ["recording-active", "call-inferred", "activity-unknown", "queue"] as const) english(waitMessage(reason));
  for (const model of WHISPER_MODELS) english(model.quality);
  for (const target of ["local", "remote"] as const) {
    for (const transcription of ["whisper-cpp", "openai", "gemini"]) {
      const destinations = describeDestinations(target, { provider: transcription, model: "m" }, { provider: "ollama", model: "m" }, DEFAULT_CONFIG);
      english(destinations.transcription.where); english(destinations.summary.where);
    }
  }
  english(describeDestinations("local", { provider: "openai", model: "m" }, { provider: "ollama", model: "m" }, config((c) => { c.summary.ollamaUrl = "http://worker.lan:11434"; })).summary.where);
  const statuses = [200, 401, 429, 503];
  for (const status of statuses) {
    const result = await testProviderKey("gemini", {
      fetch: (async () => new Response("{}", { status })) as unknown as typeof fetch,
      managerEnv: async () => ({ GEMINI_API_KEY: "synthetic" }), files: [], configApiKey: undefined
    } as never);
    english(result.detail);
  }
  english((await testProviderKey("openai", { fetch: (async () => new Response("{}")) as unknown as typeof fetch, managerEnv: async () => ({}), files: [], configApiKey: undefined } as never)).detail);
  english(OBS_PASSWORD_UNKNOWN);
});
