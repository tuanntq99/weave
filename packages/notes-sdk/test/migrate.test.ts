import { describe, expect, it } from "vitest";
import { db, resetDbForTests } from "../src/db";
import { files } from "../src/files";
import { LocalLiveCollection } from "../src/live";
import { migrateLegacy } from "../src/migrate";

/** A browser that ran Notes before the rename: its `weave-local` database,
 *  with the three stores the old db.ts made. Answers the open connection,
 *  which keeps the database from being deleted until it closes. */
async function seedLegacy(
  records: unknown[],
  stored: unknown[],
  meta: unknown[],
  options: { keepOpen?: boolean } = {},
): Promise<IDBDatabase> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("weave-local", 1);
    request.onupgradeneeded = () => {
      const opened = request.result;
      opened.createObjectStore("records", { keyPath: "key" }).createIndex("bucket", "bucket", { unique: false });
      opened.createObjectStore("files", { keyPath: "key" });
      opened.createObjectStore("meta", { keyPath: "key" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(["records", "files", "meta"], "readwrite");
    for (const row of records) transaction.objectStore("records").put(row);
    for (const row of stored) transaction.objectStore("files").put(row);
    for (const row of meta) transaction.objectStore("meta").put(row);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  if (options.keepOpen) database.onversionchange = null;
  else database.close();
  return database;
}

const names = async () => (await indexedDB.databases()).map((info) => info.name);
const legacyPage = { key: "personal:u_ada|pages|p1", bucket: "personal:u_ada|pages", id: "p1", value: { n: 1 } };

describe("migrating the weave-local database", () => {
  it("copies a legacy browser's records, files and people into notes, then deletes it", async () => {
    await seedLegacy(
      [legacyPage],
      [{ key: "personal:u_ada|a.txt", blob: new Blob(["x"]), type: "text/plain" }],
      [{ key: "user:u_ada", person: { id: "u_ada" } }],
    );
    const live = await LocalLiveCollection.open("personal:u_ada|pages", []);
    expect(live.get("p1")).toEqual({ n: 1 });
    expect(await (await files.read("a.txt")).text()).toBe("x");
    expect(await names()).not.toContain("weave-local");
  });

  it("leaves the legacy db alone when notes already has data", async () => {
    const mine = await LocalLiveCollection.open<{ n: number }>("personal:u_ada|pages", []);
    await mine.put("p9", { n: 9 });
    await seedLegacy([legacyPage], [], []);
    resetDbForTests();
    const live = await LocalLiveCollection.open("personal:u_ada|pages", []);
    expect(live.get("p1")).toBeUndefined();
    expect(live.get("p9")).toEqual({ n: 9 });
    expect(await names()).toContain("weave-local");
  });

  it("is a no-op with no legacy db", async () => {
    expect(await migrateLegacy(await db())).toBe("none");
  });

  it("does not hang when the legacy db cannot be deleted yet", async () => {
    await seedLegacy([legacyPage], [], [], { keepOpen: true });
    const opened = await Promise.race([
      db().then(() => "opened"),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 1000)),
    ]);
    expect(opened).toBe("opened");
    expect((await LocalLiveCollection.open("personal:u_ada|pages", [])).get("p1")).toEqual({ n: 1 });
  });
});
