// Shared shape of the Studio bridge's operation families: each family file lists its operations,
// the payload keys each one accepts, a strict validator, a handler and the fixed messages it may
// show. bridge.ts only registers families; nothing here touches the filesystem.

/** One parsed request as a family sees it: payload keys were already checked against its allowlist. */
export type BridgeCall = { id: number; op: string; key?: string; payload: Record<string, unknown> };

export type BridgeFamily<Context> = {
  readonly operations: readonly string[];
  /** Payload keys each operation accepts; anything else is refused before dispatch. */
  readonly allowedPayload: Readonly<Record<string, readonly string[]>>;
  /** Throws INVALID_PAYLOAD for anything malformed. Runs after the allowlist check. */
  validate(call: BridgeCall): void;
  handle(call: BridgeCall, context: Context): Promise<unknown>;
  /** Messages shown as they are; anything else becomes `fallback(op)`. */
  readonly knownErrors: readonly string[];
  fallback(op: string): string;
  /** Operations admitted even when 32 requests are pending (cancellations). */
  readonly alwaysAdmitted?: readonly string[];
};

export const INVALID_PAYLOAD = "payload inválido";

export const invalid = (): never => {
  throw new Error(INVALID_PAYLOAD);
};

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const SHA256 = /^[a-f0-9]{64}$/;
/** Same grammar as clients (src/clients/catalog.ts) and the assistant scope. */
export const CLIENT_CODE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,19}$/;
/** Stored person ids are UUIDs; names nobody edited yet are "name:<key>". */
export const PERSON_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|name:[^\p{Cc}]{1,200})$/iu;
export const TEMPLATE_ID = /^(?:[a-z][a-z0-9-]{0,40}|custom:[a-z0-9][a-z0-9-]{0,40})$/;
export const RECIPE_ID = /^(?:[a-z][a-z0-9-]{0,40}|custom:[a-z0-9][a-z0-9-]{0,40})$/;

const CONTROL = /\p{Cc}/u;
const CONTROL_EXCEPT_LINES = /[^\P{Cc}\n\r\t]/u;

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** A one-line string of at most `max` characters, without control characters. */
export const isLine = (value: unknown, max: number, options: { empty?: boolean } = {}): value is string =>
  typeof value === "string" && value.length <= max && (options.empty === true || value.trim().length > 0) && !CONTROL.test(value);

/** Multi-line text: line breaks and tabs allowed, other control characters refused. */
export const isText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length <= max && !CONTROL_EXCEPT_LINES.test(value);

export const line = (payload: Record<string, unknown>, name: string, max: number, options: { optional?: boolean; empty?: boolean } = {}): void => {
  if (payload[name] === undefined && options.optional) return;
  if (!isLine(payload[name], max, options)) invalid();
};

export const text = (payload: Record<string, unknown>, name: string, max: number, options: { optional?: boolean } = {}): void => {
  if (payload[name] === undefined && options.optional) return;
  if (!isText(payload[name], max)) invalid();
};

export const bool = (payload: Record<string, unknown>, name: string, options: { optional?: boolean } = {}): void => {
  if (payload[name] === undefined && options.optional) return;
  if (typeof payload[name] !== "boolean") invalid();
};

export const integer = (payload: Record<string, unknown>, name: string, min: number, max: number, options: { optional?: boolean } = {}): void => {
  if (payload[name] === undefined && options.optional) return;
  const value = payload[name];
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) invalid();
};

export const oneOf = (payload: Record<string, unknown>, name: string, values: readonly string[], options: { optional?: boolean } = {}): void => {
  if (payload[name] === undefined && options.optional) return;
  if (typeof payload[name] !== "string" || !values.includes(payload[name] as string)) invalid();
};

export const matches = (payload: Record<string, unknown>, name: string, pattern: RegExp, options: { optional?: boolean; max?: number } = {}): void => {
  if (payload[name] === undefined && options.optional) return;
  const value = payload[name];
  if (typeof value !== "string" || value.length > (options.max ?? 256) || !pattern.test(value)) invalid();
};

/** The request key must be a job (or notes/session) UUID. */
export const uuidKey = (call: BridgeCall): void => {
  if (typeof call.key !== "string" || !UUID.test(call.key)) invalid();
};

/** The request key must be a library key: an absolute path. */
export const pathKey = (call: BridgeCall): void => {
  if (typeof call.key !== "string" || !call.key.startsWith("/") || call.key.length > 4096) invalid();
};

/** Assistant scope: exactly one of the four shapes, nothing else. */
export const validateScope = (value: unknown): void => {
  if (!record(value)) {
    invalid();
    return;
  }
  const keys = Object.keys(value).sort().join(",");
  if (value.kind === "library" && keys === "kind") return;
  if (value.kind === "meeting" && keys === "jobId,kind" && typeof value.jobId === "string" && UUID.test(value.jobId)) return;
  if (value.kind === "person" && keys === "kind,personId" && typeof value.personId === "string" && PERSON_ID.test(value.personId)) return;
  if (value.kind === "client" && keys === "clientCode,kind" && typeof value.clientCode === "string" && CLIENT_CODE.test(value.clientCode)) return;
  invalid();
};

/** An object payload field (a template or a recipe) bounded by its JSON size. */
export const boundedObject = (payload: Record<string, unknown>, name: string, maxBytes: number): void => {
  const value = payload[name];
  if (!record(value)) {
    invalid();
    return;
  }
  let size = Number.POSITIVE_INFINITY;
  try { size = Buffer.byteLength(JSON.stringify(value), "utf8"); } catch { /* not serializable: refused below */ }
  if (size > maxBytes) invalid();
};

/** The message when it is one of `known`, else the family's generic one. Raw exception text never leaks. */
export const familyError = (family: Pick<BridgeFamily<unknown>, "knownErrors" | "fallback">, op: string, error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return family.knownErrors.includes(message) ? message : family.fallback(op);
};

/** "mm:ss" (or "h:mm:ss") of a media offset. */
export const clockOf = (seconds: number): string => {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${String(minutes).padStart(2, "0")}:${rest}`;
};
