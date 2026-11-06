import { describe, expect, it } from "vitest";
import { trashActions } from "./trash-actions";

describe("trashActions", () => {
  it("offers neither restore nor delete to a viewer", () => {
    expect(trashActions(false)).toEqual({ restore: false, deletePermanently: false });
  });
  it("offers both to someone who may edit", () => {
    expect(trashActions(true)).toEqual({ restore: true, deletePermanently: true });
  });
});
