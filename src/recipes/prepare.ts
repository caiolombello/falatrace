import type { AssistantScope } from "../assistant/types";
import type { AppConfig } from "../config/defaults";
import type { JobFacts } from "../library-index/types";
import { isContentLanguage, toContentLanguage } from "../summary/language";
import { assertRecipeFitsScope, type Recipe, type RecipeLanguage } from "./catalog";
import { buildRecipeVariables, expandRecipe } from "./expand";

/**
 * Turns a recipe into what the assistant runner takes (`{ id, prompt }`) for one scope: checks the
 * recipe fits the scope and fills its variables from the meeting facts, person or client. Used by
 * the CLI (`recipes run`) and meant for the Studio bridge too, so both expand recipes alike.
 */

export type RecipeRunContext = {
  scope: AssistantScope;
  /** Facts of the meeting (meeting scope). */
  facts?: JobFacts;
  /** Person of a person scope. */
  person?: { name: string };
  /** Client of a client scope; for a meeting, its first client is used when absent. */
  client?: { name: string };
  /** The user's own name; for a meeting, the calendar's self attendee is used when absent. */
  me?: string;
  language: RecipeLanguage;
  today?: Date;
  timeZone?: string;
};

/** Names of the people of a meeting: confirmed speaker labels, then calendar attendees, without repeats. */
export const meetingPeople = (facts: Pick<JobFacts, "speakers" | "attendees">): string[] => {
  const seen = new Set<string>();
  const names: string[] = [];
  const add = (name: string): void => {
    const key = name.trim().toLocaleLowerCase("pt-BR");
    if (!key || seen.has(key)) return;
    seen.add(key);
    names.push(name.trim());
  };
  for (const speaker of facts.speakers) if (speaker.confirmed) add(speaker.label);
  for (const attendee of facts.attendees) add(attendee.name);
  return names.slice(0, 50);
};

/** Language recipes write in: the summary language setting, else the meeting's language, else the Studio language. */
export const recipeLanguageFor = (config: Pick<AppConfig, "summary" | "studio">, facts?: Pick<JobFacts, "language">): RecipeLanguage => {
  if (isContentLanguage(config.summary.language)) return config.summary.language;
  if (facts?.language) return toContentLanguage(facts.language);
  return config.studio.language === "en" ? "en" : "pt-BR";
};

const scopeLabel = (context: RecipeRunContext): string | undefined => {
  if (context.scope.kind === "person" && context.person?.name) return `meetings with ${context.person.name}`;
  if (context.scope.kind === "client" && context.client?.name) return `meetings with the client ${context.client.name}`;
  return undefined;
};

/** The recipe's run request: scope checked, variables filled (values sanitized, single pass). */
export const prepareRecipeRun = (recipe: Recipe, context: RecipeRunContext): { id: string; prompt: string } => {
  assertRecipeFitsScope(recipe, context.scope);
  const facts = context.scope.kind === "meeting" ? context.facts : undefined;
  const self = facts?.attendees.find((attendee) => attendee.self)?.name;
  const variables = buildRecipeVariables({
    ...(facts ? { meeting: { title: facts.title, date: facts.date, people: meetingPeople(facts) } } : {}),
    client: context.client?.name ?? facts?.clients[0]?.name,
    person: context.person?.name,
    me: context.me ?? self,
    scope: scopeLabel(context),
    language: context.language,
    today: context.today,
    timeZone: context.timeZone
  });
  return { id: recipe.id, prompt: expandRecipe(recipe, variables) };
};
