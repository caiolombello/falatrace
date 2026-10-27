import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import {
  buildChatGptAuthUrl,
  CHATGPT_DIRECT_SCOPE,
  CHATGPT_MESSAGES,
  CHATGPT_OAUTH,
  CHATGPT_SCOPES,
  type ChatGptOAuthDeps,
  chatGptLogout,
  chatGptStatus,
  createPkce,
  getChatGptAccessToken,
  startChatGptLogin,
  verifyIdToken
} from "../chatgpt/oauth";
import { CHATGPT_STORE_MESSAGES, ChatGptStore } from "../chatgpt/store";
import { ProviderError } from "../types";
import { type FakeAuthServer, generateSigningKey, jwkOf, signJwt, startFakeAuthServer } from "./fixtures/fake-openai-auth";
import { withTempDir } from "./provider-helpers";

let auth: FakeAuthServer;

beforeAll(async () => {
  auth = await startFakeAuthServer();
});
afterAll(() => auth.stop());
beforeEach(() => auth.reset());

const depsFor = (dir: string, extra: Partial<ChatGptOAuthDeps> = {}): ChatGptOAuthDeps & { store: ChatGptStore } => ({
  store: new ChatGptStore(join(dir, "chatgpt")),
  endpoints: auth.endpoints,
  port: 0,
  ...extra
});

/** Starts a sign-in and plays the browser: follows the authorization URL to the loopback callback. */
const login = async (deps: ChatGptOAuthDeps, options: { browse?: boolean } = {}) => {
  const opened: string[] = [];
  let browser: Promise<Response> | undefined;
  const handle = await startChatGptLogin(
    {
      openUrl: (url) => {
        opened.push(url);
        if (options.browse !== false) browser = fetch(url);
      }
    },
    deps
  );
  return {
    handle,
    opened,
    page: async () => {
      const response = await (browser as Promise<Response>);
      return { status: response.status, text: await response.text() };
    }
  };
};

const signIn = async (dir: string, extra: Partial<ChatGptOAuthDeps> = {}) => {
  const deps = depsFor(dir, extra);
  const { handle } = await login(deps);
  await handle.done;
  return deps;
};

