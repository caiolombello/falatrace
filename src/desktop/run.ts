// Development build runner. Installed FalaTrace Studio uses prebuilt release files.
// Qt/MpvQt headers stay in the user SDK cache; generated binaries stay in dist/.
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const root = import.meta.dir;
const sdk = process.env.RECORDING_DESKTOP_SDK || join(homedir(), ".cache/recording-cli/desktop-sdk/root");
const build = resolve(root, "../../dist/desktop");
const include = join(sdk, "usr/include");
const qt = join(include, "x86_64-linux-gnu/qt6");
const moc = join(sdk, "usr/lib/qt6/libexec/moc");
const executable = join(build, "recording-studio");
const run = async (args: string[]): Promise<void> => {
  const child = Bun.spawn(args, { stdout: "inherit", stderr: "inherit" });
  const code = await child.exited;
  if (code !== 0) throw new Error(`Comando falhou (${code}): ${args[0]}`);
};
if (!(await Bun.file(moc).exists())) throw new Error("SDK Qt ausente. Execute bun run desktop:setup.");
await fs.mkdir(build, { recursive: true });
const source = join(root, "main.cpp");
const binaryStat = await fs.stat(executable).catch(() => null);
if (!binaryStat || binaryStat.mtimeMs < (await fs.stat(source)).mtimeMs || process.argv.includes("--build")) {
  const includes = [include, join(include, "MpvQt"), qt, ...["QtCore", "QtGui", "QtQml", "QtQuick", "QtOpenGL"].map(name => join(qt, name)), build].map(dir => `-I${dir}`);
  await run([moc, ...includes, source, "-o", join(build, "main.moc")]);
  const libraries = ["Qt6QuickControls2.so.6", "Qt6Quick.so.6", "Qt6Qml.so.6", "Qt6Gui.so.6", "Qt6Core.so.6", "MpvQt.so.2"].map(name => `/usr/lib/x86_64-linux-gnu/lib${name}`);
  await run(["g++", "-std=c++20", "-O2", "-fPIC", ...includes, source, ...libraries, "-o", executable]);
}
if (!process.argv.includes("--build")) await run([executable, root, process.execPath]);
