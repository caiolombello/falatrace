// User-scope development headers for Ubuntu 26.04 / Qt 6.10.2.
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const sdk = join(homedir(), ".cache/recording-cli/desktop-sdk");
const debs = join(sdk, "debs");
await fs.mkdir(debs, { recursive: true });
const run = async (args: string[]) => {
  const child = Bun.spawn(args, { cwd: debs, stdout: "inherit", stderr: "inherit" });
  if (await child.exited) throw new Error(`Falha em ${args[0]}`);
};
await run(["apt-get", "download", "libmpv-dev=0.41.0-2ubuntu4", "libmpvqt-dev=1.1.1-2", "qt6-base-dev=6.10.2+dfsg-7", "qt6-base-dev-tools=6.10.2+dfsg-7", "qt6-declarative-dev=6.10.2+dfsg-3"]);
for (const name of await fs.readdir(debs)) if (name.endsWith(".deb")) await run(["dpkg-deb", "-x", join(debs, name), join(sdk, "root")]);
console.log("SDK local pronto. Execute bun run desktop:build.");
