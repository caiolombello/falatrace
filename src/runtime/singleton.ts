import { createHash } from "node:crypto";
import { createServer, type Server } from "node:net";

export type SingletonLease = {
  release(): Promise<void>;
};

const socketName = (name: string): string => {
  if (!/^[a-z0-9-]{1,64}$/.test(name)) throw new Error("Invalid singleton name");
  // Only the guarded offline preload sets this in-process QA namespace.
  // Ordinary installed processes retain their original socket names.
  const qaNamespace = (globalThis as any)[Symbol.for("falatrace.qa.socket-namespace")];
  if (typeof qaNamespace === "string" && /^[a-f0-9]{12}$/.test(qaNamespace)) {
    name = `qa-${qaNamespace}-${createHash("sha256").update(name).digest("hex").slice(0, 32)}`;
  }
  const userId = typeof process.getuid === "function" ? process.getuid() : "user";
  return `\0recording-cli-${userId}-${name}`;
};

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((err) => err ? reject(err) : resolve());
  });

export const acquireSingleton = async (name: string): Promise<SingletonLease> => {
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      server.off("listening", onListening);
      if (err.code === "EADDRINUSE") {
        reject(new Error(`${name} is already running`));
      } else {
        reject(err);
      }
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketName(name));
  });

  let released = false;
  return {
    async release(): Promise<void> {
      if (released) return;
      released = true;
      await closeServer(server);
    }
  };
};
