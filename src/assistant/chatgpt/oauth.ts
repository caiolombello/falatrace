import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readBounded } from "../providers/common";
import { ProviderError } from "../types";
import { CHATGPT_STORE_MESSAGES, CLIENT_ID_PATTERN, type ChatGptCredentials, ChatGptStore, DYNAMIC_CLIENT_ID, withoutTokens } from "./store";

// "Sign in with ChatGPT" for open-source local apps: Authorization Code + PKCE (S256) through
// the system browser, a one-shot listener on 127.0.0.1 for the redirect, and a rotating
// refresh token. The first sign-in registers FalaTrace dynamically and OpenAI issues a client
// id that is reused afterwards. Nothing is used before the ID token (RS256, JWKS) checks out
// and the user granted plan usage (chatgpt.tokens.use.direct).

export const CHATGPT_OAUTH = {
  authorizeUrl: "https://auth.openai.com/api/accounts/authorize",
  tokenUrl: "https://auth.openai.com/api/accounts/oauth/token",
  jwksUrl: "https://auth.openai.com/.well-known/jwks.json",
  issuer: "https://auth.openai.com",
  resource: "https://api.openai.com/v1",
  agentName: "FalaTrace",
  /** Port from OpenAI's examples; only the port of the redirect may vary, and never "localhost". */
  defaultPort: 1455,
  callbackPath: "/auth/callback"
} as const;

export const CHATGPT_DIRECT_SCOPE = "chatgpt.tokens.use.direct";
export const CHATGPT_SCOPES = ["openid", "profile", "email", "offline_access", "resource.invoke", CHATGPT_DIRECT_SCOPE] as const;

export const CHATGPT_MESSAGES = {
  portBusy: "A porta usada pelo login com o ChatGPT (127.0.0.1:1455) está ocupada, talvez por outro login aberto (como o do Codex). Feche-o e tente de novo.",
  inProgress: "Já há um login com o ChatGPT em andamento.",
  timeout: "O login com o ChatGPT não foi concluído em 5 minutos. Tente de novo.",
  cancelled: "O login com o ChatGPT foi cancelado.",
  denied: "O login com o ChatGPT foi cancelado ou negado na página da OpenAI.",
  stateMismatch: "A resposta do login não corresponde a este pedido; nada foi salvo.",
  clientMissing: "O ChatGPT não informou o registro do FalaTrace; nada foi salvo. Tente de novo.",
  clientMismatch: "O ChatGPT respondeu com outro registro do FalaTrace; nada foi salvo. Tente de novo.",
  exchangeFailed: "O ChatGPT não confirmou o login. Tente de novo.",
  noRefreshToken: "O ChatGPT não entregou um acesso duradouro. Entre de novo.",
  identityFailed: "Não foi possível confirmar a identidade da conta do ChatGPT; nada foi salvo.",
  scopeDeclined: "Você não autorizou o FalaTrace a usar o seu plano do ChatGPT. Entre de novo e aceite essa permissão, ou use uma chave de API.",
  unreachable: "Não foi possível falar com o ChatGPT. Confira a conexão e tente de novo.",
  signedOut: "Entre com o ChatGPT em Configurações › Perguntar e receitas para usar o seu plano.",
  expired: "A sessão do ChatGPT expirou. Entre de novo com o ChatGPT em Configurações › Perguntar e receitas."
} as const;

export type ChatGptEndpoints = { authorizeUrl: string; tokenUrl: string; jwksUrl: string; issuer: string };

export type ChatGptOAuthDeps = {
  fetch?: typeof fetch;
  store?: ChatGptStore;
  now?: () => number;
  random?: (size: number) => Buffer;
  endpoints?: Partial<ChatGptEndpoints>;
  /** Loopback port for the redirect (0 picks a free one, for tests). */
  port?: number;
  /** When the port is busy, use any free port instead of failing. Off by default. */
  portFallback?: boolean;
  timeoutMs?: number;
  /**
   * Keep the process alive while waiting for the browser (default). A long-running host that
   * stays up anyway (the Studio bridge) may pass false so a pending sign-in never delays its exit.
   */
  keepAlive?: boolean;
};