const failure = async (promise: Promise<unknown>): Promise<Error> => {
  const error = await promise.then(() => undefined, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(Error);
  return error as Error;
};

const expectProviderError = async (promise: Promise<unknown>, message: string, code: ProviderError["code"]) => {
  const error = await failure(promise);
  expect(error).toBeInstanceOf(ProviderError);
  expect({ message: error.message, code: (error as ProviderError).code }).toEqual({ message, code });
};

describe("Sign in with ChatGPT", () => {
  test("first sign-in: dynamic registration, PKCE S256, verified ID token, private credentials", async () => {
    await withTempDir(async (dir) => {
      const deps = depsFor(dir);
      const { handle, opened, page } = await login(deps);
      const status = await handle.done;
      expect(status).toEqual({ signedIn: true, planUsage: true, registered: true, email: "ana@example.com", expiresAt: expect.any(String), scopes: [...CHATGPT_SCOPES] });
      expect(opened).toEqual([handle.url]);
      expect(await page()).toMatchObject({ status: 200, text: expect.stringContaining("ChatGPT conectado") });

      const url = new URL(handle.url);
      expect(url.origin + url.pathname).toBe(auth.endpoints.authorizeUrl);
      const params = url.searchParams;
      expect(params.get("response_type")).toBe("code");
      expect(params.get("client_id")).toBe("dynamic_agent_client");
      expect(params.get("agent_name_hint")).toBe("FalaTrace");
      expect(params.get("ext_agent_host_id")).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
      expect(params.get("scope")).toBe("openid profile email offline_access resource.invoke chatgpt.tokens.use.direct");
      expect(params.get("resource")).toBe("https://api.openai.com/v1");
      expect(params.get("code_challenge_method")).toBe("S256");
      expect(params.get("state")?.length).toBeGreaterThanOrEqual(32);
      expect(params.get("nonce")?.length).toBeGreaterThanOrEqual(32);
      // Only the port of the loopback redirect varies; never "localhost".
      expect(handle.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/);
      expect(params.get("redirect_uri")).toBe(handle.redirectUri);

      // The token request proved possession of the PKCE verifier (the fake server checks it).
      const exchange = auth.tokenRequests[0] as URLSearchParams;
      expect(exchange.get("grant_type")).toBe("authorization_code");
      expect(exchange.get("client_id")).toBe("oaiapp_falatrace_test");
      expect(exchange.get("redirect_uri")).toBe(handle.redirectUri);
      expect(exchange.get("resource")).toBe("https://api.openai.com/v1");
      expect(createHash("sha256").update(exchange.get("code_verifier") ?? "").digest("base64url")).toBe(params.get("code_challenge") as string);

      const stored = await deps.store.read();
      expect(stored).toMatchObject({ version: 1, clientId: "oaiapp_falatrace_test", hostId: params.get("ext_agent_host_id"), email: "ana@example.com", scopes: [...CHATGPT_SCOPES] });
      expect(stored?.accessToken).toMatch(/^at-/);
      expect(stored?.refreshToken).toMatch(/^rt-/);
      expect((await fs.stat(deps.store.path)).mode & 0o777).toBe(0o600);
      // What the UI sees never carries a token.
      const shown = JSON.stringify(await chatGptStatus(deps));
      expect(shown).not.toContain(stored?.accessToken as string);
      expect(shown).not.toContain(stored?.refreshToken as string);
    });
  });

  test("a later sign-in reuses the issued client id and host id; another client id is refused", async () => {
    await withTempDir(async (dir) => {
      const deps = await signIn(dir);
      const first = await deps.store.read();
      const again = await login(deps);
      await again.handle.done;
      const params = new URL(again.handle.url).searchParams;
      expect(params.get("client_id")).toBe("oaiapp_falatrace_test");
      expect(params.has("agent_name_hint")).toBe(false);
      expect(params.get("ext_agent_host_id")).toBe(first?.hostId as string);

      await chatGptLogout({}, deps);
      auth.reset({ callbackClientId: "oaiapp_impostor" });
      const mismatch = await login(deps);
      expect((await failure(mismatch.handle.done)).message).toBe(CHATGPT_MESSAGES.clientMismatch);
      expect(await mismatch.page()).toMatchObject({ status: 400, text: expect.stringContaining(CHATGPT_MESSAGES.clientMismatch) });
      expect((await deps.store.read())?.accessToken).toBeUndefined();
      expect(auth.tokenRequests).toHaveLength(0);
    });
  });

  test("a callback with another state is refused, nothing is saved, and the sign-in keeps waiting", async () => {
    await withTempDir(async (dir) => {
      const deps = depsFor(dir);
      const { handle } = await login(deps, { browse: false });
      const forged = await fetch(`${handle.redirectUri}?code=stolen&state=forged&client_id=oaiapp_falatrace_test`);
      expect(forged.status).toBe(400);
      expect(await forged.text()).toContain(CHATGPT_MESSAGES.stateMismatch);
      expect(auth.tokenRequests).toHaveLength(0);
      expect((await deps.store.read())?.accessToken).toBeUndefined();
      // A redirect from the server with a tampered state is refused the same way.
      auth.reset({ tamperState: true });
      expect((await fetch(handle.url)).status).toBe(400);
      expect((await deps.store.read())?.accessToken).toBeUndefined();
      // The real answer still completes the sign-in.
      auth.reset();
      expect((await fetch(handle.url)).status).toBe(200);
      expect((await handle.done).signedIn).toBe(true);
    });
  });

  test("the user declining plan usage keeps the registration but no tokens", async () => {
    await withTempDir(async (dir) => {
      auth.reset({ grantedScope: "openid profile email offline_access resource.invoke" });
      const deps = depsFor(dir);
      const { handle, page } = await login(deps);
      expect((await failure(handle.done)).message).toBe(CHATGPT_MESSAGES.scopeDeclined);
      expect((await page()).text).toContain(CHATGPT_MESSAGES.scopeDeclined);
      const stored = await deps.store.read();
      expect(stored?.clientId).toBe("oaiapp_falatrace_test");
      expect(stored?.accessToken).toBeUndefined();
      expect(await chatGptStatus(deps)).toEqual({ signedIn: false, planUsage: false, registered: true, scopes: [] });
      // The next attempt reuses the issued client id.
      auth.reset();
      const retry = await login(deps);
      await retry.handle.done;
      expect(new URL(retry.handle.url).searchParams.get("client_id")).toBe("oaiapp_falatrace_test");
    });
  });

  test("an omitted scope in the token response means everything asked was granted", async () => {
    await withTempDir(async (dir) => {
      auth.reset({ grantedScope: null });
      const deps = await signIn(dir);
      expect((await deps.store.read())?.scopes).toContain(CHATGPT_DIRECT_SCOPE);
    });
  });

  test("ID token problems stop the sign-in before anything is saved", async () => {
    await withTempDir(async (dir) => {
      for (const flaw of ["missing", "bad-signature", "wrong-nonce", "wrong-aud", "wrong-iss", "expired", "alg-none", "unknown-kid", "azp-mismatch"] as const) {
        auth.reset({ idTokenFlaw: flaw });
        const deps = depsFor(join(dir, flaw));
        const { handle } = await login(deps);
        const error = await failure(handle.done);
        expect({ flaw, message: error.message }).toEqual({ flaw, message: CHATGPT_MESSAGES.identityFailed });
        expect((await deps.store.read())?.accessToken).toBeUndefined();
      }
    });
  });

  test("a rotated signing key is picked up by fetching the key set again", async () => {
    await withTempDir(async (dir) => {
      await signIn(join(dir, "before"));
      const original = auth.key;
      auth.setKey(await generateSigningKey("rotated"));
      try {
        auth.reset();
        await signIn(join(dir, "after"));
        expect(auth.jwksRequests).toBe(1);
      } finally {
        auth.setKey(original);
      }
    });
  });

  test("denied consent, failed exchanges and missing refresh tokens are reported in Portuguese", async () => {
    await withTempDir(async (dir) => {
      const cases: Array<[Parameters<FakeAuthServer["reset"]>[0], string]> = [
        [{ deny: true }, CHATGPT_MESSAGES.denied],
        [{ tokenStatus: 500 }, CHATGPT_MESSAGES.exchangeFailed],
        [{ noRefreshToken: true }, CHATGPT_MESSAGES.noRefreshToken],
        [{ callbackClientId: null }, CHATGPT_MESSAGES.clientMissing],
        [{ callbackClientId: "dynamic_agent_client" }, CHATGPT_MESSAGES.clientMissing]
      ];
      for (const [knobs, message] of cases) {
        auth.reset(knobs);
        const deps = depsFor(join(dir, message.slice(0, 8).replace(/\W/g, "")));
        const { handle } = await login(deps);
        expect((await failure(handle.done)).message).toBe(message);
        expect((await deps.store.read())?.accessToken).toBeUndefined();
      }
    });
  });

  test("a busy port fails clearly unless a fallback port is allowed", async () => {
    await withTempDir(async (dir) => {
      const blocker = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("busy") });
      try {
        const busy = await failure(startChatGptLogin({}, depsFor(dir, { port: blocker.port })));
        expect(busy.message).toBe(CHATGPT_MESSAGES.portBusy);
        // The failed attempt did not leave a sign-in marked as running.
        const fallback = await login(depsFor(dir, { port: blocker.port, portFallback: true }));
        expect(fallback.handle.redirectUri).not.toContain(`:${blocker.port}/`);
        expect((await fallback.handle.done).signedIn).toBe(true);
      } finally {
        blocker.stop(true);
      }
      expect(CHATGPT_OAUTH.defaultPort).toBe(1455);
    });
  });

  test("one sign-in at a time; cancel and timeout settle it and free the port", async () => {
    await withTempDir(async (dir) => {
      const first = await login(depsFor(dir), { browse: false });
      expect((await failure(startChatGptLogin({}, depsFor(dir)))).message).toBe(CHATGPT_MESSAGES.inProgress);
      await first.handle.cancel();
      expect((await failure(first.handle.done)).message).toBe(CHATGPT_MESSAGES.cancelled);
      await expect(fetch(first.handle.redirectUri)).rejects.toThrow();

      const slowDeps = depsFor(dir, { timeoutMs: 150 });
      const slow = await login(slowDeps, { browse: false });
      expect((await failure(slow.handle.done)).message).toBe(CHATGPT_MESSAGES.timeout);
      expect((await slowDeps.store.read())?.accessToken).toBeUndefined();
    });
  });

  test("the listener answers only its callback path, and a second callback while one is handled is refused", async () => {
    await withTempDir(async (dir) => {
      auth.reset({ tokenDelayMs: 300 });
      const { handle } = await login(depsFor(dir), { browse: false });
      const origin = new URL(handle.redirectUri).origin;
      expect((await fetch(`${origin}/`)).status).toBe(404);
      expect((await fetch(`${origin}/auth/callback`, { method: "POST" })).status).toBe(404);
      const browsing = fetch(handle.url);
      await Bun.sleep(100);
      const duplicate = await fetch(auth.lastRedirect as string);
      expect(duplicate.status).toBe(409);
      expect((await browsing).status).toBe(200);
      expect((await handle.done).signedIn).toBe(true);
      expect(auth.tokenRequests).toHaveLength(1);
    });
  });

  test("cancelling while the code is being exchanged saves nothing", async () => {
    await withTempDir(async (dir) => {
      auth.reset({ tokenDelayMs: 300 });
      const deps = depsFor(dir);
      const { handle } = await login(deps, { browse: false });
      const browsing = fetch(handle.url);
      await Bun.sleep(100);
      await handle.cancel();
      expect((await failure(handle.done)).message).toBe(CHATGPT_MESSAGES.cancelled);
      const page = await browsing;
      expect(page.status).toBe(400);
      expect(await page.text()).toContain(CHATGPT_MESSAGES.cancelled);
      await Bun.sleep(400);
      expect((await deps.store.read())?.accessToken).toBeUndefined();
      expect(await chatGptStatus(deps)).toMatchObject({ signedIn: false });
    });
  });

  test("a failing browser opener still returns the URL to open by hand", async () => {
    await withTempDir(async (dir) => {
      const handle = await startChatGptLogin(
        {
          openUrl: () => {
            throw new Error("xdg-open missing");
          }
        },
        depsFor(dir)
      );
      expect(handle.url.startsWith(auth.endpoints.authorizeUrl)).toBe(true);
      expect((await fetch(handle.url)).status).toBe(200);
      expect((await handle.done).signedIn).toBe(true);
    });
  });
});

