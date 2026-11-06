import type { Op } from "@notes/sync-protocol";
import { isRemote } from "./config";
import { announce, db, done, nextRev, settled, TAB_ID, type StoredFileBytes, type StoredRecord } from "./db";
import { uploadWaitingFiles } from "./files";
import { me } from "./identity";
import { outbox, type OutboxEntry } from "./outbox";
import { transportFor } from "./transport";

/* Everything this browser keeps for Notes, as one JSON file, and back. The
   file is the person's safety net while their data lives in the browser
   alone: it holds every record of every scope, every file's bytes (base64)
   and the people and spaces this browser knows.

   A file exported as someone else (another `?as=`, another account) comes
   back as the person importing it: its own scope becomes theirs.

   With a sync server, what the import brings to a scope the server keeps
   is a write like any other: put in the outbox and sent, shown once the
   server has it; its files are owed to the server as files.write's are. */

const FORMAT = "notes-backup";
const VERSION = 1;
const STORES = ["records", "files", "meta"] as const;

interface BackupFile {
  format: typeof FORMAT;
  version: typeof VERSION;
  exportedAt: string;
  user: { id: string; handle: string };
  records: Array<{ bucket: string; id: string; value: Record<string, unknown> }>;
  files: Array<{ key: string; type: string; base64: string }>;
  meta: Array<{ key: string } & Record<string, unknown>>;
}

const badBackup = (why: string) => Object.assign(new Error(`This is not a Weave backup: ${why}`), { code: "bad_backup", retryable: false });

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function base64Of(bytes: Uint8Array): string {
  // In chunks of a multiple of three bytes, so no chunk but the last is
  // padded and the joined text is one base64 string.
  const CHUNK = 3 << 18;
  let out = "";
  for (let start = 0; start < bytes.length; start += CHUNK) {
    let binary = "";
    const chunk = bytes.subarray(start, Math.min(bytes.length, start + CHUNK));
    for (let at = 0; at < chunk.length; at += 0x8000) binary += String.fromCharCode(...chunk.subarray(at, at + 0x8000));
    out += btoa(binary);
  }
  return out;
}

function bytesOf(base64: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(base64);
  } catch {
    throw badBackup("a file's bytes are not base64");
  }
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);
  return bytes;
}

function parse(text: string): BackupFile {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw badBackup("it is not JSON");
  }
  if (!isObject(value) || value.format !== FORMAT) throw badBackup("its format is not notes-backup");
  if (value.version !== VERSION) throw badBackup(`version ${String(value.version)} is not one this Weave reads`);
  const { user, records, files, meta } = value;
  if (!isObject(user) || typeof user.id !== "string") throw badBackup("it names no person");
  if (!Array.isArray(records) || !Array.isArray(files) || !Array.isArray(meta)) throw badBackup("it is missing records, files or meta");
  for (const row of records) {
    if (!isObject(row) || typeof row.bucket !== "string" || typeof row.id !== "string" || !isObject(row.value)) throw badBackup("a record is malformed");
  }
  for (const row of files) {
    if (!isObject(row) || typeof row.key !== "string" || typeof row.type !== "string" || typeof row.base64 !== "string") throw badBackup("a file is malformed");
  }
  for (const row of meta) {
    if (!isObject(row) || typeof row.key !== "string") throw badBackup("a person or space is malformed");
  }
  return value as unknown as BackupFile;
}

async function exportAll(): Promise<Blob> {
  const database = await db();
  const transaction = database.transaction([...STORES]);
  const [records, stored, meta] = await Promise.all([
    done(transaction.objectStore("records").getAll()) as Promise<StoredRecord[]>,
    done(transaction.objectStore("files").getAll()) as Promise<StoredFileBytes[]>,
    done(transaction.objectStore("meta").getAll()) as Promise<Array<{ key: string }>>,
  ]);
  const user = me();
  const head: Omit<BackupFile, "files"> = {
    format: FORMAT,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    user: { id: user.id, handle: user.handle },
    records: records.map(({ bucket, id, value }) => ({ bucket, id, value })),
    meta,
  };
  // The file is built as a Blob, one file's bytes at a time, so no string
  // ever holds the whole export: each file's base64 goes into the Blob and
  // is let go before the next is read.
  const opening = JSON.stringify(head);
  let blob = new Blob([`${opening.slice(0, -1)},"files":[`]);
  for (const [index, file] of stored.entries()) {
    const base64 = base64Of(new Uint8Array(await file.blob.arrayBuffer()));
    const entry = `${index ? "," : ""}{"key":${JSON.stringify(file.key)},"type":${JSON.stringify(file.type)},"base64":"`;
    blob = new Blob([blob, entry, base64, '"}']);
  }
  return new Blob([blob, "]}"], { type: "application/json" });
}

