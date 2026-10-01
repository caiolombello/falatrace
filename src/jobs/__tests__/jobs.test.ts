import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { mergeConfig, validateConfig } from "../../config/load";
import {
  buildOpenAIChunkPrompt,
  isDiarizedOpenAIModel,
  isGptTranscribeModel,
  OPENAI_TRANSCRIPTION_TIMEOUT_MS,
  openAILanguageParameters,
  openAITranscriptionParameters,
  parseOpenAIDiarizedResponse,
  parseOpenAITextResponse,
  planOpenAIChunks
} from "../../transcription/openai";
import { runCommand } from "../command";
import { assertUsableTranscript, processJob } from "../pipeline";
import { buildSshArgs } from "../remote";
import { cleanupLocalCompletedWork, cleanupRemoteServer } from "../retention";
import { processLocalJob, retryJob, syncJobs } from "../sync";
import { JobStore, mergeTranscriptionPrompt, writeJsonAtomic } from "../store";
import { archiveDirectory } from "../worker";
import { SUMMARY_JSON_SCHEMA } from "../../summary/schema";
import {
  deriveMeetingTitle,
  JOB_VERSION,
  validateJobManifest,
  validateJobStatus,
  validateTranscript,
  validateSummary
} from "../types";

const temporaryDirectories: string[] = [];
const originalPath = process.env.PATH;

const makeTemporaryDirectory = async (): Promise<string> => {
  const path = await fs.mkdtemp(join(tmpdir(), "recording-cli-test-"));
  temporaryDirectories.push(path);
  return path;
};

const writeExecutable = async (path: string, content: string): Promise<void> => {
  await fs.writeFile(path, content, { mode: 0o700 });
};

afterEach(async () => {
  process.env.PATH = originalPath;
  await Promise.all(temporaryDirectories.splice(0).map((path) => fs.rm(path, { recursive: true, force: true })));
});

describe("config", () => {
  test("deeply merges processing provider configuration", () => {
    const config = mergeConfig(DEFAULT_CONFIG, {
      remote: { host: "worker.home" },
      transcription: {
        openaiPrompt: "Terraform, ECR",
        whisperCpp: { threads: 4 }
      },
      summary: { provider: "ollama" },
      calendar: { enabled: true }
    });
    expect(config.remote.host).toBe("worker.home");
    expect(config.remote.port).toBe(22);
    expect(config.transcription.openaiModel).toBe("gpt-transcribe");
    expect(config.transcription.expectedLanguages).toEqual([]);
    expect(config.transcription.openaiPrompt).toBe("Terraform, ECR");
    expect(config.transcription.whisperCpp.threads).toBe(4);
    expect(config.transcription.whisperCpp.command).toBe("whisper-cli");
    expect(config.summary.provider).toBe("ollama");
    expect(config.calendar.enabled).toBe(true);
    expect(config.proton.targetFolder).toBe("/my-files/RecordingArchive");
    expect(config.proton.policy).toBe("artifacts");
  });

  test("rejects an SSH host that could inject options", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.remote.host = "-oProxyCommand=bad";
    expect(() => validateConfig(config)).toThrow("remote.host");
  });

  test("rejects unsafe Proton paths and unsupported backup policies", () => {
    const traversal = structuredClone(DEFAULT_CONFIG);
    traversal.proton.targetFolder = "/my-files/../Shared";
    expect(() => validateConfig(traversal)).toThrow("proton.targetFolder");

    const outsideRoot = structuredClone(DEFAULT_CONFIG);
    outsideRoot.proton.targetFolder = "/Recordings";
    expect(() => validateConfig(outsideRoot)).toThrow("proton.targetFolder");

    const invalidPolicy = structuredClone(DEFAULT_CONFIG);
    (invalidPolicy.proton as { policy: string }).policy = "sync";
    expect(() => validateConfig(invalidPolicy)).toThrow("proton.policy");
  });

  test("accepts automatic language detection and rejects invalid language values", () => {
    const automatic = structuredClone(DEFAULT_CONFIG);
    automatic.transcription.language = "auto";
    expect(() => validateConfig(automatic)).not.toThrow();

    const invalid = structuredClone(DEFAULT_CONFIG);
    invalid.transcription.language = "automatic";
    expect(() => validateConfig(invalid)).toThrow("auto or an ISO language code");

    const multilingual = structuredClone(DEFAULT_CONFIG);
    multilingual.transcription.expectedLanguages = ["pt", "en"];
    expect(() => validateConfig(multilingual)).not.toThrow();

    const duplicate = structuredClone(DEFAULT_CONFIG);
    duplicate.transcription.expectedLanguages = ["pt", "pt"];
    expect(() => validateConfig(duplicate)).toThrow("expectedLanguages");
  });

  test("rejects an unbounded OpenAI transcription prompt", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.transcription.openaiPrompt = "x".repeat(8_001);

    expect(() => validateConfig(config)).toThrow("openaiPrompt");
  });

  test("rejects a non-boolean calendar flag", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    (config.calendar as { enabled: unknown }).enabled = "yes";
    expect(() => validateConfig(config)).toThrow("calendar.enabled");
  });

  test("ignores ambient SSH config for hardened background services", () => {
    const args = buildSshArgs(DEFAULT_CONFIG);
    const configIndex = args.indexOf("-F");
    expect(configIndex).toBeGreaterThanOrEqual(0);
    expect(args[configIndex + 1]).toBe("/dev/null");
  });

  test("bounds the transcription glossary merged from local context", () => {
    const prompt = mergeTranscriptionPrompt("Terraform", "x".repeat(20_000));
    expect(prompt).toStartWith("Terraform");
    expect(prompt.length).toBe(8_000);
  });
});

