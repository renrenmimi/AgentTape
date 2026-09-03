"use client";

// The steps, as a list you can read.
//
// The thing this replaces was a canvas rail of eight tick shapes with a legend
// above it. The rail is still there — it is good at density and at showing
// where in a run you are — but it was never able to answer "what is step 7",
// and that is the question somebody has when they arrive.
//
// So every row says what the step is in task language ("Tool call · Read",
// "Context compaction"), carries its own number, and states failure and
// delegation in words as well as in colour. The names are a presentation
// layer: `lib/labels.ts` maps kind and tool to a phrase, and the record's real
// type and role are untouched underneath and shown in Record data.
//
// Virtualised at a fixed row height, which is what keeps a six-thousand-step
// session from putting six thousand rows in the DOM. The height is fixed
// rather than measured because a measure-then-reflow pass on a list this long
// is the thing that makes scrolling stutter.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Step } from "@/lib/format";
import { stepLabel } from "@/lib/labels";
import { fmtInt } from "@/lib/summary";

export const ROW = 64;
const OVER = 6; // rows of overscan above and below

type Props = {
  /** The steps in view order — filtering dims, it does not remove. */
  steps: Step[];
  /** Position in `steps`, not a global index. */
  pos: number;
  onPos: (k: number) => void;
  /** One byte per view position: 1 matches the active filter. null when off. */
  mask: Uint8Array | null;
  /** One byte per view position: 1 delegated its work to a subagent. */
  delegated: Uint8Array | null;
  /** What a step is called on screen. */
  shownIndex: (globalIndex: number) => number;
  /** The tool a step belongs to, following a result back to its call. */
  toolOf: (globalIndex: number) => string;
  /** Bumped by the owner to ask the list to scroll the selection into view. */
  revealKey: number;
};

export default function StepList({
  steps, pos, onPos, mask, delegated, shownIndex, toolOf, revealKey,
}: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(600);
  const raf = useRef(0);
  const n = steps.length;

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    setViewH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const onScroll = useCallback(() => {
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      const el = scroller.current;
      if (el) setScrollTop(el.scrollTop);
    });
  }, []);

  useEffect(() => () => { if (raf.current) cancelAnimationFrame(raf.current); }, []);

  // Bring the selection into view without yanking the list around: only scroll
  // when the row is actually outside, and land it a third of the way down so
  // the steps before it stay in shot.
  useEffect(() => {
    const el = scroller.current;
    if (!el || pos < 0 || pos >= n) return;
    const top = pos * ROW;
    const h = el.clientHeight || viewH;
    if (top >= el.scrollTop && top + ROW <= el.scrollTop + h) return;
    const want = Math.max(0, Math.min(n * ROW - h, top - h * 0.33));
    el.scrollTop = want;
    setScrollTop(want);
  }, [pos, n, viewH, revealKey]);

  const [from, to] = useMemo(() => {
    const first = Math.max(0, Math.floor(scrollTop / ROW) - OVER);
    const last = Math.min(n, Math.ceil((scrollTop + viewH) / ROW) + OVER);
    return [first, last];
  }, [scrollTop, viewH, n]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    let next = pos;
    if (e.key === "ArrowDown" || e.key === "ArrowRight") next = pos + (e.shiftKey ? 10 : 1);
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft") next = pos - (e.shiftKey ? 10 : 1);
    else if (e.key === "PageDown") next = pos + 50;
    else if (e.key === "PageUp") next = pos - 50;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    else return;
    e.preventDefault();
    // The list owns arrow keys while it has focus; letting them through would
    // move the playhead twice.
    e.stopPropagation();
    onPos(Math.max(0, Math.min(n - 1, next)));
  };

  const rows = [];
  for (let k = from; k < to; k++) {
    const s = steps[k];
    if (!s) continue;
    const on = k === pos;
    const dim = mask ? mask[k] === 0 : false;
    const cls = [
      "step-row",
      on ? "step-row-on" : "",
      dim ? "step-row-dim" : "",
      s.err ? "step-row-err" : "",
    ].join(" ");
    rows.push(
      <div
        key={s.i}
        id={`step-opt-${s.i}`}
        role="option"
        aria-selected={on}
        tabIndex={on ? 0 : -1}
        className={cls}
        style={{ top: k * ROW, height: ROW }}
        onClick={() => onPos(k)}
      >
        <span className="step-num">{fmtInt(shownIndex(s.i) || s.i + 1)}</span>
        <span className="step-main">
          <span className="step-label">
            {stepLabel(s, toolOf(s.i))}
            {s.err && <span className="tag tag-error">Failed</span>}
            {delegated?.[k] === 1 && <span className="tag tag-info">Delegated</span>}
            {dim && <span className="tag tag-quiet">Filtered out</span>}
          </span>
          <span className="step-summary">{s.preview || "no summary"}</span>
        </span>
      </div>,
    );
  }

  if (!n) {
    return (
      <div className="step-list-empty">
        <p className="empty-line">This session has no steps in view.</p>
      </div>
    );
  }

  const cur = steps[Math.max(0, Math.min(n - 1, pos))];

  return (
    <div
      className="step-list"
      ref={scroller}
      onScroll={onScroll}
      role="listbox"
      aria-label="Steps in this session"
      aria-activedescendant={cur ? `step-opt-${cur.i}` : undefined}
      onKeyDown={onKeyDown}
      data-testid="step-list"
    >
      <div className="step-list-inner" style={{ height: n * ROW }} data-count={n}>
        {rows}
      </div>
    </div>
  );
}
