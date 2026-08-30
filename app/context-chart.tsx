"use client";

// Cumulative context size, step by step: input_tokens + cache_read_input_tokens
// at each assistant turn, carried forward across the steps in between.
//
// The chart exists for one shape. A step pushes a large payload into the array;
// the line steps up and never comes back down, and every turn after it pays to
// re-send that payload. The largest single-step increase is marked by name
// because that is the step you are looking for.
//
// Compact boundaries are marked too. Without them the drop after a compaction
// reads as a bug in the chart rather than an event in the run.

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { Step } from "@/lib/format";
import { fmtInt, fmtTokens, type JumpTrace } from "@/lib/summary";
import { ctx2d } from "./canvas";

const PAD = 8;

// Canvas colours live in CSS custom properties so themes reach the pixels, but
// reading them forces a style recalc. They are read once per theme change and
// held, because paintHead runs on every frame of a drag.
const NAMES = ["--area", "--area-line", "--grid", "--warn", "--text-3", "--mono", "--accent"];
type Palette = Record<string, string>;
let palette: Palette | null = null;

function readPalette(): Palette {
  const css = getComputedStyle(document.documentElement);
  const out: Palette = {};
  for (const n of NAMES) out[n] = css.getPropertyValue(n).trim();
  return out;
}

function cssVar(name: string): string {
  if (!palette) palette = readPalette();
  return palette[name] ?? "";
}

function forgetPalette(): void {
  palette = null;
}

type Props = {
  steps: Step[];
  pos: number;
  jumpAt: number;
  jumpBy: number;
  peakCtx: number;
  compactAt: number[];
  /** What became of the payload the marked jump added. */
  trace: JumpTrace | null;
  /** Where the fall happened, numbered the way the rest of the UI numbers steps. */
  fellAtShown: number;
  onPos: (n: number) => void;
  height?: number;
};

/**
 * One line about the marked jump. Context is a single number per turn, not an
 * inventory, so this reports what it can prove — that the level never fell back
 * — and names the inference where it is making one.
 */
function attribution(t: JumpTrace | null, fellAtShown: number): { text: string; tone: string } | null {
  if (!t) return null;
  if (t.unknown) return { text: "no context figures in this tape, so the payload cannot be traced", tone: "dim" };
  const turns = `${fmtInt(t.turnsSince)} turn${t.turnsSince === 1 ? "" : "s"} re-sent it`;
  const reread = t.resent > 0 ? ` · ${fmtTokens(t.resent)} of re-reading` : "";
  if (t.fellAt < 0)
    return { text: `still in the array ${fmtInt(t.stepsSince)} steps later · ${turns}${reread}`, tone: "warn" };
  if (t.fellToCompaction)
    return {
      text: `dropped at the compaction ${fmtInt(t.stepsSince)} steps later · ${turns} first${reread}`,
      tone: "ok",
    };
  return {
    text: `context fell below this level at step ${fmtInt(fellAtShown)}, ` +
      `${fmtInt(t.stepsSince)} steps later — nothing in the transcript says why · ${turns} first${reread}`,
    tone: "dim",
  };
}

