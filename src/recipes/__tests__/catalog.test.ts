import { describe, expect, test } from "bun:test";
import {
  BUILT_IN_RECIPES,
  BUILT_IN_RECIPE_IDS,
  RECIPE_KNOWN_ERRORS,
  RECIPE_MESSAGES,
  RECIPE_VARIABLES,
  RecipeValidationError,
  assertRecipeFitsScope,
  builtInRecipe,
  customRecipeSlug,
  recipeFitsScope,
  recipeName,
  recipeVariablesIn,
  unknownRecipeVariables,
  validateRecipe,
  type Recipe
} from "../index";

const custom = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "custom:weekly-report",
  version: 1,
  builtIn: false,
  name: { "pt-BR": "Relatório semanal", en: "Weekly report", es: "Informe semanal" },
  description: "A weekly status report for the client.",
  scope: "meeting",
  prompt: "Write a weekly report about {{meeting.title}} in {{language}}.",
  ...overrides
});

const expectRecipeError = (value: unknown, message: string): void => {
  try {
    validateRecipe(value);
  } catch (error) {
    expect(error).toBeInstanceOf(RecipeValidationError);
    expect((error as Error).message).toBe(message);
    return;
  }
  throw new Error("expected a RecipeValidationError");
};

describe("built-in recipes", () => {
  test("exactly the ten fixed ids, in order, with the right scopes", () => {
    expect(BUILT_IN_RECIPES.map((recipe) => recipe.id)).toEqual([...BUILT_IN_RECIPE_IDS]);
    expect(BUILT_IN_RECIPES.filter((recipe) => recipe.scope === "library").map((recipe) => recipe.id)).toEqual(["prep-next-meeting", "what-did-i-promise"]);
  });

  test("each one is valid, named in three languages, and frozen", () => {
    for (const recipe of BUILT_IN_RECIPES) {
      expect(validateRecipe(recipe)).toEqual(recipe as Recipe);
      expect(recipe.builtIn).toBe(true);
      expect(recipe.version).toBeGreaterThanOrEqual(1);
      for (const language of ["pt-BR", "en", "es"] as const) expect(recipe.name[language].length).toBeGreaterThan(2);
      expect(new Set([recipe.name["pt-BR"], recipe.name.en]).size).toBe(2);
      expect(Object.isFrozen(recipe)).toBe(true);
      expect(Object.isFrozen(recipe.name)).toBe(true);
      expect(() => { (recipe as { prompt: string }).prompt = "x"; }).toThrow();
    }
  });

  test("prompts are substantial, name the output language and use only known variables", () => {
    for (const recipe of BUILT_IN_RECIPES) {
      expect(recipe.prompt.length).toBeGreaterThan(400);
      expect(recipe.prompt).toContain("{{language}}");
      expect(unknownRecipeVariables(recipe.prompt)).toEqual([]);
      // Grounding: every recipe tells the model not to invent facts.
      expect(recipe.prompt).toMatch(/invent/);
    }
  });

  test("meeting recipes refer to the meeting; library recipes to the scope and today", () => {
    for (const recipe of BUILT_IN_RECIPES) {
      const variables = recipeVariablesIn(recipe.prompt);
      if (recipe.scope === "meeting") {
        expect(variables).toContain("meeting.title");
        expect(variables).not.toContain("scope");
      } else {
        expect(variables).toContain("scope");
        expect(variables).toContain("today");
        expect(variables.some((name) => name.startsWith("meeting."))).toBe(false);
      }
    }
  });

  test("ready-to-send recipes keep citation markers out of the text", () => {
    for (const id of ["follow-up-email", "slack-update"]) expect(builtInRecipe(id)?.prompt).toMatch(/markers/);
    expect(builtInRecipe("follow-up-email")?.prompt).toMatch(/owner to be confirmed/);
    expect(builtInRecipe("risks")?.prompt).toMatch(/Mitigation/);
    expect(builtInRecipe("postmortem-doc")?.prompt).toMatch(/blameless/);
    expect(builtInRecipe("what-did-i-promise")?.prompt).toContain("{{me}}");
  });

  test("lookup helpers", () => {
    expect(builtInRecipe("risks")?.name.en).toBe("Risks and mitigations");
    expect(builtInRecipe("custom:risks")).toBeUndefined();
    expect(customRecipeSlug("custom:abc-1")).toBe("abc-1");
    expect(customRecipeSlug("risks")).toBeUndefined();
    expect(customRecipeSlug("custom:../x")).toBeUndefined();
    expect(recipeName(builtInRecipe("risks") as Recipe, "es")).toBe("Riesgos y mitigaciones");
    expect(recipeName(builtInRecipe("risks") as Recipe, "fr")).toBe("Riscos e mitigações");
  });
});

