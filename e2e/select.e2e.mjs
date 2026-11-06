import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { openBrowser, startServer } from "./harness.mjs";

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

const undoKey = process.platform === "darwin" ? "Meta+z" : "Control+z";
const redoKey = process.platform === "darwin" ? "Meta+Shift+z" : "Control+y";

test("a Select's cell makes its options, as one step of undo", async () => {
  const tab = await browser.newTab("ada");
  await tab.getByRole("button", { name: "New database", exact: true }).first().click();
  await tab.waitForTimeout(500);
  await tab.keyboard.type("Tasks");
  for (const name of ["Row 1", "Row 2"]) {
    await tab.getByText(/^New$/).last().click();
    await tab.keyboard.type(name);
    await tab.keyboard.press("Escape");
  }
  await tab.getByRole("button", { name: "Add property" }).click();
  await tab.getByRole("menuitem", { name: "Select" }).click();
  await tab.keyboard.press("Escape");
  await tab.waitForTimeout(400);

  const cell = (index) => tab.locator("button.select-cell").nth(index);
  await cell(0).click();
  await tab.getByLabel("Find or create an option").fill("High");
  assert.ok(await tab.getByRole("option", { name: "Create “High”" }).isVisible());
  await tab.keyboard.press("Enter");
  await tab.waitForTimeout(400);
  assert.equal((await cell(0).innerText()).trim(), "High");

  // One undo takes back the option and the value together.
  await tab.locator("body").click({ position: { x: 700, y: 600 } });
  await tab.keyboard.press(undoKey);
  await tab.waitForTimeout(400);
  assert.equal((await cell(0).innerText()).trim(), "Empty");
  await cell(1).click();
  assert.equal(await tab.getByRole("option", { name: "High" }).count(), 0, "the option went with the undo");
  await tab.keyboard.press("Escape");
  await tab.keyboard.press(redoKey);
  await tab.waitForTimeout(400);
  assert.equal((await cell(0).innerText()).trim(), "High");

  // Kept, and a name that differs only in case and spaces chooses it again.
  await tab.reload();
  await tab.getByRole("button", { name: /^Settings/ }).waitFor();
  await tab.getByText("Tasks").first().click();
  await cell(0).waitFor();
  assert.equal((await cell(0).innerText()).trim(), "High");
  await cell(1).click();
  await tab.getByLabel("Find or create an option").fill(" high ");
  assert.equal(await tab.getByRole("option", { name: /Create/ }).count(), 0);
  await tab.keyboard.press("Enter");
  await tab.waitForTimeout(400);
  assert.equal((await cell(1).innerText()).trim(), "High");
  assert.deepEqual(browser.consoleErrors(tab), []);
});

test("Enter while an input method is composing makes nothing", async () => {
  const tab = await browser.newTab("ime");
  await tab.getByRole("button", { name: "New database", exact: true }).first().click();
  await tab.waitForTimeout(500);
  await tab.keyboard.type("Composing");
  await tab.getByText(/^New$/).last().click();
  await tab.keyboard.type("Row");
  await tab.keyboard.press("Escape");
  await tab.getByRole("button", { name: "Add property" }).click();
  await tab.getByRole("menuitem", { name: "Select" }).click();
  await tab.keyboard.press("Escape");
  await tab.locator("button.select-cell").first().click();
  const search = tab.getByLabel("Find or create an option");
  await search.fill("Vie");
  // The Enter that ends a composition (Vietnamese, Japanese…) is the IME's.
  await search.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true, keyCode: 229, bubbles: true });
  await tab.waitForTimeout(300);
  assert.ok(await search.isVisible(), "the box stays open");
  assert.equal((await tab.locator("button.select-cell").first().innerText()).trim(), "Empty");
});
