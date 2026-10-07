"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { IconCheck, IconSearch } from "./Icons";

export interface ListboxOption {
  value: string;
  label: string;
  description?: string;
  icon?: React.ReactNode;
}

// An accessible single-select popover: a button that opens a listbox. Native
// <select> cannot carry the description / icon / search this platform needs,
// so this implements the same keyboard contract itself:
//   - Trigger: Enter / Space / ArrowDown opens.
//   - Open: focus moves to the selected option (or the search field when the
//     list is long); ArrowUp/Down/Home/End move; Enter/Space selects; Esc
//     closes and returns focus to the trigger; Tab closes; click outside
//     closes.
// Options are real <button role="option"> elements, so assistive tech and
// pointer/keyboard users get identical behaviour.
export function Listbox({
  options,
  value,
  onSelect,
  disabled = false,
  heading,
  ariaLabel,
  placement = "below",
  panelClassName,
  searchable,
  trigger,
  triggerClassName,
}: {
  options: ListboxOption[];
  value: string;
  onSelect: (value: string) => void;
  disabled?: boolean;
  heading: string;
  ariaLabel: string;
  placement?: "below" | "right";
  // Overrides the popover position (e.g. to span a wider parent block).
  panelClassName?: string;
  // Defaults to showing search once the list is long enough to need it.
  searchable?: boolean;
  trigger: React.ReactNode;
  triggerClassName: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const showSearch = searchable ?? options.length > 7;
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q
      ? options.filter((o) => o.label.toLowerCase().includes(q))
      : options;
  }, [options, query]);

  function optionButtons(): HTMLButtonElement[] {
    return Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ??
        [],
    );
  }

  function close(returnFocus: boolean) {
    setOpen(false);
    setQuery("");
    if (returnFocus) triggerRef.current?.focus();
  }

  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (showSearch) {
      searchRef.current?.focus();
    } else {
      const items = Array.from(
        listRef.current?.querySelectorAll<HTMLButtonElement>(
          '[role="option"]',
        ) ?? [],
      );
      (items.find((el) => el.dataset.selected === "true") ?? items[0])?.focus();
    }
  }, [open, showSearch]);

  function onKeyDown(event: React.KeyboardEvent) {
    if (!open) return;
    if (event.key === "Escape") {
      event.preventDefault();
      // Keep an enclosing dialog (the mobile drawer) open.
      event.stopPropagation();
      close(true);
      return;
    }
    if (event.key === "Tab") {
      close(false);
      return;
    }
    const items = optionButtons();
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    let next: number | null = null;
    if (event.key === "ArrowDown") {
      next = index < 0 ? 0 : Math.min(index + 1, items.length - 1);
    } else if (event.key === "ArrowUp") {
      if (index <= 0 && showSearch) {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      next = Math.max(index - 1, 0);
    } else if (event.key === "Home" && index >= 0) {
      next = 0;
    } else if (event.key === "End" && index >= 0) {
      next = items.length - 1;
    }
    if (next !== null) {
      event.preventDefault();
      items[next]?.focus();
    }
  }

  const panelPosition =
    panelClassName ??
    (placement === "right"
      ? "left-full top-0 ml-2"
      : "left-0 right-0 top-full mt-1.5");

  return (
    <div ref={rootRef} className="relative" onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        onClick={() => (open ? close(false) : setOpen(true))}
        onKeyDown={(event) => {
          if (!open && event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className={triggerClassName}
      >
        {trigger}
      </button>

      {open ? (
        <div
          className={`cx-pop-in absolute z-40 min-w-64 overflow-hidden rounded-xl border border-border-default bg-surface-card ${panelPosition}`}
          style={{ boxShadow: "var(--cx-shadow-pop)" }}
        >
          <p className="px-3.5 pb-1 pt-3 text-xs font-medium text-text-muted">
            {heading}
          </p>
          {showSearch ? (
            <div className="px-2.5 pb-1.5 pt-1">
              <label className="flex items-center gap-2 rounded-lg bg-surface-subtle px-2.5 py-1.5 text-text-muted focus-within:ring-2 focus-within:ring-focus">
                <IconSearch className="h-4 w-4" />
                <span className="sr-only">Search {heading.toLowerCase()}</span>
                <input
                  ref={searchRef}
                  type="text"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search"
                  className="min-w-0 flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-muted"
                />
              </label>
            </div>
          ) : null}
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={ariaLabel}
            className="cx-scroll max-h-72 overflow-y-auto p-1.5"
          >
            {visible.length === 0 ? (
              <p className="px-2.5 py-3 text-sm text-text-muted">No matches.</p>
            ) : (
              visible.map((option) => {
                const selected = option.value === value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    data-selected={selected}
                    onClick={() => {
                      close(true);
                      if (!selected) onSelect(option.value);
                    }}
                    className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors hover:bg-surface-subtle focus-visible:bg-surface-subtle focus-visible:outline-none ${
                      selected ? "text-text-primary" : "text-text-secondary"
                    }`}
                  >
                    {option.icon ? (
                      <span className="text-text-muted">{option.icon}</span>
                    ) : null}
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span
                        className={`truncate ${selected ? "font-medium" : ""}`}
                      >
                        {option.label}
                      </span>
                      {option.description ? (
                        <span className="truncate text-xs text-text-muted">
                          {option.description}
                        </span>
                      ) : null}
                    </span>
                    {selected ? (
                      <IconCheck className="h-4 w-4 text-accent" />
                    ) : null}
                  </button>
                );
              })
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
