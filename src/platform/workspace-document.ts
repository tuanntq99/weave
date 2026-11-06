import { applyMutation, emptyWorkspace, isWorkspaceMutation } from "../core/workspace-state";
import { sdkConfig, sync, type RichText } from "@notes/sdk";
import { storedRuns } from "../core/stored-runs";
import type { SpaceSummary, WorkspaceMutation, WorkspaceState } from "../core/types";
import type { PlatformClient } from "./client";
import { Plane } from "./plane";
import { blockRecordId } from "./record-ids";
import {
  pageOfRef,
  pageRecords,
  planeOfPage,
  PERSONAL,
  Projector,
  recordIn,
  recordsOfPath,
  refKey,
  writeFor,
  type PlaneRecords,
  type RecordRef,
} from "./records";

export type { WorkspaceMutation } from "../core/types";

/** How often a page's "last edited" is written while someone keeps writing
 *  in it. */
export const STAMP_INTERVAL_MS = 30_000;
/** How long `flush` waits for writes still on their way before it says they
 *  are not saved yet. */
const FLUSH_WAIT_MS = 10_000;

const stampField = (mutation: WorkspaceMutation): "updated_at" | "updated_by" | null => (
  mutation.path.length === 3 && mutation.path[0] === "pages" && (mutation.path[2] === "updated_at" || mutation.path[2] === "updated_by")
    ? mutation.path[2]
    : null
);

/** The writes without the "last edited" stamps that would say nothing new:
 *  a page written in again by the same person within STAMP_INTERVAL_MS
 *  keeps the stamp it has. */
export function withoutFreshStamps(state: WorkspaceState, mutations: readonly WorkspaceMutation[]): WorkspaceMutation[] {
  const fresh = new Set<string>();
  for (const mutation of mutations) {
    if (mutation.type !== "set" || stampField(mutation) !== "updated_at" || typeof mutation.value !== "string") continue;
    const pageId = mutation.path[1];
    const page = state.pages[pageId];
    const by = mutations.find((other) => other.type === "set" && stampField(other) === "updated_by" && other.path[1] === pageId)?.value;
    const since = page ? Date.parse(mutation.value) - Date.parse(page.updated_at) : Number.NaN;
    if (page && page.updated_by === by && since >= 0 && since < STAMP_INTERVAL_MS) fresh.add(pageId);
  }
  if (!fresh.size) return [...mutations];
  return mutations.filter((mutation) => !(stampField(mutation) && fresh.has(mutation.path[1])));
}

/** The record and rich-text field a mutation's `base` is for, with the runs
 *  as a record keeps them: a paragraph's words, or a page's name. */
function baseOf(mutation: WorkspaceMutation): [string, Record<string, RichText>] | null {
  const [root, pageId, field, list, blockId] = mutation.path;
  if (!mutation.base || root !== "pages" || !pageId) return null;
  if (field === "block_tree" && list === "by_id" && blockId) {
    return [refKey({ collection: "blocks", id: blockRecordId(pageId, blockId) }), { content: storedRuns(mutation.base) }];
  }
  if (field === "title" || field === "title_content") return [refKey({ collection: "pages", id: pageId }), { title_content: storedRuns(mutation.base) }];
  return null;
}

/** Where this window's writes are: all stored, some on their way, waiting
 *  for the connection, or some refused for good (too large to store, not a
 *  shape the platform takes, a change to a record someone else deleted) and
 *  taken back, so the rest are saved. */
export type SyncStatus = "saved" | "saving" | "offline" | "refused";

/** A change the window did not keep: one to a page this member may only
 *  view there (`read_only`, never shown nor sent), or one the platform
 *  refused for good and took back (`refused`). */
/** How long a refusal keeps the window reading "refused" without another
 *  (`quietMs`), and how often one page's refusals are told (`toastMs`). */
export const REFUSAL_TIMING = { quietMs: 5000, toastMs: 2000 };

export interface Refusal {
  pageId?: string;
  reason: "read_only" | "refused";
}