describe("OpenAI transcription", () => {
  test("omits the language parameter for automatic detection", () => {
    expect(openAILanguageParameters("gpt-4o-transcribe", "auto")).toEqual({});
    expect(openAILanguageParameters("gpt-4o-transcribe", "pt")).toEqual({
      language: "pt"
    });
    expect(
      openAILanguageParameters("gpt-transcribe", "auto", ["pt", "en"])
    ).toEqual({ languages: ["pt", "en"] });
    expect(openAILanguageParameters("gpt-transcribe", "pt")).toEqual({
      languages: ["pt"]
    });
  });

  test("sets an extended client timeout for diarized transcription requests", () => {
    expect(OPENAI_TRANSCRIPTION_TIMEOUT_MS).toBe(60 * 60 * 1000);
  });

  test("splits long recordings into bounded ten-minute requests", () => {
    const chunks = planOpenAIChunks(1593.833);

    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toEqual({ start: 0, duration: 600 });
    expect(chunks[1]).toEqual({ start: 600, duration: 600 });
    expect(chunks[2]?.start).toBe(1200);
    expect(chunks[2]?.duration).toBeCloseTo(393.833, 6);
    expect(Math.max(...chunks.map((chunk) => chunk.duration))).toBe(600);
  });

  test("uses direct transcription parameters unless diarization is selected", () => {
    expect(isGptTranscribeModel("gpt-transcribe")).toBe(true);
    expect(isDiarizedOpenAIModel("gpt-4o-transcribe")).toBe(false);
    expect(isDiarizedOpenAIModel("gpt-4o-transcribe-diarize")).toBe(true);
    expect(openAITranscriptionParameters("gpt-4o-transcribe", "auto", "Terraform")).toEqual({
      response_format: "json",
      prompt: "Terraform"
    });
    expect(
      openAITranscriptionParameters("gpt-4o-transcribe-diarize", "pt", "ignored")
    ).toEqual({
      language: "pt",
      response_format: "diarized_json",
      chunking_strategy: "auto"
    });
    expect(
      openAITranscriptionParameters(
        "gpt-transcribe",
        "auto",
        "Contexto técnico",
        ["pt", "en"],
        ["Example Alpha", "Terraform"]
      )
    ).toEqual({
      languages: ["pt", "en"],
      response_format: "json",
      prompt: "Contexto técnico",
      keywords: ["Example Alpha", "Terraform"]
    });
  });

  test("builds bounded continuation prompts without losing the glossary", () => {
    const prompt = buildOpenAIChunkPrompt("Glossário: Terraform, ECR.", "a".repeat(20_000));

    expect(prompt).toStartWith("Glossário: Terraform, ECR.");
    expect(prompt).toContain("Contexto imediatamente anterior");
    expect(prompt.length).toBeLessThanOrEqual(8_000);
  });

  test("normalizes direct text responses into speakerless chunk segments", () => {
    expect(parseOpenAITextResponse({ text: " Olá, Terraform. " }, 600, 300)).toEqual([
      {
        start: 600,
        end: 900,
        text: "Olá, Terraform."
      }
    ]);
  });

  test("namespaces diarized speakers when chunks are processed independently", () => {
    expect(
      parseOpenAIDiarizedResponse(
        { segments: [{ start: 1, end: 2, text: "Olá", speaker: "A" }] },
        600,
        "C2"
      )
    ).toEqual([
      {
        start: 601,
        end: 602,
        text: "Olá",
        speaker: "C2:A"
      }
    ]);
  });
});

describe("summary schema", () => {
  test("requires a bounded title and a non-blank overview", () => {
    expect(SUMMARY_JSON_SCHEMA.required).toContain("title");
    expect(SUMMARY_JSON_SCHEMA.properties.title).toEqual({
      type: "string",
      pattern: "\\S",
      maxLength: 160
    });
    expect(SUMMARY_JSON_SCHEMA.properties.overview).toEqual({
      type: "string",
      pattern: "\\S"
    });
  });
});

