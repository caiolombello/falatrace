import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { desktopEntry, installPaths, installStudio, MARKER, swapInto, uninstallStudio } from "../install";

const repo = resolve(import.meta.dir, "../../..");

/** A synthetic home whose prefix contains a space and a quote, to exercise the quoting. */
const fixture = async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "falatrace-install-"));
  const home = join(root, "it's home");
  const paths = installPaths({ INSTALL_PREFIX: join(home, ".local"), XDG_DATA_HOME: join(home, ".local", "share") }, home);
  const output = join(root, "launched-args");
  // The "built" shell only records the arguments the launcher passes to it.
  const binary = join(root, "recording-studio");
  await fs.writeFile(binary, `#!/bin/sh\nprintf '%s\\n' "$@" > '${output}'\n`, { mode: 0o755 });
  const build = async () => binary;
  const options = { paths, repo, build, refreshCaches: false, log: () => undefined };
  return { root, paths, output, options };
};

test("install refuses to run before the CLI is installed", async () => {
  const { root, options } = await fixture();
  try {
    await expect(installStudio(options)).rejects.toThrow("make install-cli");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("install copies the shell and QML, and the launcher starts it in packaged mode", async () => {
  const { root, paths, output, options } = await fixture();
  try {
    await fs.mkdir(paths.binDir, { recursive: true });
    await fs.writeFile(paths.cli, "#!/bin/sh\n", { mode: 0o755 });
    await installStudio(options);
    expect((await fs.stat(join(paths.studioDir, "recording-studio"))).mode & 0o777).toBe(0o755);
    for (const name of ["Main.qml", "SettingsDialog.qml", "i18n.js"]) expect(await Bun.file(join(paths.studioDir, "qml", name)).exists()).toBe(true);
    expect(await fs.readFile(paths.launcher, "utf8")).toContain(MARKER);
    expect(await fs.readlink(paths.alias)).toBe(paths.launcher);
    expect(await fs.readFile(paths.desktopEntry, "utf8")).toBe(desktopEntry(paths));
    expect(await fs.readFile(paths.icon, "utf8")).toContain("FalaTrace avatar");
    expect(await fs.readFile(paths.icon, "utf8")).toEndWith(`<!-- ${MARKER} -->\n`);

    const launched = Bun.spawn([paths.launcher], { stdout: "ignore", stderr: "pipe" });
    expect(await launched.exited).toBe(0);
    expect((await fs.readFile(output, "utf8")).trim().split("\n")).toEqual([join(paths.studioDir, "qml"), paths.cli, "--packaged"]);

    // Reinstalling replaces the copy in place and leaves no staging directories behind.
    await installStudio(options);
    expect((await fs.readdir(join(paths.dataHome, "falatrace"))).sort()).toEqual(["studio"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("files another installer wrote are kept unless replacing is explicit", async () => {
  const { root, paths, options } = await fixture();
  try {
    await fs.mkdir(paths.binDir, { recursive: true });
    await fs.writeFile(paths.cli, "#!/bin/sh\n", { mode: 0o755 });
    await fs.writeFile(paths.launcher, "#!/bin/sh\n# release launcher\n", { mode: 0o755 });
    await expect(installStudio(options)).rejects.toThrow("REPLACE=1");
    expect(await fs.readFile(paths.launcher, "utf8")).toContain("release launcher");
    await installStudio({ ...options, replace: true });
    expect(await fs.readFile(paths.launcher, "utf8")).toContain(MARKER);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("an icon from another install is neither replaced nor removed", async () => {
  const { root, paths, options } = await fixture();
  try {
    await fs.mkdir(paths.binDir, { recursive: true });
    await fs.writeFile(paths.cli, "#!/bin/sh\n", { mode: 0o755 });
    await fs.mkdir(join(paths.icon, ".."), { recursive: true });
    await fs.writeFile(paths.icon, "<svg><title>release icon</title></svg>\n");
    await installStudio(options);
    expect(await fs.readFile(paths.icon, "utf8")).toBe("<svg><title>release icon</title></svg>\n");
    const removed = await uninstallStudio({ paths, refreshCaches: false, log: () => undefined });
    expect(removed).not.toContain(paths.icon);
    expect(await fs.readFile(paths.icon, "utf8")).toBe("<svg><title>release icon</title></svg>\n");
    await installStudio({ ...options, replace: true });
    expect(await fs.readFile(paths.icon, "utf8")).toContain(MARKER);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("uninstall removes only what the installer created", async () => {
  const { root, paths, options } = await fixture();
  try {
    await fs.mkdir(paths.binDir, { recursive: true });
    await fs.writeFile(paths.cli, "#!/bin/sh\n", { mode: 0o755 });
    await installStudio(options);
    // A desktop entry edited by the user (marker gone) is no longer ours.
    await fs.writeFile(paths.desktopEntry, "[Desktop Entry]\nName=Custom\n");
    const removed = await uninstallStudio({ paths, refreshCaches: false, log: () => undefined });
    expect(removed.sort()).toEqual([paths.alias, paths.icon, paths.launcher, paths.studioDir].sort());
    expect(await fs.readFile(paths.desktopEntry, "utf8")).toContain("Custom");
    expect(await Bun.file(paths.cli).exists()).toBe(true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a swap that fails halfway puts the previous Studio back", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "falatrace-swap-"));
  try {
    const target = join(root, "studio");
    const staging = join(root, "studio.new");
    await fs.mkdir(target);
    await fs.writeFile(join(target, "old"), "old");
    await fs.mkdir(staging);
    await fs.writeFile(join(staging, "new"), "new");
    let calls = 0;
    const failing = (async (from: string, to: string) => {
      calls += 1;
      if (calls === 2) throw new Error("rename failed halfway");
      return fs.rename(from, to);
    }) as typeof fs.rename;
    await expect(swapInto(staging, target, failing)).rejects.toThrow("rename failed halfway");
    expect(await fs.readdir(target)).toEqual(["old"]);
    await swapInto(staging, target);
    expect(await fs.readdir(target)).toEqual(["new"]);
    expect(await fs.readdir(root)).toEqual(["studio"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
