import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportOverdue } from "./data-export";

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

describe("exportOverdue", () => {
  it("is overdue with no export and after seven days", () => {
    expect(exportOverdue()).toBe(true);
    localStorage.setItem("notes:lastExport", new Date(Date.now() - 6 * 86400e3).toISOString());
    expect(exportOverdue()).toBe(false);
    localStorage.setItem("notes:lastExport", new Date(Date.now() - 8 * 86400e3).toISOString());
    expect(exportOverdue()).toBe(true);
  });

  it("treats a stored value that is no date as never exported", () => {
    localStorage.setItem("notes:lastExport", "garbage");
    expect(exportOverdue()).toBe(true);
  });
});

describe("downloadBlob", () => {
  it("keeps the file's address alive long enough for the browser to save it", async () => {
    vi.useFakeTimers();
    const revoke = vi.fn();
    const click = vi.fn();
    vi.stubGlobal("URL", { createObjectURL: () => "blob:x", revokeObjectURL: revoke });
    vi.stubGlobal("document", { createElement: () => ({ click, href: "", download: "" }) });
    const { downloadBlob } = await import("./data-export");
    downloadBlob(new Blob(["x"]), "notes-backup-2026-11-05.json");
    expect(click).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(revoke).toHaveBeenCalledWith("blob:x");
    vi.useRealTimers();
  });
});
