import { describe, expect, it } from "vitest";
import { RECORD_SHAPES } from "../../../schema";
import { commitOp, fromWire, parseClient, parseServer, toWire, validateRecord } from "../src";

const NOW = "2026-11-05T00:00:00.000Z";
const page = (extra: Record<string, unknown> = {}) => ({
  id: "p1", title_content: [{ text: "Plans" }], icon: "", kind: "document",
  created_at: NOW, updated_at: NOW, created_by: "Ada", updated_by: "Ada", ...extra,
});

describe("commitOp", () => {
  it("merges a rich patch over what is stored", () => {
    const stored = { title_content: [{ text: "hello brave world" }], icon: "" };
    const op = { action: "patch" as const, patch: { title_content: [{ text: "hello world!" }], icon: "x" }, rich: { title_content: { base: [{ text: "hello world" }], next: [{ text: "hello world!" }] } } };
    expect(commitOp(stored, op)).toEqual({ title_content: [{ text: "hello brave world!" }], icon: "x" });
  });

  it("travels and comes back the same", () => {
    const op = { action: "patch" as const, patch: { title_content: [{ text: "b" }] }, rich: { title_content: { base: [{ text: "a" }], next: [{ text: "b" }] } } };
    expect(fromWire(toWire(op), ["title_content"])).toEqual(op);
  });
});

describe("messages", () => {
  it("parseClient reads a hello and a write", () => {
    expect(parseClient(JSON.stringify({ t: "hello", protocol: 1, cursor: 0, clientId: "c1" }))).toMatchObject({ t: "hello" });
    expect(parseClient(JSON.stringify({ t: "write", opId: "o1", collection: "pages", id: "p1", action: "delete" }))).toMatchObject({ t: "write", action: "delete" });
  });

  it("parseClient rejects an unknown type, bad JSON, a write without opId and another protocol", () => {
    expect(parseClient(JSON.stringify({ t: "nope" }))).toBeNull();
    expect(parseClient("{")).toBeNull();
    expect(parseClient(JSON.stringify({ t: "write", collection: "pages", id: "p1", action: "delete" }))).toBeNull();
    expect(parseClient(JSON.stringify({ t: "write", opId: "o1", collection: "elsewhere", id: "p1", action: "delete" }))).toBeNull();
    expect(parseClient(JSON.stringify({ t: "hello", protocol: 2, cursor: 0, clientId: "c1" }))).toBeNull();
  });

  it("parseServer reads an ack and changes", () => {
    expect(parseServer(JSON.stringify({ t: "ack", opId: "o1", seq: 3, value: null }))).toMatchObject({ t: "ack", seq: 3 });
    expect(parseServer(JSON.stringify({ t: "changes", changes: [{ seq: 1, collection: "pages", id: "p1", value: null }] }))).toMatchObject({ t: "changes" });
    expect(parseServer(JSON.stringify({ t: "ack", opId: "o1" }))).toBeNull();
  });
});

describe("validateRecord", () => {
  it("accepts a real page record", () => {
    expect(validateRecord(RECORD_SHAPES.pages, page({ archived: true, cover: "dawn" }))).toEqual({ ok: true });
  });

  it("rejects a page without title_content", () => {
    const { title_content: _gone, ...rest } = page();
    expect(validateRecord(RECORD_SHAPES.pages, rest)).toMatchObject({ ok: false, path: "title_content" });
  });

  it("rejects a value outside a choice, and a wrong type deeper in", () => {
    expect(validateRecord(RECORD_SHAPES.pages, page({ kind: "folder" }))).toMatchObject({ ok: false, path: "kind" });
    expect(validateRecord(RECORD_SHAPES.pages, page({ database: { properties: [{ id: 1 }], views: [] } }))).toMatchObject({ ok: false });
  });

  it("accepts a block and a settings record", () => {
    expect(validateRecord(RECORD_SHAPES.blocks, { page: "p1", id: "b1", kind: "text", order: 1, content: [{ text: "hi" }] })).toEqual({ ok: true });
    expect(validateRecord(RECORD_SHAPES.workspace_settings, { theme: "dark", roots: ["p1"] })).toEqual({ ok: true });
  });
});
