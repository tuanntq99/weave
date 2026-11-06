/* The service worker as built (spec S5b): its template with the build's
   files and a name for the build put in. Used by the `pwa` plugin in
   vite.config.ts; kept apart so it can be tested. */

/** What the service worker keeps: every file the build made but source
 *  maps and itself, and the app's front door. */
export function precacheList(files: readonly string[]): string[] {
  const kept = files.filter((file) => !file.endsWith(".map") && file !== "sw.js");
  return [...new Set(["./", "index.html", ...kept])].sort();
}

/** A short name for a build, the same for the same files. */
export function buildVersion(files: readonly string[]): string {
  let hash = 2166136261;
  for (const char of files.join("\n")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function serviceWorkerSource(template: string, files: readonly string[]): string {
  const list = precacheList(files);
  return template
    .replace("const VERSION = __VERSION__;", `const VERSION = ${JSON.stringify(buildVersion(list))};`)
    .replace("const PRECACHE = __PRECACHE__;", `const PRECACHE = ${JSON.stringify(list)};`);
}
