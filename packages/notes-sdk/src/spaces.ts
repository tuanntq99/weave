import { announce, db, done, listen, settled, TAB_ID } from "./db";
import { isRemote, unavailable } from "./config";
import { cleanHandle, me, personOf, spaceScope, type Person } from "./identity";
import type { Json } from "@notes/sync-protocol";
import { api, changed, sharingOn, spaceRemote } from "./remote-spaces";

/* People, spaces and who is in them, kept in this browser. Anyone the
   browser has seen (a handle opened with `?as=`, or invited) is a person; a
   space is a name, its owner and its members' roles. An invitation is
   accepted at once: there is nobody to wait for. Presence — who is on which
   page — goes between tabs over the BroadcastChannel and is never stored. */

export type SpaceRole = "owner" | "admin" | "editor" | "viewer";
export type MemberRole = Exclude<SpaceRole, "owner">;

export interface Space {
  id: string;
  name: string;
  myRole: SpaceRole;
  capabilities: { canInvite: boolean; canManageRoles: boolean; canRemoveMembers: boolean; canLeave: boolean };
}

export interface SpaceMember extends Person {
  role: SpaceRole;
}

export interface SpaceInvitation {
  id: string;
  invitee: Person;
  role: MemberRole;
  status: "pending" | "accepted" | "declined" | "revoked" | "expired";
  expiresAt: string;
}

export interface SpaceRoster {
  members: SpaceMember[];
  invitations: SpaceInvitation[];
}

interface UserRow { key: string; person: Person }
interface SpaceRow { key: string; id: string; name: string; members: Record<string, SpaceRole> }

const refused = (message: string, code = "forbidden") => Object.assign(new Error(message), { code, retryable: false });

async function all<T>(prefix: string): Promise<T[]> {
  const database = await db();
  const range = IDBKeyRange.bound(prefix, `${prefix}￿`);
  return await done(database.transaction("meta").objectStore("meta").getAll(range)) as T[];
}

async function getRow<T>(key: string): Promise<T | undefined> {
  const database = await db();
  return await done(database.transaction("meta").objectStore("meta").get(key)) as T | undefined;
}

async function putRows(rows: Array<UserRow | SpaceRow>, del: string[] = []): Promise<void> {
  const database = await db();
  const transaction = database.transaction("meta", "readwrite");
  const store = transaction.objectStore("meta");
  for (const row of rows) store.put(row);
  for (const key of del) store.delete(key);
  await settled(transaction);
  announce({ type: "meta", from: TAB_ID });
}

/** Someone the browser knows, made known if they were not. */
export async function knownPerson(handle: string): Promise<Person> {
  const person = personOf(handle);
  const found = await getRow<UserRow>(`user:${person.id}`);
  if (found) return found.person;
  await putRows([{ key: `user:${person.id}`, person }]);
  return person;
}

async function people(): Promise<Map<string, Person>> {
  const rows = await all<UserRow>("user:");
  return new Map(rows.map((row) => [row.person.id, row.person]));
}

function capabilities(role: SpaceRole): Space["capabilities"] {
  const manager = role === "owner" || role === "admin";
  return { canInvite: manager, canManageRoles: manager, canRemoveMembers: manager, canLeave: role !== "owner" };
}

const spaceOf = (row: SpaceRow, role: SpaceRole): Space => ({ id: row.id, name: row.name, myRole: role, capabilities: capabilities(role) });

async function spaceRow(spaceId: string): Promise<SpaceRow> {
  const row = await getRow<SpaceRow>(`space:${spaceId}`);
  if (!row) throw refused(`There is no space ${spaceId}`, "not_found");
  return row;
}

async function myRoleIn(spaceId: string): Promise<{ row: SpaceRow; role: SpaceRole }> {
  const row = await spaceRow(spaceId);
  const role = row.members[me().id];
  if (!role) throw refused("You are not in this space");
  return { row, role };
}