describe("job contracts", () => {
  const manifest = {
    version: JOB_VERSION,
    id: "123e4567-e89b-42d3-a456-426614174000",
    createdAt: "2026-07-13T12:00:00.000Z",
    source: {
      originalName: "meeting.mkv",
      mediaFile: "source.mkv",
      size: 12,
      sha256: "a".repeat(64)
    },
    transcription: {
      provider: "whisper-cpp",
      model: "model.bin",
      language: "pt",
      prompt: "Terraform"
    },
    summary: { provider: "openai", model: "gpt-4o-mini" }
  };

  test("accepts a valid manifest and status", () => {
    expect(validateJobManifest(manifest).transcription.prompt).toBe("Terraform");
    expect(
      validateJobStatus({
        version: JOB_VERSION,
        id: manifest.id,
        state: "completed",
        updatedAt: manifest.createdAt,
        archiveRelative: `2026/07/${manifest.id}`
      }).state
    ).toBe("completed");
  });

  test("rejects path traversal in media names", () => {
    expect(() =>
      validateJobManifest({
        ...manifest,
        source: { ...manifest.source, mediaFile: "../source.mkv" }
      })
    ).toThrow("directory components");
  });

  test("keeps legacy manifests without a transcription prompt valid", () => {
    const legacy = structuredClone(manifest);
    delete (legacy.transcription as { prompt?: string }).prompt;

    expect(validateJobManifest(legacy).transcription.prompt).toBeUndefined();
  });

  test("validates multilingual hints and bounded transcription keywords", () => {
    const parsed = validateJobManifest({
      ...manifest,
      transcription: {
        ...manifest.transcription,
        model: "gpt-transcribe",
        language: "auto",
        languages: ["pt", "en"],
        keywords: ["Example Alpha", "Terraform"]
      }
    });
    expect(parsed.transcription.languages).toEqual(["pt", "en"]);
    expect(parsed.transcription.keywords).toEqual(["Example Alpha", "Terraform"]);
    expect(() =>
      validateJobManifest({
        ...manifest,
        transcription: {
          ...manifest.transcription,
          keywords: ["unsafe\nkeyword"]
        }
      })
    ).toThrow("unsupported characters");
  });

  test("accepts bounded meeting and client context in the manifest", () => {
    const parsed = validateJobManifest({
      ...manifest,
      summary: {
        ...manifest.summary,
        context: {
          meeting: {
            source: "gnome-calendar",
            title: "Daily SRE",
            startAt: "2026-07-28T19:00:00.000Z",
            endAt: "2026-07-28T19:15:00.000Z",
            recurring: true,
            confidence: 0.95,
            app: "zen"
          },
          clients: [
            {
              code: "CL002",
              name: "Example Alpha",
              aliases: ["Legacy - Example Alpha", "Example Alias"]
            }
          ]
        }
      }
    });
    expect(parsed.summary.context?.meeting?.title).toBe("Daily SRE");
    expect(parsed.summary.context?.clients?.[0].name).toBe("Example Alpha");
  });

  test("keeps manifests without summary context backward compatible", () => {
    expect(validateJobManifest(manifest).summary.context).toBeUndefined();
  });

  test("rejects unsafe summary context", () => {
    expect(() =>
      validateJobManifest({
        ...manifest,
        summary: {
          ...manifest.summary,
          context: {
            meeting: {
              source: "gnome-calendar",
              title: "Daily\nSRE",
              startAt: "2026-07-28T19:00:00.000Z",
              endAt: "2026-07-28T19:15:00.000Z",
              recurring: true,
              confidence: 0.95
            }
          }
        }
      })
    ).toThrow("single-line");
  });

  test("derives a searchable title for legacy structured summaries", () => {
    const summary = validateSummary(
      {
        overview: "Revisão dos alertas da Example Vet. Próximos passos definidos.",
        topics: ["Tema"],
        decisions: [],
        actionItems: []
      },
      "ollama",
      "qwen3.5:9b"
    );
    expect(summary.version).toBe(JOB_VERSION);
    expect(summary.provider).toBe("ollama");
    expect(summary.title).toBe("Revisão dos alertas da Example Vet");
    expect(
      deriveMeetingTitle(
        "A conversa gira em torno de temas como compras de móveis de escritório, atualizações em sistemas técnicos e discussões sobre gerenciamento de infraestrutura de TI."
      )
    ).toBe(
      "Compras de móveis de escritório, atualizações em sistemas técnicos e discussões sobre gerenciamento de infraestrutura"
    );
  });

  test("normalizes an explicit title and rejects unsafe or unbounded titles", () => {
    const summary = validateSummary(
      {
        title: "  Alertas da Example Vet  ",
        overview: "Resumo",
        topics: [],
        decisions: [],
        actionItems: []
      },
      "openai",
      "gpt-4o-mini"
    );
    expect(summary.title).toBe("Alertas da Example Vet");
    expect(deriveMeetingTitle("A".repeat(200)).length).toBeLessThanOrEqual(160);
    expect(() =>
      validateSummary(
        {
          title: "Título\ninjetado",
          overview: "Resumo",
          topics: [],
          decisions: [],
          actionItems: []
        },
        "openai",
        "gpt-4o-mini"
      )
    ).toThrow("single-line");
    expect(() =>
      validateSummary(
        {
          title: "x".repeat(161),
          overview: "Resumo",
          topics: [],
          decisions: [],
          actionItems: []
        },
        "openai",
        "gpt-4o-mini"
      )
    ).toThrow("up to 160");
  });

  test("validates reusable transcripts before a retry", () => {
    expect(
      validateTranscript({
        version: JOB_VERSION,
        provider: "openai",
        model: "gpt-4o-transcribe",
        language: "auto",
        text: "Olá",
        segments: [{ start: 0, end: 1, text: "Olá" }]
      }).text
    ).toBe("Olá");
    expect(() =>
      validateTranscript({
        version: JOB_VERSION,
        provider: "openai",
        model: "gpt-4o-transcribe",
        language: "auto",
        text: "Olá",
        segments: [{ start: -1, end: 1, text: "Olá" }]
      })
    ).toThrow("segment");
  });

  test("rejects unbounded summary arrays", () => {
    expect(() =>
      validateSummary(
        { overview: "Resumo", topics: Array(101).fill("Tema"), decisions: [], actionItems: [] },
        "ollama",
        "qwen3.5:9b"
      )
    ).toThrow("at most 100");
  });
});