/** Notes' workspace in this window, made from the records of the member's
 *  own plane and of every space whose pages they read (records.ts).

 *  A change is made here at once and handed, record by record, to the
 *  plane's live collections (plane.ts): the fields that changed, each a
 *  top-level field of its record, as a patch — a paragraph's words and a
 *  page's name with the runs the window showed as their base, so the SDK
 *  merges them with whatever anyone else typed meanwhile. The collections
 *  show the write until it lands, then the record as it was merged. */
export class WorkspaceDocument {
  readonly platform: PlatformClient;
  state: WorkspaceState = emptyWorkspace();

  private readonly projector = new Projector();
  /** The planes being read, by key: PERSONAL, or a space's id. */
  private readonly planes = new Map<string, Plane>();
  /** What each plane holds, as its live records say. */
  private readonly held = new Map<string, PlaneRecords>();
  private readonly stops = new Map<string, () => void>();
  /** Spaces being opened, so one is never read twice: each one's opening,
   *  which every caller waits for. */
  private readonly opening = new Map<string, Promise<void>>();
  private readonly listeners = new Set<(state: WorkspaceState) => void>();
  private readonly syncListeners = new Set<(status: SyncStatus) => void>();
  private readonly refusalListeners = new Set<(refusal: Refusal) => void>();
  private syncStatus: SyncStatus = "saved";
  /** Writes handed to a plane and not yet settled. */
  private readonly writing = new Set<Promise<void>>();
  /** When each recent refusal came: the window reads "refused" while any is
   *  left — until a later write is stored, or a quiet while passes. */
  private refused: number[] = [];
  private readonly stopSync: () => void;
  /** How many writes were refused in this window, ever: what `flush` counts. */
  private refusals = 0;
  private quietTimer: ReturnType<typeof setTimeout> | null = null;
  /** When each page's refusal was last told. */
  private readonly toldAt = new Map<string, number>();
  /** Spaces this member may only read (Can view): nothing is sent there. */
  private readonly readOnly = new Set<string>();
  private loading = true;
  private projecting = false;
  private closed = false;

  private constructor(platform: PlatformClient) {
    this.platform = platform;
    this.stopSync = sync.subscribe(() => this.updateSyncStatus());
  }

  static async open(platform: PlatformClient): Promise<WorkspaceDocument> {
    const document = new WorkspaceDocument(platform);
    const spaceIds = await document.discoverSpaces();
    await document.watch(PERSONAL);
    await Promise.all(spaceIds.map((spaceId) => document.watchSpace(spaceId)));
    document.loading = false;
    document.reproject(false);
    return document;
  }

  /** The spaces this member's Notes can read: every page tree shared with
   *  them, and every one they shared. Empty when the platform cannot say. */
  private async discoverSpaces(): Promise<string[]> {
    try {
      const installations = await this.platform.spaces.installations();
      // Where this member may only view is known before anything is shown,
      // so no change of theirs there is ever made.
      for (const installation of installations) if (installation.role === "viewer") this.readOnly.add(installation.spaceId);
      return [...new Set(installations.map((installation) => installation.spaceId).filter(Boolean))];
    } catch {
      return [];
    }
  }

  private async watch(key: string): Promise<void> {
    const plane = await Plane.open(key === PERSONAL ? undefined : key);
    if (this.closed || (key !== PERSONAL && !this.opening.has(key))) {
      void plane.close();
      return;
    }
    this.planes.set(key, plane);
    this.stops.set(key, plane.watch((records) => this.heard(key, records)));
  }

  /** Reads a space, or waits for the reading of it already under way: a
   *  page shared into a space just made (whose live list may already be
   *  opening it) is written there only once its plane is open, or the write
   *  would find no plane and the page would stay where it was. */
  private watchSpace(spaceId: string): Promise<void> {
    if (this.closed || this.planes.has(spaceId)) return Promise.resolve();
    let opening = this.opening.get(spaceId);
    if (!opening) {
      opening = this.watch(spaceId)
        // A space that cannot be read now is read again when it is next added.
        .catch(() => undefined)
        .finally(() => this.opening.delete(spaceId));
      this.opening.set(spaceId, opening);
    }
    return opening;
  }

