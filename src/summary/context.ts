import {
  validateSummary,
  type RecordingSummary,
  type SummaryClientHint,
  type SummaryContext
} from "../jobs/types";
import type { TimesheetContext } from "../timesheet/types";
import type { SummaryProvider } from "../config/defaults";
import type { SummaryInputEvidence } from "./evidence";

const normalized = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const uniqueStrings = (values: string[]): string[] => {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = normalized(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const preferredClientName = (
  name: string,
  aliases: string[]
): string => {
  const normalizedName = normalized(name);
  const suffix = aliases.find((alias) => {
    const candidate = normalized(alias);
    return (
      candidate.length >= 2 &&
      (normalizedName === candidate ||
        normalizedName.endsWith(` ${candidate}`))
    );
  });
  return suffix || name;
};

export const buildSummaryClientHints = (
  context: TimesheetContext
): SummaryClientHint[] =>
  context.clients.slice(0, 100).map((client) => {
    const name = preferredClientName(client.name, client.aliases);
    return {
      code: client.code,
      name,
      aliases: uniqueStrings([
        client.name,
        ...client.aliases
      ]).slice(0, 20)
    };
  });

export const buildSummaryUserContent = (
  transcript: string,
  context?: SummaryContext,
  evidence?: SummaryInputEvidence,
  maxCharacters = 24_000
): string => {
  const content = JSON.stringify({
    meeting: context?.meeting,
    clients: context?.clients || [],
    transcript,
    ...(evidence ? { evidence } : {})
  });
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 4096 || maxCharacters > 200_000 || content.length > maxCharacters) {
    throw new Error("Summary input exceeds the explicit character budget; chunking or an explicit larger budget is required");
  }
  return content;
};

const escapeRegularExpression = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const replaceAlias = (
  value: string,
  alias: string,
  canonicalName: string
): string => {
  if (!value || normalized(alias) === normalized(canonicalName)) return value;
  const expression = new RegExp(
    `(^|[^\\p{L}\\p{N}])(${escapeRegularExpression(alias)})(?=$|[^\\p{L}\\p{N}])`,
    "giu"
  );
  return value.replace(
    expression,
    (_match, prefix: string) => `${prefix}${canonicalName}`
  );
};

const canonicalizeText = (
  value: string,
  clients: SummaryClientHint[]
): string => {
  let result = value;
  for (const client of clients) {
    const aliases = [...client.aliases].sort(
      (left, right) => right.length - left.length
    );
    for (const alias of aliases) {
      result = replaceAlias(result, alias, client.name);
    }
  }
  return result;
};

const calendarTitle = (
  generatedTitle: string,
  context?: SummaryContext
): string => {
  const meeting = context?.meeting;
  if (!meeting || meeting.confidence < 0.8) return generatedTitle;
  if (
    normalized(generatedTitle).startsWith(normalized(meeting.title))
  ) {
    return `${meeting.title}${generatedTitle.slice(meeting.title.length)}`.slice(
      0,
      160
    );
  }
  const suffix = generatedTitle
    .replace(/^(?:reunião|call|conversa|meeting)\s*[-—:]\s*/i, "")
    .trim();
  return `${meeting.title}${suffix ? ` — ${suffix}` : ""}`.slice(0, 160);
};

export const canonicalizeSummary = (
  summary: RecordingSummary,
  context: SummaryContext | undefined,
  provider: SummaryProvider,
  model: string
): RecordingSummary => {
  const clients = context?.clients || [];
  const value = {
    ...(summary.citations ? { citations: summary.citations } : {}),
    ...(summary.limitations ? { limitations: summary.limitations } : {}),
    ...(summary.support ? { support: summary.support } : {}),
    title: calendarTitle(
      canonicalizeText(summary.title, clients),
      context
    ),
    overview: canonicalizeText(summary.overview, clients),
    topics: summary.topics.map((topic) =>
      canonicalizeText(topic, clients)
    ),
    decisions: summary.decisions.map((decision) =>
      canonicalizeText(decision, clients)
    ),
    actionItems: summary.actionItems.map((item) => ({
      description: canonicalizeText(item.description, clients),
      owner: canonicalizeText(item.owner, clients),
      dueDate: item.dueDate
    }))
  };
  return validateSummary(value, provider, model);
};
