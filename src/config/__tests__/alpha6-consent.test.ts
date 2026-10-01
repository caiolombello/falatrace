import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../defaults";
import { loadConfigSnapshot } from "../load";

const cases: {
  name: string;
  timesheet?: Partial<AppConfig["timesheet"]>;
  enabled: boolean;
  aiClassification: boolean;
  automaticFromCalls: boolean;
}[] = [
  { name: "missing module settings", enabled: false, aiClassification: false, automaticFromCalls: false },
  { name: "enabled module with missing consent flags", timesheet: { enabled: true }, enabled: true, aiClassification: false, automaticFromCalls: false },
  { name: "explicit opt-ins", timesheet: { enabled: true, aiClassification: true, automaticFromCalls: true }, enabled: true, aiClassification: true, automaticFromCalls: true },
  { name: "explicit opt-outs", timesheet: { enabled: true, aiClassification: false, automaticFromCalls: false }, enabled: true, aiClassification: false, automaticFromCalls: false },
  { name: "AI opt-in with omitted automation", timesheet: { enabled: true, aiClassification: true }, enabled: true, aiClassification: true, automaticFromCalls: false },
  { name: "automation opt-in with omitted AI", timesheet: { enabled: true, automaticFromCalls: true }, enabled: true, aiClassification: false, automaticFromCalls: true },
  { name: "AI opt-out with omitted automation", timesheet: { enabled: true, aiClassification: false }, enabled: true, aiClassification: false, automaticFromCalls: false },
  { name: "automation opt-out with omitted AI", timesheet: { enabled: true, automaticFromCalls: false }, enabled: true, aiClassification: false, automaticFromCalls: false },
  { name: "independent explicit consent flags", timesheet: { enabled: true, aiClassification: true, automaticFromCalls: false }, enabled: true, aiClassification: true, automaticFromCalls: false }
];

for (const fixture of cases) {
  test(`config loading preserves ${fixture.name} without rewriting bytes`, async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "falatrace-alpha6-consent-"));
    try {
      const path = join(root, "config.json");
      const bytes = Buffer.from(`${JSON.stringify(fixture.timesheet ? { timesheet: fixture.timesheet } : {}, null, 2)}\n`);
      await fs.writeFile(path, bytes);

      const loaded = await loadConfigSnapshot(path);

      expect(loaded.config.timesheet.enabled).toBe(fixture.enabled);
      expect(loaded.config.timesheet.aiClassification).toBe(fixture.aiClassification);
      expect(loaded.config.timesheet.automaticFromCalls).toBe(fixture.automaticFromCalls);
      expect(await fs.readFile(path)).toEqual(bytes);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}
