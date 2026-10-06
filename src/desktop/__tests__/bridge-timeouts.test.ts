import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = (path: string): string => readFileSync(join(import.meta.dir, "../../..", path), "utf8");

test("requests that read a whole recording outlive the 30 s bridge timeout, in the Qt shell and its PySide6 port", () => {
  const shell = source("src/desktop/main.cpp");
  const port = source("scripts/studio-qml-runner.py");
  // Planning hashes the recording, and confirming hashes it again while the job is created.
  expect(shell).toContain('const bool readsRecording = op == "recording-process-plan" || op == "recording-process";');
  expect(shell).toContain('op.startsWith("capture-") ? 120000 : readsRecording ? 900000 : 30000');
  expect(port).toContain("reads_recording = op in ('recording-process-plan', 'recording-process')");
  expect(port).toContain("120000 if op.startswith('capture-') else 900000 if reads_recording else 30000");
});
