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

const RUNS = 10;

test(`two tabs typing in one paragraph keep every word in order, ${RUNS} times`, async () => {
  const one = await browser.newTab("ada");
  const two = await browser.newTab("ada");
  for (let run = 1; run <= RUNS; run += 1) {
    const title = `Race ${run}`;
    await newPage(one, title, "First paragraph here");
    await two.getByText(title).first().click();
    await two.getByText("First paragraph here").first().waitFor();
    const paragraph = (tab) => tab.locator(".block__editable", { hasText: "First paragraph" }).first();
    await paragraph(one).click();
    await one.keyboard.press("End");
    await paragraph(two).click();
    await two.keyboard.press("Home");
    await Promise.all([
      one.keyboard.type(" [one end]", { delay: 40 }),
      two.keyboard.type("[two start] ", { delay: 40 }),
    ]);
    await one.waitForTimeout(1500);
    const a = await paragraph(one).innerText();
    const b = await paragraph(two).innerText();
    assert.equal(a, b, `run ${run}: the tabs differ`);
    assert.equal(a, "[two start] First paragraph here [one end]", `run ${run}: words out of order`);
  }
  assert.deepEqual(browser.consoleErrors(one), []);
  assert.deepEqual(browser.consoleErrors(two), []);
});
