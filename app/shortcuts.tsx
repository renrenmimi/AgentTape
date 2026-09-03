"use client";

// The keys, in one place.
//
// A shortcut nobody can discover is a shortcut nobody has. The scope column is
// the part that was missing: several of these do something different depending
// on what has focus, and a list that does not say so teaches the wrong thing
// once and is never read again.

import { useRef } from "react";
import { useDialogFocus } from "./dialog";

export const SHORTCUTS: { keys: string[]; what: string; where: string }[] = [
  { keys: ["←", "→"], what: "Step back and forward", where: "anywhere in Replay" },
  { keys: ["⇧", "←", "→"], what: "Ten steps at a time", where: "anywhere in Replay" },
  { keys: ["PgUp", "PgDn"], what: "Fifty steps at a time", where: "the step list, rail and chart" },
  { keys: ["Home", "End"], what: "The first and last step", where: "anywhere in Replay" },
  { keys: ["↑", "↓"], what: "Move through the list", where: "the step list" },
  { keys: ["n"], what: "Next failure — or next match, while a filter is on", where: "Replay" },
  { keys: ["p"], what: "The same, backwards", where: "Replay" },
  { keys: ["/"], what: "Jump to the search box", where: "Replay" },
  { keys: ["c"], what: "Compare this run with another", where: "a loaded session" },
  { keys: ["a"], what: "Open Checks", where: "a loaded session" },
  { keys: ["?"], what: "This list", where: "anywhere" },
  { keys: ["Esc"], what: "Close the topmost thing that is open", where: "anywhere" },
];

export default function Shortcuts({ onClose }: { onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useDialogFocus(box);

  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="keys-title"
        tabIndex={-1}
        ref={box}
      >
        <div className="dialog-head">
          <h2 id="keys-title">Keyboard shortcuts</h2>
          <span className="spacer" />
          <button type="button" className="btn btn-sm" onClick={onClose}>Close</button>
        </div>
        <div className="dialog-body">
          <table className="data-table keys-table">
            <thead>
              <tr>
                <th scope="col">Keys</th>
                <th scope="col">What it does</th>
                <th scope="col">Where</th>
              </tr>
            </thead>
            <tbody>
              {SHORTCUTS.map((s) => (
                <tr key={s.what}>
                  <td className="keys-cell">{s.keys.map((k) => <kbd key={k}>{k}</kbd>)}</td>
                  <td>{s.what}</td>
                  <td className="dim">{s.where}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="sec-lead dim">
            Letter keys type when a text box has focus, and do nothing else. Arrow keys belong to
            whichever list, rail or chart has focus, and move the playhead otherwise.
          </p>
        </div>
      </div>
    </div>
  );
}
