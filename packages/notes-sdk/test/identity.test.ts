import { describe, expect, it } from "vitest";
import { chooseHandle } from "../src/identity";

const store = (entries: Record<string, string> = {}) => {
  const kept = new Map(Object.entries(entries));
  return {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => void kept.set(key, value),
    removeItem: (key: string) => void kept.delete(key),
    kept,
  };
};

describe("chooseHandle", () => {
  it("takes the address's ?as= first, then the tab's, then the browser's", () => {
    expect(chooseHandle("?as=Ada", store({ "notes:as": "tab" }), store({ "notes:as": "browser" }))).toBe("ada");
    expect(chooseHandle("", store({ "notes:as": "tab" }), store({ "notes:as": "browser" }))).toBe("tab");
    expect(chooseHandle("", store(), store({ "notes:as": "browser" }))).toBe("browser");
    expect(chooseHandle("", store(), store())).toBe("me");
  });

  it("carries over the handle the browser kept before the rename", () => {
    const local = store({ "weave-local:as": "grace" });
    expect(chooseHandle("", store(), local)).toBe("grace");
    expect(local.kept.get("notes:as")).toBe("grace");
    expect(local.kept.has("weave-local:as")).toBe(false);
  });

  it("keeps working without storage", () => {
    expect(chooseHandle("", null, null)).toBe("me");
  });
});
