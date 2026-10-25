import { homedir } from "node:os";
import { join } from "node:path";
import { defaultCallApplications, type CallApplication } from "../calls/apps";

export const RECORDING_BACKENDS = [
  "audio", "gpu-screen-recorder", "wf-recorder", "gnome", "obs", "obs-ws", "obs-cli", "ffmpeg", "ffmpeg-only",
  "gnome-ffmpeg", "gnome-native", "pipewire", "gstreamer", "kooha", "hybrid", "simple"
] as const;
export type RecordingBackend = (typeof RECORDING_BACKENDS)[number];

export type ExecutionTarget = "local" | "remote";
export type TranscriptionProvider = "openai" | "whisper-cpp" | "gemini";
export type SummaryProvider = "openai" | "ollama";
/** Language of new summaries; "auto" follows the predominant language of the conversation. */
export const SUMMARY_LANGUAGES = ["auto", "pt-BR", "en", "es"] as const;
export type SummaryLanguage = (typeof SUMMARY_LANGUAGES)[number];
/** "ai" lets the summary request pick a template when the calendar title and keywords do not decide; "keywords" never asks the model. */
export const TEMPLATE_DETECTION = ["ai", "keywords"] as const;
export type TemplateDetection = (typeof TEMPLATE_DETECTION)[number];
/** Where in-app questions, recipes and chat go. "local" uses the Ollama server of the summary settings. */
export const ASSISTANT_PROVIDERS = ["local", "api", "acp", "cli", "chatgpt"] as const;
export type AssistantProvider = (typeof ASSISTANT_PROVIDERS)[number];
export const ASSISTANT_API_PRESETS = ["openai", "openrouter", "gemini", "xai", "groq", "mistral", "deepseek", "together", "anthropic", "custom"] as const;
export type AssistantApiPreset = (typeof ASSISTANT_API_PRESETS)[number];
export const ASSISTANT_ACP_AGENTS = ["claude", "codex", "gemini", "opencode", "kiro", "copilot", "cursor", "goose", "qwen", "grok", "custom"] as const;
export type AssistantAcpAgent = (typeof ASSISTANT_ACP_AGENTS)[number];
export const ASSISTANT_CLI_TOOLS = ["claude", "codex", "gemini", "opencode"] as const;
export type AssistantCliTool = (typeof ASSISTANT_CLI_TOOLS)[number];
export const REMINDER_MODES = ["auto", "on", "off"] as const;
export type ReminderMode = (typeof REMINDER_MODES)[number];
export const LIVE_PROVIDERS = ["whisper-cpp", "openai", "groq"] as const;
export type LiveProvider = (typeof LIVE_PROVIDERS)[number];
export const MEDIA_RETENTION_MODES = ["keep", "audio-only", "transcript-only"] as const;
export type MediaRetentionMode = (typeof MEDIA_RETENTION_MODES)[number];
export const AI_APP_TARGETS = ["chatgpt-web", "claude-web", "claude-desktop", "gemini-web", "claude-cli", "codex-cli", "gemini-cli", "opencode-cli"] as const;
export type AiAppTarget = (typeof AI_APP_TARGETS)[number];
export type CallDetectionMode = "notify-only" | "obs" | "record";
export type ProtonBackupPolicy = "artifacts" | "full";

export const TRANSCRIPTION_PROMPT_MAX_LENGTH = 8_000;

