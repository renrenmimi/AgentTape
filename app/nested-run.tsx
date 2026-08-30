"use client";

// A subagent's run, nested inside the step that delegated it.
//
// Deliberately not a second workbench. A strip of its steps drawn with the same
// tick shapes, its counts, its tools and what it cost — enough to answer "what
// happened in there and was it expensive", which is the question you have while
// looking at the parent. Anything more wants its own playhead, and two
// playheads on one screen is a different design.

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { Step } from "@/lib/format";
import type { Delegation, SubRun } from "@/lib/subagents";
import { fmtBytes, fmtDuration, fmtInt, fmtTokens } from "@/lib/summary";
import { ctx2d } from "./canvas";

const PAD = 6;
const H = 26;

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** The same eight shapes as the main rail, at a smaller scale. */
function tick(g: CanvasRenderingContext2D, s: Step, x: number, y: number, wide: boolean) {
  if (!wide) {
    g.fillRect(x - 0.5, y - 4, 1, 8);
    return;
  }
  switch (s.kind) {
    case "user": g.fillRect(x - 2, y - 2, 4, 4); break;
    case "text": g.fillRect(x - 3, y - 1, 6, 2); break;
    case "thinking":
      g.beginPath(); g.arc(x, y, 2, 0, Math.PI * 2); g.stroke(); break;
    case "tool-call":
      g.beginPath(); g.moveTo(x, y - 2.8); g.lineTo(x + 2.6, y + 2); g.lineTo(x - 2.6, y + 2);
      g.closePath(); g.fill(); break;
    case "tool-result":
      g.beginPath(); g.moveTo(x, y + 2.8); g.lineTo(x + 2.6, y - 2); g.lineTo(x - 2.6, y - 2);
      g.closePath(); g.stroke(); break;
    default:
      g.beginPath(); g.arc(x, y, 1.1, 0, Math.PI * 2); g.fill();
  }
}

function Strip({ run }: { run: SubRun }) {
  const wrap = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);

  const paint = useCallback(() => {
    const el = wrap.current;
    const canvas = cv.current;
    if (!el || !canvas) return;
    const steps = run.tape.steps;
    const n = steps.length;
    if (!n) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = el.clientWidth;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(H * dpr);
    const g = ctx2d(canvas);
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, H);

    const tickCol = cssVar("--tick") || "#788292";
    const toolCol = cssVar("--tick-tool") || "#8f86c4";
    const risk = cssVar("--risk") || "#e47777";
    const spacing = (w - PAD * 2) / n;
    const wide = spacing >= 3;
    const xOf = (i: number) => PAD + ((i + 0.5) * (w - PAD * 2)) / n;

    g.lineWidth = 1.1;
    let last = "";
    for (let i = 0; i < n; i++) {
      const s = steps[i];
      if (s.err) continue;
      if (s.kind !== last) {
        const col = s.kind === "tool-call" || s.kind === "tool-result" ? toolCol : tickCol;
        g.fillStyle = col;
        g.strokeStyle = col;
        g.globalAlpha = 0.85;
        last = s.kind;
      }
      tick(g, s, xOf(i), H / 2, wide);
    }
    g.globalAlpha = 1;
    g.fillStyle = risk;
    for (let i = 0; i < n; i++) {
      if (!steps[i].err) continue;
      g.fillRect(Math.round(xOf(i)) - 1, H / 2 - 6, 2, 12);
    }
  }, [run]);

  useLayoutEffect(() => { paint(); }, [paint]);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => paint());
    ro.observe(el);
    window.addEventListener("agenttape:theme", paint);
    return () => { ro.disconnect(); window.removeEventListener("agenttape:theme", paint); };
  }, [paint]);

  return (
    <div className="nested-strip" ref={wrap} style={{ height: H }}>
      <canvas ref={cv} aria-hidden />
    </div>
  );
}

type Props = {
  delegation: Delegation;
  /** Given when the run can still be fetched: the helper knows where it is. */
  onLoad: (() => void) | null;
  loading: boolean;
  error: string;
  /** Bytes the helper reported, so the offer can say how big it is. */
  offeredBytes: number;
  /** Open the delegated run and step through it. */
  onEnter: () => void;
};

const PAIRED_BY: Record<SubRun["pairedBy"], string> = {
  sidecar: "matched by its sidecar's tool_use id",
  time: "matched by when it ran, inside this call's window",
  manual: "attached by hand",
};

export default function NestedRun({ delegation, onLoad, loading, error, offeredBytes, onEnter }: Props) {
  const run = delegation.run;

  if (!run) {
    return (
      <div className="nested nested-absent">
        <span className="eyebrow">delegated work</span>
        <p className="nested-note">
          This step handed its work to a subagent. <b>That work is not in this file.</b> It lives
          beside the session, in <code>subagents/agent-&lt;id&gt;.jsonl</code>, and nothing in the
          main transcript records what happened inside it — only the call and the summary that
          came back.
        </p>
        {error && <p className="nested-err">{error}</p>}
        {onLoad ? (
          <button type="button" className="btn btn-sm" onClick={onLoad} disabled={loading}>
            {loading ? "Loading…" : `Load the subagent run${offeredBytes ? ` (${fmtBytes(offeredBytes)})` : ""}`}
          </button>
        ) : (
          <p className="nested-note nested-dim">
            Drop the <code>agent-*.jsonl</code> files alongside the transcript, or open the session
            through the local helper, to see inside.
          </p>
        )}
      </div>
    );
  }

  const wall = run.lastT && run.firstT ? run.lastT - run.firstT : 0;

  return (
    <div className="nested">
      <div className="nested-head">
        <span className="eyebrow">delegated run</span>
        <span className="nested-id">{run.agentId}</span>
        <span className="spacer" />
        <span className="nested-paired" title="How this file was matched to this call">
          {PAIRED_BY[run.pairedBy]}
        </span>
      </div>

      <Strip run={run} />

      <dl className="nested-stats">
        <dt>steps</dt>
        <dd>{fmtInt(run.steps)}<span className="delta-dim"> · {fmtInt(run.lines)} lines · {fmtBytes(run.bytes)}</span></dd>
        <dt>tool calls</dt>
        <dd>
          {fmtInt(run.toolCalls)}
          {run.errors > 0 && <span className="nested-errs"> · {fmtInt(run.errors)} failed</span>}
        </dd>
        <dt>tokens</dt>
        <dd>
          {fmtTokens(run.input + run.cacheRead + run.cacheCreate)}<span className="delta-dim"> in · </span>
          {fmtTokens(run.output)}<span className="delta-dim"> out</span>
        </dd>
        <dt>wall clock</dt>
        <dd>{fmtDuration(wall)}</dd>
      </dl>

      <div className="nested-enter">
        <button type="button" className="btn btn-sm btn-accent" onClick={onEnter}>
          Step through this run
        </button>
        <span className="nested-paired">its own playhead, messages and step detail</span>
      </div>

      <div className="nested-tools">
        {run.tools.slice(0, 10).map((t) => (
          <span className="tool-chip" key={t.name}>
            {t.name}
            <b>{fmtInt(t.count)}</b>
          </span>
        ))}
        {run.tools.length > 10 && <span className="tool-chip">+{run.tools.length - 10} more</span>}
      </div>

      <p className="nested-note nested-dim">
        Stepping through a delegated run gives you its timeline, its messages and its bodies. It
        does not give you the filter, the comparison or the assertions — those belong to the run
        you opened, and a nested run is something you look into rather than work on.
      </p>
    </div>
  );
}
