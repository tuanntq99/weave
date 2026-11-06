/* Where everything is kept: one IndexedDB database in this browser, shared by
   every tab of the app. A tab that changes something says so on a
   BroadcastChannel, and the other tabs read it — so two tabs, signed in as
   two people (`?as=`), are two collaborators.

   Stores:
   - records: every record of every collection, of every scope, keyed
     `scope|collection|id` and indexed by `scope|collection`.
   - files: file bytes, keyed `scope|path`.
   - meta: the local people, spaces and memberships. */

import { migrateLegacy } from "./migrate";

const DB_NAME = "notes";
const DB_VERSION = 3;

export interface StoredRecord {
  key: string;
  bucket: string;
  id: string;
  value: Record<string, unknown>;
  /** The bucket's revision when this was stored; none before revisions. */
  rev?: number;
}

export interface StoredFileBytes {
  key: string;
  blob: Blob;
  type: string;
}

let opening: Promise<IDBDatabase> | null = null;

/** The database, opened once a session. */
export function db(): Promise<IDBDatabase> {
  if (!opening) {
    opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains("records")) {
          const records = database.createObjectStore("records", { keyPath: "key" });
          records.createIndex("bucket", "bucket", { unique: false });
        }
        if (!database.objectStoreNames.contains("files")) database.createObjectStore("files", { keyPath: "key" });
        if (!database.objectStoreNames.contains("meta")) database.createObjectStore("meta", { keyPath: "key" });
        // Each bucket's last revision: it only grows, through deletes and
        // imports too, so a tab can tell a late message from a new one.
        if (!database.objectStoreNames.contains("revs")) database.createObjectStore("revs", { keyPath: "bucket" });
        // What a server has not answered yet, in order (outbox.ts); how far
        // each scope has heard from its server; files not uploaded yet.
        if (!database.objectStoreNames.contains("outbox")) {
          const queued = database.createObjectStore("outbox", { keyPath: "n", autoIncrement: true });
          queued.createIndex("bucket", "bucket", { unique: false });
          queued.createIndex("opId", "opId", { unique: true });
        }
        if (!database.objectStoreNames.contains("cursors")) database.createObjectStore("cursors", { keyPath: "scope" });
        if (!database.objectStoreNames.contains("outbox_files")) database.createObjectStore("outbox_files", { keyPath: "key" });
      };
      let blocked = false;
      // Another tab holds an older version open: say so now, rather than
      // wait unseen until that tab goes.
      request.onblocked = () => {
        blocked = true;
        reject(Object.assign(new Error("Weave was updated: close or reload its other tabs, then open it again."), { code: "upgrade_blocked", retryable: true }));
      };
      request.onsuccess = () => {
        const database = request.result;
        if (blocked) {
          database.close();
          return;
        }
        // A newer Notes in another tab needs the database: this one lets go,
        // and opens it afresh next time it is asked.
        database.onversionchange = () => {
          database.close();
          opening = null;
        };
        resolve(database);
      };
      request.onerror = () => reject(request.error);
    }).then(async (database) => {
      // What a browser kept before the rename comes along, once.
      await migrateLegacy(database).catch((error) => console.warn("[notes] Could not copy the old weave-local database", error));
      return database;
    });
    opening.catch(() => { opening = null; });
  }
  return opening;
}

/** The bucket's next revision, taken inside `transaction` (which must
 *  hold the "revs" store for writing). */
export async function nextRev(transaction: IDBTransaction, bucket: string): Promise<number> {
  const revs = transaction.objectStore("revs");
  const found = await done(revs.get(bucket)) as { bucket: string; rev: number } | undefined;
  const rev = (found?.rev ?? 0) + 1;
  revs.put({ bucket, rev });
  return rev;
}

/** Forgets the open database: tests start each case afresh. */
export function resetDbForTests(): void {
  opening = null;
}

export const done = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

export const settled = (transaction: IDBTransaction): Promise<void> => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => reject(transaction.error);
  transaction.onabort = () => reject(transaction.error ?? new Error("The write was abandoned"));
});

/* ── Telling the other tabs, and this one ─────────────────────────────── */

export type HubMessage =
  | { type: "records"; bucket: string; changes: Array<{ id: string; value: Record<string, unknown> | null; rev: number }>; from: string }
  | { type: "meta"; from: string }
  /** A scope's copy here was replaced wholesale (a reset): views read it
   *  again rather than weigh each record's revision. */
  | { type: "reread"; scope: string; from: string }
  | { type: "presence"; spaceId: string; tab: string; userId: string; state: unknown; at: number; from: string }
  | { type: "presence-leave"; spaceId: string; tab: string; from: string }
  | { type: "presence-hello"; spaceId: string; from: string };

/** This tab, as the hub knows it. */
export const TAB_ID = `tab_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

type Listener = (message: HubMessage) => void;
const listeners = new Set<Listener>();
let channel: BroadcastChannel | null = null;

function ensureChannel(): void {
  if (channel || typeof BroadcastChannel === "undefined") return;
  channel = new BroadcastChannel(DB_NAME);
  // In Node (tests) a channel would keep the process alive.
  (channel as BroadcastChannel & { unref?: () => void }).unref?.();
  channel.onmessage = (event: MessageEvent<HubMessage>) => {
    for (const listener of [...listeners]) listener(event.data);
  };
}

/** Says something to every tab, this one included. */
export function announce(message: HubMessage): void {
  ensureChannel();
  for (const listener of [...listeners]) listener(message);
  channel?.postMessage(message);
}

export function listen(listener: Listener): () => void {
  ensureChannel();
  listeners.add(listener);
  return () => listeners.delete(listener);
}
