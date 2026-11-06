/* Notes kept its data in a database named `weave-local` before the SDK was
   renamed. The first time a browser opens `notes`, whatever that old
   database holds is copied in, once, and the old one is deleted. Nothing is
   copied over data `notes` already has. */

const LEGACY = "weave-local";
const STORES = ["records", "files", "meta"] as const;

const request = <T>(req: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

async function legacyExists(): Promise<boolean> {
  if (typeof indexedDB.databases !== "function") return false;
  return (await indexedDB.databases()).some((info) => info.name === LEGACY);
}

function openLegacy(): Promise<IDBDatabase | null> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(LEGACY);
    // Found missing after all: nothing to copy, and nothing to leave behind.
    req.onupgradeneeded = () => req.transaction?.abort();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => (req.error?.name === "AbortError" ? resolve(null) : reject(req.error));
  });
}

async function isEmpty(target: IDBDatabase): Promise<boolean> {
  const transaction = target.transaction([...STORES]);
  const counts = await Promise.all(STORES.map((name) => request(transaction.objectStore(name).count())));
  return counts.every((count) => count === 0);
}

/** Copies the old database into `target`, once. */
export async function migrateLegacy(target: IDBDatabase): Promise<"migrated" | "skipped" | "none"> {
  if (!(await legacyExists())) return "none";
  const legacy = await openLegacy();
  if (!legacy) return "none";
  try {
    if (!(await isEmpty(target))) {
      console.warn("[notes] Kept the old weave-local database: notes already holds data.");
      return "skipped";
    }
    const present = STORES.filter((name) => legacy.objectStoreNames.contains(name));
    const read = legacy.transaction(present);
    const rows = await Promise.all(present.map((name) => request(read.objectStore(name).getAll())));
    const write = target.transaction([...STORES], "readwrite");
    present.forEach((name, index) => {
      for (const row of rows[index]) write.objectStore(name).put(row);
    });
    await new Promise<void>((resolve, reject) => {
      write.oncomplete = () => resolve();
      write.onerror = () => reject(write.error);
      write.onabort = () => reject(write.error ?? new Error("The copy was abandoned"));
    });
  } finally {
    legacy.close();
  }
  // Another tab may still hold the old database open: its deletion then
  // finishes when that tab lets go, and nothing waits for it here.
  await new Promise<void>((resolve) => {
    const deletion = indexedDB.deleteDatabase(LEGACY);
    deletion.onsuccess = () => resolve();
    deletion.onerror = () => resolve();
    deletion.onblocked = () => {
      console.warn("[notes] The old weave-local database is deleted once its other tabs close.");
      resolve();
    };
  });
  return "migrated";
}
