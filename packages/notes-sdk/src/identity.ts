/* Who is signed in. There are no accounts: a person is a handle, chosen by
   the address (`?as=ada`), kept for the tab (sessionStorage) and as the
   browser's default (localStorage). Without one, "me". */

export interface Person {
  id: string;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
}

const KEY = "notes:as";

export function cleanHandle(value: string): string {
  return value.trim().replace(/^@/, "").toLowerCase().replace(/[^a-z0-9_.-]/g, "").slice(0, 40);
}

export function personOf(handle: string): Person {
  const clean = cleanHandle(handle) || "me";
  return {
    id: `u_${clean}`,
    handle: clean,
    displayName: clean === "me" ? "Me" : clean.charAt(0).toUpperCase() + clean.slice(1),
    avatarUrl: null,
  };
}

const storage = (kind: "sessionStorage" | "localStorage"): Storage | null => {
  try {
    return typeof window !== "undefined" ? window[kind] : null;
  } catch {
    return null;
  }
};

let current: Person | null = null;

type HandleStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** The key the handle was kept under before the SDK was renamed. */
const LEGACY_KEY = "weave-local:as";

/** Who a tab is: `?as=` in its address, else the handle the tab kept, else
 *  the browser's — carried over from before the rename once — else "me".
 *  Remembered for the tab and as the browser's default. */
export function chooseHandle(search: string, session: HandleStore | null, local: HandleStore | null): string {
  const legacy = local?.getItem(LEGACY_KEY);
  if (legacy && !local?.getItem(KEY)) local?.setItem(KEY, legacy);
  if (legacy) local?.removeItem(LEGACY_KEY);
  const handle = cleanHandle(new URLSearchParams(search).get("as") ?? "")
    || cleanHandle(session?.getItem(KEY) ?? "")
    || cleanHandle(local?.getItem(KEY) ?? "")
    || "me";
  session?.setItem(KEY, handle);
  local?.setItem(KEY, handle);
  return handle;
}

/** The person this tab is signed in as. */
export function me(): Person {
  if (current) return current;
  const search = typeof window !== "undefined" ? window.location.search : "";
  current = personOf(chooseHandle(search, storage("sessionStorage"), storage("localStorage")));
  return current;
}

/** Signs in as the person the server named (remote mode), remembered on
 *  this browser for a start with no network. */
export function signIn(person: Person): void {
  current = person;
  try {
    globalThis.localStorage?.setItem(REMEMBERED_KEY, JSON.stringify(person));
  } catch {
    // Storage refused (private mode, full): only an offline start misses it.
  }
}

const REMEMBERED_KEY = "notes:remote-person";

/** The person last signed in on this browser (remote mode), if any. */
export function rememberedPerson(): Person | null {
  try {
    const kept = JSON.parse(globalThis.localStorage?.getItem(REMEMBERED_KEY) ?? "null") as Person | null;
    return kept && typeof kept.id === "string" && typeof kept.handle === "string" ? kept : null;
  } catch {
    return null;
  }
}

/** Signs in as someone else: tests only. */
export function setMeForTests(handle: string): void {
  current = personOf(handle);
}

export const personalScope = (person: Person = me()) => `personal:${person.id}`;
export const spaceScope = (spaceId: string) => `space:${spaceId}`;
