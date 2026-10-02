import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { mergePipeWireNode, parsePipeWireNode } from "./classifier";
import type { PipeWireNodeRecord } from "./types";

const MAX_JSON_VALUE_BYTES = 16 * 1024 * 1024;

export class JsonValueStreamParser {
  private buffer = "";
  private bufferBytes = 0;
  private previousHighSurrogate = false;
  private depth = 0;
  private inString = false;
  private escaped = false;

  push(chunk: string): unknown[] {
    const values: unknown[] = [];
    for (const character of chunk) {
      if (this.depth === 0 && /\s/.test(character)) continue;
      if (this.depth === 0 && character !== "[") {
        throw new Error("pw-dump emitted an unexpected JSON value");
      }
      this.buffer += character;
      const codeUnit = character.charCodeAt(0);
      const completesSurrogatePair = this.previousHighSurrogate &&
        character.length === 1 && codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
      // A high surrogate counted as 3 bytes becomes a 4-byte pair across pushes.
      this.bufferBytes += completesSurrogatePair ? 1 : Buffer.byteLength(character, "utf8");
      this.previousHighSurrogate = character.length === 1 &&
        codeUnit >= 0xd800 && codeUnit <= 0xdbff;
      if (this.bufferBytes > MAX_JSON_VALUE_BYTES) {
        throw new Error("pw-dump JSON value exceeded the size limit");
      }
      if (this.inString) {
        if (this.escaped) {
          this.escaped = false;
        } else if (character === "\\") {
          this.escaped = true;
        } else if (character === '"') {
          this.inString = false;
        }
        continue;
      }
      if (character === '"') {
        this.inString = true;
      } else if (character === "[" || character === "{") {
        this.depth += 1;
      } else if (character === "]" || character === "}") {
        this.depth -= 1;
        if (this.depth < 0) throw new Error("pw-dump emitted invalid JSON framing");
        if (this.depth === 0) {
          values.push(JSON.parse(this.buffer));
          this.buffer = "";
          this.bufferBytes = 0;
          this.previousHighSurrogate = false;
        }
      }
    }
    return values;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export class PipeWireGraph {
  private readonly nodes = new Map<number, PipeWireNodeRecord>();

  apply(value: unknown): boolean {
    if (!Array.isArray(value) || value.length > 100_000) {
      throw new Error("pw-dump emitted an invalid object batch");
    }
    let changed = false;
    for (const item of value) {
      if (!isObject(item) || !Number.isSafeInteger(item.id)) continue;
      const id = Number(item.id);
      if (item.type === null || item.info === null) {
        changed = this.nodes.delete(id) || changed;
        continue;
      }
      const node = parsePipeWireNode(item);
      if (!node) continue;
      this.nodes.set(id, mergePipeWireNode(this.nodes.get(id), node));
      changed = true;
    }
    return changed;
  }

  values(): PipeWireNodeRecord[] {
    return [...this.nodes.values()];
  }
}

export const readPipeWireSnapshot = async (): Promise<PipeWireNodeRecord[]> => {
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn("pw-dump", ["--no-colors"], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let length = 0;
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => child.kill("SIGTERM"), 5_000);
    const finish = (error?: Error, output?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(output || "");
    };
    child.stdout.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > MAX_JSON_VALUE_BYTES) {
        child.kill("SIGTERM");
        finish(new Error("pw-dump snapshot exceeded the size limit"));
      } else {
        chunks.push(chunk);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-2_000);
    });
    child.on("error", (err) => finish(err));
    child.on("close", (code, signal) => {
      if (code === 0) {
        finish(undefined, Buffer.concat(chunks).toString());
      } else {
        finish(new Error(
          `pw-dump failed${signal ? ` with signal ${signal}` : ` with code ${code}`}: ${stderr}`
        ));
      }
    });
  });
  const graph = new PipeWireGraph();
  graph.apply(JSON.parse(stdout));
  return graph.values();
};

export const monitorPipeWire = (
  onNodesChanged: (nodes: PipeWireNodeRecord[]) => void,
  signal: AbortSignal
): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn("pw-dump", ["--monitor", "--no-colors", "--indent", "0"], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    const parser = new JsonValueStreamParser();
    const decoder = new StringDecoder("utf8");
    const graph = new PipeWireGraph();
    let stderr = "";
    let settled = false;

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = (): void => {
      child.kill("SIGTERM");
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();

    child.stdout.on("data", (chunk: Buffer) => {
      try {
        for (const value of parser.push(decoder.write(chunk))) {
          if (graph.apply(value)) onNodesChanged(graph.values());
        }
      } catch (err) {
        child.kill("SIGTERM");
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString()}`.slice(-2_000);
    });
    child.on("error", (err) => finish(err));
    child.on("close", (code, closeSignal) => {
      if (signal.aborted) {
        finish();
      } else {
        const detail = stderr.trim().replace(/[\r\n\0]+/g, " ").slice(0, 500);
        finish(new Error(
          `pw-dump stopped${closeSignal ? ` with signal ${closeSignal}` : ` with code ${code}`}${detail ? `: ${detail}` : ""}`
        ));
      }
    });
  });
