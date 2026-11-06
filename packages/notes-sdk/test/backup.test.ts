import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import { backup } from "../src/backup";
import { resetDbForTests } from "../src/db";
import { files } from "../src/files";
import { setMeForTests } from "../src/identity";
import { LocalLiveCollection } from "../src/live";
import { spaces } from "../src/spaces";

type Row = { n: number };
const pages = (scope = "personal:u_ada") => LocalLiveCollection.open<Row>(`${scope}|pages`, []);

/** A browser with nothing in it: its data cleared, as by "Clear site data". */
function resetBrowser(): void {
  globalThis.indexedDB = new IDBFactory();
  resetDbForTests();
}

function randomBytes(size: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(new ArrayBuffer(size));
  for (let at = 0; at < size; at += 65536) crypto.getRandomValues(bytes.subarray(at, Math.min(size, at + 65536)));
  return bytes;
}

describe("backup", () => {
  it("round-trips everything into an empty browser", async () => {
    await (await pages()).put("p1", { n: 1 });
    await files.write("a.txt", new Blob(["hello"], { type: "text/plain" }));
    await spaces.create({ name: "Team" });
    const blob = await backup.exportAll();
    expect(blob.type).toBe("application/json");

    resetBrowser();
    expect(await backup.importAll(blob, "replace")).toEqual({ records: 1, files: 1 });
    expect((await pages()).get("p1")).toEqual({ n: 1 });
    expect(await (await files.read("a.txt")).text()).toBe("hello");
    expect((await spaces.list()).map((space) => space.name)).toEqual(["Team"]);
  });

  it("round-trips an empty browser", async () => {
    const blob = await backup.exportAll();
    const parsed = JSON.parse(await blob.text());
    expect(parsed).toMatchObject({ format: "notes-backup", version: 1, user: { id: "u_ada", handle: "ada" }, records: [], files: [] });
    expect(await backup.importAll(blob, "replace")).toEqual({ records: 0, files: 0 });
  });

  it("merge keeps what is already there", async () => {
    const live = await pages();
    await live.put("p1", { n: 1 });
    await live.put("p2", { n: 2 });
    const blob = await backup.exportAll();
    await live.put("p1", { n: 9 });
    await live.delete("p2");
    expect(await backup.importAll(blob, "merge")).toEqual({ records: 1, files: 0 });
    expect(live.get("p1")).toEqual({ n: 9 });
    expect(live.get("p2")).toEqual({ n: 2 });
  });

  it("rejects a file that is not a notes backup and writes nothing", async () => {
    const live = await pages();
    await live.put("p1", { n: 1 });
    for (const text of ["not json", "{\"format\":\"x\"}", JSON.stringify({ format: "notes-backup", version: 2, records: [], files: [], meta: [] }),
      JSON.stringify({ format: "notes-backup", version: 1, user: { id: "u_ada", handle: "ada" }, records: [{ bucket: 1 }], files: [], meta: [] })]) {
      await expect(backup.importAll(new Blob([text]), "replace")).rejects.toMatchObject({ code: "bad_backup" });
    }
    expect((await pages()).get("p1")).toEqual({ n: 1 });
  });

  it("keeps a 3 MB file byte for byte", async () => {
    const bytes = randomBytes(3 * 1024 * 1024);
    await files.write("big.bin", new Blob([bytes], { type: "application/octet-stream" }));
    const blob = await backup.exportAll();
    resetBrowser();
    await backup.importAll(blob, "replace");
    const back = new Uint8Array(await (await files.read("big.bin")).arrayBuffer());
    expect(back.length).toBe(bytes.length);
    expect(back.every((value, index) => value === bytes[index])).toBe(true);
  });

  it("never holds the whole export in one string", async () => {
    const MB = 1024 * 1024;
    await files.write("one.bin", new Blob([randomBytes(MB)]));
    await files.write("two.bin", new Blob([randomBytes(MB)]));
    const longest = { value: 0 };
    const stringify = JSON.stringify;
    const spy = vi.spyOn(JSON, "stringify").mockImplementation((...args: Parameters<typeof JSON.stringify>) => {
      const out = stringify(...args);
      longest.value = Math.max(longest.value, out?.length ?? 0);
      return out;
    });
    const blob = await backup.exportAll();
    spy.mockRestore();
    // Two files' base64 is about 2.8 MB: no single string may hold both.
    expect(longest.value).toBeLessThan(1.5 * MB);
    expect(blob.size).toBeGreaterThan(2.6 * MB);
    resetBrowser();
    expect(await backup.importAll(blob, "replace")).toEqual({ records: 0, files: 2 });
  });

  it("remaps another person's personal scope", async () => {
    await (await pages()).put("p1", { n: 1 });
    await files.write("a.txt", new Blob(["mine"]));
    const blob = await backup.exportAll();
    setMeForTests("me");
    resetBrowser();
    await backup.importAll(blob, "replace");
    expect((await pages("personal:u_me")).get("p1")).toEqual({ n: 1 });
    expect(await (await files.read("a.txt")).text()).toBe("mine");
  });

  it("gives the importer the exporter's place in their spaces", async () => {
    const { space } = await spaces.create({ name: "Team" });
    await spaces.members.invite(space.id, "grace", "editor");
    const blob = await backup.exportAll();
    setMeForTests("me");
    resetBrowser();
    await backup.importAll(blob, "replace");
    const mine = await spaces.list();
    expect(mine.map((item) => [item.name, item.myRole])).toEqual([["Team", "owner"]]);
    const members = await spaces.members.list(space.id);
    expect(members.map((member) => [member.id, member.role]).sort()).toEqual([["u_grace", "editor"], ["u_me", "owner"]]);
  });

  it("an open tab takes an older value a replace brings back", async () => {
    const live = await pages();
    await live.put("p1", { n: 1 });
    const blob = await backup.exportAll();
    await live.put("p1", { n: 2 });
    await backup.importAll(blob, "replace");
    expect(live.get("p1")).toEqual({ n: 1 });
  });

  it("tells live collections what replace removed", async () => {
    const live = await pages();
    await live.put("p1", { n: 1 });
    const blob = await backup.exportAll();
    await live.put("p2", { n: 2 });
    await backup.importAll(blob, "replace");
    expect(live.get("p1")).toEqual({ n: 1 });
    expect(live.get("p2")).toBeUndefined();
  });
});
