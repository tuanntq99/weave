import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { WriteMessage } from "@notes/sync-protocol";
import type { ScopeDO } from "../src/scope-do";

/* The free tier counts SQLite rows written (indexes included): a write
   should cost as few as it can (spec S4). */

const DAY = 24 * 60 * 60 * 1000;
const NOW = "2026-11-05T00:00:00.000Z";
const page = (title: string) => ({
  id: "p1", title_content: [{ text: title }], icon: "", kind: "document",
  created_at: NOW, updated_at: NOW, created_by: "Ada", updated_by: "Ada",
});
let names = 0;
const stubOf = () => env.SCOPE.getByName(`personal:u_rows${(++names).toString().padStart(12, "0")}`);
const put = (opId: string, title: string): WriteMessage => ({ t: "write", opId, collection: "pages", id: "p1", action: "put", value: page(title) });

/** Rows written by `run`, counted over every statement it makes. */
async function rowsWrittenBy(stub: DurableObjectStub<ScopeDO>, run: (instance: ScopeDO) => Promise<unknown>): Promise<number> {
  return runInDurableObject(stub, async (instance) => {
    const sql = (instance as unknown as { sql: SqlStorage }).sql;
    const exec = sql.exec.bind(sql);
    const cursors: Array<{ rowsWritten: number }> = [];
    (sql as { exec: unknown }).exec = (...args: Parameters<SqlStorage["exec"]>) => {
      const cursor = exec(...args);
      cursors.push(cursor);
      return cursor;
    };
    try {
      await run(instance);
    } finally {
      (sql as { exec: unknown }).exec = exec;
    }
    return cursors.reduce((sum, cursor) => sum + cursor.rowsWritten, 0);
  });
}

describe("rows written", () => {
  it("a change to a record writes at most 3 rows", async () => {
    const stub = stubOf();
    await stub.apply(put("o1", "one"));
    const rows = await rowsWrittenBy(stub, (instance) => instance.apply(put("o2", "two")));
    expect(rows).toBeLessThanOrEqual(3);
    expect(await stub.head()).toBe(2);
  });

  it("the head never goes back when the newest record was a tombstone cleaned away", async () => {
    const stub = stubOf();
    await stub.apply(put("o1", "one"));
    await stub.apply({ t: "write", opId: "o2", collection: "pages", id: "p1", action: "delete" });
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("UPDATE records SET deleted_at = ?", Date.now() - 91 * DAY);
      await state.storage.setAlarm(Date.now());
    });
    await runDurableObjectAlarm(stub);
    expect(await stub.head()).toBe(2);
    const next = await stub.apply({ t: "write", opId: "o3", collection: "pages", id: "p2", action: "put", value: { ...page("new"), id: "p2" } });
    expect(next).toMatchObject({ t: "ack", seq: 3 });
  });

  it("applied ops kept in the old table are carried into the new one", async () => {
    const stub = stubOf();
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec("DROP TABLE applied_ops");
      sql.exec("CREATE TABLE applied_ops (op_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, value TEXT, at INTEGER NOT NULL)");
      sql.exec("INSERT INTO applied_ops (op_id, seq, value, at) VALUES ('kept', 4, NULL, ?)", Date.now());
      sql.exec("INSERT INTO meta (key, value) VALUES ('head', '4')");
    });
    // A new instance migrates the table when it starts.
    await runInDurableObject(stub, async (_instance, state) => state.abort()).catch(() => undefined);
    const fresh = env.SCOPE.get(stub.id);
    expect(await fresh.apply({ t: "write", opId: "kept", collection: "pages", id: "p1", action: "delete" })).toEqual({ t: "ack", opId: "kept", seq: 4, value: null });
    await runInDurableObject(fresh, async (_instance, state) => {
      const ddl = state.storage.sql.exec<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'applied_ops'").one().sql;
      expect(ddl).toMatch(/WITHOUT ROWID/i);
    });
  });
});
