import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { OPEN_REQUEST_ERRORS } from "../../desktop/open-request";
import { NOTIFY_ERRORS } from "../../notify/actions";
import { CLI_MESSAGES } from "../shared";

// Spawned commands in an isolated HOME/XDG root, as a user or agent runs them. Nothing here reaches
// the network: the configured assistant is an external API, and every question stops at consent.
test("new command families keep their output contracts in a synthetic installation", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "falatrace-cli-features-"));
  const id = "11111111-1111-4111-8111-111111111111";
  const env = { ...process.env, HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"), XDG_DATA_HOME: join(root, "data"), NO_COLOR: "1" };
  const run = async (args: string[], stdin?: string) => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "../index.ts"), ...args], {
      env, stdin: stdin === undefined ? "ignore" : new Blob([stdin]), stdout: "pipe", stderr: "pipe"
    });
    const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(out).not.toContain("\u001b");
    expect(err).not.toContain("\u001b");
    return { code, out, err };
  };
  try {
    for (const path of [env.HOME, join(env.XDG_CONFIG_HOME, "recording-cli"), join(env.XDG_STATE_HOME, "recording-cli/jobs"), env.XDG_DATA_HOME]) await fs.mkdir(path, { recursive: true, mode: 0o700 });
    const config = structuredClone(DEFAULT_CONFIG);
    config.timesheet.contextPath = join(root, "timesheet-context.json");
    config.assistant.provider = "api";
    config.assistant.apiPreset = "openrouter";
    await fs.writeFile(join(env.XDG_CONFIG_HOME, "recording-cli/config.json"), JSON.stringify(config), { mode: 0o600 });
    const sourcePath = join(root, "synthetic.mkv");
    await fs.writeFile(sourcePath, "media");
    const artifactDir = join(root, "synthetic.recording", id);
    await fs.mkdir(artifactDir, { recursive: true, mode: 0o700 });
    const job = {
      version: 1, id, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", source: { originalName: "synthetic.mkv", mediaFile: "source.mkv", size: 5, sha256: "a".repeat(64) },
      transcription: { provider: "whisper-cpp", model: "synthetic", language: "en" }, summary: { provider: "ollama", model: "synthetic" }, sourcePath, artifactDir, target: "local", state: "completed"
    };
    await fs.writeFile(join(env.XDG_STATE_HOME, "recording-cli/jobs", `${id}.json`), JSON.stringify(job));
    await fs.writeFile(join(artifactDir, "summary.json"), JSON.stringify({ version: 1, provider: "ollama", model: "synthetic", title: "Synthetic chart", overview: "Synthetic decision.", topics: [], decisions: [], actionItems: [] }));
    await fs.writeFile(join(artifactDir, "transcript.json"), JSON.stringify({ version: 1, provider: "whisper-cpp", model: "whisper-cpp", language: "en", text: "Synthetic chart decision.", segments: [{ start: 10, end: 12, text: "Synthetic chart decision." }] }));

    const help = await run(["help"]);
    expect(help.code).toBe(0); expect(help.err).toBe("");
    for (const text of ["FalaTrace", "context meeting", "calls pause", "Perguntar", "Compartilhar", "Avançado/legado"]) expect(help.out).toContain(text);
    const details = await run(["help", "ask"]);
    expect(details.code).toBe(0); expect(details.out).toContain("--yes"); expect(details.out).not.toContain("Gravar\n");

    const templates = await run(["templates", "list"]);
    expect(templates.code).toBe(0); expect(templates.err).toBe("");
    expect(JSON.parse(templates.out).templates.map((item: { id: string }) => item.id)).toContain("general");

    // Notes typed after the meeting: stdin in, saved text out, private file under XDG_DATA_HOME.
    const edited = await run(["notes", "edit", id], "# Pauta\n- gráfico sintético\n\n");
    expect(edited).toEqual({ code: 0, out: "# Pauta\n- gráfico sintético\n", err: "" });
    expect((await run(["notes", "show", id])).out).toBe("# Pauta\n- gráfico sintético\n");
    const path = (await run(["notes", "path", id])).out.trim();
    expect(path).toBe(join(env.XDG_DATA_HOME, "recording-cli/notes", `${id}.json`));
    expect((await fs.stat(path)).mode & 0o777).toBe(0o600);

    const media = await run(["media", "status", id]);
    expect(media.code).toBe(0); expect(JSON.parse(media.out)).toMatchObject({ jobId: id, state: "present" });

    const reminders = await run(["reminders", "status"]);
    expect(reminders.code).toBe(0); expect(JSON.parse(reminders.out)).toMatchObject({ mode: "auto", calendars: [] });

    // Questions to an external destination stop after showing it, before anything is sent.
    const ask = await run(["ask", "--meeting", id, "what was decided?"]);
    expect(ask.code).toBe(1); expect(ask.out).toBe("");
    expect(ask.err).toContain("Destino: OpenRouter");
    expect(ask.err).toContain(CLI_MESSAGES.consentRequired);

    const search = await run(["library", "search", "Synthetic chart", "--limit", "3"]);
    expect(search.code).toBe(0);
    const found = JSON.parse(search.out);
    expect(found.trust).toBe("untrusted-meeting-data");
    expect(found.items[0].jobId).toBe(id);

    const invalidLink = await run(["studio", "open", "https://example.com/x"]);
    expect(invalidLink).toEqual({ code: 1, out: "", err: `${OPEN_REQUEST_ERRORS.invalidUri}\n` });
    const invalidNotify = await run(["notify", "ready", "--job", "../x"]);
    expect(invalidNotify).toEqual({ code: 1, out: "", err: `${NOTIFY_ERRORS.invalidCommand}\n` });
    const missing = await run(["notes"]);
    expect(missing.code).toBe(1); expect(missing.out).toBe(""); expect(missing.err).toContain("notes show|edit|path");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}, 60_000);
