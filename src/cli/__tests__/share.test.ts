import { expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../config/defaults";
import type { DeliverShareInput, DeliveryReceipt, DestinationStatus } from "../../destinations";
import { SHARE_MESSAGES, ShareError, type ShareNote } from "../../share/render";
import { runShareCli, type ShareCliDeps } from "../share";
import { CLI_MESSAGES, CLI_USAGE } from "../shared";
import { captureIO, fakeJobs } from "./cli-helpers";

const JOB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOTE: ShareNote = {
  jobId: JOB, title: "Revisão semanal", date: "2026-10-25T12:00:00.000Z", people: ["Ana Souza"], client: "Acme", overview: "Lançamento aprovado.",
  decisions: ["Lançar em março"], actions: [{ text: "Mandar proposta", owner: "Ana", dueDate: "2026-11-01", done: false }],
  notes: ["# Pauta", "- orçamento"], transcript: [{ at: "00:05", speaker: "Ana", text: "Vamos lançar em março." }], link: `falatrace://recording/${JOB}`
};
const STATUSES: DestinationStatus[] = [
  { destination: "obsidian", ready: true, external: false, target: "/vault/FalaTrace" },
  { destination: "notion", ready: false, external: true, problem: SHARE_MESSAGES.notionNotConfigured },
  { destination: "slack", ready: true, external: true, target: "hooks.slack.com/services/T…/B…/***" },
  { destination: "clipboard", ready: true, external: false, target: "clipboard" },
  { destination: "ai-app", ready: true, external: false, target: "ai-app:chatgpt-web", aiApp: "chatgpt-web" }
];

const shareDeps = () => {
  const capture = captureIO();
  const delivered: DeliverShareInput[] = [];
  const deps: ShareCliDeps = {
    io: capture.io,
    loadConfig: async () => structuredClone(DEFAULT_CONFIG),
    jobs: () => fakeJobs([{ id: JOB, sourcePath: "/recordings/meeting.mkv" }]),
    buildNote: async () => ({ note: NOTE, language: "pt-BR" }),
    describe: async () => STATUSES,
    deliver: async (input) => {
      delivered.push(input);
      return { at: "2026-10-25T15:00:00.000Z", destination: input.request.destination, target: "x", sha256: input.share.sha256, result: "sent", warnings: [], content: "secret" } as DeliveryReceipt;
    }
  };
  return { deps, capture, delivered };
};

test("share --dry-run prints the Markdown the destination would get and sends nothing", async () => {
  const plain = shareDeps();
  await runShareCli(["share", JOB, "--to", "clipboard", "--dry-run"], plain.deps);
  expect(plain.capture.out()).toContain("Lançar em março");
  expect(plain.capture.out()).toContain("- [ ] Mandar proposta");
  expect(plain.capture.out()).toContain("# Pauta");
  expect(plain.capture.out()).not.toContain("falatrace_job");
  expect(plain.capture.out()).not.toContain("Vamos lançar em março.");
  expect(plain.delivered).toEqual([]);
  // Obsidian notes carry the frontmatter; "full" adds the transcript; "summary" leaves the notes out.
  const vault = shareDeps();
  await runShareCli(["share", JOB, "--to", "obsidian", "--include", "full", "--dry-run"], vault.deps);
  expect(vault.capture.out()).toContain(`falatrace_job: "${JOB}"`);
  expect(vault.capture.out()).toContain("Vamos lançar em março.");
  const brief = shareDeps();
  await runShareCli(["share", JOB, "--to", "slack", "--include", "summary", "--dry-run"], brief.deps);
  expect(brief.capture.out()).not.toContain("# Pauta");
});

test("Notion, Slack and AI apps need --yes after the destination is shown; local destinations send at once", async () => {
  const refused = shareDeps();
  await expect(runShareCli(["share", JOB, "--to", "slack"], refused.deps)).rejects.toThrow(CLI_MESSAGES.consentRequired);
  expect(refused.capture.err()).toBe("Destino: slack → hooks.slack.com/services/T…/B…/*** (fora deste computador)\n");
  expect(refused.delivered).toEqual([]);
  const sent = shareDeps();
  await runShareCli(["share", JOB, "--to", "slack", "--yes"], sent.deps);
  expect(sent.delivered).toHaveLength(1);
  expect(sent.delivered[0]).toMatchObject({ request: { destination: "slack" }, consent: true, expectedSnapshot: sent.delivered[0]!.share.snapshot });
  const receipt = JSON.parse(sent.capture.out());
  expect(receipt.result).toBe("sent");
  expect(receipt.content).toBeUndefined();
  const clipboard = shareDeps();
  await runShareCli(["share", JOB, "--to", "clipboard"], clipboard.deps);
  expect(clipboard.delivered[0]).toMatchObject({ request: { destination: "clipboard", mode: "system" } });
  expect(clipboard.delivered[0]!.consent).toBeUndefined();
  const appRefused = shareDeps();
  await expect(runShareCli(["share", JOB, "--to", "ai-app"], appRefused.deps)).rejects.toThrow(CLI_MESSAGES.consentRequired);
  expect(appRefused.capture.err()).toBe("Destino: ai-app → ai-app:chatgpt-web (fora deste computador)\n");
  expect(appRefused.delivered).toEqual([]);
  const app = shareDeps();
  await runShareCli(["share", JOB, "--to", "ai-app", "--yes"], app.deps);
  expect(app.delivered[0]).toMatchObject({ request: { destination: "ai-app", clipboard: "system", open: true }, consent: true });
});

test("share refuses an unready destination with its own message, and checks its arguments", async () => {
  const notion = shareDeps();
  await expect(runShareCli(["share", JOB, "--to", "notion", "--yes"], notion.deps)).rejects.toThrow(SHARE_MESSAGES.notionNotConfigured);
  expect(notion.delivered).toEqual([]);
  const { deps } = shareDeps();
  await expect(runShareCli(["share"], deps)).rejects.toThrow(CLI_USAGE.share);
  await expect(runShareCli(["share", JOB], deps)).rejects.toThrow(CLI_MESSAGES.shareDestinationRequired);
  await expect(runShareCli(["share", JOB, "--to", "email"], deps)).rejects.toThrow(CLI_MESSAGES.shareDestinationRequired);
  await expect(runShareCli(["share", JOB, "--to", "slack", "--include", "all"], deps)).rejects.toThrow(CLI_MESSAGES.shareIncludeInvalid);
  await expect(runShareCli(["share", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "--to", "slack"], deps)).rejects.toThrow(CLI_MESSAGES.jobNotFound);
  await expect(runShareCli(["share", JOB, "--to", "slack", "--force"], deps)).rejects.toThrow("--force");
});

test("a recording without a usable transcript is refused in Portuguese, never with a raw file error", async () => {
  const missing = shareDeps();
  const enoent = Object.assign(new Error("ENOENT: no such file or directory, lstat '/home/ana/Vídeos/x.recording/transcript.json'"), { code: "ENOENT" });
  missing.deps.buildNote = async () => { throw enoent; };
  await expect(runShareCli(["share", JOB, "--to", "clipboard", "--dry-run"], missing.deps)).rejects.toThrow(CLI_MESSAGES.shareUnreadable);
  await expect(runShareCli(["share", JOB, "--to", "slack", "--yes"], missing.deps)).rejects.toThrow(CLI_MESSAGES.shareUnreadable);
  expect(missing.delivered).toEqual([]);
  expect(missing.capture.out()).toBe("");
  // The share module's own (Portuguese) messages pass through unchanged.
  const invalid = shareDeps();
  invalid.deps.buildNote = async () => { throw new ShareError(SHARE_MESSAGES.invalidNote, "invalid"); };
  await expect(runShareCli(["share", JOB, "--to", "clipboard", "--dry-run"], invalid.deps)).rejects.toThrow(SHARE_MESSAGES.invalidNote);
});
