/* Notes' service worker (spec S5b): the app opens with no network.

   Built by the `pwa` plugin (vite.config.ts), which puts the list of every
   file the build made in place of __PRECACHE__ and a name for this build in
   place of __VERSION__.

   - Installed, it keeps every file of the build in a cache of the build's
     own; activated, it lets go of older builds' caches.
   - A page load goes to the network first — so a new version, and Access's
     sign-in, are met as before — and, with no network, is answered with the
     kept front door (the app's index.html).
   - A file of the build is answered from the cache (its name carries its
     hash, so it never changes), else fetched and kept.
   - /api — the sync socket, files, sign-in — and other origins are never
     touched: the SDK keeps what it needs in IndexedDB. */

const VERSION = __VERSION__;
const PRECACHE = __PRECACHE__;
const CACHE = `notes-${VERSION}`;

const scope = () => self.registration.scope;
const isApi = (url) => new URL(url).pathname.startsWith(new URL("api/", scope()).pathname);

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // One by one, so what Access turns away (a lapsed sign-in) is not kept
    // as if it were the app.
    await Promise.all(PRECACHE.map(async (path) => {
      const url = new URL(path, scope()).href;
      const response = await fetch(url, { credentials: "same-origin", cache: "reload" });
      if (response.ok && !response.redirected) await cache.put(url, response);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith("notes-") && name !== CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== new URL(scope()).origin || isApi(request.url)) return;

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        return await fetch(request);
      } catch (error) {
        // The front door as kept: the scope's root (Cloudflare answers
        // /index.html with a redirect to it, never kept), else index.html.
        const kept = await caches.match(scope(), { cacheName: CACHE })
          ?? await caches.match(new URL("index.html", scope()).href, { cacheName: CACHE });
        if (kept) return kept;
        throw error;
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const kept = await cache.match(request, { ignoreSearch: true });
    if (kept) return kept;
    const response = await fetch(request);
    if (response.ok && !response.redirected && url.pathname.includes("/assets/")) await cache.put(request, response.clone());
    return response;
  })());
});
