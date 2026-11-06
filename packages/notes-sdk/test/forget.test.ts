import { describe, expect, it } from "vitest";
import { db } from "../src/db";
import { forgetThisDevice } from "../src/index";
import { LocalLiveCollection } from "../src/live";
import { outbox } from "../src/outbox";

describe("forgetThisDevice", () => {
  it("refuses while something is owed to the server, and touches nothing", async () => {
    const live = await LocalLiveCollection.open<{ n: number }>("personal:u_ada|pages", []);
    await live.put("p1", { n: 1 });
    await outbox.add({ bucket: "personal:u_ada|pages", id: "p2", opId: "o1", op: { action: "delete" } });
    expect(await forgetThisDevice()).toBe("pending");
    expect((await LocalLiveCollection.open<{ n: number }>("personal:u_ada|pages", [])).get("p1")).toEqual({ n: 1 });
  });

  it("deletes this browser's copy when nothing is owed", async () => {
    await db();
    expect(await forgetThisDevice()).toBe("cleared");
    expect((await indexedDB.databases()).map((info) => info.name)).not.toContain("notes");
  });
});
