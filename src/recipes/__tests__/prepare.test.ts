import { expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../../config/defaults";
import type { JobFacts } from "../../library-index/types";
import { builtInRecipe, RECIPE_MESSAGES } from "../catalog";
import { meetingPeople, prepareRecipeRun, recipeLanguageFor } from "../prepare";

const JOB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const facts = {
  jobId: JOB, title: "Revisão {{today}} semanal", date: "2026-10-25T12:00:00.000Z", language: "en",
  speakers: [{ speakerId: "S01", label: "Ana Souza", confirmed: true }, { speakerId: "S02", label: "Falante 2", confirmed: false }],
  attendees: [{ name: "ana souza", self: false }, { name: "Eu Mesmo", self: true }],
  clients: [{ code: "ACME", name: "Acme", source: "manual", confidence: 1 }]
} as unknown as JobFacts;

test("a meeting recipe is filled from the meeting's facts, in one pass", () => {
  const recipe = builtInRecipe("follow-up-email")!;
  const run = prepareRecipeRun(recipe, { scope: { kind: "meeting", jobId: JOB }, facts, language: "pt-BR", today: new Date("2026-10-26T12:00:00Z"), timeZone: "UTC" });
  expect(run.id).toBe("follow-up-email");
  expect(run.prompt).not.toMatch(/\{\{\s*meeting\./);
  // A title that looks like a variable stays literal text (braces neutralised).
  expect(run.prompt).toContain("Revisão { {today} } semanal");
  expect(meetingPeople(facts)).toEqual(["Ana Souza", "Eu Mesmo"]);
});

test("a recipe only runs in a scope it fits, and the language follows the settings", () => {
  expect(() => prepareRecipeRun(builtInRecipe("risks")!, { scope: { kind: "library" }, language: "en" })).toThrow(RECIPE_MESSAGES.scopeMismatch);
  expect(() => prepareRecipeRun(builtInRecipe("what-did-i-promise")!, { scope: { kind: "meeting", jobId: JOB }, facts, language: "en" })).toThrow(RECIPE_MESSAGES.scopeMismatch);
  const person = prepareRecipeRun(builtInRecipe("what-did-i-promise")!, { scope: { kind: "person", personId: "name:ana souza" }, person: { name: "Ana Souza" }, language: "es" });
  expect(person.prompt).not.toContain("{{language}}");
  const config = structuredClone(DEFAULT_CONFIG);
  expect(recipeLanguageFor(config, facts)).toBe("en");
  expect(recipeLanguageFor(config)).toBe("pt-BR");
  config.studio.language = "en";
  expect(recipeLanguageFor(config)).toBe("en");
  config.summary.language = "es";
  expect(recipeLanguageFor(config, facts)).toBe("es");
});
