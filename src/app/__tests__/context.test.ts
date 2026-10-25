import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../../config/defaults";
import { IndexStore } from "../../library-index/store";
import { ThreadStore } from "../../assistant/threads";
import { PeopleStore } from "../../people/store";
import type { ChatProvider } from "../../assistant/types";
import { createAppServices } from "../context";

const fakeProvider = (): ChatProvider => ({
  destination: { kind: "local", id: "ollama", label: "Ollama · teste", endpoint: "http://127.0.0.1:1", model: "teste", external: false },
  check: async () => ({ ready: true }),
  run: async () => ({ text: "Nada encontrado.", stopReason: "end" })
});

test("services wire the index, people and runner; an empty library refuses a question clearly", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "app-context-"));
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.timesheet.contextPath = join(root, "catalog.json");
    const services = createAppServices(config, {
      index: { jobs: { list: async () => [], getWorkDir: (id: string) => join(root, "jobs", id) }, store: new IndexStore(join(root, "index")) },
      assistant: { providerFactory: fakeProvider, store: new ThreadStore(join(root, "threads")), people: new PeopleStore(join(root, "people")) }
    });
    const report = await services.index.refresh();
    expect(report.indexed).toBe(0);
    expect(await services.index.listFacts()).toEqual([]);
    await expect(services.runner.plan({ scope: { kind: "library" }, question: "O que ficou decidido?" }))
      .rejects.toThrow("Nenhuma reunião registrada corresponde a este escopo.");
    await services.close();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
