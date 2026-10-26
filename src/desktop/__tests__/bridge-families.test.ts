import { describe, expect, test } from "bun:test";
import { desktopRequestAdmitted, familyOf, parseRequest } from "../bridge";
import { ASSISTANT_BRIDGE_OPERATIONS } from "../assistant-bridge";
import { ENTITIES_BRIDGE_OPERATIONS } from "../entities-bridge";
import { HOME_BRIDGE_OPERATIONS } from "../home-bridge";
import { MEDIA_BRIDGE_OPERATIONS } from "../media-bridge";
import { NOTES_BRIDGE_OPERATIONS } from "../notes-bridge";
import { SHARE_BRIDGE_OPERATIONS } from "../share-bridge";
import { SUMMARY_BRIDGE_OPERATIONS } from "../summary-bridge";

/**
 * Every operation of the new Studio (DESIGN-STUDIO §4) is accepted with its documented payload and
 * refused with anything else: unknown keys, unbounded strings, malformed ids and loose scope objects.
 */
const job = "123e4567-e89b-42d3-a456-426614174042";
const other = "223e4567-e89b-42d3-a456-426614174043";
const hash = "a".repeat(64);
const path = "/home/user/recordings/call.mkv";
const request = (op: string, payload?: Record<string, unknown>, key?: string) => ({ id: 1, op, ...(key === undefined ? {} : { key }), ...(payload === undefined ? {} : { payload }) });
const accepts = (op: string, payload?: Record<string, unknown>, key?: string) => expect(parseRequest(request(op, payload, key)).op).toBe(op as never);
const refuses = (op: string, payload?: Record<string, unknown>, key?: string) => expect(() => parseRequest(request(op, payload, key)), JSON.stringify([op, payload, key])).toThrow();

