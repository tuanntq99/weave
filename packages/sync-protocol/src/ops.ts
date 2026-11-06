import { mergePatch, mergeRichText, sameRichText } from "./merge";
import type { Json, RichText } from "./types";

/** One write of a record: made whole, changed field by field (each
 *  rich-text field with the runs it was changed from), or deleted. */
export type Op =
  | { action: "put"; value: Json }
  | { action: "patch"; patch: Json; rich: Record<string, { base: unknown; next: unknown }> }
  | { action: "delete" };

const isObject = (value: unknown): value is Json =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** What a write stores, made over what is stored now: a patch merges field
 *  by field, and its rich-text fields three ways with what came since. */
export function commitOp(stored: Json | undefined, op: Op): Json | undefined {
  if (op.action === "delete") return undefined;
  if (op.action === "put") return op.value;
  const merged = mergePatch(stored, op.patch) as Json;
  for (const [field, { base, next }] of Object.entries(op.rich)) {
    merged[field] = mergeRichText(base, stored?.[field], next);
  }
  return merged;
}

/** A write as it travels: a patch's rich-text bases beside it. */
export type WriteBody =
  | { action: "put"; value: Json }
  | { action: "patch"; patch: Json; base?: Record<string, RichText> }
  | { action: "delete" };

export function toWire(op: Op): WriteBody {
  if (op.action !== "patch") return op;
  const fields = Object.entries(op.rich);
  return fields.length
    ? { action: "patch", patch: op.patch, base: Object.fromEntries(fields.map(([field, { base }]) => [field, base as RichText])) }
    : { action: "patch", patch: op.patch };
}

/** A write as it arrived: a rich-text field in the patch merges from its
 *  base, or — with none sent — from nothing (and so takes the patch whole). */
export function fromWire(body: WriteBody, richFields: readonly string[]): Op {
  if (body.action !== "patch") return body;
  const rich: Record<string, { base: unknown; next: unknown }> = {};
  for (const field of richFields) {
    const next = body.patch[field];
    if (next === undefined || next === null) continue;
    const base = body.base?.[field];
    if (base !== undefined) rich[field] = { base, next };
  }
  return { action: "patch", patch: body.patch, rich };
}

export { isObject };

/** Two JSON Merge Patches as one with the same effect, `later` applied
 *  after `earlier` — or null where one patch cannot say it: an object set
 *  over a field `earlier` replaced with something else (it would merge into
 *  what is stored instead of replacing it). */
function composePatch(earlier: Json, later: Json): Json | null {
  const result: Json = { ...earlier };
  for (const [key, value] of Object.entries(later)) {
    if (value === undefined) continue;
    if (isObject(value) && key in earlier) {
      const before = earlier[key];
      if (!isObject(before)) return null;
      const inner = composePatch(before, value);
      if (!inner) return null;
      result[key] = inner;
    } else {
      result[key] = value;
    }
  }
  return result;
}

/** One write with the effect of `earlier` then `later` on any stored value,
 *  or null when they must go apart: a rich-text field changed by both is
 *  one change only when `later` started from the words `earlier` left
 *  (someone else's words in between would be merged differently). */
export function mergeOps(earlier: Op, later: Op): Op | null {
  if (later.action !== "patch") return structuredClone(later);
  if (earlier.action !== "patch") {
    const value = commitOp(earlier.action === "put" ? earlier.value : undefined, later);
    return value ? { action: "put", value: structuredClone(value) } : null;
  }
  const patch = composePatch(earlier.patch, later.patch);
  if (!patch) return null;
  const rich: Record<string, { base: unknown; next: unknown }> = {};
  for (const [field, change] of Object.entries(earlier.rich)) {
    if (!(field in later.patch)) rich[field] = change;
  }
  for (const [field, change] of Object.entries(later.rich)) {
    const before = earlier.rich[field];
    if (before) {
      if (!sameRichText(change.base, before.next)) return null;
      rich[field] = { base: before.base, next: change.next };
    } else if (field in earlier.patch) {
      return null;
    } else {
      rich[field] = change;
    }
  }
  return structuredClone({ action: "patch", patch, rich });
}
