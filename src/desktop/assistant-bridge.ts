// Ask (questions over a meeting, a person, a client or the library), conversation threads, assistant
// sign-in and recipes (DESIGN-STUDIO §4 "Assistant", "Recipes"). Long work is start + poll.
import type { AppServices } from "../app/context";
import { personReader } from "../app/context";
import { CHATGPT_MESSAGES, chatGptLogout, chatGptStatus, startChatGptLogin, type ChatGptLogin } from "../assistant/chatgpt/oauth";
import { detectAssistantTools } from "../assistant/detect";
import { ASSISTANT_PROVIDER_KNOWN_ERRORS, createChatProvider } from "../assistant/providers";
import { MAX_QUESTION_CHARACTERS } from "../assistant/prompts";
import { validateAssistantScope } from "../assistant/retrieval";
import { ASSISTANT_KNOWN_ERRORS, type AssistantRunner } from "../assistant/runner";
import type { AssistantScope, ChatCitation } from "../assistant/types";
import { readClientCatalog } from "../clients/catalog";
import type { AppConfig } from "../config/defaults";
import {
  assertRecipeFitsScope, buildRecipeVariables, deleteCustomRecipe, expandRecipe, getRecipe, inspectCustomRecipes, RECIPE_KNOWN_ERRORS, RECIPE_MESSAGES,
  recipeName, saveCustomRecipe, BUILT_IN_RECIPES, type Recipe, type RecipeLanguage
} from "../recipes";
import { type BridgeCall, type BridgeFamily, boundedObject, integer, invalid, matches, RECIPE_ID, SHA256, text, UUID, validateScope } from "./bridge-family";
import type { BridgeContext } from "./bridge-context";
import { studioLanguage } from "./studio-services";
import { renderAssistantMarkdown } from "./assistant-markdown";

export const ASSISTANT_BRIDGE_OPERATIONS = [
  "assistant-plan", "assistant-start", "assistant-poll", "assistant-cancel", "assistant-threads", "assistant-thread", "assistant-thread-delete",
  "assistant-detect", "assistant-chatgpt-login", "assistant-chatgpt-status", "assistant-chatgpt-logout",
  "recipes-list", "recipes-save", "recipes-delete"
] as const;

export const ASSISTANT_BRIDGE_MESSAGES = Object.freeze({
  failed: "Não foi possível concluir o pedido ao assistente; tente de novo.",
  signInFailed: "Não foi possível falar com o login do ChatGPT; tente de novo.",
  recipesFailed: "Não foi possível ler ou salvar as receitas. Nada foi alterado."
});

export const ASSISTANT_BRIDGE_KNOWN_ERRORS: readonly string[] = Object.freeze([
  ...new Set([...Object.values(ASSISTANT_BRIDGE_MESSAGES), ...ASSISTANT_KNOWN_ERRORS, ...ASSISTANT_PROVIDER_KNOWN_ERRORS, ...RECIPE_KNOWN_ERRORS])
]);

const RECIPE_MAX_BYTES = 64 * 1024;

/** A message the Studio may show as it is; anything else becomes the family's generic one. */
const shownMessage = (message: string | undefined, fallback: string = ASSISTANT_BRIDGE_MESSAGES.failed): string | undefined =>
  message === undefined ? undefined : ASSISTANT_BRIDGE_KNOWN_ERRORS.includes(message) ? message : fallback;

const ALLOWED: Record<(typeof ASSISTANT_BRIDGE_OPERATIONS)[number], readonly string[]> = {
  "assistant-plan": ["scope", "question", "recipeId"],
  "assistant-start": ["scope", "question", "threadId", "recipeId", "consentKey"],
  "assistant-poll": ["runId"],
  "assistant-cancel": ["runId"],
  "assistant-threads": ["scope"],
  "assistant-thread": ["threadId"],
  "assistant-thread-delete": ["threadId"],
  "assistant-detect": [],
  "assistant-chatgpt-login": [],
  "assistant-chatgpt-status": [],
  "assistant-chatgpt-logout": [],
  "recipes-list": [],
  "recipes-save": ["recipe", "expectedVersion"],
  "recipes-delete": ["id", "expectedVersion"]
};

