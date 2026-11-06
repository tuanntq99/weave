import { isObject, type WriteBody } from "./ops";
import { COLLECTIONS, type Collection, type Json } from "./types";

/* What a client and its sync server say to each other, one JSON message a
   WebSocket frame (spec S3 §4.2). Anything else is not a message: parse
   answers null and the receiver lets it go. */

export const PROTOCOL = 1;

export type Hello = { t: "hello"; protocol: 1; cursor: number; clientId: string };
export type WriteMessage = { t: "write"; opId: string; collection: Collection; id: string } & WriteBody;
export type PresenceIn = { t: "presence"; state: Json | null };
export type Ping = { t: "ping" };
export type ClientMessage = Hello | WriteMessage | PresenceIn | Ping;

export type Change = { seq: number; collection: Collection; id: string; value: Json | null };
export type Welcome = { t: "welcome"; head: number; reset: false; changes: Change[] } | { t: "welcome"; head: number; reset: true };
export type Snapshot = { t: "snapshot"; records: Change[]; done: boolean };
export type Ack = { t: "ack"; opId: string; seq: number; value: Json | null };
export type RejectCode = "bad_request" | "too_large" | "forbidden";
export type Reject = { t: "reject"; opId: string; code: RejectCode; message: string };
export type Changes = { t: "changes"; changes: Change[] };
export type PresenceOut = { t: "presence"; peers: Array<{ clientId: string; userId: string; state: Json | null }> };
export type Pong = { t: "pong" };
export type ServerMessage = Welcome | Snapshot | Ack | Reject | Changes | PresenceOut | Pong;

/** The largest message, and record, either side sends. */
export const MAX_MESSAGE_BYTES = 1024 * 1024;
export const MAX_ID_LENGTH = 200;
export const SNAPSHOT_BATCH = 500;

const isCollection = (value: unknown): value is Collection => (COLLECTIONS as readonly unknown[]).includes(value);
const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH;
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
const isValue = (value: unknown) => value === null || isObject(value);

function read(text: string): Json | null {
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

function isChange(value: unknown): value is Change {
  return isObject(value) && isCount(value.seq) && isCollection(value.collection) && isId(value.id) && isValue(value.value);
}

export function parseClient(text: string): ClientMessage | null {
  const message = read(text);
  if (!message) return null;
  switch (message.t) {
    case "hello":
      return message.protocol === PROTOCOL && isCount(message.cursor) && isId(message.clientId) ? message as Hello : null;
    case "write": {
      if (!isId(message.opId) || !isCollection(message.collection) || !isId(message.id)) return null;
      if (message.action === "put") return isObject(message.value) ? message as WriteMessage : null;
      if (message.action === "delete") return message as WriteMessage;
      if (message.action === "patch") {
        if (!isObject(message.patch)) return null;
        if (message.base !== undefined && !isObject(message.base)) return null;
        return message as WriteMessage;
      }
      return null;
    }
    case "presence":
      return isValue(message.state) ? message as PresenceIn : null;
    case "ping":
      return { t: "ping" };
    default:
      return null;
  }
}

export function parseServer(text: string): ServerMessage | null {
  const message = read(text);
  if (!message) return null;
  switch (message.t) {
    case "welcome":
      if (!isCount(message.head) || typeof message.reset !== "boolean") return null;
      if (message.reset) return message as Welcome;
      return Array.isArray(message.changes) && message.changes.every(isChange) ? message as Welcome : null;
    case "snapshot":
      return Array.isArray(message.records) && message.records.every(isChange) && typeof message.done === "boolean" ? message as Snapshot : null;
    case "ack":
      return isId(message.opId) && isCount(message.seq) && isValue(message.value) ? message as Ack : null;
    case "reject":
      return isId(message.opId) && typeof message.code === "string" && typeof message.message === "string" ? message as Reject : null;
    case "changes":
      return Array.isArray(message.changes) && message.changes.every(isChange) ? message as Changes : null;
    case "presence":
      return Array.isArray(message.peers) ? message as PresenceOut : null;
    case "pong":
      return { t: "pong" };
    default:
      return null;
  }
}
