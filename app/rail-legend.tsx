"use client";

// What the marks on the position rail mean.
//
// The rail draws a different shape per kind of step and a different one again
// for a failure, which is what keeps it readable with no colour perception at
// all. That is only worth anything if somebody can find out what the shapes
// are — and the old answer, a permanent band of eight glyphs and their names
// above the content, cost more room than it was worth to a reader who mostly
// wants the list.
//
// So the words come first: every step in the list says what it is, in full.
// This is the legend for the rail, one control away, for the moment somebody
// looks at the strip and wonders. Nothing is only in here.

import { useEffect, useId, useRef, useState } from "react";
import type { StepKind } from "@/lib/format";
import { KIND_NAME } from "@/lib/labels";
import { DelegateGlyph, FailGlyph, KindGlyph } from "./glyphs";
import { HelpIcon } from "./icons";

const KINDS: StepKind[] = ["user", "text", "thinking", "tool-call", "tool-result", "system"];

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

  return (
    <div className="popover-host" ref={host}>
      <button
        type="button"
        className="btn btn-sm btn-icon btn-quiet"
        aria-label="What the marks on the position rail mean"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <HelpIcon />
      </button>
      {open && (
        <div
          className="popover popover-narrow"
          id={id}
          role="group"
          aria-label="Marks on the position rail"
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.stopPropagation();
            setOpen(false);
            host.current?.querySelector("button")?.focus();
          }}
        >
          <h3 className="popover-title">Marks on the rail</h3>
          <ul className="legend">
            {KINDS.map((k) => (
              <li key={k}>
                <span className="legend-mark"><KindGlyph kind={k} size={12} /></span>
                <span>{KIND_NAME[k]}</span>
              </li>
            ))}
            <li className="legend-fail">
              <span className="legend-mark"><FailGlyph size={12} /></span>
              <span>Failed — taller and a different shape, not only a different colour</span>
            </li>
            {delegations && (
              <li className="legend-delegate">
                <span className="legend-mark"><DelegateGlyph size={12} /></span>
                <span>Delegated to a subagent</span>
              </li>
            )}
          </ul>
          <p className="sec-lead dim">
            Below about three pixels a step the shapes stop being distinguishable, so the rail
            becomes a density plot rather than pretending to a resolution it does not have. The
            list beside it always says what each step is, in words.
          </p>
        </div>
      )}
    </div>
  );
}
