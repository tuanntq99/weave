import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { userIdOf } from "../src/auth";
import { createWorker } from "../src/worker";

const ISSUER = "https://notes-test.cloudflareaccess.com";
let worker: ReturnType<typeof createWorker>;
let sign: (claims: JWTPayload, options?: { audience?: string; expires?: string }) => Promise<string>;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
  worker = createWorker({ keys: createLocalJWKSet({ keys: [jwk] }) });
  sign = (claims, options = {}) => new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(ISSUER)
    .setAudience(options.audience ?? "aud-test")
    .setIssuedAt()
    .setExpirationTime(options.expires ?? "1h")
    .sign(privateKey);
});

async function call(path: string, init: RequestInit & { token?: string; host?: string } = {}, bindings = env) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("Cf-Access-Jwt-Assertion", init.token);
  const request = new Request(`https://${init.host ?? "notes.example.com"}${path}`, { ...init, headers });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, bindings, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

describe("signing in", () => {
  it("no token → 401", async () => {
    expect((await call("/api/me")).status).toBe(401);
  });

  it("a token for another audience → 401", async () => {
    expect((await call("/api/me", { token: await sign({ email: "ada@example.com" }, { audience: "someone-else" }) })).status).toBe(401);
  });

  it("an expired token → 401", async () => {
    expect((await call("/api/me", { token: await sign({ email: "ada@example.com" }, { expires: "-1m" }) })).status).toBe(401);
  });

  it("/api/me answers the person", async () => {
    const response = await call("/api/me", { token: await sign({ email: "Ada@Example.com" }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: await userIdOf("ada@example.com"), handle: "ada", displayName: "Ada", avatarUrl: null, sharing: false });
  });

  it("DEV_USER works on localhost and not on another host", async () => {
    const dev = { ...env, DEV_USER: "grace" };
    const local = await call("/api/me", { host: "localhost:8787" }, dev);
    expect(local.status).toBe(200);
    expect(await local.json()).toMatchObject({ handle: "grace" });
    expect((await call("/api/me", { host: "notes.example.com" }, dev)).status).toBe(401);
  });
});

describe("requests from other sites", () => {
  it("a socket opened by another site's page is refused", async () => {
    const userId = await userIdOf("ada@example.com");
    const response = await call(`/api/sync/${encodeURIComponent(`personal:${userId}`)}`, {
      token: await sign({ email: "ada@example.com" }), headers: { Upgrade: "websocket", Origin: "https://evil.example" },
    });
    expect(response.status).toBe(403);
  });

  it("a restore posted by another site's page is refused", async () => {
    const response = await call("/api/admin/restore", {
      method: "POST", token: await sign({ email: "owner@example.com" }), headers: { Origin: "https://evil.example" },
      body: JSON.stringify({ scope: "personal:u_x", at: 0 }),
    }, { ...env, OWNER_EMAIL: "owner@example.com" });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: "cross_site" });
  });

  it("Notes' own pages are let through", async () => {
    const response = await call("/api/me", { token: await sign({ email: "ada@example.com" }), headers: { Origin: "https://notes.example.com" } });
    expect(response.status).toBe(200);
  });
});

describe("the sync route", () => {
  it("opens the person's own scope", async () => {
    const userId = await userIdOf("ada@example.com");
    const response = await call(`/api/sync/${encodeURIComponent(`personal:${userId}`)}`, {
      token: await sign({ email: "ada@example.com" }), headers: { Upgrade: "websocket" },
    });
    expect(response.status).toBe(101);
    response.webSocket?.accept();
    response.webSocket?.close(1000, "done");
  });

  it("another person's scope → 403", async () => {
    const response = await call(`/api/sync/${encodeURIComponent("personal:u_someoneelse00000")}`, {
      token: await sign({ email: "ada@example.com" }), headers: { Upgrade: "websocket" },
    });
    expect(response.status).toBe(403);
  });

  it("space scopes → 403", async () => {
    const response = await call(`/api/sync/${encodeURIComponent("space:s1")}`, {
      token: await sign({ email: "ada@example.com" }), headers: { Upgrade: "websocket" },
    });
    expect(response.status).toBe(403);
  });

  it("without a sign-in → 401", async () => {
    expect((await call("/api/sync/x", { headers: { Upgrade: "websocket" } })).status).toBe(401);
  });
});
