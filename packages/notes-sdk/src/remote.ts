import { parseServer, PROTOCOL, toWire, type Change, type Json, type Op } from "@notes/sync-protocol";
import { announce, db, done, settled, TAB_ID, type StoredRecord } from "./db";
import { setSyncStatus, tellSyncListeners } from "./sync";
import type { CommitResult, Transport } from "./transport";

/* A scope kept in step with its sync server over one WebSocket (spec S3
   §4–5). What the server stores is written into this browser's IndexedDB —
   each record at its sequence number, which is its revision here — and told
   to every tab; how far the scope has heard is its cursor. A write waits in
   the outbox (live.ts) and here until the server answers it; after a lost
   connection it is sent again under the same op id, so the server applies
   it once. A sign-in that ran out (a 4401 close, or a handshake turned away
   that /api/me then says is not signed in) stops the trying until a reload. */

export interface RemoteOptions {
  /** The server's origin, e.g. https://notes.example.com. */
  url: string;
  WebSocket?: typeof WebSocket;
  /** How long to wait before the `attempt`th reconnect. */
  delays?: (attempt: number) => number;
  clientId?: string;
  /** Whether the sign-in still holds, asked when a socket cannot open: in
   *  front of the server, Access turns a lapsed sign-in away before the
   *  server could say so (the browser sees only a failed handshake). */
  checkSignIn?: () => Promise<boolean>;
}

const PING_MS = 25_000;
const PONG_MS = 10_000;

/** min(30 s, 1 s·2ⁿ), within ±20%. */
export function nextDelay(attempt: number, random = Math.random()): number {
  const base = Math.min(30_000, 1000 * 2 ** attempt);
  return Math.round(base * (0.8 + 0.4 * random));
}

/** Every scope kept in step: the save indicator speaks for all of them. */
const open = new Set<RemoteScope>();
const WORST = ["saved", "saving", "offline"] as const;

function tellAll(): void {
  let worst = 0;
  for (const scope of open) worst = Math.max(worst, WORST.indexOf(scope.status));
  setSyncStatus(WORST[worst]);
}

/** Who is in a scope, as its server says (spec S5c presence). */
export interface Peer {
  clientId: string;
  userId: string;
  state: Json | null;
}

interface Waiting {
  bucket: string;
  id: string;
  op: Op;
  resolve(result: CommitResult): void;
  reject(error: Error): void;
}

export class RemoteScope implements Transport {
  readonly queued = true;
  /** The sign-in ran out: nothing more is tried until the page reloads. */
  signedOut = false;
  private socket: WebSocket | null = null;
  private welcomed = false;
  private attempt = 0;
  private closed = false;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;
  private pong: ReturnType<typeof setTimeout> | null = null;
  private readonly waiting = new Map<string, Waiting>();
  private inbox: Promise<void> = Promise.resolve();
  /** On a reset: the records held before it, to let go of those it lacks. */
  private resetting: Set<string> | null = null;
  private readonly WebSocketClass: typeof WebSocket;
  private readonly delays: (attempt: number) => number;
  private readonly clientId: string;
  private readonly onOnline = () => this.reconnectNow();
  /** What this client says where it is: sent once welcomed, again after a
   *  reconnect. Undefined: presence is not asked for here. */
  private presenceState: Json | null | undefined = undefined;
  private peerList: Peer[] = [];
  private readonly peerListeners = new Set<(peers: Peer[]) => void>();

  constructor(readonly scope: string, private readonly options: RemoteOptions) {
    this.WebSocketClass = options.WebSocket ?? globalThis.WebSocket;
    this.delays = options.delays ?? ((attempt) => nextDelay(attempt));
    this.clientId = options.clientId ?? crypto.randomUUID();
    open.add(this);
    globalThis.addEventListener?.("online", this.onOnline);
    this.connect();
  }

  /** Where this scope's writes stand. */
  get status(): "saved" | "saving" | "offline" {
    return this.waiting.size === 0 ? "saved" : this.welcomed ? "saving" : "offline";
  }

  get peers(): Peer[] {
    return this.peerList;
  }

  /** Says where this client is, to everyone in the scope. */
  setPresence(state: Json | null): void {
    this.presenceState = state;
    if (this.welcomed) this.socket?.send(JSON.stringify({ t: "presence", state }));
  }

