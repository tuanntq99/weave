import { DurableObject } from "cloudflare:workers";
import {
  commitOp,
  fromWire,
  MAX_ID_LENGTH,
  MAX_MESSAGE_BYTES,
  parseClient,
  RICH_FIELDS,
  SNAPSHOT_BATCH,
  validateRecord,
  type Ack,
  type Change,
  type Collection,
  type FieldLike,
  type Json,
  type Reject,
  type ServerMessage,
  type WriteMessage,
} from "@notes/sync-protocol";
import { RECORD_SHAPES } from "../../schema-fields";
import type { Env } from "./env";

/* One scope's records — a person's own, or (later) a space's — kept in the
   object's SQLite. Writes are taken one at a time: each is merged over what
   is stored, checked against its collection's fields, and given the
   scope's next sequence number. A record keeps one row, its latest; a
   deleted record keeps a tombstone (value NULL) for 90 days, so a client
   coming back can be told it went. An op is remembered by id for 7 days, so
   one sent again gets its first answer back and is never applied twice. */

const DAY_MS = 24 * 60 * 60 * 1000;
const TOMBSTONE_DAYS = 90;
const APPLIED_OP_DAYS = 7;
const BACKUPS_KEPT = 30;

const SHAPES = RECORD_SHAPES as unknown as Record<Collection, Record<string, FieldLike>>;

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

/** What a socket remembers through hibernation (at most 16 KiB): who it is,
 *  which client, and where that client says it is. */
interface Attachment {
  userId: string;
  clientId: string | null;
  state: Json | null;
  /** What the Worker found this person may do here (a viewer: read). Unset
   *  on sockets opened before S5c: their own scope, so write. */
  access?: "read" | "write";
}

const send = (socket: WebSocket, message: ServerMessage) => socket.send(JSON.stringify(message));

