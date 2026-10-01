import { expect, test } from "bun:test";
import { findClient } from "../context";
import { type TimesheetClient, validateTimesheetContext } from "../types";

const client = (code: string, name: string, aliases: string[] = []): TimesheetClient => ({
  code,
  name,
  aliases,
  responsibleNames: []
});

const catalog = (clients: TimesheetClient[]) => validateTimesheetContext({
  version: 1,
  colleagues: [],
  clients,
  taskTypes: []
});

test("exact client codes win over another client's alias in either catalog order", () => {
  const selected = client("project:blue", "Synthetic blue project");
  const other = client("project:red", "Synthetic red project", ["project:blue"]);
  for (const clients of [[selected, other], [other, selected]]) {
    const context = catalog(clients);
    expect(findClient(context, "project:blue")?.code).toBe("project:blue");
    expect(findClient(context, "project blue")).toBeUndefined();
  }
});

test("punctuation-distinct codes keep their exact identities in either catalog order", () => {
  const dotted = client("A.B", "Synthetic dotted project");
  const hyphenated = client("a-b", "Synthetic hyphenated project");
  for (const clients of [[dotted, hyphenated], [hyphenated, dotted]]) {
    const context = catalog(clients);
    expect(context.clients.map((entry) => entry.code)).toEqual(clients.map((entry) => entry.code));
    expect(findClient(context, "A.B")?.code).toBe("A.B");
    expect(findClient(context, "a-b")?.code).toBe("a-b");
    expect(findClient(context, "a b")).toBeUndefined();
  }
});

test("normalized names and aliases resolve only one matching client", () => {
  const first = client("first", "Synthetic first", ["Shared alias"]);
  const second = client("second", "Shared alias");
  for (const clients of [[first, second], [second, first]]) {
    expect(findClient(catalog(clients), "SHARED ALIAS")).toBeUndefined();
  }
  expect(findClient(catalog([first]), "shared-alias")?.code).toBe("first");
  expect(findClient(catalog([first]), "missing")).toBeUndefined();
});

test("unique Unicode aliases and legacy codes retain normalized lookup", () => {
  const context = catalog([client("CL008", "Synthetic legacy client", ["São José", "SÃO-JOSÉ"])]);
  expect(findClient(context, "sao jose")?.code).toBe("CL008");
  expect(findClient(context, "SÃO JOSÉ")?.code).toBe("CL008");
  expect(findClient(context, "cl008")?.code).toBe("CL008");
});

test("selectors with no normalized text do not select a client", () => {
  const context = catalog([client("synthetic", "Synthetic project", ["東京", "---"])]);
  for (const selector of ["", "   ", "---", "東京", "大阪"]) {
    expect(findClient(context, selector)).toBeUndefined();
  }
});
