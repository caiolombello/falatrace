// Development build runner. Installed FalaTrace Studio uses prebuilt release files.
// Qt/MpvQt headers stay in the user SDK cache; generated binaries stay in dist/.
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { version as productVersion } from "../../package.json";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const root = import.meta.dir;
const sdk = process.env.RECORDING_DESKTOP_SDK || join(homedir(), ".cache/recording-cli/desktop-sdk/root");
const build = resolve(root, "../../dist/desktop");
const include = join(sdk, "usr/include");
const qt = join(include, "x86_64-linux-gnu/qt6");
const moc = join(sdk, "usr/lib/qt6/libexec/moc");
const executable = join(build, "recording-studio");
const pendingPath = join(build, "build-pending");
const run = async (args: string[]): Promise<void> => {
  const child = Bun.spawn(args, { stdout: "inherit", stderr: "inherit" });
  const code = await child.exited;
  if (code !== 0) throw new Error(`Comando falhou (${code}): ${args[0]}`);
};
if (!(await Bun.file(moc).exists())) throw new Error("SDK Qt ausente. Execute bun run desktop:setup.");
await fs.mkdir(build, { recursive: true });
const source = join(root, "main.cpp");
// The Studio QML is split across files loaded at runtime; all of them identify the build.
const qmlFiles = (await fs.readdir(root)).filter((name) => name.endsWith(".qml")).sort().map((name) => join(root, name));
const buildInputs = [source, ...qmlFiles, join(root, "bridge.ts"), join(root, "run.ts"), resolve(root, "../../package.json")];
const fingerprint = createHash("sha256");
for (const input of buildInputs) fingerprint.update(await fs.readFile(input));
const buildId = fingerprint.digest("hex").slice(0, 12);
const metadata = `#define FALATRACE_VERSION ${JSON.stringify(productVersion)}\n#define FALATRACE_BUILD_ID ${JSON.stringify(buildId)}\n`;
const metadataPath = join(build, "build-info.h");
const metadataChanged = await fs.readFile(metadataPath, "utf8").catch(() => "") !== metadata;
const binaryStat = await fs.stat(executable).catch(() => null);
const inputMtime = Math.max((await fs.stat(source)).mtimeMs, (await fs.stat(metadataPath).catch(() => null))?.mtimeMs || 0);
const buildPending = await fs.lstat(pendingPath).then(() => true, (error) => {
  if (error.code === "ENOENT") return false;
  throw error;
});
if (buildPending || metadataChanged || !binaryStat || binaryStat.mtimeMs < inputMtime || process.argv.includes("--build")) {
  const includes = [include, join(include, "MpvQt"), qt, ...["QtCore", "QtGui", "QtQml", "QtQuick", "QtOpenGL"].map(name => join(qt, name)), build].map(dir => `-I${dir}`);
  const libraries = ["Qt6QuickControls2.so.6", "Qt6Quick.so.6", "Qt6Qml.so.6", "Qt6Gui.so.6", "Qt6Core.so.6", "MpvQt.so.2"].map(name => `/usr/lib/x86_64-linux-gnu/lib${name}`);
  // Leave this marker in place if the runner is interrupted before completion.
  await fs.writeFile(pendingPath, `${buildId}\n`);
  try {
    if (metadataChanged) await fs.writeFile(metadataPath, metadata);
    await run([moc, ...includes, source, "-o", join(build, "main.moc")]);
    await fs.rm(executable, { force: true });
    await run(["g++", "-std=c++20", "-O2", "-fPIC", ...includes, source, ...libraries, "-o", executable]);
    if (!(await fs.lstat(executable)).isFile()) throw new Error("Compilação não gerou um executável regular.");
    await fs.rm(pendingPath);
  } catch (error) {
    // Failed builds can leave an old or partially written executable behind.
    await fs.rm(executable, { force: true });
    throw error;
  }
}
if (!process.argv.includes("--build")) await run([executable, root, process.execPath]);
