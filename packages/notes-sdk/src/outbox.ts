import type { Op } from "@notes/sync-protocol";
import { db, done, settled } from "./db";

/* Writes made and not yet answered by the server, kept in IndexedDB in the
   order they were made: shown over what is stored when a tab opens, and
   sent again under the same op ids, so the server applies each once. */

export interface OutboxEntry {
  n?: number;
  bucket: string;
  id: string;
  opId: string;
  op: Op;
}

export const outbox = {
  async add(entry: OutboxEntry): Promise<number> {
    const database = await db();
    const transaction = database.transaction("outbox", "readwrite");
    const n = await done(transaction.objectStore("outbox").add(entry)) as number;
    await settled(transaction);
    return n;
  },
  async list(bucket: string): Promise<OutboxEntry[]> {
    const database = await db();
    const rows = await done(database.transaction("outbox").objectStore("outbox").index("bucket").getAll(bucket)) as OutboxEntry[];
    return rows.sort((left, right) => (left.n ?? 0) - (right.n ?? 0));
  },
  /** A write not yet sent, changed in place: the same id, the same place. */
  async replace(opId: string, op: Op): Promise<void> {
    const database = await db();
    const transaction = database.transaction("outbox", "readwrite");
    const store = transaction.objectStore("outbox");
    const key = await done(store.index("opId").getKey(opId));
    if (key !== undefined) {
      const entry = await done(store.get(key)) as OutboxEntry;
      store.put({ ...entry, op });
    }
    await settled(transaction);
  },
  async remove(opId: string): Promise<void> {
    const database = await db();
    const transaction = database.transaction("outbox", "readwrite");
    const store = transaction.objectStore("outbox");
    const key = await done(store.index("opId").getKey(opId));
    if (key !== undefined) store.delete(key);
    await settled(transaction);
  },
  /** How many writes wait, across every scope. */
  async count(): Promise<number> {
    const database = await db();
    return await done(database.transaction("outbox").objectStore("outbox").count()) as number;
  },
};
