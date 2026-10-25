import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { mediaSha, removeTempDirs, tempDir, uuid } from "../../people/__tests__/fixtures";
import {
  ACTION_LIMITS,
  ACTIONS_ERRORS,
  ACTIONS_KNOWN_ERRORS,
  ActionsStore,
  type ActionsFile,
  type CurrentAction,
  actionFingerprint,
  actionTokens,
  deriveActionId,
  jaccard,
  parseDueDate,
  reconcileActions,
  setActionStatus,
  validateActionsFile
} from "../store";

afterEach(removeTempDirs);

const MEDIA = mediaSha(1);
const JOB = uuid(1);
const now = "2026-10-25T12:00:00.000Z";
const later = "2026-10-26T12:00:00.000Z";

const current = (key: string, text: string, extra: Partial<CurrentAction> = {}): CurrentAction =>
  ({ key, text, owner: "", dueDate: "", segmentIds: [], origin: "model", ...extra });

const input = (actions: CurrentAction[], extra: Partial<Parameters<typeof reconcileActions>[2]> = {}) =>
  ({ jobId: JOB, jobIds: [JOB], transcriptArtifactSha256: "b".repeat(64), revision: 0, actions, now, ...extra });

const markDone = (file: ActionsFile, id: string): ActionsFile => ({
  ...file, items: file.items.map((item) => (item.id === id ? { ...item, status: "done", statusChangedAt: now } : item))
});

describe("action text helpers", () => {
  test("fingerprint ignores case, accents and spacing", () => {
    expect(actionFingerprint("Enviar  a proposta à Ana")).toBe(actionFingerprint("enviar a proposta a ana"));
    expect(actionFingerprint("Enviar proposta")).not.toBe(actionFingerprint("Enviar contrato"));
  });

  test("token Jaccard drops short words and stopwords, keeps digits", () => {
    expect([...actionTokens("Enviar a proposta para a Ana")]).toEqual(["enviar", "proposta", "ana"]);
    expect(jaccard(actionTokens("Enviar relatório 1"), actionTokens("Enviar relatório 2"))).toBeLessThan(0.8);
    expect(jaccard(actionTokens("Enviar proposta revisada"), actionTokens("Enviar a proposta revisada ao cliente"))).toBeCloseTo(3 / 4);
    expect(jaccard(new Set(), new Set())).toBe(0);
  });

  test("due dates are kept only when they are calendar dates", () => {
    expect(parseDueDate("até 2026-11-03")).toBe("2026-11-03");
    expect(parseDueDate("sexta, 7/11/2026")).toBe("2026-11-07");
    expect(parseDueDate("2026-02-30")).toBeUndefined();
    expect(parseDueDate("semana que vem")).toBeUndefined();
  });

  test("derived ids are stable UUIDs that avoid taken ones", () => {
    const fp = actionFingerprint("x");
    const first = deriveActionId(MEDIA, fp, new Set());
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(deriveActionId(MEDIA, fp, new Set())).toBe(first);
    const second = deriveActionId(MEDIA, fp, new Set([first]));
    expect(second).not.toBe(first);
    expect(deriveActionId(mediaSha(2), fp, new Set())).not.toBe(first);
  });
});

