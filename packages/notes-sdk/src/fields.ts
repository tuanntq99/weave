/* The field builders an app declares its records and its operations' inputs
   with (`t`), and the TypeScript types read from them (`Infer`). At run time
   a field only remembers what it is: its kind, whether it may be left out,
   its default, and what it holds — enough to fill defaults and to know which
   fields are rich text. */

import type { RichText } from "@notes/sync-protocol";

export type { RichText, RichTextRun } from "@notes/sync-protocol";

export type FieldKind =
  | "string" | "id" | "name" | "bool" | "number" | "int" | "date"
  | "choice" | "list" | "object" | "json" | "richText";

export interface FieldSpec {
  kind: FieldKind;
  optional: boolean;
  description?: string;
  default?: unknown;
  hasDefault: boolean;
  values?: readonly string[];
  item?: AnyField;
  shape?: Shape;
  min?: number;
  max?: number;
}

/** A declared field: `T` is what it holds, `O` whether it may be left out. */
export class Field<T, O extends boolean = false> {
  /** Never set: carries `T` and `O` for the type checker. */
  declare readonly __type: T;
  declare readonly __optional: O;

  constructor(readonly spec: FieldSpec) {}

  optional(): Field<T, true> {
    return new Field<T, true>({ ...this.spec, optional: true });
  }

  describe(description: string): Field<T, O> {
    return new Field<T, O>({ ...this.spec, description });
  }

  /** A default is filled in when the field is left out, so it is always
   *  there for whoever reads the input. */
  default(value: T): Field<T, false> {
    return new Field<T, false>({ ...this.spec, optional: false, hasDefault: true, default: value });
  }
}

export type AnyField = Field<any, boolean>;
export type Shape = Record<string, AnyField>;

type Simplify<T> = { [K in keyof T]: T[K] } & {};
type OptionalKeys<S extends Shape> = { [K in keyof S]: S[K] extends Field<unknown, true> ? K : never }[keyof S];
type RequiredKeys<S extends Shape> = Exclude<keyof S, OptionalKeys<S>>;

/** What a field holds. */
export type Infer<F> = F extends Field<infer T, boolean> ? T : never;

/** What an object of fields holds: a field that may be left out is an
 *  optional key. */
export type InferShape<S extends Shape> = Simplify<
  { [K in RequiredKeys<S>]: Infer<S[K]> } & { [K in OptionalKeys<S>]?: Infer<S[K]> }
>;

const make = <T>(kind: FieldKind, extra: Partial<FieldSpec> = {}) =>
  new Field<T>({ kind, optional: false, hasDefault: false, ...extra });

export const t = {
  string: (max?: number) => make<string>("string", { max }),
  id: () => make<string>("id"),
  name: () => make<string>("name"),
  bool: () => make<boolean>("bool"),
  number: (min?: number, max?: number) => make<number>("number", { min, max }),
  int: (min?: number, max?: number) => make<number>("int", { min, max }),
  /** A day, `YYYY-MM-DD`. */
  date: () => make<string>("date"),
  choice: <const V extends readonly string[]>(...values: V) => make<V[number]>("choice", { values }),
  list: <F extends AnyField>(item: F, max?: number) => make<Infer<F>[]>("list", { item, max }),
  object: <S extends Shape>(shape: S) => make<InferShape<S>>("object", { shape }),
  /** Anything a JSON schema describes; read through the app's own checks. */
  json: (_schema: Record<string, unknown>) => make<Record<string, unknown>>("json"),
  richText: () => make<RichText>("richText"),
};

/** An input with every default filled in, at every depth. */
export function withDefaults(shape: Shape, input: unknown): Record<string, unknown> {
  const given = input && typeof input === "object" && !Array.isArray(input) ? { ...(input as Record<string, unknown>) } : {};
  for (const [key, field] of Object.entries(shape)) {
    const value = given[key];
    if (value === undefined) {
      if (field.spec.hasDefault) given[key] = structuredClone(field.spec.default);
      continue;
    }
    given[key] = filled(field, value);
  }
  return given;
}

function filled(field: AnyField, value: unknown): unknown {
  if (field.spec.kind === "object" && field.spec.shape) return withDefaults(field.spec.shape, value);
  if (field.spec.kind === "list" && field.spec.item && Array.isArray(value)) {
    const item = field.spec.item;
    return value.map((entry) => filled(item, entry));
  }
  return value;
}

/** The names of an object's rich-text fields. */
export function richTextFields(shape: Shape): string[] {
  return Object.entries(shape).filter(([, field]) => field.spec.kind === "richText").map(([key]) => key);
}
