import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { acquireSingleton } from "../runtime/singleton";

export const aiContextRoot = (): string => join(process.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "recording-cli/ai-context");
const markerPath = (root: string): string => join(root, ".invalidated.json");
const leaseFor = async (root: string) => {
  const name = `ai-context-${createHash("sha256").update(root).digest("hex").slice(0,32)}`;
  for (let attempt = 0; ; attempt++) {
    try { return await acquireSingleton(name); }
    catch (error) {
      if (!(error instanceof Error) || error.message !== `${name} is already running` || attempt >= 20) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
};

export const readContextInvalidation = async (root = aiContextRoot()): Promise<string | undefined> => {
  try {
    const directory = await fs.lstat(root);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Unsafe AI context directory; rebuild required");
    const stat = await fs.lstat(markerPath(root));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error("Invalid AI context marker; rebuild required");
    return await fs.readFile(markerPath(root), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

export const assertFreshAiContext = async (root = aiContextRoot()): Promise<void> => {
  if (await readContextInvalidation(root) !== undefined) throw new Error("Contexto de IA invalidado por remoção local. Execute context build completo antes de consultar.");
};

export const invalidateAiContext = async (root = aiContextRoot()): Promise<"invalidated" | "not-found" | "failed"> => {
  const temporary = join(root, `.invalidate-${randomUUID()}.tmp`);
  try {
    const stat = await fs.lstat(root).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (!stat) return "not-found";
    if (!stat.isDirectory() || stat.isSymbolicLink()) return "failed";
    const lease = await leaseFor(root);
    try {
      await fs.writeFile(temporary, JSON.stringify({ version: 1, token: randomUUID(), invalidatedAt: new Date().toISOString(), reason: "local-deletion" }), { mode: 0o600, flag: "wx" });
      await fs.rename(temporary, markerPath(root));
    } finally { await lease.release(); }
    return "invalidated";
  } catch {
    return "failed";
  } finally { await fs.rm(temporary, { force: true }).catch(() => undefined); }
};

export const clearContextInvalidation = async (root: string, before: string | undefined): Promise<void> => {
  // A deletion concurrent with rebuilding must remain invalidated.
  if (before === undefined) return;
  const lease = await leaseFor(root);
  try {
    if (await readContextInvalidation(root) === before) await fs.unlink(markerPath(root));
  } finally { await lease.release(); }
};