describe("reconcileActions", () => {
  test("first sight creates open items anchored to the summary", () => {
    const { file, changed, matches } = reconcileActions(undefined, MEDIA, input([
      current("a", "Enviar a proposta", { owner: "Ana", dueDate: "2026-11-03", segmentIds: ["s000010"] }),
      current("b", "Agendar revisão", { origin: "note" })
    ]));
    expect(changed).toBe(true);
    expect(file.rev).toBe(1);
    expect(file.jobIds).toEqual([JOB]);
    expect(file.items).toHaveLength(2);
    expect(file.items[0]).toMatchObject({
      origin: "model", text: "Enviar a proposta", ownerText: "Ana", dueDate: "2026-11-03", status: "open", matchState: "current",
      anchor: { jobId: JOB, transcriptArtifactSha256: "b".repeat(64), revision: 0, fingerprint: actionFingerprint("Enviar a proposta"), segmentIds: ["s000010"], summarySource: "original" }
    });
    expect(file.items[1]).toMatchObject({ origin: "note", text: "Agendar revisão" });
    expect(file.items[1]).not.toHaveProperty("ownerText");
    expect(matches.get("a")).toBe(file.items[0]!.id);
    expect(() => validateActionsFile(file, MEDIA)).not.toThrow();
  });

  test("a recording without actions needs no state", () => {
    const result = reconcileActions(undefined, MEDIA, input([]));
    expect(result.changed).toBe(false);
    expect(result.file.items).toEqual([]);
  });

  test("the same summary again changes nothing", () => {
    const first = reconcileActions(undefined, MEDIA, input([current("a", "Enviar a proposta", { owner: "Ana" })]));
    const second = reconcileActions(first.file, MEDIA, input([current("a", "Enviar a proposta", { owner: "Ana" })], { now: later }));
    expect(second.changed).toBe(false);
    expect(second.file).toBe(first.file);
  });

  test("regeneration that reorders and recases keeps ids and status (exact fingerprint)", () => {
    const first = reconcileActions(undefined, MEDIA, input([current("a", "Enviar a proposta"), current("b", "Ligar para o Bruno")]));
    const done = markDone(first.file, first.file.items[0]!.id);
    const regenerated = reconcileActions(done, MEDIA, input([current("x", "LIGAR para o bruno"), current("y", "Enviar a  proposta")], { jobId: JOB, revision: 2, now: later }));
    expect(regenerated.file.items.map((item) => item.id)).toEqual(first.file.items.map((item) => item.id));
    expect(regenerated.matches.get("y")).toBe(first.file.items[0]!.id);
    expect(regenerated.file.items[0]).toMatchObject({ status: "done", text: "Enviar a  proposta", matchState: "current", anchor: { revision: 2, summarySource: "reviewed" } });
    expect(regenerated.file.items[0]!.updatedAt).toBe(later);
    expect(regenerated.file.rev).toBe(2);
  });

  test("reworded actions re-match by token Jaccard when they cite the same segments", () => {
    const first = reconcileActions(undefined, MEDIA, input([current("a", "Enviar a proposta revisada para a Ana", { segmentIds: ["s000010", "s000011"] })]));
    const done = markDone(first.file, first.file.items[0]!.id);
    const regenerated = reconcileActions(done, MEDIA, input([
      current("z", "Enviar proposta revisada à Ana amanhã", { segmentIds: ["s000011", "s000012"], owner: "Ana" })
    ], { now: later }));
    expect(regenerated.file.items).toHaveLength(1);
    expect(regenerated.file.items[0]).toMatchObject({ id: first.file.items[0]!.id, status: "done", matchState: "current", text: "Enviar proposta revisada à Ana amanhã", ownerText: "Ana" });
    expect(regenerated.file.items[0]!.anchor!.fingerprint).toBe(actionFingerprint("Enviar proposta revisada à Ana amanhã"));
    expect(regenerated.file.items[0]!.anchor!.segmentIds).toEqual(["s000011", "s000012"]);
  });

  test("similar wording without overlapping segments is not the same action", () => {
    const first = reconcileActions(undefined, MEDIA, input([current("a", "Enviar a proposta revisada para a Ana", { segmentIds: ["s000010"] })]));
    const done = markDone(first.file, first.file.items[0]!.id);
    const regenerated = reconcileActions(done, MEDIA, input([current("z", "Enviar proposta revisada à Ana amanhã", { segmentIds: ["s000099"] })], { now: later }));
    expect(regenerated.file.items).toHaveLength(2);
    expect(regenerated.file.items[0]).toMatchObject({ id: first.file.items[0]!.id, matchState: "orphaned", status: "done", text: "Enviar a proposta revisada para a Ana" });
    expect(regenerated.file.items[1]).toMatchObject({ matchState: "current", status: "open", text: "Enviar proposta revisada à Ana amanhã" });
  });

  test("low similarity with overlapping segments is not the same action either", () => {
    const first = reconcileActions(undefined, MEDIA, input([current("a", "Enviar a proposta para a Ana", { segmentIds: ["s000010"] })]));
    const regenerated = reconcileActions(first.file, MEDIA, input([current("z", "Revisar orçamento do trimestre", { segmentIds: ["s000010"] })], { now: later }));
    expect(regenerated.file.items.map((item) => item.matchState)).toEqual(["orphaned", "current"]);
  });

  test("without citations on either side only near-identical wording re-matches", () => {
    const first = reconcileActions(undefined, MEDIA, input([current("a", "Atualizar planilha de custos da operação"), current("b", "Enviar contrato assinado ao jurídico")]));
    const regenerated = reconcileActions(first.file, MEDIA, input([
      current("x", "Atualizar planilha de custos da operação hoje"), // Jaccard 4/5 = 0.8
      current("y", "Enviar contrato ao financeiro")                   // Jaccard 2/5
    ], { now: later }));
    expect(regenerated.matches.get("x")).toBe(first.file.items[0]!.id);
    expect(regenerated.file.items.find((item) => item.id === first.file.items[1]!.id)!.matchState).toBe("orphaned");
    expect(regenerated.file.items).toHaveLength(3);
  });

  test("an orphan comes back when its action reappears, status intact", () => {
    const first = reconcileActions(undefined, MEDIA, input([current("a", "Enviar a proposta")]));
    const done = markDone(first.file, first.file.items[0]!.id);
    const dropped = reconcileActions(done, MEDIA, input([], { now: later }));
    expect(dropped.changed).toBe(true);
    expect(dropped.file.items[0]).toMatchObject({ matchState: "orphaned", status: "done" });
    const back = reconcileActions(dropped.file, MEDIA, input([current("a", "Enviar a proposta")], { now: later }));
    expect(back.file.items[0]).toMatchObject({ id: first.file.items[0]!.id, matchState: "current", status: "done" });
  });

  test("repeated wording pairs up one to one", () => {
    const first = reconcileActions(undefined, MEDIA, input([current("a", "Revisar"), current("b", "Revisar")]));
    expect(new Set(first.file.items.map((item) => item.id)).size).toBe(2);
    const again = reconcileActions(first.file, MEDIA, input([current("a", "Revisar"), current("b", "Revisar"), current("c", "Revisar")], { now: later }));
    expect(again.file.items).toHaveLength(3);
    expect(again.file.items.slice(0, 2).map((item) => item.id)).toEqual(first.file.items.map((item) => item.id));
  });

  test("a regenerated summary gets the best pairing, not the first", () => {
    const first = reconcileActions(undefined, MEDIA, input([
      current("a", "Revisar contrato do cliente Acme", { segmentIds: ["s000001"] }),
      current("b", "Revisar contrato do fornecedor Beta", { segmentIds: ["s000001"] })
    ]));
    const regenerated = reconcileActions(first.file, MEDIA, input([
      current("y", "Revisar contrato fornecedor Beta hoje", { segmentIds: ["s000001"] }),
      current("x", "Revisar contrato cliente Acme hoje", { segmentIds: ["s000001"] })
    ], { now: later }));
    expect(regenerated.matches.get("x")).toBe(first.file.items[0]!.id);
    expect(regenerated.matches.get("y")).toBe(first.file.items[1]!.id);
  });

  test("manual items are never re-matched or orphaned", () => {
    const base: ActionsFile = {
      version: 1, mediaSha256: MEDIA, jobIds: [JOB], rev: 4,
      items: [{ id: uuid(77), origin: "user", text: "Enviar a proposta", status: "open", matchState: "current", createdAt: now, updatedAt: now }]
    };
    const result = reconcileActions(base, MEDIA, input([current("a", "Enviar a proposta")], { now: later }));
    expect(result.file.items[0]).toEqual(base.items[0]!);
    expect(result.file.items).toHaveLength(2);
    expect(result.matches.get("a")).not.toBe(uuid(77));
  });

  test("a reprocessed recording (new job) adopts the media's state", () => {
    const first = reconcileActions(undefined, MEDIA, input([current("a", "Enviar a proposta")]));
    const done = markDone(first.file, first.file.items[0]!.id);
    const reprocessed = reconcileActions(done, MEDIA, input([current("a", "Enviar a proposta")], { jobId: uuid(2), jobIds: [uuid(2), JOB], now: later }));
    expect(reprocessed.file.jobIds).toEqual([JOB, uuid(2)]);
    expect(reprocessed.file.items[0]).toMatchObject({ id: first.file.items[0]!.id, status: "done", anchor: { jobId: uuid(2) } });
  });

  test("the file stays bounded: decided orphans outlive open ones", () => {
    let file: ActionsFile | undefined;
    const batch = (round: number) => Array.from({ length: 100 }, (_, index) => current(`${round}-${index}`, `Rodada${round} tarefa${index} distinta`));
    file = reconcileActions(undefined, MEDIA, input(batch(1))).file;
    file = { ...file, items: file.items.map((item, index) => (index < 10 ? { ...item, status: "done" as const } : item)) };
    file = reconcileActions(file, MEDIA, input(batch(2), { now: "2026-10-25T13:00:00.000Z" })).file;
    file = reconcileActions(file, MEDIA, input(batch(3), { now: "2026-10-25T14:00:00.000Z" })).file;
    expect(file.items.length).toBe(ACTION_LIMITS.maxItems);
    expect(file.items.filter((item) => item.matchState === "current")).toHaveLength(100);
    expect(file.items.filter((item) => item.status === "done")).toHaveLength(10);
    expect(() => validateActionsFile(file, MEDIA)).not.toThrow();
  });

  test("only the first maxCurrent actions of a summary get state", () => {
    const many = Array.from({ length: ACTION_LIMITS.maxCurrent + 20 }, (_, index) => current(String(index), `Tarefa ${index}`));
    expect(reconcileActions(undefined, MEDIA, input(many)).file.items).toHaveLength(ACTION_LIMITS.maxCurrent);
  });
});

