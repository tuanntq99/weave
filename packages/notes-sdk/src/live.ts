import { announce, db, done, listen, TAB_ID, type StoredRecord } from "./db";
import { outbox } from "./outbox";
import { beginStore, setSyncStatus, sync } from "./sync";
import { transportFor, type Transport } from "./transport";
import { commitOp, mergeOps, type Op as WireOp, type RichText } from "@notes/sync-protocol";

/* A collection as a tab holds it, live: what is stored, with this tab's
   writes over it until they are stored. A write shows at once; it is then
   stored in one transaction that reads what is there now — another tab may
   have written since — merges, and writes. IndexedDB runs one read-write
   transaction on a store at a time, across tabs, so no write is made over a
   stale read. Every tab is then told what was stored. */

export type RecordPatch<R> = { [K in keyof R]?: R[K] | null };

export interface LiveRow<R> {
  id: string;
  value: R;
}

export interface PatchOptions {
  /** The runs a rich-text field's change was made from, by field; unset, the
   *  runs this tab showed. */
  base?: Record<string, RichText>;
}

export interface LiveCollection<R> {
  readonly records: LiveRow<R>[];
  get(id: string): R | undefined;
  put(id: string, value: R): Promise<void>;
  patch(id: string, patch: RecordPatch<R>, options?: PatchOptions): Promise<void>;
  delete(id: string): Promise<void>;
  /** Called on every change; also at once unless `immediate` is false. */
  subscribe(listener: (records: LiveRow<R>[]) => void, options?: { immediate?: boolean }): () => void;
  close(): Promise<void>;
}

type Value = Record<string, unknown>;

/** A write as this tab holds it: the protocol's op (`wire`), its place in
 *  the tab's order (`seq`), the id the server knows it by (`opId`), whether
 *  it has gone to the transport (`sent`: then it never changes), and the
 *  calls whose changes it carries, told how it ends. */
interface Pending {
  seq: number;
  opId: string;
  wire: WireOp;
  sent: boolean;
  waiters: Array<{ resolve(): void; reject(error: Error): void }>;
}

const newOpId = () => crypto.randomUUID();

let sequence = 0;

/* With a server (spec S4), a write waits before it is sent: until
   `quietMs` pass with no write, or `maxMs` after the first that waits.
   Meanwhile each write to the same record joins it (mergeOps), under its op
   id - the server has never seen that id, so nothing is applied twice - and
   is kept in the outbox at once, so a closed tab loses nothing. Every
   collection's waiting writes go together, in the order they were made. */
export const COALESCE = { quietMs: 400, maxMs: 2000 };

interface Holder {
  takeHeld(): Array<{ id: string; entry: Pending; send(): Promise<void> }>;
}

const holding = new Set<Holder>();
let holdTimer: ReturnType<typeof setTimeout> | null = null;
let holdSince = 0;
/** The outbox's changes, one after another: a write is sent only once it
 *  is kept. */
let persisted: Promise<void> = Promise.resolve();

function persist(task: () => Promise<unknown>): void {
  const stored = beginStore();
  persisted = persisted.then(task).then(() => undefined, (error: unknown) => {
    console.warn("[notes] Could not keep a write in the outbox", error);
  }).finally(stored);
}

function holdOn(holder: Holder): void {
  holding.add(holder);
  if (holdTimer) clearTimeout(holdTimer);
  else holdSince = Date.now();
  const wait = Math.max(0, Math.min(COALESCE.quietMs, holdSince + COALESCE.maxMs - Date.now()));
  holdTimer = setTimeout(releaseAll, wait);
  if (sync.status === "saved") setSyncStatus("saving");
}

/** Sends every waiting write, in the order they were made. */
function releaseAll(): void {
  if (holdTimer) clearTimeout(holdTimer);
  holdTimer = null;
  const waiting = [...holding].flatMap((holder) => holder.takeHeld());
  holding.clear();
  waiting.sort((left, right) => left.entry.seq - right.entry.seq);
  void persisted.then(() => {
    for (const write of waiting) void write.send();
  });
}

export class LocalLiveCollection<R> implements LiveCollection<R> {
  private readonly confirmed = new Map<string, Value>();
  /** The revision each record's confirmed value is from: a message older
   *  than it, arriving late, is not taken. */
  private readonly revs = new Map<string, number>();
  private readonly pending = new Map<string, Pending[]>();
  private visible = new Map<string, Value>();
  private rows: LiveRow<R>[] | null = null;
  private readonly listeners = new Set<(records: LiveRow<R>[]) => void>();
  private stopListening: (() => void) | null = null;
  private closed = false;