describe("access tokens", () => {
  const later = () => Date.now() + 2 * 3600_000;

  test("a fresh token is used as is; an expiring one is refreshed with the rotating refresh token", async () => {
    await withTempDir(async (dir) => {
      const signed = await signIn(dir);
      const before = await signed.store.read();
      expect(await getChatGptAccessToken({}, signed)).toBe(before?.accessToken as string);
      expect(auth.tokenRequests).toHaveLength(1);

      const token = await getChatGptAccessToken({}, { ...signed, now: later });
      const after = await signed.store.read();
      expect(token).toBe(after?.accessToken as string);
      expect(token).not.toBe(before?.accessToken as string);
      expect(after?.refreshToken).not.toBe(before?.refreshToken as string);
      const refresh = auth.tokenRequests[1] as URLSearchParams;
      expect(Object.fromEntries(refresh)).toEqual({ grant_type: "refresh_token", refresh_token: before?.refreshToken as string, client_id: "oaiapp_falatrace_test", resource: "https://api.openai.com/v1" });
      expect(after?.hostId).toBe(before?.hostId as string);
      expect(after?.email).toBe("ana@example.com");
    });
  });

  test("parallel callers share one refresh: the second adopts the token the first obtained", async () => {
    await withTempDir(async (dir) => {
      const signed = await signIn(dir);
      const tokens = await Promise.all([getChatGptAccessToken({}, { ...signed, now: later }), getChatGptAccessToken({}, { ...signed, store: new ChatGptStore(signed.store.root), now: later })]);
      expect(tokens[0]).toBe(tokens[1]);
      expect(auth.tokenRequests.filter((form) => form.get("grant_type") === "refresh_token")).toHaveLength(1);
    });
  });

  test("a spent or reused refresh token signs out but keeps the registration", async () => {
    await withTempDir(async (dir) => {
      const signed = await signIn(dir);
      const stale = await signed.store.read();
      await getChatGptAccessToken({ forceRefresh: true }, signed);
      // Another copy still holds the old pair (a restored backup): the server refuses its reuse.
      await signed.store.transaction(() => ({ next: stale, result: undefined }));
      await expectProviderError(getChatGptAccessToken({}, { ...signed, now: later }), CHATGPT_MESSAGES.expired, "auth");
      const stored = await signed.store.read();
      expect(stored?.accessToken).toBeUndefined();
      expect(stored?.clientId).toBe("oaiapp_falatrace_test");
      await expectProviderError(getChatGptAccessToken({}, signed), CHATGPT_MESSAGES.signedOut, "auth");
    });
  });

  test("a server failure keeps the tokens; a refresh without plan usage drops them", async () => {
    await withTempDir(async (dir) => {
      const signed = await signIn(dir);
      auth.reset({ refreshStatus: 503 });
      await expectProviderError(getChatGptAccessToken({}, { ...signed, now: later }), CHATGPT_MESSAGES.unreachable, "unavailable");
      expect((await signed.store.read())?.accessToken).toBeDefined();
      auth.reset({ refreshScope: "openid offline_access" });
      await expectProviderError(getChatGptAccessToken({}, { ...signed, now: later }), CHATGPT_MESSAGES.scopeDeclined, "auth");
      expect((await signed.store.read())?.accessToken).toBeUndefined();
    });
  });

  test("an unreachable token endpoint and a cancelled refresh are told apart", async () => {
    await withTempDir(async (dir) => {
      const signed = await signIn(dir);
      const offline: typeof fetch = (async () => {
        throw new TypeError("ECONNREFUSED");
      }) as unknown as typeof fetch;
      await expectProviderError(getChatGptAccessToken({}, { ...signed, now: later, fetch: offline }), CHATGPT_MESSAGES.unreachable, "unavailable");
      const aborted = new AbortController();
      aborted.abort();
      await expectProviderError(getChatGptAccessToken({ signal: aborted.signal }, { ...signed, now: later }), CHATGPT_MESSAGES.cancelled, "cancelled");
      expect((await signed.store.read())?.accessToken).toBeDefined();
    });
  });

  test("signed out, plan usage missing, or an unsafe file all mean no token", async () => {
    await withTempDir(async (dir) => {
      const store = new ChatGptStore(join(dir, "chatgpt"));
      await expectProviderError(getChatGptAccessToken({}, { store }), CHATGPT_MESSAGES.signedOut, "auth");
      await store.ensureHostId();
      await store.transaction((current) => ({
        next: current && { ...current, clientId: "oaiapp_x", accessToken: "at", refreshToken: "rt", expiresAt: new Date(Date.now() + 3600_000).toISOString(), scopes: ["openid"] },
        result: undefined
      }));
      await expectProviderError(getChatGptAccessToken({}, { store }), CHATGPT_MESSAGES.scopeDeclined, "auth");
      await fs.chmod(store.path, 0o644);
      await expectProviderError(getChatGptAccessToken({}, { store }), CHATGPT_MESSAGES.signedOut, "auth");
    });
  });
});

