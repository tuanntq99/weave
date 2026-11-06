import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Change, WriteMessage } from "@notes/sync-protocol";

const NOW = "2026-11-05T00:00:00.000Z";
const page = (title: string, extra: Record<string, unknown> = {}) => ({
  id: "p1", title_content: [{ text: title }], icon: "", kind: "document",
  created_at: NOW, updated_at: NOW, created_by: "Ada", updated_by: "Ada", ...extra,
});
let names = 0;
const scope = () => env.SCOPE.getByName(`personal:u_test${++names}`);
const put = (opId: string, value: Record<string, unknown>, id = "p1"): WriteMessage =>
  ({ t: "write", opId, collection: "pages", id, action: "put", value });

describe("ScopeDO", () => {
  it("apply stores a put and answers seq 1", async () => {
    const stub = scope();
    const answer = await stub.apply(put("o1", page("Plans")));
    expect(answer).toEqual({ t: "ack", opId: "o1", seq: 1, value: page("Plans") });
    expect(await stub.head()).toBe(1);
  });

  it("a resent opId gets its first ack back", async () => {
    const stub = scope();
    const first = await stub.apply(put("o1", page("Plans")));
    const again = await stub.apply(put("o1", page("Something else")));
    expect(again).toEqual(first);
    expect(await stub.head()).toBe(1);
  });

  it("a patch with base merges with what is stored", async () => {
    const stub = scope();
    await stub.apply(put("o1", page("hello world")));
    const base = { title_content: [{ text: "hello world" }] };
    await stub.apply({ t: "write", opId: "o2", collection: "pages", id: "p1", action: "patch", patch: { title_content: [{ text: "hello brave world" }] }, base });
    const last = await stub.apply({ t: "write", opId: "o3", collection: "pages", id: "p1", action: "patch", patch: { title_content: [{ text: "hello world!" }] }, base });
    expect(last).toMatchObject({ t: "ack", seq: 3, value: { title_content: [{ text: "hello brave world!" }] } });
  });

  it("delete leaves a tombstone that since() reports as null", async () => {
    const stub = scope();
    await stub.apply(put("o1", page("Plans")));
    await stub.apply({ t: "write", opId: "o2", collection: "pages", id: "p1", action: "delete" });
    expect(await stub.since(0)).toEqual({ head: 2, reset: false, changes: [{ seq: 2, collection: "pages", id: "p1", value: null }] });
  });

  it("a value over 1 MiB is rejected too_large and stores nothing", async () => {
    const stub = scope();
    const answer = await stub.apply(put("o1", page("x".repeat(1024 * 1024 + 1))));
    expect(answer).toMatchObject({ t: "reject", opId: "o1", code: "too_large" });
    expect(await stub.head()).toBe(0);
  });

  it("an invalid record is rejected bad_request", async () => {
    const stub = scope();
    const answer = await stub.apply(put("o1", { id: "p1", kind: "folder" }));
    expect(answer).toMatchObject({ t: "reject", code: "bad_request" });
    expect(await stub.head()).toBe(0);
  });

  it("since(cursor) answers only later changes, one row per record", async () => {
    const stub = scope();
    await stub.apply(put("o1", page("a")));
    await stub.apply(put("o2", page("b"), "p2"));
    await stub.apply(put("o3", page("c")));
    // RPC types cannot carry `unknown`; what comes back is plain JSON.
    const later = await stub.since(1) as unknown as { head: number; changes: Change[] };
    expect(later.head).toBe(3);
    expect(later.changes.map((change) => [change.id, change.seq])).toEqual([["p2", 2], ["p1", 3]]);
  });

  it("a cursor ahead of the head (the scope was restored to earlier) is told to reset", async () => {
    const stub = scope();
    await stub.apply(put("o1", page("a")));
    expect(await stub.since(5)).toMatchObject({ head: 1, reset: true });
    expect(await stub.since(1)).toMatchObject({ head: 1, reset: false });
  });
});
