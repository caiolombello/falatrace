import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GOOGLE_MESSAGES, GOOGLE_SCOPES, GOOGLE_TOKEN_URL, GoogleTokenStore, buildAuthUrl, createPkce, emailFromIdToken, exchangeCode, listenForCallback,
  refreshAccessToken, revokeToken, startGoogleConnect
} from "../oauth";

const CLIENT = "123456789012-abcdefghij0123456789.apps.googleusercontent.com";
const idToken = (payload: object) => `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
const withDir = async (run: (dir: string) => Promise<void>) => {
  const dir = await fs.mkdtemp(join(tmpdir(), "falatrace-google-"));
  try { await run(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
};
type Seen = { url: string; form: URLSearchParams };
const tokenEndpoint = (reply: (form: URLSearchParams) => { status: number; body: object }, seen: Seen[] = []) => (async (input: RequestInfo | URL, init?: RequestInit) => {
  const form = new URLSearchParams(String(init?.body || ""));
  seen.push({ url: String(input), form });
  const { status, body } = reply(form);
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}) as typeof fetch;

test("PKCE pairs a verifier with its S256 challenge, and the consent URL asks only for what is needed", () => {
  let counter = 0;
  const pkce = createPkce((size) => Buffer.alloc(size, ++counter));
  expect(pkce.challenge).toBe(createHash("sha256").update(pkce.verifier).digest("base64url"));
  expect(pkce.verifier.length).toBeGreaterThanOrEqual(43);
  const url = new URL(buildAuthUrl(CLIENT, "http://127.0.0.1:4321", pkce.challenge, pkce.state));
  expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
  expect(Object.fromEntries(url.searchParams)).toEqual({
    client_id: CLIENT, redirect_uri: "http://127.0.0.1:4321", response_type: "code", scope: GOOGLE_SCOPES.join(" "),
    code_challenge: pkce.challenge, code_challenge_method: "S256", state: pkce.state, access_type: "offline", prompt: "consent"
  });
  expect(url.searchParams.get("scope")).toBe("openid email https://www.googleapis.com/auth/calendar.events.owned.readonly");
  expect(emailFromIdToken(idToken({ email: "ana@example.com" }))).toBe("ana@example.com");
  expect(emailFromIdToken("garbage")).toBeUndefined();
});

test("the loopback server accepts only Google's redirect with this state", async () => {
  const callback = await listenForCallback("expected-state", { timeoutMs: 5_000 });
  expect(callback.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect((await fetch(`${callback.redirectUri}/favicon.ico`)).status).toBe(404);
  const answer = await fetch(`${callback.redirectUri}/?state=expected-state&code=the-code`);
  expect(answer.status).toBe(200);
  expect(await answer.text()).toContain("Conta do Google conectada");
  expect(await callback.code).toBe("the-code");
  // One shot: the server is gone once the code arrived.
  await expect(fetch(`${callback.redirectUri}/?state=expected-state&code=again`)).rejects.toThrow();

  const forged = await listenForCallback("expected-state", { timeoutMs: 5_000 });
  expect((await fetch(`${forged.redirectUri}/?state=other&code=x`)).status).toBe(400);
  // Another page cannot end the sign-in: it keeps waiting for Google's answer with this state.
  await fetch(`${forged.redirectUri}/?state=expected-state&code=real`);
  expect(await forged.code).toBe("real");
  const denied = await listenForCallback("s", { timeoutMs: 5_000 });
  await fetch(`${denied.redirectUri}/?state=s&error=access_denied`);
  await expect(denied.code).rejects.toThrow(GOOGLE_MESSAGES.denied);
  const slow = await listenForCallback("s", { timeoutMs: 30 });
  await expect(slow.code).rejects.toThrow(GOOGLE_MESSAGES.timeout);
});

test("a full sign-in exchanges the code with the verifier and keeps only the refresh token, privately", async () => withDir(async (dir) => {
  const seen: Seen[] = [];
  const store = new GoogleTokenStore(join(dir, "google"));
  const fetchToken = tokenEndpoint(() => ({ status: 200, body: { access_token: "short-lived", refresh_token: "long-lived", scope: GOOGLE_SCOPES.join(" "), id_token: idToken({ email: "dono@example.com" }) } }), seen);
  const flow = await startGoogleConnect({ clientId: CLIENT, clientSecret: "desktop-secret" }, { fetch: fetchToken, store, timeoutMs: 5_000 });
  const auth = new URL(flow.url);
  const redirect = auth.searchParams.get("redirect_uri")!;
  await fetch(`${redirect}/?state=${auth.searchParams.get("state")}&code=authorization-code`);
  const token = await flow.done;
  expect(token).toMatchObject({ version: 1, clientId: CLIENT, refreshToken: "long-lived", email: "dono@example.com" });
  expect(seen).toHaveLength(1);
  expect(seen[0]!.url).toBe(GOOGLE_TOKEN_URL);
  const form = Object.fromEntries(seen[0]!.form);
  expect(form).toMatchObject({ client_id: CLIENT, client_secret: "desktop-secret", code: "authorization-code", grant_type: "authorization_code", redirect_uri: redirect });
  expect(createHash("sha256").update(form.code_verifier!).digest("base64url")).toBe(auth.searchParams.get("code_challenge")!);
  expect(await store.read()).toEqual(token);
  expect((await fs.stat(store.path)).mode & 0o777).toBe(0o600);
  expect((await fs.stat(store.root)).mode & 0o777).toBe(0o700);
  // The access token itself is never stored.
  expect(await fs.readFile(store.path, "utf8")).not.toContain("short-lived");
}));

test("sign-in failures are explained and save nothing", async () => withDir(async (dir) => {
  const store = new GoogleTokenStore(join(dir, "google"));
  await expect(startGoogleConnect({ clientId: "" }, { store })).rejects.toThrow(GOOGLE_MESSAGES.clientMissing);
  await expect(startGoogleConnect({ clientId: "not-a-client" }, { store })).rejects.toThrow(GOOGLE_MESSAGES.clientInvalid);
  await expect(exchangeCode({ clientId: CLIENT, code: "c", verifier: "v", redirectUri: "http://127.0.0.1:1" }, tokenEndpoint(() => ({ status: 400, body: { error: "invalid_grant" } }))))
    .rejects.toThrow(GOOGLE_MESSAGES.exchangeFailed);
  await expect(exchangeCode({ clientId: CLIENT, code: "c", verifier: "v", redirectUri: "http://127.0.0.1:1" }, tokenEndpoint(() => ({ status: 200, body: { access_token: "a" } }))))
    .rejects.toThrow(GOOGLE_MESSAGES.noRefreshToken);
  await expect(exchangeCode({ clientId: CLIENT, code: "c", verifier: "v", redirectUri: "http://127.0.0.1:1" }, (async () => { throw new Error("offline"); }) as unknown as typeof fetch))
    .rejects.toThrow(GOOGLE_MESSAGES.unreachable);
  expect(await store.read()).toBeUndefined();
  // A damaged or foreign token file reads as disconnected.
  await fs.mkdir(store.root, { recursive: true, mode: 0o700 });
  await fs.writeFile(store.path, JSON.stringify({ version: 1, clientId: "x", refreshToken: "r", scopes: [], connectedAt: "now" }), { mode: 0o600 });
  expect(await store.read()).toBeUndefined();
}));

test("refreshing and revoking use the stored refresh token; a refused refresh asks to connect again", async () => {
  const token = { version: 1 as const, clientId: CLIENT, refreshToken: "long-lived", scopes: [...GOOGLE_SCOPES], connectedAt: "2026-10-21T00:00:00.000Z" };
  const seen: Seen[] = [];
  expect(await refreshAccessToken(token, "secret", tokenEndpoint(() => ({ status: 200, body: { access_token: "fresh" } }), seen))).toBe("fresh");
  expect(Object.fromEntries(seen[0]!.form)).toEqual({ client_id: CLIENT, client_secret: "secret", refresh_token: "long-lived", grant_type: "refresh_token" });
  await expect(refreshAccessToken(token, undefined, tokenEndpoint(() => ({ status: 400, body: { error: "invalid_grant" } })))).rejects.toThrow(GOOGLE_MESSAGES.expired);
  expect(await revokeToken(token, tokenEndpoint(() => ({ status: 200, body: {} })))).toBe(true);
  expect(await revokeToken(token, (async () => { throw new Error("offline"); }) as unknown as typeof fetch)).toBe(false);
});