  subscribePeers(listener: (peers: Peer[]) => void): () => void {
    this.peerListeners.add(listener);
    return () => this.peerListeners.delete(listener);
  }

  commit(bucket: string, id: string, op: Op, opId: string): Promise<CommitResult> {
    return new Promise((resolve, reject) => {
      this.waiting.set(opId, { bucket, id, op, resolve, reject });
      if (this.welcomed) this.send(opId);
      this.tellStatus();
    });
  }

  close(): void {
    this.closed = true;
    open.delete(this);
    tellAll();
    globalThis.removeEventListener?.("online", this.onOnline);
    this.stopTimers();
    if (this.retry) clearTimeout(this.retry);
    this.socket?.close(1000);
    this.socket = null;
  }

  /* ── The connection ──────────────────────────────────────────────────── */

  private connect(): void {
    if (this.closed || this.signedOut) return;
    const address = `${this.options.url.replace(/^http/, "ws")}/api/sync/${encodeURIComponent(this.scope)}`;
    let socket: WebSocket;
    try {
      socket = new this.WebSocketClass(address);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.addEventListener("open", () => {
      void this.cursor().then((cursor) => {
        if (this.socket !== socket) return;
        socket.send(JSON.stringify({ t: "hello", protocol: PROTOCOL, cursor, clientId: this.clientId }));
        this.startTimers(socket);
      });
    });
    socket.addEventListener("message", (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      const message = parseServer(event.data);
      // One at a time, in the order sent: a snapshot's handling must not
      // overtake its welcome's.
      if (message) {
        this.inbox = this.inbox.then(() => this.heard(message)).catch((error: unknown) => {
          console.warn("[notes] Could not take in what the server said", error);
        });
      }
    });
    socket.addEventListener("close", (event: CloseEvent) => {
      if (this.socket !== socket) return;
      const opened = this.welcomed;
      this.socket = null;
      this.welcomed = false;
      this.stopTimers();
      if (event.code === 4401 || event.code === 4403) return this.endSignIn();
      this.tellStatus();
      if (opened || !this.options.checkSignIn) return this.scheduleReconnect();
      void this.options.checkSignIn().catch(() => true).then((still) => {
        if (still) this.scheduleReconnect();
        else this.endSignIn();
      });
    });
  }

  private endSignIn(): void {
    if (this.signedOut) return;
    this.signedOut = true;
    this.tellStatus();
    tellSyncListeners();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.signedOut || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      this.connect();
    }, this.delays(this.attempt++));
  }

  private reconnectNow(): void {
    if (this.socket || this.closed || this.signedOut) return;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.connect();
  }

  private startTimers(socket: WebSocket): void {
    this.stopTimers();
    this.ping = setInterval(() => {
      if (this.socket !== socket) return;
      socket.send(JSON.stringify({ t: "ping" }));
      this.pong = setTimeout(() => socket.close(4000), PONG_MS);
    }, PING_MS);
  }

  private stopTimers(): void {
    if (this.ping) clearInterval(this.ping);
    if (this.pong) clearTimeout(this.pong);
    this.ping = null;
    this.pong = null;
  }

  private send(opId: string): void {
    const waiting = this.waiting.get(opId);
    if (!waiting || !this.socket || !this.welcomed) return;
    const collection = waiting.bucket.slice(this.scope.length + 1);
    this.socket.send(JSON.stringify({ t: "write", opId, collection, id: waiting.id, ...toWire(waiting.op) }));
  }

  private tellStatus(): void {
    tellAll();
  }

  /* ── What the server says ────────────────────────────────────────────── */

  private async heard(message: NonNullable<ReturnType<typeof parseServer>>): Promise<void> {
    switch (message.t) {
      case "welcome":
        if (message.reset) {
          this.resetting = new Set(await this.heldKeys());
          // The server's head now, even if lower than the cursor held (the
          // scope was restored to an earlier time).
          await this.setCursor(message.head);
        } else {
          await this.store(message.changes);
        }
        this.welcomed = !message.reset;
        if (this.welcomed) this.ready();
        return;
      case "snapshot":
        for (const record of message.records) this.resetting?.delete(`${this.scope}|${record.collection}|${record.id}`);
        await this.store(message.records);
        if (message.done) {
          await this.forget([...(this.resetting ?? [])]);
          this.resetting = null;
          announce({ type: "reread", scope: this.scope, from: TAB_ID });
          this.welcomed = true;
          this.ready();
        }
        return;
      case "changes":
        await this.store(message.changes);
        return;
      case "ack": {
        const waiting = this.waiting.get(message.opId);
        await this.store([{ seq: message.seq, collection: (waiting?.bucket.slice(this.scope.length + 1) ?? "pages") as Change["collection"], id: waiting?.id ?? "", value: message.value }], false);
        if (!waiting) return;
        this.waiting.delete(message.opId);
        waiting.resolve({ value: message.value, rev: message.seq });
        this.tellStatus();
        return;
      }
      case "reject": {
        const waiting = this.waiting.get(message.opId);
        if (!waiting) return;
        this.waiting.delete(message.opId);
        waiting.reject(Object.assign(new Error(message.message), { code: message.code }));
        this.tellStatus();
        return;
      }
      case "pong":
        if (this.pong) clearTimeout(this.pong);
        this.pong = null;
        return;
      case "presence":
        this.peerList = message.peers;
        for (const listener of [...this.peerListeners]) listener(this.peerList);
        return;
    }
  }

  /** Welcomed: the backoff starts over, and every write waiting is sent
   *  again, in the order it was made. */
  private ready(): void {
    this.attempt = 0;
    for (const opId of this.waiting.keys()) this.send(opId);
    if (this.presenceState !== undefined) this.socket?.send(JSON.stringify({ t: "presence", state: this.presenceState }));
    this.tellStatus();
  }

  /* ── This browser's copy ─────────────────────────────────────────────── */

  private async cursor(): Promise<number> {
    const database = await db();
    const row = await done(database.transaction("cursors").objectStore("cursors").get(this.scope)) as { cursor: number } | undefined;
    return row?.cursor ?? 0;
  }

  private async heldKeys(): Promise<string[]> {
    const database = await db();
    const keys = await done(database.transaction("records").objectStore("records").getAllKeys(IDBKeyRange.bound(`${this.scope}|`, `${this.scope}|￿`)));
    return keys.map(String);
  }

  /** Keeps what the server stored, moves the cursor and tells every tab.
   *  `tell` false: the write's own collection tells its tabs (live.ts). */
  private async store(changes: Change[], tell = true): Promise<void> {
    if (!changes.length) return;
    const database = await db();
    const transaction = database.transaction(["records", "cursors"], "readwrite");
    const records = transaction.objectStore("records");
    const cursors = transaction.objectStore("cursors");
    const at = (await done(cursors.get(this.scope)) as { cursor: number } | undefined)?.cursor ?? 0;
    let cursor = at;
    for (const change of changes) {
      const bucket = `${this.scope}|${change.collection}`;
      const key = `${bucket}|${change.id}`;
      if (change.value) records.put({ key, bucket, id: change.id, value: change.value, rev: change.seq } satisfies StoredRecord);
      else records.delete(key);
      cursor = Math.max(cursor, change.seq);
    }
    if (cursor !== at) cursors.put({ scope: this.scope, cursor });
    await settled(transaction);
    if (tell) this.tell(changes.map((change) => ({ ...change, rev: change.seq })));
  }

  /** Records a reset did not bring back: gone from this browser too (the
   *  views are told to read the scope again once the reset is done). */
  private async forget(keys: string[]): Promise<void> {
    if (!keys.length) return;
    const database = await db();
    const transaction = database.transaction("records", "readwrite");
    for (const key of keys) transaction.objectStore("records").delete(key);
    await settled(transaction);
  }

  private async setCursor(cursor: number): Promise<void> {
    const database = await db();
    const transaction = database.transaction("cursors", "readwrite");
    transaction.objectStore("cursors").put({ scope: this.scope, cursor });
    await settled(transaction);
  }

  private tell(changes: Array<{ collection: string; id: string; value: Json | null; rev: number }>): void {
    const byBucket = new Map<string, Array<{ id: string; value: Json | null; rev: number }>>();
    for (const change of changes) {
      const bucket = `${this.scope}|${change.collection}`;
      byBucket.set(bucket, [...(byBucket.get(bucket) ?? []), { id: change.id, value: change.value, rev: change.rev }]);
    }
    for (const [bucket, list] of byBucket) announce({ type: "records", bucket, changes: list, from: TAB_ID });
  }
}

export function connectScope(scope: string, options: RemoteOptions): RemoteScope {
  return new RemoteScope(scope, options);
}
