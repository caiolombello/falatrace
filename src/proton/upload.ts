import { promises as fs } from "node:fs";
import { basename, isAbsolute } from "node:path";
import type { AppConfig } from "../config/defaults";
import { runCommand } from "../jobs/command";

const PROTON_TRANSFER_TIMEOUT_MS = 12 * 60 * 60 * 1000;

type ProtonName = {
  ok?: boolean;
  value?: string;
};

export type ProtonRemoteItem = {
  type?: string;
  name?: ProtonName | string;
  totalStorageSize?: number;
  activeRevision?: {
    ok?: boolean;
    claimedSize?: number;
    storageSize?: number;
    value?: {
      claimedSize?: number;
      storageSize?: number;
    };
  };
};

type ProtonTransferSummary = {
  failedItems?: number;
  transferredItems?: number;
  skippedItems?: number;
  transferredBytes?: number;
  failures?: unknown[];
};

export type UploadResult = {
  success: boolean;
  message?: string;
};

const parseJson = <T>(raw: string, operation: string): T => {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`Proton Drive returned invalid JSON for ${operation}`);
  }
};

export const protonItemName = (item: ProtonRemoteItem): string | undefined =>
  typeof item.name === "string"
    ? item.name
    : item.name?.ok === false
      ? undefined
      : item.name?.value;

export const protonItemSize = (item: ProtonRemoteItem): number | undefined => {
  if (item.activeRevision?.ok === false) return undefined;
  const size = item.activeRevision?.claimedSize ?? item.activeRevision?.value?.claimedSize;
  return Number.isSafeInteger(size) && Number(size) >= 0 ? size : undefined;
};

const transferFailureCount = (summary: ProtonTransferSummary): number =>
  Math.max(summary.failedItems || 0, summary.failures?.length || 0);

const hasUnsafeRemoteComponent = (path: string): boolean =>
  path.split("/").some((component) => component === "." || component === "..");

const assertRemotePath = (path: string): void => {
  if (
    !path.startsWith("/my-files/") ||
    /[\r\n\0]/.test(path) ||
    hasUnsafeRemoteComponent(path)
  ) {
    throw new Error("Proton Drive path must be below /my-files");
  }
};

const assertRemoteFolder = (path: string): void => {
  if (
    (path !== "/my-files" && !path.startsWith("/my-files/")) ||
    /[\r\n\0]/.test(path) ||
    hasUnsafeRemoteComponent(path)
  ) {
    throw new Error("Proton Drive folder must be below /my-files");
  }
};

export const executeProtonCommand = async (
  args: string[],
  timeoutMs?: number,
  run: typeof runCommand = runCommand
): Promise<string> => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const result = await run("proton-drive", [...args, "-j"], { timeoutMs });
      return result.stdout;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Secret Service can reject a generated session key before any filesystem action.
      // Only that pre-operation failure is safe to retry with a fresh CLI process.
      const rejectedKey = message.includes("Failed to load session from secrets") &&
        message.includes("Client public key size is invalid (code: 16)");
      const missingSession = /^proton-drive failed with code 1:\s*You need to login first\s*$/.test(message);
      if (attempt >= 2 || (!rejectedKey && !missingSession)) throw error;
      await new Promise((done) => setTimeout(done, 250 * (attempt + 1)));
    }
  }
};

export class ProtonDriveClient {
  constructor(
    private readonly execute: (
      args: string[],
      timeoutMs?: number
    ) => Promise<string> = executeProtonCommand
  ) {}

  async list(path: string): Promise<ProtonRemoteItem[]> {
    return parseJson<ProtonRemoteItem[]>(
      await this.execute(["filesystem", "list", path]),
      `list ${path}`
    );
  }

  async createFolder(parentPath: string, name: string): Promise<void> {
    await this.execute(["filesystem", "create-folder", parentPath, name]);
  }

  async ensureFolder(path: string): Promise<void> {
    if (!path.startsWith("/my-files")) {
      throw new Error("Proton Drive folder must be below /my-files");
    }
    const components = path.split("/").filter(Boolean);
    let parent = `/${components.shift()}`;
    for (const component of components) {
      const children = await this.list(parent);
      const existing = children.find(
        (item) => protonItemName(item) === component
      );
      if (existing && existing.type !== "folder") {
        throw new Error(`Proton Drive path is not a folder: ${parent}/${component}`);
      }
      if (!existing) {
        await this.createFolder(parent, component);
      }
      parent = `${parent}/${component}`;
    }
  }

  async upload(localPaths: string[], parentPath: string): Promise<void> {
    if (localPaths.length === 0) return;
    const summary = parseJson<ProtonTransferSummary>(
      await this.execute(
        [
          "filesystem",
          "upload",
          "--file-conflict-strategy",
          "replace",
          ...localPaths,
          parentPath
        ],
        PROTON_TRANSFER_TIMEOUT_MS
      ),
      `upload to ${parentPath}`
    );
    const failureCount = transferFailureCount(summary);
    if (failureCount > 0) {
      throw new Error(
        `Proton Drive reported ${failureCount} upload failure(s)`
      );
    }
  }

  async uploadImmutable(localPaths: string[], parentPath: string): Promise<void> {
    if (localPaths.length === 0) return;
    assertRemoteFolder(parentPath);
    const summary = parseJson<ProtonTransferSummary>(
      await this.execute(
        [
          "filesystem",
          "upload",
          "--file-conflict-strategy",
          "skip",
          ...localPaths,
          parentPath
        ],
        PROTON_TRANSFER_TIMEOUT_MS
      ),
      `immutable upload to ${parentPath}`
    );
    const failureCount = transferFailureCount(summary);
    if (failureCount > 0) {
      throw new Error(
        `Proton Drive reported ${failureCount} immutable upload failure(s)`
      );
    }
  }

  async download(remotePaths: string[], localFolder: string): Promise<void> {
    if (remotePaths.length === 0) return;
    if (remotePaths.length > 10) {
      throw new Error("Proton Drive download accepts at most 10 paths");
    }
    if (new Set(remotePaths).size !== remotePaths.length) {
      throw new Error("Proton Drive download paths must be unique");
    }
    for (const path of remotePaths) assertRemotePath(path);
    if (!isAbsolute(localFolder)) {
      throw new Error("Proton Drive download target must be an absolute private directory");
    }
    const target = await fs.lstat(localFolder);
    if (!target.isDirectory() || target.isSymbolicLink() || (target.mode & 0o077) !== 0) {
      throw new Error("Proton Drive download target must be a private directory");
    }
    const summary = parseJson<ProtonTransferSummary>(
      await this.execute(
        [
          "filesystem",
          "download",
          "--file-conflict-strategy",
          "skip",
          ...remotePaths,
          localFolder
        ],
        PROTON_TRANSFER_TIMEOUT_MS
      ),
      `download to private directory`
    );
    const failureCount = transferFailureCount(summary);
    if (failureCount > 0) {
      throw new Error(
        `Proton Drive reported ${failureCount} download failure(s)`
      );
    }
  }
}

export const uploadToProtonDrive = async (
  config: AppConfig,
  localPath: string
): Promise<UploadResult> => {
  if (!config.proton.enabled) {
    return { success: false, message: "Proton Drive upload is disabled" };
  }

  try {
    const client = new ProtonDriveClient();
    await client.ensureFolder(config.proton.targetFolder);
    await client.upload([localPath], config.proton.targetFolder);
    return {
      success: true,
      message: `${basename(localPath)} uploaded; local file preserved`
    };
  } catch (err) {
    return {
      success: false,
      message: err instanceof Error ? err.message : String(err)
    };
  }
};
