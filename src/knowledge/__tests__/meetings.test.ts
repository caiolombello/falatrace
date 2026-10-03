import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { searchMeetings, readMeetingContext } from "../meetings";

const roots: string[] = [];
const oldState = process.env.XDG_STATE_HOME;

const fixture = async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "recording-cli-meetings-test-"));
  roots.push(root);
  process.env.XDG_STATE_HOME = join(root, "state");
  const sourcePath = join(root, "meeting.mkv");
  const id = "3e3b529e-5c22-4802-97b8-f3e1a52c1919";
  const artifactDir = join(root, "meeting.recording", id);
  await fs.mkdir(artifactDir, { recursive: true });
  await fs.writeFile(sourcePath, "media");
  await fs.mkdir(join(root, "state", "recording-cli", "jobs"), { recursive: true });
  await fs.mkdir(join(root, "state", "recording-cli", "timesheet"), { recursive: true });
  await fs.writeFile(join(root, "state", "recording-cli", "timesheet-context.json"), JSON.stringify({
    version: 1, colleagues: [], clients: [{ code: "CL008", name: "Example Vet", aliases: ["example"], responsibleNames: [] }], taskTypes: []
  }));
  const job = {
    version: 1, id, createdAt: "2026-09-02T18:59:31.000Z", updatedAt: "2026-09-02T19:10:00.000Z",
    source: { originalName: "meeting.mkv", mediaFile: "source.mkv", size: 5, sha256: "a".repeat(64) },
    transcription: { provider: "openai", model: "gpt-transcribe", language: "pt" },
    summary: { provider: "openai", model: "gpt-4o-mini" }, sourcePath, artifactDir, target: "local", state: "completed"
  };
  await fs.writeFile(join(root, "state", "recording-cli", "jobs", `${id}.json`), JSON.stringify(job));
  await fs.writeFile(join(artifactDir, "summary.json"), JSON.stringify({
    version: 1, provider: "openai", model: "gpt-4o-mini", title: "Reunião de Atendimento Normal e Permissões - O que deu errado?",
    overview: "Revisão de permissões. contato@example.com", topics: ["Permissões"], decisions: [], actionItems: []
  }));
  await fs.writeFile(join(artifactDir, "transcript.json"), JSON.stringify({
    version: 1, provider: "openai", model: "gpt-transcribe", language: "pt", text: "Falamos sobre permissões e acesso.",
    segments: [{ start: 10, end: 12, text: "Falamos sobre permissões e acesso.", speaker: "Pessoa 1" }]
  }));
  const config = structuredClone(DEFAULT_CONFIG);
  config.timesheet.contextPath = join(root, "state", "recording-cli", "timesheet-context.json");
  return { config, id, artifactDir, transcriptPath: join(artifactDir, "transcript.json") };
};

