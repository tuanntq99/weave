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

test("a viewer is offered no restore for a shared page in the trash", async () => {
  const ada = await browser.newTab("ada");
  await newPage(ada, "Viewed", "read only for grace");

  // Ada shares the page with Grace, who may only view it.
  await ada.getByRole("button", { name: "Share" }).click();
  const dialog = ada.getByRole("dialog");
  await dialog.getByRole("button", { name: "Can edit" }).click();
  await ada.getByRole("menuitem", { name: /Can view/ }).click();
  await dialog.getByLabel("Add people by handle").fill("grace");
  await dialog.getByRole("button", { name: "Invite" }).click();
  await dialog.getByText("@grace").waitFor();
  await ada.keyboard.press("Escape");

  // Ada moves it to the trash.
  await ada.getByRole("button", { name: "More page actions" }).click();
  await ada.getByRole("menuitem", { name: /Move to trash/ }).click();
  await ada.waitForTimeout(800);

  const grace = await browser.newTab("grace");
  await grace.getByRole("button", { name: "Trash" }).click();
  // The row's buttons show while the pointer is over it.
  await grace.locator(".trash__row, [role=option]", { hasText: "Viewed" }).first().hover();
  assert.equal(await grace.getByRole("button", { name: "Restore Viewed" }).count(), 0);
  assert.equal(await grace.getByRole("button", { name: "Delete Viewed permanently" }).count(), 0);

  // Ada, who owns it, still has both.
  await ada.bringToFront();
  await ada.getByRole("button", { name: "Trash" }).click();
  await ada.locator(".trash__row, [role=option]", { hasText: "Viewed" }).first().hover();
  assert.equal(await ada.getByRole("button", { name: "Restore Viewed" }).count(), 1);
  assert.deepEqual(browser.consoleErrors(grace), []);
  assert.deepEqual(browser.consoleErrors(ada), []);
});
