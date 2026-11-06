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

/** The trash, open, with the pointer over `title`'s row. */
async function trashRow(tab, title) {
  if (!(await tab.getByLabel("Search the trash").count())) await tab.getByRole("button", { name: "Trash" }).click();
  const row = tab.locator("[role=option]", { hasText: title }).first();
  await row.hover();
  return row;
}

test("deleting for good asks first, and Enter alone does not delete", async () => {
  const tab = await browser.newTab("ada");
  await newPage(tab, "Gone", "bye");
  await tab.getByRole("button", { name: "More page actions" }).click();
  await tab.getByRole("menuitem", { name: /Move to trash/ }).click();
  await tab.waitForTimeout(500);

  await trashRow(tab, "Gone");
  await tab.getByRole("button", { name: "Delete Gone permanently" }).click();
  const dialog = tab.getByRole("dialog", { name: /Delete/ });
  await dialog.waitFor();
  await tab.waitForFunction(() => document.activeElement?.textContent === "Cancel");
  assert.match(await dialog.innerText(), /Delete “Gone” and every page inside it forever\? This cannot be undone\./);
  await tab.keyboard.press("Enter");
  await tab.waitForTimeout(400);
  assert.equal(await (await trashRow(tab, "Gone")).count(), 1, "Enter on the focused Cancel keeps it");

  await tab.getByRole("button", { name: "Delete Gone permanently" }).click();
  await tab.getByRole("dialog", { name: /Delete/ }).getByRole("button", { name: "Cancel" }).click();
  await tab.waitForTimeout(400);
  assert.equal(await (await trashRow(tab, "Gone")).count(), 1, "Cancel keeps it");

  await tab.getByRole("button", { name: "Delete Gone permanently" }).click();
  // The question has Cancel in focus once it is up; a Tab reaches Delete.
  await tab.getByRole("dialog", { name: /Delete/ }).getByRole("button", { name: "Cancel" }).waitFor();
  await tab.waitForFunction(() => document.activeElement?.textContent === "Cancel");
  await tab.keyboard.press("Tab");
  await tab.keyboard.press("Enter");
  await tab.waitForTimeout(600);
  if (!(await tab.getByLabel("Search the trash").count())) await tab.getByRole("button", { name: "Trash" }).click();
  assert.equal(await tab.locator("[role=option]", { hasText: "Gone" }).count(), 0, "confirmed, it is gone");
  assert.deepEqual(browser.consoleErrors(tab), []);
});

test("restoring a version asks first", async () => {
  const tab = await browser.newTab("ada");
  await newPage(tab, "Versioned", "first words");
  // Leaving a page keeps a checkpoint of it.
  await newPage(tab, "Elsewhere");
  await tab.getByText("Versioned").first().click();
  const body = tab.locator(".block__editable", { hasText: "first words" }).first();
  await body.click();
  await tab.keyboard.press("End");
  await tab.keyboard.type(" and more");
  await tab.waitForTimeout(800);

  await tab.getByRole("button", { name: "More page actions" }).click();
  await tab.getByRole("menuitem", { name: "Page history" }).click();
  await tab.locator(".history-group [role=option]").first().click();
  await tab.getByRole("button", { name: "Restore" }).click();
  const dialog = tab.getByRole("dialog", { name: /Restore/ });
  await dialog.waitFor();
  assert.match(await dialog.innerText(), /Restore “Versioned” to the version of .+\? The current version stays in the history\./);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await tab.keyboard.press("Escape");
  await tab.waitForTimeout(400);
  assert.ok(await tab.getByText("first words and more").first().isVisible(), "Cancel keeps what the page says now");
  assert.deepEqual(browser.consoleErrors(tab), []);
});
