import { afterEach, describe, expect, it, vi } from "vitest";
import { backup } from "../src/backup";
import { configureSdk } from "../src/config";
import { db, done } from "../src/db";
import { LocalLiveCollection } from "../src/live";
import { outbox } from "../src/outbox";
import { connectScope, nextDelay, type RemoteScope } from "../src/remote";
import { sync } from "../src/sync";
import { localTransport, setTransports } from "../src/transport";
import { FakeServer } from "./fake-server";

const SCOPE = "personal:u_ada";
const BUCKET = `${SCOPE}|pages`;
const NOW = "2026-11-05T00:00:00.000Z";
const page = (title: string) => ({
  id: "p1", title_content: [{ text: title }], icon: "", kind: "document",
  created_at: NOW, updated_at: NOW, created_by: "Ada", updated_by: "Ada",
});
type Page = ReturnType<typeof page>;

let remotes: RemoteScope[] = [];
async function start(server: FakeServer) {
  const remote = connectScope(SCOPE, { url: "https://notes.test", WebSocket: server.WebSocket as unknown as typeof WebSocket, delays: () => 5 });
  remotes.push(remote);
  const live = await LocalLiveCollection.open<Page>(BUCKET, ["title_content"], remote);
  return { remote, live };
}

const cursorOf = async (scope: string) => {
  const database = await db();
  return (await done(database.transaction("cursors").objectStore("cursors").get(scope)) as { cursor: number } | undefined)?.cursor ?? 0;
};

afterEach(() => {
  for (const remote of remotes) remote.close();
  remotes = [];
});

describe("the remote transport", () => {
  it("writes are acked, stored and the cursor moves", async () => {
    const server = new FakeServer();
    const { live } = await start(server);
    await live.put("p1", page("Plans"));
    expect(server.records.get("pages|p1")?.value).toEqual(page("Plans"));
    expect(await outbox.list(BUCKET)).toEqual([]);
    expect(await cursorOf(SCOPE)).toBe(1);
    // Kept in this browser as the server stored it.
    const again = await LocalLiveCollection.open<Page>(BUCKET, ["title_content"], (await start(server)).remote);
    expect(again.get("p1")).toEqual(page("Plans"));
  });

  it("hears what another device wrote", async () => {
    const server = new FakeServer();
    const { live } = await start(server);
    await vi.waitFor(() => expect(server.sockets.size).toBe(1));
    server.writeFromElsewhere("pages", "p2", page("From the phone"));
    await vi.waitFor(() => expect(live.get("p2")).toEqual(page("From the phone")));
  });

  it("a reconnect resends the outbox in order and the server applies each once", async () => {
    const server = new FakeServer();
    const { live } = await start(server);
    server.dropNextAck = true;
    await live.put("p1", page("one"));
    expect(server.head).toBe(1);
    expect(new Set(server.received.filter((t) => t.startsWith("write:"))).size).toBe(1);
    expect(server.received.filter((t) => t.startsWith("write:")).length).toBe(2);
    expect(live.get("p1")).toEqual(page("one"));
  });

  it("an offline edit merges with what came meanwhile", async () => {
    const server = new FakeServer();
    const { live } = await start(server);
    await live.put("p1", page("hello world"));
    server.reachable = false;
    for (const socket of [...server.sockets]) socket.cut(1006);
    const writing = live.patch("p1", { title_content: [{ text: "hello world!" }] });
    await vi.waitFor(async () => expect(await outbox.list(BUCKET)).toHaveLength(1));
    // "saving" while it waits to be sent, then "offline".
    await vi.waitFor(() => expect(sync.status).toBe("offline"));
    server.change("pages", "p1", { ...page("hello brave world") });
    server.reachable = true;
    await writing;
    expect(live.get("p1")?.title_content).toEqual([{ text: "hello brave world!" }]);
    expect(server.records.get("pages|p1")?.value?.title_content).toEqual([{ text: "hello brave world!" }]);
  });

  it("a reset keeps the outbox and reloads the scope", async () => {
    const server = new FakeServer();
    server.change("pages", "p9", page("kept on the server"));
    server.horizon = 5;
    const { live } = await start(server);
    await vi.waitFor(() => expect(live.get("p9")).toEqual(page("kept on the server")));
    await live.put("p1", page("mine"));
    expect(server.records.get("pages|p1")?.value).toEqual(page("mine"));
  });

  it("after the server is restored to earlier, a reset brings this browser back to it, once", async () => {
    const server = new FakeServer();
    const { live } = await start(server);
    await live.put("p1", page("before"));
    await live.put("p2", page("made after the restore point"));
    expect(await cursorOf(SCOPE)).toBe(2);
    // Restored to just after the first write: p2 never happened.
    server.head = 1;
    server.records.delete("pages|p2");
    server.applied.clear();
    for (const socket of [...server.sockets]) socket.cut(1006);
    await vi.waitFor(() => expect(live.get("p2")).toBeUndefined());
    expect(await cursorOf(SCOPE)).toBe(1);
    // What the server writes next (seq 2 again) is heard.
    server.writeFromElsewhere("pages", "p3", page("after"));
    await vi.waitFor(async () => expect(await cursorOf(SCOPE)).toBe(2));
    const hellos = server.received.filter((t) => t === "hello").length;
    for (const socket of [...server.sockets]) socket.cut(1006);
    await vi.waitFor(() => expect(server.received.filter((t) => t === "hello").length).toBe(hellos + 1));
    await vi.waitFor(() => expect(server.sockets.size).toBe(1));
    expect(await cursorOf(SCOPE)).toBe(2);
  });

  it("a 4401 close stops retrying and keeps the outbox", async () => {
    const server = new FakeServer();
    server.signedIn = false;
    const { remote, live } = await start(server);
    void live.put("p1", page("waiting")).catch(() => undefined);
    await vi.waitFor(() => expect(remote.signedOut).toBe(true));
    const tries = server.received.length;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(server.received.length).toBe(tries);
    expect(await outbox.list(BUCKET)).toHaveLength(1);
  });

  it("a handshake refused at the edge (Access lets the sign-in lapse) reads as signed out once /api/me says so", async () => {
    const server = new FakeServer();
    server.reachable = false;
    let asked = 0;
    let signedIn = true;
    const remote = connectScope(SCOPE, {
      url: "https://notes.test", WebSocket: server.WebSocket as unknown as typeof WebSocket, delays: () => 5,
      checkSignIn: async () => {
        asked += 1;
        return signedIn;
      },
    });
    remotes.push(remote);
    // Still signed in: only out of reach, so it goes on trying.
    await vi.waitFor(() => expect(asked).toBeGreaterThan(1));
    expect(remote.signedOut).toBe(false);
    let told = 0;
    const stop = sync.subscribe(() => { told += 1; });
    signedIn = false;
    await vi.waitFor(() => expect(remote.signedOut).toBe(true));
    stop();
    expect(told).toBeGreaterThan(0);
    const tries = asked;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(asked).toBe(tries);
  });

  it("status reads saving, then saved", async () => {
    const server = new FakeServer();
    const { live } = await start(server);
    await vi.waitFor(() => expect(server.sockets.size).toBe(1));
    const seen: string[] = [];
    const stop = sync.subscribe(() => seen.push(sync.status));
    await live.put("p1", page("x"));
    await vi.waitFor(() => expect(sync.status).toBe("saved"));
    stop();
    expect(seen).toContain("saving");
    expect(seen[seen.length - 1]).toBe("saved");
  });
});

