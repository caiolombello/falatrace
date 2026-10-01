import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

/** Complete private file publication; never follows an existing artifact symlink. */
export const writePrivateArtifact = async (path: string, text: string): Promise<void> => {
  const directory = await fs.lstat(dirname(path));
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Unsafe artifact directory");
  const existing = await fs.lstat(path).catch(error => { if (error.code === "ENOENT") return undefined; throw error; });
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error("Unsafe existing artifact; preserved");
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, text, { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, path);
  } finally { await fs.rm(temporary, { force: true }); }
};
