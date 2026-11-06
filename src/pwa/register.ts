/* The service worker (spec S5b) is taken on in a build only: in
   development Vite serves files that change under it. */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch((error: unknown) => {
      console.warn("[notes] The app will not open offline: its service worker could not start", error);
    });
  });
}