afterEach(async () => {
  if (oldState === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = oldState;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("on-demand meeting retrieval", () => {
  test("filters by title terms and returns bounded canonical excerpts with redaction", async () => {
    const { config, id } = await fixture();
    const found = await searchMeetings(config, { query: "permissões", limit: 5 });
    expect(found.items).toHaveLength(1);
    expect(found.items[0].jobId).toBe(id);
    const context = await readMeetingContext(config, id, { query: "permissões", maxCharacters: 4_096 });
    expect(context.trust).toBe("untrusted-meeting-data");
    expect(context.excerpts[0].timing).toBe("block");
    expect(JSON.stringify(context)).not.toContain("contato@example.com");
    expect(context.budget.characters).toBeLessThanOrEqual(4_096);
  });

  test("revalidates artifacts and rejects a deleted transcript", async () => {
    const { config, id, artifactDir } = await fixture();
    await fs.rm(join(artifactDir, "transcript.json"));
    await expect(readMeetingContext(config, id)).rejects.toThrow();
  });

  test("does not follow a symlinked artifact", async () => {
    const { config, id, artifactDir } = await fixture();
    const transcriptPath = join(artifactDir, "transcript.json");
    await fs.rm(transcriptPath);
    await fs.symlink(join(artifactDir, "summary.json"), transcriptPath);
    await expect(readMeetingContext(config, id)).rejects.toThrow(/symbolic link/i);
  });

  test("keeps monotonic offsets for repeated segment text and marks GPT blocks", async () => {
    const { config, id, transcriptPath } = await fixture();
    await fs.writeFile(transcriptPath, JSON.stringify({
      version: 1, provider: "openai", model: "gpt-transcribe", language: "pt",
      text: "repetido repetido", segments: [
        { start: 0, end: 1, text: "repetido" }, { start: 2, end: 3, text: "repetido" }
      ]
    }));
    const result = await readMeetingContext(config, id);
    expect(result.excerpts.map((item) => item.charOffset)).toEqual([{ start: 0, end: 17 }]);
    expect(result.excerpts.every((item) => item.timing === "block")).toBe(true);
  });

  test("rejects unsafe budgets and paginates by global character offset", async () => {
    const { config, id } = await fixture();
    await expect(readMeetingContext(config, id, { maxCharacters: 2_000 })).rejects.toThrow(/entre 4096 e 24000/);
    const first = await readMeetingContext(config, id, { maxCharacters: 4_096 });
    expect(first.budget.nextOffset).toBeUndefined();
    const next = await readMeetingContext(config, id, { offset: first.excerpts[0].charOffset.end });
    expect(next.excerpts).toHaveLength(0);
  });

  test("preserves unmatchable transcript tails, marks unknown timing, and stays strictly bounded", async () => {
    const { config, id, transcriptPath } = await fixture();
    const text = "início sem segmento. gap preservado. contato@example.com";
    await fs.writeFile(transcriptPath, JSON.stringify({
      version: 1, provider: "openai", model: "whisper-cpp", language: "pt", text, segments: []
    }));
    const result = await readMeetingContext(config, id, { maxCharacters: 4_096 });
    expect(result.excerpts[0].charOffset).toEqual({ start: 0, end: text.length });
    expect(result.excerpts[0].timing).toBe("none");
    expect(result.excerpts[0].redacted).toBe(true);
    expect(result.excerpts[0].originalTextSha256).not.toBe(result.excerpts[0].textSha256);
    expect(JSON.stringify(result).length).toBe(result.budget.characters);
    expect(result.budget.characters).toBeLessThanOrEqual(4_096);
    await expect(readMeetingContext(config, id, { offset: Number.NaN })).rejects.toThrow(/offset/);
  });

  test("paginates long canonical content and redaction without gaps or inconsistent hashes", async () => {
    const { config, id, transcriptPath } = await fixture();
    const text = ("Gap contato@example.com decisão sobre acesso. ").repeat(260) + "CAUDA final sem segmento";
    const hash = (text: string) => createHash("sha256").update(text).digest("hex");
    await fs.writeFile(transcriptPath, JSON.stringify({ version: 1, provider: "openai", model: "unknown", language: "pt", text,
      segments: [{ start: 0, end: 10, text: "não é igual" }, { start: 15, end: 15, text: "Gap" }] }));
    let offset = 0;
    let pages = 0;
    do {
      const page = await readMeetingContext(config, id, { offset, maxCharacters: 4096 });
      expect(page.startOffset).toBe(offset);
      expect(page.budget.characters).toBe(JSON.stringify(page).length);
      expect(page.budget.characters).toBeLessThanOrEqual(4096);
      for (const item of page.excerpts) {
        expect(item.charOffset.start).toBe(offset);
        offset = item.charOffset.end;
        expect(item.originalTextSha256).toBe(hash(text.slice(item.charOffset.start, offset)));
        expect(item.textSha256).toBe(hash(item.text));
        expect(item.timing).toBe("block");
        expect(item.timestamps).toBeUndefined();
      }
      pages += 1;
      if (!page.budget.truncated) break;
      expect(page.budget.nextOffset).toBe(offset);
      if (pages > 60) throw new Error("Pagination failed to advance");
    } while (true);
    expect(pages).toBeGreaterThan(1);
    expect(offset).toBe(text.length);
  });

  test("focuses on query terms and validates direct API limits", async () => {
    const { config, id, transcriptPath } = await fixture();
    const text = "introdução ".repeat(700) + "permissões finais para atendimento";
    await fs.writeFile(transcriptPath, JSON.stringify({ version: 1, provider: "openai", model: "unknown", language: "pt", text, segments: [{ start: 0, end: 100, text }] }));
    const focused = await readMeetingContext(config, id, { query: "permissões", maxCharacters: 4096 });
    expect(focused.startOffset).toBeGreaterThan(5000);
    expect(focused.excerpts.some((item) => item.text.includes("permissões"))).toBe(true);
    expect(focused.excerpts.every((item) => item.timing === "block")).toBe(true);
    await expect(searchMeetings(config, { limit: NaN })).rejects.toThrow("limit");
    await expect(searchMeetings(config, { query: "a".repeat(1001) })).rejects.toThrow("query");
  });
});
