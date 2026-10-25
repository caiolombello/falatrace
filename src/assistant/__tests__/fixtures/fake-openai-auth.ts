import { createHash, randomBytes } from "node:crypto";

// A fake OpenAI authorization server for the Sign in with ChatGPT tests: /authorize answers
// like the consent page (a redirect to the app's loopback callback), /token checks PKCE and
// rotates single-use refresh tokens, /jwks publishes the RS256 key that signs ID tokens.
// Every behaviour the tests need to break is a knob.

export type IdTokenFlaw = "missing" | "bad-signature" | "wrong-nonce" | "wrong-aud" | "wrong-iss" | "expired" | "alg-none" | "unknown-kid" | "azp-mismatch";

export type AuthKnobs = {
  /** Client id the server issues on the first (dynamic) registration. */
  issuedClientId: string;
  /** client_id put in the callback: undefined sends the issued one, null leaves it out. */
  callbackClientId?: string | null;
  /** scope of the token response: undefined grants what was asked, null leaves the field out. */
  grantedScope?: string | null;
  idTokenFlaw?: IdTokenFlaw;
  deny?: boolean;
  /** Redirect with a state that does not match the request. */
  tamperState?: boolean;
  noRefreshToken?: boolean;
  tokenStatus?: number;
  tokenDelayMs?: number;
  refreshStatus?: number;
  refreshScope?: string;
  email?: string;
  expiresIn?: number;
};

export type SigningKey = { kid: string; privateKey: CryptoKey; publicJwk: JsonWebKey };

export const generateSigningKey = async (kid: string, modulusLength = 2048): Promise<SigningKey> => {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { kid, privateKey: pair.privateKey, publicJwk };
};

const segment = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");

