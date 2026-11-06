import { db, done, settled, type StoredFileBytes } from "./db";
import { isRemote, sdkConfig } from "./config";
import { sharingOn } from "./remote-spaces";
import { personalScope, spaceScope } from "./identity";

/* File bytes, kept in IndexedDB beside the records: the person's own, or a
   space's bucket's. Shown through object URLs, one per file however many
   views draw it, let go when the last view is done. */

/** The bytes on screen: `url` at once when this tab already has them, else
 *  once `ready` answers. Held until `release()`. */
export interface FileUrl {
  readonly url: string | null;
  readonly ready: Promise<string>;
  release(): void;
}

const notFound = (path: string) => Object.assign(new Error(`There is no file ${path}`), { code: "not_found", retryable: false });

async function writeBytes(scope: string, path: string, bytes: Blob, type: string): Promise<void> {
  const database = await db();
  const transaction = database.transaction("files", "readwrite");
  transaction.objectStore("files").put({ key: `${scope}|${path}`, blob: bytes, type } satisfies StoredFileBytes);
  await settled(transaction);
}

async function readBytes(scope: string, path: string): Promise<Blob> {
  const database = await db();
  const found = await done(database.transaction("files").objectStore("files").get(`${scope}|${path}`)) as StoredFileBytes | undefined;
  if (found) return found.blob;
  if (!isRemote() || !(scope.startsWith("personal:") || (sharingOn() && scope.startsWith("space:")))) throw notFound(path);
  // Not here yet: the server has it, or will once its uploader is back.
  let response: Response;
  try {
    response = await fetch(fileAddress(scope, path), { credentials: "include" });
  } catch {
    throw Object.assign(new Error(`Could not reach the server for ${path}`), { retryable: true });
  }
  if (response.status === 404) throw notFound(path);
  if (!response.ok) throw Object.assign(new Error(`The server could not give ${path}`), { retryable: response.status >= 500 });
  const blob = await response.blob();
  await writeBytes(scope, path, blob, blob.type);
  return blob;
}

const fileAddress = (scope: string, path: string) =>
  `${sdkConfig().url}/api/files/${encodeURIComponent(scope)}/${path.split("/").map(encodeURIComponent).join("/")}`;

interface WaitingFile {
  key: string;
  scope: string;
  path: string;
  type: string;
  blob: Blob;
}

/** Bytes kept here and owed to the server, in its queue until it has them. */
async function owe(scope: string, path: string, blob: Blob, type: string): Promise<void> {
  const database = await db();
  const transaction = database.transaction("outbox_files", "readwrite");
  transaction.objectStore("outbox_files").put({ key: `${scope}|${path}`, scope, path, type, blob } satisfies WaitingFile);
  await settled(transaction);
}

let uploading: Promise<void> | null = null;
let again = false;
let retry: ReturnType<typeof setTimeout> | null = null;
let retryIn = 2_000;

/** Sends every file owed to the server, oldest first. Asked again while it
 *  runs, it goes round once more after; stopped by the network, it tries
 *  again later on its own (2 s, doubling to a minute) — an `online` event
 *  can come while a send begun offline is still failing. */
export function uploadWaitingFiles(): Promise<void> {
  if (!isRemote()) return Promise.resolve();
  if (uploading) {
    again = true;
    return uploading;
  }
  if (retry) clearTimeout(retry);
  retry = null;
  uploading = (async () => {
    try {
      let stuck: boolean;
      do {
        again = false;
        stuck = await uploadOnce();
      } while (again);
      if (!stuck) {
        retryIn = 2_000;
        return;
      }
      retry = setTimeout(() => void uploadWaitingFiles(), retryIn);
      retryIn = Math.min(60_000, retryIn * 2);
    } finally {
      uploading = null;
    }
  })();
  return uploading;
}

/** One pass over the queue: whether the network stopped it. */
async function uploadOnce(): Promise<boolean> {
  const database = await db();
  const waiting = await done(database.transaction("outbox_files").objectStore("outbox_files").getAll()) as WaitingFile[];
  for (const file of waiting) {
    let response: Response;
    try {
      response = await fetch(fileAddress(file.scope, file.path), {
        method: "PUT", body: file.blob, headers: { "Content-Type": file.type || "application/octet-stream" }, credentials: "include",
      });
    } catch {
      return true;
    }
    if (!response.ok && response.status !== 413) return true;
    const transaction = database.transaction("outbox_files", "readwrite");
    transaction.objectStore("outbox_files").delete(file.key);
    await settled(transaction);
  }
  return false;
}

interface Shown {
  views: number;
  url: string | null;
  ready: Promise<string>;
}

const shown = new Map<string, Shown>();

function urlOf(scope: string, path: string): FileUrl {
  const key = `${scope}|${path}`;
  let entry = shown.get(key);
  if (!entry) {
    const created: Shown = { views: 0, url: null, ready: Promise.resolve("") };
    created.ready = readBytes(scope, path).then((blob) => {
      created.url = URL.createObjectURL(blob);
      return created.url;
    });
    // A file not there yet is asked again next time, not remembered missing.
    created.ready.catch(() => {
      if (shown.get(key) === created) shown.delete(key);
    });
    shown.set(key, created);
    entry = created;
  }
  const held = entry;
  held.views += 1;
  let released = false;
  return {
    get url() {
      return held.url;
    },
    ready: held.ready,
    release() {
      if (released) return;
      released = true;
      held.views -= 1;
      if (held.views > 0) return;
      if (shown.get(key) === held) shown.delete(key);
      void held.ready.then((url) => URL.revokeObjectURL(url)).catch(() => undefined);
    },
  };
}

/** How many object URLs are held: tests only. */
export const heldUrlCount = () => shown.size;

export interface Bucket {
  write(path: string, bytes: Blob, options?: { contentType?: string }): Promise<void>;
  read(path: string): Promise<Blob>;
  url(path: string): FileUrl;
}

export const files = {
  async write(path: string, bytes: Blob, options: { mediaType?: string } = {}): Promise<void> {
    const type = options.mediaType ?? bytes.type;
    await writeBytes(personalScope(), path, bytes, type);
    if (!isRemote()) return;
    await owe(personalScope(), path, bytes, type);
    void uploadWaitingFiles();
  },
  read(path: string): Promise<Blob> {
    return readBytes(personalScope(), path);
  },
  url(path: string): FileUrl {
    return urlOf(personalScope(), path);
  },
  bucket(name: string) {
    return {
      in(spaceId: string): Bucket {
        const scope = `${spaceScope(spaceId)}|bucket:${name}`;
        return {
          async write(path, bytes, options = {}) {
            const type = options.contentType ?? bytes.type;
            await writeBytes(scope, path, bytes, type);
            // Shared on the server (spec S5c): sent there like one's own.
            if (!isRemote() || !sharingOn()) return;
            await owe(scope, path, bytes, type);
            void uploadWaitingFiles();
          },
          read: (path) => readBytes(scope, path),
          url: (path) => urlOf(scope, path),
        };
      },
    };
  },
};
