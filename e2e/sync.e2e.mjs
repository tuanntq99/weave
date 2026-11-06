import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { newPage, openBrowser, startSyncServer } from "./harness.mjs";

/* Two devices of one person — two browsers, each with a profile of its own,
   so nothing passes between them but the sync server. */

let server;
let a;
let b;

before(async () => {
  server = await startSyncServer();
  a = await openBrowser(server.url);
  b = await openBrowser(server.url);
});

after(async () => {
  await a?.close();
  await b?.close();
  await server?.stop();
});

const paragraph = (tab, words) => tab.locator(".block__editable", { hasText: words }).first();

async function open(tab, title) {
  await tab.getByText(title, { exact: true }).first().click();
  await tab.locator(".doc").first().waitFor();
}

// A 2×2 PNG, red.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEUlEQVR4nGP4z8DwnwGMgRQAH+4D/dJQfRoAAAAASUVORK5CYII=",
  "base64",
);

test("an edit on A shows on B within a few seconds", async () => {
  const one = await a.newTab();
  const two = await b.newTab();
  await newPage(one, "Across", "written on A");
  await two.getByText("Across", { exact: true }).first().waitFor({ timeout: 5000 });
  await open(two, "Across");
  await paragraph(two, "written on A").waitFor({ timeout: 5000 });
  assert.deepEqual(a.consoleErrors(one), []);
  assert.deepEqual(b.consoleErrors(two), []);
  await one.close();
  await two.close();
});

test("B edits offline and closes the tab without being asked; back online, both converge", async () => {
  const one = await a.newTab();
  const two = await b.newTab();
  await newPage(one, "Apart", "Shared line");
  await two.getByText("Apart", { exact: true }).first().waitFor({ timeout: 5000 });
  await open(one, "Apart");
  await open(two, "Apart");
  await paragraph(two, "Shared line").waitFor({ timeout: 5000 });

  await b.context.setOffline(true);
  await paragraph(two, "Shared line").click();
  await two.keyboard.press("End");
  await two.keyboard.type(" [B offline]", { delay: 20 });
  await paragraph(one, "Shared line").click();
  await one.keyboard.press("Home");
  await one.keyboard.type("[A online] ", { delay: 20 });
  await one.waitForTimeout(1500);
  assert.equal(await paragraph(one, "Shared line").innerText(), "[A online] Shared line", "B's offline words reached A");

  // What B typed is in its outbox: closing asks nothing.
  let asked = false;
  two.on("dialog", (dialog) => {
    asked = true;
    void dialog.dismiss();
  });
  await two.close({ runBeforeUnload: true });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(asked, false, "closing with writes in the outbox asked to stay");

  await b.context.setOffline(false);
  const back = await b.newTab();
  await open(back, "Apart");
  const both = "[A online] Shared line [B offline]";
  await back.locator(".block__editable", { hasText: both }).first().waitFor({ timeout: 8000 });
  await one.locator(".block__editable", { hasText: both }).first().waitFor({ timeout: 8000 });
  assert.deepEqual(a.consoleErrors(one), []);
  await one.close();
  await back.close();
});

test("a picture added offline on B shows on A after B reconnects", async () => {
  const one = await a.newTab();
  const two = await b.newTab();
  await newPage(one, "Pictured", "a cover comes");
  await two.getByText("Pictured", { exact: true }).first().waitFor({ timeout: 5000 });
  await open(two, "Pictured");

  // The picker is opened online: its code is loaded the first time it is
  // asked for, and a page with no network cannot load code.
  await two.locator(".doc__head").hover();
  await two.getByRole("button", { name: "Add cover" }).click();
  await two.locator(".doc__cover").hover();
  await two.getByRole("button", { name: "Change cover" }).click();
  await two.getByRole("tab", { name: "Upload" }).click();
  await b.context.setOffline(true);
  await two.getByLabel("Cover picture").setInputFiles({ name: "red.png", mimeType: "image/png", buffer: PNG });
  // Shown on B at once, from this device's copy.
  await two.locator("img.doc__cover-image").waitFor({ timeout: 5000 });

  await b.context.setOffline(false);
  await open(one, "Pictured");
  const shown = one.locator("img.doc__cover-image");
  await shown.waitFor({ timeout: 15000 });
  await one.waitForFunction(() => {
    const image = document.querySelector("img.doc__cover-image");
    return image instanceof HTMLImageElement && image.complete && image.naturalWidth === 2;
  }, null, { timeout: 10000 });
  // A may ask before B's upload lands: a 404 it reads again, by design.
  assert.deepEqual(a.consoleErrors(one).filter((line) => !/status of 404/.test(line)), []);
  await one.close();
  await two.close();
});
