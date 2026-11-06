import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import { useState } from "react";
import { MenuList } from "../../components/Menu";
import { Popover } from "../../components/Popover";
import { imeComposing } from "../../core/keyboard";
import type { DatabaseProperty } from "../../core/types";
import type { AnchorRect } from "../../hooks/useAnchoredPosition";
import { MAX_OPTION_NAME } from "./database-model";

/** What a Select's options can be made to do, by its cells and its menu —
 *  each a change of the database, as the view that owns it writes it. */
export interface SelectEditing {
  /** The option named so (made when there is none): null when it cannot be. */
  add(name: string): string | null;
  rename(from: string, to: string): boolean;
  remove(name: string): void;
  move(name: string, index: number): void;
}

/** "Edit options" beside a Select's column menu: each option renamed in
 *  place, moved up or down, or deleted (its rows cleared). */
export function SelectOptionsMenu({
  anchor,
  group,
  property,
  editing,
  onClose,
}: {
  anchor: AnchorRect;
  group: string;
  property: DatabaseProperty;
  editing: SelectEditing;
  onClose(): void;
}) {
  const options = property.options ?? [];
  const [draft, setDraft] = useState("");

  return (
    <Popover open anchor={anchor} placement="right-start" label="Edit options" group={group} onDismiss={onClose}>
      <MenuList label="Edit options" className="select-options">
        <div className="menu__section-title">Options</div>
        {options.length ? options.map((option, index) => (
          <div key={option} className="select-options__row">
            <input
              className="select-options__name"
              aria-label={`Rename ${option}`}
              defaultValue={option}
              maxLength={MAX_OPTION_NAME}
              onKeyDown={(event) => {
                if (imeComposing(event)) return;
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") {
                  event.currentTarget.value = option;
                  event.currentTarget.blur();
                }
              }}
              onBlur={(event) => {
                const next = event.currentTarget.value;
                if (next.trim() === option) return;
                if (!editing.rename(option, next)) event.currentTarget.value = option;
              }}
            />
            <button type="button" className="icon-btn icon-btn--sm" aria-label={`Move ${option} up`} disabled={index === 0} onClick={() => editing.move(option, index - 1)}>
              <ArrowUp size={14} />
            </button>
            <button type="button" className="icon-btn icon-btn--sm" aria-label={`Move ${option} down`} disabled={index === options.length - 1} onClick={() => editing.move(option, index + 1)}>
              <ArrowDown size={14} />
            </button>
            <button type="button" className="icon-btn icon-btn--sm" aria-label={`Delete ${option}`} onClick={() => editing.remove(option)}>
              <Trash2 size={14} />
            </button>
          </div>
        )) : <p className="select-options__empty">No options yet</p>}
        <input
          className="select-options__new"
          aria-label="Add an option"
          placeholder="Add an option…"
          value={draft}
          maxLength={MAX_OPTION_NAME}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (imeComposing(event) || event.key !== "Enter" || !draft.trim()) return;
            if (editing.add(draft)) setDraft("");
          }}
        />
      </MenuList>
    </Popover>
  );
}