export const signJwt = async (key: SigningKey, payload: Record<string, unknown>, header: Record<string, unknown> = {}): Promise<string> => {
  const input = `${segment({ alg: "RS256", typ: "JWT", kid: key.kid, ...header })}.${segment(payload)}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, new TextEncoder().encode(input));
  return `${input}.${Buffer.from(signature).toString("base64url")}`;
};

export const jwkOf = (key: SigningKey): Record<string, unknown> => ({ kty: "RSA", kid: key.kid, use: "sig", alg: "RS256", n: key.publicJwk.n, e: key.publicJwk.e });

type PendingCode = { challenge: string; nonce: string; redirectUri: string; clientId: string; scope: string };

export type FakeAuthServer = {
  base: string;
  endpoints: { authorizeUrl: string; tokenUrl: string; jwksUrl: string; issuer: string };
  knobs: AuthKnobs;
  authorizeRequests: URLSearchParams[];
  tokenRequests: URLSearchParams[];
  jwksRequests: number;
  /** Location of the last redirect /authorize sent to the browser. */
  lastRedirect?: string;
  /** Refresh token currently valid (single use). */
  currentRefreshToken?: string;
  key: SigningKey;
  setKey(key: SigningKey): void;
  reset(knobs?: Partial<AuthKnobs>): void;
  stop(): void;
};

export const startFakeAuthServer = async (): Promise<FakeAuthServer> => {
  const defaults: AuthKnobs = { issuedClientId: "oaiapp_falatrace_test" };
  const codes = new Map<string, PendingCode>();
  let counter = 0;
  const otherKey = await generateSigningKey("main");
  const state: FakeAuthServer = {
    base: "",
    endpoints: { authorizeUrl: "", tokenUrl: "", jwksUrl: "", issuer: "" },
    knobs: { ...defaults },
    authorizeRequests: [],
    tokenRequests: [],
    jwksRequests: 0,
    key: await generateSigningKey("main"),
    setKey(key) {
      state.key = key;
    },
    reset(knobs = {}) {
      state.knobs = { ...defaults, ...knobs };
      state.authorizeRequests = [];
      state.tokenRequests = [];
      state.jwksRequests = 0;
      state.lastRedirect = undefined;
    },
    stop() {
      server.stop(true);
    }
  };

  const idToken = async (pending: PendingCode): Promise<string | undefined> => {
    const now = Math.floor(Date.now() / 1000);
    const flaw = state.knobs.idTokenFlaw;
    if (flaw === "missing") return undefined;
    const payload: Record<string, unknown> = {
      iss: flaw === "wrong-iss" ? "https://evil.example.com" : state.base,
      aud: flaw === "wrong-aud" ? "oaiapp_someone_else" : [pending.clientId, "https://api.openai.com/v1"],
      sub: "user-123",
      email: state.knobs.email ?? "ana@example.com",
      iat: now,
      exp: flaw === "expired" ? now - 3600 : now + 3600,
      nonce: flaw === "wrong-nonce" ? "another-nonce" : pending.nonce,
      ...(flaw === "azp-mismatch" ? { azp: "oaiapp_someone_else" } : {})
    };
    if (flaw === "alg-none") return `${segment({ alg: "none", typ: "JWT" })}.${segment(payload)}.`;
    if (flaw === "bad-signature") return signJwt({ ...otherKey, kid: state.key.kid }, payload);
    if (flaw === "unknown-kid") return signJwt({ ...state.key, kid: "never-published" }, payload);
    return signJwt(state.key, payload);
  };

  const issueTokens = async (scope: string, pending?: PendingCode): Promise<Record<string, unknown>> => {
    counter += 1;
    const refresh = state.knobs.noRefreshToken ? undefined : `rt-${counter}-${randomBytes(4).toString("hex")}`;
    state.currentRefreshToken = refresh;
    const id = pending ? await idToken(pending) : undefined;
    return {
      access_token: `at-${counter}-${randomBytes(4).toString("hex")}`,
      token_type: "Bearer",
      expires_in: state.knobs.expiresIn ?? 3600,
      ...(refresh ? { refresh_token: refresh } : {}),
      ...(id ? { id_token: id } : {}),
      ...(state.knobs.grantedScope === null ? {} : { scope: state.knobs.grantedScope ?? scope })
    };
  };

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/authorize" && request.method === "GET") {
        const params = url.searchParams;
        state.authorizeRequests.push(params);
        const redirectUri = params.get("redirect_uri") ?? "";
        const challenge = params.get("code_challenge") ?? "";
        if (params.get("response_type") !== "code" || params.get("code_challenge_method") !== "S256" || !/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/.test(redirectUri) || !challenge) {
          return new Response("bad authorize request", { status: 400 });
        }
        const callback = new URL(redirectUri);
        callback.searchParams.set("state", state.knobs.tamperState ? "tampered" : (params.get("state") ?? ""));
        if (state.knobs.deny) {
          callback.searchParams.set("error", "access_denied");
        } else {
          const requested = params.get("client_id") ?? "";
          const clientId = requested === "dynamic_agent_client" ? state.knobs.issuedClientId : requested;
          const code = `code-${randomBytes(8).toString("hex")}`;
          codes.set(code, { challenge, nonce: params.get("nonce") ?? "", redirectUri, clientId, scope: params.get("scope") ?? "" });
          callback.searchParams.set("code", code);
          const callbackClientId = state.knobs.callbackClientId === undefined ? clientId : state.knobs.callbackClientId;
          if (callbackClientId !== null) callback.searchParams.set("client_id", callbackClientId);
        }
        state.lastRedirect = callback.toString();
        return new Response(null, { status: 302, headers: { location: callback.toString() } });
      }
      if (url.pathname === "/token" && request.method === "POST") {
        if (request.headers.get("content-type") !== "application/x-www-form-urlencoded") return Response.json({ error: "invalid_request" }, { status: 400 });
        const form = new URLSearchParams(await request.text());
        state.tokenRequests.push(form);
        if (state.knobs.tokenDelayMs) await Bun.sleep(state.knobs.tokenDelayMs);
        if (form.get("grant_type") === "authorization_code") {
          if (state.knobs.tokenStatus && state.knobs.tokenStatus !== 200) return Response.json({ error: "server_error" }, { status: state.knobs.tokenStatus });
          const pending = codes.get(form.get("code") ?? "");
          codes.delete(form.get("code") ?? "");
          if (!pending) return Response.json({ error: "invalid_grant" }, { status: 400 });
          const verifier = form.get("code_verifier") ?? "";
          const challenge = createHash("sha256").update(verifier).digest("base64url");
          if (challenge !== pending.challenge || form.get("redirect_uri") !== pending.redirectUri || form.get("client_id") !== pending.clientId) {
            return Response.json({ error: "invalid_grant" }, { status: 400 });
          }
          return Response.json(await issueTokens(pending.scope, pending));
        }
        if (form.get("grant_type") === "refresh_token") {
          if (state.knobs.refreshStatus && state.knobs.refreshStatus !== 200) return Response.json({ error: "server_error" }, { status: state.knobs.refreshStatus });
          if (!state.currentRefreshToken || form.get("refresh_token") !== state.currentRefreshToken) return Response.json({ error: "invalid_grant", error_description: "refresh_token_reused" }, { status: 400 });
          return Response.json(await issueTokens(state.knobs.refreshScope ?? "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"));
        }
        return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
      }
      if (url.pathname === "/jwks") {
        state.jwksRequests += 1;
        return Response.json({ keys: [jwkOf(state.key)] });
      }
      return new Response("not found", { status: 404 });
    }
  });
  state.base = `http://127.0.0.1:${server.port}`;
  state.endpoints = { authorizeUrl: `${state.base}/authorize`, tokenUrl: `${state.base}/token`, jwksUrl: `${state.base}/jwks`, issuer: state.base };
  return state;
};
