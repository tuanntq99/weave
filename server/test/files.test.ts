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

const own = async () => encodeURIComponent(`personal:${await userIdOf("ada@example.com")}`);

describe("files", () => {
  it("put then get returns the bytes with immutable caching", async () => {
    const token = await sign({ email: "ada@example.com" });
    const path = `/api/files/${await own()}/pictures/one.png`;
    const put = await call(path, { method: "PUT", token, body: "png-bytes", headers: { "Content-Type": "image/png" } });
    expect(put.status).toBe(200);
    const got = await call(path, { token });
    expect(got.status).toBe(200);
    expect(await got.text()).toBe("png-bytes");
    expect(got.headers.get("Content-Type")).toBe("image/png");
    expect(got.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable");
    expect(got.headers.get("ETag")).toBeTruthy();
  });

  it("a second put of a path keeps the first", async () => {
    const token = await sign({ email: "ada@example.com" });
    const path = `/api/files/${await own()}/a.txt`;
    await call(path, { method: "PUT", token, body: "first" });
    expect((await call(path, { method: "PUT", token, body: "second" })).status).toBe(200);
    expect(await (await call(path, { token })).text()).toBe("first");
  });

  it("over 10 MiB → 413", async () => {
    const token = await sign({ email: "ada@example.com" });
    const body = new Uint8Array(10 * 1024 * 1024 + 1);
    expect((await call(`/api/files/${await own()}/big.bin`, { method: "PUT", token, body })).status).toBe(413);
  });

  it("missing → 404 not_found", async () => {
    const response = await call(`/api/files/${await own()}/nothing.png`, { token: await sign({ email: "ada@example.com" }) });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: "not_found" });
  });

  it("another scope → 403", async () => {
    const response = await call(`/api/files/${encodeURIComponent("personal:u_someoneelse00000")}/a.txt`, { token: await sign({ email: "ada@example.com" }) });
    expect(response.status).toBe(403);
  });
});
