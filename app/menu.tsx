"use client";

// A menu button, with the keyboard behaviour a menu button is supposed to have.
//
// This exists because the alternative — a `<details>` with links in it — looks
// identical and behaves differently: arrow keys do nothing, focus does not
// come back to the trigger on Escape, and a screen reader is told it is a
// disclosure widget rather than a menu. Those are the three things somebody
// without a mouse actually needs.
//
// Everything it holds is a real action with a name. Nothing important lives
// only in here: the rule is that a menu holds the second-most-used things, not
// the things there was no room for.

import {
  useCallback, useEffect, useId, useRef, useState, type ReactNode,
} from "react";

export type MenuItem = {
  label: string;
  onSelect: () => void;
  /** Shown under the label when the action needs a word of explanation. */
  note?: string;
  disabled?: boolean;
  /**
   * Set on items that are a choice rather than an action — the theme, for
   * instance. Present makes the item a radio, so the current value is
   * announced as chosen rather than being a tick somebody has to see.
   */
  selected?: boolean;
};

type Props = {
  label: string;
  items: MenuItem[];
  /** Rendered inside the trigger, before the label. */
  icon?: ReactNode;
  /** "action" gives the trigger the secondary-button look; "quiet" is bare. */
  look?: "action" | "quiet";
  align?: "start" | "end";
};

export default function Menu({ label, items, icon, look = "action", align = "end" }: Props) {
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();

  const close = useCallback((focusTrigger: boolean) => {
    setOpen(false);
    if (focusTrigger) trigger.current?.focus();
  }, []);

  // Focus follows the active item, which is what makes a screen reader read it.
  useEffect(() => {
    if (!open) return;
    const nodes = list.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
    nodes?.[at]?.focus();
  }, [open, at]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (list.current?.contains(t) || trigger.current?.contains(t)) return;
      setOpen(false);
    };
    // Capture, so a click that also opens another menu still closes this one.
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [open]);

  const usable = items.filter((i) => !i.disabled);

  const onTriggerKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setAt(0);
      setOpen(true);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setAt(Math.max(0, items.length - 1));
      setOpen(true);
    }
  };

  const onListKey = (e: React.KeyboardEvent) => {
    const n = items.length;
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(true); return; }
    if (e.key === "Tab") { close(false); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setAt((i) => (i + 1) % n); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); setAt((i) => (i - 1 + n) % n); return; }
    if (e.key === "Home") { e.preventDefault(); setAt(0); return; }
    if (e.key === "End") { e.preventDefault(); setAt(n - 1); return; }
  };

  return (
    <div className="menu-host">
      <button
        type="button"
        ref={trigger}
        className={look === "quiet" ? "btn btn-quiet menu-trigger" : "btn menu-trigger"}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={usable.length === 0}
        onClick={() => { setAt(0); setOpen((v) => !v); }}
        onKeyDown={onTriggerKey}
      >
        {icon}
        <span>{label}</span>
        <svg className="menu-caret" width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M2 4l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.4"
            strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div
          id={id}
          className={"menu-list menu-" + align}
          role="menu"
          aria-label={label}
          ref={list}
          onKeyDown={onListKey}
        >
          {items.map((item, i) => (
            <button
              type="button"
              key={item.label}
              role={item.selected === undefined ? "menuitem" : "menuitemradio"}
              aria-checked={item.selected === undefined ? undefined : item.selected}
              tabIndex={i === at ? 0 : -1}
              className={"menu-item" + (item.selected ? " menu-item-on" : "")}
              disabled={item.disabled}
              onFocus={() => setAt(i)}
              onClick={() => { close(true); item.onSelect(); }}
            >
              {item.selected !== undefined && (
                <svg className="menu-tick" width="14" height="14" viewBox="0 0 14 14" aria-hidden>
                  {item.selected && (
                    <path d="M2.6 7.4l2.8 2.8 6-6" fill="none" stroke="currentColor"
                      strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  )}
                </svg>
              )}
              <span className="menu-item-label">{item.label}</span>
              {item.note && <span className="menu-item-note">{item.note}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
