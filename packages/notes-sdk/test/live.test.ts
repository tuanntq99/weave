import { describe, expect, it, vi } from "vitest";
import { announce, db } from "../src/db";
import { LocalLiveCollection } from "../src/live";

type Row = { title?: unknown; n?: number; nested?: Record<string, unknown> };
const open = () => LocalLiveCollection.open<Row>("personal:u_ada|pages", ["title"]);

describe("LocalLiveCollection", () => {
  it("shows a write at once and keeps it once stored", async () => {
    const live = await open();
    const writing = live.put("p1", { n: 1 });
    expect(live.get("p1")).toEqual({ n: 1 });
    await writing;
    await live.close();
    const again = await open();
    expect(again.records).toEqual([{ id: "p1", value: { n: 1 } }]);
  });

  it("patches field by field, null removing one", async () => {
    const live = await open();
    await live.put("p1", { n: 1, nested: { a: 1, b: 2 } });
    await live.patch("p1", { nested: { a: null, c: 3 } });
    expect(live.get("p1")).toEqual({ n: 1, nested: { b: 2, c: 3 } });
    await live.delete("p1");
    expect(live.get("p1")).toBeUndefined();
    expect((await open()).records).toEqual([]);
  });

  it("tells subscribers of changes, and at once unless asked not to", async () => {
    const live = await open();
    const now = vi.fn();
    const later = vi.fn();
    live.subscribe(now);
    live.subscribe(later, { immediate: false });
    expect(now).toHaveBeenCalledTimes(1);
    expect(later).not.toHaveBeenCalled();
    await live.put("p1", { n: 1 });
    expect(later).toHaveBeenCalled();
  });

  it("shows another tab's writes, and merges two people's words", async () => {
    const ada = await open();
    const grace = await open();
    await ada.put("p1", { title: [{ text: "hello world" }] });
    expect(grace.get("p1")).toEqual({ title: [{ text: "hello world" }] });

    // Both start from "hello world"; each writes their own change.
    const base = { title: [{ text: "hello world" }] };
    await Promise.all([
      ada.patch("p1", { title: [{ text: "hello brave world" }] }, { base }),
      grace.patch("p1", { title: [{ text: "hello world!" }] }, { base }),
    ]);
    const expected = { title: [{ text: "hello brave world!" }] };
    expect(ada.get("p1")).toEqual(expected);
    expect(grace.get("p1")).toEqual(expected);
    expect((await open()).get("p1")).toEqual(expected);
  });

  it("keeps a tab's own write on screen over another's until it lands", async () => {
    const ada = await open();
    const grace = await open();
    await ada.put("p1", { n: 1 });
    const mine = grace.patch("p1", { n: 3 });
    expect(grace.get("p1")).toEqual({ n: 3 });
    await mine;
    expect(ada.get("p1")).toEqual({ n: 3 });
  });

  it("never hides another's words while its own are on their way", async () => {
    const ada = await open();
    const grace = await open();
    await ada.put("p1", { title: [{ text: "hello world" }] });
    const base = { title: [{ text: "hello world" }] };
    const graceWriting = grace.patch("p1", { title: [{ text: "[g] hello world" }] }, { base });
    await ada.patch("p1", { title: [{ text: "hello world [a]" }] }, { base });
    expect(grace.get("p1")).toEqual({ title: [{ text: "[g] hello world [a]" }] });
    await graceWriting;
    expect(grace.get("p1")).toEqual({ title: [{ text: "[g] hello world [a]" }] });
    expect(ada.get("p1")).toEqual({ title: [{ text: "[g] hello world [a]" }] });
  });

  it("ignores a late message older than what it already holds", async () => {
    const live = await open();
    await live.put("p1", { n: 1 });
    await live.put("p1", { n: 2 });
    announce({ type: "records", bucket: "personal:u_ada|pages", changes: [{ id: "p1", value: { n: 1 }, rev: 1 }], from: "tab_other" });
    expect(live.get("p1")).toEqual({ n: 2 });
  });

  it("still takes a newer message from another tab", async () => {
    const live = await open();
    await live.put("p1", { n: 1 });
    announce({ type: "records", bucket: "personal:u_ada|pages", changes: [{ id: "p1", value: { n: 3 }, rev: 9 }], from: "tab_other" });
    expect(live.get("p1")).toEqual({ n: 3 });
  });

  it("reads records stored before revisions as revision 0", async () => {
    const database = await db();
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("records", "readwrite");
      transaction.objectStore("records").put({ key: "personal:u_ada|pages|p1", bucket: "personal:u_ada|pages", id: "p1", value: { n: 1 } });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
    const live = await open();
    expect(live.get("p1")).toEqual({ n: 1 });
    announce({ type: "records", bucket: "personal:u_ada|pages", changes: [{ id: "p1", value: { n: 9 }, rev: 1 }], from: "tab_other" });
    expect(live.get("p1")).toEqual({ n: 9 });
  });

  it("refuses writes once closed", async () => {
    const live = await open();
    await live.close();
    await expect(live.put("p1", { n: 1 })).rejects.toThrow();
  });
});