const validate = (call: BridgeCall): void => {
  const p = call.payload;
  switch (call.op) {
    case "assistant-plan":
    case "assistant-start":
      validateScope(p.scope);
      text(p, "question", MAX_QUESTION_CHARACTERS);
      matches(p, "recipeId", RECIPE_ID, { optional: true, max: 60 });
      if (call.op === "assistant-start") {
        matches(p, "threadId", UUID, { optional: true });
        matches(p, "consentKey", SHA256, { optional: true });
      }
      // A question needs words unless a recipe says what to do.
      if (p.recipeId === undefined && !(p.question as string).trim()) invalid();
      return;
    case "assistant-poll":
    case "assistant-cancel":
      matches(p, "runId", UUID); return;
    case "assistant-threads":
      validateScope(p.scope); return;
    case "assistant-thread":
    case "assistant-thread-delete":
      matches(p, "threadId", UUID); return;
    case "recipes-save":
      boundedObject(p, "recipe", RECIPE_MAX_BYTES);
      integer(p, "expectedVersion", 1, 999_999, { optional: true }); return;
    case "recipes-delete":
      matches(p, "id", RECIPE_ID, { max: 60 });
      integer(p, "expectedVersion", 1, 999_999, { optional: true }); return;
    default:
      return;
  }
};

/** Output language of recipes: the summary language when fixed, else the Studio's. */
export const recipeLanguage = (config: AppConfig): RecipeLanguage =>
  config.summary.language !== "auto" ? config.summary.language : studioLanguage(config);

const recipeDirs = (context: BridgeContext) => context.deps.recipesDir ? { dir: context.deps.recipesDir } : {};

/** The recipe's prompt with its variables filled from what the index knows about the scope. */
const expandedRecipe = async (recipeId: string, scope: AssistantScope, services: AppServices, config: AppConfig, context: BridgeContext): Promise<{ id: string; prompt: string }> => {
  const recipe = await getRecipe(recipeId, recipeDirs(context));
  if (!recipe) throw new Error(RECIPE_MESSAGES.notFound);
  assertRecipeFitsScope(recipe, scope);
  const language = recipeLanguage(config);
  let meeting: { title?: string; date?: string; people?: string[] } | undefined;
  let client: string | undefined;
  let person: string | undefined;
  let label: string | undefined;
  if (scope.kind === "meeting") {
    const facts = await services.index.getFacts(scope.jobId);
    if (facts) {
      meeting = { title: facts.title, date: facts.date, people: [...new Set([...facts.speakers.filter((speaker) => speaker.confirmed).map((speaker) => speaker.label), ...facts.attendees.filter((attendee) => !attendee.self).map((attendee) => attendee.name)])] };
      client = facts.clients[0]?.name;
    }
  } else if (scope.kind === "person") {
    person = (await personReader(services.index, services.people)(scope.personId))?.name;
    if (person) label = `meetings with ${person}`;
  } else if (scope.kind === "client") {
    const catalog = await readClientCatalog(config.timesheet.contextPath);
    client = catalog.context.clients.find((candidate) => candidate.code === scope.clientCode)?.name;
    if (client) label = `meetings with the client ${client}`;
  }
  const variables = buildRecipeVariables({ meeting, client, person, language, ...(label ? { scope: label } : {}), ...(context.deps.now ? { today: context.deps.now() } : {}) });
  return { id: recipe.id, prompt: expandRecipe(recipe, variables) };
};

const MARKER = /\[\[((?:m\d{1,4}:)?s\d{6})\]\]/g;

/** `[[m2:s000123]]` markers become `[n]`, numbered in the order of the citations. */
export const numberedAnswer = (text: string, citations: readonly ChatCitation[], dateOf: (jobId: string) => string | undefined) => {
  const numbers = new Map(citations.map((citation, index) => [citation.ref, index + 1]));
  return {
    text: text.replace(MARKER, (_match, ref: string) => numbers.has(ref) ? `[${numbers.get(ref)}]` : ""),
    citations: citations.map((citation, index) => ({
      n: index + 1, jobId: citation.jobId, segmentId: citation.segmentId, ...(citation.start !== undefined ? { start: citation.start } : {}),
      title: citation.title, date: dateOf(citation.jobId) ?? ""
    }))
  };
};

const dates = async (services: AppServices, citations: readonly ChatCitation[]): Promise<(jobId: string) => string | undefined> => {
  const known = new Map<string, string>();
  for (const jobId of new Set(citations.map((citation) => citation.jobId))) {
    const facts = await services.index.getFacts(jobId).catch(() => undefined);
    if (facts) known.set(jobId, facts.date);
  }
  return (jobId) => known.get(jobId);
};

