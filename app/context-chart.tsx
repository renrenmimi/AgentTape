"use client";

// Context size, step by step: input_tokens + cache_read_input_tokens at each
// assistant turn, carried forward across the steps in between.
//
// It used to be a 62-pixel strip above the content with two numbers written on
// it in nine-point type. It is now the content of its own view, which is what
// lets it have axes with units on them, a scale somebody can read a value off,
// and a selection that moves with the keyboard.
//
// The shape it exists for: a step pushes a large payload into the array, the
// line steps up and never comes back down, and every turn after it pays to
// re-send. The largest single-step increase is marked. Compact boundaries are
// marked too, because without them the drop after one reads as a bug in the
// chart rather than an event in the run.
//
// Everything drawn here is also available as text. `Read as a table` below the
// canvas is not a fallback nobody maintains — it is generated from the same
// array the line is drawn from.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Step } from "@/lib/format";
import { fmtInt, fmtTokens } from "@/lib/summary";
import { ctx2d } from "./canvas";

const PAD_L = 56;   // room for the y-axis labels
const PAD_R = 12;
const PAD_T = 12;
const PAD_B = 26;   // room for the x-axis labels

const NAMES = [
  "--chart-line", "--chart-fill", "--chart-grid", "--chart-warn",
  "--chart-axis-text", "--chart-selected", "--font-mono",
];
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
  /** The steps in view order. The x axis is step order, not wall-clock time. */
  steps: Step[];
  pos: number;
  onPos: (k: number) => void;
  /** View positions, so the marks and the playhead agree. */
  jumpAt: number;
  jumpBy: number;
  peakCtx: number;
  compactAt: number[];
  shownIndex: (globalIndex: number) => number;
  height?: number;
};

/** A round number at or above the peak, so the top gridline is readable. */
function niceTop(peak: number): number {
  if (peak <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(peak));
  for (const step of [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10]) {
    if (mag * step >= peak) return mag * step;
  }
  return mag * 10;
}