test("does not summarize an empty reusable transcript", async () => {
  const root = await makeTemporaryDirectory();
  const outputDir = join(root, "processing");
  await fs.mkdir(outputDir);
  const manifest = {
    version: JOB_VERSION,
    id: "123e4567-e89b-42d3-a456-426614174000",
    createdAt: "2026-07-13T12:00:00.000Z",
    source: {
      originalName: "meeting.mp4",
      mediaFile: "source.mp4",
      size: 1,
      sha256: "a".repeat(64)
    },
    transcription: {
      provider: "openai" as const,
      model: "gpt-transcribe",
      language: "auto"
    },
    summary: {
      provider: "ollama" as const,
      model: "fake",
      context: undefined
    }
  };
  await fs.writeFile(
    join(outputDir, "transcript.json"),
    JSON.stringify({
      version: JOB_VERSION,
      provider: "openai",
      model: "gpt-transcribe",
      language: "auto",
      text: " \n\t",
      segments: []
    })
  );

  let summaryRequests = 0;
  const server = Bun.serve({
    port: 0,
    fetch: () => {
      summaryRequests += 1;
      return Response.json({});
    }
  });
  try {
    await expect(
      processJob(
        mergeConfig(DEFAULT_CONFIG, {
          summary: { provider: "ollama", ollamaUrl: `http://127.0.0.1:${server.port}` }
        }),
        manifest,
        join(root, "missing-source.mp4"),
        outputDir
      )
    ).rejects.toThrow(
      "Transcrição vazia: o áudio pode estar ausente ou silencioso, ou o provedor retornou uma resposta vazia"
    );
    expect(summaryRequests).toBe(0);
    expect(await fs.stat(join(outputDir, "summary.json")).catch(() => null)).toBeNull();
  } finally {
    server.stop(true);
  }
});

test("rejects transcripts containing only whitespace", () => {
  expect(() =>
    assertUsableTranscript({
      version: JOB_VERSION,
      provider: "openai",
      model: "gpt-transcribe",
      language: "auto",
      text: "  \n",
      segments: [{ start: 0, end: 1, text: "\t" }]
    })
  ).toThrow("Transcrição vazia");
});

test("marks a local job with an empty transcript as failed", async () => {
  const root = await makeTemporaryDirectory();
  const mediaPath = join(root, "meeting.mp4");
  await fs.writeFile(mediaPath, "fake media");
  const store = new JobStore(join(root, "state"), join(root, "data"));
  const config = mergeConfig(DEFAULT_CONFIG, {
    processing: { defaultTarget: "local" },
    summary: { provider: "ollama", ollamaUrl: "http://127.0.0.1:1" }
  });
  const job = await store.enqueue(config, mediaPath);
  await fs.writeFile(
    join(store.getWorkDir(job.id), "transcript.json"),
    JSON.stringify({
      version: JOB_VERSION,
      provider: job.transcription.provider,
      model: job.transcription.model,
      language: job.transcription.language,
      text: "\t \n",
      segments: []
    })
  );

  const result = await processLocalJob(config, store, job);

  expect(result.state).toBe("failed");
  expect(result.error).toContain("Transcrição vazia");
});

