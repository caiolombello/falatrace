import { homedir } from "node:os";
import { join } from "node:path";

export type RecordingBackend =
  | "audio"
  | "gpu-screen-recorder"
  | "wf-recorder"
  | "gnome"
  | "obs"
  | "obs-ws"
  | "obs-cli"
  | "ffmpeg"
  | "ffmpeg-only"
  | "gnome-ffmpeg"
  | "gnome-native"
  | "pipewire"
  | "gstreamer"
  | "kooha"
  | "hybrid"
  | "simple";

export type ExecutionTarget = "local" | "remote";
export type TranscriptionProvider = "openai" | "whisper-cpp" | "gemini";
export type SummaryProvider = "openai" | "ollama";
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
    countdownSeconds: number;
    autoStopMinutes?: number;
    enableHotkeys: boolean;
    enableWindowPicker: boolean;
    enableCompression: boolean;
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
  };
  visualReview?: { maxInferences:number; maxPreviews:number; period:"lifetime" };
  calendar: {
    enabled: boolean;
  };
  callDetection: {
    enabled: boolean;
    mode: CallDetectionMode;
    dryRun: boolean;
    entryDebounceSeconds: number;
    exitTimeoutSeconds: number;
    networkSampleSeconds: number;
    enqueueOnStop: boolean;
    apps: {
      slack: boolean;
      zen: boolean;
      helium: boolean;
    };
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
};

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
    countdownSeconds: 3,
    autoStopMinutes: undefined,
    enableHotkeys: false,
    enableWindowPicker: false,
    enableCompression: false,
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
    syncIntervalMinutes: 5
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
    ollamaModel: "qwen3.5:9b"
  },
  calendar: {
    enabled: false
  },
  callDetection: {
    enabled: false,
    mode: "notify-only",
    dryRun: false,
    entryDebounceSeconds: 5,
    exitTimeoutSeconds: 15,
    networkSampleSeconds: 5,
    enqueueOnStop: true,
    apps: {
      slack: true,
      zen: true,
      helium: true
    }
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
  }
};
