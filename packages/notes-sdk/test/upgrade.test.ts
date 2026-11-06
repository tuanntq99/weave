import { describe, expect, it } from "vitest";
import { db } from "../src/db";
import { LocalLiveCollection } from "../src/live";

/** The `notes` database as the first SDK made it (version 1): no "revs". */
function openV1(rows: unknown[]): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("notes", 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      database.createObjectStore("records", { keyPath: "key" }).createIndex("bucket", "bucket", { unique: false });
      database.createObjectStore("files", { keyPath: "key" });
      database.createObjectStore("meta", { keyPath: "key" });
      for (const row of rows) request.transaction!.objectStore("records").put(row);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

describe("upgrading the notes database", () => {
  it("keeps a version 1 browser's records", async () => {
    const old = await openV1([{ key: "personal:u_ada|pages|p1", bucket: "personal:u_ada|pages", id: "p1", value: { n: 1 } }]);
    old.close();
    const live = await LocalLiveCollection.open("personal:u_ada|pages", []);
    expect(live.get("p1")).toEqual({ n: 1 });
    await live.put("p1", { n: 2 });
    expect(live.get("p1")).toEqual({ n: 2 });
  });

  it("says so, rather than hanging, while an older tab holds the old version open", async () => {
    const old = await openV1([]);
    old.onversionchange = null;
    const outcome = await Promise.race([
      db().then(() => "opened", (error: { code?: string }) => error.code ?? "failed"),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 1000)),
    ]);
    expect(outcome).toBe("upgrade_blocked");
    old.close();
  });

  it("lets go of its own connection when a newer version asks", async () => {
    const database = await db();
    let closed = false;
    const next = indexedDB.open("notes", 99);
    await new Promise<void>((resolve, reject) => {
      next.onsuccess = () => { closed = true; next.result.close(); resolve(); };
      next.onblocked = () => reject(new Error("blocked by this tab"));
      next.onerror = () => reject(next.error);
    });
    expect(closed).toBe(true);
    expect(database).toBeDefined();
  });
});
