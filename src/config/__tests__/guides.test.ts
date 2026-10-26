import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { defaultActionsDir } from "../../actions/store";
import { defaultChatGptDir } from "../../assistant/chatgpt/store";
import { ACP_AGENTS } from "../../assistant/providers/acp";
import { buildCliInvocation } from "../../assistant/providers/cli";
import { API_PRESETS } from "../../assistant/providers/openai-compatible";
import { defaultThreadsDir } from "../../assistant/threads";
import { calendarLinksDir } from "../../calendar/links";
import { calendarSaltPath } from "../../calendar/upcoming";
import { commandHelp, mainHelp } from "../../cli/help";
import { defaultClientOverridesPath } from "../../clients/overrides";
import { studioInboxDir } from "../../desktop/open-request";
import { defaultDeliveryLogDir } from "../../destinations/log";
import { googleStateDir } from "../../google/oauth";
import { defaultIndexRoot } from "../../library-index/store";
import { defaultLiveDir } from "../../live/store";
import { firstRunPath } from "../../metrics/first-run";
import { defaultNotesDir } from "../../notes/store";
import { defaultPeopleDir } from "../../people/store";
import { BUILT_IN_RECIPES } from "../../recipes/catalog";
import { defaultRecipesDir } from "../../recipes/store";
import { meetingOverridesPath } from "../../reminders/overrides";
import { remindersSentPath } from "../../reminders/scheduler";
import { voiceProfilesDir } from "../../speakers/voices";
import { defaultSummaryPrefsDir } from "../../summary/prefs";
import { reviewedSummaryProviderForConfig } from "../../summary/reviewed";
import { BUILT_IN_TEMPLATES } from "../../templates/catalog";
import { defaultTemplatesDir } from "../../templates/store";
import { ASSISTANT_ACP_AGENTS, ASSISTANT_API_PRESETS, ASSISTANT_CLI_TOOLS, DEFAULT_CONFIG } from "../defaults";
import { getConfigPath } from "../load";

// Keeps the user guides (README, quickstarts, docs/*.md written for people, the skill) in step
// with the code they describe: links resolve, cited commands exist, and the tables of providers,
// templates, recipes and data locations match the constants the code uses.

const root = resolve(import.meta.dir, "../../..");
const read = (path: string): string => readFileSync(join(root, path), "utf8");

const GUIDES = [
  "README.md",
  "docs/QUICKSTART.md",
  "docs/QUICKSTART.pt-BR.md",
  "docs/NOTES-AND-TEMPLATES.md",
  "docs/ASSISTANT.md",
  "docs/PEOPLE-CLIENTS-ACTIONS.md",
  "docs/REMINDERS-AND-LIVE.md",
  "docs/SHARING.md",
  "docs/PRIVACY.md",
  "docs/EVIDENCE-AND-LIMITS.md",
  "docs/DEVELOPMENT.md",
  "docs/ONBOARDING.md",
  "docs/CONFIGURATION.md",
  "docs/COMPATIBILITY.md",
  "docs/HUMAN-REVIEW-EXPORT.md",
  "SECURITY.md",
  "skills/falatrace/SKILL.md",
  "skills/falatrace/references/commands.md"
];

/** GitHub's heading anchor: lower case, punctuation dropped (letters, digits, spaces, - and _ kept), spaces to "-". */
const slug = (heading: string): string =>
  heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");

const anchorsOf = (markdown: string): Set<string> => {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const match = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    const base = slug((match[1] ?? "").replace(/<!--.*?-->/g, ""));
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    anchors.add(count ? `${base}-${count}` : base);
  }
  return anchors;
};

/** Relative link targets of a Markdown file: [text](target) and src/href attributes, outside code. */
const linksOf = (markdown: string): string[] => {
  const prose = markdown.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  const targets = [...prose.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1] ?? "");
  targets.push(...[...prose.matchAll(/(?:src|srcset|href)="([^"]+)"/g)].map((match) => match[1] ?? ""));
  return targets.filter((target) => !/^(?:https?:|mailto:)/.test(target));
};

