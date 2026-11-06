import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { beforeEach } from "vitest";
import { resetDbForTests } from "../src/db";
import { setMeForTests } from "../src/identity";

/** Each case starts with an empty browser, signed in as Ada. */
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  resetDbForTests();
  setMeForTests("ada");
});
