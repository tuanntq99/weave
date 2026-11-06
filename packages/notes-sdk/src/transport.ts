import { commitOp, type Json, type Op } from "@notes/sync-protocol";
import { db, done, nextRev, settled, type StoredRecord } from "./db";

/* Where a write is made. Locally, in this browser's IndexedDB: merged over
   what is stored, given the bucket's next revision, and kept. Remotely
   (remote.ts), by the scope's sync server: then a write waits in the outbox
   (`queued`) until the server answers. */

export interface CommitResult {
  value: Json | null;
  rev: number;
}

export interface Transport {
  /** Whether a write must wait in the outbox until this answers. */
  readonly queued: boolean;
  commit(bucket: string, id: string, op: Op, opId: string): Promise<CommitResult>;
}

export const localTransport: Transport = {
  queued: false,
  async commit(bucket, id, op) {
    const database = await db();
    const transaction = database.transaction(["records", "revs"], "readwrite");
    const store = transaction.objectStore("records");
    const key = `${bucket}|${id}`;
    const found = await done(store.get(key)) as StoredRecord | undefined;
    const value = commitOp(found?.value, op);
    const rev = await nextRev(transaction, bucket);
    if (value) store.put({ key, bucket, id, value, rev } satisfies StoredRecord);
    else store.delete(key);
    await settled(transaction);
    return { value: value ?? null, rev };
  },
};

let choose: (bucket: string) => Transport = () => localTransport;

/** The transport a bucket's writes go through: local unless the SDK is set
 *  up for a server. */
export function transportFor(bucket: string): Transport {
  return choose(bucket);
}

export function setTransports(next: (bucket: string) => Transport): void {
  choose = next;
}
