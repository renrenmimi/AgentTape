"use client";

// The keys, in one place.
//
// The app has grown arrow keys, n and p, Home and End, a search box, two
// overlays and an escape route, and until now nothing told anyone. A shortcut
// nobody can discover is a shortcut nobody has.

import { useRef } from "react";
import { useDialogFocus } from "./dialog";

export const SHORTCUTS: { keys: string[]; what: string }[] = [
  { keys: ["←", "→"], what: "step back and forward" },
  { keys: ["⇧", "←", "→"], what: "ten steps at a time" },
  { keys: ["PgUp", "PgDn"], what: "fifty steps at a time" },
  { keys: ["Home", "End"], what: "the first and last step" },
  { keys: ["n", "p"], what: "next and previous failure — or match, while a filter is on" },
  { keys: ["/"], what: "jump to the search box" },
  { keys: ["c"], what: "compare this run with another" },
  { keys: ["a"], what: "assertions about this run" },
  { keys: ["?"], what: "this list" },
  { keys: ["Esc"], what: "close whatever is open" },
];

export default function Shortcuts({ onClose }: { onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useDialogFocus(box);

  return (
    <div className="sheet-scrim" onClick={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        tabIndex={-1}
        ref={box}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-head">
          <span className="eyebrow">keyboard</span>
          <span className="spacer" />
          <button type="button" className="btn btn-sm" onClick={onClose}>Close</button>
        </div>
        <dl className="sheet-list">
          {SHORTCUTS.map((s) => (
            <div className="sheet-row" key={s.what}>
              <dt>{s.keys.map((k) => <kbd key={k}>{k}</kbd>)}</dt>
              <dd>{s.what}</dd>
            </div>
          ))}
        </dl>
        <p className="sheet-note">
          The keys work wherever you are, except inside a text box — there, they type.
        </p>
      </div>
    </div>
  );
}
