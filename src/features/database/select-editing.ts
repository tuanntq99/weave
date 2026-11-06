import type { DatabaseConfig, NotePage } from "../../core/types";
import { addSelectOption, moveSelectOption, removeSelectOption, renameSelectOption, type RowWrite } from "./database-model";
import type { SelectEditing } from "./SelectOptions";

/** A Select's options made editable over a database: each change saved as
 *  its owner saves the database, and the rows a rename or a delete touches
 *  written as it writes rows. Where the database is read only, nothing. */
export function selectEditingFor({
  config,
  propertyId,
  rows,
  readOnly,
  saveConfig,
  writeRows,
}: {
  config: DatabaseConfig;
  propertyId: string;
  rows: readonly NotePage[];
  readOnly: boolean;
  saveConfig(next: DatabaseConfig): void;
  writeRows(propertyId: string, writes: RowWrite[]): void;
}): SelectEditing {
  return {
    add: (name) => {
      const made = readOnly ? null : addSelectOption(config, propertyId, name);
      if (!made) return null;
      if (made.config !== config) saveConfig(made.config);
      return made.option;
    },
    rename: (from, to) => {
      const renamed = readOnly ? null : renameSelectOption(config, propertyId, from, to, rows);
      if (!renamed) return false;
      saveConfig(renamed.config);
      writeRows(propertyId, renamed.writes);
      return true;
    },
    remove: (name) => {
      if (readOnly) return;
      const removed = removeSelectOption(config, propertyId, name, rows);
      saveConfig(removed.config);
      writeRows(propertyId, removed.writes);
    },
    move: (name, index) => {
      if (!readOnly) saveConfig(moveSelectOption(config, propertyId, name, index));
    },
  };
}
