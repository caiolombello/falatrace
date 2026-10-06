import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertQaIsolation } from "../../../scripts/qa-isolation-guard";
import * as playback from "../playback";

assertQaIsolation();

const ID = "123e4567-e89b-42d3-a456-426614174000";
const STATE_DIR = "FALATRACE_PLAYBACK_STATE_DIR";

test("a playback unit answers in the Studio's state directory, not in the user manager's runtime directory", async () => {
  // Without XDG_RUNTIME_DIR the Studio keeps playback state under the cache; the unit is told where.
  const unset = playback.playbackRunArgs("recording-studio-playback-1", ["/x/falatrace"], ID, "/rec/a.mkv", { PATH: "/usr/bin" }, "/home/u");
  expect(unset.slice(0, unset.indexOf("--"))).toContain(`--setenv=${STATE_DIR}=/home/u/.cache/recording-cli/desktop`);
  const set = playback.playbackRunArgs("recording-studio-playback-1", ["/x/falatrace"], ID, "/rec/a.mkv", { PATH: "/usr/bin", XDG_RUNTIME_DIR: "/run/user/1000" }, "/home/u");
  expect(set.slice(0, set.indexOf("--"))).toContain(`--setenv=${STATE_DIR}=/run/user/1000/recording-cli/desktop`);

  // The worker runs with the manager's runtime directory and still writes where the Studio reads.
  const root = await fs.mkdtemp(join(tmpdir(), "falatrace-playback-"));
  const saved = { [STATE_DIR]: process.env[STATE_DIR], XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR };
  try {
    const studio = join(root, "studio", "recording-cli", "desktop");
    process.env[STATE_DIR] = studio;
    process.env.XDG_RUNTIME_DIR = join(root, "manager");
    await playback.runPlaybackWorker(ID, "/synthetic/missing.mkv");
    expect(JSON.parse(await fs.readFile(join(studio, `${ID}.json`), "utf8"))).toMatchObject({ state: "failed", operationId: ID });
    await expect(fs.stat(join(root, "manager"))).rejects.toThrow();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("only an absolute directory given to the unit replaces the runtime one", () => {
  const runtime = { XDG_RUNTIME_DIR: "/run/user/1000" };
  expect(playback.playbackStateDir({ ...runtime, [STATE_DIR]: "/home/u/.cache/recording-cli/desktop" }, "/home/u")).toBe("/home/u/.cache/recording-cli/desktop");
  expect(playback.playbackStateDir({ ...runtime, [STATE_DIR]: "relative/desktop" }, "/home/u")).toBe("/run/user/1000/recording-cli/desktop");
  expect(playback.playbackStateDir({ ...runtime, [STATE_DIR]: "/run/a\nb" }, "/home/u")).toBe("/run/user/1000/recording-cli/desktop");
  expect(playback.playbackStateDir({}, "/home/u")).toBe("/home/u/.cache/recording-cli/desktop");
});
