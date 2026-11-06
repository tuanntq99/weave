/* How this tab's writes stand. `durable`: every write the app made is in
   IndexedDB — kept through a reload or a closed tab — even if the server
   does not have it yet. `status`: what the save indicator says (remote mode
   sets it; locally a write is stored as soon as it is durable). */

export type SyncStatus = "saved" | "saving" | "offline" | "refused";

const listeners = new Set<() => void>();
let unstored = 0;
let status: SyncStatus = "saved";

const tell = () => {
  for (const listener of [...listeners]) listener();
};

export const sync = {
  get durable(): boolean {
    return unstored === 0;
  },
  get status(): SyncStatus {
    return status;
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/** Marks a write on its way into IndexedDB; calling the answer marks it there. */
export function beginStore(): () => void {
  unstored += 1;
  if (unstored === 1) tell();
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    unstored -= 1;
    if (unstored === 0) tell();
  };
}

/** Something else about sync changed (the sign-in ran out): listeners look again. */
export function tellSyncListeners(): void {
  tell();
}

export function setSyncStatus(next: SyncStatus): void {
  if (next === status) return;
  status = next;
  tell();
}
