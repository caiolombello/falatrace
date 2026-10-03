import './qa-isolation-guard';
import { createHash } from 'node:crypto';
// The guard above validates the temporary root/nonce before any product import.
// Preserve real kernel lease semantics while isolating QA from user services.
(globalThis as any)[Symbol.for('falatrace.qa.socket-namespace')] = createHash('sha256').update(process.env.FALATRACE_QA_NONCE!).digest('hex').slice(0, 12);
const nativeFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
 const url = new URL(input instanceof Request ? input.url : String(input));
 if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || ["11434", "4455"].includes(url.port)) throw new Error("AUDIT blocked network request");
 return nativeFetch(input, init);
}) as typeof fetch;
