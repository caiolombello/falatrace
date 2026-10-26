import { type AppServices, createAppServices, personReader } from "../app/context";
import type { AssistantScope } from "../assistant/types";
import { readClientCatalog } from "../clients/catalog";
import type { AppConfig } from "../config/defaults";
import { BUILT_IN_RECIPES, type Recipe, RECIPE_MESSAGES, RecipeStore } from "../recipes";
import { prepareRecipeRun, type RecipeRunContext, recipeLanguageFor } from "../recipes/prepare";
import { askQuestion, type QuestionServices, refreshIndex, SCOPE_OPTIONS, scopeFromArgs, withServices } from "./answer";
import { RECIPES_HELP } from "./help";
import { CLI_MESSAGES, CLI_USAGE, type CliIO, defaultLoadConfig, type Interrupt, parseArgs, printJson, processInterrupt, processIO, sleep } from "./shared";

export { RECIPES_HELP };

/** What the variables of a recipe are filled from, for one scope. */
export type RecipeScopeContext = Omit<RecipeRunContext, "scope" | "language" | "today" | "timeZone">;

export type RecipesCliDeps = {
  io: CliIO;
  loadConfig: () => Promise<AppConfig>;
  recipes: () => Pick<RecipeStore, "inspect" | "get">;
  services: (config: AppConfig) => QuestionServices;
  /** Meeting facts, person or client names for the recipe variables (read through the same services). */
  context: (config: AppConfig, scope: AssistantScope) => Promise<RecipeScopeContext>;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  interrupt: () => Interrupt;
  pollMs?: number;
};

const appContext = async (config: AppConfig, services: AppServices, scope: AssistantScope): Promise<RecipeScopeContext> => {
  if (scope.kind === "meeting") {
    const facts = await services.index.getFacts(scope.jobId);
    return facts ? { facts } : {};
  }
  if (scope.kind === "person") {
    const person = await personReader(services.index, services.people)(scope.personId).catch(() => undefined);
    return person ? { person: { name: person.name } } : {};
  }
  if (scope.kind === "client") {
    const catalog = await readClientCatalog(config.timesheet.contextPath);
    const client = catalog.context.clients.find((candidate) => candidate.code === scope.clientCode);
    return client ? { client: { name: client.name } } : {};
  }
  return {};
};

export const defaultRecipesCliDeps = (): RecipesCliDeps => {
  let app: AppServices | undefined;
  return {
    io: processIO,
    loadConfig: defaultLoadConfig,
    recipes: () => new RecipeStore(),
    services: (config) => {
      app = createAppServices(config);
      return app;
    },
    context: (config, scope) => (app ? appContext(config, app, scope) : Promise.resolve({})),
    now: () => new Date(),
    sleep,
    interrupt: processInterrupt
  };
};

const brief = (recipe: Recipe) => ({ id: recipe.id, builtIn: recipe.builtIn, version: recipe.version, scope: recipe.scope, name: recipe.name, description: recipe.description });

export const runRecipesCli = async (args: string[], deps: RecipesCliDeps = defaultRecipesCliDeps()): Promise<void> => {
  const [, subcommand, ...rest] = args;
  const { io } = deps;
  if (subcommand === "help" || subcommand === "--help") { io.out(RECIPES_HELP); return; }
  if (subcommand === "list") {
    parseArgs(rest);
    const { recipes, problems } = await deps.recipes().inspect();
    printJson(io, { recipes: [...BUILT_IN_RECIPES, ...recipes].map(brief), problems });
    return;
  }
  if (subcommand === "show") {
    const [id] = parseArgs(rest).positionals;
    if (!id) throw new Error(CLI_USAGE.recipes);
    const recipe = await deps.recipes().get(id);
    if (!recipe) throw new Error(RECIPE_MESSAGES.notFound);
    printJson(io, recipe);
    return;
  }
  if (subcommand === "run") {
    const parsed = parseArgs(rest, { values: SCOPE_OPTIONS, flags: ["--yes", "--json"] });
    const [id, ...extra] = parsed.positionals;
    if (!id) throw new Error(CLI_USAGE.recipes);
    const recipe = await deps.recipes().get(id);
    if (!recipe) throw new Error(RECIPE_MESSAGES.notFound);
    const scope = scopeFromArgs(parsed);
    if (recipe.scope === "meeting" && scope.kind !== "meeting") throw new Error(CLI_MESSAGES.recipeNeedsMeeting);
    const config = await deps.loadConfig();
    const services = deps.services(config);
    await withServices(services, async () => {
      await refreshIndex(services, io);
      const context = await deps.context(config, scope);
      const run = prepareRecipeRun(recipe, { ...context, scope, language: recipeLanguageFor(config, context.facts), today: deps.now() });
      // Words after the id are an extra request added to the recipe's task.
      await askQuestion(services, { scope, question: extra.join(" ").trim(), recipe: run, yes: parsed.flags.has("--yes"), json: parsed.flags.has("--json") }, deps);
    });
    return;
  }
  throw new Error(CLI_USAGE.recipes);
};