export default function ContextChart({
  steps, pos, onPos, jumpAt, jumpBy, peakCtx, compactAt, shownIndex, height = 260,
}: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const base = useRef<HTMLCanvasElement>(null);
  const head = useRef<HTMLCanvasElement>(null);
  const hit = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const n = steps.length;
  const top = niceTop(peakCtx);

  const xOf = useCallback(
    (i: number, w: number) => PAD_L + ((i + 0.5) * (w - PAD_L - PAD_R)) / Math.max(1, n),
    [n],
  );
  const iOf = useCallback(
    (x: number, w: number) =>
      Math.max(0, Math.min(n - 1, Math.floor(((x - PAD_L) / (w - PAD_L - PAD_R)) * n))),
    [n],
  );
  const yOf = useCallback(
    (v: number, h: number) => h - PAD_B - (v / top) * (h - PAD_T - PAD_B),
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

    const line = cssVar("--chart-line") || "#315ccd";
    const fill = cssVar("--chart-fill") || "rgba(49,92,205,.10)";
    const grid = cssVar("--chart-grid") || "#dde4ee";
    const warn = cssVar("--chart-warn") || "#7a460c";
    const axis = cssVar("--chart-axis-text") || "#4b5768";
    const mono = cssVar("--font-mono") || "monospace";

    g.font = "12px " + mono;
    g.textBaseline = "middle";

    // y axis: four gridlines with the value on each, in tokens.
    g.strokeStyle = grid;
    g.lineWidth = 1;
    g.fillStyle = axis;
    g.textAlign = "right";
    for (const f of [0, 0.25, 0.5, 0.75, 1]) {
      const y = Math.round(yOf(top * f, h)) + 0.5;
      g.beginPath();
      g.moveTo(PAD_L, y);
      g.lineTo(w - PAD_R, y);
      g.stroke();
      g.fillText(f === 0 ? "0" : fmtTokens(Math.round(top * f)), PAD_L - 8, y);
    }

    // x axis: step numbers at the ends and the middle. The axis is step order,
    // which is what the rest of the view is indexed by; elapsed time is a
    // different axis and has its own track below.
    g.textBaseline = "top";
    const label = (i: number, align: CanvasTextAlign) => {
      const s = steps[i];
      if (!s) return;
      g.textAlign = align;
      const x = align === "left" ? PAD_L : align === "right" ? w - PAD_R : (PAD_L + w - PAD_R) / 2;
      g.fillText("step " + fmtInt(shownIndex(s.i) || i + 1), x, h - PAD_B + 8);
    };
    label(0, "left");
    if (n > 2) label(Math.floor(n / 2), "center");
    if (n > 1) label(n - 1, "right");

    // The area is sampled one point per pixel column: 10,000 steps into 1,400
    // columns is 1,400 lineTo calls instead of 10,000.
    const cols = Math.max(2, Math.floor(w - PAD_L - PAD_R));
    const pts: [number, number][] = [];
    for (let c = 0; c < cols; c++) {
      const i0 = Math.floor((c * n) / cols);
      const i1 = Math.max(i0 + 1, Math.floor(((c + 1) * n) / cols));
      let peak = 0;
      for (let i = i0; i < i1 && i < n; i++) if (steps[i].ctx > peak) peak = steps[i].ctx;
      pts.push([PAD_L + c, yOf(peak, h)]);
    }

    const floor = yOf(0, h);
    g.beginPath();
    g.moveTo(pts[0][0], floor);
    for (const [x, y] of pts) g.lineTo(x, y);
    g.lineTo(pts[pts.length - 1][0], floor);
    g.closePath();
    g.fillStyle = fill;
    g.fill();

    g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.strokeStyle = line;
    g.lineWidth = 2;
    g.stroke();

    // compact boundaries
    g.strokeStyle = warn;
    g.setLineDash([3, 3]);
    g.lineWidth = 1.2;
    for (const i of compactAt) {
      const x = Math.round(xOf(i, w)) + 0.5;
      g.beginPath();
      g.moveTo(x, PAD_T);
      g.lineTo(x, h - PAD_B);
      g.stroke();
    }
    g.setLineDash([]);

    // the largest single-step increase
    if (jumpBy > 0 && jumpAt > 0 && jumpAt < n) {
      const x = Math.round(xOf(jumpAt, w)) + 0.5;
      g.strokeStyle = warn;
      g.lineWidth = 1.4;
      g.beginPath();
      g.moveTo(x, PAD_T);
      g.lineTo(x, h - PAD_B);
      g.stroke();
      g.fillStyle = warn;
      g.beginPath();
      g.moveTo(x, PAD_T + 1);
      g.lineTo(x + 5, PAD_T - 6);
      g.lineTo(x - 5, PAD_T - 6);
      g.closePath();
      g.fill();
    }
  }, [n, steps, top, xOf, yOf, compactAt, jumpAt, jumpBy, shownIndex]);

  const paintHead = useCallback(
    (p: number) => {
      const cv = head.current;
      const el = wrap.current;
      if (!cv || !el || !n) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
        cv.width = Math.round(w * dpr);
        cv.height = Math.round(h * dpr);
      }
      const g = ctx2d(cv);
      if (!g) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      const s = steps[Math.max(0, Math.min(n - 1, p))];
      if (!s) return;
      const accent = cssVar("--chart-selected") || "#315ccd";
      const x = Math.round(xOf(p, w)) + 0.5;
      g.strokeStyle = accent;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(x, PAD_T);
      g.lineTo(x, h - PAD_B);
      g.stroke();
      g.fillStyle = accent;
      g.beginPath();
      g.arc(x, yOf(s.ctx, h), 5, 0, Math.PI * 2);
      g.fill();
    },
    [n, steps, xOf, yOf],
  );

  useLayoutEffect(() => {
    paintBase();
    paintHead(pos);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paintBase]);
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

  const fromEvent = (e: { clientX: number }) => {
    const el = wrap.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return iOf(e.clientX - r.left, r.width);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (!n) return;
    const big = e.shiftKey ? 10 : 1;
    let next = pos;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") next = pos + big;
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = pos - big;
    else if (e.key === "PageDown") next = pos + 50;
    else if (e.key === "PageUp") next = pos - 50;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    else return;
    e.preventDefault();
    e.stopPropagation();
    onPos(Math.max(0, Math.min(n - 1, next)));
  };

  const cur = steps[Math.max(0, Math.min(n - 1, pos))];
  const prev = pos > 0 ? steps[pos - 1] : null;
  const shown = cur ? shownIndex(cur.i) || pos + 1 : 0;
  const delta = cur && prev ? cur.ctx - prev.ctx : 0;

  return (
    <div className="chart-block">
      <div className="chart" ref={wrap} style={{ height }}>
        <canvas ref={base} aria-hidden />
        <canvas ref={head} aria-hidden />
        <div
          className="chart-hit"
          ref={hit}
          role="slider"
          tabIndex={0}
          aria-label="Context size by step. Arrow keys move the selected step; Home and End jump to the ends."
          aria-valuemin={1}
          aria-valuemax={Math.max(1, n)}
          aria-valuenow={pos + 1}
          aria-valuetext={
            cur
              ? `step ${shown}: ${fmtInt(cur.ctx)} tokens in the array` +
                (delta ? `, ${delta > 0 ? "up" : "down"} ${fmtInt(Math.abs(delta))}` : "")
              : "no steps"
          }
          onPointerDown={(e) => {
            dragging.current = true;
            hit.current?.setPointerCapture(e.pointerId);
            onPos(fromEvent(e));
          }}
          onPointerMove={(e) => { if (dragging.current) onPos(fromEvent(e)); }}
          onPointerUp={(e) => {
            dragging.current = false;
            try { hit.current?.releasePointerCapture(e.pointerId); } catch { /* gone */ }
          }}
          onKeyDown={onKey}
        />
      </div>

      <p className="chart-readout">
        <span className="chart-readout-main">
          Step {fmtInt(shown)} — <b>{fmtInt(cur ? cur.ctx : 0)}</b> tokens in the array
        </span>
        {delta !== 0 && (
          <span className={"chart-readout-delta " + (delta > 0 ? "up" : "down")}>
            {delta > 0 ? "+" : "−"}{fmtInt(Math.abs(delta))} from the previous step
          </span>
        )}
        <span className="chart-readout-scale">
          Vertical axis in tokens, to {fmtTokens(top)}. Horizontal axis is step order.
        </span>
      </p>
    </div>
  );
}