const LOGIN_TIMEOUT_MS = 5 * 60_000;
const HTTP_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_TOKEN_LENGTH = 16 * 1024;
const TOKEN = /^[\x21-\x7e]+$/;
const EMAIL = /^[^\s@]{1,128}@[^\s@]{1,125}$/;
/** Refresh a little before expiry so a request never starts with a token about to lapse. */
const EXPIRY_MARGIN_MS = 60_000;
const CLOCK_SKEW_S = 60;

const endpointsOf = (deps: ChatGptOAuthDeps): ChatGptEndpoints => ({
  authorizeUrl: deps.endpoints?.authorizeUrl ?? CHATGPT_OAUTH.authorizeUrl,
  tokenUrl: deps.endpoints?.tokenUrl ?? CHATGPT_OAUTH.tokenUrl,
  jwksUrl: deps.endpoints?.jwksUrl ?? CHATGPT_OAUTH.jwksUrl,
  issuer: deps.endpoints?.issuer ?? CHATGPT_OAUTH.issuer
});

const base64url = (data: Buffer): string => data.toString("base64url");

export const createPkce = (random: (size: number) => Buffer = randomBytes): { verifier: string; challenge: string; state: string; nonce: string } => {
  const verifier = base64url(random(48));
  return { verifier, challenge: base64url(createHash("sha256").update(verifier).digest()), state: base64url(random(24)), nonce: base64url(random(24)) };
};

