"use client";

// The key to the rail: three levels, not eight shapes.
//
// The rail's grammar is height and colour. Quiet things are short and grey;
// events are tall and semantic; the current step is a full-height line. That
// is learnable in one look, which is the point — but it still has to be
// *stated* somewhere, and the words come first everywhere else: every row in
// the step list says what its step is, and every event on the rail is a button
// whose accessible name reads "Step 14 · Edit failed".
//
// So this is small, labelled `Key` rather than a bare question mark, and shut
// by default. It draws the real marks at the size the rail draws them, because
// a legend of coloured squares standing in for the marks is a legend of
// coloured squares.

import { useEffect, useId, useRef, useState } from "react";

type Row = { cls: string; name: string; what: string };

const ROWS: Row[] = [
  { cls: "key-step", name: "Step", what: "an ordinary step — texture, so you can see where the run is dense" },
  { cls: "key-tool", name: "Tool call", what: "slightly taller, because tool calls are the shape of a run" },
  { cls: "key-fail", name: "Failure", what: "tall, red, square cap" },
  { cls: "key-compaction", name: "Compaction", what: "tall, amber, diamond cap" },
  { cls: "key-delegation", name: "Delegation", what: "a dot on a stem" },
  { cls: "key-now", name: "Current step", what: "full height, with a triangle at the top" },
];

export default function RailLegend({ delegations }: { delegations: boolean }) {
  const [open, setOpen] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!host.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [open]);

  const rows = delegations ? ROWS : ROWS.filter((r) => r.cls !== "key-delegation");

  return (
    <div className="popover-host" ref={host}>
      <button
        type="button"
        className="btn btn-sm btn-quiet"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        Key
      </button>
      {open && (
        <div
          className="popover popover-narrow"
          id={id}
          role="group"
          aria-label="What the marks on the rail mean"
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.stopPropagation();
            setOpen(false);
            host.current?.querySelector("button")?.focus();
          }}
        >
          <h3 className="popover-title">Marks on the rail</h3>
          <dl className="key-list">
            {rows.map((r) => (
              <div className="key-row" key={r.cls}>
                <dt>
                  <span className={"key-mark " + r.cls} aria-hidden />
                  <span>{r.name}</span>
                </dt>
                <dd>{r.what}</dd>
              </div>
            ))}
          </dl>
          <p className="sec-lead dim">
            Every event on the rail is also a button: reach it with Tab, and its name is read
            out in full. Hovering or focusing anywhere on the rail names the step under it.
          </p>
        </div>
      )}
    </div>
  );
}
