import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promises as fs } from "node:fs";
import {
  buildValidationReport,
  readValidationSession,
  validateScenario,
  writeValidationSnapshot,
  type ValidationScenario,
  type ValidationSnapshot
} from "../validation";

const snapshot = (
  scenario: ValidationScenario,
  active: boolean
): ValidationSnapshot => ({
  version: 1,
  session: "slack-huddle",
  scenario,
  capturedAt: "2026-07-14T12:00:00.000Z",
  environment: { pipewire: { observation: { active } } },
  monitorStatus: null
});

describe("call validation collection", () => {
  test("reports the expected inactive, active, inactive sequence", () => {
    const report = buildValidationReport([
      snapshot("app-open", false),
      snapshot("in-call", true),
      snapshot("ended", false)
    ]);
    expect(report.complete).toBe(true);
    expect(report.passed).toBe(true);
  });

  test("writes sanitized scenario files and reads the session back", async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "recording-cli-validation-"));
    try {
      await writeValidationSnapshot(snapshot("app-open", false), root);
      expect((await readValidationSession("slack-huddle", root))[0]?.scenario).toBe("app-open");
      expect(() => validateScenario("payload-capture")).toThrow("must be one of");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
