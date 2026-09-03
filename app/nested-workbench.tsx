"use client";

// Stepping through a delegated run.
//
// A summary answers "was that expensive". It does not answer "what did it do",
// and one of the delegated runs in the probe corpus made 130 tool calls — that
// is a session, not a footnote.
//
// So this is the replay again, pointed at the subagent's own tape: the same
// component, the same list, the same subviews, rather than a second
// implementation that would drift. What it deliberately does not carry is the
// things that belong to a top-level run — the filter, the comparison, the
// checks, the redaction export — because a nested run is something you are
// looking *into*, not something you are working *on*, and an Export button
// here would be ambiguous about which run it meant.
//
// A breadcrumb and a way back, because the failure mode of a nested view is
// arriving somewhere with no idea how to leave. The parent stays mounted
// underneath, so leaving restores its scroll position and its focus without
// anything having to remember them.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { pairTools } from "@/lib/parser";
import { fmtInt, summarise, traceJump } from "@/lib/summary";
import type { SubRun } from "@/lib/subagents";
import Replay, { type DetailTab, type LeftMode } from "./replay";
import { useDialogFocus } from "./dialog";
import { BackIcon } from "./icons";

type Props = {
  run: SubRun;
  /** Which step of the parent delegated this, as the parent numbers it. */
  parentStep: number;
  /** What the parent session is called, for the breadcrumb. */
  parentLabel: string;
  onClose: () => void;
};

export default function NestedWorkbench({ run, parentStep, parentLabel, onClose }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  useDialogFocus(panel);

  const tape = run.tape;
  const [pos, setPos] = useState(0);
  const [leftMode, setLeftMode] = useState<LeftMode>("steps");
  const [tab, setTab] = useState<DetailTab>("details");
  const [entriesOpen, setEntriesOpen] = useState<Set<number>>(() => new Set());
  const [follow, setFollow] = useState(true);
  const [revealKey, setRevealKey] = useState(0);

  const pairs = useMemo(() => pairTools(tape.steps), [tape]);
  const summary = useMemo(() => summarise(tape), [tape]);

  // Bookkeeping records are filtered out here as they are upstairs, so the two
  // step lists count the same way.
  const steps = useMemo(() => tape.steps.filter((s) => s.kind !== "meta"), [tape]);
  const at = useMemo(() => {
    const out = new Int32Array(tape.steps.length).fill(-1);
    steps.forEach((s, k) => { out[s.i] = k; });
    return out;
  }, [tape, steps]);

  const curGlobal = steps.length ? steps[Math.min(pos, steps.length - 1)].i : 0;
  const shownIndex = useCallback((gi: number) => (at[gi] >= 0 ? at[gi] + 1 : 0), [at]);
  const goToGlobal = useCallback((gi: number) => {
    if (at[gi] >= 0) { setPos(at[gi]); setRevealKey((k) => k + 1); }
  }, [at]);

  const seekNext = useCallback((dir: 1 | -1) => {
    for (let i = pos + dir; i >= 0 && i < steps.length; i += dir) {
      if (steps[i].err) { setPos(i); setRevealKey((k) => k + 1); return; }
    }
  }, [pos, steps]);

  const compactions = useMemo(
    () => summary.compactAt.map((i) => at[i]).filter((i) => i >= 0),
    [summary, at],
  );
  const trace = useMemo(
    () => traceJump(tape.steps, summary.jumpAt, summary.jumpBy),
    [tape, summary],
  );

  // Arrows and n/p, scoped to this layer. Escape is the page's job, and the
  // parent's handler stands down while this is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A keydown dispatched on `window` — which is what a shortcut sent by
      // the page itself looks like — has a target that is not a Node at all.
      // `contains` throws on one rather than returning false, so this narrows
      // instead of casting.
      const t = e.target;
      if (!(t instanceof HTMLElement) || !panel.current?.contains(t)) return;
      if (t.closest(".track-hit, .chart-hit, [role='listbox']")) return;
      const tag = t.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || t.isContentEditable) return;
      const n = steps.length;
      const big = e.shiftKey ? 10 : 1;
      let next = pos;
      if (e.key === "ArrowRight") next = pos + big;
      else if (e.key === "ArrowLeft") next = pos - big;
      else if (e.key === "PageDown") next = pos + 50;
      else if (e.key === "PageUp") next = pos - 50;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = n - 1;
      else if (e.key === "n" || e.key === "N") { e.preventDefault(); seekNext(1); return; }
      else if (e.key === "p" || e.key === "P") { e.preventDefault(); seekNext(-1); return; }
      else return;
      e.preventDefault();
      setPos(Math.max(0, Math.min(n - 1, next)));
      setRevealKey((k) => k + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pos, steps, seekNext]);

  return (
    <div
      className="layer"
      role="dialog"
      aria-modal="true"
      aria-label="A delegated run"
      tabIndex={-1}
      ref={panel}
    >
      <nav className="crumbs" aria-label="Where you are">
        <button type="button" className="btn btn-quiet btn-sm" onClick={onClose}>
          <BackIcon />
          <span>Back to step {fmtInt(parentStep)}</span>
        </button>
        <ol className="crumb-trail">
          <li>{parentLabel || "Session"}</li>
          <li>Step {fmtInt(parentStep)}</li>
          <li aria-current="page">Delegated run</li>
        </ol>
        <span className="spacer" />
        <span className="crumb-note">
          {fmtInt(run.steps)} steps · {fmtInt(run.toolCalls)} tool calls
          {run.errors > 0 && <> · {fmtInt(run.errors)} failed</>}
        </span>
      </nav>

      <Replay
        title="Delegated run"
        tape={tape}
        steps={steps}
        pos={pos}
        onPos={(k) => setPos(k)}
        curGlobal={curGlobal}
        pairs={pairs}
        shownIndex={shownIndex}
        onSelectStep={goToGlobal}
        summary={summary}
        trace={trace}
        compactions={compactions}
        jumpAt={at[summary.jumpAt] >= 0 ? at[summary.jumpAt] : 0}
        fellAtShown={trace && trace.fellAt >= 0 ? shownIndex(trace.fellAt) : 0}
        leftMode={leftMode}
        onLeftMode={setLeftMode}
        tab={tab}
        onTab={setTab}
        filter={null}
        onFilter={() => {}}
        filterIndex={null}
        matches={0}
        mask={null}
        ordinal={0}
        onSeek={seekNext}
        onJumpCompaction={() => {
          if (!compactions.length) return;
          setPos(compactions.find((i) => i > pos) ?? compactions[0]);
          setRevealKey((k) => k + 1);
        }}
        // Bookkeeping records are always out of view here, so there is no toggle
        // to offer: a control that cannot do anything is worse than no control.
        metaSteps={0}
        showMeta={false}
        onShowMeta={() => {}}
        delegatedMask={null}
        delegation={null}
        onLoadSubagent={null}
        subLoading={false}
        subError=""
        offeredBytes={0}
        entryHits={null}
        entriesOpen={entriesOpen}
        onEntriesOpen={setEntriesOpen}
        follow={follow}
        onFollow={setFollow}
        revealKey={revealKey}
        nested
      />
    </div>
  );
}
