import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type BuildMode = "success" | "fail" | "partial-fail" | "partial-wait" | "moc-fail" | "no-output" | "symlink-output";

const scriptBinary = (label: string) => `#!/bin/sh\nprintf '${label}\\n' >> "$ALPHA6_BUILD_LOG"\n`;

async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), "alpha6-desktop-build-"));
  const source = join(root, "src/desktop");
  const build = join(root, "dist/desktop");
  const sdk = join(root, "sdk");
  const bin = join(root, "bin");
  const log = join(root, "commands.log");
  const mode = join(root, "compiler-mode");
  const runner = join(source, "run.ts");
  const executable = join(build, "recording-studio");
  const metadata = join(build, "build-info.h");
  const pending = join(build, "build-pending");
  const waitScript = join(root, "compiler-wait.ts");
  const compilerReady = join(root, "compiler-ready");
  for (const path of [source, build, bin, join(sdk, "usr/lib/qt6/libexec")]) {
    await fs.mkdir(path, { recursive: true });
  }
  await fs.copyFile(new URL("../run.ts", import.meta.url), runner);
  await fs.writeFile(join(root, "package.json"), JSON.stringify({ version: "9.9.9-synthetic", type: "module" }));
  for (const name of ["main.cpp", "Main.qml", "bridge.ts"]) {
    await fs.writeFile(join(source, name), "// synthetic build fixture\n");
  }
  const past = Date.now() / 1000 - 60;
  await fs.utimes(join(source, "main.cpp"), past, past);
  await fs.writeFile(mode, "success");
  await fs.writeFile(waitScript, `import { promises as fs } from "node:fs";
const output = process.argv[2];
await fs.writeFile(output, '#!/bin/sh\\nprintf "execute-partial\\\\n" >> "$ALPHA6_BUILD_LOG"\\n', { mode: 0o700 });
const header = await fs.stat(process.env.ALPHA6_BUILD_METADATA!);
await fs.utimes(output, new Date(), new Date(header.mtimeMs + 1000));
await fs.writeFile(process.env.ALPHA6_COMPILER_READY!, String(process.pid));
setInterval(() => {}, 1000);
`);
  await fs.writeFile(join(sdk, "usr/lib/qt6/libexec/moc"), `#!/bin/sh
printf 'moc\\n' >> "$ALPHA6_BUILD_LOG"
if [ "$(cat "$ALPHA6_BUILD_MODE")" = moc-fail ]; then
  printf 'SYNTHETIC_MOC_FAILED\\n' >&2
  exit 6
fi
`, { mode: 0o700 });
  await fs.writeFile(join(bin, "g++"), `#!/bin/sh
printf 'compile\\n' >> "$ALPHA6_BUILD_LOG"
output=
while [ "$#" -gt 0 ]; do
  if [ "$1" = -o ]; then
    shift
    output=$1
  fi
  shift
done
mode=$(cat "$ALPHA6_BUILD_MODE")
if [ "$mode" = partial-wait ]; then
  exec "$ALPHA6_BUILD_INTERPRETER" "$ALPHA6_COMPILER_WAIT_SCRIPT" "$output"
fi
if [ "$mode" = no-output ]; then
  exit 0
fi
if [ "$mode" = symlink-output ]; then
  ln -s "$ALPHA6_BUILD_MODE" "$output"
  exit 0
fi
if [ "$mode" = fail ]; then
  printf 'SYNTHETIC_COMPILER_FAILED\\n' >&2
  exit 7
fi
if [ "$mode" = partial-fail ]; then
  printf '#!/bin/sh\\nprintf "execute-partial\\\\n" >> "$ALPHA6_BUILD_LOG"\\n' > "$output"
  chmod 700 "$output"
  printf 'SYNTHETIC_COMPILER_FAILED\\n' >&2
  exit 7
fi
printf '#!/bin/sh\\nprintf "execute-current\\\\n" >> "$ALPHA6_BUILD_LOG"\\n' > "$output"
chmod 700 "$output"
`, { mode: 0o700 });

  const env = {
    ...process.env,
    PATH: `${bin}:/usr/bin:/bin`,
    RECORDING_DESKTOP_SDK: sdk,
    ALPHA6_BUILD_LOG: log,
    ALPHA6_BUILD_MODE: mode,
    ALPHA6_BUILD_METADATA: metadata,
    ALPHA6_BUILD_INTERPRETER: process.execPath,
    ALPHA6_COMPILER_WAIT_SCRIPT: waitScript,
    ALPHA6_COMPILER_READY: compilerReady,
  };

  return {
    root, source, runner, executable, metadata, pending, compilerReady, env,
    setMode: (value: BuildMode) => fs.writeFile(mode, value),
    async oldBinary() {
      await fs.writeFile(executable, scriptBinary("execute-old"), { mode: 0o700 });
      const older = Date.now() / 1000 - 30;
      await fs.utimes(executable, older, older);
    },
    async commands() {
      const contents = await fs.readFile(log, "utf8").catch(() => "");
      return contents.trim().split("\n").filter(Boolean);
    },
    async run(...args: string[]) {
      const child = Bun.spawn([process.execPath, runner, ...args], {
        cwd: root,
        env,
        stdout: "pipe", stderr: "pipe",
      });
      const [code, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      return { code, stdout, stderr };
    },
  };
}

