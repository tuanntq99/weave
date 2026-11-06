import { commitOp, fromWire, parseClient, RICH_FIELDS, type Change, type Json, type ServerMessage } from "@notes/sync-protocol";

/* A sync server in memory, speaking the protocol over fake WebSockets: what
   the SDK's remote transport is tested against. It merges as the real one
   does (commitOp), remembers op ids, and can be made to misbehave: cut a
   socket before its ack, refuse a sign-in, be out of reach. */

type Listener = (event: { data?: string; code?: number }) => void;

export class FakeServer {
  head = 0;
  horizon = 0;
  records = new Map<string, { collection: string; id: string; value: Json | null; seq: number }>();
  applied = new Map<string, { seq: number; value: Json | null }>();
  sockets = new Set<FakeSocket>();
  reachable = true;
  signedIn = true;
  dropNextAck = false;
  received: string[] = [];
  presence = new Map<FakeSocket, Json | null>();

  /** The WebSocket class a client is given. */
  get WebSocket() {
    const server = this;
    return class extends FakeSocket {
      constructor(url: string) {
        super(url, server);
      }
    };
  }

  change(collection: string, id: string, value: Json | null): Change {
    this.head += 1;
    this.records.set(`${collection}|${id}`, { collection, id, value, seq: this.head });
    return { seq: this.head, collection: collection as Change["collection"], id, value };
  }

  /** Someone else writes: every socket is told. */
  writeFromElsewhere(collection: string, id: string, value: Json | null): void {
    const change = this.change(collection, id, value);
    for (const socket of this.sockets) socket.deliver({ t: "changes", changes: [change] });
  }

  handle(socket: FakeSocket, text: string): void {
    const message = parseClient(text);
    if (!message) return;
    this.received.push(message.t === "write" ? `write:${message.opId}` : message.t);
    if (message.t === "ping") socket.deliver({ t: "pong" });
    if (message.t === "presence") {
      // As the real one: everyone told who is here and where they say they are.
      this.presence.set(socket, message.state);
      const peers = [...this.presence].map(([someone, state], index) => ({ clientId: `c${index}`, userId: someone.userId, state }));
      for (const other of this.sockets) other.deliver({ t: "presence", peers });
    }
    if (message.t === "hello") {
      if (message.cursor < this.horizon || message.cursor > this.head) {
        socket.deliver({ t: "welcome", head: this.head, reset: true });
        const live = [...this.records.values()].filter((row) => row.value !== null)
          .map((row) => ({ seq: row.seq, collection: row.collection as Change["collection"], id: row.id, value: row.value }));
        socket.deliver({ t: "snapshot", records: live, done: true });
        return;
      }
      const changes = [...this.records.values()].filter((row) => row.seq > message.cursor).sort((a, b) => a.seq - b.seq)
        .map((row) => ({ seq: row.seq, collection: row.collection as Change["collection"], id: row.id, value: row.value }));
      socket.deliver({ t: "welcome", head: this.head, reset: false, changes });
    }
    if (message.t === "write") {
      const known = this.applied.get(message.opId);
      let seq: number;
      let value: Json | null;
      if (known) ({ seq, value } = known);
      else {
        const stored = this.records.get(`${message.collection}|${message.id}`)?.value ?? undefined;
        value = commitOp(stored, fromWire(message, RICH_FIELDS[message.collection])) ?? null;
        seq = this.change(message.collection, message.id, value).seq;
        this.applied.set(message.opId, { seq, value });
        for (const other of this.sockets) if (other !== socket) other.deliver({ t: "changes", changes: [{ seq, collection: message.collection, id: message.id, value }] });
      }
      if (this.dropNextAck) {
        this.dropNextAck = false;
        socket.cut(1006);
        return;
      }
      socket.deliver({ t: "ack", opId: message.opId, seq, value });
    }
  }
}

export class FakeSocket {
  static readonly OPEN = 1;
  readyState = 0;
  /** Who this socket is, for presence: the url's `?as=`, else u_ada. */
  get userId(): string {
    return new URL(this.url.replace(/^ws/, "http")).searchParams.get("as") ?? "u_ada";
  }
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(readonly url: string, private readonly server: FakeServer) {
    queueMicrotask(() => {
      if (!server.reachable) return this.cut(1006);
      if (!server.signedIn) return this.cut(4401);
      server.sockets.add(this);
      this.readyState = 1;
      this.emit("open", {});
    });
  }

  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(text: string): void {
    if (this.readyState !== 1) throw new Error("not open");
    queueMicrotask(() => this.server.handle(this, text));
  }

  close(code = 1000): void {
    this.cut(code);
  }

  deliver(message: ServerMessage): void {
    if (this.readyState !== 1) return;
    queueMicrotask(() => this.emit("message", { data: JSON.stringify(message) }));
  }

  cut(code: number): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.server.sockets.delete(this);
    queueMicrotask(() => this.emit("close", { code }));
  }

  private emit(type: string, event: { data?: string; code?: number }): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
}