async function importAll(file: Blob, mode: "merge" | "replace"): Promise<{ records: number; files: number }> {
  const backupFile = parse(await file.text());
  const from = `personal:${backupFile.user.id}|`;
  const to = `personal:${me().id}|`;
  const own = (key: string) => (key.startsWith(from) ? to + key.slice(from.length) : key);

  // Everything is read and decoded before anything is written: a file that
  // turns out bad leaves the browser as it was.
  const records: StoredRecord[] = backupFile.records.map(({ bucket, id, value }) => {
    const mine = own(`${bucket}|`).slice(0, -1);
    return { key: `${mine}|${id}`, bucket: mine, id, value };
  });
  const stored: StoredFileBytes[] = backupFile.files.map(({ key, type, base64 }) => ({
    key: own(key), type, blob: new Blob([bytesOf(base64) as BlobPart], { type }),
  }));
  // The exporter's place in each space becomes the importer's, or every
  // space would belong to someone who is not here.
  const fromId = backupFile.user.id;
  const toId = me().id;
  const meta = backupFile.meta.map((row) => {
    if (fromId === toId || !row.key.startsWith("space:") || !isObject(row.members)) return row;
    const members = { ...row.members };
    if (!(fromId in members) || toId in members) return row;
    members[toId] = members[fromId];
    delete members[fromId];
    return { ...row, members };
  });

  const queued = (bucket: string) => transportFor(bucket).queued;
  const owedFile = (key: string) => isRemote() && key.startsWith("personal:");
  const database = await db();
  const transaction = database.transaction([...STORES, "revs", "outbox", "outbox_files"], "readwrite");
  const recordStore = transaction.objectStore("records");
  const fileStore = transaction.objectStore("files");
  const metaStore = transaction.objectStore("meta");
  const before = await done(recordStore.getAll()) as StoredRecord[];
  const had = {
    records: new Set(before.map((row) => row.key)),
    files: new Set((await done(fileStore.getAllKeys())).map(String)),
    meta: new Set((await done(metaStore.getAllKeys())).map(String)),
  };
  if (mode === "replace") {
    // A server's scope is changed by writes to it, below, not here.
    for (const row of before) if (!queued(row.bucket)) recordStore.delete(row.key);
    fileStore.clear();
    metaStore.clear();
  }
  const keep = (set: Set<string>, key: string) => mode === "replace" || !set.has(key);
  const written = { records: records.filter((row) => keep(had.records, row.key)), files: stored.filter((row) => keep(had.files, row.key)) };

  // Every change gets its bucket's next revision, so each tab takes it in.
  const changes = new Map<string, Array<{ id: string; value: Record<string, unknown> | null; rev: number }>>();
  const change = async (bucket: string, id: string, value: Record<string, unknown> | null) => {
    const rev = await nextRev(transaction, bucket);
    const list = changes.get(bucket) ?? [];
    list.push({ id, value, rev });
    changes.set(bucket, list);
    return rev;
  };
  const sending: OutboxEntry[] = [];
  const send = (bucket: string, id: string, op: Op) => {
    const entry = { bucket, id, opId: crypto.randomUUID(), op };
    transaction.objectStore("outbox").add(entry);
    sending.push(entry);
  };
  if (mode === "replace") {
    const kept = new Set(records.map((row) => row.key));
    for (const row of before) {
      if (kept.has(row.key)) continue;
      if (queued(row.bucket)) send(row.bucket, row.id, { action: "delete" });
      else await change(row.bucket, row.id, null);
    }
  }
  for (const row of written.records) {
    if (queued(row.bucket)) send(row.bucket, row.id, { action: "put", value: row.value });
    else recordStore.put({ ...row, rev: await change(row.bucket, row.id, row.value) });
  }
  for (const row of written.files) {
    fileStore.put(row);
    if (owedFile(row.key)) {
      const split = row.key.indexOf("|");
      transaction.objectStore("outbox_files").put({ key: row.key, scope: row.key.slice(0, split), path: row.key.slice(split + 1), type: row.type, blob: row.blob });
    }
  }
  for (const row of meta) if (keep(had.meta, row.key)) metaStore.put(row);
  await settled(transaction);

  // Every tab's live collections take in what came, and what replace took away.
  for (const [bucket, list] of changes) announce({ type: "records", bucket, changes: list, from: TAB_ID });
  announce({ type: "meta", from: TAB_ID });

  // The server's answers are told to every tab, as the server stored them.
  for (const entry of sending) {
    void transportFor(entry.bucket).commit(entry.bucket, entry.id, entry.op, entry.opId).then(
      async ({ value, rev }) => {
        await outbox.remove(entry.opId);
        announce({ type: "records", bucket: entry.bucket, changes: [{ id: entry.id, value: value as Record<string, unknown> | null, rev }], from: TAB_ID });
      },
      () => outbox.remove(entry.opId).catch(() => undefined),
    );
  }
  if (written.files.some((row) => owedFile(row.key))) void uploadWaitingFiles();

  return { records: written.records.length, files: written.files.length };
}

export const backup = { exportAll, importAll };