export default function ContextChart({
  steps, pos, jumpAt, jumpBy, peakCtx, compactAt, trace, fellAtShown, onPos, height = 62,
}: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const base = useRef<HTMLCanvasElement>(null);
  const head = useRef<HTMLCanvasElement>(null);
  const n = steps.length;
  const top = Math.max(1, peakCtx * 1.08);

  const xOf = useCallback(
    (i: number, w: number) => PAD + ((i + 0.5) * (w - PAD * 2)) / Math.max(1, n),
    [n],
  );
  const yOf = useCallback(
    (v: number, h: number) => h - 5 - (v / top) * (h - 14),
    [top],
  );

  const paintBase = useCallback(() => {
    const cv = base.current;
    const el = wrap.current;
    if (!cv || !el || !n) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = el.clientWidth;
    const h = el.clientHeight;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    const g = ctx2d(cv);
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    const area = cssVar("--area") || "rgba(138,124,246,.22)";
    const line = cssVar("--area-line") || "#8a7cf6";
    const grid = cssVar("--grid") || "rgba(255,255,255,.07)";
    const warn = cssVar("--warn") || "#e3ad58";
    const dim = cssVar("--text-3") || "#788292";
    const mono = cssVar("--mono") || "monospace";

    // horizontal guides at a quarter, a half and three quarters of the peak
    g.strokeStyle = grid;
    g.lineWidth = 1;
    g.beginPath();
    for (const f of [0.25, 0.5, 0.75]) {
      const y = Math.round(yOf(top * f, h)) + 0.5;
      g.moveTo(PAD, y);
      g.lineTo(w - PAD, y);
    }
    g.stroke();

    // The area is built by sampling one point per pixel column: 10,000 steps
    // into 1,400 columns is 1,400 lineTo calls instead of 10,000.
    const cols = Math.max(2, Math.floor(w - PAD * 2));
    const pts: [number, number][] = [];
    for (let c = 0; c < cols; c++) {
      const i0 = Math.floor((c * n) / cols);
      const i1 = Math.max(i0 + 1, Math.floor(((c + 1) * n) / cols));
      let peak = 0;
      for (let i = i0; i < i1 && i < n; i++) if (steps[i].ctx > peak) peak = steps[i].ctx;
      pts.push([PAD + c, yOf(peak, h)]);
    }

    g.beginPath();
    g.moveTo(pts[0][0], h);
    for (const [x, y] of pts) g.lineTo(x, y);
    g.lineTo(pts[pts.length - 1][0], h);
    g.closePath();
    g.fillStyle = area;
    g.fill();

    g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.strokeStyle = line;
    g.lineWidth = 1.2;
    g.stroke();

    // compact boundaries
    g.strokeStyle = dim;
    g.setLineDash([2, 3]);
    g.lineWidth = 1;
    for (const i of compactAt) {
      const x = Math.round(xOf(i, w)) + 0.5;
      g.beginPath();
      g.moveTo(x, 2);
      g.lineTo(x, h - 2);
      g.stroke();
    }
    g.setLineDash([]);

    // the biggest single-step jump
    if (jumpBy > 0 && jumpAt > 0 && jumpAt < n) {
      const x = Math.round(xOf(jumpAt, w)) + 0.5;
      g.strokeStyle = warn;
      g.lineWidth = 1.2;
      g.beginPath();
      g.moveTo(x, 2);
      g.lineTo(x, h - 2);
      g.stroke();
      g.fillStyle = warn;
      g.beginPath();
      g.moveTo(x, 2);
      g.lineTo(x + 4, 8);
      g.lineTo(x - 4, 8);
      g.closePath();
      g.fill();
    }

    g.font = "9px " + mono;
    g.fillStyle = dim;
    g.textBaseline = "top";
    g.textAlign = "left";
    g.fillText(fmtTokens(peakCtx) + " peak", PAD + 2, 4);
  }, [n, steps, top, xOf, yOf, compactAt, jumpAt, jumpBy, peakCtx]);

  const paintHead = useCallback(
    (p: number) => {
      const cv = head.current;
      const el = wrap.current;
      if (!cv || !el || !n) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (cv.width !== Math.round(w * dpr)) {
        cv.width = Math.round(w * dpr);
        cv.height = Math.round(h * dpr);
      }
      const g = ctx2d(cv);
      if (!g) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      const s = steps[Math.max(0, Math.min(n - 1, p))];
      if (!s) return;
      const accent = cssVar("--accent") || "#8a7cf6";
      const x = Math.round(xOf(p, w)) + 0.5;
      g.strokeStyle = accent;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, h);
      g.stroke();
      g.fillStyle = accent;
      g.beginPath();
      g.arc(x, yOf(s.ctx, h), 2.6, 0, Math.PI * 2);
      g.fill();
    },
    [n, steps, xOf, yOf],
  );

  useLayoutEffect(() => { paintBase(); paintHead(pos); /* eslint-disable-line react-hooks/exhaustive-deps */ }, [paintBase]);
  useEffect(() => { paintHead(pos); }, [pos, paintHead]);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => { paintBase(); paintHead(pos); });
    ro.observe(el);
    const onTheme = () => { forgetPalette(); paintBase(); paintHead(pos); };
    window.addEventListener("agenttape:theme", onTheme);
    return () => { ro.disconnect(); window.removeEventListener("agenttape:theme", onTheme); };
  }, [paintBase, paintHead, pos]);

  const cur = steps[Math.max(0, Math.min(n - 1, pos))];

  return (
    <div className="chart" ref={wrap} style={{ height }}>
      <canvas ref={base} aria-hidden />
      <canvas ref={head} aria-hidden />
      {jumpBy > 0 && (
        <div className="chart-notes">
          <button
            type="button"
            className="chart-note"
            onClick={() => onPos(jumpAt)}
            title="Jump to the step that added the most context"
          >
            largest jump <b>+{fmtTokens(jumpBy)}</b> at step {fmtInt(jumpAt + 1)}
          </button>
          {(() => {
            const a = attribution(trace, fellAtShown);
            return a ? <span className={"chart-attrib chart-attrib-" + a.tone}>{a.text}</span> : null;
          })()}
        </div>
      )}
      <p className="sr-only" aria-live="polite">
        {cur ? `Context at step ${pos + 1}: ${fmtTokens(cur.ctx)} tokens. Peak ${fmtTokens(peakCtx)}.` : ""}
      </p>
    </div>
  );
}
