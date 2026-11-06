import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import type { ServerMessage } from "@notes/sync-protocol";
import { userIdOf } from "../src/auth";
import { mayChangeRole, mayInvite, mayLeave, mayRemove } from "../src/sharing";
import { createWorker } from "../src/worker";

/* Sharing (spec S5c): off unless SHARING is "on"; then spaces, members
   and roles, and who may open a space's scope. */

const ISSUER = "https://notes-test.cloudflareaccess.com";
let worker: ReturnType<typeof createWorker>;
let sign: (email: string) => Promise<string>;
let runs = 0;

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
  worker = createWorker({ keys: createLocalJWKSet({ keys: [jwk] }) });
  sign = (email) => new SignJWT({ email }).setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(ISSUER).setAudience("aud-test").setIssuedAt().setExpirationTime("1h").sign(privateKey);
});

const on = { ...env, SHARING: "on" };

/** Someone with an email of their own to this test run. */
async function person(name: string) {
  const email = `${name}.${++runs}@example.com`;
  const token = await sign(email);
  const userId = await userIdOf(email);
  const ask = async (path: string, init: RequestInit = {}, bindings: typeof env = on) => {
    const headers = new Headers(init.headers);
    headers.set("Cf-Access-Jwt-Assertion", token);
    if (init.body) headers.set("Content-Type", "application/json");
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request(`https://notes.example.com${path}`, { ...init, headers }), bindings, ctx);
    await waitOnExecutionContext(ctx);
    return response;
  };
  const json = async (path: string, init: RequestInit = {}, bindings: typeof env = on) => {
    const response = await ask(path, init, bindings);
    return { status: response.status, body: await response.json() as Record<string, unknown> & Array<Record<string, unknown>> };
  };
  // Met: signed in once, so others can find them.
  await ask("/api/me");
  return { email, userId, handle: email.split("@")[0], ask, json };
}

const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

describe("the rules", () => {
  it("are local mode's", () => {
    expect(mayInvite("editor", "viewer")).toMatchObject({ code: "forbidden" });
    expect(mayInvite("admin", "admin")).toMatchObject({ code: "forbidden" });
    expect(mayInvite("owner", "admin")).toBeNull();
    expect(mayChangeRole("admin", "owner", "viewer")).toMatchObject({ code: "forbidden" });
    expect(mayChangeRole("admin", "admin", "viewer")).toMatchObject({ code: "forbidden" });
    expect(mayChangeRole("admin", "editor", "viewer")).toBeNull();
    expect(mayRemove("owner", "owner")).toMatchObject({ code: "forbidden" });
    expect(mayRemove("viewer", "editor")).toMatchObject({ code: "forbidden" });
    expect(mayLeave("owner")).toMatchObject({ code: "forbidden" });
    expect(mayLeave("viewer")).toBeNull();
  });
});

describe("with sharing off", () => {
  it("/api/me says so, and spaces, people and space scopes are refused", async () => {
    const ada = await person("ada");
    expect((await ada.json("/api/me", {}, env)).body).toMatchObject({ sharing: false });
    expect(await ada.json("/api/spaces", {}, env)).toEqual({ status: 403, body: { code: "sharing_off" } });
    expect((await ada.json("/api/people?q=a", {}, env)).status).toBe(403);
    expect((await ada.ask("/api/sync/space%3Aspace_x", { headers: { Upgrade: "websocket" } }, env)).status).toBe(403);
  });
});

