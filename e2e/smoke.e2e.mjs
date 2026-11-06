import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { newPage, openBrowser, startServer } from "./harness.mjs";

let server;
let browser;

before(async () => {
  server = await startServer();
  browser = await openBrowser(server.url);
});

after(async () => {
  await browser?.close();
  await server?.stop();
});

test("a page made is there after a reload", async () => {
  const tab = await browser.newTab("ada");
  await newPage(tab, "Smoke", "it keeps");
  await tab.reload();
  await tab.getByRole("button", { name: /^Settings/ }).waitFor();
  assert.ok(await tab.getByText("Smoke").first().isVisible());
  assert.deepEqual(browser.consoleErrors(tab), []);
});
