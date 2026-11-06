import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureSdk, sdkConfig } from "../src/config";
import { files, uploadWaitingFiles } from "../src/files";
import { me } from "../src/identity";
import { ready } from "../src/index";
import { spaces } from "../src/spaces";

const URL_BASE = "https://notes.test";
const person = { id: "u_0123456789abcdef", handle: "ada", displayName: "Ada", avatarUrl: null };

beforeEach(() => {
  configureSdk({ mode: "remote", url: URL_BASE });
});

afterEach(() => {
  configureSdk({ mode: "local", url: "" });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A browser's localStorage, in memory. */
function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() { return items.size; },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, String(value)),
  };
}

const answer = (status: number, body: unknown, type = "application/json") =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "Content-Type": type } });

describe("the platform, answered by the server", () => {
  it("ready reads the person from /api/me", async () => {
    const fetch = vi.fn(async (url: string) => (url === `${URL_BASE}/api/me` ? answer(200, person) : answer(404, {})));
    vi.stubGlobal("fetch", fetch);
    const info = await ready();
    expect(info.user).toEqual(person);
    expect(me()).toEqual(person);
    expect(sdkConfig().mode).toBe("remote");
  });

  it("opened with no network, ready answers the person last signed in on this browser", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    vi.stubGlobal("fetch", vi.fn(async () => answer(200, person)));
    await ready();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    const info = await ready();
    expect(info.user).toEqual(person);
    expect(me()).toEqual(person);
  });

  it("opened with no network and no one known here, ready says unreachable", async () => {
    vi.stubGlobal("localStorage", memoryStorage());
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    await expect(ready()).rejects.toMatchObject({ code: "unreachable" });
  });

  it("ready says signed_out when the server does not know who is asking", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => answer(401, { code: "signed_out" })));
    await expect(ready()).rejects.toMatchObject({ code: "signed_out" });
  });

  it("a file written offline is uploaded when the network returns", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (url.endsWith("/api/me") ? answer(200, person) : answer(404, {}))));
    await ready();
    const puts: string[] = [];
    let reachable = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method !== "PUT") return answer(404, { code: "not_found" });
      if (!reachable) throw new TypeError("Failed to fetch");
      puts.push(url);
      return answer(200, { ok: true });
    }));
    await files.write("pictures/one.png", new Blob(["png"], { type: "image/png" }), { mediaType: "image/png" });
    // Kept here at once: the picture shows before the server has it.
    expect(await (await files.read("pictures/one.png")).text()).toBe("png");
    expect(puts).toEqual([]);
    reachable = true;
    await uploadWaitingFiles();
    expect(puts).toEqual([`${URL_BASE}/api/files/${encodeURIComponent(`personal:${person.id}`)}/pictures/one.png`]);
    await uploadWaitingFiles();
    expect(puts).toHaveLength(1);
  });

  it("an upload asked for while one is failing runs again once that one ends", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (url.endsWith("/api/me") ? answer(200, person) : answer(404, {}))));
    await ready();
    const puts: string[] = [];
    let fail: (() => void) | null = null;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method !== "PUT") return answer(404, { code: "not_found" });
      if (!puts.length && fail === null) {
        // The first try is still out when the network returns, then fails.
        await new Promise<void>((resolve) => { fail = resolve; });
        throw new TypeError("Failed to fetch");
      }
      puts.push(url);
      return answer(200, { ok: true });
    }));
    await files.write("pictures/two.png", new Blob(["png"], { type: "image/png" }), { mediaType: "image/png" });
    await vi.waitFor(() => expect(fail).not.toBeNull());
    const second = uploadWaitingFiles();
    fail!();
    await second;
    expect(puts).toHaveLength(1);
  });

  it("a file this browser lacks is read from the server, and a missing one reads not_found", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/api/me")) return answer(200, person);
      if (url.endsWith("/there.txt")) return answer(200, "from the server", "text/plain");
      return answer(404, { code: "not_found" });
    }));
    await ready();
    expect(await (await files.read("there.txt")).text()).toBe("from the server");
    await expect(files.read("nowhere.txt")).rejects.toMatchObject({ code: "not_found" });
  });

  it("spaces are unavailable in remote mode", async () => {
    expect(await spaces.list()).toEqual([]);
    await expect(spaces.create({ name: "Team" })).rejects.toMatchObject({ code: "unavailable" });
  });
});
