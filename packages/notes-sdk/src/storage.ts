/* Whether the browser keeps Notes' data when it runs short of space. By
   default a site's storage is "best effort" and may be cleared; a persistent
   one is kept until the person clears it. The browser is asked once; its
   answer is remembered, so a refusal is not asked again every visit. */

const KEY = "notes:persist";

export type Persistence = "granted" | "denied" | "unsupported";

function remembered(): string | null {
  try {
    return globalThis.localStorage?.getItem(KEY) ?? null;
  } catch {
    return null;
  }
}

function remember(answer: "granted" | "denied"): void {
  try {
    globalThis.localStorage?.setItem(KEY, answer);
  } catch {
    // A browser that keeps nothing: asked again next time.
  }
}

export const storage = {
  async ensurePersistent(): Promise<Persistence> {
    const manager = globalThis.navigator?.storage;
    if (!manager?.persist || !manager.persisted) return "unsupported";
    if (await manager.persisted()) return "granted";
    if (remembered() === "denied") return "denied";
    const answer = (await manager.persist()) ? "granted" : "denied";
    remember(answer);
    return answer;
  },
};