  /** What a plane holds now, this window's writes included. */
  private heard(key: string, records: PlaneRecords): void {
    if (this.closed) return;
    this.held.set(key, records);
    this.scheduleProjection();
  }

  private scheduleProjection(): void {
    if (this.loading || this.projecting) return;
    this.projecting = true;
    queueMicrotask(() => {
      this.projecting = false;
      if (!this.closed) this.reproject();
    });
  }

  /** The workspace made again from what the planes hold. */
  private reproject(notify = true): void {
    this.state = this.projector.project(this.held);
    if (notify) this.notify();
  }

  /** Starts reading a space: one this member just shared a page into, or one
   *  that has been shared with them since the window opened. */
  async addSpace(spaceId: string): Promise<void> {
    await this.watchSpace(spaceId);
  }

  /** Stops reading a space this member no longer belongs to — they left, or
   *  were removed. Everything that lives there leaves the workspace with it,
   *  their own writes to it too: those were stored in the space, and a
   *  window opened now would not have them either. */
  removeSpace(spaceId: string): void {
    const plane = this.planes.get(spaceId);
    if (!plane) return;
    this.planes.delete(spaceId);
    this.stops.get(spaceId)?.();
    this.stops.delete(spaceId);
    this.held.delete(spaceId);
    void plane.close();
    // The page leaves the space too: being in it says the member is looking
    // at it, and the space puts out a page whose member it no longer has.
    void this.platform.presence.release(spaceId);
    this.reproject();
  }

  /** Brings the spaces being read in line with the ones the member belongs
   *  to, and with what they may do in each — as given, or as the platform
   *  says now. False when the platform could not say. */
  async refreshSpaces(known?: readonly SpaceSummary[]): Promise<boolean> {
    if (this.closed) return false;
    let list = known;
    if (!list) {
      try {
        list = await this.platform.spaces.installations();
      } catch {
        return false;
      }
    }
    // Moved to Can view, this member writes nothing more there.
    this.readOnly.clear();
    for (const space of list) if (space.role === "viewer") this.readOnly.add(space.spaceId);
    const current = new Set(list.map((space) => space.spaceId));
    for (const spaceId of [...this.planes.keys()]) if (spaceId !== PERSONAL && !current.has(spaceId)) this.removeSpace(spaceId);
    for (const spaceId of current) await this.addSpace(spaceId);
    return true;
  }

  /* Every record goes to the plane its page lives in: the member's own for a
     private page (and for the page list and preferences), the page's space
     for a shared one — so each page has one home, and everyone who can read
     the space reads the same page. A change that carries a page from one
     plane to another (sharing it, moving it into or out of a shared tree,
     stopping sharing) writes the page — with everything under it — whole
     into the plane it entered, and deletes it from the one it left; a page
     shared from the member's own plane leaves its record there, which says
     where it stands among their pages. */
  transact(requested: WorkspaceMutation[]): void {
    if (this.closed) throw new Error("Workspace is closed");
    const mutations = withoutFreshStamps(this.state, requested).filter(isWorkspaceMutation);
    if (!mutations.length) return;
    const before = this.state;
    let next = before;
    const touched = new Map<string, RecordRef>();
    const readOnlyPages = new Set<string>();
    for (const mutation of mutations) {
      // A change that lands in a space this member may only view is never
      // made: shown here, it would be a change nothing ever stores.
      const after = applyMutation(next, mutation);
      const refs = [...recordsOfPath(next, mutation.path), ...recordsOfPath(after, mutation.path)];
      const blocked = refs.find((ref) => this.inReadOnly(next, ref) || this.inReadOnly(after, ref));
      if (blocked) {
        readOnlyPages.add(pageOfRef(blocked) ?? "");
        continue;
      }
      for (const ref of refs) touched.set(refKey(ref), ref);
      next = after;
    }
    for (const pageId of readOnlyPages) this.refuse({ ...(pageId ? { pageId } : {}), reason: "read_only" });
    if (next === before) return;
    this.state = next;
    const bases = new Map(mutations.flatMap((mutation) => {
      const base = baseOf(mutation);
      return base ? [base] : [];
    }));
    const carried = new Set<string>();
    for (const ref of touched.values()) {
      if (ref.collection !== "pages") continue;
      const from = planeOfPage(before, ref.id);
      const to = planeOfPage(next, ref.id);
      if (from && to && from !== to) for (const id of this.descendantPages(ref.id)) carried.add(id);
    }
    for (const ref of touched.values()) {
      const page = pageOfRef(ref);
      const plane = page === undefined ? PERSONAL : planeOfPage(next, page) ?? planeOfPage(before, page);
      if (!plane || (page && carried.has(page))) continue;
      this.write(plane, ref, false, bases.get(refKey(ref)));
    }
    for (const pageId of carried) {
      const from = planeOfPage(before, pageId);
      const to = planeOfPage(next, pageId);
      if (!from || !to || from === to) continue;
      for (const ref of new Map([...pageRecords(before, pageId), ...pageRecords(next, pageId)].map((ref) => [refKey(ref), ref])).values()) {
        this.write(to, ref, true);
        // Deleted there — but for a page shared from the member's own
        // plane, whose record stays (`recordIn`).
        this.write(from, ref, true);
      }
    }
    this.notify();
  }