describe("user guides", () => {
  test("every relative link and anchor resolves", () => {
    const problems: string[] = [];
    let checked = 0;
    for (const file of GUIDES) {
      const text = read(file);
      for (const target of linksOf(text)) {
        checked += 1;
        const [path, anchor] = target.split("#") as [string, string | undefined];
        const absolute = path ? resolve(root, dirname(file), decodeURIComponent(path)) : join(root, file);
        if (!existsSync(absolute)) { problems.push(`${file}: ${target} (missing file)`); continue; }
        if (anchor !== undefined && absolute.endsWith(".md") && !anchorsOf(readFileSync(absolute, "utf8")).has(anchor)) {
          problems.push(`${file}: ${target} (missing anchor)`);
        }
      }
    }
    expect(problems).toEqual([]);
    expect(checked).toBeGreaterThan(80);
  });

  test("every falatrace command and flag they cite exists in the CLI help", () => {
    const overview = mainHelp("0.0.0");
    const problems: string[] = [];
    let cited = 0;
    for (const file of GUIDES) {
      const text = read(file);
      // Commands in code: whole lines of fenced blocks and inline code spans.
      const code = [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].flatMap((match) => (match[1] ?? "").split("\n"))
        .concat([...text.replace(/```[\s\S]*?```/g, "").matchAll(/`([^`\n]+)`/g)].map((match) => match[1] ?? ""));
      for (const snippet of code) {
        for (const match of snippet.matchAll(/(?:^|[\s|;(])falatrace\s+([a-z][a-z-]*)((?:\s+[^\s|;#)]+)*)/g)) {
          const command = match[1] ?? "";
          cited += 1;
          const help = commandHelp(command) ?? overview;
          if (!commandHelp(command) && !new RegExp(`^\\s+(?:[a-z-]+\\s*\\|\\s*)*${command}\\b`, "m").test(overview)) {
            problems.push(`${file}: falatrace ${command} (unknown command)`);
            continue;
          }
          const words = (match[2] ?? "").trim().split(/\s+/).filter(Boolean);
          const sub = words[0];
          if (sub && /^[a-z][a-z-]*$/.test(sub) && !new RegExp(`(^|[\\s|])${sub}([\\s|]|$)`, "m").test(help)) {
            problems.push(`${file}: falatrace ${command} ${sub} (unknown subcommand)`);
          }
          for (const flag of words.map((word) => /^--[a-z][a-z-]*/.exec(word)?.[0]).filter((found): found is string => found !== undefined)) {
            if (!help.includes(flag) && !overview.includes(flag)) problems.push(`${file}: falatrace ${command} ${flag} (unknown flag)`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
    expect(cited).toBeGreaterThan(80);
  });
});

describe("docs/ASSISTANT.md", () => {
  const assistant = read("docs/ASSISTANT.md");
  /** The text from a heading to the next heading of any level. */
  const section = (heading: string): string => {
    const start = assistant.indexOf(`\n${heading}\n`);
    if (start < 0) return "";
    const next = assistant.slice(start + heading.length + 2).search(/\n#{1,6} /);
    return next < 0 ? assistant.slice(start) : assistant.slice(start, start + heading.length + 2 + next);
  };
  /** The table row of `id` within one section. */
  const rowIn = (text: string, id: string): string => text.split("\n").find((line) => line.startsWith(`| \`${id}\``)) ?? "";
  const shown = (argv: string[]): string => argv.map((arg) => (arg === "" ? '""' : /[\s*]/.test(arg) ? `"${arg}"` : arg)).join(" ");

  test("the API preset table matches the presets' endpoints and keys", () => {
    const api = section("### API: your own key");
    for (const id of ASSISTANT_API_PRESETS) expect(rowIn(api, id)).not.toBe("");
    for (const [id, preset] of Object.entries(API_PRESETS)) {
      expect(rowIn(api, id)).toContain(`\`${preset.keyName}\``);
      if (preset.baseURL) expect(rowIn(api, id)).toContain(`\`${preset.baseURL}\``);
    }
    expect(rowIn(api, "anthropic")).toContain("`ANTHROPIC_API_KEY`");
  });

  test("the ACP table names the exact command FalaTrace starts", () => {
    const acp = section("### ACP agents");
    for (const id of ASSISTANT_ACP_AGENTS) expect(rowIn(acp, id)).not.toBe("");
    for (const [id, preset] of Object.entries(ACP_AGENTS)) expect(rowIn(acp, id)).toContain(`\`${shown([preset.command, ...preset.args])}\``);
  });

  test("the subscription CLI table matches the argv FalaTrace runs", () => {
    const cli = section("### Subscription CLIs");
    for (const id of ASSISTANT_CLI_TOOLS) expect(rowIn(cli, id)).not.toBe("");
    const paths = { cwd: "/w", outputFile: "/w/out" };
    expect(rowIn(cli, "claude")).toContain(`\`${shown(buildCliInvocation("claude", "claude", "", paths).argv)}\``);
    expect(rowIn(cli, "opencode")).toContain(`\`${shown(buildCliInvocation("opencode", "opencode", "", paths).argv)}\``);
    expect(rowIn(cli, "codex")).toContain(`\`${shown(buildCliInvocation("codex", "codex", "", paths).argv.slice(0, 7))} …\``);
    expect(rowIn(cli, "gemini")).toContain("-o json");
  });

  test("the recipe table lists every built-in recipe", () => {
    const listed = assistant.split("\n").filter((line) => /^\| `[a-z-]+` \| .+ \| (meeting|library)/.test(line)).map((line) => /^\| `([a-z-]+)`/.exec(line)?.[1]);
    expect(listed).toEqual(BUILT_IN_RECIPES.map((recipe) => recipe.id));
  });
});

test("docs/NOTES-AND-TEMPLATES.md lists every built-in template with its sections", () => {
  const notes = read("docs/NOTES-AND-TEMPLATES.md");
  for (const template of BUILT_IN_TEMPLATES) {
    const line = notes.split("\n").find((candidate) => candidate.startsWith(`| \`${template.id}\` |`)) ?? "";
    expect(line).toContain(`${template.name["pt-BR"]} / ${template.name.en}`);
    expect(line).toContain(template.sections.map((section) => section.title.en).join(", "));
  }
});

test("docs/PRIVACY.md names the real location of every private store", () => {
  const privacy = read("docs/PRIVACY.md");
  const config = dirname(getConfigPath());
  const data = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "recording-cli");
  const state = join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "recording-cli");
  const runtime = process.env.XDG_RUNTIME_DIR?.startsWith("/") ? join(process.env.XDG_RUNTIME_DIR, "recording-cli") : state;
  const stores: Array<[string, string]> = [
    [config, defaultTemplatesDir()], [config, defaultRecipesDir()],
    [data, defaultNotesDir()], [data, defaultSummaryPrefsDir()], [data, defaultThreadsDir()], [data, join(defaultPeopleDir(), "people.json")],
    [data, defaultClientOverridesPath()], [data, defaultActionsDir()], [data, calendarLinksDir()], [data, join(voiceProfilesDir(), "profiles.json")],
    [state, defaultIndexRoot()], [state, defaultLiveDir()], [state, defaultDeliveryLogDir()], [state, join(defaultChatGptDir(), "oauth.json")],
    [state, join(googleStateDir(), "oauth.json")], [state, meetingOverridesPath()], [state, remindersSentPath()], [state, calendarSaltPath()],
    [state, firstRunPath()], [runtime, studioInboxDir()]
  ];
  const missing = stores.map(([base, path]) => relative(base, path)).filter((path) => path.startsWith("..") || !privacy.includes(`\`${path}`));
  expect(missing).toEqual([]);
  // Published transcripts and summaries live next to the recording, not in the data folder.
  expect(privacy).toMatch(/`<name>\.recording\/` folder holds a `<job-id>\/` folder[^\n]*`transcript\.json`[^\n]*`summary\.json`/);
});

