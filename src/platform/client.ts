import {
  files,
  people,
  ready,
  spaces,
  storage,
  backup,
  type EnteredSpace,
  type FileUrl,
  type Persistence,
  type Space,
  type SpacePresence,
} from "@notes/sdk";

import type {
  AppBootstrap,
  CollaboratorPresence,
  Person,
  PresenceState,
  SpaceMember,
  SpaceRoster,
  SpaceSummary,
} from "../core/types";

/** The bucket a shared page's files live in. Opened with the page's space,
 *  it is the space's: every member reads them whoever uploaded them — and
 *  they stay readable after that person leaves or is removed. A private
 *  page's files stay in the member's own data store. */
export const SHARED_FILES_BUCKET = "page_files";

export interface PlatformClient {
  readonly bootstrap: AppBootstrap;
  /** Who is on which page of a space: the page's presence there, once it has
   *  entered the space (`spaces.enter`). */
  presence: {
    set(state: PresenceState | null, spaceId?: string): Promise<void>;
    watch(
      listener: (presence: CollaboratorPresence[]) => void,
      spaceId?: string,
    ): Promise<() => void>;
    /** Leaves a space once the member is no longer in it. */
    release(spaceId: string): Promise<void>;
  };
  users: {
    search(query: string): Promise<Person[]>;
  };
  /** Bytes for image and file blocks: the member's private store, or the
   *  space's `SHARED_FILES_BUCKET` when `spaceId` is given. */
  files: {
    write(path: string, bytes: Blob, options: { spaceId?: string; mediaType: string }): Promise<void>;
    read(path: string, options: { spaceId?: string }): Promise<Blob>;
    /** The bytes on screen, read once a session however many views show
     *  them (the SDK's `url`), held for the view until `release()`. */
    url(path: string, options: { spaceId?: string }): FileUrl;
  };
  spaces: {
    create(name: string): Promise<{ spaceId: string; name: string }>;
    /** Every space this member belongs to that has Notes in it, with their
     *  role there and what that role lets them do. */
    installations(): Promise<SpaceSummary[]>;
    /** That list now, and again whenever it changes — a space joined (one
     *  this window made too) or left, or the member's role in one changed. */
    watchInstallations(listener: (spaces: SpaceSummary[]) => void): Promise<() => void>;
    /** Who is in the space now, read afresh. */
    members(spaceId: string): Promise<SpaceMember[]>;
    /** Who is in a space and who has been asked in — now, and again when
     *  either changes there, and only then. */
    watchRoster(spaceId: string, listener: (roster: SpaceRoster) => void): Promise<() => void>;
    invite(spaceId: string, handle: string, role: "admin" | "editor" | "viewer"): Promise<{ created: boolean }>;
    /** Owner and admins only; only the owner gives or takes Full access.
     *  Moves a member between Full access (admin), Can edit (editor) and Can
     *  view (viewer). */
    updateRole(spaceId: string, userId: string, role: "admin" | "editor" | "viewer"): Promise<void>;
    /** Owner and admins only; never the owner. Their access ends at once. */
    removeMember(spaceId: string, userId: string): Promise<void>;
    /** Anyone but the owner. */
    leave(spaceId: string): Promise<void>;
  };
  /** Whether the browser keeps Notes' data when it runs short of space:
   *  asked once, the answer remembered. */
  storage: {
    ensurePersistent(): Promise<Persistence>;
  };
  /** Everything this browser keeps for Notes, as one file, and back:
   *  `merge` adds what is not here yet; `replace` makes the file all there is. */
  backup: {
    export(): Promise<Blob>;
    import(file: Blob, mode: "merge" | "replace"): Promise<{ records: number; files: number }>;
  };
  close(): Promise<void>;
}

function summary(space: Space): SpaceSummary {
  return {
    spaceId: space.id,
    name: space.name,
    role: space.myRole,
    canInvite: space.capabilities.canInvite,
    canManageRoles: space.capabilities.canManageRoles,
    canRemoveMembers: space.capabilities.canRemoveMembers,
    canLeave: space.capabilities.canLeave,
  };
}

