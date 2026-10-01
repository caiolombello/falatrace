import type {
  TimeEntryActivityPlan,
  TimeEntryActivitySuggestion
} from "./types";

const MINIMUM_SECONDARY_SECONDS = 15 * 60;
const MINIMUM_SECONDARY_SHARE = 0.2;

const activityDuration = (activity: TimeEntryActivitySuggestion): number =>
  activity.startSeconds !== undefined && activity.endSeconds !== undefined
    ? activity.endSeconds - activity.startSeconds
    : 0;

const hasReliableTiming = (
  activities: TimeEntryActivitySuggestion[],
  readyConfidence: number
): boolean => {
  const timed = activities.every(
    (activity) =>
      activity.startSeconds !== undefined &&
      activity.endSeconds !== undefined &&
      activity.confidence.timing >= readyConfidence
  );
  if (!timed) return false;
  const ordered = [...activities].sort(
    (left, right) => left.startSeconds! - right.startSeconds!
  );
  return ordered.every(
    (activity, index) =>
      index === 0 ||
      activity.startSeconds! >= ordered[index - 1].endSeconds!
  );
};

export const buildActivityPlan = (
  activities: TimeEntryActivitySuggestion[],
  totalHours: number | undefined,
  readyConfidence: number
): TimeEntryActivityPlan | undefined => {
  if (activities.length < 2) return undefined;
  const orderedActivities = activities.every(
    (activity) => activity.startSeconds !== undefined
  )
    ? [...activities].sort(
        (left, right) => left.startSeconds! - right.startSeconds!
      )
    : activities;
  const splittable =
    typeof totalHours === "number" &&
    totalHours > 0 &&
    hasReliableTiming(orderedActivities, readyConfidence);
  const clientCodes = new Set(
    orderedActivities
      .map((activity) => activity.clientCode)
      .filter((value): value is string => Boolean(value))
  );
  if (clientCodes.size > 1) {
    return {
      recommendation: "split",
      reason: "Foram identificados trabalhos atribuídos a clientes diferentes.",
      splittable,
      activities: orderedActivities
    };
  }

  const taskTypeIds = new Set(
    orderedActivities
      .map((activity) => activity.taskTypeId)
      .filter((value): value is number => value !== undefined)
  );
  if (taskTypeIds.size > 1 && splittable && totalHours) {
    const durationsByType = new Map<number, number>();
    for (const activity of orderedActivities) {
      if (activity.taskTypeId === undefined) continue;
      durationsByType.set(
        activity.taskTypeId,
        (durationsByType.get(activity.taskTypeId) || 0) +
          activityDuration(activity)
      );
    }
    const durations = [...durationsByType.values()].sort(
      (left, right) => right - left
    );
    const secondarySeconds = durations
      .slice(1)
      .reduce((total, duration) => total + duration, 0);
    if (
      secondarySeconds >= MINIMUM_SECONDARY_SECONDS &&
      secondarySeconds / (totalHours * 3_600) >= MINIMUM_SECONDARY_SHARE
    ) {
      return {
        recommendation: "split",
        reason:
          "Há tipos de tarefa distintos e a atividade secundária representa pelo menos 15 minutos e 20% da chamada.",
        splittable,
        activities: orderedActivities
      };
    }
  }

  const reason =
    taskTypeIds.size > 1 && !splittable
      ? "Há tipos de tarefa distintos, mas faltam intervalos confiáveis para justificar uma divisão."
      : "As atividades podem ser registradas juntas sem criar fragmentação desnecessária.";
  return {
    recommendation: "consolidate",
    reason,
    splittable,
    activities: orderedActivities
  };
};

export const allocateActivityHours = (
  plan: TimeEntryActivityPlan,
  totalHours: number
): number[] => {
  if (!plan.splittable) {
    throw new Error("Activity plan does not have reliable time intervals");
  }
  const totalHundredths = Math.round(totalHours * 100);
  if (
    !Number.isSafeInteger(totalHundredths) ||
    totalHundredths <= 0 ||
    totalHundredths > 2_400
  ) {
    throw new Error("Total hours are invalid");
  }
  const weights = plan.activities.map(activityDuration);
  const totalWeight = weights.reduce((total, weight) => total + weight, 0);
  if (weights.some((weight) => weight <= 0) || totalWeight <= 0) {
    throw new Error("Activity plan contains invalid time intervals");
  }
  const raw = weights.map((weight) => (weight / totalWeight) * totalHundredths);
  const allocated = raw.map(Math.floor);
  const remaining =
    totalHundredths - allocated.reduce((total, value) => total + value, 0);
  const order = raw
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort(
      (left, right) =>
        right.fraction - left.fraction || left.index - right.index
    );
  for (let index = 0; index < remaining; index += 1) {
    allocated[order[index].index] += 1;
  }
  if (allocated.some((value) => value <= 0)) {
    throw new Error("An activity interval is too short to allocate hours");
  }
  return allocated.map((value) => value / 100);
};
