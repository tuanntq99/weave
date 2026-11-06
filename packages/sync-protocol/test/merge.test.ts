import { describe, expect, it } from "vitest";
import { mergePatch, mergeRichText } from "../src/merge";

const text = (value: string) => [{ text: value }];
const plain = (runs: unknown) => (runs as Array<{ text?: string }>).map((run) => run.text ?? "◆").join("");

describe("mergePatch (RFC 7396)", () => {
  it("sets, replaces, removes with null and merges objects", () => {
    expect(mergePatch({ a: 1, b: { c: 2, d: 3 }, e: [1] }, { a: 2, b: { c: null, x: 1 }, e: [2], f: "new" }))
      .toEqual({ a: 2, b: { d: 3, x: 1 }, e: [2], f: "new" });
  });

  it("makes a record from nothing, and never changes what it was given", () => {
    const target = { a: { b: 1 } };
    expect(mergePatch(undefined, { a: 1 })).toEqual({ a: 1 });
    mergePatch(target, { a: { b: 2 } });
    expect(target).toEqual({ a: { b: 1 } });
  });
});

describe("mergeRichText", () => {
  it("keeps both changes made in different places", () => {
    const merged = mergeRichText(text("hello world"), text("hello brave world"), text("hello world!"));
    expect(plain(merged)).toBe("hello brave world!");
  });

  it("keeps two insertions at one place, theirs first", () => {
    expect(plain(mergeRichText(text("ab"), text("aXb"), text("aYb")))).toBe("aXYb");
  });

  it("lets the writer win where both changed the same words", () => {
    expect(plain(mergeRichText(text("one two three"), text("one 2 three"), text("one deux three")))).toBe("one deux three");
  });

  it("takes the other side whole when one side changed nothing", () => {
    expect(plain(mergeRichText(text("same"), text("same"), text("next")))).toBe("next");
    expect(plain(mergeRichText(text("same"), text("theirs"), text("same")))).toBe("theirs");
  });

  it("keeps marks and embeds, and never splits a surrogate pair", () => {
    const base = [{ text: "a" }, { text: "bold", marks: { bold: true } }, { embed: { mention: { kind: "page", page_id: "p1" } } }];
    const theirs = [{ text: "😀a" }, ...base.slice(1)];
    const ours = [...base, { text: "!" }];
    expect(mergeRichText(base, theirs, ours)).toEqual([
      { text: "😀a" },
      { text: "bold", marks: { bold: true } },
      { embed: { mention: { kind: "page", page_id: "p1" } } },
      { text: "!" },
    ]);
  });
});