describe("validateActionsFile", () => {
  const valid = (): ActionsFile => reconcileActions(undefined, MEDIA, input([current("a", "Enviar a proposta", { segmentIds: ["s000001"] })])).file;

  test("accepts its own output and rejects tampering", () => {
    expect(validateActionsFile(valid(), MEDIA)).toEqual(valid());
    const cases: Array<(file: any) => void> = [
      (file) => { file.version = 2; },
      (file) => { file.mediaSha256 = mediaSha(9); },
      (file) => { file.items[0].status = "closed"; },
      (file) => { file.items[0].text = "linha\nquebrada"; },
      (file) => { file.items[0].anchor.segmentIds = ["../x"]; },
      (file) => { file.items[0].anchor = undefined; },
      (file) => { file.items[0].dueDate = "amanhã"; },
      (file) => { file.items.push({ ...file.items[0] }); },
      (file) => { file.jobIds = ["not-a-uuid"]; },
      (file) => { file.rev = -1; }
    ];
    for (const tamper of cases) {
      const file = structuredClone(valid()) as any;
      tamper(file);
      expect(() => validateActionsFile(file, MEDIA)).toThrow(ACTIONS_ERRORS.invalidFile);
    }
  });
});

describe("ActionsStore", () => {
  const newStore = async () => {
    const root = join(await tempDir("actions-store-"), "actions");
    return new ActionsStore(root, { now: () => new Date(now), lockTimeoutMs: 2_000 });
  };

  test("reconcile saves a private file only when something changed", async () => {
    const store = await newStore();
    const empty = await store.reconcile(MEDIA, input([]));
    expect(empty.persisted).toBe(true);
    expect(await fs.stat(store.root).catch(() => null)).toBeNull();
    const first = await store.reconcile(MEDIA, input([current("a", "Enviar a proposta")]));
    expect(first).toMatchObject({ persisted: true, changed: true });
    expect((await fs.stat(store.path(MEDIA))).mode & 0o777).toBe(0o600);
    expect((await fs.stat(store.root)).mode & 0o777).toBe(0o700);
    const mtime = (await fs.stat(store.path(MEDIA))).mtimeMs;
    const again = await store.reconcile(MEDIA, input([current("a", "Enviar a proposta")]));
    expect(again).toMatchObject({ persisted: true, changed: false });
    expect((await fs.stat(store.path(MEDIA))).mtimeMs).toBe(mtime);
    expect(await store.read(MEDIA)).toEqual(first.file);
  });

  test("persist:false computes the same ids without writing", async () => {
    const store = await newStore();
    const memory = await store.reconcile(MEDIA, input([current("a", "Enviar a proposta")]), { persist: false });
    expect(memory.persisted).toBe(false);
    expect(await fs.stat(store.root).catch(() => null)).toBeNull();
    const saved = await store.reconcile(MEDIA, input([current("a", "Enviar a proposta")]));
    expect(saved.file.items[0]!.id).toBe(memory.file.items[0]!.id);
  });

  test("an unsaved listing reports the rev on disk, so a status change from it is not refused as stale", async () => {
    const store = await newStore();
    const saved = await store.reconcile(MEDIA, input([current("a", "Enviar a proposta")]));
    expect(saved.file.rev).toBe(1);
    // A reprocessed job changes the state, but this caller does not save it.
    const reprocessed = input([current("a", "Enviar a proposta")], { jobId: uuid(2), jobIds: [uuid(2), JOB] });
    const memory = await store.reconcile(MEDIA, reprocessed, { persist: false });
    expect(memory).toMatchObject({ changed: true, persisted: false });
    expect(memory.file.rev).toBe(1);
    const file = await setActionStatus(MEDIA, memory.file.items[0]!.id, "done", memory.file.rev, store);
    expect(file.rev).toBe(2);
    expect(file.items[0]!.status).toBe("done");
  });

  test("a repeated job id never makes the state unsavable", async () => {
    const store = await newStore();
    const result = await store.reconcile(MEDIA, input([current("a", "Enviar a proposta")], { jobIds: [JOB, uuid(2), JOB] }));
    expect(result.persisted).toBe(true);
    expect((await store.read(MEDIA))!.jobIds).toEqual([uuid(2), JOB]);
  });

  test("a damaged file is listed in memory and never overwritten", async () => {
    const store = await newStore();
    await fs.mkdir(store.root, { recursive: true, mode: 0o700 });
    await fs.writeFile(store.path(MEDIA), "{broken", { mode: 0o600 });
    const result = await store.reconcile(MEDIA, input([current("a", "Enviar a proposta")]));
    expect(result.persisted).toBe(false);
    expect(result.file.items).toHaveLength(1);
    expect(await fs.readFile(store.path(MEDIA), "utf8")).toBe("{broken");
    await expect(store.setStatus(MEDIA, result.file.items[0]!.id, "done")).rejects.toThrow(ACTIONS_ERRORS.invalidFile);
    expect(await fs.readFile(store.path(MEDIA), "utf8")).toBe("{broken");
  });

  test("a symlinked state file is not followed", async () => {
    const store = await newStore();
    await fs.mkdir(store.root, { recursive: true, mode: 0o700 });
    const target = join(store.root, "..", "target.json");
    await fs.writeFile(target, "keep");
    await fs.symlink(target, store.path(MEDIA));
    const result = await store.reconcile(MEDIA, input([current("a", "Enviar a proposta")]));
    expect(result.persisted).toBe(false);
    await expect(store.read(MEDIA)).rejects.toThrow(ACTIONS_ERRORS.invalidFile);
    expect(await fs.readFile(target, "utf8")).toBe("keep");
  });

  test("setStatus with compare-and-swap", async () => {
    const store = await newStore();
    const { file } = await store.reconcile(MEDIA, input([current("a", "Enviar a proposta")]));
    const id = file.items[0]!.id;
    const done = await setActionStatus(MEDIA, id, "done", 1, store);
    expect(done.rev).toBe(2);
    expect(done.items[0]).toMatchObject({ status: "done", statusChangedAt: now });
    await expect(store.setStatus(MEDIA, id, "open", 1)).rejects.toThrow(ACTIONS_ERRORS.stale);
    expect((await store.setStatus(MEDIA, id, "done", 2)).rev).toBe(2);
    expect((await store.setStatus(MEDIA, id, "dismissed")).items[0]!.status).toBe("dismissed");
    await expect(store.setStatus(MEDIA, uuid(5), "done")).rejects.toThrow(ACTIONS_ERRORS.notFound);
    await expect(store.setStatus(MEDIA, "x", "done")).rejects.toThrow(ACTIONS_ERRORS.notFound);
    await expect(store.setStatus(MEDIA, id, "closed" as never)).rejects.toThrow(ACTIONS_ERRORS.invalidStatus);
    await expect(store.setStatus(mediaSha(5), id, "done")).rejects.toThrow(ACTIONS_ERRORS.notFound);
    expect(() => store.path("../../etc/passwd")).toThrow(ACTIONS_ERRORS.invalidRecording);
  });

  test("two windows marking with the same rev: one wins, the other must reload", async () => {
    const store = await newStore();
    const { file } = await store.reconcile(MEDIA, input([current("a", "Enviar a proposta"), current("b", "Ligar para o Bruno")]));
    const results = await Promise.allSettled([
      store.setStatus(MEDIA, file.items[0]!.id, "done", file.rev),
      store.setStatus(MEDIA, file.items[1]!.id, "dismissed", file.rev)
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect((rejected.reason as Error).message).toBe(ACTIONS_ERRORS.stale);
    expect((await store.read(MEDIA))!.rev).toBe(file.rev + 1);
  });

  test("a regeneration racing a status change keeps both", async () => {
    const store = await newStore();
    const { file } = await store.reconcile(MEDIA, input([current("a", "Enviar a proposta")]));
    await Promise.all([
      store.setStatus(MEDIA, file.items[0]!.id, "done"),
      store.reconcile(MEDIA, input([current("a", "Enviar a proposta"), current("b", "Nova ação")], { now: later }))
    ]);
    const saved = (await store.read(MEDIA))!;
    expect(saved.items).toHaveLength(2);
    expect(saved.items[0]!.status).toBe("done");
  });

  test("manual actions can be added and removed; model actions cannot be removed", async () => {
    const store = await newStore();
    const { file: created, item } = await store.addUserAction(MEDIA, { jobId: JOB, text: "  Pagar   fornecedor ", ownerText: "Caio", dueDate: "2026-11-01" }, 0);
    expect(created.rev).toBe(1);
    expect(item).toMatchObject({ origin: "user", text: "Pagar fornecedor", ownerText: "Caio", dueDate: "2026-11-01", status: "open" });
    expect(created.jobIds).toEqual([JOB]);
    await expect(store.addUserAction(MEDIA, { jobId: JOB, text: "Outra" }, 0)).rejects.toThrow(ACTIONS_ERRORS.stale);
    await expect(store.addUserAction(MEDIA, { jobId: JOB, text: "linha\u0000" })).rejects.toThrow(ACTIONS_ERRORS.invalidText);
    await expect(store.addUserAction(MEDIA, { jobId: JOB, text: "ok", dueDate: "amanhã" })).rejects.toThrow(ACTIONS_ERRORS.invalidDueDate);
    await expect(store.addUserAction(MEDIA, { jobId: JOB, text: "ok", dueDate: 20261101 as never })).rejects.toThrow(ACTIONS_ERRORS.invalidDueDate);
    await expect(store.addUserAction(MEDIA, { jobId: JOB, text: "ok", ownerText: 42 as never })).rejects.toThrow(ACTIONS_ERRORS.invalidOwner);
    await expect(store.addUserAction(MEDIA, { jobId: JOB, text: "ok", ownerText: "x".repeat(501) })).rejects.toThrow(ACTIONS_ERRORS.invalidOwner);
    await expect(store.addUserAction(MEDIA, { jobId: JOB, text: 7 as never })).rejects.toThrow(ACTIONS_ERRORS.invalidText);
    expect((await store.read(MEDIA))!.items).toHaveLength(1);
    const multiline = await store.addUserAction(MEDIA, { jobId: JOB, text: "Ligar\npara o banco", ownerText: "  ", dueDate: "" });
    expect(multiline.item).toMatchObject({ text: "Ligar para o banco" });
    expect(multiline.item).not.toHaveProperty("ownerText");
    expect(multiline.item).not.toHaveProperty("dueDate");
    await store.removeUserAction(MEDIA, multiline.item.id);
    await expect(store.addUserAction(MEDIA, { jobId: "x", text: "ok" })).rejects.toThrow(ACTIONS_ERRORS.invalidRecording);
    const { file } = await store.reconcile(MEDIA, input([current("a", "Enviar a proposta")]));
    const model = file.items.find((candidate) => candidate.origin === "model")!;
    await expect(store.removeUserAction(MEDIA, model.id)).rejects.toThrow(ACTIONS_ERRORS.notManual);
    const removed = await store.removeUserAction(MEDIA, item.id);
    expect(removed.items.map((candidate) => candidate.origin)).toEqual(["model"]);
  });

  test("manual actions are limited", async () => {
    const store = await newStore();
    for (let index = 0; index < ACTION_LIMITS.maxUserItems; index++) await store.addUserAction(MEDIA, { jobId: JOB, text: `Item ${index}` });
    await expect(store.addUserAction(MEDIA, { jobId: JOB, text: "Mais um" })).rejects.toThrow(ACTIONS_ERRORS.full);
  });

  test("remove forgets a media's state", async () => {
    const store = await newStore();
    await store.reconcile(MEDIA, input([current("a", "Enviar a proposta")]));
    await store.remove(MEDIA);
    expect(await store.read(MEDIA)).toBeUndefined();
    await store.remove(MEDIA);
  });

  test("a store that cannot be created on disk lists in memory and refuses edits in Portuguese", async () => {
    const parent = join(await tempDir("actions-blocked-"), "not-a-directory");
    await fs.writeFile(parent, "x");
    const store = new ActionsStore(join(parent, "actions"), { now: () => new Date(now), lockTimeoutMs: 2_000 });
    const result = await store.reconcile(MEDIA, input([current("a", "Enviar a proposta")]));
    expect(result).toMatchObject({ persisted: false, changed: true });
    await expect(store.setStatus(MEDIA, result.file.items[0]!.id, "done")).rejects.toThrow(ACTIONS_ERRORS.storage);
    await expect(store.addUserAction(MEDIA, { jobId: JOB, text: "Pagar" })).rejects.toThrow(ACTIONS_ERRORS.storage);
  });

  test("every error message is listed for translation", () => {
    for (const message of Object.values(ACTIONS_ERRORS)) expect(ACTIONS_KNOWN_ERRORS).toContain(message);
  });
});