  /** Hands a record's change to its plane: a put where the plane does not
   *  show it (or it goes whole), a delete where it is gone, else a patch of
   *  what changed since the window drew it — its rich text from `base` when
   *  the change started from other runs than the plane shows. */
  private write(key: string, ref: RecordRef, whole: boolean, base?: Record<string, RichText>): void {
    const plane = this.planes.get(key);
    if (!plane || this.readOnly.has(key)) return;
    const shown = plane.get(ref);
    const after = recordIn(this.state, key, ref);
    const changed = after ? writeFor(ref, whole ? undefined : shown, after) : shown ? writeFor(ref, shown, undefined) : null;
    const write = changed?.action === "patch" && base && Object.keys(base).some((field) => field in changed.patch) ? { ...changed, base } : changed;
    if (!write) return;
    const started = Date.now();
    const pageId = pageOfRef(ref);
    const tracked: Promise<void> = plane.write(write).then(
      () => {
        // Stored after a refusal: what was refused before it is behind us.
        this.refused = this.refused.filter((at) => at > started);
      },
      () => {
        // A plane let go of (a space left) drops what was on its way there;
        // anything else was refused for good, and its collection took it back.
        if (this.planes.get(key) === plane && !this.closed) this.noteRefusal(pageId);
      },
    ).finally(() => {
      this.writing.delete(tracked);
      this.updateSyncStatus();
    });
    this.writing.add(tracked);
    this.updateSyncStatus();
  }

  onChange(listener: (state: WorkspaceState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener(this.state);
  }

  private updateSyncStatus(): void {
    // With a server, its socket knows best whether writes are on their way
    // or waiting for the network; a refusal is still this document's.
    const remote = sdkConfig().mode === "remote";
    const next: SyncStatus = this.refused.length && !this.writing.size ? "refused"
      : remote ? sync.status
      : this.writing.size ? (globalThis.navigator?.onLine === false ? "offline" : "saving")
      : "saved";
    if (next === this.syncStatus) return;
    this.syncStatus = next;
    for (const listener of this.syncListeners) listener(next);
  }

  /** Whether there are writes not stored yet. */
  /** Whether closing now would lose a write. With a server, a write in the
   *  outbox is kept through a closed tab: only one not yet in IndexedDB is. */
  get unsaved(): boolean {
    return sdkConfig().mode === "remote" ? !sync.durable : this.writing.size > 0;
  }

  /** Whether this member may change a page: not where they may only view. */
  canWrite(pageId: string): boolean {
    const plane = planeOfPage(this.state, pageId);
    return plane === undefined || !this.readOnly.has(plane);
  }

  private noteRefusal(pageId: string | undefined): void {
    const now = Date.now();
    this.refusals += 1;
    this.refused.push(now);
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => {
      this.quietTimer = null;
      this.refused = [];
      this.updateSyncStatus();
    }, REFUSAL_TIMING.quietMs);
    this.refuse({ ...(pageId ? { pageId } : {}), reason: "refused" });
  }

