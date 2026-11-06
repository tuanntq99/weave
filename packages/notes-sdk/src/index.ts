/* @notes/sdk: what Notes builds on, answered in
   the browser. Records and files live in IndexedDB; other tabs, each
   signed in as someone (`?as=<handle>`), are the collaborators. */

import { isRemote, sdkConfig } from "./config";
import { uploadWaitingFiles } from "./files";
import { me, rememberedPerson, signIn, type Person } from "./identity";
import { closeSpaceRemotes, rememberedSharing, setSharing, sharingOn, spaceRemote } from "./remote-spaces";
import { connectScope, type RemoteScope } from "./remote";
import { sync } from "./sync";
import { localTransport, setTransports } from "./transport";
import { knownPerson, people_ } from "./spaces";

export { t, type Infer, type InferShape, type RichText, type RichTextRun } from "./fields";
export { schema, type App, type Handlers } from "./schema";
export type { CollectionHandle, LiveCollection, LiveRow, RecordPatch } from "./live";
export { files, type FileUrl, type Bucket } from "./files";
export { spaces, type Space, type SpaceMember, type SpaceRoster, type SpaceInvitation, type SpacePresence, type EnteredSpace } from "./spaces";
export type { Person } from "./identity";
export { storage, type Persistence } from "./storage";
export { backup } from "./backup";
export { sync, type SyncStatus } from "./sync";
export { configureSdk, sdkConfig } from "./config";
export { outbox } from "./outbox";
export { uploadWaitingFiles } from "./files";

export const people = people_;

export interface ReadyInfo {
  guest: boolean;
  appId: string;
  installationId: string | null;
  name: string;
  user: Person;
}

/** Who is signed in, once the browser knows them. */
export async function ready(): Promise<ReadyInfo> {
  if (isRemote()) return readyRemote();
  const user = me();
  await knownPerson(user.handle);
  return { guest: false, appId: "@tuanntq/notes", installationId: null, name: "Weave", user };
}

let remote: RemoteScope | null = null;

/** Who the server says is signed in; then the person's own scope is kept in
 *  step with it, and files waiting to go up are sent. */
async function readyRemote(): Promise<ReadyInfo> {
  const { url } = sdkConfig();
  const unreachable = () => Object.assign(new Error("Weave could not reach its server."), { code: "unreachable", retryable: true });
  let user: Person;
  let sharing = rememberedSharing();
  try {
    const response = await fetch(`${url}/api/me`, { credentials: "include" });
    if (response.status === 401 || response.status === 403) {
      throw Object.assign(new Error("Your sign-in has ended: sign in again."), { code: "signed_out", retryable: false });
    }
    if (!response.ok) throw unreachable();
    const { sharing: on, ...person } = await response.json() as Person & { sharing?: boolean };
    user = person;
    sharing = on === true;
  } catch (error) {
    // No network (the app opened from the service worker's copy): the
    // person last signed in here, their writes kept until the server is
    // back — a lapsed sign-in is found then (checkSignIn).
    const known = error instanceof TypeError ? rememberedPerson() : null;
    if (!known) throw error instanceof TypeError ? unreachable() : error;
    user = known;
  }
  signIn(user);
  setSharing(sharing);
  const scope = `personal:${user.id}`;
  remote?.close();
  closeSpaceRemotes();
  remote = connectScope(scope, { url, checkSignIn: () => stillSignedIn(url) });
  const mine = remote;
  // A space's records go through its own socket (spec S5c), sharing on.
  setTransports((bucket) => (bucket.startsWith(`${scope}|`) ? mine
    : sharingOn() && bucket.startsWith("space:") ? spaceRemote(bucket.slice(0, bucket.indexOf("|")))
    : localTransport));
  void uploadWaitingFiles();
  watchForTheServer();
  return { guest: false, appId: "@tuanntq/notes", installationId: null, name: "Weave", user };
}

/** Deletes this browser's copy of Notes and its people, unless something
 *  is still owed to the server: then nothing is touched. */
export async function forgetThisDevice(): Promise<"cleared" | "pending"> {
  const { db, done } = await import("./db");
  const database = await db();
  const transaction = database.transaction(["outbox", "outbox_files"]);
  const owed = (await done(transaction.objectStore("outbox").count()) as number)
    + (await done(transaction.objectStore("outbox_files").count()) as number);
  if (owed > 0) return "pending";
  database.close();
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase("notes");
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  });
  return "cleared";
}

/** Whether /api/me still knows who this is: Access answers a lapsed
 *  sign-in with a redirect to its login. Out of reach reads as yes. */
async function stillSignedIn(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/api/me`, { credentials: "include", redirect: "manual" });
    return !(response.type === "opaqueredirect" || response.status === 401 || response.status === 403);
  } catch {
    return true;
  }
}

let watching = false;

/** Files owed go up when the network returns, or the socket does after
 *  being offline (the server reachable again) — watched once per page. */
function watchForTheServer(): void {
  if (watching) return;
  watching = true;
  globalThis.addEventListener?.("online", () => void uploadWaitingFiles());
  let was = sync.status;
  sync.subscribe(() => {
    if (was === "offline" && sync.status !== "offline") void uploadWaitingFiles();
    was = sync.status;
  });
}

/** Whether the server said the sign-in ran out. */
export const signedOut = (): boolean => remote?.signedOut ?? false;

/** The places the window is asked to go to. Here only the browser's own
 *  back and forward, and `notes:route` events, ask. */
export const routes = {
  listen(listener: (route: string) => void): () => void {
    const onPop = () => listener(window.location.pathname + window.location.search + window.location.hash);
    const onRoute = (event: Event) => listener(String((event as CustomEvent).detail ?? "/"));
    window.addEventListener("popstate", onPop);
    window.addEventListener("notes:route", onRoute);
    return () => {
      window.removeEventListener("popstate", onPop);
      window.removeEventListener("notes:route", onRoute);
    };
  },
};

/** What the app tells its maintainers: the console, here. */
export const log = {
  async error(message: string, context?: unknown) {
    console.error(`[notes] ${message}`, context ?? "");
  },
  async warn(message: string, context?: unknown) {
    console.warn(`[notes] ${message}`, context ?? "");
  },
  async info(message: string, context?: unknown) {
    console.info(`[notes] ${message}`, context ?? "");
  },
};

/** The platform's fonts: none here; the stylesheet's fallbacks stand. */
export const fonts = {
  async load(_family: string): Promise<void> {},
};

/** Whether trying again may help: a write or read that could not get
 *  through, not one refused. */
export function isRetryable(error: unknown): boolean {
  return (error as { retryable?: unknown } | null)?.retryable === true;
}
