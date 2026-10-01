import { createServer, type Server, type Socket } from "node:net";
import {
  collectNetworkTelemetryDirect,
  getNetworkProbeSocketName
} from "./network";

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((err) => err ? reject(err) : resolve());
  });

const serveTelemetry = async (socket: Socket): Promise<void> => {
  socket.on("error", () => undefined);
  socket.setTimeout(5_000, () => socket.destroy());
  try {
    socket.end(JSON.stringify(await collectNetworkTelemetryDirect()));
  } catch {
    socket.destroy();
  }
};

export const runNetworkProbe = async (signal: AbortSignal): Promise<void> => {
  const server = createServer((socket) => {
    void serveTelemetry(socket);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(getNetworkProbeSocketName());
  });

  if (!signal.aborted) {
    await new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
  }
  await closeServer(server);
};