export type AppConfig = {
  recordingsDir: string;
  backend: RecordingBackend;
  capture: {
    profile?: "standard" | "call-light";
    audioSource: "none" | "microphone" | "desktop" | "both";
    microphone: string;
    desktop: string;
    framerate: number;
    encoder: "gpu" | "cpu";
    startupTimeoutSeconds: number;
  };
  gnome: {
    pipeline?: string;
    framerate?: number;
    drawCursor?: boolean;
    audioSource?: "none" | "microphone" | "desktop" | "both";
  };
  obs: {
    enabled: boolean;
    autoLaunch: boolean;
    host: string;
    port: number;
    password?: string;
  };
  features: {
    namingTemplate: string;
  };
  proton: {
    enabled: boolean;
    targetFolder: string;
    policy: ProtonBackupPolicy;
  };
  archive: {
    enabled: boolean;
    vaio: boolean;
    proton: boolean;
    syncIntervalMinutes: number;
  };
  s3: {
    enabled: boolean;
    bucket: string;
    region: string;
    prefix: string;
    profile?: string;
  };
  openai: {
    apiKey?: string;
    model: string;
    autoTranscribe: boolean;
  };
  processing: {
    autoEnqueue: boolean;
    defaultTarget: ExecutionTarget;
    syncIntervalMinutes: number;
    /** Desktop notification when a processing job finishes or fails. */
    notifyOnCompletion: boolean;
    /** Process a recording as soon as it stops (local providers only) instead of waiting for the sync timer. */
    fastPath: boolean;
  };
  retention: {
    localCompletedWorkDays: number;
    remoteIncomingDays: number;
    remoteResultsDays: number;
    remoteFailuresDays: number;
  };
  remote: {
    host: string;
    user?: string;
    port: number;
    identityFile?: string;
    archiveDir: string;
  };
  transcription: {
    provider: TranscriptionProvider;
    language: string;
    expectedLanguages: string[];
    openaiModel: string;
    openaiPrompt: string;
    geminiModel: string;
    whisperCpp: {
      command: string;
      modelPath: string;
      threads: number;
      variant: "cpu" | "vulkan";
    };
  };
  summary: {
    provider: SummaryProvider;
    maxInputCharacters: number;
    openaiModel: string;
    ollamaUrl: string;
    ollamaModel: string;
    /** Language of new summaries. */
    language: SummaryLanguage;
    /** "auto" or a template id (built-in id or "custom:<slug>"). */
    template: string;
    templateDetection: TemplateDetection;
    /** Use the notes typed during the meeting as the skeleton of the summary. */
    useNotes: boolean;
  };
  /** Notepad during a capture. */
  notes: {
    enabled: boolean;
  };
  /** In-app questions, chat and recipes. */
  assistant: {
    provider: AssistantProvider;
    /** Ollama model for provider "local" (same server as summary.ollamaUrl). */
    localModel: string;
    apiPreset: AssistantApiPreset;
    /** Base URL of an OpenAI-compatible API for preset "custom"; empty otherwise. */
    apiBaseUrl: string;
    /** Model for provider "api"; empty uses the preset's default. */
    apiModel: string;
    acpAgent: AssistantAcpAgent;
    /** Command line of a custom ACP agent (no shell); empty otherwise. */
    acpCommand: string;
    cliTool: AssistantCliTool;
    /** Model for provider "cli"; empty uses the tool's default. */
    cliModel: string;
    /** Model for provider "chatgpt"; empty uses the account default. */
    chatgptModel: string;
    /** Upper bound of meeting text sent with one question. */
    maxContextCharacters: number;
    /** Local Ollama embedding model for library search; empty keeps keyword search only. */
    embeddingModel: string;
  };
  /** Calendar reminder shortly before a meeting starts. */
  reminders: {
    /** "auto": on when recordings are not automatic (notify-only or no call detection), off when they are. */
    mode: ReminderMode;
    leadMinutes: number;
    /** Add what is known from earlier meetings (open actions, last decisions). */
    brief: boolean;
  };
  /** Live transcript during a capture (a preview; the final transcript is made after the meeting). */
  live: {
    enabled: boolean;
    provider: LiveProvider;
    chunkSeconds: number;
    whisperModelPath: string;
    whisperThreads: number;
    openaiModel: string;
    groqModel: string;
  };
  /** What happens to the recorded media once its transcript is verified. */
  media: {
    retention: MediaRetentionMode;
    /** Days to wait before removing media, for speaker naming and voice learning. */
    graceDays: number;
  };
  /** Where "Share" can send notes and recipe results. */
  destinations: {
    /** Absolute path of an Obsidian vault; empty when not set. */
    obsidianVault: string;
    obsidianFolder: string;
    /** Notion page that receives new pages (32 hex characters); empty when not set. */
    notionParentId: string;
    /** AI app that "Open in my AI" uses. */
    aiApp: AiAppTarget;
  };
  visualReview?: { maxInferences:number; maxPreviews:number; period:"lifetime" };
  calendar: {
    enabled: boolean;
  };
  speakers: {
    /** Recognize known voices locally and learn from names a person confirms; needs the voice model. */
    voices: boolean;
  };
  google: {
    /** OAuth client of the user's own Google Cloud project ("Desktop app"); empty when not set up. */
    clientId: string;
    /** Read the Google Calendar event (title, invited names) of a recording; needs a connected account. */
    calendar: boolean;
  };
  callDetection: {
    enabled: boolean;
    mode: CallDetectionMode;
    dryRun: boolean;
    entryDebounceSeconds: number;
    exitTimeoutSeconds: number;
    networkSampleSeconds: number;
    enqueueOnStop: boolean;
    apps: Record<CallApplication, boolean>;
  };
  timesheet: {
    enabled: boolean;
    automaticFromCalls: boolean;
    aiClassification: boolean;
    aiModel: string;
    readyConfidence: number;
    contextPath: string;
  };
  aiContext: {
    enabled: boolean;
    autoBuild: boolean;
    maxMeetingsPerClient: number;
    maxCharactersPerClient: number;
  };
  /** Studio preferences. "auto" follows the system language (Portuguese or English). */
  studio: {
    language: StudioLanguage;
  };
};

