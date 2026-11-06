import { describe, expect, it } from "vitest";
import { buildVersion, precacheList, serviceWorkerSource } from "./build-sw";
import template from "./service-worker.js?raw";

/* The service worker run in a stand-in for its global scope: caches in
   memory, a network that answers or is gone. */

const SCOPE = "https://notes.test/";

type Handler = (event: { request?: Request; waitUntil(work: Promise<unknown>): void; respondWith?(answer: Promise<Response>): void }) => void;

function worker(files: string[], network: (request: Request) => Promise<Response>) {
  const handlers = new Map<string, Handler>();
  const stores = new Map<string, Map<string, Response>>();
  const caches = {
    async open(name: string) {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name)!;
      return {
        async put(key: Request | string, response: Response) { store.set(typeof key === "string" ? key : key.url.split("?")[0], response); },
        async match(key: Request | string) { return store.get(typeof key === "string" ? key : key.url.split("?")[0])?.clone(); },
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name: string) { return stores.delete(name); },
    async match(key: string, { cacheName }: { cacheName: string }) { return stores.get(cacheName)?.get(key)?.clone(); },
  };
  const fetched: string[] = [];
  const self = {
    registration: { scope: SCOPE },
    clients: { claim: async () => undefined },
    skipWaiting: async () => undefined,
    addEventListener: (type: string, handler: Handler) => handlers.set(type, handler),
  };
  const fetch = (input: string | Request) => {
    const request = typeof input === "string" ? new Request(input) : input;
    fetched.push(request.url);
    return network(request);
  };
  new Function("self", "caches", "fetch", serviceWorkerSource(template, files))(self, caches, fetch);

  const run = async (type: string, request?: Request) => {
    let answer: Promise<Response> | undefined;
    const work: Promise<unknown>[] = [];
    handlers.get(type)!({ request, waitUntil: (promise) => work.push(promise), respondWith: (promise) => { answer = promise; } });
    await Promise.all(work);
    return answer;
  };
  return { stores, fetched, run };
}

const ok = (body: string) => new Response(body, { status: 200 });
const page = (url: string) => new Request(url, { mode: "same-origin" }) as Request;
/** A page load: Request's mode cannot be set to "navigate" by hand. */
const navigation = (url: string) => Object.defineProperty(new Request(url), "mode", { value: "navigate" });

describe("the build's list", () => {
  it("keeps every file but maps and the worker itself, with the front door", () => {
    expect(precacheList(["assets/a.js", "assets/a.js.map", "sw.js", "favicon.svg", "index.html"]))
      .toEqual(["./", "assets/a.js", "favicon.svg", "index.html"]);
  });

  it("names a build by its files", () => {
    expect(buildVersion(["a"])).toBe(buildVersion(["a"]));
    expect(buildVersion(["a"])).not.toBe(buildVersion(["b"]));
  });
});

describe("the service worker", () => {
  it("installed, keeps the build; with no network a page load gets the kept app", async () => {
    let online = true;
    const sw = worker(["index.html", "assets/app-1.js"], async (request) => {
      if (!online) throw new TypeError("Failed to fetch");
      return ok(`from the network: ${new URL(request.url).pathname}`);
    });
    await sw.run("install");
    online = false;
    const answer = await sw.run("fetch", navigation(`${SCOPE}some/page`));
    expect(await answer!.text()).toBe("from the network: /");
    const script = await sw.run("fetch", page(`${SCOPE}assets/app-1.js`));
    expect(await script!.text()).toBe("from the network: /assets/app-1.js");
  });

  it("where /index.html is answered with a redirect, the kept root is the app", async () => {
    let online = true;
    const sw = worker(["./", "index.html"], async (request) => {
      if (!online) throw new TypeError("Failed to fetch");
      if (request.url.endsWith("/index.html")) return Object.defineProperty(ok(""), "redirected", { value: true });
      return ok("the app");
    });
    await sw.run("install");
    online = false;
    expect(await (await sw.run("fetch", navigation(`${SCOPE}a/page`)))!.text()).toBe("the app");
  });

  it("a page load goes to the network first when there is one", async () => {
    const sw = worker(["index.html"], async () => ok("newest"));
    await sw.run("install");
    const answer = await sw.run("fetch", navigation(`${SCOPE}`));
    expect(await answer!.text()).toBe("newest");
  });

  it("never answers /api, other origins, or anything but GET", async () => {
    const sw = worker([], async () => ok("x"));
    expect(await sw.run("fetch", page(`${SCOPE}api/me`))).toBeUndefined();
    expect(await sw.run("fetch", page("https://elsewhere.test/a.js"))).toBeUndefined();
    expect(await sw.run("fetch", new Request(`${SCOPE}assets/a.js`, { method: "POST" }))).toBeUndefined();
  });

  it("what Access turns away while installing is not kept as the app", async () => {
    const sw = worker(["index.html"], async () => Object.defineProperty(ok("sign in"), "redirected", { value: true }));
    await sw.run("install");
    expect([...[...sw.stores.values()][0].keys()]).not.toContain(`${SCOPE}index.html`);
  });

  it("activated, lets go of older builds' caches", async () => {
    const sw = worker(["index.html"], async () => ok("x"));
    sw.stores.set("notes-old", new Map());
    sw.stores.set("someone-else", new Map());
    await sw.run("install");
    await sw.run("activate");
    expect([...sw.stores.keys()].filter((name) => name !== "someone-else")).toHaveLength(1);
    expect(sw.stores.has("someone-else")).toBe(true);
  });

  it("a file of the build fetched later is kept for next time", async () => {
    let online = true;
    const sw = worker([], async (request) => {
      if (!online) throw new TypeError("Failed to fetch");
      return ok(new URL(request.url).pathname);
    });
    await sw.run("install");
    await (await sw.run("fetch", page(`${SCOPE}assets/late.js`)))!.text();
    online = false;
    expect(await (await sw.run("fetch", page(`${SCOPE}assets/late.js`)))!.text()).toBe("/assets/late.js");
  });
});