export class ScopeDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS records (
          collection TEXT NOT NULL,
          id TEXT NOT NULL,
          value TEXT,
          seq INTEGER NOT NULL,
          deleted_at INTEGER,
          PRIMARY KEY (collection, id)
        );
        CREATE INDEX IF NOT EXISTS records_seq ON records(seq);
        CREATE TABLE IF NOT EXISTS applied_ops (op_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, value TEXT, at INTEGER NOT NULL) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      `);
      // Before S4 the table had a rowid, and so a second row (its key's
      // index) written for every op: carried into one without.
      const ddl = this.sql.exec<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'applied_ops'").toArray()[0]?.sql ?? "";
      if (!/WITHOUT ROWID/i.test(ddl)) {
        ctx.storage.transactionSync(() => {
          this.sql.exec("CREATE TABLE applied_ops_s4 (op_id TEXT PRIMARY KEY, seq INTEGER NOT NULL, value TEXT, at INTEGER NOT NULL) WITHOUT ROWID");
          this.sql.exec("INSERT INTO applied_ops_s4 SELECT op_id, seq, value, at FROM applied_ops");
          this.sql.exec("DROP TABLE applied_ops");
          this.sql.exec("ALTER TABLE applied_ops_s4 RENAME TO applied_ops");
        });
      }
    });
  }

  private metaNumber(key: string): number {
    const row = this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key).toArray()[0];
    return row ? Number(row.value) : 0;
  }

  /** The scope's last sequence number: 0 before any write. It is the
   *  newest record's, read off the seq index — not written with each op —
   *  or, if the newest were tombstones since cleaned away, the floor the
   *  clean-up left in meta, so a seq is never given twice. */
  private currentHead(): number {
    const newest = this.sql.exec<{ seq: number | null }>("SELECT MAX(seq) AS seq FROM records").toArray()[0]?.seq ?? 0;
    return Math.max(newest, this.metaNumber("head"));
  }

  async head(): Promise<number> {
    return this.currentHead();
  }

  /** Takes one write: its ack (the value stored and its seq), or why not. */
  async apply(write: WriteMessage): Promise<Ack | Reject> {
    const done = this.sql.exec<{ seq: number; value: string | null }>("SELECT seq, value FROM applied_ops WHERE op_id = ?", write.opId).toArray()[0];
    if (done) return { t: "ack", opId: write.opId, seq: done.seq, value: done.value === null ? null : JSON.parse(done.value) as Json };
    const reject = (code: Reject["code"], message: string): Reject => ({ t: "reject", opId: write.opId, code, message });
    if (bytes(write) > MAX_MESSAGE_BYTES) return reject("too_large", "The write is larger than 1 MiB.");
    if (!(write.collection in SHAPES) || !write.id || write.id.length > MAX_ID_LENGTH) return reject("bad_request", "No such collection or id.");

    const row = this.sql.exec<{ value: string | null }>("SELECT value FROM records WHERE collection = ? AND id = ?", write.collection, write.id).toArray()[0];
    const stored = row?.value ? JSON.parse(row.value) as Json : undefined;
    const next = commitOp(stored, fromWire(write, RICH_FIELDS[write.collection]));
    if (next) {
      const checked = validateRecord(SHAPES[write.collection], next);
      if (!checked.ok) return reject("bad_request", `${checked.path}: ${checked.reason}`);
      if (bytes(next) > MAX_MESSAGE_BYTES) return reject("too_large", "The record would be larger than 1 MiB.");
    }

    const now = Date.now();
    const text = next ? JSON.stringify(next) : null;
    const seq = this.ctx.storage.transactionSync(() => {
      const seq = this.currentHead() + 1;
      this.sql.exec(
        `INSERT INTO records (collection, id, value, seq, deleted_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (collection, id) DO UPDATE SET value = excluded.value, seq = excluded.seq, deleted_at = excluded.deleted_at`,
        write.collection, write.id, text, seq, text === null ? now : null,
      );
      this.sql.exec("INSERT INTO applied_ops (op_id, seq, value, at) VALUES (?, ?, ?, ?)", write.opId, seq, text, now);
      return seq;
    });
    // The nightly clean-up runs once there is something to clean.
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(now + DAY_MS);
    return { t: "ack", opId: write.opId, seq, value: next ?? null };
  }

  /** Nightly: tombstones past 90 days go (a cursor older than the newest of
   *  them is told to reset), and remembered ops past 7 days. */
  async alarm(): Promise<void> {
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      const gone = this.sql.exec<{ seq: number | null }>(
        "SELECT MAX(seq) AS seq FROM records WHERE value IS NULL AND deleted_at < ?", now - TOMBSTONE_DAYS * DAY_MS,
      ).toArray()[0]?.seq;
      if (gone !== null && gone !== undefined) {
        // The head as it stands, kept before the newest record may go.
        this.sql.exec("INSERT INTO meta (key, value) VALUES ('head', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", String(this.currentHead()));
        this.sql.exec("DELETE FROM records WHERE value IS NULL AND deleted_at < ?", now - TOMBSTONE_DAYS * DAY_MS);
        const horizon = Math.max(this.metaNumber("tombstone_horizon"), gone + 1);
        this.sql.exec("INSERT INTO meta (key, value) VALUES ('tombstone_horizon', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", String(horizon));
      }
      this.sql.exec("DELETE FROM applied_ops WHERE at < ?", now - APPLIED_OP_DAYS * DAY_MS);
    });
    await this.ctx.storage.setAlarm(now + DAY_MS);
  }

  /** Writes the day's backup of this scope to R2 — in the format the app's
   *  Import reads — and keeps the newest 30. Answers the key written. */
  async backup(scope: string, at = Date.now()): Promise<string> {
    const records = this.sql.exec<{ collection: string; id: string; value: string }>(
      "SELECT collection, id, value FROM records WHERE value IS NOT NULL ORDER BY seq",
    ).toArray().map((row) => ({ bucket: `${scope}|${row.collection}`, id: row.id, value: JSON.parse(row.value) as Json }));
    const userId = scope.startsWith("personal:") ? scope.slice("personal:".length) : scope;
    const body = { format: "notes-backup", version: 1, exportedAt: new Date(at).toISOString(), user: { id: userId, handle: "" }, records, files: [], meta: [] };
    const key = `backups/${scope}/${new Date(at).toISOString().slice(0, 10)}.json`;
    await this.env.FILES.put(key, JSON.stringify(body), { httpMetadata: { contentType: "application/json" } });
    const kept = (await this.env.FILES.list({ prefix: `backups/${scope}/` })).objects.map((object) => object.key).sort();
    const old = kept.slice(0, Math.max(0, kept.length - BACKUPS_KEPT));
    if (old.length) await this.env.FILES.delete(old);
    return key;
  }

  /** Brings the scope back to how it was at `at` (within the last 30 days)
   *  the next time the object starts: answers the bookmark of now, which a
   *  second restore can go back to. `restart` then makes it so. */
  async restoreTo(at: number): Promise<{ ok: true; undo: string } | { ok: false; reason: string }> {
    try {
      const bookmark = await this.ctx.storage.getBookmarkForTime(at);
      return { ok: true, undo: await this.ctx.storage.onNextSessionRestoreBookmark(bookmark) };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async restart(): Promise<void> {
    this.ctx.abort();
  }

  /* ── The sync socket ─────────────────────────────────────────────────── */

  /** A client's socket, handed on by the Worker once it has checked who is
   *  asking (`X-Notes-User`): taken so that the object can hibernate. */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
    const userId = request.headers.get("X-Notes-User");
    if (!userId) return new Response("Who is asking?", { status: 401 });
    const access = request.headers.get("X-Notes-Access") === "read" ? "read" : "write";
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ userId, clientId: null, state: null, access } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, data: string | ArrayBuffer): Promise<void> {
    if (typeof data !== "string" || data.length > MAX_MESSAGE_BYTES) return;
    const message = parseClient(data);
    if (!message) {
      console.warn("[notes] Let go of a message that is no message");
      return;
    }
    const attachment = socket.deserializeAttachment() as Attachment;
    switch (message.t) {
      case "ping":
        send(socket, { t: "pong" });
        return;
      case "hello":
        socket.serializeAttachment({ ...attachment, clientId: message.clientId } satisfies Attachment);
        await this.welcome(socket, message.cursor);
        return;
      case "presence":
        socket.serializeAttachment({ ...attachment, state: message.state } satisfies Attachment);
        this.tellPresence();
        return;
      case "write": {
        if (attachment.access === "read") {
          send(socket, { t: "reject", opId: message.opId, code: "forbidden", message: "You may only view this space." });
          return;
        }
        const answer = await this.apply(message);
        send(socket, answer);
        if (answer.t === "ack") {
          const change: Change = { seq: answer.seq, collection: message.collection, id: message.id, value: answer.value };
          for (const other of this.ctx.getWebSockets()) if (other !== socket) send(other, { t: "changes", changes: [change] });
        }
        return;
      }
    }
  }

  /** Closes a person's sockets here: removed from the space (4403, the
   *  client stops), or their role changed (4000, it reconnects and opens
   *  the space again as the new role allows). */
  async disconnect(userId: string, code: number): Promise<void> {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as Attachment | null;
      if (attachment?.userId !== userId) continue;
      try {
        socket.close(code, code === 4403 ? "removed" : "role changed");
      } catch {
        // already closed
      }
    }
  }

  async webSocketClose(socket: WebSocket, code: number, reason: string): Promise<void> {
    // 1005 and 1006 say how it closed and cannot be sent back.
    try {
      socket.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      // already closed
    }
    this.tellPresence(socket);
  }

  /** What a client missed since `cursor`: the changes, 500 to a message —
   *  or, past the tombstones kept, everything there is, as a reset. */
  private async welcome(socket: WebSocket, cursor: number): Promise<void> {
    const missed = await this.since(cursor);
    if (missed.reset) {
      send(socket, { t: "welcome", head: missed.head, reset: true });
      const everything = this.sql.exec<{ seq: number; collection: string; id: string; value: string }>(
        "SELECT seq, collection, id, value FROM records WHERE value IS NOT NULL ORDER BY seq",
      ).toArray().map((row) => ({ seq: row.seq, collection: row.collection as Collection, id: row.id, value: JSON.parse(row.value) as Json }));
      for (let at = 0; at < everything.length || at === 0; at += SNAPSHOT_BATCH) {
        const records = everything.slice(at, at + SNAPSHOT_BATCH);
        send(socket, { t: "snapshot", records, done: at + SNAPSHOT_BATCH >= everything.length });
      }
      return;
    }
    send(socket, { t: "welcome", head: missed.head, reset: false, changes: missed.changes.slice(0, SNAPSHOT_BATCH) });
    for (let at = SNAPSHOT_BATCH; at < missed.changes.length; at += SNAPSHOT_BATCH) {
      send(socket, { t: "changes", changes: missed.changes.slice(at, at + SNAPSHOT_BATCH) });
    }
  }

  /** Who is here, and where each says they are, to every socket. */
  private tellPresence(leaving?: WebSocket): void {
    const sockets = this.ctx.getWebSockets().filter((socket) => socket !== leaving);
    const peers = sockets.flatMap((socket) => {
      const attachment = socket.deserializeAttachment() as Attachment | null;
      return attachment?.clientId ? [{ clientId: attachment.clientId, userId: attachment.userId, state: attachment.state }] : [];
    });
    for (const socket of sockets) send(socket, { t: "presence", peers });
  }

  /** What changed after `cursor`: one row per record, oldest first — or,
   *  for a cursor older than the tombstones kept or ahead of the head, a
   *  reset. */
  async since(cursor: number): Promise<{ head: number; reset: boolean; changes: Change[] }> {
    const head = this.currentHead();
    // Past the tombstones kept — or ahead of the head, as after a restore to
    // an earlier time: what the client holds cannot be brought up to date.
    if (cursor < this.metaNumber("tombstone_horizon") || cursor > head) return { head, reset: true, changes: [] };
    const changes = this.sql.exec<{ seq: number; collection: string; id: string; value: string | null }>(
      "SELECT seq, collection, id, value FROM records WHERE seq > ? ORDER BY seq", cursor,
    ).toArray().map((row) => ({
      seq: row.seq, collection: row.collection as Collection, id: row.id, value: row.value === null ? null : JSON.parse(row.value) as Json,
    }));
    return { head, reset: false, changes };
  }
}
