import type { TimeEntry, TimesheetContext } from "./types";

const pad = (value: number): string => String(value).padStart(2, "0");
export const sanitizeTimeEntryText = (value: string): string =>
  value
    .replace(/\r/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");

export const formatClock = (timestamp?: string): string => {
  if (!timestamp) return "—";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "—";
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

export const formatHours = (hours?: number): string =>
  hours === undefined ? "—" : hours.toFixed(2).replace(".", ",");

const timeEntryStatus = (entry: TimeEntry): string => {
  if (entry.status === "capturing") return "em andamento";
  if (entry.status === "draft") return "revisar";
  if (entry.status === "ready") return "pronto";
  return "enviado";
};

const classificationStatus = (entry: TimeEntry): string => {
  if (entry.classificationStatus === "pending") return "aguardando classificação";
  if (entry.classificationStatus === "failed") return "classificação falhou";
  if (entry.classificationStatus === "completed") {
    if (entry.classificationSource === "openai") return "concluída · OpenAI";
    if (entry.classificationSource === "rules") return "concluída · regras locais";
    return "concluída · origem não registrada";
  }
  return "preenchimento manual";
};

const fieldOrigin = (
  entry: TimeEntry,
  field: "client" | "taskType" | "description"
): string =>
  entry.lockedFields.includes(field)
    ? "= confirmado manualmente"
    : entry.classificationStatus === "completed"
      ? entry.classificationSource === "openai"
        ? "~ sugestão OpenAI"
        : entry.classificationSource === "rules"
          ? "~ sugestão por regras locais"
          : "~ sugestão automática · origem não registrada"
      : "— ainda não confirmado";

const formatOffset = (seconds?: number): string => {
  if (seconds === undefined) return "??:??";
  const rounded = Math.max(0, Math.round(seconds));
  const hours = Math.floor(rounded / 3_600);
  const minutes = Math.floor((rounded % 3_600) / 60);
  const remainingSeconds = rounded % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
};

export const formatTimeEntry = (
  entry: TimeEntry,
  context?: TimesheetContext
): string => {
  const client =
    entry.clientCode && entry.clientName
      ? `${entry.clientCode} ${entry.clientName}`
      : entry.clientCode || "?";
  const taskType =
    entry.taskTypeName ||
    context?.taskTypes.find((item) => item.id === entry.taskTypeId)?.name ||
    "?";
  const source =
    entry.source.kind === "call"
      ? `chamada ${entry.source.app === "slack" ? "Slack" : entry.source.app === "zen" ? "Zen" : entry.source.app === "helium" ? "Helium" : ""}`.trim()
      : entry.source.kind === "timer"
        ? "timer manual"
        : "registro manual";
  const activityPlan = entry.activityPlan
    ? [
        "",
        `Atividades detectadas: ${entry.activityPlan.activities.length}`,
        `Recomendação: ${entry.activityPlan.recommendation === "split" ? "dividir" : "manter consolidado"}`,
        `Motivo: ${entry.activityPlan.reason}`,
        `Divisão pela TUI: ${entry.activityPlan.splittable ? "disponível" : "indisponível sem intervalos confiáveis"}`,
        ...entry.activityPlan.activities.map((activity, index) => {
          const activityClient =
            context?.clients.find((item) => item.code === activity.clientCode);
          const activityTask =
            context?.taskTypes.find((item) => item.id === activity.taskTypeId);
          const interval = `${formatOffset(activity.startSeconds)}–${formatOffset(activity.endSeconds)}`;
          return `${index + 1}. [${interval}] ${activityClient?.code || activity.clientCode || "cliente ?"} · ${activityTask?.name || "tipo ?"} · ${activity.description}`;
        })
      ]
    : [];
  return [
    `Status: ${timeEntryStatus(entry)}`,
    `Cliente: ${client}  (${fieldOrigin(entry, "client")})`,
    `Tipo: ${taskType}  (${fieldOrigin(entry, "taskType")})`,
    `Data: ${entry.activityDate}`,
    `Início: ${formatClock(entry.startAt)}`,
    `Fim: ${formatClock(entry.endAt)}`,
    `Total: ${formatHours(entry.hours)} h`,
    `Card: ${entry.cardId || "—"}`,
    `Descrição: ${entry.description || "?"}  (${fieldOrigin(entry, "description")})`,
    `Origem: ${source}`,
    `Classificação: ${classificationStatus(entry)}`,
    `Confiança: cliente ${Math.round(entry.confidence.client * 100)}% · tipo ${Math.round(entry.confidence.taskType * 100)}% · descrição ${Math.round(entry.confidence.description * 100)}%`,
    ...(entry.splitGroupId
      ? [`Divisão: ${entry.splitIndex}/${entry.splitCount} · grupo ${entry.splitGroupId}`]
      : []),
    ...activityPlan,
    ...(entry.classificationError ? [`Erro: ${entry.classificationError}`] : []),
    ...(entry.evidence.length > 0
      ? ["", "Evidências:", ...entry.evidence.map((item) => `- ${item}`)]
      : []),
    ...(entry.source.recordingPath
      ? ["", `Gravação: ${entry.source.recordingPath}`]
      : []),
    ...(entry.source.jobId ? [`Job: ${entry.source.jobId}`] : [])
  ].join("\n").split("\n").map(sanitizeTimeEntryText).join("\n");
};