describe("validateRecipe", () => {
  test("accepts and normalises a custom recipe", () => {
    const recipe = validateRecipe(custom({ prompt: "  Line one\r\nLine\ttwo with {{client}}  ", description: " Trimmed. " }));
    expect(recipe.prompt).toBe("Line one\nLine\ttwo with {{client}}");
    expect(recipe.description).toBe("Trimmed.");
  });

  test("refuses malformed recipes with a specific message", () => {
    expectRecipeError("recipe", RECIPE_MESSAGES.invalid);
    expectRecipeError(custom({ extra: true }), RECIPE_MESSAGES.unknownFields);
    expectRecipeError(custom({ id: "Custom:Bad" }), RECIPE_MESSAGES.invalidId);
    expectRecipeError(custom({ id: "custom:../../etc" }), RECIPE_MESSAGES.invalidId);
    expectRecipeError(custom({ id: "custom:" }), RECIPE_MESSAGES.invalidId);
    expectRecipeError(custom({ id: "weekly-report" }), RECIPE_MESSAGES.customIdRequired);
    expectRecipeError(custom({ id: "custom:weekly", builtIn: true }), RECIPE_MESSAGES.customIdRequired);
    expectRecipeError(custom({ id: "made-up", builtIn: true }), RECIPE_MESSAGES.customIdRequired);
    expectRecipeError(custom({ builtIn: "no" }), RECIPE_MESSAGES.invalid);
    expectRecipeError(custom({ version: 0 }), RECIPE_MESSAGES.invalid);
    expectRecipeError(custom({ version: 1.5 }), RECIPE_MESSAGES.invalid);
    expectRecipeError(custom({ name: { "pt-BR": "x", en: "y" } }), RECIPE_MESSAGES.invalidName);
    expectRecipeError(custom({ name: { "pt-BR": "x", en: "y", es: "z", fr: "w" } }), RECIPE_MESSAGES.invalidName);
    expectRecipeError(custom({ name: { "pt-BR": "a\nb", en: "y", es: "z" } }), RECIPE_MESSAGES.invalidName);
    expectRecipeError(custom({ name: { "pt-BR": "x".repeat(81), en: "y", es: "z" } }), RECIPE_MESSAGES.invalidName);
    expectRecipeError(custom({ description: "" }), RECIPE_MESSAGES.invalidDescription);
    expectRecipeError(custom({ description: "two\nlines" }), RECIPE_MESSAGES.invalidDescription);
    expectRecipeError(custom({ scope: "person" }), RECIPE_MESSAGES.invalidScope);
    expectRecipeError(custom({ prompt: "short" }), RECIPE_MESSAGES.invalidPrompt);
    expectRecipeError(custom({ prompt: "x".repeat(8001) }), RECIPE_MESSAGES.invalidPrompt);
    expectRecipeError(custom({ prompt: "valid text but \u0007 bell" }), RECIPE_MESSAGES.invalidPrompt);
    expectRecipeError(custom({ prompt: "valid text but lone \ud800 surrogate" }), RECIPE_MESSAGES.invalidPrompt);
    expectRecipeError(custom({ prompt: 42 }), RECIPE_MESSAGES.invalidPrompt);
  });

  test("errors carry the field", () => {
    try {
      validateRecipe(custom({ name: { "pt-BR": "x", en: "", es: "z" } }));
    } catch (error) {
      expect((error as RecipeValidationError).field).toBe("name.en");
    }
  });
});

describe("scopes and variables", () => {
  test("meeting recipes fit meetings; library recipes fit library, person and client scopes", () => {
    const meeting = builtInRecipe("risks") as Recipe;
    const library = builtInRecipe("what-did-i-promise") as Recipe;
    const job = "3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b";
    expect(recipeFitsScope(meeting, { kind: "meeting", jobId: job })).toBe(true);
    expect(recipeFitsScope(meeting, { kind: "library" })).toBe(false);
    for (const scope of [{ kind: "library" }, { kind: "person", personId: "p1" }, { kind: "client", clientCode: "ACME" }] as const) {
      expect(recipeFitsScope(library, scope)).toBe(true);
    }
    expect(recipeFitsScope(library, { kind: "meeting", jobId: job })).toBe(false);
    expect(() => assertRecipeFitsScope(library, { kind: "meeting", jobId: job })).toThrow(RECIPE_MESSAGES.scopeMismatch);
  });

  test("variable helpers", () => {
    expect(recipeVariablesIn("{{ today }} {{today}} {{meeting.title}} {{x-y}} {{ }} {single}")).toEqual(["today", "meeting.title", "x-y"]);
    expect(unknownRecipeVariables("{{today}} {{foo}} {{meeting.place}}")).toEqual(["foo", "meeting.place"]);
    expect(RECIPE_VARIABLES).toContain("meeting.people");
  });

  test("known errors are unique", () => {
    expect(new Set(RECIPE_KNOWN_ERRORS).size).toBe(RECIPE_KNOWN_ERRORS.length);
  });
});