async function withFixture(run: (value: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const value = await fixture();
  try {
    await run(value);
  } finally {
    await fs.rm(value.root, { recursive: true, force: true });
  }
}

test("publishes the pending marker before changed metadata, even with a future-dated old binary", async () => {
  await withFixture(async (f) => {
    await f.oldBinary();
    const future = Date.now() / 1000 + 86400;
    await fs.utimes(f.executable, future, future);
    const interceptor = join(f.root, "stop-after-header.ts");
    await fs.writeFile(interceptor, `import { promises as fs } from "node:fs";
const original = fs.writeFile.bind(fs);
fs.writeFile = async (...args) => {
  const result = await original(...args);
  if (String(args[0]).endsWith("build-info.h")) process.kill(process.pid, "SIGKILL");
  return result;
};
`);
    const stopped = Bun.spawn([process.execPath, "--preload", interceptor, f.runner], {
      cwd: f.root, env: f.env, stdout: "ignore", stderr: "ignore",
    });
    expect(await stopped.exited).not.toBe(0);
    expect(await Bun.file(f.metadata).exists()).toBe(true);
    expect(await Bun.file(f.pending).exists()).toBe(true);
    expect(await f.commands()).toEqual([]);
    expect((await f.run()).code).toBe(0);
    expect(await f.commands()).toEqual(["moc", "compile", "execute-current"]);
    expect(await Bun.file(f.pending).exists()).toBe(false);
  });
});

describe("desktop build freshness", () => {
  test("retries a failed changed-fingerprint build without executing the old binary", async () => {
    await withFixture(async (f) => {
      expect((await f.run("--build")).code).toBe(0);
      const previousMetadata = await fs.readFile(f.metadata, "utf8");
      await fs.appendFile(join(f.source, "Main.qml"), "// changed synthetic build input\n");
      await f.oldBinary();
      await f.setMode("fail");
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await f.run();
        expect(result.code).not.toBe(0);
        expect(result.stderr).toContain("SYNTHETIC_COMPILER_FAILED");
      }
      const metadata = await fs.readFile(f.metadata, "utf8");
      expect(metadata).toContain("9.9.9-synthetic");
      expect(metadata).not.toBe(previousMetadata);
      expect(await f.commands()).toEqual(["moc", "compile", "moc", "compile", "moc", "compile"]);
      expect(await Bun.file(f.executable).exists()).toBe(false);
      expect(await Bun.file(f.pending).exists()).toBe(true);
    });
  });

  test.each(["partial-fail", "moc-fail"] as const)("removes failed --build output before a normal retry (%s)", async (mode) => {
    await withFixture(async (f) => {
      expect((await f.run("--build")).code).toBe(0);
      await f.setMode(mode);
      expect((await f.run("--build")).code).not.toBe(0);
      expect(await Bun.file(f.executable).exists()).toBe(false);
      expect((await f.run()).code).not.toBe(0);
      expect(await f.commands()).toEqual(mode === "moc-fail" ? ["moc", "compile", "moc", "moc"] : ["moc", "compile", "moc", "compile", "moc", "compile"]);
    });
  });

  test("retries successfully and then reuses the compiled artifact", async () => {
    await withFixture(async (f) => {
      await f.oldBinary();
      await f.setMode("fail");
      expect((await f.run()).code).not.toBe(0);
      await f.setMode("success");
      expect((await f.run()).code).toBe(0);
      expect(await fs.readFile(f.executable, "utf8")).toContain("execute-current");
      expect((await f.run()).code).toBe(0);
      expect(await Bun.file(f.pending).exists()).toBe(false);
      expect(await f.commands()).toEqual(["moc", "compile", "moc", "compile", "execute-current", "execute-current"]);
    });
  });

  test("builds an absent binary and forces --build without executing it", async () => {
    await withFixture(async (f) => {
      expect(await Bun.file(f.executable).exists()).toBe(false);
      expect((await f.run()).code).toBe(0);
      expect((await f.run("--build")).code).toBe(0);
      expect((await f.run()).code).toBe(0);
      expect(await f.commands()).toEqual(["moc", "compile", "execute-current", "moc", "compile", "execute-current"]);
    });
  });

  test("rebuilds when unchanged metadata is newer than the binary and main.cpp", async () => {
    await withFixture(async (f) => {
      expect((await f.run("--build")).code).toBe(0);
      await f.oldBinary();
      const newer = Date.now() / 1000 - 10;
      await fs.utimes(f.metadata, newer, newer);
      await f.setMode("fail");
      expect((await f.run()).code).not.toBe(0);
      expect(await f.commands()).toEqual(["moc", "compile", "moc", "compile"]);
    });
  });

  test.each(["no-output", "symlink-output"] as const)("keeps the build pending when compiler success has no regular output (%s)", async (mode) => {
    await withFixture(async (f) => {
      expect((await f.run("--build")).code).toBe(0);
      await f.setMode(mode);
      expect((await f.run("--build")).code).not.toBe(0);
      expect(await Bun.file(f.executable).exists()).toBe(false);
      expect(await Bun.file(f.pending).exists()).toBe(true);
      await f.setMode("success");
      expect((await f.run()).code).toBe(0);
      expect(await Bun.file(f.pending).exists()).toBe(false);
      expect(await f.commands()).toEqual(["moc", "compile", "moc", "compile", "moc", "compile", "execute-current"]);
    });
  });

  test("rebuilds after SIGKILL leaves a partial executable newer than the header", async () => {
    await withFixture(async (f) => {
      await f.oldBinary();
      await f.setMode("partial-wait");
      // A new session gives this fixture its own group, including the waiting compiler stub.
      const child = spawn(process.execPath, [f.runner], {
        cwd: f.root, env: f.env, detached: true, stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.resume();
      child.stderr.resume();
      let childClosed = false;
      let spawnError: Error | undefined;
      child.once("error", (error) => { spawnError = error; });
      const closed = new Promise<NodeJS.Signals | null>((resolve) => {
        child.once("close", (_code, signal) => {
          childClosed = true;
          resolve(signal);
        });
      });
      const killGroup = () => {
        if (child.pid && !childClosed) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
        }
      };
      try {
        for (let attempt = 0; attempt < 300 && !childClosed && !spawnError && !(await Bun.file(f.compilerReady).exists()); attempt++) {
          await Bun.sleep(10);
        }
        if (spawnError) throw spawnError;
        expect(await Bun.file(f.compilerReady).exists()).toBe(true);
        expect(await fs.readFile(f.executable, "utf8")).toContain("execute-partial");
        expect((await fs.stat(f.executable)).mtimeMs).toBeGreaterThan((await fs.stat(f.metadata)).mtimeMs);
        expect(await Bun.file(f.pending).exists()).toBe(true);
        killGroup();
        expect(await closed).toBe("SIGKILL");
      } finally {
        killGroup();
        await closed;
      }
      expect(await Bun.file(f.pending).exists()).toBe(true);
      await f.setMode("success");
      expect((await f.run()).code).toBe(0);
      expect(await Bun.file(f.pending).exists()).toBe(false);
      expect(await fs.readFile(f.executable, "utf8")).toContain("execute-current");
      expect((await f.run()).code).toBe(0);
      expect(await f.commands()).toEqual(["moc", "compile", "moc", "compile", "execute-current", "execute-current"]);
    });
  });
});