const plan = async (call: BridgeCall, context: BridgeContext) => {
  const config = await context.studio.config();
  const services = await context.studio.services(config);
  const scope = validateAssistantScope(call.payload.scope);
  const recipe = typeof call.payload.recipeId === "string" ? await expandedRecipe(call.payload.recipeId, scope, services, config, context) : undefined;
  const result = await services.runner.plan({ scope, question: call.payload.question as string, ...(recipe ? { recipe } : {}) });
  const provider = (context.deps.provider ?? ((value: AppConfig) => createChatProvider(value)))(config);
  const readiness = await provider.check().catch(() => ({ ready: false as const, problem: "unreachable" as const, message: ASSISTANT_BRIDGE_MESSAGES.failed }));
  const destination = result.destination;
  return {
    ready: readiness.ready,
    ...(readiness.ready ? {} : { problem: readiness.problem, message: shownMessage(readiness.message) }),
    destination: { label: destination.label, kind: destination.kind, external: destination.external, ...(destination.subscription ? { subscription: destination.subscription } : {}) },
    consentKey: result.consentKey,
    contextCharacters: result.contextCharacters,
    meetings: result.meetings,
    truncated: result.truncated
  };
};

const start = async (call: BridgeCall, context: BridgeContext) => {
  const config = await context.studio.config();
  const services = await context.studio.services(config);
  const scope = validateAssistantScope(call.payload.scope);
  const p = call.payload;
  const recipe = typeof p.recipeId === "string" ? await expandedRecipe(p.recipeId, scope, services, config, context) : undefined;
  const started = await services.runner.start({
    scope, question: p.question as string,
    ...(typeof p.threadId === "string" ? { threadId: p.threadId } : {}),
    ...(recipe ? { recipe } : {}),
    ...(typeof p.consentKey === "string" ? { consentKey: p.consentKey } : {})
  });
  context.studio.rememberRun(started.runId, services.runner);
  return started;
};

const runnerOf = async (runId: string, context: BridgeContext): Promise<{ runner: AssistantRunner; services: AppServices }> => {
  const services = await context.studio.services();
  return { runner: context.studio.runnerFor(runId) ?? services.runner, services };
};

const poll = async (call: BridgeCall, context: BridgeContext) => {
  const runId = call.payload.runId as string;
  const { runner, services } = await runnerOf(runId, context);
  const snapshot = runner.poll(runId);
  const answer = numberedAnswer(snapshot.text, snapshot.citations, await dates(services, snapshot.citations));
  return {
    status: snapshot.status, threadId: snapshot.threadId, text: answer.text, html: renderAssistantMarkdown(answer.text, answer.citations), citations: answer.citations,
    ...(snapshot.error ? { error: shownMessage(snapshot.error) } : {}),
    ...(snapshot.saved !== undefined ? { saved: snapshot.saved } : {}),
    ...(snapshot.cutOff ? { cutOff: true } : {})
  };
};

const thread = async (call: BridgeCall, context: BridgeContext) => {
  const services = await context.studio.services();
  const stored = await services.threads.read(call.payload.threadId as string);
  const citations = stored.messages.flatMap((message) => message.citations);
  const dateOf = await dates(services, citations);
  return {
    id: stored.id, title: stored.title, scope: stored.scope, updatedAt: stored.updatedAt,
    messages: stored.messages.map((message) => {
      const numbered = numberedAnswer(message.text, message.citations, dateOf);
      return { role: message.role, text: numbered.text, ...(message.role === "assistant" ? { html: renderAssistantMarkdown(numbered.text, numbered.citations) } : {}), citations: numbered.citations, createdAt: message.createdAt, destination: message.destination,
        ...(message.recipeId ? { recipeId: message.recipeId } : {}) };
    })
  };
};

// One ChatGPT sign-in per Studio: its loopback listener lives in this process.
let chatgptLogin: { state: "waiting" | "signed-in" | "failed"; url?: string; email?: string; error?: string; login?: ChatGptLogin } | undefined;

const chatgptKnown = (error: unknown): string => {
  const message = error instanceof Error ? error.message : "";
  return (Object.values(CHATGPT_MESSAGES) as string[]).includes(message) || ASSISTANT_PROVIDER_KNOWN_ERRORS.includes(message) ? message : CHATGPT_MESSAGES.exchangeFailed;
};

const chatgptSignIn = async (context: BridgeContext) => {
  if (chatgptLogin?.state === "waiting" && chatgptLogin.url) return { authUrl: chatgptLogin.url };
  // The Studio opens the address in the browser; the loopback listener here completes the sign-in.
  const login = await startChatGptLogin({}, context.deps.chatgpt);
  const current: NonNullable<typeof chatgptLogin> = { state: "waiting", url: login.url, login };
  chatgptLogin = current;
  login.done.then((status) => {
    if (chatgptLogin === current) chatgptLogin = { state: "signed-in", ...(status.email ? { email: status.email } : {}) };
  }, (error: unknown) => {
    if (chatgptLogin === current) chatgptLogin = { state: "failed", error: chatgptKnown(error) };
  });
  return { authUrl: login.url };
};

