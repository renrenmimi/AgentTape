"use client";

// Elapsed time, as its own axis.
//
// This is the second band of the old timeline, moved rather than dropped. It
// was sitting under the step rail with a nine-point clock label at each end,
// where it competed with the position control for attention and explained
// nothing; here it sits next to the durations it is the picture of.
//
// The axis is real time, so the gaps are real gaps. A session resumed after
// lunch has a hole in the middle of this track, and that hole is the reason
// "wall clock" and "active" are two different numbers. Nothing is normalised
// to make the marks even — an even axis would be a nicer picture of a run that
// did not happen.

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { IDLE_GAP_MS, type Step } from "@/lib/format";
import { fmtClock, fmtDuration } from "@/lib/summary";
import { ctx2d } from "./canvas";

const PAD = 8;
export const TIME_H = 44;
const AXIS_Y = 22;

const NAMES = [
  "--chart-tick", "--chart-fail", "--chart-grid", "--chart-idle",
  "--chart-axis-text", "--chart-selected", "--font-mono",
];
type Palette = Record<string, string>;
let palette: Palette | null = null;

function cssVar(name: string): string {
  if (!palette) {
    const css = getComputedStyle(document.documentElement);
    palette = {};
    for (const n of NAMES) palette[n] = css.getPropertyValue(n).trim();
  }
  return palette[name] ?? "";
}

type Props = {
  steps: Step[];
  pos: number;
  onPos: (k: number) => void;
};

export default function TimeTrack({ steps, pos, onPos }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const hit = useRef<HTMLDivElement>(null);
  const n = steps.length;
  const firstT = n ? steps[0].t : 0;
  const lastT = n ? steps[n - 1].t : 0;
  const span = Math.max(1, lastT - firstT);

  const tx = useCallback(
    (t: number, w: number) => PAD + ((t - firstT) / span) * (w - PAD * 2),
    [firstT, span],
  );

  /** Nearest step to a point on the time axis — the inverse of tx. */
  const nearest = useCallback(
    (x: number, w: number) => {
      const want = firstT + ((x - PAD) / Math.max(1, w - PAD * 2)) * span;
      let best = 0;
      let bd = Infinity;
      for (let i = 0; i < n; i++) {
        const d = Math.abs(steps[i].t - want);
        if (d < bd) { bd = d; best = i; }
      }
      return best;
    },
    [firstT, span, n, steps],
  );

  const paint = useCallback(() => {
    const canvas = cv.current;
    const el = wrap.current;
    if (!canvas || !el || !n) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = el.clientWidth;
    const h = el.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const g = ctx2d(canvas);
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    const tick = cssVar("--chart-tick") || "#6b7686";
    const risk = cssVar("--chart-fail") || "#b42318";
    const grid = cssVar("--chart-grid") || "#dde4ee";
    const idle = cssVar("--chart-idle") || "rgba(24,33,47,.06)";
    const axis = cssVar("--chart-axis-text") || "#4b5768";
    const accent = cssVar("--chart-selected") || "#315ccd";
    const mono = cssVar("--font-mono") || "monospace";

    g.strokeStyle = grid;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(PAD, AXIS_Y + 0.5);
    g.lineTo(w - PAD, AXIS_Y + 0.5);
    g.stroke();

    // Gaps over two minutes, shaded, so a forty-minute pause reads as a pause.
    g.fillStyle = idle;
    for (let i = 1; i < n; i++) {
      const d = steps[i].t - steps[i - 1].t;
      if (d <= IDLE_GAP_MS) continue;
      const a = tx(steps[i - 1].t, w);
      const b = tx(steps[i].t, w);
      if (b - a < 1) continue;
      g.fillRect(a, AXIS_Y - 9, b - a, 18);
    }

    const cols = Math.max(1, Math.floor(w - PAD * 2));
    g.fillStyle = tick;
    g.globalAlpha = 0.8;
    if (n > cols) {
      const seen = new Uint8Array(cols);
      for (let i = 0; i < n; i++) {
        seen[Math.min(cols - 1, Math.max(0, Math.floor(tx(steps[i].t, w) - PAD)))] = 1;
      }
      for (let c = 0; c < cols; c++) if (seen[c]) g.fillRect(PAD + c, AXIS_Y - 5, 1, 10);
    } else {
      for (let i = 0; i < n; i++) g.fillRect(tx(steps[i].t, w) - 0.5, AXIS_Y - 5, 1, 10);
    }
    g.globalAlpha = 1;

    g.fillStyle = risk;
    for (let i = 0; i < n; i++) {
      if (steps[i].err) g.fillRect(Math.round(tx(steps[i].t, w)) - 1, AXIS_Y - 8, 2, 16);
    }

    // where the selected step sits in real time
    const s = steps[Math.max(0, Math.min(n - 1, pos))];
    if (s) {
      const x = Math.round(tx(s.t, w)) + 0.5;
      g.strokeStyle = accent;
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(x, AXIS_Y - 11);
      g.lineTo(x, AXIS_Y + 11);
      g.stroke();
    }

    g.font = "12px " + mono;
    g.fillStyle = axis;
    g.textBaseline = "top";
    if (lastT > firstT) {
      g.textAlign = "left";
      g.fillText(fmtClock(firstT), PAD, AXIS_Y + 13);
      g.textAlign = "right";
      g.fillText(fmtClock(lastT), w - PAD, AXIS_Y + 13);
    }
  }, [n, steps, tx, firstT, lastT, pos]);

  useLayoutEffect(() => { paint(); }, [paint]);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => paint());
    ro.observe(el);
    const onTheme = () => { palette = null; paint(); };
    window.addEventListener("agenttape:theme", onTheme);
    return () => { ro.disconnect(); window.removeEventListener("agenttape:theme", onTheme); };
  }, [paint]);

  if (!n || lastT === firstT) {
    return (
      <p className="empty-line">
        This session carries no usable timestamps, so there is no time axis to draw.
      </p>
    );
  }

  const cur = steps[Math.max(0, Math.min(n - 1, pos))];

  return (
    <div className="track time-track" ref={wrap} style={{ height: TIME_H }}>
      <canvas ref={cv} aria-hidden />
      <div
        className="track-hit"
        ref={hit}
        role="slider"
        tabIndex={0}
        aria-label="Elapsed time. Selects the step nearest a point in real time; arrow keys step."
        aria-valuemin={1}
        aria-valuemax={Math.max(1, n)}
        aria-valuenow={pos + 1}
        aria-valuetext={`step ${pos + 1} of ${n}, at ${fmtClock(cur.t)}, ` +
          `${fmtDuration(cur.t - firstT)} into the session`}
        onPointerDown={(e) => {
          const r = wrap.current?.getBoundingClientRect();
          if (r) onPos(nearest(e.clientX - r.left, r.width));
        }}
        onKeyDown={(e) => {
          let next = pos;
          if (e.key === "ArrowRight") next = pos + (e.shiftKey ? 10 : 1);
          else if (e.key === "ArrowLeft") next = pos - (e.shiftKey ? 10 : 1);
          else if (e.key === "Home") next = 0;
          else if (e.key === "End") next = n - 1;
          else return;
          e.preventDefault();
          e.stopPropagation();
          onPos(Math.max(0, Math.min(n - 1, next)));
        }}
      />
    </div>
  );
}