export const STUDIO_LANGUAGES = ["auto", "pt-BR", "en"] as const;
export type StudioLanguage = (typeof STUDIO_LANGUAGES)[number];

export const DEFAULT_CONFIG: AppConfig = {
  recordingsDir: join(homedir(), "Videos", "Recordings"),
  backend: "simple",
  capture: {
    audioSource: "both",
    microphone: "default",
    desktop: "default",
    framerate: 30,
    encoder: "gpu",
    startupTimeoutSeconds: 90
  },
  gnome: {
    pipeline: undefined,
    framerate: 30,
    drawCursor: true,
    audioSource: "both"
  },
  obs: {
    enabled: false,
    autoLaunch: false,
    host: "127.0.0.1",
    port: 4455,
    password: undefined
  },
  features: {
    namingTemplate: "YYYY-MM-DD_HH-mm_[title]"
  },
  proton: {
    enabled: false,
    targetFolder: "/my-files/RecordingArchive",
    policy: "artifacts"
  },
  archive: { enabled: false, vaio: true, proton: true, syncIntervalMinutes: 5 },
  s3: {
    enabled: false,
    bucket: "",
    region: "us-east-1",
    prefix: "recordings/",
    profile: undefined
  },
  openai: {
    apiKey: undefined,
    model: "gpt-transcribe",
    autoTranscribe: false
  },
  processing: {
    autoEnqueue: false,
    defaultTarget: "local",
    syncIntervalMinutes: 5,
    notifyOnCompletion: true,
    fastPath: false
  },
  retention: {
    localCompletedWorkDays: 7,
    remoteIncomingDays: 2,
    remoteResultsDays: 30,
    remoteFailuresDays: 30
  },
  remote: {
    host: "worker.example.invalid",
    user: undefined,
    port: 22,
    identityFile: undefined,
    archiveDir: "~/Videos/RecordingArchive"
  },
  transcription: {
    provider: "whisper-cpp",
    language: "pt",
    expectedLanguages: [],
    openaiModel: "gpt-transcribe",
    openaiPrompt: "",
    geminiModel: "gemini-3.5-transcribe",
    whisperCpp: {
      command: "whisper-cli",
      modelPath: join(
        homedir(),
        ".local",
        "share",
        "recording-cli",
        "models",
        "ggml-large-v3-turbo-q5_0.bin"
      ),
      threads: 8,
      variant: "cpu"
    }
  },
  summary: {
    provider: "ollama",
    maxInputCharacters: 24_000,
    openaiModel: "gpt-6-luna",
    ollamaUrl: "http://127.0.0.1:11434",
    ollamaModel: "qwen3.5:9b",
    language: "auto",
    template: "auto",
    templateDetection: "ai",
    useNotes: true
  },
  notes: {
    enabled: true
  },
  assistant: {
    provider: "local",
    localModel: "qwen3.5:9b",
    apiPreset: "openrouter",
    apiBaseUrl: "",
    apiModel: "",
    acpAgent: "codex",
    acpCommand: "",
    cliTool: "claude",
    cliModel: "",
    chatgptModel: "",
    maxContextCharacters: 60_000,
    embeddingModel: ""
  },
  reminders: {
    mode: "auto",
    leadMinutes: 2,
    brief: true
  },
  live: {
    enabled: false,
    provider: "whisper-cpp",
    chunkSeconds: 15,
    whisperModelPath: join(homedir(), ".local", "share", "recording-cli", "models", "ggml-base.bin"),
    whisperThreads: 2,
    openaiModel: "gpt-transcribe",
    groqModel: "whisper-large-v3-turbo"
  },
  media: {
    retention: "keep",
    graceDays: 1
  },
  destinations: {
    obsidianVault: "",
    obsidianFolder: "FalaTrace",
    notionParentId: "",
    aiApp: "chatgpt-web"
  },
  calendar: {
    enabled: false
  },
  speakers: {
    voices: false
  },
  google: {
    clientId: "",
    calendar: false
  },
  callDetection: {
    enabled: false,
    mode: "notify-only",
    dryRun: false,
    entryDebounceSeconds: 5,
    exitTimeoutSeconds: 15,
    networkSampleSeconds: 5,
    enqueueOnStop: true,
    apps: defaultCallApplications()
  },
  timesheet: {
    enabled: false,
    automaticFromCalls: false,
    aiClassification: false,
    aiModel: "gpt-6-luna",
    readyConfidence: 0.8,
    contextPath: join(homedir(), ".config", "recording-cli", "timesheet-context.json")
  },
  aiContext: {
    enabled: false,
    autoBuild: true,
    maxMeetingsPerClient: 12,
    maxCharactersPerClient: 18_000
  },
  studio: {
    language: "auto"
  }
};
