import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeJsonAtomic } from "../jobs/store";
import { GOOGLE_CLIENT_ID } from "./client-id";

// Google sign-in for a desktop app: the browser opens Google's consent page, Google
// redirects to a one-shot server on 127.0.0.1, and the code is exchanged with PKCE.
// The client ID belongs to the user's own Google Cloud project (configured in
// Settings); FalaTrace ships none. Only the refresh token is kept, in a private file.

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
/** Least privilege: events of calendars the user owns (invitations land on the primary one), plus the account e-mail to show who is connected. */
export const GOOGLE_SCOPES = ["openid", "email", "https://www.googleapis.com/auth/calendar.events.owned.readonly"] as const;
const CONNECT_TIMEOUT_MS = 5 * 60 * 1000;

export const GOOGLE_MESSAGES = {
  clientMissing: "Informe o ID do cliente OAuth do Google (app para computador) em Integrações.",
  clientInvalid: "O ID do cliente do Google deve terminar em .apps.googleusercontent.com.",
  notConnected: "A conta do Google não está conectada.",
  expired: "O Google não aceitou mais a conexão. Conecte a conta de novo em Integrações.",
  denied: "O acesso à agenda não foi autorizado no Google.",
  timeout: "O login do Google não foi concluído em 5 minutos. Tente de novo.",
  stateMismatch: "A resposta do Google não corresponde a este pedido; nada foi salvo.",
  exchangeFailed: "O Google não confirmou o login. Confira o ID e a chave secreta do cliente e tente de novo.",
  noRefreshToken: "O Google não entregou um acesso duradouro. Remova o acesso do FalaTrace na sua conta do Google e conecte de novo.",
  unreachable: "Não foi possível falar com o Google. Confira a conexão e tente de novo.",
  inProgress: "Já há um login do Google em andamento nesta janela."
} as const;

export type GoogleToken = { version: 1; clientId: string; refreshToken: string; scopes: string[]; email?: string; connectedAt: string };

const base64url = (data: Buffer): string => data.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const createPkce = (random: (size: number) => Buffer = randomBytes): { verifier: string; challenge: string; state: string } => {
  const verifier = base64url(random(48));
  return { verifier, challenge: base64url(createHash("sha256").update(verifier).digest()), state: base64url(random(24)) };
};

export const buildAuthUrl = (clientId: string, redirectUri: string, challenge: string, state: string): string => {
  const url = new URL(GOOGLE_AUTH_URL);
  for (const [key, value] of Object.entries({
    client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: GOOGLE_SCOPES.join(" "),
    code_challenge: challenge, code_challenge_method: "S256", state, access_type: "offline", prompt: "consent"
  })) url.searchParams.set(key, value);
  return url.toString();
};

/** E-mail from the ID token the token endpoint returned over TLS; shown, never trusted for access. */
export const emailFromIdToken = (idToken: unknown): string | undefined => {
  if (typeof idToken !== "string") return undefined;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1] || "", "base64url").toString("utf8")) as { email?: unknown };
    return typeof payload.email === "string" && payload.email.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(payload.email) ? payload.email : undefined;
  } catch { return undefined; }
};

type TokenResponse = { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown; scope?: unknown; id_token?: unknown; error?: unknown };

const postForm = async (fetchImpl: typeof fetch, url: string, form: Record<string, string>, signal?: AbortSignal): Promise<{ status: number; body: TokenResponse }> => {
  let response: Response;
  try {
    response = await fetchImpl(url, { method: "POST", redirect: "error", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString(),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) });
  } catch { throw new Error(GOOGLE_MESSAGES.unreachable); }
  const body = await response.json().catch(() => ({})) as TokenResponse;
  return { status: response.status, body };
};

export const exchangeCode = async (
  input: { clientId: string; clientSecret?: string; code: string; verifier: string; redirectUri: string }, fetchImpl: typeof fetch = fetch, now = () => new Date()
): Promise<GoogleToken> => {
  const { status, body } = await postForm(fetchImpl, GOOGLE_TOKEN_URL, {
    client_id: input.clientId, ...(input.clientSecret ? { client_secret: input.clientSecret } : {}), code: input.code, code_verifier: input.verifier,
    grant_type: "authorization_code", redirect_uri: input.redirectUri
  });
  if (status !== 200) throw new Error(GOOGLE_MESSAGES.exchangeFailed);
  if (typeof body.refresh_token !== "string" || !body.refresh_token || body.refresh_token.length > 2048) throw new Error(GOOGLE_MESSAGES.noRefreshToken);
  const scopes = typeof body.scope === "string" ? body.scope.split(" ").filter(Boolean).slice(0, 20) : [...GOOGLE_SCOPES];
  const email = emailFromIdToken(body.id_token);
  return { version: 1, clientId: input.clientId, refreshToken: body.refresh_token, scopes, ...(email ? { email } : {}), connectedAt: now().toISOString() };
};

/** A short-lived access token from the stored refresh token; never written anywhere. */
export const refreshAccessToken = async (token: GoogleToken, clientSecret: string | undefined, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<string> => {
  const { status, body } = await postForm(fetchImpl, GOOGLE_TOKEN_URL, {
    client_id: token.clientId, ...(clientSecret ? { client_secret: clientSecret } : {}), refresh_token: token.refreshToken, grant_type: "refresh_token"
  }, signal);
  if (status === 400 || status === 401) throw new Error(GOOGLE_MESSAGES.expired);
  if (status !== 200 || typeof body.access_token !== "string" || !body.access_token) throw new Error(GOOGLE_MESSAGES.unreachable);
  return body.access_token;
};

export const revokeToken = async (token: GoogleToken, fetchImpl: typeof fetch = fetch): Promise<boolean> => {
  try { return (await postForm(fetchImpl, GOOGLE_REVOKE_URL, { token: token.refreshToken })).status === 200; } catch { return false; }
};

export const googleStateDir = (): string => join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "recording-cli", "google");

