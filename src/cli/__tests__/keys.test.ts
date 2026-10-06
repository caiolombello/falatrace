import { expect, test } from "bun:test";
import { assertQaIsolation } from "../../../scripts/qa-isolation-guard";
import { runKeysCli, type KeysCliDeps } from "../keys";

assertQaIsolation();

const fakeDeps = (captureActive: boolean) => {
  const calls: string[] = [];
  const deps: KeysCliDeps = {
    readValue: async () => { calls.push("read"); return "synthetic-value"; },
    setSecret: async (name) => { calls.push(`set:${String(name)}`); },
    removeSecret: async (name) => { calls.push(`remove:${String(name)}`); return { removed: true }; },
    lock: async (name) => { calls.push(`lock:${name}`); return { release: async () => { calls.push("release"); } }; },
    captureActive: async () => captureActive
  };
  return { deps, calls };
};

test("keys set and remove leave the OBS password alone while a capture runs, since stopping it authenticates again", async () => {
  const log = console.log;
  console.log = () => undefined;
  try {
    const busySet = fakeDeps(true);
    await expect(runKeysCli(["keys", "set", "RECORDING_CLI_OBS_PASSWORD"], busySet.deps)).rejects.toThrow("senha do OBS");
    // The value is read before the lock is taken, so waiting for it never holds up a capture.
    expect(busySet.calls).toEqual(["read", "lock:capture-control", "release"]);
    const busyRemove = fakeDeps(true);
    await expect(runKeysCli(["keys", "remove", "RECORDING_CLI_OBS_PASSWORD"], busyRemove.deps)).rejects.toThrow("senha do OBS");
    expect(busyRemove.calls).toEqual(["lock:capture-control", "release"]);
    // Other keys are not read when a capture stops; without a capture the password changes under the lock.
    const other = fakeDeps(true);
    await runKeysCli(["keys", "set", "OPENAI_API_KEY"], other.deps);
    expect(other.calls).toEqual(["read", "set:OPENAI_API_KEY"]);
    const idle = fakeDeps(false);
    await runKeysCli(["keys", "set", "RECORDING_CLI_OBS_PASSWORD"], idle.deps);
    await runKeysCli(["keys", "remove", "RECORDING_CLI_OBS_PASSWORD"], idle.deps);
    expect(idle.calls).toEqual([
      "read", "lock:capture-control", "set:RECORDING_CLI_OBS_PASSWORD", "release",
      "lock:capture-control", "remove:RECORDING_CLI_OBS_PASSWORD", "release"
    ]);
  } finally {
    console.log = log;
  }
});