async function rosterOf(spaceId: string): Promise<SpaceRoster> {
  const row = await spaceRow(spaceId);
  const known = await people();
  const members = Object.entries(row.members).map(([userId, role]) => ({
    ...(known.get(userId) ?? personOf(userId.replace(/^u_/, ""))),
    role,
  }));
  return { members, invitations: [] };
}

/** With a server, lists are also read again this often: someone else may
 *  have invited, removed or renamed. */
export const REMOTE_POLL_MS = 30_000;

/** A list that is read again whenever people or spaces change, in any tab
 *  (and, shared on a server, every REMOTE_POLL_MS). */
function liveList<T>(read: () => Promise<T>) {
  return {
    async open() {
      let current = await read();
      const listeners = new Set<(value: T) => void>();
      let reading: Promise<void> = Promise.resolve();
      const again = () => {
        reading = reading.then(async () => {
          const next = await read();
          // People and spaces share one message: only a change here is told.
          if (JSON.stringify(next) === JSON.stringify(current)) return;
          current = next;
          for (const listener of [...listeners]) listener(current);
        }).catch(() => undefined);
      };
      const listening = listen((message) => {
        if (message.type === "meta") again();
      });
      const poll = shared() ? setInterval(again, REMOTE_POLL_MS) : null;
      const stop = () => {
        listening();
        if (poll) clearInterval(poll);
      };
      return {
        get value() {
          return current;
        },
        subscribe(listener: (value: T) => void, options: { immediate?: boolean } = {}) {
          listeners.add(listener);
          if (options.immediate !== false) listener(current);
          return () => listeners.delete(listener);
        },
        async close() {
          stop();
          listeners.clear();
        },
      };
    },
  };
}

const SPACES_KEY = "notes:remote-spaces";

function keepSpaces(rows: Array<{ id: string; name: string; myRole: SpaceRole }>): void {
  try {
    globalThis.localStorage?.setItem(SPACES_KEY, JSON.stringify(rows));
  } catch {
    // Storage refused: an offline start shows no spaces.
  }
}

