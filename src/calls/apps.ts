// Explicit allowlist of call-capable applications. Matching is equality after
// lowercasing PipeWire metadata; there is no regex or wildcard. Electron apps
// (ChatGPT, editors, ...) announce application.name "Chromium input", so the
// Chromium family is matched by process binary, never by that generic name.
export const CALL_APPLICATIONS = [
  "slack",
  "zen",
  "helium",
  "chromium",
  "chrome",
  "brave",
  "edge",
  "vivaldi",
  "opera",
  "firefox",
  "zoom",
  "teams",
  "discord",
  "signal",
  "telegram",
  "element"
] as const;

export type CallApplication = (typeof CALL_APPLICATIONS)[number];

export type CallApplicationIdentity = {
  label: string;
  kind: "browser" | "app";
  /** Fresh-config default; existing configs keep their explicit values. */
  defaultEnabled: boolean;
  binaries: readonly string[];
  names: readonly string[];
  ids: readonly string[];
  /** Binary that only identifies this app when application.name starts with one of these prefixes. */
  sharedBinary?: { binary: string; namePrefixes: readonly string[] };
};

export const CALL_APPLICATION_IDENTITIES: Record<CallApplication, CallApplicationIdentity> = {
  slack: { label: "Slack", kind: "app", defaultEnabled: true, binaries: ["slack"], names: ["slack"], ids: [] },
  zen: { label: "Zen", kind: "browser", defaultEnabled: true, binaries: ["zen"], names: ["zen"], ids: ["app.zen_browser.zen"] },
  helium: { label: "Helium", kind: "browser", defaultEnabled: true, binaries: ["helium"], names: ["helium"], ids: ["helium"] },
  chromium: {
    label: "Chromium",
    kind: "browser",
    defaultEnabled: true,
    binaries: ["chromium", "chromium-browser"],
    names: [],
    ids: ["org.chromium.chromium"],
    // Snap Chromium runs .../chromium-browser/chrome, the same basename as Google Chrome.
    sharedBinary: { binary: "chrome", namePrefixes: ["chromium"] }
  },
  chrome: { label: "Google Chrome", kind: "browser", defaultEnabled: true, binaries: ["chrome", "google-chrome", "google-chrome-stable"], names: [], ids: ["com.google.chrome"] },
  brave: { label: "Brave", kind: "browser", defaultEnabled: true, binaries: ["brave", "brave-browser"], names: [], ids: ["com.brave.browser"] },
  edge: { label: "Microsoft Edge", kind: "browser", defaultEnabled: true, binaries: ["msedge", "microsoft-edge"], names: [], ids: ["com.microsoft.edge"] },
  vivaldi: { label: "Vivaldi", kind: "browser", defaultEnabled: true, binaries: ["vivaldi", "vivaldi-bin"], names: [], ids: ["com.vivaldi.vivaldi"] },
  opera: { label: "Opera", kind: "browser", defaultEnabled: true, binaries: ["opera"], names: [], ids: ["com.opera.opera"] },
  firefox: {
    label: "Firefox",
    kind: "browser",
    defaultEnabled: true,
    binaries: ["firefox", "firefox-bin", "firefox-esr"],
    names: ["firefox"],
    ids: ["org.mozilla.firefox"]
  },
  zoom: { label: "Zoom", kind: "app", defaultEnabled: true, binaries: ["zoom", "zoom.real"], names: ["zoom", "zoom voiceengine"], ids: ["us.zoom.zoom"] },
  teams: {
    label: "Teams for Linux",
    kind: "app",
    defaultEnabled: true,
    binaries: ["teams-for-linux"],
    names: ["teams-for-linux"],
    ids: ["com.github.ismaelmartinez.teams_for_linux"]
  },
  // Personal messengers stay opt-in: enabling them records private calls too.
  discord: { label: "Discord", kind: "app", defaultEnabled: false, binaries: ["discord", "discordptb", "discordcanary"], names: [], ids: ["com.discordapp.discord"] },
  signal: { label: "Signal", kind: "app", defaultEnabled: false, binaries: ["signal-desktop", "signal-desktop-beta"], names: [], ids: ["org.signal.signal"] },
  telegram: { label: "Telegram", kind: "app", defaultEnabled: false, binaries: ["telegram-desktop", "telegram"], names: ["telegram desktop"], ids: ["org.telegram.desktop"] },
  element: { label: "Element", kind: "app", defaultEnabled: false, binaries: ["element-desktop"], names: [], ids: ["im.riot.riot"] }
};

export const isCallApplication = (value: unknown): value is CallApplication =>
  typeof value === "string" && (CALL_APPLICATIONS as readonly string[]).includes(value);

export const callApplicationLabel = (app: CallApplication | undefined): string | undefined =>
  app && isCallApplication(app) ? CALL_APPLICATION_IDENTITIES[app].label : undefined;

export const defaultCallApplications = (): Record<CallApplication, boolean> =>
  Object.fromEntries(
    CALL_APPLICATIONS.map((app) => [app, CALL_APPLICATION_IDENTITIES[app].defaultEnabled])
  ) as Record<CallApplication, boolean>;

export const matchCallApplication = (
  metadata: { binary: string; name: string; id: string },
  enabledApps: Partial<Record<CallApplication, boolean>>
): CallApplication | null => {
  const binary = metadata.binary.toLowerCase();
  const name = metadata.name.toLowerCase();
  const id = metadata.id.toLowerCase();
  for (const app of CALL_APPLICATIONS) {
    if (!enabledApps[app]) continue;
    const identity = CALL_APPLICATION_IDENTITIES[app];
    if (
      identity.sharedBinary &&
      binary === identity.sharedBinary.binary &&
      identity.sharedBinary.namePrefixes.some((prefix) => name.startsWith(prefix))
    ) {
      return app;
    }
    // A shared binary claimed by an earlier identity must not fall through to a
    // later one when that earlier identity is disabled.
    const sharedOwner = CALL_APPLICATIONS.find((other) => {
      const shared = CALL_APPLICATION_IDENTITIES[other].sharedBinary;
      return shared && shared.binary === binary && shared.namePrefixes.some((prefix) => name.startsWith(prefix));
    });
    if (sharedOwner && sharedOwner !== app) continue;
    if (
      (binary && identity.binaries.includes(binary)) ||
      (name && identity.names.includes(name)) ||
      (id && identity.ids.includes(id))
    ) {
      return app;
    }
  }
  return null;
};

/** Process names as reported by `ss -p` (kernel comm, truncated to 15 bytes). */
export const callApplicationForProcessName = (processName: string): CallApplication | null => {
  const lowered = processName.toLowerCase();
  for (const app of CALL_APPLICATIONS) {
    if (CALL_APPLICATION_IDENTITIES[app].binaries.some((binary) => binary.slice(0, 15) === lowered)) {
      return app;
    }
  }
  return null;
};
