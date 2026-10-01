import { createConnection } from "node:net";
import { runCommand } from "../jobs/command";
import type {
  CallApplication,
  NetworkTelemetry,
  ProcessNetworkTelemetry
} from "./types";

const emptyProcessTelemetry = (): ProcessNetworkTelemetry => ({
  tcpSockets: 0,
  udpSockets: 0,
  tcpBytesSent: 0,
  tcpBytesReceived: 0
});

const emptyTelemetry = (): NetworkTelemetry => ({
  slack: emptyProcessTelemetry(),
  zen: emptyProcessTelemetry(),
  helium: emptyProcessTelemetry()
});

export const getNetworkProbeSocketName = (): string => {
  const userId = typeof process.getuid === "function" ? process.getuid() : "user";
  return `\0recording-cli-${userId}-network-probe`;
};

const parseApplication = (record: string): CallApplication | null => {
  const match = record.match(/users:\(\(\"([^\"]+)\",pid=\d+/);
  return match?.[1] === "slack" || match?.[1] === "zen" || match?.[1] === "helium"
    ? match[1]
    : null;
};

const splitSocketRecords = (output: string): string[] => {
  const records: string[] = [];
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    if (/^\s/.test(line) && records.length > 0) {
      records[records.length - 1] += `\n${line}`;
    } else {
      records.push(line);
    }
  }
  return records;
};

export const parseNetworkTelemetry = (tcpOutput: string, udpOutput: string): NetworkTelemetry => {
  const telemetry = emptyTelemetry();
  for (const record of splitSocketRecords(tcpOutput)) {
    const app = parseApplication(record);
    if (!app) continue;
    telemetry[app].tcpSockets += 1;
    for (const match of record.matchAll(/bytes_sent:(\d+)/g)) {
      telemetry[app].tcpBytesSent += Number(match[1]);
    }
    for (const match of record.matchAll(/bytes_received:(\d+)/g)) {
      telemetry[app].tcpBytesReceived += Number(match[1]);
    }
  }
  for (const record of splitSocketRecords(udpOutput)) {
    const app = parseApplication(record);
    if (app) telemetry[app].udpSockets += 1;
  }
  return telemetry;
};

const isProcessTelemetry = (value: unknown): value is ProcessNetworkTelemetry => {
  if (!value || typeof value !== "object") return false;
  const telemetry = value as Record<string, unknown>;
  return ["tcpSockets", "udpSockets", "tcpBytesSent", "tcpBytesReceived"].every((key) =>
    Number.isSafeInteger(telemetry[key]) && Number(telemetry[key]) >= 0
  );
};

export const parseNetworkProbeResponse = (value: string): NetworkTelemetry => {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid network probe response");
  }
  const response = parsed as Record<string, unknown>;
  if (
    !isProcessTelemetry(response.slack) ||
    !isProcessTelemetry(response.zen) ||
    !isProcessTelemetry(response.helium)
  ) {
    throw new Error("Invalid network probe response");
  }
  return {
    slack: response.slack,
    zen: response.zen,
    helium: response.helium
  };
};

export const collectNetworkTelemetryDirect = async (): Promise<NetworkTelemetry> => {
  const [tcp, udp] = await Promise.all([
    runCommand("ss", ["-Htinp"], { timeoutMs: 3_000 }),
    runCommand("ss", ["-Hunp"], { timeoutMs: 3_000 })
  ]);
  return parseNetworkTelemetry(tcp.stdout, udp.stdout);
};

const requestNetworkProbe = async (): Promise<NetworkTelemetry> =>
  new Promise((resolve, reject) => {
    const socket = createConnection({ path: getNetworkProbeSocketName() });
    let response = "";
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else {
        try {
          resolve(parseNetworkProbeResponse(response));
        } catch (err) {
          reject(err);
        }
      }
    };
    socket.setEncoding("utf8");
    socket.setTimeout(3_000, () => finish(new Error("Network probe timed out")));
    socket.on("data", (chunk: string) => {
      response += chunk;
      if (response.length > 16_384) finish(new Error("Network probe response is too large"));
    });
    socket.once("end", () => finish());
    socket.once("error", (err) => finish(err));
  });

export const collectNetworkTelemetry = async (): Promise<NetworkTelemetry> => {
  try {
    return await requestNetworkProbe();
  } catch {
    return collectNetworkTelemetryDirect();
  }
};
