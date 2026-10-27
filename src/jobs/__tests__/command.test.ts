import { expect, test } from "bun:test";
import { runCommand } from "../command";

// 150 000 "é" (2 bytes each in UTF-8): over the 100 000 characters kept by default, and
// pipe chunks split some of them in half.
const print = ["-e", "process.stdout.write(JSON.stringify([...Array.from({ length: 1500 }, () => 'é'.repeat(100)), 'end']))"];

test("by default only the tail of a long output is kept", async () => {
  const { stdout } = await runCommand(process.execPath, print);
  expect(stdout.length).toBe(100_000);
  expect(stdout.endsWith("\"end\"]")).toBe(true);
});

test("a command read whole returns its full output, multi-byte characters intact", async () => {
  const { stdout } = await runCommand(process.execPath, print, { maxOutputBytes: 1024 * 1024 });
  const parsed = JSON.parse(stdout) as string[];
  expect(parsed).toHaveLength(1501);
  expect(parsed[0]).toBe("é".repeat(100));
  expect(stdout.includes("�")).toBe(false);
});

test("a command read whole fails instead of returning a cut output", async () => {
  await expect(runCommand(process.execPath, print, { maxOutputBytes: 64 * 1024 })).rejects.toThrow(`${process.execPath} output exceeded 65536 bytes`);
});