test("processes a local job through fake whisper.cpp and Ollama providers", async () => {
  const root = await makeTemporaryDirectory();
  const binDir = join(root, "bin");
  const stateDir = join(root, "state");
  const dataDir = join(root, "data");
  const mediaPath = join(root, "meeting.mkv");
  const modelPath = join(root, "model.bin");
  const contextPath = join(root, "timesheet-context.json");
  await fs.mkdir(binDir);
  await fs.writeFile(mediaPath, "fake media");
  await fs.writeFile(modelPath, "fake model");
  await writeExecutable(join(binDir, "ffprobe"), "#!/usr/bin/env bash\nprintf '12.5\\n'\n");
  await writeExecutable(
    join(binDir, "ffmpeg"),
    "#!/usr/bin/env bash\noutput=\"${!#}\"\nprintf 'audio' > \"$output\"\n"
  );
  await writeExecutable(
    join(binDir, "whisper-cli"),
    `#!/usr/bin/env bash\nwhile [[ $# -gt 0 ]]; do if [[ $1 == -of ]]; then output=$2; shift 2; else shift; fi; done\nprintf '%s' '{"result":{"language":"pt"},"transcription":[{"offsets":{"from":0,"to":1250},"text":" Olá mundo"}]}' > "${"$"}{output}.json"\n`
  );
  process.env.PATH = `${binDir}:${originalPath}`;
  await fs.writeFile(
    contextPath,
    JSON.stringify({
      version: 1,
      colleagues: [],
      clients: [
        {
          code: "CL002",
          name: "Legacy - Example Alpha",
          aliases: ["Example Legacy Alias", "Example Alpha", "Example Alias"],
          responsibleNames: []
        }
      ],
      taskTypes: []
    })
  );

  let summaryUserContent = "";
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      expect(new URL(request.url).pathname).toBe("/api/chat");
      const requestBody = (await request.json()) as {
        messages: Array<{ role: string; content: string }>;
      };
      summaryUserContent =
        requestBody.messages.find((message) => message.role === "user")
          ?.content || "";
      return Response.json({
        message: {
          content: JSON.stringify({
            title: "Alocações e atualizações de infraestrutura",
            overview: "Foram discutidas atividades da Example Alias.",
            topics: ["Demandas da Example Alias"],
            decisions: [],
            actionItems: []
          })
        }
      });
    }
  });

  try {
    const config = mergeConfig(DEFAULT_CONFIG, {
      processing: { defaultTarget: "local" },
      transcription: {
        provider: "whisper-cpp",
        whisperCpp: { command: "whisper-cli", modelPath, threads: 2 }
      },
      summary: {
        provider: "ollama",
        ollamaUrl: `http://127.0.0.1:${server.port}`,
        ollamaModel: "fake"
      },
      timesheet: {
        enabled: true,
        contextPath
      }
    });
    const store = new JobStore(stateDir, dataDir);
    const job = await store.enqueue(config, mediaPath, {
      meetingContext: {
        source: "gnome-calendar",
        title: "Daily SRE",
        startAt: "2026-07-28T19:00:00.000Z",
        endAt: "2026-07-28T19:15:00.000Z",
        recurring: true,
        confidence: 0.95,
        app: "zen"
      }
    });
    const result = await processLocalJob(config, store, job);
    expect(result.state).toBe("completed");
    const transcript = JSON.parse(await fs.readFile(join(job.artifactDir, "transcript.json"), "utf-8"));
    expect(transcript.text).toBe("Olá mundo");
    expect(transcript.segments[0].end).toBe(1.25);
    expect(await fs.readFile(join(job.artifactDir, "summary.md"), "utf-8")).toStartWith(
      "# Daily SRE — Alocações e atualizações de infraestrutura\n\n## Resumo"
    );
    const summary = JSON.parse(
      await fs.readFile(join(job.artifactDir, "summary.json"), "utf-8")
    );
    expect(summary.title).toBe(
      "Daily SRE — Alocações e atualizações de infraestrutura"
    );
    expect(summary.overview).toContain("Example Alpha");
    expect(summary.overview).not.toContain("Example Alias");
    const summaryInput = JSON.parse(summaryUserContent);
    expect(summaryInput.meeting.title).toBe("Daily SRE");
    expect(summaryInput.clients[0]).toEqual({
      code: "CL002",
      name: "Example Alpha",
      aliases: ["Legacy - Example Alpha", "Example Legacy Alias", "Example Alpha", "Example Alias"]
    });
  } finally {
    server.stop(true);
  }
});

