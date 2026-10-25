import type { AssistantScope } from "../assistant/types";

/**
 * Recipes: reusable requests to the assistant ("write the follow-up email", "what did I promise?").
 * The prompt is English for the model and names the output language through {{language}}; the
 * name is shown in the Studio in pt-BR, en or es. Meeting recipes run on one meeting, library
 * recipes on the library or on the meetings of a person or client.
 */

export type LocalizedText = { "pt-BR": string; en: string; es: string };
export type RecipeLanguage = keyof LocalizedText;
export type RecipeScope = "meeting" | "library";

export type Recipe = {
  /** Built-ins: kebab-case. Custom: "custom:<slug>". */
  id: string;
  /** Revision: custom recipes count saves; built-ins change it when their text changes. */
  version: number;
  builtIn: boolean;
  name: LocalizedText;
  /** English, one sentence. */
  description: string;
  scope: RecipeScope;
  /** English instructions; may use the variables in RECIPE_VARIABLES. */
  prompt: string;
};

export const BUILT_IN_RECIPE_IDS = [
  "follow-up-email",
  "risks",
  "postmortem-doc",
  "executive-summary",
  "next-steps",
  "slack-update",
  "open-questions",
  "formal-minutes",
  "prep-next-meeting",
  "what-did-i-promise"
] as const;
export type BuiltInRecipeId = (typeof BUILT_IN_RECIPE_IDS)[number];

/** Variables a prompt may use as {{name}}; anything else is left as written. */
export const RECIPE_VARIABLES = [
  "meeting.title",
  "meeting.date",
  "meeting.people",
  "client",
  "person",
  "me",
  "scope",
  "today",
  "language"
] as const;
export type RecipeVariable = (typeof RECIPE_VARIABLES)[number];

export const RECIPE_LIMITS = Object.freeze({
  nameCharacters: 80,
  descriptionCharacters: 300,
  minPromptCharacters: 10,
  promptCharacters: 8000,
  maxVersion: 1_000_000
});

export const BUILT_IN_RECIPE_ID_PATTERN = /^[a-z][a-z0-9-]{0,40}$/;
export const CUSTOM_RECIPE_ID_PATTERN = /^custom:([a-z0-9][a-z0-9-]{0,40})$/;

/** Fixed messages; the Studio bridge whitelists and translates them. */
export const RECIPE_MESSAGES = Object.freeze({
  invalid: "A receita é inválida.",
  invalidId: "O identificador da receita é inválido; use letras minúsculas, números e hífens.",
  unknownFields: "A receita contém campos desconhecidos.",
  invalidName: "O nome da receita é obrigatório em português, inglês e espanhol, com até 80 caracteres.",
  invalidDescription: "A descrição da receita é obrigatória, em uma linha de até 300 caracteres.",
  invalidScope: "O escopo da receita precisa ser uma reunião ou a biblioteca.",
  invalidPrompt: "O texto da receita é obrigatório e deve ter de 10 a 8000 caracteres, sem caracteres de controle.",
  builtInReadOnly: "Receitas embutidas não podem ser alteradas nem apagadas.",
  customIdRequired: "Receitas personalizadas usam identificadores no formato custom:<nome>.",
  exists: "Já existe uma receita personalizada com esse identificador.",
  conflict: "A receita mudou em outra janela; recarregue antes de salvar.",
  missing: "A receita personalizada não existe mais.",
  limit: "Limite de 100 receitas personalizadas atingido; apague alguma antes de criar outra.",
  invalidFile: "O arquivo da receita personalizada é inválido; corrija ou apague o arquivo.",
  unsafeDirectory: "A pasta de receitas personalizadas não é segura; ela precisa ser uma pasta comum, sem link simbólico.",
  tooLarge: "A receita é grande demais (limite de 64 KiB).",
  busy: "Outra janela está salvando receitas; tente de novo.",
  notFound: "Receita não encontrada.",
  scopeMismatch: "Esta receita não se aplica a este escopo; use uma receita de reunião numa reunião e uma de biblioteca na biblioteca."
});

export const RECIPE_KNOWN_ERRORS: readonly string[] = Object.freeze(Object.values(RECIPE_MESSAGES));

