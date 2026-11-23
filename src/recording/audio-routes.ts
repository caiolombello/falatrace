import { runCommand } from "../jobs/command";
import type { AudioSources } from "./capture";
import type { RecordingSession } from "./session";

/** The two FFmpeg Pulse clients have independent names even if the server has
 * already moved both streams onto the same fallback source during unplug. */
export const pulseClientName = (id: string, kind: string): string => `FalaTrace-${id}-${kind}`;

export class AudioMoveRefused extends Error {}

export async function moveDefaultInputs(
  session: RecordingSession, routes: (keyof AudioSources)[], pid: number, run = runCommand
): Promise<AudioSources> {
  const kinds = routes.filter(kind => session.audio?.[kind] && session.audioSelection?.[kind] === "default");
  if (!kinds.length) return {};
  if (!Number.isSafeInteger(pid) || pid <= 0) throw Error("O processo de captura não está ativo.");
  const list = async (type: string) => {
    const result = await run("pactl", ["--format=json", "list", type], { timeoutMs: 3000, maxOutputBytes: 2_000_000 });
    return JSON.parse(result.stdout) as { index: number; source?: number; name?: string; properties?: Record<string,string> }[];
  };
  const [sources, outputs, defaults] = await Promise.all([
    list("sources"), list("source-outputs"), Promise.all(kinds.map(async kind => {
      const { stdout } = await run("pactl", [kind === "desktop" ? "get-default-sink" : "get-default-source"], { timeoutMs: 3000 });
      return stdout.trim() + (kind === "desktop" ? ".monitor" : "");
    }))
  ]);
  const targets = { ...session.audio };
  for (const [i, kind] of kinds.entries()) targets[kind] = defaults[i];
  if (targets.desktop && targets.desktop === targets.microphone) {
    throw Error("O microfone e a saída da reunião apontam para a mesma fonte.");
  }
  const ownedByTrack = (properties: Record<string, string> | undefined, kind: keyof AudioSources) =>
    properties?.["application.name"] === pulseClientName(session.id, kind) && Number(properties["application.process.id"]) === pid;
  const moved = new Map<keyof AudioSources, number>();
  const updated: AudioSources = {};
  for (const [i, kind] of kinds.entries()) {
    const source = sources.find(item => item.name === defaults[i]);
    const owned = outputs.filter(item => ownedByTrack(item.properties, kind));
    if (source && !owned.length && session.namedPulseInputs) throw new AudioMoveRefused("A faixa anterior foi desconectada.");
    if (!source || !Number.isSafeInteger(source.index) || owned.length !== 1 || !Number.isSafeInteger(owned[0].index)) {
      throw Error("Não foi possível identificar a faixa da gravação ou o novo dispositivo.");
    }
    if (owned[0].source !== source.index) {
      try {
        await run("pactl", ["move-source-output", String(owned[0].index), String(source.index)], { timeoutMs: 3000 });
        moved.set(kind, source.index);
      } catch (cause) {
        throw new AudioMoveRefused("O servidor de áudio recusou a troca de dispositivo.", { cause });
      }
    }
    updated[kind] = source.name;
  }
  if (moved.size) {
    const after = await list("source-outputs");
    for (const [kind, target] of moved) {
      if (!after.some(item => ownedByTrack(item.properties, kind) && item.source === target)) {
        throw new AudioMoveRefused("O fluxo de áudio não chegou ao dispositivo selecionado.");
      }
    }
  }
  return updated;
}
