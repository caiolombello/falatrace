import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactDigest } from "../../jobs/transcript-access";
import { type JobRecord, type Transcript, validateSummary } from "../../jobs/types";
import { formatSummaryMarkdown, formatTranscriptMarkdown } from "../../jobs/format";
import { readReviewedView, saveRevision, withRevisionLease, type ReviewedView } from "../../revisions/index";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { readMeetingContext } from "../../knowledge/meetings";
import { buildSummaryEvidence, summaryEvidenceMatches, summaryTranscriptEvidenceSha256 } from "../../summary/evidence";
import { sourceTimingQuality } from "../../transcript/timing";
import { parsePlayerTranscript } from "../../player/transcript";
import { previewExport, saveExport, exportRoot } from "../index";
import { snapshotReviewedView, canonicalJson, digest } from "../snapshot";
import { renderExport } from "../format";
import { subtitleTimestamp } from "../subtitles";

const id = "11111111-1111-4111-8111-111111111111";
const sourceTranscript = (): Transcript => ({ version: 1, provider: "whisper-cpp", model: "/models/synthetic.bin", language: "pt",
  text: "Introdução sem tempo.\nOlá 😀\nSegunda linha. Cauda sem tempo.", segments: [
    { start: 4.5, end: 6, text: "Segunda linha." }, { start: 1.2, end: 3.4, text: "Olá 😀" }
  ] });
const job = (): JobRecord => ({ version: 1, id, createdAt: "2026-10-03T00:00:00.000Z", updatedAt: "2026-10-03T00:00:00.000Z",
  source: { originalName: "synthetic.mkv", mediaFile: "source.mkv", size: 5, sha256: "a".repeat(64) },
  transcription: { provider: "whisper-cpp", model: "/models/synthetic.bin", language: "pt" },
  summary: { provider: "openai", model: "synthetic-summary" }, sourcePath: "/tmp/synthetic.mkv", artifactDir: "/tmp/synthetic.recording/" + id, target: "local", state: "completed" });
const summary = () => ({ version: 1, provider: "openai", model: "synthetic-summary", title: "Sintético", overview: "Resumo sintético", topics: [], decisions: [], actionItems: [] });
const view = (transcript = sourceTranscript()): ReviewedView => {
  const raw = JSON.stringify(transcript), hash = artifactDigest(raw);
  return { original: { raw, path: "/tmp/transcript.json", transcript, provenance: { origin: "published", receipt: "legacy-unverified", mediaSha256: "a".repeat(64), transcriptSha256: hash } },
    transcript: structuredClone(transcript), segments: transcript.segments.map((segment, index) => ({ ...segment, id: "s" + String(index).padStart(6, "0"), canonicalId: id + ":" + hash + ":s" + String(index).padStart(6, "0"),
      originalText: segment.text, speakerId: segment.speaker, humanEdited: false, humanSpeakerEdited: false })),
    revision: { version: 1, revision: 0, humanReviewed: false, base: { jobId: id, mediaSha256: "a".repeat(64), transcriptArtifactSha256: hash } }, notes: [], derivedStale: false, canUndo: false };
};
const diarized = (): ReviewedView => {
  const result = view();
  const turns = [{ start: 1, end: 3, text: "Próprio 😀\nTexto simultâneo", speaker: "S01" }, { start: 2, end: 4, text: "Resposta & <literal> -->", speaker: "S02" }];
  const original = { version: 1 as const, jobId: id, mediaSha256: "a".repeat(64), transcriptSha256: digest(result.original.transcript.text), provider: "openai" as const, model: "gpt-4o-transcribe-diarize",
    generatedAt: "2026-10-03T00:00:00.000Z", duration: 5, labels: { S01: "Pessoa A", S02: "Pessoa B" }, acousticValidation: "pending" as const, turns,
    alignment: { text: result.original.transcript.text, matchedTokenRatio: 0, unassignedTokenCount: 10, segments: [{ start: 0, end: 5, charStart: 0, charEnd: result.original.transcript.text.length, text: result.original.transcript.text, reviewRequired: true }] } };
  result.diarization = { original, labels: { ...original.labels }, turns: turns.map((turn, index) => ({ ...turn, id: "t" + String(index).padStart(6, "0"), label: original.labels[turn.speaker as "S01" | "S02"], humanSpeakerEdited: false })) };
  result.revision.base.diarizationSha256 = digest(JSON.stringify(original));
  return result;
};

