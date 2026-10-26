import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Messages tell people where to fix something ("Informe o modelo em Configurações › Perguntar e
 * receitas."). Every such path must name a section the Studio's Settings really has, in Portuguese
 * and in its English translation, so renaming or regrouping the sections cannot leave messages
 * pointing at a section that is gone. "ChatGPT › Configurações › …" is ChatGPT's own settings.
 */
const repo = join(import.meta.dir, "../../..");
const desktop = join(repo, "src/desktop");
const read = (path: string): string => readFileSync(path, "utf8");

const dialog = read(join(desktop, "SettingsDialog.qml"));
const sectionsBlock = /readonly property var sections: \[([\s\S]*?)\n {4}\]/.exec(dialog)?.[1] ?? "";
const titles = [...sectionsBlock.matchAll(/title: t\("([^"]+)"\)/g)].map((match) => match[1]!);

const source = read(join(desktop, "i18n.js")).replace(/^\.pragma library\s*$/m, "");
const { EN } = new Function(`${source}\nreturn { EN };`)() as { EN: Record<string, string> };

const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  if (name === "__tests__" || name === "node_modules") return [];
  return statSync(path).isDirectory() ? files(path) : /\.(ts|qml)$/.test(name) && !name.endsWith(".test.ts") ? [path] : [];
});

/** Each "<prefix> › <rest>" in text, except the ones inside ChatGPT's own settings. */
const pathsIn = (text: string, prefix: string): string[] => {
  const found: string[] = [];
  const marker = `${prefix} › `;
  for (let at = text.indexOf(marker); at >= 0; at = text.indexOf(marker, at + marker.length)) {
    if (text.slice(Math.max(0, at - 10), at) === "ChatGPT › ") continue;
    found.push(text.slice(at + marker.length, at + marker.length + 80));
  }
  return found;
};

test("the settings sections are read from the dialog", () => {
  expect(titles).toHaveLength(16);
  expect(titles).toContain("Perguntar e receitas");
});

test("messages name only Settings sections that exist", () => {
  const wrong: string[] = [];
  for (const path of files(join(repo, "src"))) {
    for (const rest of pathsIn(read(path), "Configurações")) {
      if (!titles.some((title) => rest.startsWith(title))) wrong.push(`${relative(repo, path)}: Configurações › ${rest}`);
    }
  }
  expect(wrong).toEqual([]);
});

test("their English names the English title of a section that exists", () => {
  const english = titles.map((title) => EN[title]).filter((title): title is string => !!title);
  expect(english).toHaveLength(titles.length);
  const wrong: string[] = [];
  for (const [portuguese, value] of Object.entries(EN)) {
    for (const rest of pathsIn(portuguese, "Configurações")) {
      if (!titles.some((title) => rest.startsWith(title))) wrong.push(`key: ${portuguese}`);
    }
    for (const rest of pathsIn(value, "Settings")) {
      if (!english.some((title) => rest.startsWith(title))) wrong.push(`${portuguese} → ${value}`);
    }
  }
  expect(wrong).toEqual([]);
});
