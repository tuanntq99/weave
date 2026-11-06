import { describe, expect, it } from "vitest";
import { bulletFor, numberFor } from "./list-markers";

describe("numberFor", () => {
  it("counts the top level in numbers", () => {
    expect(numberFor(3, 0)).toBe("3.");
  });
  it("letters the next level on past z, as spreadsheet columns do", () => {
    expect([1, 26, 27, 28, 52, 53, 702, 703].map((value) => numberFor(value, 1)))
      .toEqual(["a.", "z.", "aa.", "ab.", "az.", "ba.", "zz.", "aaa."]);
  });
  it("numbers the third level in Roman numerals", () => {
    expect(numberFor(4, 2)).toBe("iv.");
    expect(numberFor(9, 5)).toBe("ix.");
  });
});

describe("bulletFor", () => {
  it("cycles its three marks by depth", () => {
    expect([0, 1, 2, 3].map(bulletFor)).toEqual(["•", "◦", "▪", "•"]);
  });
});