  private constructor(
    private readonly bucket: string,
    private readonly richFields: readonly string[],
    private readonly transport: Transport,
  ) {}

  static async open<R>(bucket: string, richFields: readonly string[], transport: Transport = transportFor(bucket)): Promise<LocalLiveCollection<R>> {
    const live = new LocalLiveCollection<R>(bucket, richFields, transport);
    // Listen before reading, so nothing stored in between is missed; what
    // the read finds is never older than what was heard.
    const heard: Array<{ id: string; value: Value | null; rev: number }> = [];
    let reading = true;
    live.stopListening = listen((message) => {
      if (message.type === "reread" && bucket.startsWith(`${message.scope}|`) && !live.closed && !reading) {
        void live.reread();
        return;
      }
      if (message.type !== "records" || message.bucket !== bucket || live.closed) return;
      if (reading) {
        heard.push(...message.changes);
        return;
      }
      live.heard(message.changes);
    });
    const database = await db();
    const rows = await done(database.transaction("records").objectStore("records").index("bucket").getAll(bucket)) as StoredRecord[];
    for (const row of rows) {
      live.confirmed.set(row.id, row.value);
      live.revs.set(row.id, row.rev ?? 0);
    }
    for (const change of heard) live.take(change);
    reading = false;
    live.visible = new Map(live.confirmed);
    // What waited in the outbox is shown, and sent again in its order.
    if (transport.queued) {
      for (const entry of await outbox.list(bucket)) {
        const op: Pending = { seq: ++sequence, opId: entry.opId, wire: entry.op, sent: true, waiters: [] };
        live.pending.set(entry.id, [...(live.pending.get(entry.id) ?? []), op]);
        live.refresh(entry.id, false);
        void live.send(entry.id, op);
      }
    }
    return live;
  }

  get records(): LiveRow<R>[] {
    if (!this.rows) this.rows = [...this.visible].map(([id, value]) => ({ id, value: value as R }));
    return this.rows;
  }

  get(id: string): R | undefined {
    return this.visible.get(id) as R | undefined;
  }

  put(id: string, value: R): Promise<void> {
    return this.write(id, { action: "put", value: structuredClone(value) as Value });
  }

  patch(id: string, patch: RecordPatch<R>, options: PatchOptions = {}): Promise<void> {
    const shown = this.visible.get(id);
    const copy = structuredClone(patch) as Value;
    const rich: Record<string, { base: unknown; next: unknown }> = {};
    for (const field of this.richFields) {
      if (!(field in copy) || copy[field] === null || copy[field] === undefined) continue;
      rich[field] = { base: options.base?.[field] ?? shown?.[field] ?? [], next: copy[field] };
    }
    return this.write(id, { action: "patch", patch: copy, rich });
  }

  delete(id: string): Promise<void> {
    return this.write(id, { action: "delete" });
  }

  subscribe(listener: (records: LiveRow<R>[]) => void, options: { immediate?: boolean } = {}): () => void {
    this.listeners.add(listener);
    if (options.immediate !== false) listener(this.records);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    // What waits is sent now (it is in the outbox either way).
    if (holding.has(this)) releaseAll();
    this.closed = true;
    this.stopListening?.();
    this.listeners.clear();
  }

  private write(id: string, wire: WireOp): Promise<void> {
    if (this.closed) return Promise.reject(new Error("This collection is closed"));
    return new Promise<void>((resolve, reject) => {
      const waiter = { resolve, reject };
      const last = this.pending.get(id)?.at(-1);
      const held = this.transport.queued && last && !last.sent ? last : undefined;
      const merged = held ? mergeOps(held.wire, wire) : null;
      if (held && merged) {
        held.wire = merged;
        held.waiters.push(waiter);
        this.refresh(id);
        persist(() => outbox.replace(held.opId, merged));
        holdOn(this);
        return;
      }
      // What waits cannot take this change: it goes first, as it is.
      if (held) releaseAll();
      const entry: Pending = { seq: ++sequence, opId: newOpId(), wire, sent: !this.transport.queued, waiters: [waiter] };
      this.pending.set(id, [...(this.pending.get(id) ?? []), entry]);
      this.refresh(id);
      if (!this.transport.queued) {
        void this.send(id, entry);
        return;
      }
      // Kept before it is sent: a reload or a closed tab loses nothing.
      persist(() => outbox.add({ bucket: this.bucket, id, opId: entry.opId, op: wire }));
      holdOn(this);
    });
  }