describe("new bridge operations: accepted shapes", () => {
  test("notes and live transcript", () => {
    accepts("notes-read", undefined, job);
    accepts("notes-save", { text: "# Pauta\n- [ ] enviar ata\n\tcom tab", expectedRev: 0 }, job);
    accepts("notes-save", { text: "", expectedRev: 3, title: "" }, job);
    accepts("live-read", { sinceSeq: 0 }, job);
    accepts("live-read", { sinceSeq: 12, limit: 500 }, job);
    accepts("live-set", { enabled: true, consent: true }, job);
    accepts("live-set", { enabled: true, consent: true, provider: "groq" }, job);
    accepts("live-set", { enabled: false }, job);
  });

  test("summary status, choices and templates", () => {
    accepts("summary-status", { requestId: other }, job);
    accepts("summary-status", { requestId: other });
    accepts("summary-prefs-read", undefined, job);
    accepts("summary-prefs-save", { expectedRev: 0, templateId: "postmortem", language: "en" }, job);
    accepts("summary-prefs-save", { expectedRev: 1, templateId: "auto", language: "auto" }, job);
    accepts("summary-prefs-save", { expectedRev: 1, templateId: "custom:retro-time" }, job);
    accepts("summary-plan", { requestId: other, maxRequests: 1, templateId: "postmortem", language: "es", useNotes: false }, job);
    accepts("summary-plan", { requestId: other, maxRequests: 2, templateId: "auto" }, job);
    accepts("templates-list");
    accepts("templates-save", { template: { id: "custom:x", name: { "pt-BR": "X", en: "X", es: "X" } } });
    accepts("templates-save", { template: { id: "custom:x" }, expectedVersion: 2 });
    accepts("templates-delete", { id: "custom:x", expectedVersion: 1 });
  });

  test("assistant and recipes", () => {
    for (const scope of [{ kind: "meeting", jobId: job }, { kind: "library" }, { kind: "person", personId: "name:ana souza" }, { kind: "person", personId: other }, { kind: "client", clientCode: "ACME-1" }]) {
      accepts("assistant-plan", { scope, question: "O que foi decidido?" });
      accepts("assistant-threads", { scope });
    }
    accepts("assistant-plan", { scope: { kind: "meeting", jobId: job }, question: "", recipeId: "follow-up-email" });
    accepts("assistant-start", { scope: { kind: "library" }, question: "Quem prometeu o quê?\nE quando?", threadId: other, consentKey: hash });
    accepts("assistant-start", { scope: { kind: "meeting", jobId: job }, question: "", recipeId: "custom:minha-receita" });
    accepts("assistant-poll", { runId: other });
    accepts("assistant-cancel", { runId: other });
    accepts("assistant-thread", { threadId: other });
    accepts("assistant-thread-delete", { threadId: other });
    for (const op of ["assistant-detect", "assistant-chatgpt-login", "assistant-chatgpt-status", "assistant-chatgpt-logout", "recipes-list"]) accepts(op);
    accepts("recipes-save", { recipe: { id: "custom:a" } });
    accepts("recipes-save", { recipe: { id: "custom:a" }, expectedVersion: 3 });
    accepts("recipes-delete", { id: "custom:a" });
  });

  test("share", () => {
    accepts("share-preview", { destination: "clipboard", include: "summary", jobId: job });
    accepts("share-preview", { destination: "notion", include: "full", jobId: job, frontmatter: true });
    accepts("share-preview", { destination: "obsidian", include: "summary", text: "Resposta com [1]", title: "Pergunta", recipeId: "risks" });
    accepts("share-send", { previewId: other });
    accepts("share-send", { previewId: other, consent: true });
  });

  test("actions, people and clients", () => {
    accepts("actions-list", { status: "open" });
    accepts("actions-list", { status: "all", personId: "name:ana", clientCode: "ACME", jobId: job });
    accepts("action-set", { mediaSha256: hash, actionId: other, status: "done", expectedRev: 4 });
    accepts("people-list");
    accepts("people-list", { includeHidden: true });
    accepts("person-detail", { personId: "name:ana souza" });
    accepts("person-edit", { personId: "name:ana", op: "rename", value: "Ana Souza" });
    accepts("person-edit", { personId: other, op: "merge", targetId: "name:ana" });
    accepts("person-edit", { personId: other, op: "hide", expectedRev: 2 });
    accepts("clients-list");
    accepts("client-detail", { clientCode: "ACME" });
    accepts("client-edit", { op: "add", name: "Acme" });
    accepts("client-edit", { op: "add", code: "", name: "Acme" });
    accepts("client-edit", { op: "add", code: "ACME", name: "Acme" });
    accepts("client-edit", { op: "rename", code: "ACME", name: "Acme Ltda" });
    accepts("client-edit", { op: "delete", code: "ACME" });
    accepts("client-edit", { op: "alias-add", code: "ACME", value: "acme corp" });
    accepts("meeting-client-set", { clientCodes: ["ACME", "BETA"] }, job);
    accepts("meeting-client-set", { clientCodes: [] }, job);
    accepts("meeting-client-set", { automatic: true }, job);
  });

  test("home, links, first run, search and media", () => {
    accepts("home-read");
    accepts("meeting-override", { eventIdHash: hash, decision: "skip" });
    accepts("meeting-override", { eventIdHash: hash, decision: "clear" });
    accepts("inbox-take");
    accepts("first-run-dismiss");
    accepts("library-search", { query: "orçamento" });
    accepts("library-search", { query: "orçamento", limit: 50 });
    accepts("media-plan", undefined, path);
    accepts("media-remove", { mode: "audio-only", consentKey: hash }, path);
    accepts("media-status", { requestId: other });
  });
});

const ALL_NEW_OPERATIONS: readonly string[] = [
  ...NOTES_BRIDGE_OPERATIONS, ...SUMMARY_BRIDGE_OPERATIONS, ...ASSISTANT_BRIDGE_OPERATIONS, ...SHARE_BRIDGE_OPERATIONS, ...ENTITIES_BRIDGE_OPERATIONS,
  ...HOME_BRIDGE_OPERATIONS, ...MEDIA_BRIDGE_OPERATIONS
];