  /** Told of each change the window did not keep. */
  onRefused(listener: (refusal: Refusal) => void): () => void {
    this.refusalListeners.add(listener);
    return () => this.refusalListeners.delete(listener);
  }

  /** Tells of a change the window did not keep — once per page and reason
   *  in each REFUSAL_TIMING.toastMs, however many came. */
  private refuse(refusal: Refusal): void {
    const key = `${refusal.reason}|${refusal.pageId ?? ""}`;
    const now = Date.now();
    const told = this.toldAt.get(key);
    if (told !== undefined && now - told < REFUSAL_TIMING.toastMs) return;
    this.toldAt.set(key, now);
    if (import.meta.env?.DEV) console.warn(`[notes] Not kept (${refusal.reason}):`, refusal.pageId ?? "");
    for (const listener of [...this.refusalListeners]) listener(refusal);
  }

  /** Whether a record lives, in `state`, in a space this member may only view. */
  private inReadOnly(state: WorkspaceState, ref: RecordRef): boolean {
    const pageId = pageOfRef(ref);
    if (!pageId) return false;
    const plane = planeOfPage(state, pageId);
    return plane !== undefined && this.readOnly.has(plane);
  }

  onSyncStatus(listener: (status: SyncStatus) => void): () => void {
    this.syncListeners.add(listener);
    listener(this.syncStatus);
    return () => this.syncListeners.delete(listener);
  }

  /** Resolves once every write so far is stored. Throws when one was refused
   *  meanwhile, or when some are still on their way after FLUSH_WAIT_MS: they
   *  go on trying. */
  async flush(): Promise<void> {
    const refused = this.refusals;
    const deadline = Date.now() + FLUSH_WAIT_MS;
    while (this.writing.size && Date.now() < deadline) {
      await Promise.race([
        Promise.all([...this.writing]),
        new Promise((resolve) => globalThis.setTimeout(resolve, Math.max(0, deadline - Date.now()))),
      ]);
    }
    if (this.refusals > refused) throw new Error("Some of these changes were refused: they were taken back.");
    if (this.writing.size) throw new Error("Some changes are not saved yet: they go on trying.");
  }

  /** A page and every page under it. */
  private descendantPages(rootId: string): string[] {
    const ids: string[] = [];
    const seen = new Set<string>();
    const queue = [rootId];
    while (queue.length) {
      const id = queue.shift()!;
      if (seen.has(id) || !this.state.pages[id]) continue;
      seen.add(id);
      ids.push(id);
      for (const child of Object.values(this.state.pages)) if (child.parent_id === id) queue.push(child.id);
    }
    return ids;
  }

  /** Shares a page tree through a space: the space is read first,
   *  then the page's home becomes it, so it is copied in whole (see
   *  `transact`), and from then on every member of the space reads and
   *  writes it there. */
  async sharePageTree(pageId: string, spaceId: string): Promise<void> {
    const page = this.state.pages[pageId];
    if (!page) throw new Error("Page no longer exists");
    await this.addSpace(spaceId);
    if (page.share_space_id !== spaceId) this.transact([{ type: "set", path: ["pages", pageId, "share_space_id"], value: spaceId }]);
    await this.flush();
  }

  /** Stops sharing a page tree: it comes back to the member's own plane, whole,
   *  and leaves the space, whose members lose it. */
  async stopSharing(pageId: string): Promise<void> {
    if (!this.state.pages[pageId]?.share_space_id) return;
    this.transact([{ type: "delete", path: ["pages", pageId, "share_space_id"] }]);
    await this.flush();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    try {
      await this.flush();
    } finally {
      // A last save that fails goes on trying in the collections' own queue
      // for as long as the page is open; a document nobody holds stops here.
      this.closed = true;
      for (const stop of this.stops.values()) stop();
      this.stops.clear();
      for (const plane of this.planes.values()) void plane.close();
      this.planes.clear();
      this.listeners.clear();
      this.syncListeners.clear();
      this.refusalListeners.clear();
      this.stopSync();
      if (this.quietTimer) clearTimeout(this.quietTimer);
      this.quietTimer = null;
    }
  }
}
