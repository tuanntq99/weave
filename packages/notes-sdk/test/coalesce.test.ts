import { afterEach, describe, expect, it, vi } from "vitest";
import { COALESCE, LocalLiveCollection } from "../src/live";
import { outbox } from "../src/outbox";
import { connectScope, type RemoteScope } from "../src/remote";
import { sync } from "../src/sync";
import type { Transport } from "../src/transport";
import { FakeServer } from "./fake-server";

/* Writes in remote mode wait a moment before they go: what is typed
   meanwhile joins the write still waiting, under its id (spec S4). */

const SCOPE = "personal:u_ada";
const BUCKET = `${SCOPE}|pages`;
const NOW = "2026-11-05T00:00:00.000Z";
const page = (title: string) => ({
  id: "p1", title_content: [{ text: title }], icon: "", kind: "document",
  created_at: NOW, updated_at: NOW, created_by: "Ada", updated_by: "Ada",
});
type Page = ReturnType<typeof page>;
const DEFAULT = { ...COALESCE };

let remotes: RemoteScope[] = [];
afterEach(() => {
  for (const remote of remotes) remote.close();
  remotes = [];
  Object.assign(COALESCE, DEFAULT);
});

async function start(server: FakeServer) {
  const remote = connectScope(SCOPE, { url: "https://notes.test", WebSocket: server.WebSocket as unknown as typeof WebSocket, delays: () => 5 });
  remotes.push(remote);
  return LocalLiveCollection.open<Page>(BUCKET, ["title_content"], remote);
}

/** Types `words` one character at a time, each from the words before it. */
function type(live: LocalLiveCollection<Page>, from: string, words: string): Promise<void>[] {
  const writes: Promise<void>[] = [];
  let shown = from;
  for (const char of words) {
    const base = [{ text: shown }];
    shown += char;
    writes.push(live.patch("p1", { title_content: [{ text: shown }] }, { base: { title_content: base } }));
  }
  return writes;
}

const writesTo = (server: FakeServer) => server.received.filter((t) => t.startsWith("write:"));

function silent(): Transport & { commits: Array<{ opId: string; op: unknown }> } {
  const commits: Array<{ opId: string; op: unknown }> = [];
  return { queued: true, commits, commit: (_bucket, _id, op, opId) => (commits.push({ opId, op }), new Promise(() => {})) };
}

describe("coalesced writes", () => {
  it("twenty keystrokes reach the server as one write", async () => {
    Object.assign(COALESCE, { quietMs: 50, maxMs: 2000 });
    const server = new FakeServer();
    const live = await start(server);
    await live.put("p1", page(""));
    const before = writesTo(server).length;
    await Promise.all(type(live, "", "twenty keys in a row"));
    expect(writesTo(server).length - before).toBe(1);
    expect(server.records.get("pages|p1")?.value).toMatchObject({ title_content: [{ text: "twenty keys in a row" }] });
    expect(await outbox.list(BUCKET)).toEqual([]);
    expect(sync.status).toBe("saved");
  });

  it("a write once sent is never changed: the next keystroke starts another", async () => {
    Object.assign(COALESCE, { quietMs: 10, maxMs: 2000 });
    const server = new FakeServer();
    const live = await start(server);
    await live.put("p1", page(""));
    await Promise.all(type(live, "", "a"));
    await Promise.all(type(live, "a", "b"));
    expect(writesTo(server).slice(-2)[0]).not.toBe(writesTo(server).slice(-1)[0]);
    expect(server.records.get("pages|p1")?.value).toMatchObject({ title_content: [{ text: "ab" }] });
  });

  it("a write still waiting is kept whole in the outbox, and sent as it is after a reload", async () => {
    Object.assign(COALESCE, { quietMs: 60_000, maxMs: 60_000 });
    const first = silent();
    const live = await LocalLiveCollection.open<Page>(BUCKET, ["title_content"], first);
    void live.put("p1", page("hi"));
    void type(live, "hi", " there");
    expect(sync.status).toBe("saving");
    await vi.waitFor(async () => {
      const rows = await outbox.list(BUCKET);
      expect(rows).toHaveLength(1);
      expect(rows[0].op).toMatchObject({ action: "put", value: { title_content: [{ text: "hi there" }] } });
    });
    expect(first.commits).toEqual([]);

    const second = silent();
    const again = await LocalLiveCollection.open<Page>(BUCKET, ["title_content"], second);
    expect(again.get("p1")?.title_content).toEqual([{ text: "hi there" }]);
    expect(second.commits).toHaveLength(1);
    expect(second.commits[0].opId).toBe((await outbox.list(BUCKET))[0].opId);
    await outbox.remove(second.commits[0].opId);
  });

  it("words that cannot join the waiting write send it at once, then wait themselves", async () => {
    Object.assign(COALESCE, { quietMs: 60_000, maxMs: 60_000 });
    const transport = silent();
    const live = await LocalLiveCollection.open<Page>(BUCKET, ["title_content"], transport);
    void live.patch("p1", { title_content: [{ text: "h" }] }, { base: { title_content: [] } });
    // Someone's X arrived in between: this change started from other words.
    void live.patch("p1", { title_content: [{ text: "Xhe" }] }, { base: { title_content: [{ text: "Xh" }] } });
    await vi.waitFor(() => expect(transport.commits).toHaveLength(1));
    expect(transport.commits[0].op).toMatchObject({ patch: { title_content: [{ text: "h" }] } });
    await vi.waitFor(async () => expect(await outbox.list(BUCKET)).toHaveLength(2));
    await live.close();
    await vi.waitFor(() => expect(transport.commits).toHaveLength(2));
    for (const row of await outbox.list(BUCKET)) await outbox.remove(row.opId);
  });

  it("writes to different records go in the order they were made", async () => {
    Object.assign(COALESCE, { quietMs: 60_000, maxMs: 60_000 });
    const transport = silent();
    const live = await LocalLiveCollection.open<Page>(BUCKET, ["title_content"], transport);
    void live.put("b", page("second"));
    void live.put("a", page("first"));
    void live.patch("b", { icon: "x" });
    await live.close();
    await vi.waitFor(() => expect(transport.commits).toHaveLength(2));
    expect(transport.commits.map((commit) => (commit.op as { value: Page }).value.title_content[0])).toEqual([{ text: "second" }, { text: "first" }]);
    for (const row of await outbox.list(BUCKET)) await outbox.remove(row.opId);
  });

  it("the longest a write waits while typing goes on is maxMs", async () => {
    Object.assign(COALESCE, { quietMs: 40, maxMs: 120 });
    const server = new FakeServer();
    const live = await start(server);
    await live.put("p1", page(""));
    const before = writesTo(server).length;
    let shown = "";
    for (let i = 0; i < 12; i += 1) {
      const base = [{ text: shown }];
      shown += "x";
      void live.patch("p1", { title_content: [{ text: shown }] }, { base: { title_content: base } });
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await vi.waitFor(() => expect(server.records.get("pages|p1")?.value).toMatchObject({ title_content: [{ text: shown }] }));
    const sent = writesTo(server).length - before;
    expect(sent).toBeGreaterThan(1);
    expect(sent).toBeLessThan(12);
  });
});
