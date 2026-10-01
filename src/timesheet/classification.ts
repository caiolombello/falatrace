import OpenAI from "openai";
import type { AppConfig } from "../config/defaults";
import type { RecordingSummary, Transcript } from "../jobs/types";
import type {
  TimeEntry,
  TimeEntryActivitySuggestion,
  TimeEntrySuggestion,
  TimesheetContext
} from "./types";
import { buildActivityPlan } from "./allocation";

const MAX_TRANSCRIPT_CONTEXT = 50_000;

export const TIME_ENTRY_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "clientCode",
    "taskTypeId",
    "description",
    "cardId",
    "clientConfidence",
    "taskTypeConfidence",
    "descriptionConfidence",
    "evidence",
    "activities"
  ],
  properties: {
    clientCode: { type: "string", maxLength: 20 },
    taskTypeId: { type: "integer", minimum: 0 },
    description: { type: "string", maxLength: 5000 },
    cardId: { type: "string", maxLength: 100 },
    clientConfidence: { type: "number", minimum: 0, maximum: 1 },
    taskTypeConfidence: { type: "number", minimum: 0, maximum: 1 },
    descriptionConfidence: { type: "number", minimum: 0, maximum: 1 },
    evidence: {
      type: "array",
      maxItems: 20,
      items: { type: "string", maxLength: 500 }
    },
    activities: {
      type: "array",
      minItems: 1,
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "clientCode",
          "taskTypeId",
          "description",
          "cardId",
          "startSeconds",
          "endSeconds",
          "clientConfidence",
          "taskTypeConfidence",
          "descriptionConfidence",
          "timingConfidence",
          "evidence"
        ],
        properties: {
          clientCode: { type: "string", maxLength: 20 },
          taskTypeId: { type: "integer", minimum: 0 },
          description: { type: "string", minLength: 1, maxLength: 2_000 },
          cardId: { type: "string", maxLength: 100 },
          startSeconds: { type: "number", minimum: -1, maximum: 86_400 },
          endSeconds: { type: "number", minimum: -1, maximum: 86_400 },
          clientConfidence: { type: "number", minimum: 0, maximum: 1 },
          taskTypeConfidence: { type: "number", minimum: 0, maximum: 1 },
          descriptionConfidence: { type: "number", minimum: 0, maximum: 1 },
          timingConfidence: { type: "number", minimum: 0, maximum: 1 },
          evidence: {
            type: "array",
            maxItems: 8,
            items: { type: "string", minLength: 1, maxLength: 500 }
          }
        }
      }
    }
  }
} as const;