async function fixture(action: (f: { root: string; job: JobRecord; transcriptPath: string }) => Promise<void>, transcript = sourceTranscript(), summaryValue: Record<string, unknown> = summary()) {
  const root = await fs.mkdtemp(join(tmpdir(), "g7-export-"));
  const before = { state: process.env.XDG_STATE_HOME, data: process.env.XDG_DATA_HOME };
  process.env.XDG_STATE_HOME = join(root, "state"); process.env.XDG_DATA_HOME = join(root, "data");
  try {
    const selected = { ...job(), sourcePath: join(root, "synthetic.mkv"), artifactDir: join(root, "synthetic.recording", id),
      transcription: { provider: transcript.provider, model: transcript.model, language: transcript.language } };
    const state = join(root, "state/recording-cli/jobs");
    await fs.mkdir(state, { recursive: true }); await fs.mkdir(selected.artifactDir, { recursive: true });
    await fs.writeFile(selected.sourcePath, "media");
    await fs.writeFile(join(state, id + ".json"), JSON.stringify(selected));
    const transcriptPath = join(selected.artifactDir, "transcript.json");
    await fs.writeFile(transcriptPath, JSON.stringify(transcript));
    await fs.writeFile(join(selected.artifactDir, "summary.json"), JSON.stringify(summaryValue));
    await action({ root, job: selected, transcriptPath });
  } finally {
    if (before.state === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = before.state;
    if (before.data === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = before.data;
    await fs.rm(root, { recursive: true, force: true });
  }
}
const readCues = (text: string): Array<{ start: number; end: number; text: string }> => {
  const milliseconds = (value: string) => { const fields = value.replace(",", ".").split(/[:.]/).map(Number); return fields[0] * 3600000 + fields[1] * 60000 + fields[2] * 1000 + fields[3]; };
  return text.split("\n\n").filter(block => /^\S+\n\d+:\d{2}:\d{2}[.,]\d{3} --> /.test(block)).map(block => {
    const lines = block.split("\n"), [start, end] = lines[1].split(" --> ");
    return { start: milliseconds(start), end: milliseconds(end), text: lines.slice(2).join("\n").replace(/\n$/, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&") };
  });
};

test("JSON and Markdown retain full source/selected text, original IDs, notes and limitations deterministically", () => {
  const selected = view();
  selected.transcript.text += "\nNota de texto " + String.fromCharCode(96).repeat(6);
  selected.notes.push("Nota humana sem tempo 😀");
  const snapshot = snapshotReviewedView(job(), selected, "transcript", { state: "ready", original: validateSummary({ ...summary(), limitations: ["Tempo parcial"] }, "openai", "synthetic-summary") });
  const json = renderExport(snapshot, "json"), markdown = renderExport(snapshot, "markdown");
  const parsed = JSON.parse(json.content);
  expect(parsed.original.transcript.text).toBe(selected.original.transcript.text);
  expect(parsed.reviewed.text).toBe(selected.transcript.text);
  expect(parsed.reviewed.segments.map((s: { id: string }) => s.id)).toEqual(["s000000", "s000001"]);
  for (const text of [selected.transcript.text, selected.original.transcript.text, selected.notes[0], "Tempo parcial"]) expect(markdown.content).toContain(text);
  expect(renderExport(snapshot, "json")).toEqual(json); expect(renderExport(snapshot, "markdown")).toEqual(markdown);
  expect(json.sha256).toBe(digest(json.content)); expect(json.snapshotSha256).toBe(digest(canonicalJson(snapshot)));
});

test("source arrays and mutable labels are frozen before output; cue order never reassigns source IDs", () => {
  const selected = diarized(), snapshot = snapshotReviewedView(job(), selected, "transcript");
  selected.diarization!.labels.S01 = "Nome alterado depois";
  selected.transcript.text = "Alteração após snapshot";
  const json = renderExport(snapshot, "json"), srt = renderExport(snapshot, "srt");
  expect(json.content).not.toContain("Nome alterado depois"); expect(json.content).not.toContain("Alteração após snapshot");
  expect(srt.cues.map(cue => cue.id)).toEqual(["s000001", "s000000"]);
  expect(snapshot.reviewed.segments.map(segment => segment.id)).toEqual(["s000000", "s000001"]);
});

test("SRT and VTT roundtrip overlapping own diarizer text, Unicode, literal markup and multiline payloads", () => {
  const snapshot = snapshotReviewedView(job(), diarized(), "diarization");
  const expected = [{ start: 1000, end: 3000, text: "Pessoa A: Próprio 😀\nTexto simultâneo" }, { start: 2000, end: 4000, text: "Pessoa B: Resposta & <literal> -->" }];
  for (const format of ["srt", "vtt"] as const) {
    const result = renderExport(snapshot, format);
    expect(readCues(result.content)).toEqual(expected);
    expect(result.content).not.toContain(snapshot.reviewed.text);
    expect(result.cues.map(cue => cue.id)).toEqual(["t000000", "t000001"]);
    expect(result.content.endsWith("\n")).toBe(true);
    expect(result.content.charCodeAt(0)).not.toBe(0xFEFF);
  }
});

test("canonical and acoustic speaker IDs stay separate unless a human explicitly assigns the acoustic speaker", () => {
  const selected = diarized();
  selected.segments[0].speakerId = "S01";
  const original = renderExport(snapshotReviewedView(job(), selected, "transcript"), "srt");
  expect(original.content).toContain("S01: Segunda linha."); expect(original.content).not.toContain("Pessoa A: Segunda linha.");
  selected.segments[0].humanSpeakerEdited = true;
  expect(renderExport(snapshotReviewedView(job(), selected, "transcript"), "srt").content).toContain("Pessoa A: Segunda linha.");
});

test("timestamp rounding carries minute/hour boundaries using integer milliseconds", () => {
  const selected = view({ ...sourceTranscript(), text: "Borda", segments: [{ start: 3599.9996, end: 3600.005, text: "Borda" }] });
  const output = renderExport(snapshotReviewedView(job(), selected, "transcript"), "srt");
  expect(output.content).toContain("01:00:00,000 --> 01:00:00,005");
  expect(subtitleTimestamp(60000, ".")).toBe("00:01:00.000");
});

for (const [start, end] of [[-1, 2], [2, 1], [1, 1], [NaN, 2], [0, Infinity], [1, 1.0001], [0, Number.MAX_SAFE_INTEGER]] as const) test("subtitle refuses invalid or collapsed interval " + start + "/" + end, () => {
  const snapshot = snapshotReviewedView(job(), view(), "transcript");
  snapshot.reviewed.segments[0].start = start; snapshot.reviewed.segments[0].end = end;
  expect(() => renderExport(snapshot, "srt")).toThrow(/s000000/);
});

test("unknown and approximate timing refuse subtitles, while edited text preserves original intervals only in JSON/Markdown", () => {
  for (const model of ["gpt-transcribe", "other-openai-text"]) {
    const selected = view({ ...sourceTranscript(), provider: "openai", model });
    const snapshot = snapshotReviewedView(job(), selected, "transcript");
    expect(() => renderExport(snapshot, "srt")).toThrow("approximate-block");
  }
  const selected = view(); selected.segments[0].humanEdited = true; selected.segments[0].text = "Correção humana"; selected.transcript.text = "Correção humana";
  const snapshot = snapshotReviewedView(job(), selected, "transcript");
  expect(() => renderExport(snapshot, "vtt")).toThrow("corrigido"); expect(renderExport(snapshot, "json").content).toContain("Correção humana");
  expect(snapshot.reviewed.segments[0].start).toBe(4.5);
  const unknown = snapshotReviewedView(job(), view({ ...sourceTranscript(), provider: "gemini", model: "synthetic-gemini" }), "transcript");
  expect(() => renderExport(unknown, "vtt")).toThrow("unknown");
});

test("subtitle refuses blank lines/control/unpaired Unicode and does not invent timing for full-text gaps", () => {
  for (const text of ["a\n\nb", "a\rb\n", "x\u0000y", "x\uD800y"]) {
    const snapshot = snapshotReviewedView(job(), view(), "transcript"); snapshot.reviewed.segments[0].text = text;
    expect(() => renderExport(snapshot, "srt")).toThrow();
  }
  const snapshot = snapshotReviewedView(job(), view(), "transcript");
  expect(renderExport(snapshot, "srt").content).not.toContain("Introdução sem tempo.");
  expect(renderExport(snapshot, "json").content).toContain("Introdução sem tempo.");
  snapshot.reviewed.segments[0].text = "";
  expect(renderExport(snapshot, "srt").omitted).toEqual(["s000000"]);
});

test("existing source timing has one provider-aware contract for player, context evidence and exports", async () => {
  const whisper = sourceTranscript(); expect(sourceTimingQuality(whisper)).toBe("segment"); expect(parsePlayerTranscript(whisper).timing).toBe("segment");
  expect(buildSummaryEvidence(whisper, "a".repeat(64)).timingQuality).toBe("segment");
  const gemini = { ...whisper, provider: "gemini" as const, model: "gemini-synthetic", words: [{ start: 1, end: 2, text: "Olá" }] };
  expect(sourceTimingQuality(gemini)).toBe("word"); expect(buildSummaryEvidence(gemini, "a".repeat(64)).timingQuality).toBe("segment");
  const diarizedTranscript = { ...whisper, provider: "openai" as const, model: "gpt-4o-transcribe-diarize" };
  expect(sourceTimingQuality(diarizedTranscript)).toBe("segment"); expect(buildSummaryEvidence(diarizedTranscript, "a".repeat(64)).timingQuality).toBe("segment");
  await fixture(async f => { const context = await readMeetingContext(DEFAULT_CONFIG, f.job.id); expect(context.excerpts.some(excerpt => excerpt.timestamps !== undefined)).toBe(false); }, whisper);
});

test("context prunes citations after compaction and preserves summary limitations without support", async () => {
  const selectedSummary = { ...summary(), decisions: ["A", "B", "C", "D"], citations: [{ section: "decision", index: 3, segmentIds: ["s000000"], uncertainty: "clear" }] };
  await fixture(async f => {
    const context = await readMeetingContext(DEFAULT_CONFIG, f.job.id, { maxCharacters: 24000 });
    expect(context.summary!.decisions).toHaveLength(3); expect(context.summary!.citations).toHaveLength(0);
    expect(() => validateSummary(context.summary, "openai", "synthetic-summary")).not.toThrow();
  }, sourceTranscript(), selectedSummary);
  const value = validateSummary({ ...summary(), limitations: ["Timing desconhecido"] }, "openai", "synthetic-summary");
  expect(formatSummaryMarkdown(value)).toContain("Timing desconhecido");
  expect(formatTranscriptMarkdown(sourceTranscript())).toContain("Cauda sem tempo.");
});

test("summary evidence binds media, normalized producer hash and exact source references; raw final LF remains a separate digest", async () => {
  const transcript = sourceTranscript();
  const supported = { ...summary(), citations: [{ section: "overview", index: 0, segmentIds: ["s000000"], uncertainty: "clear" }],
    support: { version: 1, mediaSha256: "a".repeat(64), transcriptSha256: summaryTranscriptEvidenceSha256(transcript), timingQuality: "segment", reviewRequired: false,
      references: [{ id: "s000000", start: transcript.segments[0].start, end: transcript.segments[0].end }] } };
  expect(summaryEvidenceMatches(validateSummary(supported, "openai", "synthetic-summary"), "a".repeat(64), transcript)).toBe(true);
  const damages = [
    { ...supported, support: { ...supported.support, mediaSha256: "b".repeat(64) } },
    { ...supported, support: { ...supported.support, transcriptSha256: "b".repeat(64) } },
    { ...supported, support: { ...supported.support, references: [{ id: "s000000", start: 999, end: 1000 }] } },
    { ...supported, citations: [{ ...supported.citations[0], segmentIds: ["s999999"] }], support: { ...supported.support, references: [{ id: "s999999", start: 0, end: 1 }] } }
  ];
  for (const damaged of damages) await fixture(async f => {
    const context = await readMeetingContext(DEFAULT_CONFIG, f.job.id);
    expect(context.summary).toBeNull(); expect(context.summaryProvenance).toEqual({ state: "stale", verification: "mismatch" });
    const preview = await previewExport(f.job, { format: "json", track: "transcript" }), document = JSON.parse(preview.display);
    expect(document.summary.state).toBe("stale"); expect(document.summary.verification).toBe("mismatch");
    expect(document.summary.original.support).toEqual(damaged.support);
  }, transcript, damaged);
  await fixture(async f => {
    await fs.appendFile(f.transcriptPath, "\n");
    const context = await readMeetingContext(DEFAULT_CONFIG, f.job.id);
    expect(context.summaryProvenance).toEqual({ state: "ready", verification: "verified" });
    expect(context.transcriptProvenance.transcriptSha256).not.toBe(summaryTranscriptEvidenceSha256(transcript));
    const preview = await previewExport(f.job, { format: "json", track: "transcript" }), document = JSON.parse(preview.display);
    expect(document.summary.verification).toBe("verified");
  }, transcript, supported);
  await fixture(async f => {
    const context = await readMeetingContext(DEFAULT_CONFIG, f.job.id);
    expect(context.summaryProvenance.verification).toBe("legacy-unverified");
    const preview = await previewExport(f.job, { format: "json", track: "transcript" });
    expect(preview.warnings.some(warning => warning.includes("Resumo legado"))).toBe(true);
  });
});

test("context pages never split a Unicode codepoint and reject a split starting offset", async () => {
  const text = "a".repeat(999) + "😀b";
  await fixture(async f => {
    const context = await readMeetingContext(DEFAULT_CONFIG, f.job.id, { maxCharacters: 24000 });
    expect(context.excerpts[0].charOffset.end).toBe(999);
    expect(context.excerpts[1].charOffset.start).toBe(999); expect(context.excerpts[1].text).toBe("😀b");
    await expect(readMeetingContext(DEFAULT_CONFIG, f.job.id, { offset: 1000 })).rejects.toThrow("Unicode");
  }, { ...sourceTranscript(), text, segments: [{ start: 0, end: 3, text }] });
});

test("private saved exports are immutable, idempotent, independently hashed bundles and never overwrite corrupt copies", async () => {
  await fixture(async f => {
    const original = await fs.readFile(f.transcriptPath, "utf8"), preview = await previewExport(f.job, { format: "srt", track: "transcript" });
    expect(preview.available).toBe(true); await expect(fs.stat(exportRoot())).rejects.toThrow();
    const input = { format: "srt" as const, track: "transcript" as const, expectedRevision: preview.revision, expectedBase: preview.base, expectedSnapshotSha256: preview.snapshotSha256! };
    const receipt = await saveExport(f.job, input), again = await saveExport(f.job, input);
    expect(again.path).toBe(receipt.path); expect(again.reused).toBe(true); expect(receipt.reused).toBe(false);
    const output = await fs.readFile(receipt.path, "utf8"), manifest = JSON.parse(await fs.readFile(receipt.manifestPath, "utf8")), snapshot = await fs.readFile(receipt.snapshotPath, "utf8");
    expect(digest(output)).toBe(receipt.sha256); expect(digest(snapshot)).toBe(receipt.snapshotSha256); expect(manifest.cues.map((cue: { id: string }) => cue.id)).toEqual(["s000001", "s000000"]);
    expect((await fs.stat(receipt.path)).mode & 0o777).toBe(0o600); expect((await fs.stat(exportRoot())).mode & 0o777).toBe(0o700);
    expect(await fs.readFile(f.transcriptPath, "utf8")).toBe(original);
    await fs.chmod(receipt.path, 0o644);
    await expect(saveExport(f.job, input)).rejects.toThrow("privada");
    await fs.chmod(receipt.path, 0o600);
    await fs.writeFile(receipt.path, "synthetic-corruption");
    await expect(saveExport(f.job, input)).rejects.toThrow("preservados"); expect(await fs.readFile(receipt.path, "utf8")).toBe("synthetic-corruption");
  });
});

test("revision CAS refuses stale export preview and reviewed context never serves stale original summary as current", async () => {
  await fixture(async f => {
    const preview = await previewExport(f.job, { format: "json", track: "transcript" });
    await saveRevision(f.job, { expectedRevision: preview.revision, base: preview.base, operations: [{ kind: "note", text: "Revisão humana sem tempo" }] });
    await expect(saveExport(f.job, { format: "json", track: "transcript", expectedRevision: preview.revision, expectedBase: preview.base, expectedSnapshotSha256: preview.snapshotSha256! })).rejects.toThrow("revisão");
    await expect(fs.stat(exportRoot())).rejects.toThrow();
    const current = await previewExport(f.job, { format: "json", track: "transcript" }), parsed = JSON.parse(current.display);
    expect(parsed.summary.state).toBe("stale"); expect(parsed.summary.original.overview).toBe("Resumo sintético");
    const context = await readMeetingContext(DEFAULT_CONFIG, f.job.id);
    expect(context.summary).toBeNull(); expect(context.review.revision).toBe(1); expect(context.review.notes).toEqual(["Revisão humana sem tempo"]);
  });
});

test("preview snapshot CAS binds summary artifact bytes even when revision and original transcript stay unchanged", async () => {
  await fixture(async f => {
    const preview = await previewExport(f.job, { format: "json", track: "transcript" });
    await fs.writeFile(join(f.job.artifactDir, "summary.json"), JSON.stringify({ ...summary(), overview: "Resumo B alterado" }));
    await expect(saveExport(f.job, { format: "json", track: "transcript", expectedRevision: preview.revision, expectedBase: preview.base, expectedSnapshotSha256: preview.snapshotSha256! })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    await expect(fs.stat(exportRoot())).rejects.toThrow();
    const current = await previewExport(f.job, { format: "json", track: "transcript" });
    expect(current.revision).toBe(preview.revision); expect(current.base).toEqual(preview.base); expect(current.snapshotSha256).not.toBe(preview.snapshotSha256);
    const receipt = await saveExport(f.job, { format: "json", track: "transcript", expectedRevision: current.revision, expectedBase: current.base, expectedSnapshotSha256: current.snapshotSha256! });
    expect(JSON.parse(await fs.readFile(receipt.path, "utf8")).summary.original.overview).toBe("Resumo B alterado");
  });
});

test("bounded preview never splits Unicode and the saved JSON remains a complete roundtrip", async () => {
  const text = "😀".repeat(18000);
  await fixture(async f => {
    const preview = await previewExport(f.job, { format: "json", track: "transcript" });
    expect(preview.displayTruncated).toBe(true); expect(preview.display.length).toBeLessThanOrEqual(24000);
    expect(/[\uD800-\uDBFF]$/.test(preview.display)).toBe(false);
    const receipt = await saveExport(f.job, { format: "json", track: "transcript", expectedRevision: preview.revision, expectedBase: preview.base, expectedSnapshotSha256: preview.snapshotSha256! });
    const result = JSON.parse(await fs.readFile(receipt.path, "utf8"));
    expect(result.reviewed.text).toBe(text); expect(result.original.transcript.text).toBe(text);
  }, { ...sourceTranscript(), text, segments: [] });
});

test("export rejects changed original source and symlink output ancestors without writes or overwrite", async () => {
  await fixture(async f => {
    const preview = await previewExport(f.job, { format: "json", track: "transcript" });
    await fs.writeFile(f.transcriptPath, JSON.stringify({ ...sourceTranscript(), text: "Origem alterada" }));
    await expect(saveExport(f.job, { format: "json", track: "transcript", expectedRevision: preview.revision, expectedBase: preview.base, expectedSnapshotSha256: preview.snapshotSha256! })).rejects.toThrow("origem");
    await expect(fs.stat(exportRoot())).rejects.toThrow();
  });
  await fixture(async f => {
    const preview = await previewExport(f.job, { format: "json", track: "transcript" }), external = join(f.root, "outside");
    await fs.mkdir(external); await fs.mkdir(join(f.root, "data")); await fs.symlink(external, join(f.root, "data/recording-cli"));
    await expect(saveExport(f.job, { format: "json", track: "transcript", expectedRevision: preview.revision, expectedBase: preview.base, expectedSnapshotSha256: preview.snapshotSha256! })).rejects.toThrow(/inseguro|simbólico/);
    expect(await fs.readdir(external)).toEqual([]);
  });
});

test("concurrent revision mutation cannot enter while an export holds the revision lease", async () => {
  await fixture(async f => {
    const original = await readReviewedView(f.job);
    let entered = false;
    let mutation!: Promise<void>;
    await withRevisionLease(f.job.id, async () => {
      mutation = saveRevision(f.job, { expectedRevision: 0, base: original.revision.base, operations: [{ kind: "note", text: "Concorrência sintética" }] }).then(() => { entered = true; });
      await new Promise(resolve => setTimeout(resolve, 80)); expect(entered).toBe(false);
    });
    await mutation;
    expect((await readReviewedView(f.job)).revision.revision).toBe(1);
  });
});
