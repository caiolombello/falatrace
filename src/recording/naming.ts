const pad = (value: number): string => String(value).padStart(2, "0");

export const formatName = (template: string, title?: string): string => {
  const now = new Date();
  const safeTitle = (title ?? "recording")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9_-]/g, "");

  return template
    .replaceAll("YYYY", String(now.getFullYear()))
    .replaceAll("MM", pad(now.getMonth() + 1))
    .replaceAll("DD", pad(now.getDate()))
    .replaceAll("HH", pad(now.getHours()))
    .replaceAll("mm", pad(now.getMinutes()))
    .replaceAll("[title]", safeTitle || "recording");
};