describe("a backup imported with a server", () => {
  afterEach(() => {
    setTransports(() => localTransport);
    configureSdk({ mode: "local", url: "" });
    vi.unstubAllGlobals();
  });

  it("goes to the server through the outbox, and every open view shows it", async () => {
    configureSdk({ mode: "remote", url: "https://notes.test" });
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }));
    const server = new FakeServer();
    const { remote, live } = await start(server);
    setTransports((bucket) => (bucket.startsWith(`${SCOPE}|`) ? remote : localTransport));
    await vi.waitFor(() => expect(server.sockets.size).toBe(1));
    const file = new Blob([JSON.stringify({
      format: "notes-backup", version: 1, exportedAt: NOW, user: { id: "u_ada", handle: "ada" },
      records: [{ bucket: BUCKET, id: "p1", value: page("Imported") }],
      files: [{ key: `${SCOPE}|a.txt`, type: "text/plain", base64: btoa("hello") }],
      meta: [],
    })]);
    expect(await backup.importAll(file, "merge")).toEqual({ records: 1, files: 1 });
    await vi.waitFor(() => expect(server.records.get("pages|p1")?.value).toEqual(page("Imported")));
    await vi.waitFor(() => expect(live.get("p1")).toEqual(page("Imported")));
    await vi.waitFor(async () => expect(await outbox.list(BUCKET)).toEqual([]));
    // The file's bytes are owed to the server until it can be reached.
    const database = await db();
    expect(await done(database.transaction("outbox_files").objectStore("outbox_files").getAllKeys())).toEqual([`${SCOPE}|a.txt`]);
  });
});

describe("nextDelay", () => {
  it("grows from 1 s to 30 s, within ±20%", () => {
    expect(nextDelay(0, 0.5)).toBe(1000);
    expect(nextDelay(3, 0.5)).toBe(8000);
    expect(nextDelay(10, 0.5)).toBe(30000);
    expect(nextDelay(0, 0)).toBe(800);
    expect(nextDelay(0, 1)).toBe(1200);
  });
});
