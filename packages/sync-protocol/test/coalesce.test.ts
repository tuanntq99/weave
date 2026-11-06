import { describe, expect, it } from "vitest";
import { sameRichText } from "../src/merge";
import { commitOp, mergeOps, type Op } from "../src/ops";

const text = (value: string) => [{ text: value }];
const typed = (from: string, to: string): Op => ({
  action: "patch",
  patch: { content: text(to) },
  rich: { content: { base: text(from), next: text(to) } },
});

describe("sameRichText", () => {
  it("compares the words and marks, not how they are split into runs", () => {
    expect(sameRichText([{ text: "ab" }], [{ text: "a" }, { text: "b" }])).toBe(true);
    expect(sameRichText([{ text: "ab" }], [{ text: "ab", marks: { bold: true } }])).toBe(false);
    expect(sameRichText([], undefined)).toBe(true);
  });
});

describe("mergeOps", () => {
  it("continuous typing becomes one patch from the first base to the last words", () => {
    let op = typed("", "h");
    for (const [from, to] of [["h", "he"], ["he", "hel"], ["hel", "hell"], ["hell", "hello"]]) {
      op = mergeOps(op, typed(from, to))!;
    }
    expect(op).toEqual(typed("", "hello"));
  });

  it("declines when someone else's words came in between", () => {
    // The window showed "Xh" (another person's X arrived) when it typed "e".
    expect(mergeOps(typed("", "h"), typed("Xh", "Xhe"))).toBeNull();
  });

  it("composes plain fields: the later wins, objects compose, null removes", () => {
    const earlier: Op = { action: "patch", patch: { icon: "a", props: { x: 1, y: 2 }, kind: "doc" }, rich: {} };
    const later: Op = { action: "patch", patch: { icon: "b", props: { y: null, z: 3 } }, rich: {} };
    const merged = mergeOps(earlier, later)!;
    const stored = { id: "p", props: { w: 0 }, kind: "old" };
    expect(commitOp(stored, merged)).toEqual(commitOp(commitOp(stored, earlier), later));
    expect(merged).toEqual({ action: "patch", patch: { icon: "b", props: { x: 1, y: null, z: 3 }, kind: "doc" }, rich: {} });
  });

  it("declines an object set over a field the earlier replaced with a non-object", () => {
    const earlier: Op = { action: "patch", patch: { props: null }, rich: {} };
    const later: Op = { action: "patch", patch: { props: { z: 3 } }, rich: {} };
    expect(mergeOps(earlier, later)).toBeNull();
  });

  it("a put or delete later replaces whatever came before", () => {
    const put: Op = { action: "put", value: { id: "p", content: text("x") } };
    expect(mergeOps(typed("", "h"), put)).toEqual(put);
    expect(mergeOps(put, { action: "delete" })).toEqual({ action: "delete" });
  });

  it("a patch after a put or delete becomes a put of the result", () => {
    const put: Op = { action: "put", value: { id: "p", content: text("h") } };
    expect(mergeOps(put, typed("h", "hi"))).toEqual({ action: "put", value: { id: "p", content: text("hi") } });
    expect(mergeOps({ action: "delete" }, { action: "patch", patch: { id: "p" }, rich: {} }))
      .toEqual({ action: "put", value: { id: "p" } });
  });

  it("a rich field cleared or set plainly by the earlier declines a later rich change", () => {
    const cleared: Op = { action: "patch", patch: { content: null }, rich: {} };
    expect(mergeOps(cleared, typed("", "a"))).toBeNull();
  });

  it("a rich field overwritten plainly by the later leaves the rich list", () => {
    const later: Op = { action: "patch", patch: { content: null }, rich: {} };
    expect(mergeOps(typed("", "a"), later)).toEqual({ action: "patch", patch: { content: null }, rich: {} });
  });

  it("never changes what it was given", () => {
    const earlier = typed("", "h");
    const later = typed("h", "hi");
    const copies = structuredClone([earlier, later]);
    mergeOps(earlier, later);
    expect([earlier, later]).toEqual(copies);
  });
});
