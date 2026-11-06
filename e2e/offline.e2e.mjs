import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { newPage, openBrowser, startSyncServer } from "./harness.mjs";

/* The app as deployed — built, served by wrangler beside /api — opens and
   works with its server gone (spec S5b). */

let server;
let browser;

before(async () => {
  execFileSync(process.execPath, [fileURLToPath(new URL("../node_modules/vite/bin/vite.js", import.meta.url)), "build", "--logLevel", "error"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    stdio: "inherit",
  });
  server = await startSyncServer({ built: true });
  browser = await openBrowser(server.url);
});

after(async () => {
  await browser?.close();
  await server?.stop();
});

test("with the server gone, a reload opens the app, its pages and its lazily loaded parts", async () => {
  const tab = await browser.newTab();
  await tab.waitForFunction(() => navigator.serviceWorker.controller !== null, null, { timeout: 15000 });
  await newPage(tab, "Kept offline", "written online");
  // Sent: the server has it, and this browser's copy too.
  await tab.getByText("Saved", { exact: false }).first().waitFor({ timeout: 10000 }).catch(() => undefined);

  await server.stop();
  await browser.context.setOffline(true);
  await tab.reload();
  await tab.getByRole("button", { name: /^Settings/ }).waitFor({ timeout: 15000 });
  await tab.getByText("Kept offline", { exact: true }).first().click();
  await tab.locator(".block__editable", { hasText: "written online" }).first().waitFor({ timeout: 5000 });

  // The picker's code is loaded the first time it is asked for: from the
  // service worker's copy now.
  await tab.locator(".doc__head").hover();
  await tab.getByRole("button", { name: "Add cover" }).click();
  await tab.locator(".doc__cover").hover();
  await tab.getByRole("button", { name: "Change cover" }).click();
  await tab.getByRole("tab", { name: "Upload" }).waitFor({ timeout: 5000 });

  // Still writable: kept in this browser until the server is back.
  await tab.locator(".block__editable", { hasText: "written online" }).first().click();
  await tab.keyboard.press("Escape");
  const errors = browser.consoleErrors(tab).filter((line) => !/Failed to load resource|ERR_INTERNET_DISCONNECTED|WebSocket|net::/i.test(line));
  assert.deepEqual(errors, []);
});