test("keeps artifacts from repeated jobs in separate directories", async () => {
  const root = await makeTemporaryDirectory();
  const mediaPath = join(root, "meeting.mkv");
  await fs.writeFile(mediaPath, "fake media");
  const store = new JobStore(join(root, "state"), join(root, "data"));

  const first = await store.enqueue(DEFAULT_CONFIG, mediaPath);
  const second = await store.enqueue(DEFAULT_CONFIG, mediaPath);

  expect(first.artifactDir).not.toBe(second.artifactDir);
  expect(first.artifactDir).toEndWith(first.id);
  expect(second.artifactDir).toEndWith(second.id);
});

test("does not reprocess a local job already being processed", async () => {
  const root = await makeTemporaryDirectory();
  const mediaPath = join(root, "meeting.mkv");
  await fs.writeFile(mediaPath, "fake media");
  const store = new JobStore(join(root, "state"), join(root, "data"));
  const config = mergeConfig(DEFAULT_CONFIG, { processing: { defaultTarget: "local" } });
  const job = await store.enqueue(config, mediaPath);
  await store.update(job.id, "processing");

  const result = await syncJobs(config, store);

  expect(result).toEqual([]);
  expect((await store.get(job.id)).state).toBe("processing");
});

test("resumes a failed local job from its valid transcript", async () => {
  const root = await makeTemporaryDirectory();
  const mediaPath = join(root, "meeting.mkv");
  await fs.writeFile(mediaPath, "fake media");
  const store = new JobStore(join(root, "state"), join(root, "data"));
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json({
        message: {
          content: JSON.stringify({
            title: "Recuperação do processamento",
            overview: "Resumo recuperado.",
            topics: ["Retry"],
            decisions: [],
            actionItems: []
          })
        }
      })
  });
  try {
    const config = mergeConfig(DEFAULT_CONFIG, {
      processing: { defaultTarget: "local" },
      summary: {
        provider: "ollama",
        ollamaUrl: `http://127.0.0.1:${server.port}`,
        ollamaModel: "fake"
      }
    });
    const job = await store.enqueue(config, mediaPath);
    await fs.writeFile(
      join(store.getWorkDir(job.id), "transcript.json"),
      JSON.stringify({
        version: JOB_VERSION,
        provider: job.transcription.provider,
        model: job.transcription.model,
        language: job.transcription.language,
        text: "Transcrição preservada.",
        segments: [{ start: 0, end: 2, text: "Transcrição preservada." }]
      })
    );
    await store.update(job.id, "failed", { error: "summary failed" });

    const pending = await retryJob(store, job.id);
    const result = await processLocalJob(config, store, pending);

    expect(pending.error).toBeUndefined();
    expect(result.state).toBe("completed");
    expect(await fs.readFile(join(job.artifactDir, "transcript.md"), "utf-8")).toContain(
      "Transcrição preservada."
    );
    expect(await fs.readFile(join(job.artifactDir, "summary.md"), "utf-8")).toContain(
      "Resumo recuperado."
    );
  } finally {
    server.stop(true);
  }
});

test("stores the selected OpenAI quality profile in the remote job manifest", async () => {
  const root = await makeTemporaryDirectory();
  const mediaPath = join(root, "meeting.mkv");
  const contextPath = join(root, "timesheet-context.json");
  await fs.writeFile(mediaPath, "fake media");
  await fs.writeFile(
    contextPath,
    JSON.stringify({
      version: 1,
      colleagues: [
        {
          name: "Alex Example",
          aliases: [],
          email: "not-sent@example.test"
        }
      ],
      clients: [
        {
          code: "CL002",
          name: "Legacy - Example Alpha",
          aliases: ["Example Alias"],
          responsibleNames: []
        }
      ],
      taskTypes: []
    })
  );
  const store = new JobStore(join(root, "state"), join(root, "data"));
  const config = mergeConfig(DEFAULT_CONFIG, {
    transcription: {
      provider: "openai",
      language: "auto",
      expectedLanguages: ["pt", "en"],
      openaiModel: "gpt-transcribe",
      openaiPrompt: "Glossário: Terraform, ECR."
    },
    timesheet: { enabled: true, contextPath }
  });

  const job = await store.enqueue(config, mediaPath);
  const manifest = validateJobManifest(
    JSON.parse(await fs.readFile(join(store.getWorkDir(job.id), "manifest.json"), "utf-8"))
  );

  expect(manifest.transcription).toEqual({
    provider: "openai",
    model: "gpt-transcribe",
    language: "auto",
    languages: ["pt", "en"],
    keywords: ["Alex Example", "CL002", "Legacy - Example Alpha"],
    prompt:
      "Glossário: Terraform, ECR.\n\nGrafias de nomes e clientes: Alex Example, CL002, Legacy - Example Alpha."
  });
});