  /** The writes waiting here, now marked sent: they change no more. */
  takeHeld(): Array<{ id: string; entry: Pending; send(): Promise<void> }> {
    const taken: Array<{ id: string; entry: Pending; send(): Promise<void> }> = [];
    for (const [id, ops] of this.pending) {
      for (const entry of ops) {
        if (entry.sent) continue;
        entry.sent = true;
        taken.push({ id, entry, send: () => this.send(id, entry) });
      }
    }
    return taken;
  }

  /** Hands a write to the transport; its answer is what is stored, and
   *  what every call it carries is told. */
  private async send(id: string, op: Pending): Promise<void> {
    const stored = this.transport.queued ? () => {} : beginStore();
    try {
      const { value, rev } = await this.transport.commit(this.bucket, id, op.wire, op.opId);
      if (this.transport.queued) await outbox.remove(op.opId);
      this.settle(id, op);
      announce({ type: "records", bucket: this.bucket, changes: [{ id, value, rev }], from: TAB_ID });
      for (const waiter of op.waiters) waiter.resolve();
    } catch (error) {
      // Refused: taken back off the screen, and out of the outbox.
      if (this.transport.queued) await outbox.remove(op.opId).catch(() => undefined);
      this.settle(id, op);
      this.refresh(id);
      const refused = Object.assign(error instanceof Error ? error : new Error(String(error)), { retryable: false });
      for (const waiter of op.waiters) waiter.reject(refused);
    } finally {
      stored();
    }
  }

  private settle(id: string, op: Pending): void {
    const ops = (this.pending.get(id) ?? []).filter((item) => item.seq !== op.seq);
    if (ops.length) this.pending.set(id, ops);
    else this.pending.delete(id);
  }

  /** The bucket as stored, taken in whole: after a reset, revisions held
   *  may be from before it and say nothing about what is newer. */
  private async reread(): Promise<void> {
    const database = await db();
    const rows = await done(database.transaction("records").objectStore("records").index("bucket").getAll(this.bucket)) as StoredRecord[];
    if (this.closed) return;
    const ids = new Set([...this.confirmed.keys(), ...rows.map((row) => row.id)]);
    this.confirmed.clear();
    this.revs.clear();
    for (const row of rows) {
      this.confirmed.set(row.id, row.value);
      this.revs.set(row.id, row.rev ?? 0);
    }
    for (const id of ids) this.refresh(id, false);
    this.rows = null;
    this.emit();
  }

  /** What was stored, by any tab. */
  private heard(changes: Array<{ id: string; value: Value | null; rev: number }>): void {
    let changed = false;
    for (const change of changes) {
      if (!this.take(change)) continue;
      this.refresh(change.id, false);
      changed = true;
    }
    if (changed) this.emit();
  }

  /** Takes a stored value in, unless what is held is newer: messages from
   *  other tabs can arrive after this tab's own later commit. */
  private take(change: { id: string; value: Value | null; rev: number }): boolean {
    if ((change.rev ?? 0) <= (this.revs.get(change.id) ?? 0)) return false;
    this.revs.set(change.id, change.rev);
    if (change.value) this.confirmed.set(change.id, change.value);
    else this.confirmed.delete(change.id);
    return true;
  }

  /** A record as this tab shows it: what is stored, its own writes over it. */
  private refresh(id: string, emit = true): void {
    let value = this.confirmed.get(id);
    // Each pending write is merged over what is there, as storing it will:
    // someone else's words never vanish while this tab's are on their way.
    for (const op of this.pending.get(id) ?? []) value = commitOp(value, op.wire);
    const before = this.visible.get(id);
    if (before === value) return;
    if (value) this.visible.set(id, value);
    else this.visible.delete(id);
    this.rows = null;
    if (emit) this.emit();
  }

  private emit(): void {
    if (this.closed) return;
    const rows = this.records;
    for (const listener of [...this.listeners]) listener(rows);
  }
}

/** A collection of the app's, in one scope. */
export interface CollectionHandle<R> {
  readonly name: string;
  live(): Promise<LiveCollection<R>>;
  /** The same collection in a space. */
  in(spaceId: string): CollectionHandle<R>;
}

export function isRecord(value: unknown): value is Value {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