describe("logout and status", () => {
  test("logout forgets the tokens and keeps the registration; forgetRegistration removes everything", async () => {
    await withTempDir(async (dir) => {
      const signed = await signIn(dir);
      const hostId = (await signed.store.read())?.hostId;
      await chatGptLogout({}, signed);
      expect(await chatGptStatus(signed)).toEqual({ signedIn: false, planUsage: false, registered: true, scopes: [] });
      expect(await signed.store.read()).toMatchObject({ hostId, clientId: "oaiapp_falatrace_test" });
      await chatGptLogout({ forgetRegistration: true }, signed);
      expect(await signed.store.read()).toBeUndefined();
      expect(await chatGptStatus(signed)).toEqual({ signedIn: false, planUsage: false, registered: false, scopes: [] });
      // Logging out twice is fine.
      await chatGptLogout({}, signed);
    });
  });

  test("logout removes a planted link without touching its target", async () => {
    await withTempDir(async (dir) => {
      const store = new ChatGptStore(join(dir, "chatgpt"));
      await store.ensureHostId();
      const target = join(dir, "target.json");
      await fs.writeFile(target, "keep me");
      await fs.rm(store.path);
      await fs.symlink(target, store.path);
      await expect(chatGptStatus({ store })).rejects.toThrow(CHATGPT_STORE_MESSAGES.unsafe);
      await chatGptLogout({}, { store });
      await expect(fs.lstat(store.path)).rejects.toThrow();
      expect(await fs.readFile(target, "utf8")).toBe("keep me");
    });
  });
});

