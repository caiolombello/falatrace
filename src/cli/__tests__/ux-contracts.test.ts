import { test, expect } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("CLI help, machine status, errors and automation controls preserve their output contracts", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "falatrace-cli-ux-"));
  const run = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../index.ts"), ...args], {
      env: { ...process.env, HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"), XDG_DATA_HOME: join(root, "data"), NO_COLOR: "1" },
      stdin: "ignore", stdout: "pipe", stderr: "pipe"
    });
    return { code: await child.exited, out: await new Response(child.stdout).text(), err: await new Response(child.stderr).text() };
  };
  try {
    const help = await run("help");
    expect(help.code).toBe(0); expect(help.err).toBe(""); expect(help.out).toContain("FalaTrace");
    expect(help.out).toContain("context meeting"); expect(help.out).toContain("calls pause"); expect(help.out).not.toContain("\u001b");
    const status = await run("calls", "status");
    expect(status.code).toBe(0); expect(status.err).toBe(""); expect(JSON.parse(status.out).state).toBe("IDLE"); expect(status.out).not.toContain("\u001b");
    expect((await run("calls", "pause")).code).toBe(0);
    const candidates: string[] = [];
    const walk = async (dir: string) => { for (const e of await fs.readdir(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) await walk(p); else if (e.name === "automation.json") candidates.push(p); } };
    await walk(join(root, "state"));
    expect(candidates).toHaveLength(1);
    expect(JSON.parse(await fs.readFile(candidates[0], "utf8")).paused).toBe(true);
    expect((await run("calls", "resume")).code).toBe(0);
    expect(JSON.parse(await fs.readFile(candidates[0], "utf8")).paused).toBe(false);
    const invalid = await run("unknown-command"); expect(invalid.code).toBe(1); expect(invalid.err).toContain("Unknown command");
    const incomplete = await run("context", "meeting"); expect(incomplete.code).toBe(1); expect(incomplete.out).toBe(""); expect(incomplete.err).toContain("job id");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
