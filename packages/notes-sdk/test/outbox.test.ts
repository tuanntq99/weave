import { describe, expect, it, vi } from "vitest";
import { LocalLiveCollection } from "../src/live";
import { outbox } from "../src/outbox";
import { sync } from "../src/sync";
import type { Transport } from "../src/transport";

type Row = { n?: number; title?: unknown };
const BUCKET = "personal:u_ada|pages";

/** A server that takes writes and never answers — as one out of reach. */
function silent(): Transport & { commits: Array<{ id: string; opId: string }> } {
  const commits: Array<{ id: string; opId: string }> = [];
  return {
    queued: true,
    commits,
    commit: (_bucket, id, _op, opId) => {
      commits.push({ id, opId });
      return new Promise(() => {});
    },
  };
}

describe("the outbox", () => {
  it("replace changes an entry's op in place, keeping its id and its place", async () => {
    const first = await outbox.add({ bucket: BUCKET, id: "a", opId: "o1", op: { action: "delete" } });
    await outbox.add({ bucket: BUCKET, id: "b", opId: "o2", op: { action: "delete" } });
    await outbox.replace("o1", { action: "put", value: { n: 9 } });
    const rows = await outbox.list(BUCKET);
    expect(rows.map((row) => [row.n, row.opId, row.op])).toEqual([
      [first, "o1", { action: "put", value: { n: 9 } }],
      [rows[1].n, "o2", { action: "delete" }],
    ]);
    await outbox.remove("o1");
    await outbox.remove("o2");
  });

  it("the outbox survives a reopen and is shown", async () => {
    const first = silent();
    const live = await LocalLiveCollection.open<Row>(BUCKET, [], first);
    void live.put("p1", { n: 1 });
    void live.patch("p1", { n: 2 });
    // The patch joins the put still waiting: one entry, under the put's id.
    await vi.waitFor(async () => expect(await outbox.list(BUCKET)).toHaveLength(1));
    await live.close();
    expect(first.commits).toHaveLength(1);

    const second = silent();
    const again = await LocalLiveCollection.open<Row>(BUCKET, [], second);
    expect(again.get("p1")).toEqual({ n: 2 });
    // Sent again, in the order they were made, under the same ids.
    expect(second.commits.map((commit) => commit.opId)).toEqual(first.commits.map((commit) => commit.opId));
  });

  it("an answered write leaves the outbox and is confirmed", async () => {
    const transport: Transport = { queued: true, commit: async (_bucket, _id, op) => ({ value: op.action === "put" ? { ...op.value, stored: true } : null, rev: 7 }) };
    const live = await LocalLiveCollection.open<Row & { stored?: boolean }>(BUCKET, [], transport);
    await live.put("p1", { n: 1 });
    expect(await outbox.list(BUCKET)).toEqual([]);
    expect(live.get("p1")).toEqual({ n: 1, stored: true });
  });

  it("a refused write leaves the outbox and the screen", async () => {
    const transport: Transport = { queued: true, commit: async () => { throw Object.assign(new Error("no"), { code: "bad_request" }); } };
    const live = await LocalLiveCollection.open<Row>(BUCKET, [], transport);
    await expect(live.put("p1", { n: 1 })).rejects.toThrow("no");
    expect(await outbox.list(BUCKET)).toEqual([]);
    expect(live.get("p1")).toBeUndefined();
  });

  it("the local transport keeps no outbox", async () => {
    const live = await LocalLiveCollection.open<Row>(BUCKET, []);
    await live.put("p1", { n: 1 });
    expect(await outbox.list(BUCKET)).toEqual([]);
  });

  it("sync.durable is false only while a write is not yet in IndexedDB", async () => {
    const live = await LocalLiveCollection.open<Row>(BUCKET, [], silent());
    const seen: boolean[] = [];
    const stop = sync.subscribe(() => seen.push(sync.durable));
    void live.put("p1", { n: 1 });
    expect(sync.durable).toBe(false);
    await vi.waitFor(async () => expect(await outbox.list(BUCKET)).toHaveLength(1));
    expect(sync.durable).toBe(true);
    stop();
    expect(seen).toContain(false);
  });
});
