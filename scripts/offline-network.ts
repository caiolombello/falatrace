const nativeFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
 const url = new URL(input instanceof Request ? input.url : String(input));
 if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || ["11434", "4455"].includes(url.port)) throw new Error("AUDIT blocked network request");
 return nativeFetch(input, init);
}) as typeof fetch;
