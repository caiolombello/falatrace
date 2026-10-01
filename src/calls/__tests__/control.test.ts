import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAutomationState, setAutomationPaused } from "../control";

test("automation can be suspended and resumed without changing recording session state", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "recording-automation-"));
  const path = join(root, "automation.json");
  const session = join(root, "recording-session.json");
  try {
    await fs.writeFile(session, "active recording owned by another controller");
    expect((await readAutomationState(path)).paused).toBe(false);
    await setAutomationPaused(true, path);
    expect((await readAutomationState(path)).paused).toBe(true);
    expect((await fs.stat(path)).mode & 0o077).toBe(0);
    await setAutomationPaused(false, path);
    expect((await readAutomationState(path)).paused).toBe(false);
    expect(await fs.readFile(session, "utf8")).toBe("active recording owned by another controller");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
