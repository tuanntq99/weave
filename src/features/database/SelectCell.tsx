import { Plus, X } from "lucide-react";
import { useRef, useState } from "react";
import { useWorkspace } from "../../app/workspace-context";
import { Popover } from "../../components/Popover";
import { imeComposing } from "../../core/keyboard";
import type { DatabaseProperty } from "../../core/types";
import { rectOf } from "../../hooks/useAnchoredPosition";
import { MAX_OPTION_NAME, propertyOptions } from "./database-model";
import { OptionTag } from "./properties";
import type { SelectEditing } from "./SelectOptions";

const sameName = (left: string, right: string) => left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();

/** A Select's cell, as Notion's: its option as a tag; pressed, a box to type
 *  in that finds an option or — when none has the name — makes it and
 *  chooses it, as one step of undo. */
export function SelectCell({
  property,
  value,
  readOnly,
  label,
  onChange,
  editing,
}: {
  property: DatabaseProperty;
  value: string;
  readOnly: boolean;
  label: string;
  onChange(next: string): void;
  editing?: SelectEditing;
}) {
  const { checkpointHistory } = useWorkspace();
  const button = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const options = propertyOptions(property);
  const found = options.filter((option) => !query.trim() || option.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const canCreate = Boolean(editing && query.trim()) && !options.some((option) => sameName(option, query));
  const choices: Array<{ kind: "option"; name: string } | { kind: "create" }> = [
    ...found.map((name) => ({ kind: "option" as const, name })),
    ...(canCreate ? [{ kind: "create" as const }] : []),
  ];

  const close = () => {
    setOpen(false);
    setQuery("");
    setActive(0);
  };
  const choose = (name: string) => {
    onChange(name);
    close();
  };
  const create = () => {
    if (!editing) return;
    // The option and the cell's value are one step of undo.
    checkpointHistory();
    const made = editing.add(query);
    if (made) onChange(made);
    checkpointHistory();
    close();
  };
  const pick = (index: number) => {
    const choice = choices[index];
    if (!choice) return;
    if (choice.kind === "create") create();
    else choose(choice.name);
  };

  return (
    <span className="db__cell db__cell--select">
      <button
        ref={button}
        type="button"
        className="select-cell"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-history-field={`property:${property.id}`}
        disabled={readOnly}
        onClick={() => setOpen(true)}
      >
        {value ? <OptionTag property={property} value={value} /> : <span className="select-cell__empty">Empty</span>}
      </button>
      <Popover
        open={open}
        anchor={open && button.current ? rectOf(button.current) : null}
        placement="bottom-start"
        role="dialog"
        label={label}
        onDismiss={close}
      >
        <div className="select-cell__menu">
          <input
            className="select-cell__search"
            aria-label="Find or create an option"
            placeholder="Find or create an option…"
            autoFocus
            value={query}
            maxLength={MAX_OPTION_NAME}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              // Keys that end an input method's composition are the IME's.
              if (imeComposing(event)) return;
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActive((at) => Math.min(at + 1, Math.max(0, choices.length - 1)));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive((at) => Math.max(0, at - 1));
              } else if (event.key === "Enter") {
                event.preventDefault();
                // Typed a name that is an option already: that one.
                const same = options.find((option) => query.trim() && sameName(option, query));
                if (same) choose(same);
                else pick(active);
              } else if (event.key === "Escape") {
                event.preventDefault();
                close();
              }
            }}
          />
          <div role="listbox" aria-label="Options" className="select-cell__list">
            {choices.map((choice, index) => (
              <button
                key={choice.kind === "create" ? "\u0000create" : choice.name}
                type="button"
                role="option"
                aria-selected={index === active}
                className={`menu__item ${index === active ? "is-active" : ""}`}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(index)}
                onClick={() => pick(index)}
              >
                {choice.kind === "create" ? (
                  <><span className="menu__icon"><Plus size={14} /></span><span className="menu__label">{`Create “${query.trim()}”`}</span></>
                ) : (
                  <OptionTag property={property} value={choice.name} />
                )}
              </button>
            ))}
            {value ? (
              <button type="button" className="menu__item" onMouseDown={(event) => event.preventDefault()} onClick={() => choose("")}>
                <span className="menu__icon"><X size={14} /></span><span className="menu__label">Clear</span>
              </button>
            ) : null}
          </div>
        </div>
      </Popover>
    </span>
  );
}
