/* Notes in a real browser: the dev server on a free port, and a headless
   browser whose tabs share one profile — so its tabs share IndexedDB and a
   BroadcastChannel, as two tabs of one person's browser do. The browser is
   Edge unless NOTES_E2E_CHANNEL says another (chrome, chromium).

   npm run e2e runs every *.e2e.mjs here with node:test. */

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "vite";

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Notes' dev server, answering. */
export async function startServer() {
  const port = await freePort();
  const server = await createServer({ logLevel: "error", server: { port, strictPort: true, host: "127.0.0.1" } });
  await server.listen();
  const url = `http://127.0.0.1:${port}`;
  for (let tries = 0; tries < 60; tries += 1) {
    try {
      if ((await fetch(url)).ok) break;
    } catch {
      // not yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return { url, stop: () => server.close() };
}

async function answering(url, tries = 240) {
  for (let left = tries; left > 0; left -= 1) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${url} never answered`);
}

/** Notes with its sync server: `wrangler dev` (signed in as DEV_USER, its
 *  storage in a folder thrown away after) behind Vite in remote mode, which
 *  passes /api — sockets too — through to it. Two browsers opened on it
 *  are two devices of one person. */
export async function startSyncServer({ user = "ada", built = false } = {}) {
  const store = await mkdtemp(join(tmpdir(), "notes-sync-"));
  // wrangler dev serves ../dist as the app's assets: it must be there.
  await mkdir(new URL("../dist", import.meta.url), { recursive: true });
  const syncPort = await freePort();
  const wrangler = spawn(process.execPath, [
    fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url)),
    "dev", "-c", "server/wrangler.jsonc", "--ip", "127.0.0.1", "--port", String(syncPort),
    "--persist-to", store, "--var", `DEV_USER:${user}`, "--show-interactive-dev-session=false",
  ], { cwd: fileURLToPath(new URL("..", import.meta.url)), env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  wrangler.stdout.on("data", (chunk) => { log += chunk; });
  wrangler.stderr.on("data", (chunk) => { log += chunk; });
  const syncUrl = `http://127.0.0.1:${syncPort}`;
  try {
    await answering(`${syncUrl}/api/me`);
  } catch (error) {
    wrangler.kill();
    throw new Error(`${error.message}
${log}`);
  }

  let stopped = false;
  const stopWrangler = async () => {
    if (stopped) return;
    stopped = true;
    wrangler.kill();
    await new Promise((resolve) => (wrangler.exitCode === null ? wrangler.once("exit", resolve) : resolve()));
    await rm(store, { recursive: true, force: true }).catch(() => undefined);
  };
  // The build itself, as deployed: wrangler serves dist/ beside /api.
  if (built) return { url: syncUrl, stop: stopWrangler };

  process.env.VITE_SYNC = "remote";
  const port = await freePort();
  const vite = await createServer({
    logLevel: "error",
    server: { port, strictPort: true, host: "127.0.0.1", proxy: { "/api": { target: syncUrl, ws: true } } },
  });
  await vite.listen();
  const url = `http://127.0.0.1:${port}`;
  await answering(url);
  return {
    url,
    async stop() {
      await vite.close();
      await stopWrangler();
    },
  };
}

/** A headless browser on a profile of its own, thrown away on close. */
export async function openBrowser(url) {
  const profile = await mkdtemp(join(tmpdir(), "notes-e2e-"));
  const context = await chromium.launchPersistentContext(profile, {
    channel: process.env.NOTES_E2E_CHANNEL ?? "msedge",
    headless: true,
    viewport: { width: 1280, height: 800 },
    acceptDownloads: true,
  });
  const errors = new WeakMap();
  return {
    context,
    /** A tab signed in as `as`, Notes open and settled. */
    async newTab(as = "ada") {
      const page = await context.newPage();
      const seen = [];
      errors.set(page, seen);
      page.on("pageerror", (error) => seen.push(`pageerror: ${error.message}`));
      page.on("console", (message) => {
        if (message.type() === "error" && !/favicon/.test(message.text())) seen.push(message.text());
      });
      await page.goto(`${url}/?as=${as}`);
      await page.getByRole("button", { name: /^Settings/ }).waitFor();
      return page;
    },
    consoleErrors: (page) => errors.get(page) ?? [],
    async close() {
      await context.close();
      await rm(profile, { recursive: true, force: true });
    },
  };
}

/** A new page: its title, then its first paragraph. */
export async function newPage(page, title, body) {
  await page.getByRole("button", { name: "New page", exact: true }).last().click();
  await page.waitForTimeout(400);
  await page.keyboard.type(title);
  if (body !== undefined) {
    await page.keyboard.press("Enter");
    await page.keyboard.type(body);
  }
  await page.waitForTimeout(800);
}
