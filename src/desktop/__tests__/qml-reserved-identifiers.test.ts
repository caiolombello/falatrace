import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Words the Qt 6.10 QML engine (Ubuntu 26.04 system Qt) refuses as variable or parameter
// names with "Unexpected token `reserved word'", so the whole Studio fails to load.
// The CI journeys run on PySide6 6.11, which accepts some of them, so only this check
// catches them. Each word was confirmed against libQt6Qml 6.10.2.
const RESERVED = [
  "abstract", "boolean", "byte", "char", "double", "enum", "final", "float", "goto", "implements",
  "int", "interface", "long", "native", "package", "private", "protected", "public", "short",
  "synchronized", "throws", "transient", "volatile"
];
const word = `(?:${RESERVED.join("|")})`;
const declaration = new RegExp(`\\b(?:const|let|var)\\s+(${word})\\b`, "g");
const parameters = /\bfunction\b[^(]*\(([^)]*)\)/g;

const desktop = join(import.meta.dir, "..");
const sources = readdirSync(desktop).filter((name) => name.endsWith(".qml") || name.endsWith(".js"));

const findings = (text: string): string[] => {
  const found = [...text.matchAll(declaration)].map((match) => match[1]);
  for (const match of text.matchAll(parameters)) {
    for (const parameter of match[1].split(",")) {
      const name = parameter.trim().split(/[\s=]/)[0];
      if (RESERVED.includes(name)) found.push(name);
    }
  }
  return found;
};

test("the check recognises declarations and parameters named with a reserved word", () => {
  expect(findings("const short = 1; let long = 2; var int = 3")).toEqual(["short", "long", "int"]);
  expect(findings("function f(a, short, b = 1) {}")).toEqual(["short"]);
  expect(findings("const shortTitle = 1; function g(longest) {}")).toEqual([]);
});

test("Studio QML and JS use no identifier that Qt 6.10 reserves", () => {
  expect(sources).toContain("Main.qml");
  const offending = sources.flatMap((name) =>
    findings(readFileSync(join(desktop, name), "utf8")).map((identifier) => `${name}: ${identifier}`));
  expect(offending).toEqual([]);
});