/** The authorization URL; agent_name_hint goes only with the first, dynamic registration. */
export const buildChatGptAuthUrl = (input: {
  authorizeUrl?: string;
  clientId?: string;
  hostId: string;
  redirectUri: string;
  challenge: string;
  state: string;
  nonce: string;
}): string => {
  const url = new URL(input.authorizeUrl ?? CHATGPT_OAUTH.authorizeUrl);
  const clientId = input.clientId ?? DYNAMIC_CLIENT_ID;
  const params: Record<string, string> = {
    response_type: "code",
    client_id: clientId,
    ...(clientId === DYNAMIC_CLIENT_ID ? { agent_name_hint: CHATGPT_OAUTH.agentName } : {}),
    ext_agent_host_id: input.hostId,
    redirect_uri: input.redirectUri,
    scope: CHATGPT_SCOPES.join(" "),
    resource: CHATGPT_OAUTH.resource,
    state: input.state,
    nonce: input.nonce,
    code_challenge: input.challenge,
    code_challenge_method: "S256"
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
};

// ── HTTP helpers ────────────────────────────────────────────────────────────────

/** A JSON object body of at most MAX_RESPONSE_BYTES; anything else reads as {}. */
const readJson = async (response: Response): Promise<Record<string, unknown>> => {
  try {
    const { text, truncated } = await readBounded(response.body, MAX_RESPONSE_BYTES, "head", { stopWhenFull: true });
    if (truncated) return {};
    const value = JSON.parse(text) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const postForm = async (fetchImpl: typeof fetch, url: string, form: Record<string, string>, signal?: AbortSignal): Promise<{ status: number; body: Record<string, unknown> }> => {
  const timeout = AbortSignal.timeout(HTTP_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(form).toString(),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    });
  } catch {
    if (signal?.aborted) throw new ProviderError(CHATGPT_MESSAGES.cancelled, "cancelled");
    throw new ProviderError(CHATGPT_MESSAGES.unreachable, "unavailable");
  }
  return { status: response.status, body: await readJson(response) };
};

type TokenSet = { accessToken: string; refreshToken?: string; idToken?: string; expiresIn: number; scopes?: string[] };

const parseTokenSet = (body: Record<string, unknown>): TokenSet | undefined => {
  const { access_token: access, refresh_token: refresh, id_token: id, expires_in: expiresIn, scope, token_type: type } = body;
  if (typeof access !== "string" || access.length > MAX_TOKEN_LENGTH || !TOKEN.test(access)) return undefined;
  if (refresh !== undefined && (typeof refresh !== "string" || refresh.length > MAX_TOKEN_LENGTH || !TOKEN.test(refresh))) return undefined;
  if (id !== undefined && (typeof id !== "string" || id.length > MAX_TOKEN_LENGTH)) return undefined;
  if (type !== undefined && (typeof type !== "string" || type.toLowerCase() !== "bearer")) return undefined;
  const seconds = typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0 ? Math.min(expiresIn, 365 * 24 * 3600) : 3600;
  let scopes: string[] | undefined;
  if (scope !== undefined) {
    if (typeof scope !== "string" || scope.length > 2000) return undefined;
    scopes = [...new Set(scope.split(/\s+/).filter((entry) => /^[\x21-\x7e]{1,200}$/.test(entry)))].slice(0, 30);
  }
  return { accessToken: access, ...(typeof refresh === "string" ? { refreshToken: refresh } : {}), ...(typeof id === "string" ? { idToken: id } : {}), expiresIn: seconds, ...(scopes ? { scopes } : {}) };
};

// ── ID token verification (RS256 against the issuer's JWKS) ─────────────────────

type Jwk = { kty?: unknown; kid?: unknown; alg?: unknown; use?: unknown; n?: unknown; e?: unknown };
const jwksCache = new Map<string, { keys: Jwk[]; fetchedAt: number }>();
const JWKS_TTL_MS = 10 * 60_000;

const fetchJwks = async (url: string, fetchImpl: typeof fetch, now: number, force: boolean): Promise<Jwk[]> => {
  const cached = jwksCache.get(url);
  if (cached && !force && now - cached.fetchedAt < JWKS_TTL_MS) return cached.keys;
  let response: Response;
  try {
    response = await fetchImpl(url, { redirect: "error", headers: { accept: "application/json" }, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  } catch {
    throw new Error(CHATGPT_MESSAGES.unreachable);
  }
  if (!response.ok) throw new Error(CHATGPT_MESSAGES.identityFailed);
  const body = await readJson(response);
  const keys = Array.isArray(body.keys) ? (body.keys.slice(0, 20).filter((key) => typeof key === "object" && key !== null) as Jwk[]) : [];
  jwksCache.set(url, { keys, fetchedAt: now });
  return keys;
};

const decodeSegment = (segment: string): Record<string, unknown> => {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw new Error("bad segment");
  const value = JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("bad segment");
  return value as Record<string, unknown>;
};

const importRsaKey = async (jwk: Jwk): Promise<CryptoKey | undefined> => {
  if (jwk.kty !== "RSA" || typeof jwk.n !== "string" || typeof jwk.e !== "string") return undefined;
  if (jwk.alg !== undefined && jwk.alg !== "RS256") return undefined;
  if (jwk.use !== undefined && jwk.use !== "sig") return undefined;
  // At least a 2048-bit modulus.
  if (Buffer.from(jwk.n, "base64url").length < 256) return undefined;
  try {
    return await crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  } catch {
    return undefined;
  }
};

const trimSlash = (value: string): string => value.replace(/\/+$/, "");

export type IdTokenClaims = { subject?: string; email?: string };

/**
 * Checks signature (RS256, key from the JWKS by kid), issuer, audience, expiry and nonce.
 * Throws CHATGPT_MESSAGES.identityFailed on any mismatch.
 */
export const verifyIdToken = async (
  idToken: string,
  expected: { issuer: string; audience: string; nonce: string; jwksUrl: string; fetch?: typeof fetch; now?: number }
): Promise<IdTokenClaims> => {
  const fail = (): never => {
    throw new Error(CHATGPT_MESSAGES.identityFailed);
  };
  const now = expected.now ?? Date.now();
  const parts = idToken.split(".");
  if (parts.length !== 3) fail();
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = decodeSegment(headerPart);
    payload = decodeSegment(payloadPart);
  } catch {
    return fail();
  }
  if (header.alg !== "RS256" || !/^[A-Za-z0-9_-]+$/.test(signaturePart)) fail();
  const kid = typeof header.kid === "string" ? header.kid : undefined;
  const fetchImpl = expected.fetch ?? fetch;
  const pick = (keys: Jwk[]): Jwk | undefined => (kid ? keys.find((key) => key.kid === kid) : keys.length === 1 ? keys[0] : undefined);
  let jwk = pick(await fetchJwks(expected.jwksUrl, fetchImpl, now, false));
  // A key rotation shows up as an unknown kid: fetch the set once more.
  if (!jwk) jwk = pick(await fetchJwks(expected.jwksUrl, fetchImpl, now, true));
  const key = jwk ? await importRsaKey(jwk) : undefined;
  if (!key) return fail();
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, Buffer.from(signaturePart, "base64url"), new TextEncoder().encode(`${headerPart}.${payloadPart}`));
  if (!valid) fail();
  const seconds = now / 1000;
  if (typeof payload.iss !== "string" || trimSlash(payload.iss) !== trimSlash(expected.issuer)) fail();
  const audiences = typeof payload.aud === "string" ? [payload.aud] : Array.isArray(payload.aud) ? payload.aud.slice(0, 10) : [];
  if (!audiences.includes(expected.audience)) fail();
  if (payload.azp !== undefined && payload.azp !== expected.audience) fail();
  if (typeof payload.exp !== "number" || payload.exp + CLOCK_SKEW_S < seconds) fail();
  if (payload.iat !== undefined && (typeof payload.iat !== "number" || payload.iat - 300 > seconds)) fail();
  if (typeof payload.nonce !== "string" || payload.nonce !== expected.nonce) fail();
  const profile = payload["https://api.openai.com/profile"];
  const email = typeof payload.email === "string" ? payload.email : typeof profile === "object" && profile !== null ? (profile as Record<string, unknown>).email : undefined;
  return {
    ...(typeof payload.sub === "string" && payload.sub.length <= 256 ? { subject: payload.sub } : {}),
    ...(typeof email === "string" && EMAIL.test(email) ? { email } : {})
  };
};

// ── Status, logout, access tokens ───────────────────────────────────────────────

export type ChatGptStatus = {
  signedIn: boolean;
  /** The user granted plan usage (chatgpt.tokens.use.direct). */
  planUsage: boolean;
  /** OpenAI already issued a client id to this installation. */
  registered: boolean;
  email?: string;
  expiresAt?: string;
  scopes: string[];
};

const statusOf = (record: ChatGptCredentials | undefined): ChatGptStatus => {
  const signedIn = Boolean(record?.accessToken);
  return {
    signedIn,
    planUsage: signedIn && Boolean(record?.scopes?.includes(CHATGPT_DIRECT_SCOPE)),
    registered: Boolean(record?.clientId),
    ...(signedIn && record?.email ? { email: record.email } : {}),
    ...(signedIn && record?.expiresAt ? { expiresAt: record.expiresAt } : {}),
    scopes: signedIn ? [...(record?.scopes ?? [])] : []
  };
};

/** What the UI shows; never a token. */
export const chatGptStatus = async (deps: ChatGptOAuthDeps = {}): Promise<ChatGptStatus> => statusOf(await (deps.store ?? new ChatGptStore()).read());

/** Forgets the tokens. The installation id and issued client id stay unless forgetRegistration is set. */
export const chatGptLogout = async (options: { forgetRegistration?: boolean } = {}, deps: ChatGptOAuthDeps = {}): Promise<void> => {
  const store = deps.store ?? new ChatGptStore();
  if (options.forgetRegistration) {
    await store.remove();
    return;
  }
  try {
    await store.transaction((current) => ({ next: current ? withoutTokens(current) : undefined, result: undefined }));
  } catch (error) {
    // A planted link or foreign file is removed rather than kept.
    if ((error as Error).message === CHATGPT_STORE_MESSAGES.unsafe) await store.remove();
    else throw error;
  }
};

const isExpired = (record: ChatGptCredentials, now: number): boolean => !record.expiresAt || Date.parse(record.expiresAt) - EXPIRY_MARGIN_MS <= now;

/**
 * A usable access token, refreshed under the store lock when it is about to expire. Refresh
 * tokens are single use: the new pair replaces the old one together, and a process that
 * waited for the lock adopts the token another process just obtained.
 */
export const getChatGptAccessToken = async (options: { signal?: AbortSignal; forceRefresh?: boolean } = {}, deps: ChatGptOAuthDeps = {}): Promise<string> => {
  const store = deps.store ?? new ChatGptStore();
  const now = deps.now ?? Date.now;
  const fetchImpl = deps.fetch ?? fetch;
  const endpoints = endpointsOf(deps);
  let snapshot: ChatGptCredentials | undefined;
  try {
    snapshot = await store.read();
  } catch {
    throw new ProviderError(CHATGPT_MESSAGES.signedOut, "auth");
  }
  if (!snapshot?.accessToken) throw new ProviderError(CHATGPT_MESSAGES.signedOut, "auth");
  if (!snapshot.scopes?.includes(CHATGPT_DIRECT_SCOPE)) throw new ProviderError(CHATGPT_MESSAGES.scopeDeclined, "auth");
  if (!options.forceRefresh && !isExpired(snapshot, now())) return snapshot.accessToken;
  const staleToken = snapshot.accessToken;
  const outcome = await store
    .transaction<{ token: string } | { error: ProviderError }>(async (current) => {
      if (!current?.accessToken || !current.refreshToken || !current.clientId) return { result: { error: new ProviderError(CHATGPT_MESSAGES.signedOut, "auth") } };
      if (current.accessToken !== staleToken && !isExpired(current, now())) return { result: { token: current.accessToken } };
      const { status, body } = await postForm(fetchImpl, endpoints.tokenUrl, { grant_type: "refresh_token", refresh_token: current.refreshToken, client_id: current.clientId, resource: CHATGPT_OAUTH.resource }, options.signal);
      if (status === 400 || status === 401) {
        // invalid_grant, refresh_token_reused…: the pair is spent; a new sign-in is needed.
        return { next: withoutTokens(current), result: { error: new ProviderError(CHATGPT_MESSAGES.expired, "auth") } };
      }
      const tokens = status === 200 ? parseTokenSet(body) : undefined;
      if (!tokens) return { result: { error: new ProviderError(CHATGPT_MESSAGES.unreachable, "unavailable") } };
      const scopes = tokens.scopes ?? current.scopes ?? [];
      if (!scopes.includes(CHATGPT_DIRECT_SCOPE)) return { next: withoutTokens(current), result: { error: new ProviderError(CHATGPT_MESSAGES.scopeDeclined, "auth") } };
      const next: ChatGptCredentials = {
        ...current,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? current.refreshToken,
        expiresAt: new Date(now() + tokens.expiresIn * 1000).toISOString(),
        scopes
      };
      return { next, result: { token: tokens.accessToken } };
    })
    .catch((error: unknown) => {
      if (error instanceof ProviderError) throw error;
      if ((error as Error).message === CHATGPT_STORE_MESSAGES.busy) throw new ProviderError(CHATGPT_STORE_MESSAGES.busy, "unavailable");
      throw new ProviderError(CHATGPT_MESSAGES.signedOut, "auth");
    });
  if ("error" in outcome) throw outcome.error;
  return outcome.token;
};

// ── Interactive sign-in ─────────────────────────────────────────────────────────

export type ChatGptLogin = {
  /** Authorization URL, also shown so the user can open it by hand. */
  url: string;
  redirectUri: string;
  /** Settles once the tokens are verified and saved (or the sign-in failed). */
  done: Promise<ChatGptStatus>;
  cancel: () => Promise<void>;
};

let loginInProgress = false;

const KNOWN_LOGIN_MESSAGES: readonly string[] = [...Object.values(CHATGPT_MESSAGES), ...Object.values(CHATGPT_STORE_MESSAGES)];
/** The error's own message when it is one of ours, else the generic one: nothing else reaches the user. */
const loginMessage = (error: unknown, fallback: string): string => (error instanceof Error && KNOWN_LOGIN_MESSAGES.includes(error.message) ? error.message : fallback);

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
const page = (title: string, text: string): string =>
  `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>FalaTrace</title><body style="font-family:sans-serif;max-width:32rem;margin:4rem auto;line-height:1.5">` +
  `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(text)}</p></body></html>`;

const listen = (server: Server, port: number): Promise<number> =>
  new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error(CHATGPT_MESSAGES.unreachable));
      else resolve(address.port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });

