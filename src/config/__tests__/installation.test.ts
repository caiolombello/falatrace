import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_CONFIG } from "../defaults";
import { validateConfig } from "../load";

const init = async (home: string, xdg = join(home,".config")) => {
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../cli/index.ts"), "init"], {
    env: { HOME: home, PATH: process.env.PATH, XDG_CONFIG_HOME: xdg },
    stdout: "pipe", stderr: "pipe"
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
};

test("fresh init is private, local, nonbillable by default and does not overwrite existing configuration", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "recording-install-"));
  try {
    expect((await init(root)).code).toBe(0);
    const path = join(root, ".config/recording-cli/config.json");
    const config = JSON.parse(await fs.readFile(path, "utf8"));
    validateConfig(config);
    expect(config.processing.defaultTarget).toBe("local");
    expect(config.processing.autoEnqueue).toBe(false);
    expect(config.transcription.provider).toBe("whisper-cpp");
    expect(config.summary.provider).toBe("ollama");
    expect(config.callDetection.enabled).toBe(false);
    expect((await fs.stat(path)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(join(root, ".config/recording-cli"))).mode & 0o777).toBe(0o700);
    const existing = JSON.stringify({ ...config, unknownOption: "preserve", remote: { ...config.remote, host: "selected.example.invalid" } });
    await fs.writeFile(path, existing);
    const repeated = await init(root);
    expect(repeated.code).toBe(0);
    expect(repeated.stdout).toContain("preservada");
    expect(await fs.readFile(path, "utf8")).toBe(existing);
    await fs.writeFile(path, "invalid existing JSON");
    expect((await init(root)).code).not.toBe(0);
    expect(await fs.readFile(path, "utf8")).toBe("invalid existing JSON");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("concurrent fresh initializations publish a complete config without leftover staging files", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "recording-init-race-"));
  try {
    const results = await Promise.all([init(root), init(root), init(root)]);
    expect(results.every((result) => result.code === 0)).toBe(true);
    const configDir = join(root, ".config/recording-cli");
    expect(await fs.readdir(configDir)).toEqual(["config.json"]);
    validateConfig(JSON.parse(await fs.readFile(join(configDir, "config.json"), "utf8")));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("init refuses a config directory symlink without changing its target", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "recording-init-link-"));
  try {
    const target = join(root, "target"); await fs.mkdir(target, { mode: 0o755 });
    await fs.chmod(target, 0o755);
    await fs.mkdir(join(root, ".config"));
    await fs.symlink(target, join(root, ".config/recording-cli"));
    expect((await init(root)).code).not.toBe(0);
    expect(await fs.readdir(target)).toEqual([]);
    expect((await fs.stat(target)).mode & 0o777).toBe(0o755);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("explicit existing provider and remote selections remain valid when defaults change", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.processing.autoEnqueue = true; config.processing.defaultTarget = "remote";
  config.remote.host = "chosen-worker.example.invalid"; config.summary.provider = "openai";
  expect(() => validateConfig(config)).not.toThrow();
});

test("install and uninstall affect only the CLI executable and never remove configuration or recordings", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "recording-uninstall-"));
  const repository = resolve(import.meta.dir, "../../..");
  const runMake = async (args: string[]) => {
    const child = Bun.spawn(["make", "-C", repository, ...args], {
      env: { HOME: root, PATH: process.env.PATH }, stdout: "pipe", stderr: "pipe"
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe(""); expect(code).toBe(0); return stdout;
  };
  try {
    const prefix = join(root, "prefix with space"); const dist = join(root, "dist");
    await fs.mkdir(dist); await fs.writeFile(join(dist, "falatrace"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const sentinels = [".config/recording-cli/config.json", "Videos/Recordings/synthetic.mkv", ".local/state/recording-cli/jobs/fixture.json"];
    for (const relative of sentinels) {
      const path = join(root, relative); await fs.mkdir(join(path, ".."), { recursive: true }); await fs.writeFile(path, "preserve");
    }
    const dry = await runMake(["-n", "install"]);
    expect(dry).not.toContain("sudo"); expect(dry).not.toContain("apt-get");
    await runMake(["install-cli", "-o", "build-standalone", `DIST_DIR=${dist}`, `INSTALL_PREFIX=${prefix}`]);
    expect(await fs.readFile(join(prefix, "bin/falatrace"), "utf8")).toContain("#!/bin/sh");
    await runMake(["uninstall", `INSTALL_PREFIX=${prefix}`]);
    expect(await fs.stat(join(prefix, "bin/falatrace")).catch(() => null)).toBeNull();
    for (const relative of sentinels) expect(await fs.readFile(join(root, relative), "utf8")).toBe("preserve");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("explicit XDG config home is honored while existing legacy configuration is preserved",async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),"config-xdg-"));
 try {
  const home=join(root,"fresh-home"),xdg=join(root,"custom");await fs.mkdir(home);expect((await init(home,xdg)).code).toBe(0);expect((await fs.stat(join(xdg,"recording-cli/config.json"))).isFile()).toBe(true);expect(await fs.stat(join(home,".config/recording-cli/config.json")).catch(()=>null)).toBeNull();
  const legacyHome=join(root,"legacy-home");await fs.mkdir(legacyHome);expect((await init(legacyHome)).code).toBe(0);const legacy=join(legacyHome,".config/recording-cli/config.json");const before=await fs.readFile(legacy,"utf8");const newXdg=join(root,"new-xdg");expect((await init(legacyHome,newXdg)).stdout).toContain("preservada");expect(await fs.readFile(legacy,"utf8")).toBe(before);expect(await fs.stat(join(newXdg,"recording-cli/config.json")).catch(()=>null)).toBeNull();
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test("an unknown recording backend or Studio language is refused when the config loads", () => {
  const backend = structuredClone(DEFAULT_CONFIG) as unknown as Record<string, unknown>;
  backend.backend = "screen-magic";
  expect(() => validateConfig(backend as never)).toThrow("backend must be one of");
  const language = structuredClone(DEFAULT_CONFIG);
  (language.studio as { language: string }).language = "fr";
  expect(() => validateConfig(language)).toThrow("studio.language must be auto, pt-BR or en");
  for (const value of ["audio", "gpu-screen-recorder", "obs", "simple"] as const) {
    expect(() => validateConfig({ ...structuredClone(DEFAULT_CONFIG), backend: value })).not.toThrow();
  }
});
