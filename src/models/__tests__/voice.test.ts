import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { VOICE_PACKAGE, downloadVoicePackage, readTarMembers, readVoiceInstallation, voiceModelPath, voiceRuntimeDir } from "../voice";

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

/** A minimal ustar member, as npm pack writes them. */
const tarEntry = (name: string, data: Buffer, type = "0"): Buffer => {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100);
  header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
  header.write(type, 156);
  header.write("ustar\0", 257);
  return Buffer.concat([header, data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
};
const archive = (...entries: Buffer[]) => gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));

const withDir = async (run: (dir: string) => Promise<void>) => {
  const dir = await fs.mkdtemp(join(tmpdir(), "falatrace-voice-"));
  try { await run(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
};

const files = {
  "sherpa-onnx.node": Buffer.from("synthetic addon ".repeat(64)),
  "libsherpa-onnx-c-api.so": Buffer.from("synthetic c api ".repeat(64)),
  "libonnxruntime.so": Buffer.from("synthetic onnx runtime ".repeat(64))
};
const model = Buffer.from("synthetic speaker embedding model ".repeat(512));

/** Swap the pins for a synthetic archive and model with their real hashes, and serve them by URL. */
const withSyntheticPackage = async (tarball: Buffer, run: (fetch: typeof globalThis.fetch, seen: string[]) => Promise<void>) => {
  const original = structuredClone(VOICE_PACKAGE);
  Object.assign(VOICE_PACKAGE.runtime, {
    bytes: tarball.length, sha256: sha256(tarball),
    files: Object.entries(files).map(([name, data]) => ({ name, bytes: data.length, sha256: sha256(data) }))
  });
  Object.assign(VOICE_PACKAGE.model, { bytes: model.length, sha256: sha256(model) });
  const seen: string[] = [];
  const bodies = new Map([[VOICE_PACKAGE.runtime.url, tarball], [VOICE_PACKAGE.model.url, model]]);
  const fetch = (async (input: RequestInfo | URL) => {
    seen.push(String(input));
    const body = bodies.get(String(input));
    const response = new Response(body ? new Uint8Array(body) : null, { status: body ? 200 : 404 });
    Object.defineProperty(response, "url", { value: String(input) });
    return response;
  }) as typeof globalThis.fetch;
  try { await run(fetch, seen); } finally { Object.assign(VOICE_PACKAGE.runtime, original.runtime); Object.assign(VOICE_PACKAGE.model, original.model); }
};

const fullArchive = () => archive(
  tarEntry("package/package.json", Buffer.from("{}")),
  ...Object.entries(files).map(([name, data]) => tarEntry(`package/${name}`, data)),
  tarEntry("package/libsherpa-onnx-cxx-api.so", Buffer.from("not needed"))
);

test("reads only the expected regular files of an npm archive and refuses damage", () => {
  const tar = Buffer.concat([
    tarEntry("package/sherpa-onnx.node", Buffer.from("addon")),
    tarEntry("package/libonnxruntime.so", Buffer.from("target"), "2"),
    tarEntry("package/README.md", Buffer.from("readme")),
    Buffer.alloc(1024)
  ]);
  const members = readTarMembers(tar, new Set(["package/sherpa-onnx.node", "package/libonnxruntime.so"]));
  // The symlink is never extracted, and unrequested files are ignored.
  expect([...members.keys()]).toEqual(["package/sherpa-onnx.node"]);
  expect(members.get("package/sherpa-onnx.node")!.toString()).toBe("addon");
  // Cut inside the data of a member: its declared size runs past the end.
  const large = Buffer.concat([tarEntry("package/sherpa-onnx.node", Buffer.alloc(1000, 1)), Buffer.alloc(1024)]);
  expect(() => readTarMembers(large.subarray(0, 700), new Set(["package/sherpa-onnx.node"]))).toThrow("corrompido");
  const twice = Buffer.concat([tarEntry("package/a", Buffer.from("1")), tarEntry("package/a", Buffer.from("2")), Buffer.alloc(1024)]);
  expect(() => readTarMembers(twice, new Set(["package/a"]))).toThrow("repete");
});

test("installs the runtime and the model only after every size and SHA-256 matches, and records their identity", async () => withDir(async (dir) => {
  await withSyntheticPackage(fullArchive(), async (fetch, seen) => {
    const progress: number[] = [];
    const installation = await downloadVoicePackage({ fetch, directory: dir, onProgress: (received) => { progress.push(received); } });
    expect(installation).toEqual({ runtimeDir: voiceRuntimeDir(dir), modelPath: voiceModelPath(dir), modelSha256: VOICE_PACKAGE.model.sha256 });
    expect(seen).toEqual([VOICE_PACKAGE.runtime.url, VOICE_PACKAGE.model.url]);
    expect(progress[progress.length - 1]).toBe(VOICE_PACKAGE.runtime.bytes + VOICE_PACKAGE.model.bytes);
    expect((await fs.readdir(voiceRuntimeDir(dir))).sort()).toEqual(["libonnxruntime.so", "libsherpa-onnx-c-api.so", "sherpa-onnx.node"]);
    for (const [name, data] of Object.entries(files)) expect(await fs.readFile(join(voiceRuntimeDir(dir), name))).toEqual(data);
    expect((await fs.stat(voiceRuntimeDir(dir))).mode & 0o777).toBe(0o700);
    expect(await readVoiceInstallation(dir)).toEqual(installation);
    // A rewritten runtime file no longer counts as installed, even with the same size.
    await fs.writeFile(join(voiceRuntimeDir(dir), "sherpa-onnx.node"), files["sherpa-onnx.node"]);
    expect(await readVoiceInstallation(dir)).toBeUndefined();
    // Downloading again checks what is there by SHA-256 and reuses it without fetching.
    seen.length = 0;
    await downloadVoicePackage({ fetch, directory: dir, onProgress: () => undefined });
    expect(seen).toEqual([]);
    expect(await readVoiceInstallation(dir)).toEqual(installation);
  });
}));

test("a damaged archive or model installs nothing, and a different file already there is preserved", async () => withDir(async (dir) => {
  const missing = archive(tarEntry("package/sherpa-onnx.node", files["sherpa-onnx.node"]));
  await withSyntheticPackage(missing, async (fetch) => {
    await expect(downloadVoicePackage({ fetch, directory: dir, onProgress: () => undefined })).rejects.toThrow("não contém os arquivos esperados");
    expect((await fs.readdir(dir)).filter((name) => !name.startsWith("."))).toEqual([]);
  });
  await withSyntheticPackage(fullArchive(), async (fetch) => {
    Object.assign(VOICE_PACKAGE.model, { sha256: "0".repeat(64) });
    await expect(downloadVoicePackage({ fetch, directory: dir, onProgress: () => undefined })).rejects.toThrow("não confere");
    expect(await fs.readdir(dir)).toEqual([`runtime-${VOICE_PACKAGE.runtime.version}`]);
    expect(await readVoiceInstallation(dir)).toBeUndefined();
  });
  await fs.writeFile(voiceModelPath(dir), "someone else's file");
  await withSyntheticPackage(fullArchive(), async (fetch) => {
    await expect(downloadVoicePackage({ fetch, directory: dir, onProgress: () => undefined })).rejects.toThrow("preservado");
    expect(await fs.readFile(voiceModelPath(dir), "utf8")).toBe("someone else's file");
  });
}));