/** A recipe failed validation; `message` is one of RECIPE_KNOWN_ERRORS, `field` says where. */
export class RecipeValidationError extends Error {
  readonly field: string;
  constructor(message: string, field: string) {
    super(message);
    this.name = "RecipeValidationError";
    this.field = field;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Control characters, and lone surrogates (they do not survive UTF-8).
const CONTROL = /[\p{Cc}\p{Cs}]/u;

const line = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max && !CONTROL.test(value);

const LANGUAGE_KEYS = ["pt-BR", "en", "es"] as const;

const localized = (value: unknown): LocalizedText => {
  if (!isObject(value) || Object.keys(value).some((key) => !(LANGUAGE_KEYS as readonly string[]).includes(key))) {
    throw new RecipeValidationError(RECIPE_MESSAGES.invalidName, "name");
  }
  const result = {} as LocalizedText;
  for (const key of LANGUAGE_KEYS) {
    const text = value[key];
    if (!line(text, RECIPE_LIMITS.nameCharacters)) throw new RecipeValidationError(RECIPE_MESSAGES.invalidName, `name.${key}`);
    result[key] = text.trim();
  }
  return result;
};

/** Prompt text: line breaks and tabs allowed, other control characters refused; CRLF stored as LF. */
const prompt = (value: unknown): string => {
  if (typeof value !== "string") throw new RecipeValidationError(RECIPE_MESSAGES.invalidPrompt, "prompt");
  const text = value.replace(/\r\n?/g, "\n").trim();
  if (text.length < RECIPE_LIMITS.minPromptCharacters || text.length > RECIPE_LIMITS.promptCharacters || CONTROL.test(text.replace(/[\n\t]/g, ""))) {
    throw new RecipeValidationError(RECIPE_MESSAGES.invalidPrompt, "prompt");
  }
  return text;
};

export const isBuiltInRecipeId = (id: unknown): id is BuiltInRecipeId =>
  typeof id === "string" && (BUILT_IN_RECIPE_IDS as readonly string[]).includes(id);

/** "custom:<slug>" → slug; undefined for anything else. */
export const customRecipeSlug = (id: unknown): string | undefined => {
  if (typeof id !== "string") return undefined;
  const match = CUSTOM_RECIPE_ID_PATTERN.exec(id);
  return match ? match[1] : undefined;
};

/** Strict check: unknown fields are refused and the object is rebuilt field by field. */
export const validateRecipe = (value: unknown): Recipe => {
  if (!isObject(value)) throw new RecipeValidationError(RECIPE_MESSAGES.invalid, "recipe");
  const keys = ["id", "version", "builtIn", "name", "description", "scope", "prompt"];
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new RecipeValidationError(RECIPE_MESSAGES.unknownFields, "recipe");
  const id = value.id;
  if (typeof id !== "string" || (!BUILT_IN_RECIPE_ID_PATTERN.test(id) && !CUSTOM_RECIPE_ID_PATTERN.test(id))) {
    throw new RecipeValidationError(RECIPE_MESSAGES.invalidId, "id");
  }
  if (typeof value.builtIn !== "boolean") throw new RecipeValidationError(RECIPE_MESSAGES.invalid, "builtIn");
  if (value.builtIn ? !isBuiltInRecipeId(id) : !customRecipeSlug(id)) throw new RecipeValidationError(RECIPE_MESSAGES.customIdRequired, "id");
  if (!Number.isSafeInteger(value.version) || (value.version as number) < 1 || (value.version as number) > RECIPE_LIMITS.maxVersion) {
    throw new RecipeValidationError(RECIPE_MESSAGES.invalid, "version");
  }
  if (!line(value.description, RECIPE_LIMITS.descriptionCharacters)) throw new RecipeValidationError(RECIPE_MESSAGES.invalidDescription, "description");
  if (value.scope !== "meeting" && value.scope !== "library") throw new RecipeValidationError(RECIPE_MESSAGES.invalidScope, "scope");
  return {
    id,
    version: value.version as number,
    builtIn: value.builtIn,
    name: localized(value.name),
    description: value.description.trim(),
    scope: value.scope,
    prompt: prompt(value.prompt)
  };
};

const VARIABLE = /\{\{\s*([A-Za-z][A-Za-z0-9_.-]{0,40})\s*\}\}/g;

/** Variable names a prompt uses, in order of first use. */
export const recipeVariablesIn = (text: string): string[] => {
  const names: string[] = [];
  for (const match of text.matchAll(VARIABLE)) if (!names.includes(match[1])) names.push(match[1]);
  return names;
};

/** Variables a prompt uses that FalaTrace does not fill (they stay as written); for a warning in the editor. */
export const unknownRecipeVariables = (text: string): string[] =>
  recipeVariablesIn(text).filter((name) => !(RECIPE_VARIABLES as readonly string[]).includes(name));

export const recipeName = (recipe: Pick<Recipe, "name">, language: string): string =>
  (LANGUAGE_KEYS as readonly string[]).includes(language) ? recipe.name[language as RecipeLanguage] : recipe.name["pt-BR"];

/** Meeting recipes fit a meeting; library recipes fit the library and the meetings of a person or client. */
export const recipeFitsScope = (recipe: Pick<Recipe, "scope">, scope: AssistantScope): boolean =>
  recipe.scope === "meeting" ? scope.kind === "meeting" : scope.kind !== "meeting";

export const assertRecipeFitsScope = (recipe: Pick<Recipe, "scope">, scope: AssistantScope): void => {
  if (!recipeFitsScope(recipe, scope)) throw new RecipeValidationError(RECIPE_MESSAGES.scopeMismatch, "scope");
};

type BuiltInDraft = Omit<Recipe, "builtIn" | "version"> & { version?: number };

const DRAFTS: BuiltInDraft[] = [
  {
    id: "follow-up-email",
    name: { "pt-BR": "E-mail de follow-up", en: "Follow-up email", es: "Correo de seguimiento" },
    description: "A follow-up email to the attendees with decisions and next steps, ready to send.",
    scope: "meeting",
    prompt: `Write a follow-up email about the meeting "{{meeting.title}}" ({{meeting.date}}) that I can send as it is to the people who attended: {{meeting.people}}. Client or account: {{client}}.

Write in {{language}}, in the first person, as someone who took part in the meeting. Tone: professional, warm and direct; no filler and no buzzwords.

Structure:
1. A subject line, introduced by the word for "Subject" in {{language}}, specific to this meeting (never just "Follow-up").
2. A one-line greeting to the attendees.
3. One or two sentences on why we met and what we achieved.
4. Decisions: a short bullet list of what was agreed, stated as facts.
5. Next steps: a bullet list where each item starts with a verb and names the owner and the due date exactly as agreed. When the meeting did not settle an owner or a date, write "owner to be confirmed" or "date to be confirmed" (in {{language}}) instead of guessing.
6. Open points: questions that still need an answer, each addressed to the person who can answer it when that was said.
7. A closing line that invites corrections, then a sign-off without inventing my name.

Rules:
- Use only what was said in the meeting. Do not invent commitments, numbers, prices, dates or names.
- Leave out side remarks, jokes, internal opinions and anything said off the record or that sounds confidential.
- Keep it under 250 words unless there were many decisions.
- If you need to cite sources, put the citation markers on a final "Sources" line after the email, never inside it, so the email stays ready to send.`
  },
  {
    id: "risks",
    name: { "pt-BR": "Riscos e mitigações", en: "Risks and mitigations", es: "Riesgos y mitigaciones" },
    description: "A risk register with likelihood, impact, owner and mitigation for each risk raised or implied in the meeting.",
    scope: "meeting",
    prompt: `Build a risk register from the meeting "{{meeting.title}}" ({{meeting.date}}; client or account: {{client}}). Write in {{language}}.

Look for risks to delivery, schedule, cost, scope, technical quality, security and compliance, operations, and the client relationship. Include the risks people raised and the risks that clearly follow from what was said (dependencies, single points of failure, unclear ownership, optimistic estimates, decisions still missing). Mark the second kind as "inferred".

For each risk give:
- Risk: one sentence in the form "If <cause>, then <impact>".
- Evidence: what in the meeting supports it.
- Likelihood and impact: low, medium or high each, with a few words of justification.
- Owner: the person named in the meeting, or "unassigned". Never choose an owner yourself.
- Mitigation: one concrete action that reduces the risk, with a due date if one was mentioned.
- Early warning: the signal that would show the risk is materialising.

Output a Markdown table with those columns, ordered by likelihood and impact (highest first), then a short "Act this week" list with the three mitigations that matter most. If the meeting shows no meaningful risk, say so in one sentence instead of padding the table.

Rules: base every risk on what was said; do not invent facts, figures, owners or dates; keep inferred risks clearly marked so they can be checked.`
  },
  {
    id: "postmortem-doc",
    name: { "pt-BR": "Documento de postmortem", en: "Incident postmortem", es: "Postmortem del incidente" },
    description: "A blameless incident postmortem with impact, timeline, root cause and action items, ready to share.",
    scope: "meeting",
    prompt: `Write a blameless incident postmortem from the meeting "{{meeting.title}}" ({{meeting.date}}; client or system owner: {{client}}). Write in {{language}}, as a document ready to share with engineering and stakeholders.

Sections, in this order:
1. Summary: what happened, who or what was affected and for how long, in three to five sentences.
2. Impact: effects on users, systems, data and the business. Give numbers (error rates, downtime, affected customers, cost) only if they were stated.
3. Timeline: a table of time and event, in order, with times as they were said; mark approximate times with "~" and make detection, escalation, mitigation and resolution easy to spot.
4. Detection: how the incident was noticed and how long that took.
5. Root cause and contributing factors: the technical and process causes, as deep as the discussion supports. If the root cause is still unknown, say so and list the hypotheses being tested.
6. Resolution and recovery: what fixed it and what was done to recover.
7. What went well, what went badly, and where we got lucky.
8. Action items: a table with action, type (prevent, detect, mitigate or process), owner, due date and priority. Use only owners and dates that were stated; otherwise write "to be defined".
9. Open questions.

Rules: describe systems, signals and decisions, never individual blame; do not invent timestamps, metrics or causes; keep the language precise and factual.`
  },
  {
    id: "executive-summary",
    name: { "pt-BR": "Resumo executivo", en: "Executive summary", es: "Resumen ejecutivo" },
    description: "A two-minute summary for a leader who was not in the meeting: outcome, decisions, risks and asks.",
    scope: "meeting",
    prompt: `Write an executive summary of the meeting "{{meeting.title}}" ({{meeting.date}}; participants: {{meeting.people}}; client or account: {{client}}) for a senior leader who was not there and has two minutes. Write in {{language}}.

Format:
- Bottom line: two or three sentences with the outcome and what it means for the business or the project.
- Key decisions: up to five bullets.
- Risks and blockers that need leadership attention, each with its consequence if ignored.
- Asks: decisions, approvals, budget or help needed from leadership, with the deadline if one was mentioned. Write "No asks" (in {{language}}) when there are none.
- Next milestones: what happens next and when.

Rules: at most 200 words; plain language, no jargon and no unexplained acronyms; numbers only if they were stated; no invented dates or owners; lead with what matters most, not with the order of the discussion.`
  },
  {
    id: "next-steps",
    name: { "pt-BR": "Próximos passos", en: "Next steps", es: "Próximos pasos" },
    description: "The agreed actions as a checklist grouped by owner, with due dates and dependencies.",
    scope: "meeting",
    prompt: `List the next steps agreed in the meeting "{{meeting.title}}" ({{meeting.date}}; participants: {{meeting.people}}). Write in {{language}}.

Output a Markdown checklist ("- [ ] …") grouped by owner. Each item:
- starts with a verb and is specific enough to act on without having been in the meeting;
- shows the due date as agreed, or "date to be confirmed";
- notes a dependency or blocker when one was mentioned.

Rules:
- Include only actions someone committed to or the group clearly agreed on; put suggestions nobody took on in a separate "Not owned yet" list.
- Never invent actions, owners or dates. Items without a stated owner go under "Owner to be confirmed".
- Merge duplicates and drop anything that was already done during the meeting.
- After the checklist, add "Waiting on others" for what we depend on from people outside the meeting, and end with one line naming the single most important next step.`
  },
  {
    id: "slack-update",
    name: { "pt-BR": "Atualização para o Slack", en: "Slack update", es: "Actualización para Slack" },
    description: "A short team-channel update with the outcome, blockers and next steps, ready to post.",
    scope: "meeting",
    prompt: `Write a short Slack message for the team channel about the meeting "{{meeting.title}}" ({{meeting.date}}). Write in {{language}}.

Format:
- First line: a bold one-line headline with the outcome.
- Three to six bullets: decisions, progress and blockers, most important first.
- A last line introduced by the word for "Next" in {{language}}, listing the next steps with their owners by name.

Rules: at most 120 words; simple Markdown only (bold and bullets, no headings or tables); no @mentions, channel mentions or links; no confidential details, prices or personal remarks; never invent anything that was not said in the meeting. If you need to cite sources, put the markers on a separate final line so the message can be posted as it is.`
  },
  {
    id: "open-questions",
    name: { "pt-BR": "Perguntas em aberto", en: "Open questions", es: "Preguntas abiertas" },
    description: "What is still undecided or unknown after the meeting, who can answer it and how to close it.",
    scope: "meeting",
    prompt: `List what is still open after the meeting "{{meeting.title}}" ({{meeting.date}}; client or account: {{client}}). Write in {{language}}.

Group the items under these headings and leave out empty groups:
- Decisions pending
- Technical unknowns
- Business and commercial questions
- Assumptions to validate
- Unresolved disagreements

For each item give: the question, phrased so that it can be answered; why it matters (what it blocks or changes); who can answer it, if someone was named; and a suggested way to close it (a test, a document, a call), with a date if one was mentioned.

Rules: include only questions that came up or that the discussion clearly left unanswered; skip questions answered later in the same meeting; never invent who is responsible.`
  },
  {
    id: "formal-minutes",
    name: { "pt-BR": "Ata formal", en: "Formal minutes", es: "Acta formal" },
    description: "Neutral meeting minutes for the record, with agenda, discussion, decisions and action items.",
    scope: "meeting",
    prompt: `Write formal minutes of the meeting "{{meeting.title}}" held on {{meeting.date}}. Participants: {{meeting.people}}. Client or account: {{client}}. Write in {{language}}, in a neutral, third-person, past-tense style suitable for record keeping.

Structure:
1. Header: title, date and time, participants, and the client or account if any.
2. Agenda: the topics covered, in the order they were discussed.
3. For each topic: a concise, neutral summary of the discussion and of the positions expressed, then the decisions taken. Attribute positions to people only when the record makes clear who said what.
4. Action items: a table with item, owner and due date; write "to be defined" when no owner or date was agreed.
5. Next meeting: date and agenda, if they were mentioned.
6. A closing note stating that the minutes were prepared from the meeting record and that corrections should be sent to the organiser.

Rules: no opinions, adjectives or interpretation; quote exact words only when a decision depends on them; do not invent attendance, votes, dates or figures.`
  },
  {
    id: "prep-next-meeting",
    name: { "pt-BR": "Preparar a próxima reunião", en: "Prepare my next meeting", es: "Preparar mi próxima reunión" },
    description: "A briefing built from past meetings: where things stand, commitments, open topics and a suggested agenda.",
    scope: "library",
    prompt: `Prepare me for my next meeting. Scope: {{scope}}. Client or account, if any: {{client}}. Person, if any: {{person}}. Today is {{today}}. Write in {{language}}.

Use the past meetings provided, most recent first, and give me:
1. Where things stand: three bullets on the current state.
2. Commitments: what each side promised, the meeting it came from, and whether it looks done, open or unknown. List my own commitments first.
3. Decisions already made, so we do not reopen them without new information.
4. Unresolved topics and open questions carried over.
5. Sensitivities: concerns, frustrations or risks raised before that I should handle with care.
6. A suggested agenda: three to five items, each with its goal and a time box.
7. Questions I should ask, and anything I should prepare or bring.

Rules: name the meeting (date and title) each point comes from; say plainly when the history is thin; do not invent commitments, dates or status.`
  },
  {
    id: "what-did-i-promise",
    name: { "pt-BR": "O que eu prometi?", en: "What did I promise?", es: "¿Qué prometí?" },
    description: "Every commitment you made across meetings, with who it was for, due dates and status.",
    scope: "library",
    prompt: `Find every commitment I made in the meetings provided. Scope: {{scope}}. My name, if known: {{me}}. Today is {{today}}. Write in {{language}}.

A commitment is something I said I would do or deliver ("I'll send…", "I can take that", "let me check", "deixa comigo", "yo me encargo"), or an action item assigned to me that I accepted. When my name is not known, rely on first-person commitments and on action items whose owner is the person recording.

Output:
1. "Overdue or due soon": commitments with a due date before {{today}} or within seven days of it.
2. A table with: commitment, to whom, meeting (date and title), due date as said (or "none stated"), and status (done, open or unclear, judged from later meetings).
3. "We promised": commitments I made on behalf of my team, listed separately.

Rules: quote or closely paraphrase what I actually said; do not count vague intentions ("we should…") as promises unless I took them on; never invent due dates, and never mark something done without evidence from a later meeting.`
  }
];

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
};

/** Built-in recipes in catalog order (validated, frozen). */
export const BUILT_IN_RECIPES: readonly Recipe[] = deepFreeze(DRAFTS.map((draft) => validateRecipe({ ...draft, version: draft.version ?? 1, builtIn: true })));

export const builtInRecipe = (id: unknown): Recipe | undefined => BUILT_IN_RECIPES.find((recipe) => recipe.id === id);
