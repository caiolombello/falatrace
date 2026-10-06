// Install or remove FalaTrace Studio for the current user from a source checkout.
//
// It builds the Qt shell with the local toolchain (system Qt packages or the
// desktop:setup SDK), copies the shell and its QML to ~/.local/share/falatrace/studio,
// and adds the recording-studio launcher (plus a falatrace-studio alias), a desktop
// entry and the icon. The Studio bridge runs through the installed falatrace CLI, so
// `make install-cli` comes first. Nothing runs with sudo and nothing is downloaded.
// Removal only touches files that carry this installer's marker.
import { constants, promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const MARKER = "Installed by FalaTrace make install-studio";
const DESKTOP_MARKER = "X-FalaTrace-Installed=install-studio";
const STUDIO_MARKER_FILE = ".installed-by-falatrace";

export type InstallPaths = {
  prefix: string;
  dataHome: string;
  binDir: string;
  cli: string;
  launcher: string;
  alias: string;
  studioDir: string;
  desktopEntry: string;
  icon: string;
};

export const installPaths = (env: NodeJS.ProcessEnv = process.env, home = homedir()): InstallPaths => {
  const prefix = env.INSTALL_PREFIX?.startsWith("/") ? env.INSTALL_PREFIX : join(home, ".local");
  const dataHome = env.XDG_DATA_HOME?.startsWith("/") ? env.XDG_DATA_HOME : join(home, ".local", "share");
  const binDir = join(prefix, "bin");
  return {
    prefix, dataHome, binDir,
    cli: join(binDir, "falatrace"),
    launcher: join(binDir, "recording-studio"),
    alias: join(binDir, "falatrace-studio"),
    studioDir: join(dataHome, "falatrace", "studio"),
    desktopEntry: join(dataHome, "applications", "recording-studio.desktop"),
    icon: join(dataHome, "icons", "hicolor", "scalable", "apps", "falatrace-studio.svg")
  };
};

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
// Desktop entry Exec arguments are double-quoted; inside them ", `, $ and \ are escaped with a
// backslash, and the string-level escaping doubles every backslash again (spec: "\\\\" is one
// literal backslash).
const desktopQuote = (value: string): string =>
  `"${value.replace(/["`$\\]/g, (character) => (character === "\\" ? "\\\\\\\\" : `\\\\${character}`))}"`;

export const launcherScript = (paths: InstallPaths): string => `#!/bin/sh
# ${MARKER}. Remove with: make uninstall-studio
exec ${shellQuote(join(paths.studioDir, "recording-studio"))} ${shellQuote(join(paths.studioDir, "qml"))} ${shellQuote(paths.cli)} --packaged
`;

export const desktopEntry = (paths: InstallPaths): string => `[Desktop Entry]
Type=Application
Name=FalaTrace Studio
GenericName=Recording library
GenericName[pt_BR]=Biblioteca de gravações
Comment=Authorized recordings, transcripts and summaries traced to the source
Comment[pt_BR]=Gravações autorizadas, transcrições e resumos com rastreio até a fonte
Exec=${desktopQuote(paths.launcher)}
Icon=falatrace-studio
Terminal=false
Categories=AudioVideo;Office;
StartupWMClass=recording-studio
${DESKTOP_MARKER}
`;

const exists = (path: string) => fs.lstat(path).then(() => true, () => false);
const readText = (path: string) => fs.readFile(path, "utf8").catch(() => null);

/** A file this installer may replace or remove: absent, or written by it earlier. */
const ownedOrAbsent = async (path: string, marker: string): Promise<boolean> => {
  const stat = await fs.lstat(path).catch(() => null);
  if (!stat) return true;
  if (!stat.isFile()) return false;
  return (await readText(path))?.includes(marker) === true;
};

const writeFileAtomic = async (path: string, contents: string | Uint8Array, mode: number) => {
  await fs.mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await fs.writeFile(temporary, contents, { mode });
  await fs.chmod(temporary, mode);
  await fs.rename(temporary, path);
};

export type InstallOptions = {
  paths?: InstallPaths;
  /** Source checkout root (contains src/desktop and docs/assets). */
  repo?: string;
  /** Produces the shell binary and returns its path. Defaults to `bun src/desktop/run.ts --build`. */
  build?: () => Promise<string>;
  /** Replace a launcher or desktop entry that this installer did not write (for example a release install). */
  replace?: boolean;
  /** Refresh desktop and icon caches when the tools exist. */
  refreshCaches?: boolean;
  log?: (line: string) => void;
};

const defaultBuild = (repo: string) => async (): Promise<string> => {
  const child = Bun.spawn([process.execPath, join(repo, "src/desktop/run.ts"), "--build"], { stdout: "inherit", stderr: "inherit" });
  if (await child.exited) throw new Error("A compilação do Studio falhou; nada foi instalado.");
  return join(repo, "dist/desktop/recording-studio");
};

const refresh = async (paths: InstallPaths) => {
  for (const [command, args] of [
    ["update-desktop-database", [dirname(paths.desktopEntry)]],
    ["gtk-update-icon-cache", ["-q", "-t", join(paths.dataHome, "icons", "hicolor")]]
  ] as const) {
    const tool = Bun.which(command);
    if (!tool) continue;
    await Bun.spawn([tool, ...args], { stdout: "ignore", stderr: "ignore" }).exited.catch(() => undefined);
  }
};

