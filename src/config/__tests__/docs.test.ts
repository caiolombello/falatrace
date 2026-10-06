import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CALL_APPLICATIONS } from "../../calls/apps";
import { WHISPER_MODELS } from "../../models/downloads";
import { DEFAULT_CONFIG } from "../defaults";
import { mergeConfig, validateConfig } from "../load";
import { SETTINGS_FIELDS } from "../settings";

// Keep docs/CONFIGURATION.md and docs/config.example.json in step with the code.
const docs = join(import.meta.dir, "../../../docs");
const reference = readFileSync(join(docs, "CONFIGURATION.md"), "utf8");

test("the configuration reference documents every field the Studio edits", () => {
  const fields = Object.keys(SETTINGS_FIELDS).filter((field) => !field.startsWith("callDetection.apps."));
  expect(fields.filter((field) => !reference.includes(`\`${field}\``))).toEqual([]);
  expect(reference).toContain("`callDetection.apps.<id>`");
  expect(CALL_APPLICATIONS.filter((app) => !reference.includes(`\`${app}\``))).toEqual([]);
  expect(WHISPER_MODELS.filter((model) => !reference.includes(`\`${model.id}\``)).map((model) => model.id)).toEqual([]);
});

test("the example configuration is valid and only uses documented fields", () => {
  const example = JSON.parse(readFileSync(join(docs, "config.example.json"), "utf8"));
  expect(() => validateConfig(mergeConfig(DEFAULT_CONFIG, example))).not.toThrow();
  const leaves = (value: Record<string, unknown>, prefix = ""): string[] => Object.entries(value).flatMap(([key, child]) =>
    child && typeof child === "object" && !Array.isArray(child) ? leaves(child as Record<string, unknown>, `${prefix}${key}.`) : [`${prefix}${key}`]);
  expect(leaves(example).filter((field) => !(field in SETTINGS_FIELDS))).toEqual([]);
});
