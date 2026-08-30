"use client";

// Stepping through a delegated run.
//
// A summary answers "was that expensive". It does not answer "what did it do",
// and one of the delegated runs in the probe corpus made 130 tool calls — that
// is a session, not a footnote.
//
// So this is the workbench again, pointed at the subagent's own tape: the same
// timeline, the same messages panel, the same step detail, built from the same
// components rather than reimplemented. What it deliberately does not have is
// the things that belong to a top-level run — the filter bar, the comparison,
// the assertions, the redaction export — because a nested run is something you
// are looking *into*, not something you are working *on*.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { pairTools } from "@/lib/parser";
import { fmtBytes, fmtDuration, fmtInt, fmtTokens } from "@/lib/summary";
import type { SubRun } from "@/lib/subagents";
import Timeline from "./timeline";
import MessagesPanel from "./messages-panel";
import StepDetail from "./step-detail";
import { useDialogFocus } from "./dialog";

type Props = {
  run: SubRun;
  /** Which step of the parent delegated this, so the header can say. */
  parentStep: number;
  onClose: () => void;
};

export default function NestedWorkbench({ run, parentStep, onClose }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  useDialogFocus(panel);

  const tape = run.tape;
  const [pos, setPos] = useState(0);
  const pairs = useMemo(() => pairTools(tape.steps), [tape]);

  // Bookkeeping records are filtered out here as they are upstairs, so the two
  // timelines count steps the same way.
  const steps = useMemo(() => tape.steps.filter((s) => s.kind !== "meta"), [tape]);
  const at = useMemo(() => {
    const out = new Int32Array(tape.steps.length).fill(-1);
    steps.forEach((s, k) => { out[s.i] = k; });
    return out;
  }, [tape, steps]);

  const curGlobal = steps.length ? steps[Math.min(pos, steps.length - 1)].i : 0;
  const shownIndex = useCallback((gi: number) => (at[gi] >= 0 ? at[gi] + 1 : 0), [at]);
  const goToGlobal = useCallback((gi: number) => {
    if (at[gi] >= 0) setPos(at[gi]);
  }, [at]);

  const seekNext = useCallback((dir: 1 | -1) => {
    for (let i = pos + dir; i >= 0 && i < steps.length; i += dir) {
      if (steps[i].err) { setPos(i); return; }
    }
  }, [pos, steps]);

  // Arrows and n/p, scoped to this overlay. Escape is the page's job.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A keydown dispatched on `window` — which is what a shortcut sent by
      // the page itself looks like, and what the self-test sends — has a
      // target that is not a Node at all. `contains` throws on one rather
      // than returning false, so the cast this used to do was a lie that
      // took the whole handler down with it.
      const t = e.target;
      if (!(t instanceof HTMLElement) || !panel.current?.contains(t)) return;
      if (t.closest(".track-hit")) return;
      const tag = t.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || t.isContentEditable) return;
      const n = steps.length;
      const big = e.shiftKey ? 10 : 1;
      let next = pos;
      if (e.key === "ArrowRight") next = pos + big;
      else if (e.key === "ArrowLeft") next = pos - big;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = n - 1;
      else if (e.key === "n" || e.key === "N") { e.preventDefault(); seekNext(1); return; }
      else if (e.key === "p" || e.key === "P") { e.preventDefault(); seekNext(-1); return; }
      else return;
      e.preventDefault();
      setPos(Math.max(0, Math.min(n - 1, next)));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pos, steps, seekNext]);

  const wall = run.lastT && run.firstT ? run.lastT - run.firstT : 0;

  return (
    <div className="nested-wb" role="dialog" aria-modal="true"
      aria-label="A delegated run" tabIndex={-1} ref={panel}>
      <header className="strip">
        <div className="strip-brand">
          <b>Delegated run</b>
        </div>
        <div className="stat">
          <span className="eyebrow stat-k">from</span>
          <span className="stat-v">step {fmtInt(parentStep)}</span>
        </div>
        <div className="stat">
          <span className="eyebrow stat-k">agent</span>
          <span className="stat-v">{run.agentId.slice(0, 10)}</span>
        </div>
        <div className="stat">
          <span className="eyebrow stat-k">steps</span>
          <span className="stat-v">{fmtInt(run.steps)}<small>{fmtBytes(run.bytes)}</small></span>
        </div>
        <div className="stat">
          <span className="eyebrow stat-k">tool calls</span>
          <span className="stat-v">{fmtInt(run.toolCalls)}</span>
        </div>
        <div className={"stat" + (run.errors ? " stat-risk" : "")}>
          <span className="eyebrow stat-k">errors</span>
          <span className="stat-v">{fmtInt(run.errors)}</span>
        </div>
        <div className="stat">
          <span className="eyebrow stat-k">tokens</span>
          <span className="stat-v">
            {fmtTokens(run.input + run.cacheRead + run.cacheCreate)}
            <small>in · {fmtTokens(run.output)} out</small>
          </span>
        </div>
        <div className="stat">
          <span className="eyebrow stat-k">wall clock</span>
          <span className="stat-v">{fmtDuration(wall)}</span>
        </div>
        <div className="strip-actions">
          <button type="button" className="btn btn-sm" onClick={onClose}>Close</button>
        </div>
      </header>

      <section className="tracks" aria-label="Timeline of the delegated run">
        <div className="track-head">
          <span className="eyebrow">delegated timeline</span>
          <span className="spacer" />
          <span className="entry-tok">step {pos + 1} / {steps.length}</span>
          <span className="entry-tok">
            <kbd>←</kbd> <kbd>→</kbd> step · <kbd>n</kbd> <kbd>p</kbd> failures · <kbd>Esc</kbd> back
          </span>
        </div>
        <Timeline steps={steps} pos={pos} onPos={setPos} onSeek={seekNext} />
      </section>

      <div className="body">
        <MessagesPanel
          entries={tape.entries}
          steps={tape.steps}
          curStep={curGlobal}
          redacted={tape.meta.redacted}
          onSelectStep={goToGlobal}
          shownIndex={shownIndex}
          entryHits={null}
        />
        <StepDetail
          tape={tape}
          curStep={curGlobal}
          pairs={pairs}
          onSelectStep={goToGlobal}
          shownIndex={shownIndex}
          delegation={null}
          onLoadSubagent={null}
          subLoading={false}
          subError=""
          offeredBytes={0}
          outOfFilter={false}
        />
      </div>
    </div>
  );
}