export const installStudio = async (options: InstallOptions = {}): Promise<InstallPaths> => {
  const paths = options.paths ?? installPaths();
  const repo = options.repo ?? resolve(import.meta.dir, "../..");
  const log = options.log ?? ((line: string) => console.log(line));
  await fs.access(paths.cli, constants.X_OK).catch(() => {
    throw new Error(`A CLI não está instalada em ${paths.cli}. Rode make install-cli antes.`);
  });
  for (const [path, marker] of [[paths.launcher, MARKER], [paths.desktopEntry, DESKTOP_MARKER]] as const) {
    if (!options.replace && !(await ownedOrAbsent(path, marker))) {
      throw new Error(`${path} não foi instalado por este comando (talvez pela release). Remova-o ou use REPLACE=1.`);
    }
  }
  const studioStat = await fs.lstat(paths.studioDir).catch(() => null);
  if (studioStat && (!studioStat.isDirectory() || (!options.replace && !(await exists(join(paths.studioDir, STUDIO_MARKER_FILE)))))) {
    throw new Error(`${paths.studioDir} existe e não foi criado por este comando; nada foi alterado.`);
  }

  const binary = await (options.build ?? defaultBuild(repo))();
  const source = join(repo, "src/desktop");
  const files = (await fs.readdir(source)).filter((name) => name.endsWith(".qml") || name.endsWith(".js"));
  if (!files.includes("Main.qml")) throw new Error("Main.qml não encontrado; rode a partir do código-fonte do FalaTrace.");

  // Stage the new copy next to the old one, then swap, so a failure leaves the old install.
  const staging = `${paths.studioDir}.new-${process.pid}`;
  await fs.rm(staging, { recursive: true, force: true });
  await fs.mkdir(join(staging, "qml"), { recursive: true, mode: 0o755 });
  try {
    await fs.copyFile(binary, join(staging, "recording-studio"));
    await fs.chmod(join(staging, "recording-studio"), 0o755);
    for (const name of files) await fs.copyFile(join(source, name), join(staging, "qml", name));
    await fs.writeFile(join(staging, STUDIO_MARKER_FILE), `${MARKER}\n`);
    const previous = `${paths.studioDir}.old-${process.pid}`;
    if (studioStat) await fs.rename(paths.studioDir, previous);
    await fs.rename(staging, paths.studioDir);
    await fs.rm(previous, { recursive: true, force: true });
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }

  await writeFileAtomic(paths.launcher, launcherScript(paths), 0o755);
  const alias = await fs.lstat(paths.alias).catch(() => null);
  if (!alias || (alias.isSymbolicLink() && (await fs.readlink(paths.alias)) === paths.launcher)) {
    await fs.rm(paths.alias, { force: true });
    await fs.symlink(paths.launcher, paths.alias);
  } else {
    log(`${paths.alias} já existe e foi mantido.`);
  }
  await writeFileAtomic(paths.desktopEntry, desktopEntry(paths), 0o644);
  await writeFileAtomic(paths.icon, await fs.readFile(join(repo, "docs/assets/falatrace-avatar.svg")), 0o644);
  if (options.refreshCaches !== false) await refresh(paths);
  log(`FalaTrace Studio instalado em ${paths.studioDir}.`);
  log(`Abra pelo menu de aplicativos ou rode ${paths.launcher}.`);
  return paths;
};

export const uninstallStudio = async (options: Pick<InstallOptions, "paths" | "log" | "refreshCaches"> = {}): Promise<string[]> => {
  const paths = options.paths ?? installPaths();
  const log = options.log ?? ((line: string) => console.log(line));
  const removed: string[] = [];
  const kept: string[] = [];
  const remove = async (path: string, owned: boolean) => {
    if (!(await exists(path))) return;
    if (!owned) { kept.push(path); return; }
    await fs.rm(path, { recursive: true, force: true });
    removed.push(path);
  };
  const alias = await fs.lstat(paths.alias).catch(() => null);
  await remove(paths.alias, !!alias?.isSymbolicLink() && (await fs.readlink(paths.alias)) === paths.launcher);
  await remove(paths.launcher, await ownedOrAbsent(paths.launcher, MARKER));
  await remove(paths.desktopEntry, await ownedOrAbsent(paths.desktopEntry, DESKTOP_MARKER));
  await remove(paths.icon, true);
  const studio = await fs.lstat(paths.studioDir).catch(() => null);
  await remove(paths.studioDir, !!studio?.isDirectory() && (await exists(join(paths.studioDir, STUDIO_MARKER_FILE))));
  if (options.refreshCaches !== false) await refresh(paths);
  for (const path of removed) log(`Removido: ${path}`);
  for (const path of kept) log(`Mantido (não foi instalado por este comando): ${path}`);
  if (!removed.length && !kept.length) log("Nada a remover.");
  return removed;
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  const run = args.includes("--uninstall")
    ? uninstallStudio()
    : installStudio({ replace: args.includes("--replace") });
  await run.catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
