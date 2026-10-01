import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { runCommand } from "../../jobs/command";
import { findFlatpakCapture, captureProcessMatches } from "../flatpak-capture";

const fixture = async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "flatpak-capture-"));
  const process = async (pid: number, command: string[], children: number[] = []) => {
    const dir = join(root, String(pid));
    await fs.mkdir(join(dir, "task", String(pid)), { recursive: true });
    await fs.writeFile(join(dir, "cmdline"), command.join("\0") + "\0");
    const stat = Array(20).fill("0"); stat[0] = "S"; stat[19] = "123456";
    await fs.writeFile(join(dir, "stat"), `${pid} (test process) ${stat.join(" ")}`);
    await fs.writeFile(join(dir, "task", String(pid), "children"), children.join(" "));
  };
  const run: typeof runCommand = async () => ({ stdout: "300\tcom.dec05eba.gpu_screen_recorder\n900\tother.application\n", stderr: "" });
  return { root, process, run };
};

test("finds only the actual recorder for the owned output inside the Flatpak process tree", async () => {
  const f = await fixture();
  try {
    await f.process(300, ["bwrap", "gpu-screen-recorder", "-o", "/owned.mkv"], [301, 302]);
    await f.process(301, ["gpu-screen-recorder", "-o", "/other.mkv"]);
    await f.process(302, ["gpu-screen-recorder", "-o", "/owned.mkv"]);
    expect(await findFlatpakCapture("/owned.mkv", f.run, f.root)).toEqual({ pid: 302, startTicks: "123456" });
    expect(await findFlatpakCapture("/missing.mkv", f.run, f.root)).toBeNull();
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});

test("rejects reused process IDs and ambiguous capture ownership", async () => {
  const f = await fixture();
  try {
    await f.process(300, ["bwrap"], [301, 302]);
    await f.process(301, ["gpu-screen-recorder", "-o", "/owned.mkv"]);
    await f.process(302, ["gpu-screen-recorder", "-o", "/owned.mkv"]);
    await expect(findFlatpakCapture("/owned.mkv", f.run, f.root)).rejects.toThrow("Multiple");
    expect(await captureProcessMatches({ pid: 301, startTicks: "different" }, "/owned.mkv", f.root)).toBe(false);
    await f.process(301, ["unrelated-process", "-o", "/owned.mkv"]);
    expect(await captureProcessMatches({ pid: 301, startTicks: "123456" }, "/owned.mkv", f.root)).toBe(false);
  } finally { await fs.rm(f.root, { recursive: true, force: true }); }
});
