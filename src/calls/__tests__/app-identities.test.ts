import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { mergeConfig, validateConfig } from "../../config/load";
import {
  CALL_APPLICATIONS,
  callApplicationLabel,
  defaultCallApplications,
  isCallApplication,
  matchCallApplication
} from "../apps";
import { classifyCall, sanitizePipeWireNodes } from "../classifier";
import { parseNetworkTelemetry } from "../network";
import type { PipeWireNodeRecord } from "../types";

const stream = (
  id: number,
  props: Record<string, unknown>,
  mediaClass = "Stream/Input/Audio"
): PipeWireNodeRecord => ({
  id,
  type: "PipeWire:Interface:Node",
  info: { state: "running", props: { "media.class": mediaClass, "stream.is-live": true, ...props } }
});

const allEnabled = Object.fromEntries(CALL_APPLICATIONS.map((app) => [app, true]));
const match = (binary: string, name = "", id = "", enabled = allEnabled) =>
  matchCallApplication({ binary, name, id }, enabled);

describe("call application identities", () => {
  test("recognizes browser-family binaries exactly", () => {
    expect(match("chromium", "Chromium input")).toBe("chromium");
    expect(match("chromium-browser")).toBe("chromium");
    expect(match("chrome", "Google Chrome input")).toBe("chrome");
    expect(match("google-chrome-stable")).toBe("chrome");
    expect(match("brave")).toBe("brave");
    expect(match("msedge")).toBe("edge");
    expect(match("vivaldi-bin")).toBe("vivaldi");
    expect(match("opera")).toBe("opera");
    expect(match("firefox", "Firefox")).toBe("firefox");
    expect(match("firefox-esr")).toBe("firefox");
    expect(match("", "", "org.mozilla.firefox")).toBe("firefox");
  });

  test("recognizes native calling clients", () => {
    expect(match("zoom", "ZOOM VoiceEngine")).toBe("zoom");
    expect(match("", "ZOOM VoiceEngine")).toBe("zoom");
    expect(match("", "", "us.zoom.Zoom")).toBe("zoom");
    expect(match("teams-for-linux")).toBe("teams");
    expect(match("Discord", "WEBRTC VoiceEngine")).toBe("discord");
    expect(match("signal-desktop")).toBe("signal");
    expect(match("telegram-desktop")).toBe("telegram");
    expect(match("element-desktop")).toBe("element");
  });

  test("does not treat Electron apps announcing a Chromium name as Chromium", () => {
    expect(match("ChatGPT", "Chromium input")).toBeNull();
    expect(match("t3code", "Chromium input")).toBeNull();
    expect(match("code", "Chromium")).toBeNull();
    expect(match("/usr/bin/chromium")).toBeNull();
    expect(match("chromium-wrapper")).toBeNull();
  });

  test("separates Snap Chromium from Google Chrome on the shared chrome binary", () => {
    expect(match("chrome", "Chromium input")).toBe("chromium");
    expect(match("chrome", "Chromium input", "", { ...allEnabled, chromium: false })).toBeNull();
    expect(match("chrome", "Google Chrome input", "", { ...allEnabled, chrome: false })).toBeNull();
  });

  test("respects per-application switches and missing switches", () => {
    expect(match("zoom", "", "", { ...allEnabled, zoom: false })).toBeNull();
    expect(matchCallApplication({ binary: "firefox", name: "", id: "" }, { slack: true })).toBeNull();
  });

  test("classifies a native Zoom call and labels it", () => {
    const result = classifyCall([
      stream(1, { "application.process.binary": "zoom", "application.name": "ZOOM VoiceEngine" }),
      stream(2, { "application.process.binary": "zoom" }, "Stream/Output/Audio")
    ], DEFAULT_CONFIG.callDetection.apps);
    expect(result).toMatchObject({ active: true, app: "zoom", nodeIds: [1, 2] });
    expect(result.confidence).toBeCloseTo(0.75);
    expect(callApplicationLabel(result.app)).toBe("Zoom");
  });

  test("ranks browser capture like the existing browser identities", () => {
    const result = classifyCall([
      stream(1, { "application.process.binary": "firefox", "application.name": "Firefox" })
    ], DEFAULT_CONFIG.callDetection.apps);
    expect(result).toMatchObject({ active: true, app: "firefox" });
    expect(result.confidence).toBeCloseTo(0.9);
  });

  test("ignores playback-only browser streams and Electron capture", () => {
    expect(classifyCall([
      stream(1, { "application.process.binary": "chromium" }, "Stream/Output/Audio"),
      stream(2, { "application.process.binary": "ChatGPT", "application.name": "Chromium input" })
    ], DEFAULT_CONFIG.callDetection.apps).active).toBe(false);
  });

  test("sanitized streams report the new identities without names", () => {
    const streams = sanitizePipeWireNodes([
      stream(5, { "application.process.binary": "msedge", "media.name": "private tab" })
    ], DEFAULT_CONFIG.callDetection.apps);
    expect(streams).toEqual([{ id: 5, app: "edge", state: "running", mediaClass: "Stream/Input/Audio", mediaRole: undefined, live: true }]);
    expect(JSON.stringify(streams)).not.toContain("private tab");
  });

  test("keeps personal messengers opt-in by default", () => {
    const defaults = defaultCallApplications();
    expect(defaults).toMatchObject({ slack: true, zen: true, helium: true, chromium: true, firefox: true, zoom: true, teams: true });
    expect(defaults).toMatchObject({ discord: false, signal: false, telegram: false, element: false });
    expect(classifyCall([stream(1, { "application.process.binary": "signal-desktop" })], defaults).active).toBe(false);
  });

  test("existing configs keep their switches and gain new identities", () => {
    const merged = mergeConfig(DEFAULT_CONFIG, {
      callDetection: { apps: { slack: false, zen: true, helium: true } }
    } as never);
    expect(merged.callDetection.apps.slack).toBe(false);
    expect(merged.callDetection.apps.zoom).toBe(true);
    expect(() => validateConfig(merged)).not.toThrow();
    expect(() => validateConfig(mergeConfig(DEFAULT_CONFIG, {
      callDetection: { apps: { zoom: "yes" } }
    } as never))).toThrow("callDetection.zoom must be a boolean");
  });

  test("attributes network sockets by truncated process name", () => {
    const udp = 'ESTAB 0 0 10.0.0.1:2 30.0.0.1:443 users:(("telegram-deskto",pid=20,fd=2))\nESTAB 0 0 10.0.0.1:3 30.0.0.1:443 users:(("zoom",pid=21,fd=2))\n';
    const result = parseNetworkTelemetry("", udp);
    expect(result.telegram.udpSockets).toBe(1);
    expect(result.zoom.udpSockets).toBe(1);
  });

  test("validates persisted application values", () => {
    expect(isCallApplication("zoom")).toBe(true);
    expect(isCallApplication("ZOOM")).toBe(false);
    expect(isCallApplication("skype")).toBe(false);
  });
});