function keptSpaces(): Array<{ id: string; name: string; myRole: SpaceRole }> {
  try {
    const rows = JSON.parse(globalThis.localStorage?.getItem(SPACES_KEY) ?? "[]") as unknown;
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

/** Sharing through the server (spec S5c). */
const shared = () => isRemote() && sharingOn();

async function mySpaces(): Promise<Space[]> {
  // With a server, spaces are the server's; with sharing off there are none.
  if (isRemote()) {
    if (!sharingOn()) return [];
    let rows: Array<{ id: string; name: string; myRole: SpaceRole }>;
    try {
      rows = await api<typeof rows>("/api/spaces");
      keepSpaces(rows);
    } catch (error) {
      // No network: the spaces as last heard, so their pages still open.
      if ((error as { code?: string }).code !== "unreachable") throw error;
      rows = keptSpaces();
    }
    return rows.map((row) => ({ id: row.id, name: row.name, myRole: row.myRole, capabilities: capabilities(row.myRole) }));
  }
  const rows = await all<SpaceRow>("space:");
  const id = me().id;
  return rows.flatMap((row) => (row.members[id] ? [spaceOf(row, row.members[id])] : []));
}

/* ── Presence ──────────────────────────────────────────────────────────── */

export interface SpacePresence<S> {
  /** Who has a tab in the space now. */
  online: string[];
  /** What each said last. */
  states: Record<string, S>;
}

export interface EnteredSpace<S> {
  readonly presence: SpacePresence<S>;
  setPresence(state: S | null): Promise<void>;
  subscribePresence(listener: (presence: SpacePresence<S>) => void): () => void;
  close(): Promise<void>;
}

const HEARTBEAT_MS = 5_000;
const GONE_MS = 15_000;

function enterSpace<S>(spaceId: string): EnteredSpace<S> {
  const userId = me().id;
  const tabs = new Map<string, { userId: string; state: S | null; at: number }>();
  const listeners = new Set<(presence: SpacePresence<S>) => void>();
  let mine: S | null = null;
  let snapshot: SpacePresence<S> = { online: [userId], states: {} };

  const rebuild = () => {
    const now = Date.now();
    for (const [tab, entry] of tabs) if (tab !== TAB_ID && now - entry.at > GONE_MS) tabs.delete(tab);
    const latest = new Map<string, { state: S | null; at: number }>();
    for (const entry of tabs.values()) {
      const seen = latest.get(entry.userId);
      if (!seen || entry.at >= seen.at) latest.set(entry.userId, { state: entry.state, at: entry.at });
    }
    const states: Record<string, S> = {};
    for (const [id, entry] of latest) if (entry.state !== null) states[id] = entry.state;
    snapshot = { online: [...latest.keys()], states };
    for (const listener of [...listeners]) listener(snapshot);
  };

  const say = () => {
    const at = Date.now();
    tabs.set(TAB_ID, { userId, state: mine, at });
    announce({ type: "presence", spaceId, tab: TAB_ID, userId, state: mine, at, from: TAB_ID });
  };

  const stop = listen((message) => {
    if (!("spaceId" in message) || message.spaceId !== spaceId || message.from === TAB_ID) return;
    if (message.type === "presence") tabs.set(message.tab, { userId: message.userId, state: message.state as S | null, at: Date.now() });
    else if (message.type === "presence-leave") tabs.delete(message.tab);
    else if (message.type === "presence-hello") say();
    rebuild();
  });
  const heartbeat = setInterval(() => {
    say();
    rebuild();
  }, HEARTBEAT_MS);
  say();
  rebuild();
  announce({ type: "presence-hello", spaceId, from: TAB_ID });

  return {
    get presence() {
      return snapshot;
    },
    async setPresence(state) {
      mine = state;
      say();
      rebuild();
    },
    subscribePresence(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      clearInterval(heartbeat);
      stop();
      listeners.clear();
      announce({ type: "presence-leave", spaceId, tab: TAB_ID, from: TAB_ID });
    },
  };
}

/* ── What the app calls ────────────────────────────────────────────────── */

const newId = () => `space_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;

/** A space entered through its scope's socket: who is there is what the
 *  server says, by person (a person in two tabs is one). */
function enterRemote<S>(spaceId: string): EnteredSpace<S> {
  const remote = spaceRemote(spaceScope(spaceId));
  const listeners = new Set<(presence: SpacePresence<S>) => void>();
  const snapshotOf = (): SpacePresence<S> => {
    const states: Record<string, S> = {};
    for (const peer of remote.peers) if (peer.state !== null) states[peer.userId] = peer.state as S;
    return { online: [...new Set([me().id, ...remote.peers.map((peer) => peer.userId)])], states };
  };
  let snapshot = snapshotOf();
  const stop = remote.subscribePeers(() => {
    snapshot = snapshotOf();
    for (const listener of [...listeners]) listener(snapshot);
  });
  remote.setPresence(null);
  return {
    get presence() {
      return snapshot;
    },
    async setPresence(state) {
      remote.setPresence(state as Json | null);
    },
    subscribePresence(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      stop();
      listeners.clear();
      remote.setPresence(null);
    },
  };
}

async function remoteRoster(spaceId: string): Promise<SpaceRoster> {
  const members = await api<SpaceMember[]>(`/api/spaces/${encodeURIComponent(spaceId)}/members`);
  return { members, invitations: [] };
}

const memberPath = (spaceId: string, userId?: string) =>
  `/api/spaces/${encodeURIComponent(spaceId)}/members${userId ? `/${encodeURIComponent(userId)}` : ""}`;

export const spaces = {
  async create({ name }: { name: string }): Promise<{ space: Space }> {
    if (shared()) {
      const made = await api<{ id: string; name: string }>("/api/spaces", { method: "POST", body: { name } });
      changed();
      return { space: { id: made.id, name: made.name, myRole: "owner", capabilities: capabilities("owner") } };
    }
    if (isRemote()) throw unavailable("Sharing");
    await knownPerson(me().handle);
    const row: SpaceRow = { key: "", id: newId(), name: name.trim() || "Untitled space", members: { [me().id]: "owner" } };
    row.key = `space:${row.id}`;
    await putRows([row]);
    return { space: spaceOf(row, "owner") };
  },
  list: mySpaces,
  live: () => liveList(mySpaces).open(),
  async leave(spaceId: string): Promise<void> {
    if (shared()) {
      await api(`/api/spaces/${encodeURIComponent(spaceId)}/leave`, { method: "POST" });
      changed();
      return;
    }
    const { row, role } = await myRoleIn(spaceId);
    if (role === "owner") throw refused("The owner cannot leave their space");
    const members = { ...row.members };
    delete members[me().id];
    await putRows([{ ...row, members }]);
  },
  async enter<S>(spaceId: string): Promise<EnteredSpace<S>> {
    if (shared()) return enterRemote<S>(spaceId);
    if (isRemote()) throw unavailable("Sharing");
    await myRoleIn(spaceId);
    return enterSpace<S>(spaceId);
  },
  members: {
    async list(spaceId: string): Promise<SpaceMember[]> {
      if (shared()) return (await remoteRoster(spaceId)).members;
      await myRoleIn(spaceId);
      return (await rosterOf(spaceId)).members;
    },
    async live(spaceId: string) {
      if (shared()) return liveList(() => remoteRoster(spaceId)).open();
      await myRoleIn(spaceId);
      return liveList(() => rosterOf(spaceId)).open();
    },
    async invite(spaceId: string, handle: string, role: MemberRole): Promise<{ created: boolean }> {
      if (shared()) {
        const answer = await api<{ created: boolean }>(memberPath(spaceId), { method: "POST", body: { handle, role } });
        changed();
        return answer;
      }
      const { row, role: mine } = await myRoleIn(spaceId);
      if (!capabilities(mine).canInvite) throw refused("Only the owner and Full access can invite");
      if (role === "admin" && mine !== "owner") throw refused("Only the owner gives Full access");
      if (!cleanHandle(handle)) throw refused("That is not a handle", "bad_request");
      const person = await knownPerson(handle);
      if (row.members[person.id]) return { created: false };
      await putRows([{ ...row, members: { ...row.members, [person.id]: role } }]);
      return { created: true };
    },
    async update(spaceId: string, userId: string, role: MemberRole): Promise<void> {
      if (shared()) {
        await api(memberPath(spaceId, userId), { method: "PATCH", body: { role } });
        changed();
        return;
      }
      const { row, role: mine } = await myRoleIn(spaceId);
      if (!capabilities(mine).canManageRoles) throw refused("Only the owner and Full access change roles");
      const current = row.members[userId];
      if (!current || current === "owner") throw refused("That member's role cannot change");
      if ((role === "admin" || current === "admin") && mine !== "owner") throw refused("Only the owner gives or takes Full access");
      await putRows([{ ...row, members: { ...row.members, [userId]: role } }]);
    },
    async remove(spaceId: string, userId: string): Promise<void> {
      if (shared()) {
        await api(memberPath(spaceId, userId), { method: "DELETE" });
        changed();
        return;
      }
      const { row, role: mine } = await myRoleIn(spaceId);
      if (!capabilities(mine).canRemoveMembers) throw refused("Only the owner and Full access remove members");
      if (row.members[userId] === "owner") throw refused("The owner cannot be removed");
      const members = { ...row.members };
      delete members[userId];
      await putRows([{ ...row, members }]);
    },
  },
};

export const people_ = {
  async search(query: string): Promise<Person[]> {
    if (shared()) return query.trim() ? api<Person[]>(`/api/people?q=${encodeURIComponent(query.trim())}`) : [];
    const wanted = cleanHandle(query);
    if (!wanted) return [];
    const found = [...(await people()).values()]
      .filter((person) => person.handle.includes(wanted) || person.displayName.toLowerCase().includes(wanted));
    // A handle nobody has opened yet can still be invited: they appear
    // when they first open Notes with `?as=` that handle.
    if (!found.some((person) => person.handle === wanted)) found.push(personOf(wanted));
    return found.slice(0, 10);
  },
};