export const TIME_ENTRY_SYSTEM_PROMPT = `Classifique uma gravação de trabalho para um apontamento de horas.
Use somente clientes e tipos fornecidos no catálogo. Retorne clientCode vazio ou taskTypeId 0
quando não houver evidência suficiente. Pessoas internas, isoladamente, não provam que o cliente
é a própria organização; uma conversa interna pode tratar de outro cliente. Responsáveis por cliente são apenas
pistas fracas. O card é opcional e só pode ser retornado quando aparecer explicitamente no conteúdo,
usando a referência original informada (sem espaços, até 100 caracteres). Gere uma descrição objetiva do trabalho realizado, em português,
sem inventar decisões, resultados, responsáveis ou prazos. Não escreva uma ata completa.
As evidências devem explicar brevemente a classificação e nunca incluir e-mails.

Além do apontamento consolidado, identifique entre uma e cinco atividades de trabalho coerentes.
Uma troca de assunto, comentário breve ou item apenas discutido não constitui automaticamente uma
nova atividade. Una trechos adjacentes com o mesmo cliente e tipo. O apontamento principal deve
continuar consolidado por padrão e refletir a atividade predominante; atividades secundárias
relevantes podem aparecer na descrição. Separe candidatas somente quando houver trabalho material
para clientes diferentes ou tipos de tarefa realmente distintos. Para cada atividade, informe o
intervalo relativo à gravação usando os timestamps fornecidos. Use -1 em início e fim quando o
intervalo não puder ser sustentado pelo conteúdo; nunca invente duração.`;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalized = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const boundedConfidence = (value: unknown, field: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${field} must be between 0 and 1`);
  }
  return value;
};

const validateActivitySuggestion = (
  value: unknown,
  context: TimesheetContext,
  index: number
): TimeEntryActivitySuggestion => {
  if (!isObject(value)) {
    throw new Error(`Time entry activity ${index} is not an object`);
  }
  const clientCode =
    typeof value.clientCode === "string"
      ? value.clientCode.trim().toUpperCase()
      : "";
  const taskTypeId = value.taskTypeId;
  const description =
    typeof value.description === "string" ? value.description.trim() : "";
  const cardId =
    typeof value.cardId === "string" ? value.cardId.trim().toUpperCase() : "";
  if (clientCode && !context.clients.some((client) => client.code === clientCode)) {
    throw new Error("Time entry activity referenced an unknown client");
  }
  if (
    !Number.isSafeInteger(taskTypeId) ||
    Number(taskTypeId) < 0 ||
    (Number(taskTypeId) > 0 &&
      !context.taskTypes.some((taskType) => taskType.id === Number(taskTypeId)))
  ) {
    throw new Error("Time entry activity referenced an unknown task type");
  }
  if (
    !description ||
    description.length > 2_000 ||
    /[\u0000-\u001f\u007f-\u009f]/.test(description)
  ) {
    throw new Error("Time entry activity description is invalid");
  }
  if (cardId && !/^[A-Z]+-\d+$/.test(cardId)) {
    throw new Error("Time entry activity card id is invalid");
  }
  const startSeconds = value.startSeconds;
  const endSeconds = value.endSeconds;
  const unknownTiming = startSeconds === -1 && endSeconds === -1;
  if (
    !unknownTiming &&
    (typeof startSeconds !== "number" ||
      !Number.isFinite(startSeconds) ||
      startSeconds < 0 ||
      startSeconds > 86_400 ||
      typeof endSeconds !== "number" ||
      !Number.isFinite(endSeconds) ||
      endSeconds <= startSeconds ||
      endSeconds > 86_400)
  ) {
    throw new Error("Time entry activity interval is invalid");
  }
  if (
    !Array.isArray(value.evidence) ||
    value.evidence.length > 8 ||
    value.evidence.some(
      (item) =>
        typeof item !== "string" ||
        item.length === 0 ||
        item.length > 500 ||
        /[\u0000-\u001f\u007f-\u009f]/.test(item)
    )
  ) {
    throw new Error("Time entry activity evidence is invalid");
  }
  return {
    clientCode: clientCode || undefined,
    taskTypeId: Number(taskTypeId) || undefined,
    description,
    cardId: cardId || undefined,
    startSeconds: unknownTiming ? undefined : Number(startSeconds),
    endSeconds: unknownTiming ? undefined : Number(endSeconds),
    confidence: {
      client: boundedConfidence(
        value.clientConfidence,
        "activity.clientConfidence"
      ),
      taskType: boundedConfidence(
        value.taskTypeConfidence,
        "activity.taskTypeConfidence"
      ),
      description: boundedConfidence(
        value.descriptionConfidence,
        "activity.descriptionConfidence"
      ),
      timing: boundedConfidence(
        value.timingConfidence,
        "activity.timingConfidence"
      )
    },
    evidence: value.evidence as string[]
  };
};

export const validateTimeEntrySuggestion = (
  value: unknown,
  context: TimesheetContext
): TimeEntrySuggestion => {
  if (!isObject(value)) throw new Error("Time entry suggestion is not an object");
  const clientCode =
    typeof value.clientCode === "string" ? value.clientCode.trim().toUpperCase() : "";
  const taskTypeId = value.taskTypeId;
  const description =
    typeof value.description === "string" ? value.description.trim() : "";
  const cardId = typeof value.cardId === "string" ? value.cardId.trim().toUpperCase() : "";
  if (clientCode && !context.clients.some((client) => client.code === clientCode)) {
    throw new Error("Time entry suggestion referenced an unknown client");
  }
  if (
    !Number.isSafeInteger(taskTypeId) ||
    Number(taskTypeId) < 0 ||
    (Number(taskTypeId) > 0 &&
      !context.taskTypes.some((taskType) => taskType.id === Number(taskTypeId)))
  ) {
    throw new Error("Time entry suggestion referenced an unknown task type");
  }
  if (
    description.length > 5_000 ||
    /[\r\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(description)
  ) {
    throw new Error("Time entry suggestion description is invalid");
  }
  if (cardId && !/^[A-Z]+-\d+$/.test(cardId)) {
    throw new Error("Time entry suggestion card id is invalid");
  }
  if (
    !Array.isArray(value.evidence) ||
    value.evidence.length > 20 ||
    value.evidence.some(
      (item) =>
        typeof item !== "string" ||
        item.length === 0 ||
        item.length > 500 ||
        /[\u0000-\u001f\u007f-\u009f]/.test(item)
    )
  ) {
    throw new Error("Time entry suggestion evidence is invalid");
  }
  if (
    !Array.isArray(value.activities) ||
    value.activities.length < 1 ||
    value.activities.length > 5
  ) {
    throw new Error("Time entry suggestion activities are invalid");
  }
  return {
    clientCode: clientCode || undefined,
    taskTypeId: Number(taskTypeId) || undefined,
    description: description || undefined,
    cardId: cardId || undefined,
    confidence: {
      client: boundedConfidence(value.clientConfidence, "clientConfidence"),
      taskType: boundedConfidence(value.taskTypeConfidence, "taskTypeConfidence"),
      description: boundedConfidence(
        value.descriptionConfidence,
        "descriptionConfidence"
      )
    },
    evidence: value.evidence as string[],
    activities: value.activities.map((activity, index) =>
      validateActivitySuggestion(activity, context, index)
    )
  };
};

const summaryText = (summary: RecordingSummary): string =>
  [
    summary.title,
    summary.overview,
    ...summary.topics,
    ...summary.decisions,
    ...summary.actionItems.map((item) => item.description)
  ]
    .filter(Boolean)
    .join("\n");

const matchClients = (
  context: TimesheetContext,
  content: string
): TimesheetContext["clients"] => {
  const searchable = ` ${normalized(content)} `;
  return context.clients.filter((client) =>
    [client.code, client.name, ...client.aliases].some((candidate) => {
      const term = normalized(candidate);
      return term.length >= 3 && searchable.includes(` ${term} `);
    })
  );
};

export const buildDeterministicSuggestion = (
  summary: RecordingSummary,
  transcript: Transcript,
  context: TimesheetContext
): TimeEntrySuggestion => {
  const content = `${summaryText(summary)}\n${transcript.text.slice(0, MAX_TRANSCRIPT_CONTEXT)}`;
  const matchedClients = matchClients(context, content);
  const card = content.match(/\b[A-Za-z]+-\d+\b/)?.[0]?.toUpperCase();
  const clientCode =
    matchedClients.length === 1 ? matchedClients[0].code : undefined;
  const description = summary.overview.trim().slice(0, 5_000) || undefined;
  return {
    clientCode,
    description,
    cardId: card,
    classificationSource: "rules",
    confidence: {
      client: matchedClients.length === 1 ? 0.9 : 0,
      taskType: 0,
      description: summary.overview.trim() ? 0.85 : 0
    },
    evidence: [
      ...(matchedClients.length === 1
        ? [`Cliente citado no conteúdo: ${matchedClients[0].code} ${matchedClients[0].name}.`]
        : matchedClients.length > 1
          ? ["Mais de um cliente foi citado; seleção manual necessária."]
          : ["Nenhum cliente do catálogo foi identificado diretamente."]),
      ...(card ? [`Card citado explicitamente: ${card}.`] : []),
      "Descrição gerada a partir do resumo processado."
    ],
    activities: description
      ? [
          {
            clientCode,
            description: description.slice(0, 2_000),
            cardId: card,
            confidence: {
              client: matchedClients.length === 1 ? 0.9 : 0,
              taskType: 0,
              description: 0.85,
              timing: 0
            },
            evidence: ["Atividade consolidada a partir do resumo processado."]
          }
        ]
      : []
  };
};

const boundedTranscriptSegments = (
  transcript: Transcript
): Array<{ start: number; end: number; text: string }> => {
  const result: Array<{ start: number; end: number; text: string }> = [];
  let remaining = MAX_TRANSCRIPT_CONTEXT;
  for (const segment of transcript.segments) {
    if (remaining <= 0) break;
    const text = segment.text.slice(0, remaining);
    if (!text) continue;
    result.push({ start: segment.start, end: segment.end, text });
    remaining -= text.length;
  }
  return result;
};

const buildUserContent = (
  entry: TimeEntry,
  summary: RecordingSummary,
  transcript: Transcript,
  context: TimesheetContext
): string =>
  JSON.stringify({
    activity: {
      source: entry.source.kind,
      application: entry.source.app || "",
      startAt: entry.startAt || "",
      endAt: entry.endAt || "",
      hours: entry.hours || 0
    },
    clients: context.clients.map((client) => ({
      code: client.code,
      name: client.name,
      aliases: client.aliases,
      responsibleNames: client.responsibleNames
    })),
    internalColleagues: context.colleagues.map((colleague) => colleague.name),
    taskTypes: context.taskTypes,
    summary: {
      title: summary.title,
      overview: summary.overview,
      topics: summary.topics,
      decisions: summary.decisions,
      actionItems: summary.actionItems
    },
    transcriptSegments: boundedTranscriptSegments(transcript),
    transcriptExcerpt:
      transcript.segments.length === 0
        ? transcript.text.slice(0, MAX_TRANSCRIPT_CONTEXT)
        : ""
  });

export const classifyTimeEntry = async (
  config: AppConfig,
  entry: TimeEntry,
  summary: RecordingSummary,
  transcript: Transcript,
  context: TimesheetContext
): Promise<TimeEntrySuggestion> => {
  const fallback = buildDeterministicSuggestion(summary, transcript, context);
  if (!config.timesheet.aiClassification) return fallback;
  const apiKey = process.env.OPENAI_API_KEY || config.openai.apiKey;
  if (!apiKey) {
    return {
      ...fallback,
      evidence: [...fallback.evidence, "Classificação por IA indisponível: chave não configurada."]
    };
  }
  const client = new OpenAI({ apiKey });
  const response = await client.chat.completions.create({
    model: config.timesheet.aiModel,
    messages: [
      { role: "system", content: TIME_ENTRY_SYSTEM_PROMPT },
      { role: "user", content: buildUserContent(entry, summary, transcript, context) }
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "time_entry_suggestion",
        strict: true,
        schema: TIME_ENTRY_JSON_SCHEMA
      }
    }
  });
  const content = response.choices[0]?.message.content;
  if (!content) throw new Error("OpenAI time entry response was empty");
  return {
    ...validateTimeEntrySuggestion(JSON.parse(content), context),
    classificationSource: "openai"
  };
};

export const deriveTimeEntryStatus = (
  entry: TimeEntry,
  context: TimesheetContext,
  readyConfidence: number
): TimeEntry["status"] => {
  if (entry.status === "capturing" || entry.status === "synced") return entry.status;
  const clientExists = context.clients.some(
    (client) => client.code === entry.clientCode
  );
  const taskTypeExists = context.taskTypes.some(
    (taskType) => taskType.id === entry.taskTypeId
  );
  const complete =
    clientExists &&
    taskTypeExists &&
    Boolean(entry.description?.trim()) &&
    typeof entry.hours === "number" &&
    entry.hours >= 0.1 &&
    entry.hours <= 24;
  const confident =
    entry.confidence.client >= readyConfidence &&
    entry.confidence.taskType >= readyConfidence &&
    entry.confidence.description >= readyConfidence;
  return complete && confident ? "ready" : "draft";
};

export const applyTimeEntrySuggestion = (
  entry: TimeEntry,
  suggestion: TimeEntrySuggestion,
  context: TimesheetContext,
  readyConfidence: number
): TimeEntry => {
  const locked = new Set(entry.lockedFields);
  const client = suggestion.clientCode
    ? context.clients.find((item) => item.code === suggestion.clientCode)
    : undefined;
  const taskType = suggestion.taskTypeId
    ? context.taskTypes.find((item) => item.id === suggestion.taskTypeId)
    : undefined;
  const updated: TimeEntry = {
    ...entry,
    clientCode: locked.has("client") ? entry.clientCode : client?.code,
    clientName: locked.has("client") ? entry.clientName : client?.name,
    taskTypeId: locked.has("taskType") ? entry.taskTypeId : taskType?.id,
    taskTypeName: locked.has("taskType") ? entry.taskTypeName : taskType?.name,
    description: locked.has("description")
      ? entry.description
      : suggestion.description || entry.description,
    cardId: locked.has("card") ? entry.cardId : suggestion.cardId || entry.cardId,
    confidence: {
      client: locked.has("client") ? entry.confidence.client : suggestion.confidence.client,
      taskType: locked.has("taskType")
        ? entry.confidence.taskType
        : suggestion.confidence.taskType,
      description: locked.has("description")
        ? entry.confidence.description
        : suggestion.confidence.description
    },
    evidence: suggestion.evidence,
    activityPlan: buildActivityPlan(
      suggestion.activities,
      entry.hours,
      readyConfidence
    ),
    classificationStatus: "completed",
    classificationSource:
      suggestion.classificationSource || entry.classificationSource,
    classificationError: undefined,
    updatedAt: new Date().toISOString()
  };
  return {
    ...updated,
    status: deriveTimeEntryStatus(updated, context, readyConfidence)
  };
};