describe("new bridge operations: refused shapes", () => {
  test("unknown keys are refused for every new operation, whatever the key", () => {
    expect(new Set(ALL_NEW_OPERATIONS).size).toBe(43);
    for (const op of ALL_NEW_OPERATIONS) {
      for (const key of [undefined, job, path]) refuses(op, { command: "anything" }, key);
    }
  });

  test("keyed operations refuse a missing or wrong-kind key", () => {
    for (const op of ["notes-read", "summary-prefs-read"]) {
      refuses(op, undefined);
      refuses(op, undefined, path);
    }
    refuses("live-read", { sinceSeq: 0 }, path);
    refuses("live-set", { enabled: false });
    refuses("summary-prefs-save", { expectedRev: 0 }, path);
    refuses("meeting-client-set", { clientCodes: [] });
    for (const op of ["media-plan", "media-remove"]) refuses(op, op === "media-remove" ? { mode: "audio-only", consentKey: hash } : undefined, job);
    refuses("media-plan", undefined);
  });

  test("assistant and entity ids are validated on the operations that take them", () => {
    refuses("assistant-cancel", { runId: "run-1" });
    refuses("assistant-cancel", {});
    refuses("assistant-thread-delete", { threadId: "../thread" });
    refuses("assistant-threads", {});
    refuses("assistant-threads", { scope: { kind: "client", clientCode: "" } });
    refuses("person-detail", {});
    refuses("person-detail", { personId: "name:" });
    refuses("person-edit", { personId: "name:ana", op: "rename", value: "x".repeat(81) });
    refuses("client-detail", { clientCode: "a b" });
    refuses("client-detail", {});
    refuses("people-list", { includeHidden: "yes" });
    refuses("recipes-delete", { id: "custom:a", expectedVersion: 0 });
    refuses("templates-save", { template: { id: "custom:x" }, expectedVersion: "1" });
    refuses("summary-status", {});
    refuses("share-preview", { destination: "clipboard", include: "summary", jobId: job, title: "a\nb" });
    refuses("share-preview", { destination: "clipboard", include: "summary", jobId: job, recipeId: "Not An Id" });
  });

  test("notes, live and summary fields are bounded and typed", () => {
    refuses("notes-read", undefined, "not-a-uuid");
    refuses("notes-read");
    refuses("notes-save", { text: "x" }, job);
    refuses("notes-save", { text: "x", expectedRev: -1 }, job);
    refuses("notes-save", { text: "bell\u0007", expectedRev: 0 }, job);
    refuses("notes-save", { text: "x".repeat(256 * 1024 + 1), expectedRev: 0 }, job);
    refuses("notes-save", { text: "x", expectedRev: 0, title: "two\nlines" }, job);
    refuses("live-read", {}, job);
    refuses("live-read", { sinceSeq: 0, limit: 5000 }, job);
    refuses("live-set", { enabled: "yes" }, job);
    refuses("summary-status", { requestId: "nope" }, job);
    refuses("summary-status", { requestId: other }, "path/key");
    refuses("summary-prefs-save", { expectedRev: 0, templateId: "Bad Id" }, job);
    refuses("summary-prefs-save", { expectedRev: 0, language: "fr" }, job);
    refuses("summary-plan", { requestId: other, maxRequests: 1, templateId: "../etc" }, job);
    refuses("summary-plan", { requestId: other, maxRequests: 1, language: "de" }, job);
    refuses("summary-plan", { requestId: other, maxRequests: 1, useNotes: "true" }, job);
    refuses("templates-save", { template: "not an object" });
    refuses("templates-save", { template: { guidance: "x".repeat(70 * 1024) } });
    refuses("templates-delete", { id: "custom:x" });
    refuses("templates-delete", { id: "/etc/passwd", expectedVersion: 1 });
  });

  test("assistant scopes are strict and questions bounded", () => {
    for (const scope of [undefined, "library", {}, { kind: "library", extra: 1 }, { kind: "meeting" }, { kind: "meeting", jobId: "x" }, { kind: "person", personId: "Ana" },
      { kind: "client", clientCode: "with space" }, { kind: "everything" }, { kind: "meeting", jobId: job, personId: "name:ana" }]) {
      refuses("assistant-plan", { scope, question: "Pergunta" });
    }
    refuses("assistant-plan", { scope: { kind: "library" }, question: "   " });
    refuses("assistant-plan", { scope: { kind: "library" }, question: "x".repeat(4001) });
    refuses("assistant-plan", { scope: { kind: "library" }, question: "ok", recipeId: "../../x" });
    refuses("assistant-start", { scope: { kind: "library" }, question: "ok", consentKey: "short" });
    refuses("assistant-start", { scope: { kind: "library" }, question: "ok", threadId: "thread-1" });
    refuses("assistant-poll", { runId: "1" });
    refuses("assistant-thread", {});
    refuses("recipes-save", { recipe: [] });
    refuses("recipes-delete", { id: "Custom:A" });
  });

  test("share, entities, home and media fields are validated", () => {
    refuses("share-preview", { destination: "email", include: "summary", jobId: job });
    refuses("share-preview", { destination: "clipboard", include: "everything", jobId: job });
    refuses("share-preview", { destination: "clipboard", include: "summary" });
    refuses("share-preview", { destination: "clipboard", include: "summary", text: "  " });
    refuses("share-preview", { destination: "clipboard", include: "summary", jobId: "x" });
    refuses("share-send", { previewId: other, consent: "yes" });
    refuses("actions-list", {});
    refuses("actions-list", { status: "dismissed" });
    refuses("actions-list", { status: "open", personId: "Ana" });
    refuses("action-set", { mediaSha256: "abc", actionId: other, status: "done" });
    refuses("action-set", { mediaSha256: hash, actionId: other, status: "closed" });
    refuses("person-edit", { personId: other, op: "rename" });
    refuses("person-edit", { personId: other, op: "merge" });
    refuses("person-edit", { personId: other, op: "delete" });
    refuses("person-edit", { personId: other, op: "rename", value: "a\nb" });
    refuses("client-edit", { op: "rename", code: "ACME" });
    refuses("client-edit", { op: "delete" });
    refuses("client-edit", { op: "alias-add", code: "ACME" });
    refuses("client-edit", { op: "add", code: "bad code", name: "X" });
    refuses("meeting-client-set", { clientCodes: ["A", "A"] }, job);
    refuses("meeting-client-set", { clientCodes: "ACME" }, job);
    refuses("meeting-client-set", { automatic: false }, job);
    refuses("meeting-client-set", { automatic: true, clientCodes: [] }, job);
    refuses("meeting-client-set", { clientCodes: [] }, path);
    refuses("meeting-override", { eventIdHash: "abc", decision: "skip" });
    refuses("meeting-override", { eventIdHash: hash, decision: "maybe" });
    refuses("library-search", { query: "" });
    refuses("library-search", { query: "x", limit: 500 });
    refuses("media-plan", undefined, "relative/path.mkv");
    refuses("media-remove", { mode: "everything", consentKey: hash }, path);
    refuses("media-remove", { mode: "audio-only" }, path);
    refuses("media-status", {});
  });

  test("every new operation belongs to one family; cancellations are admitted at the request limit", () => {
    for (const op of ALL_NEW_OPERATIONS) expect(familyOf(op), op).toBeDefined();
    expect(familyOf("summary-plan")).toBeUndefined();
    expect(desktopRequestAdmitted(32, "assistant-cancel")).toBe(true);
    expect(desktopRequestAdmitted(32, "summary-cancel")).toBe(true);
    expect(desktopRequestAdmitted(32, "assistant-start")).toBe(false);
    expect(desktopRequestAdmitted(31, "assistant-start")).toBe(true);
  });
});