/**
 * The same data as text, for anybody the canvas does not serve.
 *
 * Sampled rather than complete: a ten-thousand-row table is not an equivalent
 * of anything. The sample is even, the count is stated, and every row is a
 * control that selects that step — so this is a way to use the chart, not a
 * description of it.
 */
export function ContextTable({
  steps, onPos, shownIndex, rows = 16,
}: {
  steps: Step[];
  onPos: (k: number) => void;
  shownIndex: (globalIndex: number) => number;
  rows?: number;
}) {
  const [open, setOpen] = useState(false);
  const n = steps.length;
  if (!n) return null;
  const take = Math.min(rows, n);
  const picks: number[] = [];
  for (let r = 0; r < take; r++) {
    const k = take === 1 ? 0 : Math.round((r * (n - 1)) / (take - 1));
    if (picks[picks.length - 1] !== k) picks.push(k);
  }

  return (
    <div className="alt-table">
      <button
        type="button"
        className="details-toggle details-toggle-sm"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="details-caret" aria-hidden>{open ? "−" : "+"}</span>
        <span>Read the chart as a table</span>
      </button>
      {open && (
        <table className="data-table">
          <caption>
            {fmtInt(picks.length)} evenly spaced samples of {fmtInt(n)} steps. Each row selects
            that step.
          </caption>
          <thead>
            <tr>
              <th scope="col">Step</th>
              <th scope="col" className="num">Context (tokens)</th>
              <th scope="col" className="num">Change</th>
              <th scope="col"><span className="sr-only">Select</span></th>
            </tr>
          </thead>
          <tbody>
            {picks.map((k) => {
              const s = steps[k];
              const p = k > 0 ? steps[k - 1] : null;
              const d = p ? s.ctx - p.ctx : 0;
              return (
                <tr key={k}>
                  <td>{fmtInt(shownIndex(s.i) || k + 1)}</td>
                  <td className="num">{fmtInt(s.ctx)}</td>
                  <td className="num">{d === 0 ? "—" : (d > 0 ? "+" : "−") + fmtInt(Math.abs(d))}</td>
                  <td>
                    <button type="button" className="btn btn-sm" onClick={() => onPos(k)}>
                      Select
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
