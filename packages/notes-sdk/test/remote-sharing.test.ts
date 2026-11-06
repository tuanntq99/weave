import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureSdk } from "../src/config";
import { ready } from "../src/index";
import { LocalLiveCollection } from "../src/live";
import { closeSpaceRemotes } from "../src/remote-spaces";
import { people_, spaces } from "../src/spaces";
import { transportFor } from "../src/transport";
import { FakeServer } from "./fake-server";

/* Sharing through the server (spec S5c), as the SDK sees it. */

const URL_BASE = "https://notes.test";
const ada = { id: "u_0123456789abcdef", handle: "ada", displayName: "Ada", avatarUrl: null };

function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() { return items.size; },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, String(value)),
  };
}

type Route = (init: RequestInit) => unknown;
/** A server answering /api/me (sharing as said) and the routes given. */
function serve(sharing: boolean, routes: Record<string, Route> = {}) {
  const asked: Array<{ method: string; path: string; body: unknown }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit = {}) => {
    const path = url.slice(URL_BASE.length);
    const method = init.method ?? "GET";
    asked.push({ method, path, body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (path === "/api/me") return Response.json({ ...ada, sharing });
    const route = routes[`${method} ${path}`];
    if (!route) return Response.json({ code: "not_found" }, { status: 404 });
    const answer = route(init);
    return answer instanceof Response ? answer : Response.json(answer);
  }));
  return asked;
}

beforeEach(() => {
  configureSdk({ mode: "remote", url: URL_BASE });
  vi.stubGlobal("localStorage", memoryStorage());
});

afterEach(() => {
  closeSpaceRemotes();
  configureSdk({ mode: "local", url: "" });
  vi.unstubAllGlobals();
});

describe("sharing off", () => {
  it("there are no spaces and none can be made", async () => {
    serve(false);
    vi.stubGlobal("WebSocket", new FakeServer().WebSocket);
    await ready();
    expect(await spaces.list()).toEqual([]);
    await expect(spaces.create({ name: "Team" })).rejects.toMatchObject({ code: "unavailable" });
  });
});

describe("sharing on", () => {
  it("spaces, members and people are the server's", async () => {
    const asked = serve(true, {
      "GET /api/spaces": () => [{ id: "space_1", name: "Team", myRole: "editor" }],
      "POST /api/spaces": () => ({ id: "space_2", name: "New" }),
      "POST /api/spaces/space_2/members": () => ({ created: true }),
      "GET /api/spaces/space_2/members": () => [{ ...ada, role: "owner" }],
      "GET /api/people?q=gr": () => [{ id: "u_grace", handle: "grace", displayName: "Grace", avatarUrl: null }],
    });
    vi.stubGlobal("WebSocket", new FakeServer().WebSocket);
    await ready();
    expect(await spaces.list()).toEqual([{
      id: "space_1", name: "Team", myRole: "editor",
      capabilities: { canInvite: false, canManageRoles: false, canRemoveMembers: false, canLeave: true },
    }]);
    expect((await spaces.create({ name: "New" })).space).toMatchObject({ id: "space_2", myRole: "owner", capabilities: { canInvite: true } });
    expect(await spaces.members.invite("space_2", "grace@example.com", "viewer")).toEqual({ created: true });
    expect(asked.find((call) => call.method === "POST" && call.path.endsWith("/members"))?.body).toEqual({ handle: "grace@example.com", role: "viewer" });
    expect(await spaces.members.list("space_2")).toEqual([{ ...ada, role: "owner" }]);
    expect((await people_.search("gr")).map((someone) => someone.handle)).toEqual(["grace"]);
  });

  it("a refusal comes back with the server's code", async () => {
    serve(true, { "POST /api/spaces/space_1/leave": () => Response.json({ code: "forbidden", message: "The owner cannot leave their space" }, { status: 403 }) });
    vi.stubGlobal("WebSocket", new FakeServer().WebSocket);
    await ready();
    await expect(spaces.leave("space_1")).rejects.toMatchObject({ code: "forbidden", message: "The owner cannot leave their space" });
  });

  it("with no network, the spaces are as last heard", async () => {
    serve(true, { "GET /api/spaces": () => [{ id: "space_1", name: "Team", myRole: "owner" }] });
    vi.stubGlobal("WebSocket", new FakeServer().WebSocket);
    await ready();
    await spaces.list();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    expect((await spaces.list()).map((space) => space.id)).toEqual(["space_1"]);
  });

  it("a space's records go through a socket of its own, and presence is by person", async () => {
    serve(true);
    const server = new FakeServer();
    vi.stubGlobal("WebSocket", server.WebSocket);
    await ready();
    const bucket = "space:space_1|pages";
    const live = await LocalLiveCollection.open<Record<string, unknown>>(bucket, ["title_content"], transportFor(bucket));
    await live.put("p1", { id: "p1", title_content: [{ text: "Shared" }], icon: "", kind: "document", created_at: "x", updated_at: "x", created_by: "Ada", updated_by: "Ada" });
    expect(server.records.get("pages|p1")?.value).toMatchObject({ title_content: [{ text: "Shared" }] });
    expect([...server.sockets].map((socket) => socket.url)).toContain("wss://notes.test/api/sync/space%3Aspace_1");

    const entered = await spaces.enter<{ pageId: string }>("space_1");
    const heard = vi.fn();
    entered.subscribePresence(heard);
    await entered.setPresence({ pageId: "p1" });
    await vi.waitFor(() => expect(entered.presence.states).toEqual({ u_ada: { pageId: "p1" } }));
    expect(entered.presence.online).toContain("u_ada");
    expect(heard).toHaveBeenCalled();
    await entered.close();
  });
});
