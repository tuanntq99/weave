import { isObject } from "./ops";

/* A record checked against its collection's fields, as schema.ts declares
   them (`RECORD_SHAPES`). The fields are read structurally — what kind, may
   it be left out, its choices, what a list or object holds — so this package
   needs nothing of the SDK's. A `json` field is any object: the app reads it
   through its own checks. */

export interface FieldLike {
  spec: {
    kind: string;
    optional: boolean;
    values?: readonly string[];
    item?: FieldLike;
    shape?: Record<string, FieldLike>;
    min?: number;
    max?: number;
  };
}

export type Validation = { ok: true } | { ok: false; path: string; reason: string };

const fail = (path: string, reason: string): Validation => ({ ok: false, path, reason });

function check(field: FieldLike, value: unknown, path: string): Validation {
  const { spec } = field;
  switch (spec.kind) {
    case "string": case "id": case "name": case "date":
      if (typeof value !== "string") return fail(path, "not a string");
      if (spec.max !== undefined && value.length > spec.max) return fail(path, "too long");
      return { ok: true };
    case "bool":
      return typeof value === "boolean" ? { ok: true } : fail(path, "not a boolean");
    case "number": case "int":
      if (typeof value !== "number" || !Number.isFinite(value)) return fail(path, "not a number");
      if (spec.kind === "int" && !Number.isInteger(value)) return fail(path, "not a whole number");
      return { ok: true };
    case "choice":
      return typeof value === "string" && (spec.values ?? []).includes(value) ? { ok: true } : fail(path, "not one of its choices");
    case "list": {
      if (!Array.isArray(value)) return fail(path, "not a list");
      if (spec.max !== undefined && value.length > spec.max) return fail(path, "too many");
      for (const [index, item] of value.entries()) {
        const found = spec.item ? check(spec.item, item, `${path}[${index}]`) : { ok: true as const };
        if (!found.ok) return found;
      }
      return { ok: true };
    }
    case "object":
      return isObject(value) ? validateRecord(spec.shape ?? {}, value, `${path}.`) : fail(path, "not an object");
    case "json":
      return isObject(value) ? { ok: true } : fail(path, "not an object");
    case "richText":
      return Array.isArray(value) && value.every((run) => isObject(run) && (typeof run.text === "string" || isObject(run.embed)))
        ? { ok: true } : fail(path, "not rich text");
    default:
      return fail(path, `unknown field kind ${spec.kind}`);
  }
}

/** Whether `value` is a record of `shape`. Fields it does not declare are
 *  allowed: a newer client may know of them. */
export function validateRecord(shape: Record<string, FieldLike>, value: unknown, prefix = ""): Validation {
  if (!isObject(value)) return fail(prefix || "(record)", "not an object");
  for (const [key, field] of Object.entries(shape)) {
    const present = value[key];
    if (present === undefined || present === null) {
      if (field.spec.optional) continue;
      return fail(`${prefix}${key}`, "missing");
    }
    const found = check(field, present, `${prefix}${key}`);
    if (!found.ok) return found;
  }
  return { ok: true };
}