describe("OAuth helpers", () => {
  test("PKCE: S256 challenge of a 64-character verifier; state and nonce are random", () => {
    const pkce = createPkce();
    expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(pkce.challenge).toBe(createHash("sha256").update(pkce.verifier).digest("base64url"));
    const other = createPkce();
    expect(other.state).not.toBe(pkce.state);
    expect(other.nonce).not.toBe(pkce.nonce);
    const fixed = createPkce((size) => Buffer.alloc(size, 1));
    expect(fixed.verifier).toBe(Buffer.alloc(48, 1).toString("base64url"));
  });

  test("the authorization URL adds agent_name_hint only for the dynamic registration", () => {
    const base = { hostId: "urn:uuid:12345678-1234-4123-8123-123456789abc", redirectUri: "http://127.0.0.1:1455/auth/callback", challenge: "c", state: "s", nonce: "n" };
    const dynamic = new URL(buildChatGptAuthUrl(base));
    expect(dynamic.origin + dynamic.pathname).toBe("https://auth.openai.com/api/accounts/authorize");
    expect(dynamic.searchParams.get("agent_name_hint")).toBe("FalaTrace");
    const issued = new URL(buildChatGptAuthUrl({ ...base, clientId: "oaiapp_1" }));
    expect(issued.searchParams.get("client_id")).toBe("oaiapp_1");
    expect(issued.searchParams.has("agent_name_hint")).toBe(false);
  });

  test("verifyIdToken checks signature, issuer, audience, expiry, issue time and nonce", async () => {
    const key = await generateSigningKey("k1");
    const second = await generateSigningKey("k2");
    let caseId = 0;
    /** A fresh JWKS URL per call: keys are cached per URL. */
    const jwks = (keys: unknown[]) => {
      caseId += 1;
      const url = `https://jwks.invalid/${caseId}`;
      const stub = (async () => Response.json({ keys })) as unknown as typeof fetch;
      return { jwksUrl: url, fetch: stub };
    };
    const now = Date.now();
    const claims = { iss: "https://auth.example", aud: "oaiapp_1", sub: "u1", email: "ana@example.com", exp: Math.floor(now / 1000) + 600, iat: Math.floor(now / 1000), nonce: "n1" };
    const expected = { issuer: "https://auth.example/", audience: "oaiapp_1", nonce: "n1", now };
    expect(await verifyIdToken(await signJwt(key, claims), { ...expected, ...jwks([jwkOf(key)]) })).toEqual({ subject: "u1", email: "ana@example.com" });
    // Without a kid, a single published key is used; with two keys the token must name one.
    const noKid = await signJwt(key, claims, { kid: undefined });
    expect((await verifyIdToken(noKid, { ...expected, ...jwks([jwkOf(key)]) })).subject).toBe("u1");
    await expect(verifyIdToken(noKid, { ...expected, ...jwks([jwkOf(key), jwkOf(second)]) })).rejects.toThrow(CHATGPT_MESSAGES.identityFailed);
    const profileEmail = { ...claims, email: undefined, "https://api.openai.com/profile": { email: "bia@example.com" } };
    expect((await verifyIdToken(await signJwt(key, profileEmail), { ...expected, ...jwks([jwkOf(key)]) })).email).toBe("bia@example.com");

    const small = await generateSigningKey("small", 1024);
    // Thunks, so no rejection is left waiting while the next token is signed.
    const refused: Array<[string, () => Promise<unknown>]> = [
      ["future iat", async () => verifyIdToken(await signJwt(key, { ...claims, iat: claims.iat + 3600 }), { ...expected, ...jwks([jwkOf(key)]) })],
      ["expired", async () => verifyIdToken(await signJwt(key, { ...claims, exp: claims.iat - 120 }), { ...expected, ...jwks([jwkOf(key)]) })],
      ["no exp", async () => verifyIdToken(await signJwt(key, { ...claims, exp: undefined }), { ...expected, ...jwks([jwkOf(key)]) })],
      ["no nonce", async () => verifyIdToken(await signJwt(key, { ...claims, nonce: undefined }), { ...expected, ...jwks([jwkOf(key)]) })],
      ["HS256", async () => verifyIdToken(await signJwt(key, claims, { alg: "HS256" }), { ...expected, ...jwks([jwkOf(key)]) })],
      ["jwk alg", async () => verifyIdToken(await signJwt(key, claims), { ...expected, ...jwks([{ ...jwkOf(key), alg: "RS512" }]) })],
      ["jwk use", async () => verifyIdToken(await signJwt(key, claims), { ...expected, ...jwks([{ ...jwkOf(key), use: "enc" }]) })],
      ["not RSA", async () => verifyIdToken(await signJwt(key, claims), { ...expected, ...jwks([{ ...jwkOf(key), kty: "EC" }]) })],
      ["two parts", async () => verifyIdToken("a.b", { ...expected, ...jwks([jwkOf(key)]) })],
      ["bad base64", async () => verifyIdToken("a!.b.c", { ...expected, ...jwks([jwkOf(key)]) })],
      ["tampered payload", async () => {
        const [header, , signature] = (await signJwt(key, claims)).split(".");
        const payload = Buffer.from(JSON.stringify({ ...claims, email: "mallory@example.com" })).toString("base64url");
        return verifyIdToken(`${header}.${payload}.${signature}`, { ...expected, ...jwks([jwkOf(key)]) });
      }],
      ["1024-bit key", async () => verifyIdToken(await signJwt(small, claims), { ...expected, ...jwks([jwkOf(small)]) })]
    ];
    for (const [name, attempt] of refused) {
      const error = await attempt().then(() => undefined, (reason: unknown) => reason as Error);
      expect({ name, message: error?.message }).toEqual({ name, message: CHATGPT_MESSAGES.identityFailed });
    }
    const unreachable = { jwksUrl: "https://jwks.invalid/down", fetch: (async () => { throw new TypeError("offline"); }) as unknown as typeof fetch };
    await expect(verifyIdToken(await signJwt(key, claims), { ...expected, ...unreachable })).rejects.toThrow(CHATGPT_MESSAGES.unreachable);
  });
});