test("rejects a local source changed after enqueue", async () => {
  const root = await makeTemporaryDirectory();
  const mediaPath = join(root, "meeting.mkv");
  await fs.writeFile(mediaPath, "original");
  const store = new JobStore(join(root, "state"), join(root, "data"));
  const config = mergeConfig(DEFAULT_CONFIG, { processing: { defaultTarget: "local" } });
  const job = await store.enqueue(config, mediaPath);
  await fs.writeFile(mediaPath, "modified");

  const result = await processLocalJob(config, store, job);

  expect(result.state).toBe("failed");
  expect(result.error).toContain("checksum");
});

test("supports concurrent atomic writes to the same JSON file", async () => {
  const root = await makeTemporaryDirectory();
  const path = join(root, "status.json");

  await Promise.all(
    Array.from({ length: 20 }, (_, index) => writeJsonAtomic(path, { index }))
  );

  const result = JSON.parse(await fs.readFile(path, "utf-8")) as { index: number };
  expect(result.index).toBeGreaterThanOrEqual(0);
  expect(result.index).toBeLessThan(20);
  expect((await fs.readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
});

test("cleans only expired completed-job work data", async () => {
  const root = await makeTemporaryDirectory();
  const mediaPath = join(root, "meeting.mkv");
  await fs.writeFile(mediaPath, "media");
  const store = new JobStore(join(root, "state"), join(root, "data"));
  const completed = await store.enqueue(DEFAULT_CONFIG, mediaPath);
  const failed = await store.enqueue(DEFAULT_CONFIG, mediaPath);
  await store.update(completed.id, "completed");
  await store.update(failed.id, "failed", { error: "retry later" });
  const future = Date.now() + 8 * 24 * 60 * 60 * 1000;

  const preview = await cleanupLocalCompletedWork(store, 7, { dryRun: true, now: future });
  expect(preview.localCompletedWork).toBe(1);
  expect((await fs.stat(store.getWorkDir(completed.id))).isDirectory()).toBe(true);

  const report = await cleanupLocalCompletedWork(store, 7, { now: future });
  expect(report.localCompletedWork).toBe(1);
  await expect(fs.stat(store.getWorkDir(completed.id))).rejects.toMatchObject({ code: "ENOENT" });
  expect((await fs.stat(store.getWorkDir(failed.id))).isDirectory()).toBe(true);
  expect((await store.get(completed.id)).state).toBe("completed");
});

test("cleans expired remote staging directories without touching fresh results", async () => {
  const root = await makeTemporaryDirectory();
  const serverRoot = join(root, "server");
  const archiveRoot = join(root, "archive");
  const oldJob = "123e4567-e89b-42d3-a456-426614174000";
  const freshJob = "123e4567-e89b-42d3-a456-426614174001";
  const orphanedJob = "123e4567-e89b-42d3-a456-426614174002";
  const paths = [
    join(serverRoot, "incoming", `${oldJob}.partial`),
    join(serverRoot, "results", oldJob),
    join(serverRoot, "failed", `${oldJob}-1234567890123`),
    join(serverRoot, "results", freshJob),
    join(serverRoot, "results", orphanedJob)
  ];
  for (const path of paths) await fs.mkdir(path, { recursive: true });
  const archiveRelative = `2026/07/${oldJob}`;
  const archiveDir = join(archiveRoot, archiveRelative);
  await fs.mkdir(archiveDir, { recursive: true });
  for (const name of ["transcript.json", "transcript.md", "summary.json", "summary.md"]) {
    await fs.writeFile(join(archiveDir, name), "artifact");
  }
  await fs.mkdir(join(serverRoot, "status"), { recursive: true });
  await fs.writeFile(join(serverRoot, "status", `${oldJob}.json`), JSON.stringify({
    version: JOB_VERSION,
    id: oldJob,
    state: "completed",
    updatedAt: "2026-07-01T00:00:00.000Z",
    archiveRelative
  }));
  const now = Date.now();
  const oldDate = new Date(now - 31 * 24 * 60 * 60 * 1000);
  for (const path of [...paths.slice(0, 3), paths[4]]) await fs.utimes(path, oldDate, oldDate);
  const config = mergeConfig(DEFAULT_CONFIG, {
    remote: { archiveDir: archiveRoot },
    retention: {
      remoteIncomingDays: 2,
      remoteResultsDays: 30,
      remoteFailuresDays: 30
    }
  });

  const report = await cleanupRemoteServer(config, { serverRoot, now });

  expect(report.remoteIncoming).toBe(1);
  expect(report.remoteResults).toBe(1);
  expect(report.remoteFailures).toBe(1);
  expect((await fs.stat(join(serverRoot, "results", freshJob))).isDirectory()).toBe(true);
  expect((await fs.stat(join(serverRoot, "results", orphanedJob))).isDirectory()).toBe(true);
});

test("terminates a command that exceeds its timeout", async () => {
  const startedAt = Date.now();

  await expect(
    runCommand(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { timeoutMs: 25 })
  ).rejects.toThrow("timed out after 25ms");

  expect(Date.now() - startedAt).toBeLessThan(1_000);
});

test("downloads artifacts when a pending remote job is already completed", async () => {
  const root = await makeTemporaryDirectory();
  const binDir = join(root, "bin");
  const mediaPath = join(root, "meeting.mkv");
  await fs.mkdir(binDir);
  await fs.writeFile(mediaPath, "fake media");
  const store = new JobStore(join(root, "state"), join(root, "data"));
  const config = mergeConfig(DEFAULT_CONFIG, {
    processing: { defaultTarget: "remote" },
    remote: { host: "worker.test", archiveDir: "~/archive" }
  });
  const job = await store.enqueue(config, mediaPath);
  const remoteStatus = JSON.stringify({
    version: JOB_VERSION,
    id: job.id,
    state: "completed",
    updatedAt: "2026-07-13T12:00:00.000Z",
    archiveRelative: `2026/07/${job.id}`
  });
  await writeExecutable(
    join(binDir, "ssh"),
    `#!/usr/bin/env bash\nif [[ "$*" == *"printenv HOME"* ]]; then\n  printf '/home/worker\\n'\nelse\n  printf '%s\\n' '${remoteStatus}'\nfi\n`
  );
  await writeExecutable(
    join(binDir, "rsync"),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> '${join(root, "rsync.log")}'\ndestination="${"$"}{!#}"\nprintf 'artifact' > "$destination"\n`
  );
  process.env.PATH = `${binDir}:${originalPath}`;

  const [result] = await syncJobs(config, store);

  expect(result.state).toBe("completed");
  for (const name of ["transcript.json", "transcript.md", "summary.json", "summary.md"]) {
    expect(await fs.readFile(join(job.artifactDir, name), "utf-8")).toBe("artifact");
  }
  expect(await fs.readFile(join(root, "rsync.log"), "utf-8")).toContain(
    `worker.test:/home/worker/archive/2026/07/${job.id}/transcript.json`
  );
});

test("requeues a failed remote job without retransferring its recording", async () => {
  const root = await makeTemporaryDirectory();
  const binDir = join(root, "bin");
  const mediaPath = join(root, "meeting.mkv");
  await fs.mkdir(binDir);
  await fs.writeFile(mediaPath, "fake media");
  const store = new JobStore(join(root, "state"), join(root, "data"));
  const config = mergeConfig(DEFAULT_CONFIG, {
    processing: { defaultTarget: "remote" },
    remote: { host: "worker.test" }
  });
  const job = await store.enqueue(config, mediaPath);
  await store.update(job.id, "failed", { error: "summary failed" });
  const remoteStatus = JSON.stringify({
    version: JOB_VERSION,
    id: job.id,
    state: "failed",
    updatedAt: "2026-07-16T12:00:00.000Z",
    error: "summary failed"
  });
  await writeExecutable(
    join(binDir, "ssh"),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> '${join(root, "ssh.log")}'\nif [[ "$*" == *"status/${job.id}.json"* ]]; then printf '%s\\n' '${remoteStatus}'; fi\n`
  );
  await writeExecutable(
    join(binDir, "rsync"),
    `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> '${join(root, "rsync.log")}'\n`
  );
  process.env.PATH = `${binDir}:${originalPath}`;

  await retryJob(store, job.id);
  const [result] = await syncJobs(config, store);

  expect(result.state).toBe("queued");
  const sshLog = await fs.readFile(join(root, "ssh.log"), "utf-8");
  expect(sshLog).toContain(`failed/${job.id}`);
  expect(sshLog).toContain(`queue/${job.id}`);
  await expect(fs.stat(join(root, "rsync.log"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("publishes an archive atomically and leaves processing cleanup to the worker", async () => {
  const root = await makeTemporaryDirectory();
  const source = join(root, "processing", "job");
  const destination = join(root, "archive", "2026", "07", "job");
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(join(source, "source.mkv"), "media");
  await fs.writeFile(join(source, "transcript.md"), "transcript");

  await archiveDirectory(source, destination);

  expect(await fs.readFile(join(destination, "source.mkv"), "utf-8")).toBe("media");
  expect(await fs.readFile(join(destination, "transcript.md"), "utf-8")).toBe("transcript");
  expect((await fs.stat(source)).isDirectory()).toBe(true);
  await expect(fs.stat(`${destination}.partial`)).rejects.toMatchObject({ code: "ENOENT" });
});
