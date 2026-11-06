import type { Json } from "@notes/sync-protocol";
import { sdkConfig } from "./config";
import { announce, TAB_ID } from "./db";
import { connectScope, type RemoteScope } from "./remote";

/* Sharing with a server (spec S5c): on only when /api/me says so. Spaces,
   members and people are asked of the API; each space's records go through
   a socket of their own, opened the first time the space is used. */

let sharing = false;

export const sharingOn = (): boolean => sharing;

const SHARING_KEY = "notes:remote-sharing";

/** Whether sharing was on when this browser last reached the server: for a
 *  start with no network. */
export function rememberedSharing(): boolean {
  try {
    return globalThis.localStorage?.getItem(SHARING_KEY) === "on";
  } catch {
    return false;
  }
}

export function setSharing(on: boolean): void {
  sharing = on;
  try {
    globalThis.localStorage?.setItem(SHARING_KEY, on ? "on" : "off");
  } catch {
    // Storage refused: an offline start shows no spaces.
  }
}

const spaceRemotes = new Map<string, RemoteScope>();

/** The socket of a space's scope (`space:<id>`), opened on first use. */
export function spaceRemote(scope: string, options: { WebSocket?: typeof WebSocket } = {}): RemoteScope {
  let remote = spaceRemotes.get(scope);
  if (!remote) {
    remote = connectScope(scope, { url: sdkConfig().url, ...options });
    spaceRemotes.set(scope, remote);
  }
  return remote;
}

/** Closes every space's socket: signed out, or tests. */
export function closeSpaceRemotes(): void {
  for (const remote of spaceRemotes.values()) remote.close();
  spaceRemotes.clear();
}

/** One call to the API: its JSON, or its refusal as an error with a code. */
export async function api<T>(path: string, init: { method?: string; body?: Json } = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${sdkConfig().url}${path}`, {
      method: init.method ?? "GET",
      credentials: "include",
      ...(init.body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(init.body) } : {}),
    });
  } catch {
    throw Object.assign(new Error("Weave could not reach its server."), { code: "unreachable", retryable: true });
  }
  const answer = await response.json().catch(() => ({})) as { code?: string; message?: string };
  if (!response.ok) {
    throw Object.assign(new Error(answer.message ?? `The server refused (${answer.code ?? response.status}).`), {
      code: answer.code ?? "forbidden",
      retryable: response.status >= 500,
    });
  }
  return answer as T;
}

/** A change to spaces or members, made: every tab's lists read again. */
export function changed(): void {
  announce({ type: "meta", from: TAB_ID });
}
