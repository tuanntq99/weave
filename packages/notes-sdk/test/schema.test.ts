import { describe, expect, expectTypeOf, it } from "vitest";
import { t, withDefaults, type InferShape, type RichText } from "../src/fields";
import type { CollectionHandle } from "../src/live";
import { schema } from "../src/schema";

describe("schema", () => {
  const app = schema({
    collections: {
      notes: { fields: { id: t.string(), title: t.richText(), done: t.bool().optional(), kind: t.choice("a", "b") } },
    },
    services: { cards: "@notes/web-card-preview@0.0.1" },
    operations: {
      list: {
        runs: "window", effect: "read", description: "",
        input: { limit: t.int(1, 100).default(50), query: t.string().optional() },
      },
    },
  });

  it("reads each record's type from its fields", () => {
    type Note = typeof app.notes extends CollectionHandle<infer R> ? R : never;
    expectTypeOf<Note>().toEqualTypeOf<{ id: string; title: RichText; kind: "a" | "b"; done?: boolean }>();
    type Input = Parameters<NonNullable<Parameters<typeof app.commands>[0]["list"]>>[0];
    expectTypeOf<Input["limit"]>().toEqualTypeOf<number>();
    expectTypeOf<Input["query"]>().toEqualTypeOf<string | undefined>();
  });

  it("knows a handle's collection, in a space too, and offers services", async () => {
    expect(app.notes.name).toBe("notes");
    expect(app.notes.in("s1").name).toBe("notes");
    expect(await app.cards.call("read", { url: "https://x.com" })).toBeNull();
    expect(typeof app.commands({})).toBe("function");
  });

  it("fills an input's defaults, at every depth", () => {
    const shape = { limit: t.int().default(50), sorts: t.list(t.object({ dir: t.choice("asc", "desc").default("asc") })).optional() };
    expect(withDefaults(shape, { sorts: [{}, { dir: "desc" }] })).toEqual({ limit: 50, sorts: [{ dir: "asc" }, { dir: "desc" }] });
    expect(withDefaults(shape, undefined)).toEqual({ limit: 50 });
    expectTypeOf<InferShape<typeof shape>>().toEqualTypeOf<{ limit: number; sorts?: { dir: "asc" | "desc" }[] }>();
  });
});
