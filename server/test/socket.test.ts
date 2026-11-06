import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ServerMessage } from "@notes/sync-protocol";
import type { ScopeDO } from "../src/scope-do";

const NOW = "2026-11-05T00:00:00.000Z";
const page = (id: string, title: string) => ({
  id, title_content: [{ text: title }], icon: "", kind: "document",
  created_at: NOW, updated_at: NOW, created_by: "Ada", updated_by: "Ada",
});
let names = 0;
const scope = () => env.SCOPE.getByName(`personal:u_socket${++names}`);

/** A client's socket to a scope: what it was told, in order. */
async function connect(stub: DurableObjectStub<ScopeDO>, userId = "u_a") {
  const response = await stub.fetch("https://do/sync", { headers: { Upgrade: "websocket", "X-Notes-User": userId } });
  const socket = response.webSocket!;
  socket.accept();
  const heard: ServerMessage[] = [];
  const waiting: Array<() => void> = [];
  socket.addEventListener("message", (event) => {
    heard.push(JSON.parse(event.data as string));
    for (const wake of waiting.splice(0)) wake();
  });
  return {
    heard,
    send: (message: unknown) => socket.send(JSON.stringify(message)),
    /** Waits until `count` messages have come. */
    async until(count: number) {
      while (heard.length < count) await new Promise<void>((resolve) => waiting.push(resolve));
      return heard;
    },
    close: () => socket.close(1000, "done"),
  };
}

const hello = (cursor = 0, clientId = "c1") => ({ t: "hello", protocol: 1, cursor, clientId });

describe("the sync socket", () => {
  it("hello with cursor 0 answers welcome with every change", async () => {
    const stub = scope();
    await stub.apply({ t: "write", opId: "o1", collection: "pages", id: "p1", action: "put", value: page("p1", "Plans") });
    const client = await connect(stub);
    client.send(hello());
    const [welcome] = await client.until(1);
    expect(welcome).toMatchObject({ t: "welcome", head: 1, reset: false, changes: [{ seq: 1, id: "p1" }] });
  });

  it("a write is acked to its sender and sent to the other socket as changes", async () => {
    const stub = scope();
    const one = await connect(stub);
    const two = await connect(stub);
    one.send(hello(0, "c1"));
    two.send(hello(0, "c2"));
    await one.until(1);
    await two.until(1);
    one.send({ t: "write", opId: "o1", collection: "pages", id: "p1", action: "put", value: page("p1", "Plans") });
    const heardByOne = await one.until(2);
    const heardByTwo = await two.until(2);
    expect(heardByOne[1]).toMatchObject({ t: "ack", opId: "o1", seq: 1 });
    expect(heardByTwo[1]).toMatchObject({ t: "changes", changes: [{ seq: 1, id: "p1" }] });
  });

  it("a stale cursor gets reset and snapshots in batches of 500", async () => {
    const stub = scope();
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      for (let index = 1; index <= 1201; index += 1) {
        sql.exec("INSERT INTO records (collection, id, value, seq) VALUES ('pages', ?, ?, ?)", `p${index}`, JSON.stringify(page(`p${index}`, "x")), index);
      }
      sql.exec("INSERT INTO meta (key, value) VALUES ('head', '1201'), ('tombstone_horizon', '100')");
    });
    const client = await connect(stub);
    client.send(hello(5));
    const heard = await client.until(4);
    expect(heard[0]).toEqual({ t: "welcome", head: 1201, reset: true });
    expect(heard.slice(1).map((message) => message.t === "snapshot" ? [message.records.length, message.done] : message.t))
      .toEqual([[500, false], [500, false], [201, true]]);
  });

  it("many missed changes come in batches after the welcome", async () => {
    const stub = scope();
    await runInDurableObject(stub, async (_instance, state) => {
      for (let index = 1; index <= 700; index += 1) {
        state.storage.sql.exec("INSERT INTO records (collection, id, value, seq) VALUES ('pages', ?, ?, ?)", `p${index}`, JSON.stringify(page(`p${index}`, "x")), index);
      }
      state.storage.sql.exec("INSERT INTO meta (key, value) VALUES ('head', '700')");
    });
    const client = await connect(stub);
    client.send(hello(0));
    const heard = await client.until(2);
    expect(heard[0]).toMatchObject({ t: "welcome", reset: false });
    expect(heard[0].t === "welcome" && !heard[0].reset ? heard[0].changes.length : -1).toBe(500);
    expect(heard[1].t === "changes" ? heard[1].changes.length : -1).toBe(200);
  });

  it("presence goes to every socket and survives eviction", async () => {
    const stub = scope();
    const one = await connect(stub, "u_a");
    const two = await connect(stub, "u_a");
    one.send(hello(0, "c1"));
    two.send(hello(0, "c2"));
    await one.until(1);
    await two.until(1);
    one.send({ t: "presence", state: { pageId: "p1" } });
    const heard = await two.until(2);
    expect(heard[1]).toMatchObject({ t: "presence", peers: expect.arrayContaining([{ clientId: "c1", userId: "u_a", state: { pageId: "p1" } }]) });
    await evictDurableObject(stub);
    two.send({ t: "presence", state: { pageId: "p2" } });
    const after = await one.until(3);
    const peers = after[after.length - 1].t === "presence" ? (after[after.length - 1] as { peers: unknown[] }).peers : [];
    expect(peers).toEqual(expect.arrayContaining([
      { clientId: "c1", userId: "u_a", state: { pageId: "p1" } },
      { clientId: "c2", userId: "u_a", state: { pageId: "p2" } },
    ]));
  });

  it("ping answers pong, and a message that is no message is let go", async () => {
    const stub = scope();
    const client = await connect(stub);
    client.send({ t: "nonsense" });
    client.send({ t: "ping" });
    const [pong] = await client.until(1);
    expect(pong).toEqual({ t: "pong" });
  });
});