test("the guides do not promise regeneration through an external summary provider", () => {
  // Reviewed regeneration (Studio and summary-review) refuses anything but Ollama on loopback.
  const config = structuredClone(DEFAULT_CONFIG);
  config.summary.provider = "ollama";
  config.summary.ollamaUrl = "http://127.0.0.1:11434";
  expect(reviewedSummaryProviderForConfig(config).provider).toBe("ollama");
  config.summary.ollamaUrl = "http://192.168.1.20:11434";
  expect(() => reviewedSummaryProviderForConfig(config)).toThrow("loopback");
  config.summary.provider = "openai";
  expect(() => reviewedSummaryProviderForConfig(config)).toThrow("local Ollama only");
  const notes = read("docs/NOTES-AND-TEMPLATES.md");
  const section = notes.slice(notes.indexOf("## Regenerating"));
  expect(section).toContain("only with Ollama on this computer");
  expect(section).not.toMatch(/OpenAI[^\n]*asks for consent/);
});

test("a new guide in docs/ is added to the checked list", () => {
  // Release notes and older review records are history; every other docs/*.md is a guide checked above.
  const history = [
    "ALPHA2-LOCAL-REVIEW.md", "CAPTURE-CALL-LIGHT.md", "LOCAL-AGENT-RETRIEVAL-CONTRACT.md", "MEMORY-INTEGRATION-REVIEW.md", "OPUS-REVIEW-RESOLUTION.md",
    "REVIEWED-SNAPSHOT-COMPATIBILITY.md", "ROADMAP.md", "TIMESHEETS.md", "UX-VERIFICATION.md"
  ];
  const unchecked = readdirSync(join(root, "docs"))
    .filter((name) => name.endsWith(".md") && !/^ALPHA\d+\.md$/.test(name) && !history.includes(name) && !GUIDES.includes(`docs/${name}`));
  expect(unchecked).toEqual([]);
});
