import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { storage } from "../src/storage";

/** A browser's storage manager, and a localStorage, made to answer as told. */
function stubStorage(manager: Partial<StorageManager> | undefined): void {
  vi.stubGlobal("navigator", manager === undefined ? {} : { storage: manager });
}

beforeEach(() => {
  const kept = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => void kept.set(key, String(value)),
    removeItem: (key: string) => void kept.delete(key),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("storage.ensurePersistent", () => {
  it("asks once and remembers a refusal", async () => {
    const persist = vi.fn().mockResolvedValue(false);
    stubStorage({ persisted: async () => false, persist });
    expect(await storage.ensurePersistent()).toBe("denied");
    expect(await storage.ensurePersistent()).toBe("denied");
    expect(persist).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("notes:persist")).toBe("denied");
  });

  it("answers granted without asking when already persisted", async () => {
    const persist = vi.fn().mockResolvedValue(true);
    stubStorage({ persisted: async () => true, persist });
    expect(await storage.ensurePersistent()).toBe("granted");
    expect(persist).not.toHaveBeenCalled();
  });

  it("answers granted when the browser agrees", async () => {
    stubStorage({ persisted: async () => false, persist: async () => true });
    expect(await storage.ensurePersistent()).toBe("granted");
    expect(localStorage.getItem("notes:persist")).toBe("granted");
  });

  it("answers unsupported without navigator.storage", async () => {
    stubStorage(undefined);
    expect(await storage.ensurePersistent()).toBe("unsupported");
  });
});