const chatgptState = async (context: BridgeContext) => {
  if (chatgptLogin?.state === "waiting") return { state: "waiting" };
  if (chatgptLogin?.state === "failed") return { state: "failed", error: chatgptLogin.error };
  const status = await chatGptStatus(context.deps.chatgpt);
  return status.signedIn ? { state: "signed-in", ...(status.email ? { email: status.email } : {}), planUsage: status.planUsage } : { state: "idle" };
};

/** Ends a sign-in still waiting for the browser, when the Studio closes. */
export const stopChatGptSignIn = async (): Promise<void> => {
  const login = chatgptLogin?.login;
  chatgptLogin = undefined;
  await login?.cancel().catch(() => undefined);
};

const recipeItem = (recipe: Recipe, language: string) => ({
  id: recipe.id, name: recipeName(recipe, language), description: recipe.description, scope: recipe.scope, builtIn: recipe.builtIn,
  prompt: recipe.prompt, version: recipe.version, names: { ...recipe.name }
});

export const assistantBridge: BridgeFamily<BridgeContext> = {
  operations: ASSISTANT_BRIDGE_OPERATIONS,
  allowedPayload: ALLOWED,
  validate,
  alwaysAdmitted: ["assistant-cancel"],
  async handle(call, context) {
    const p = call.payload;
    switch (call.op) {
      case "assistant-plan": return plan(call, context);
      case "assistant-start": return start(call, context);
      case "assistant-poll": return poll(call, context);
      case "assistant-cancel": {
        const { runner } = await runnerOf(p.runId as string, context);
        return { runId: p.runId, cancelled: runner.cancel(p.runId as string) };
      }
      case "assistant-threads": {
        const services = await context.studio.services();
        const threads = await services.threads.list({ scope: validateAssistantScope(p.scope) });
        return { threads: threads.map(({ id, title, updatedAt, messageCount }) => ({ id, title, updatedAt, messageCount })) };
      }
      case "assistant-thread": return thread(call, context);
      case "assistant-thread-delete": {
        const services = await context.studio.services();
        return { threadId: p.threadId, deleted: await services.threads.remove(p.threadId as string) };
      }
      case "assistant-detect": {
        const [tools, chatgpt] = await Promise.all([detectAssistantTools(context.deps.detect), chatGptStatus(context.deps.chatgpt)]);
        return {
          acp: tools.acp.map(({ agent, found }) => ({ agent, found })),
          cli: tools.cli.map(({ tool, found, signedIn }) => ({ tool, found, signedIn })),
          chatgpt: { signedIn: chatgpt.signedIn, ...(chatgpt.email ? { email: chatgpt.email } : {}) }
        };
      }
      case "assistant-chatgpt-login": return chatgptSignIn(context);
      case "assistant-chatgpt-status": return chatgptState(context);
      case "assistant-chatgpt-logout": {
        await stopChatGptSignIn();
        await chatGptLogout({}, context.deps.chatgpt);
        return chatgptState(context);
      }
      case "recipes-list": {
        const config = await context.studio.config();
        const language = studioLanguage(config);
        const { recipes, problems } = await inspectCustomRecipes(context.deps.recipesDir ? { dir: context.deps.recipesDir } : undefined);
        return { recipes: [...BUILT_IN_RECIPES, ...recipes].map((recipe) => recipeItem(recipe, language)), problems: problems.map(({ file, reason }) => ({ file, reason })) };
      }
      case "recipes-save": {
        const language = studioLanguage(await context.studio.config());
        const saved = await saveCustomRecipe(p.recipe, { ...recipeDirs(context), ...(p.expectedVersion !== undefined ? { expectedVersion: p.expectedVersion as number } : {}) });
        return { recipe: recipeItem(saved, language) };
      }
      case "recipes-delete":
        return { id: p.id, deleted: await deleteCustomRecipe(p.id as string, { ...recipeDirs(context), ...(p.expectedVersion !== undefined ? { expectedVersion: p.expectedVersion as number } : {}) }) };
      default:
        return invalid();
    }
  },
  knownErrors: ASSISTANT_BRIDGE_KNOWN_ERRORS,
  fallback: (op) => op.startsWith("recipes-") ? ASSISTANT_BRIDGE_MESSAGES.recipesFailed : op.startsWith("assistant-chatgpt") ? ASSISTANT_BRIDGE_MESSAGES.signInFailed : ASSISTANT_BRIDGE_MESSAGES.failed
};
