import { describe, expect, it } from "vitest";
import type { DatabaseConfig, NotePage } from "../../core/types";
import {
  addSelectOption,
  MAX_SELECT_OPTIONS,
  moveSelectOption,
  propertyOptions,
  removeSelectOption,
  renameSelectOption,
} from "./database-model";

function config(options: string[], filter?: string): DatabaseConfig {
  return {
    properties: [{ id: "p1", name: "Priority", type: "select", options }],
    views: [{ id: "v1", name: "Table", kind: "table", ...(filter ? { filter: { property_id: "p1", value: filter } } : {}) }],
  };
}

const row = (id: string, value: string) => ({ id, properties: { p1: value } }) as unknown as NotePage;
const options = (next: DatabaseConfig) => propertyOptions(next.properties[0]);

describe("Select options", () => {
  it("addSelectOption adds a trimmed name at the end", () => {
    const made = addSelectOption(config(["Low"]), "p1", " High ");
    expect(made?.option).toBe("High");
    expect(options(made!.config)).toEqual(["Low", "High"]);
  });

  it("addSelectOption returns the existing option for a name that differs only in case or spaces", () => {
    const start = config(["High"]);
    const made = addSelectOption(start, "p1", " high ");
    expect(made?.option).toBe("High");
    expect(made?.config).toBe(start);
  });

  it("addSelectOption refuses a blank name, a name over 100 characters and the 101st option", () => {
    expect(addSelectOption(config([]), "p1", "   ")).toBeNull();
    expect(addSelectOption(config([]), "p1", "x".repeat(101))).toBeNull();
    const full = config(Array.from({ length: MAX_SELECT_OPTIONS }, (_, index) => `o${index}`));
    expect(addSelectOption(full, "p1", "one more")).toBeNull();
  });

  it("addSelectOption leaves a property that is no select alone", () => {
    const status: DatabaseConfig = { properties: [{ id: "p1", name: "S", type: "status" }], views: [] };
    expect(addSelectOption(status, "p1", "High")).toBeNull();
  });

  it("renameSelectOption renames rows and the view filter that held it", () => {
    const renamed = renameSelectOption(config(["High", "Low"], "High"), "p1", "High", " Urgent ", [row("r1", "High"), row("r2", "Low")]);
    expect(options(renamed!.config)).toEqual(["Urgent", "Low"]);
    expect(renamed!.config.views[0].filter).toEqual({ property_id: "p1", value: "Urgent" });
    expect(renamed!.writes).toEqual([{ rowId: "r1", value: "Urgent" }]);
  });

  it("renameSelectOption refuses another option's name, and a blank one", () => {
    expect(renameSelectOption(config(["High", "Low"]), "p1", "High", " low ", [])).toBeNull();
    expect(renameSelectOption(config(["High"]), "p1", "High", "  ", [])).toBeNull();
  });

  it("removeSelectOption clears rows and drops the filter on it", () => {
    const removed = removeSelectOption(config(["High", "Low"], "High"), "p1", "High", [row("r1", "High"), row("r2", "Low")]);
    expect(options(removed.config)).toEqual(["Low"]);
    expect(removed.config.views[0].filter).toBeUndefined();
    expect(removed.writes).toEqual([{ rowId: "r1", value: "" }]);
  });

  it("moveSelectOption reorders", () => {
    expect(options(moveSelectOption(config(["a", "b", "c"]), "p1", "c", 0))).toEqual(["c", "a", "b"]);
    expect(options(moveSelectOption(config(["a", "b", "c"]), "p1", "a", 9))).toEqual(["b", "c", "a"]);
  });
});