/**
 * Starts the sign-in: listens on 127.0.0.1 (port 1455 unless configured), opens the browser
 * through openUrl and returns at once. `done` settles when the redirect arrived and the
 * tokens were checked and saved.
 */
export const startChatGptLogin = async (input: { openUrl?: (url: string) => unknown } = {}, deps: ChatGptOAuthDeps = {}): Promise<ChatGptLogin> => {
  if (loginInProgress) throw new Error(CHATGPT_MESSAGES.inProgress);
  loginInProgress = true;
  let server: Server | undefined;
  try {
    const store = deps.store ?? new ChatGptStore();
    const now = deps.now ?? Date.now;
    const fetchImpl = deps.fetch ?? fetch;
    const endpoints = endpointsOf(deps);
    const registration = await store.ensureHostId();
    const registeredClientId = registration.clientId;
    const pkce = createPkce(deps.random);

    let settle!: { resolve: (status: ChatGptStatus) => void; reject: (error: Error) => void };
    const done = new Promise<ChatGptStatus>((resolve, reject) => {
      settle = { resolve, reject };
    });
    done.catch(() => undefined);
    let finished = false;
    let handling = false;
    let redirectUri = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const activeServer = createServer();
    server = activeServer;
    // Aborted once the sign-in settles: a cancel or timeout during the code exchange must not save tokens later.
    const settled = new AbortController();
    let settledError: Error | undefined;
    const finish = (outcome: { status?: ChatGptStatus; error?: Error }) => {
      if (finished) return;
      finished = true;
      settledError = outcome.status ? undefined : outcome.error;
      settled.abort();
      if (timer) clearTimeout(timer);
      loginInProgress = false;
      activeServer.close();
      if (outcome.status) settle.resolve(outcome.status);
      else settle.reject(outcome.error ?? new Error(CHATGPT_MESSAGES.exchangeFailed));
    };

    const complete = async (code: string, callbackClientId: string | undefined): Promise<ChatGptStatus> => {
      if (callbackClientId !== undefined && (!CLIENT_ID_PATTERN.test(callbackClientId) || callbackClientId === DYNAMIC_CLIENT_ID)) throw new Error(CHATGPT_MESSAGES.clientMissing);
      if (registeredClientId && callbackClientId && callbackClientId !== registeredClientId) throw new Error(CHATGPT_MESSAGES.clientMismatch);
      const clientId = callbackClientId ?? registeredClientId;
      if (!clientId) throw new Error(CHATGPT_MESSAGES.clientMissing);
      const { status, body } = await postForm(fetchImpl, endpoints.tokenUrl, {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: pkce.verifier,
        // Required here as on the authorization request; without it OpenAI refuses the exchange.
        resource: CHATGPT_OAUTH.resource
      }, settled.signal).catch(() => {
        throw new Error(CHATGPT_MESSAGES.unreachable);
      });
      const tokens = status === 200 ? parseTokenSet(body) : undefined;
      if (!tokens) throw new Error(CHATGPT_MESSAGES.exchangeFailed);
      if (!tokens.idToken) throw new Error(CHATGPT_MESSAGES.identityFailed);
      const claims = await verifyIdToken(tokens.idToken, { issuer: endpoints.issuer, audience: clientId, nonce: pkce.nonce, jwksUrl: endpoints.jwksUrl, fetch: fetchImpl, now: now() });
      // Per RFC 6749 an omitted scope means everything requested was granted.
      const scopes = tokens.scopes ?? [...CHATGPT_SCOPES];
      if (!scopes.includes(CHATGPT_DIRECT_SCOPE)) {
        // Keep the registration so the next attempt reuses the issued client id; keep no tokens.
        await store.transaction((current) => ({ next: { ...withoutTokens(current ?? registration), clientId }, result: undefined }));
        throw new Error(CHATGPT_MESSAGES.scopeDeclined);
      }
      if (!tokens.refreshToken) throw new Error(CHATGPT_MESSAGES.noRefreshToken);
      const saved = await store.transaction((current) => {
        if (finished) return { result: undefined };
        const base = current ?? registration;
        const next: ChatGptCredentials = {
          ...withoutTokens(base),
          clientId,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: new Date(now() + tokens.expiresIn * 1000).toISOString(),
          scopes,
          ...(claims.email ? { email: claims.email } : {})
        };
        return { next, result: next };
      });
      if (!saved) throw new Error(CHATGPT_MESSAGES.cancelled);
      return statusOf(saved);
    };

    activeServer.on("request", (request: IncomingMessage, response: ServerResponse) => {
      const reply = (status: number, title: string, text: string) => {
        response.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", connection: "close" });
        response.end(page(title, text));
      };
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method !== "GET" || url.pathname !== CHATGPT_OAUTH.callbackPath) {
        reply(404, "Não encontrado", "Este endereço só recebe a resposta do login com o ChatGPT.");
        return;
      }
      if (finished || handling) {
        reply(409, "Login já recebido", "Você pode fechar esta janela e voltar ao FalaTrace.");
        return;
      }
      // A request with another state is not the answer to this sign-in: refuse it and keep waiting.
      if (url.searchParams.get("state") !== pkce.state) {
        reply(400, "Pedido recusado", CHATGPT_MESSAGES.stateMismatch);
        return;
      }
      if (url.searchParams.has("error")) {
        const error = new Error(url.searchParams.get("error") === "access_denied" ? CHATGPT_MESSAGES.denied : CHATGPT_MESSAGES.exchangeFailed);
        reply(200, "Login não concluído", error.message);
        finish({ error });
        return;
      }
      const code = url.searchParams.get("code") ?? "";
      if (!code || code.length > 4096) {
        reply(400, "Pedido recusado", CHATGPT_MESSAGES.exchangeFailed);
        finish({ error: new Error(CHATGPT_MESSAGES.exchangeFailed) });
        return;
      }
      handling = true;
      const callbackClientId = url.searchParams.get("client_id") ?? undefined;
      complete(code, callbackClientId).then(
        (status) => {
          reply(200, "ChatGPT conectado", "Você pode fechar esta janela e voltar ao FalaTrace.");
          finish({ status });
        },
        (error: unknown) => {
          // Cancelled or timed out meanwhile: the page tells the reason the sign-in ended with.
          const message = settledError?.message ?? loginMessage(error, CHATGPT_MESSAGES.exchangeFailed);
          reply(400, "Login não concluído", message);
          finish({ error: new Error(message) });
        }
      );
    });

    const wanted = deps.port ?? CHATGPT_OAUTH.defaultPort;
    let port: number;
    try {
      port = await listen(activeServer, wanted);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw new Error(CHATGPT_MESSAGES.unreachable);
      if (!deps.portFallback) throw new Error(CHATGPT_MESSAGES.portBusy);
      port = await listen(activeServer, 0);
    }
    redirectUri = `http://127.0.0.1:${port}${CHATGPT_OAUTH.callbackPath}`;
    timer = setTimeout(() => finish({ error: new Error(CHATGPT_MESSAGES.timeout) }), deps.timeoutMs ?? LOGIN_TIMEOUT_MS);
    if (deps.keepAlive === false) {
      activeServer.unref();
      timer.unref();
    }
    const url = buildChatGptAuthUrl({ authorizeUrl: endpoints.authorizeUrl, clientId: registeredClientId, hostId: registration.hostId, redirectUri, challenge: pkce.challenge, state: pkce.state, nonce: pkce.nonce });
    try {
      await input.openUrl?.(url);
    } catch {
      // The URL is returned too, so the user can open it by hand.
    }
    return {
      url,
      redirectUri,
      done,
      cancel: async () => {
        finish({ error: new Error(CHATGPT_MESSAGES.cancelled) });
        await done.catch(() => undefined);
      }
    };
  } catch (error) {
    loginInProgress = false;
    server?.close();
    throw new Error(loginMessage(error, CHATGPT_MESSAGES.unreachable));
  }
};