describe("with sharing on", () => {
  it("a space is made, listed with its owner's role, and others are found and invited", async () => {
    const ada = await person("ada");
    const grace = await person("grace");
    expect((await ada.json("/api/me")).body).toMatchObject({ sharing: true });
    const made = await ada.json("/api/spaces", post({ name: "Team" }));
    expect(made.status).toBe(200);
    const spaceId = made.body.id as string;
    expect(spaceId).toMatch(/^space_[0-9a-f]{16}$/);
    expect((await ada.json("/api/spaces")).body).toEqual([{ id: spaceId, name: "Team", myRole: "owner" }]);
    expect((await grace.json("/api/spaces")).body).toEqual([]);

    const found = await ada.json(`/api/people?q=${grace.handle}`);
    expect(found.body.map((someone) => someone.id)).toContain(grace.userId);

    expect((await ada.json(`/api/spaces/${spaceId}/members`, post({ handle: grace.email, role: "editor" }))).body).toEqual({ created: true });
    expect((await ada.json(`/api/spaces/${spaceId}/members`, post({ handle: grace.email, role: "editor" }))).body).toEqual({ created: false });
    expect((await grace.json("/api/spaces")).body).toEqual([{ id: spaceId, name: "Team", myRole: "editor" }]);
    const members = (await grace.json(`/api/spaces/${spaceId}/members`)).body;
    expect(members.map((member) => [member.id, member.role])).toEqual(expect.arrayContaining([[ada.userId, "owner"], [grace.userId, "editor"]]));
  });

  it("someone who never signed in cannot be invited; an outsider sees nothing of a space", async () => {
    const ada = await person("ada");
    const eve = await person("eve");
    const spaceId = (await ada.json("/api/spaces", post({ name: "Mine" }))).body.id as string;
    expect((await ada.json(`/api/spaces/${spaceId}/members`, post({ handle: "nobody@example.com", role: "viewer" }))).status).toBe(404);
    expect((await eve.json(`/api/spaces/${spaceId}/members`)).status).toBe(403);
    expect((await eve.json(`/api/spaces/${spaceId}/members`, post({ handle: ada.email, role: "admin" }))).status).toBe(403);
  });

  it("roles change, members leave or are removed, by the rules", async () => {
    const ada = await person("ada");
    const grace = await person("grace");
    const spaceId = (await ada.json("/api/spaces", post({ name: "Team" }))).body.id as string;
    await ada.json(`/api/spaces/${spaceId}/members`, post({ handle: grace.email, role: "viewer" }));
    expect((await grace.json(`/api/spaces/${spaceId}/members/${ada.userId}`, { method: "DELETE" })).status).toBe(403);
    expect((await ada.json(`/api/spaces/${spaceId}/members/${grace.userId}`, { method: "PATCH", body: JSON.stringify({ role: "editor" }) })).status).toBe(200);
    expect((await grace.json("/api/spaces")).body).toEqual([{ id: spaceId, name: "Team", myRole: "editor" }]);
    expect((await ada.json(`/api/spaces/${spaceId}/leave`, { method: "POST" })).status).toBe(403);
    expect((await grace.json(`/api/spaces/${spaceId}/leave`, { method: "POST" })).status).toBe(200);
    expect((await grace.json("/api/spaces")).body).toEqual([]);
  });

  it("a space's scope opens for its members — a viewer's socket may not write — and no one else", async () => {
    const ada = await person("ada");
    const grace = await person("grace");
    const eve = await person("eve");
    const spaceId = (await ada.json("/api/spaces", post({ name: "Team" }))).body.id as string;
    await ada.json(`/api/spaces/${spaceId}/members`, post({ handle: grace.email, role: "viewer" }));
    const path = `/api/sync/${encodeURIComponent(`space:${spaceId}`)}`;
    expect((await eve.ask(path, { headers: { Upgrade: "websocket" } })).status).toBe(403);

    const response = await grace.ask(path, { headers: { Upgrade: "websocket" } });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();
    const heard: ServerMessage[] = [];
    const next = () => new Promise<void>((resolve) => socket.addEventListener("message", () => resolve(), { once: true }));
    socket.addEventListener("message", (event) => heard.push(JSON.parse(event.data as string)));
    let arrived = next();
    socket.send(JSON.stringify({ t: "hello", protocol: 1, cursor: 0, clientId: "g1" }));
    await arrived;
    arrived = next();
    socket.send(JSON.stringify({ t: "write", opId: "o1", collection: "pages", id: "p1", action: "delete" }));
    await arrived;
    expect(heard.find((message) => message.t === "reject")).toMatchObject({ opId: "o1", code: "forbidden" });

    // Files: read yes, write no.
    const file = `/api/files/${encodeURIComponent(`space:${spaceId}|bucket:files`)}/a.txt`;
    expect((await grace.ask(file, { method: "PUT", body: "x" })).status).toBe(403);
    expect((await ada.ask(file, { method: "PUT", body: "x" })).status).toBe(200);
    expect(await (await grace.ask(file)).text()).toBe("x");
    expect((await eve.ask(file)).status).toBe(403);
    socket.close(1000);
  });

  it("a member removed is disconnected from the space", async () => {
    const ada = await person("ada");
    const grace = await person("grace");
    const spaceId = (await ada.json("/api/spaces", post({ name: "Team" }))).body.id as string;
    await ada.json(`/api/spaces/${spaceId}/members`, post({ handle: grace.email, role: "editor" }));
    const response = await grace.ask(`/api/sync/${encodeURIComponent(`space:${spaceId}`)}`, { headers: { Upgrade: "websocket" } });
    const socket = response.webSocket!;
    socket.accept();
    const closed = new Promise<number>((resolve) => socket.addEventListener("close", (event) => resolve(event.code)));
    await ada.json(`/api/spaces/${spaceId}/members/${grace.userId}`, { method: "DELETE" });
    expect(await closed).toBe(4403);
  });
});
