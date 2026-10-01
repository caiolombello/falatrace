import { expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { mergeConfig, validateConfig } from "../../config/load";

test("automatic recording can use audio without OBS and preserves capture defaults", () => {
  const config = mergeConfig(DEFAULT_CONFIG, {
    backend: "audio",
    callDetection: { mode: "record" },
    capture: { microphone: "easyeffects_source" }
  });
  expect(() => validateConfig(config)).not.toThrow();
  expect(config.obs.enabled).toBe(false);
  expect(config.capture.microphone).toBe("easyeffects_source");
  expect(config.capture.audioSource).toBe("both");
  config.capture.microphone = "default|device:unrelated";
  expect(() => validateConfig(config)).toThrow("capture.microphone");
});