export async function createPlatformClient(): Promise<PlatformClient> {
  const info = await ready();
  if (info.guest) throw new Error("Sign in, then open Weave again.");

  const bootstrap: AppBootstrap = {
    appId: info.appId,
    installationId: info.installationId,
    appName: info.name,
    user: info.user,
  };
  const entered = new Map<string, Promise<EnteredSpace<PresenceState>>>();

  const enter = (spaceId: string): Promise<EnteredSpace<PresenceState>> => {
    let opening = entered.get(spaceId);
    if (!opening) {
      const attempt = spaces.enter<PresenceState>(spaceId);
      // A space that could not be entered is not kept, or a member invited
      // back would have no presence there until the app reloaded.
      attempt.catch(() => {
        if (entered.get(spaceId) === attempt) entered.delete(spaceId);
      });
      entered.set(spaceId, attempt);
      opening = attempt;
    }
    return opening;
  };

  const mapPresence = (snapshot: SpacePresence<PresenceState>): CollaboratorPresence[] => {
    const online = new Set(snapshot.online);
    return [...new Set([...snapshot.online, ...Object.keys(snapshot.states)])].map((userId) => ({
      userId,
      online: online.has(userId),
      state: snapshot.states[userId],
    }));
  };

  const bucket = (spaceId: string) => files.bucket(SHARED_FILES_BUCKET).in(spaceId);

  return {
    bootstrap,
    storage: { ensurePersistent: () => storage.ensurePersistent() },
    backup: { export: () => backup.exportAll(), import: (file, mode) => backup.importAll(file, mode) },
    presence: {
      async set(state, spaceId) {
        // Clearing the presence of a space not entered has nothing to clear,
        // and entering it to do so would knock on a space the member may
        // have just left.
        if (!spaceId || (state === null && !entered.has(spaceId))) return;
        await (await enter(spaceId)).setPresence(state);
      },
      async watch(listener, spaceId) {
        if (!spaceId) {
          listener([]);
          return () => undefined;
        }
        // The space read who is here as the page entered and keeps it current
        // from its frames (and reads again after a gap): what it holds is now.
        const space = await enter(spaceId);
        const unsubscribe = space.subscribePresence((snapshot) => listener(mapPresence(snapshot)));
        listener(mapPresence(space.presence));
        return unsubscribe;
      },
      async release(spaceId) {
        const opening = entered.get(spaceId);
        if (!opening) return;
        entered.delete(spaceId);
        await opening.then((space) => space.close()).catch(() => undefined);
      },
    },
    users: {
      async search(query) {
        if (!query.trim()) return [];
        return people.search(query.trim().replace(/^@/, ""));
      },
    },
    files: {
      async write(path, bytes, { spaceId, mediaType }) {
        if (spaceId) await bucket(spaceId).write(path, bytes, { contentType: mediaType });
        else await files.write(path, bytes, { mediaType });
      },
      async read(path, { spaceId }) {
        return spaceId ? bucket(spaceId).read(path) : files.read(path);
      },
      url(path, { spaceId }) {
        return spaceId ? bucket(spaceId).url(path) : files.url(path);
      },
    },
    spaces: {
      async create(name) {
        const { space } = await spaces.create({ name });
        return { spaceId: space.id, name: space.name };
      },
      async installations() {
        return (await spaces.list()).map(summary);
      },
      async watchInstallations(listener) {
        const live = await spaces.live();
        const unsubscribe = live.subscribe((list) => listener(list.map(summary)));
        return () => {
          unsubscribe();
          void live.close().catch(() => undefined);
        };
      },
      members(spaceId) {
        return spaces.members.list(spaceId);
      },
      async watchRoster(spaceId, listener) {
        const live = await spaces.members.live(spaceId);
        const unsubscribe = live.subscribe((roster) => listener({ members: [...roster.members], invitations: [...roster.invitations] }));
        return () => {
          unsubscribe();
          void live.close().catch(() => undefined);
        };
      },
      invite(spaceId, handle, role) {
        return spaces.members.invite(spaceId, handle, role);
      },
      async updateRole(spaceId, userId, role) {
        await spaces.members.update(spaceId, userId, role);
      },
      removeMember(spaceId, userId) {
        return spaces.members.remove(spaceId, userId);
      },
      leave(spaceId) {
        return spaces.leave(spaceId);
      },
    },
    async close() {
      await Promise.all([...entered.values()].map(async (opening) => (await opening).close().catch(() => undefined)));
      entered.clear();
    },
  };
}