/** The refresh token, in a 0600 file under a 0700 directory; a damaged file reads as disconnected. */
export class GoogleTokenStore {
  constructor(readonly root = googleStateDir()) {}
  get path(): string { return join(this.root, "oauth.json"); }
  async read(): Promise<GoogleToken | undefined> {
    try {
      const stat = await fs.lstat(this.path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024) return undefined;
      const token = JSON.parse(await fs.readFile(this.path, "utf8")) as GoogleToken;
      if (token?.version !== 1 || typeof token.clientId !== "string" || !GOOGLE_CLIENT_ID.test(token.clientId) || typeof token.refreshToken !== "string" || !token.refreshToken ||
        !Array.isArray(token.scopes) || typeof token.connectedAt !== "string" || (token.email !== undefined && typeof token.email !== "string")) return undefined;
      return token;
    } catch { return undefined; }
  }
  async save(token: GoogleToken): Promise<void> {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("Diretório do Google inseguro");
    await writeJsonAtomic(this.path, token);
  }
  async remove(): Promise<void> { await fs.rm(this.path, { force: true }); }
}

const PAGE = (title: string, text: string): string => `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>FalaTrace</title>` +
  `<body style="font-family:sans-serif;max-width:32rem;margin:4rem auto;line-height:1.5"><h1>${title}</h1><p>${text}</p></body></html>`;

export type LoopbackCallback = { redirectUri: string; code: Promise<string>; close: () => Promise<void> };

/** One-shot server on 127.0.0.1 for Google's redirect; any other request or state is refused. */
export const listenForCallback = async (state: string, options: { timeoutMs?: number; keepAlive?: boolean } = {}): Promise<LoopbackCallback> => {
  let settle!: { resolve: (code: string) => void; reject: (error: Error) => void };
  const code = new Promise<string>((resolve, reject) => { settle = { resolve, reject }; });
  code.catch(() => undefined);
  let done = false;
  const finish = (result: { code?: string; error?: Error }) => {
    if (done) return;
    done = true;
    if (result.code) settle.resolve(result.code); else settle.reject(result.error || new Error(GOOGLE_MESSAGES.exchangeFailed));
  };
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    const reply = (status: number, title: string, text: string) => {
      response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" });
      response.end(PAGE(title, text));
    };
    if (request.method !== "GET" || url.pathname !== "/" || (!url.searchParams.has("code") && !url.searchParams.has("error"))) { reply(404, "Não encontrado", "Este endereço só recebe a resposta do login do Google."); return; }
    // Refused without ending the sign-in: a request with another state is not Google's answer to this one.
    if (url.searchParams.get("state") !== state) { reply(400, "Pedido recusado", GOOGLE_MESSAGES.stateMismatch); return; }
    if (url.searchParams.has("error")) { reply(200, "Acesso não autorizado", "Você pode fechar esta janela e voltar ao FalaTrace."); finish({ error: new Error(GOOGLE_MESSAGES.denied) }); return; }
    const value = url.searchParams.get("code") || "";
    if (!value || value.length > 2048) { reply(400, "Pedido recusado", GOOGLE_MESSAGES.exchangeFailed); finish({ error: new Error(GOOGLE_MESSAGES.exchangeFailed) }); return; }
    reply(200, "Conta do Google conectada", "Você pode fechar esta janela e voltar ao FalaTrace.");
    finish({ code: value });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
  const address = server.address();
  if (!address || typeof address === "string") { server.close(); throw new Error(GOOGLE_MESSAGES.unreachable); }
  const timer = setTimeout(() => finish({ error: new Error(GOOGLE_MESSAGES.timeout) }), options.timeoutMs ?? CONNECT_TIMEOUT_MS);
  // In the Studio the bridge's input keeps the process running; a pending sign-in never holds it open.
  if (!options.keepAlive) { server.unref(); timer.unref(); }
  const close = async () => {
    clearTimeout(timer);
    finish({ error: new Error(GOOGLE_MESSAGES.timeout) });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  void code.then(close, close);
  return { redirectUri: `http://127.0.0.1:${address.port}`, code, close };
};

export type ConnectFlow = { url: string; done: Promise<GoogleToken> };

/** Starts a sign-in: returns the URL to open and a promise that settles when the token is saved. */
export const startGoogleConnect = async (
  input: { clientId: string; clientSecret?: string },
  dependencies: { fetch?: typeof fetch; store?: GoogleTokenStore; timeoutMs?: number; random?: (size: number) => Buffer; keepAlive?: boolean } = {}
): Promise<ConnectFlow & { close: () => Promise<void> }> => {
  if (!input.clientId) throw new Error(GOOGLE_MESSAGES.clientMissing);
  if (!GOOGLE_CLIENT_ID.test(input.clientId)) throw new Error(GOOGLE_MESSAGES.clientInvalid);
  const pkce = createPkce(dependencies.random);
  const callback = await listenForCallback(pkce.state, { timeoutMs: dependencies.timeoutMs, keepAlive: dependencies.keepAlive });
  const done = callback.code.then(async (code) => {
    const token = await exchangeCode({ clientId: input.clientId, clientSecret: input.clientSecret, code, verifier: pkce.verifier, redirectUri: callback.redirectUri }, dependencies.fetch);
    await (dependencies.store || new GoogleTokenStore()).save(token);
    return token;
  });
  done.catch(() => undefined);
  return { url: buildAuthUrl(input.clientId, callback.redirectUri, pkce.challenge, pkce.state), done, close: callback.close };
};
