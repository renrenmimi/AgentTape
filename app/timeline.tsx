"use client";

// The timeline: one tick per step on top, real elapsed time underneath.
//
// Two canvases sit on top of each other. The lower one holds the ticks, the
// failure rail and the time axis, and is repainted only when the tape, the
// size or the theme changes. The upper one holds the playhead and is repainted
// on every move — it is two lines and a connector, so dragging across ten
// thousand steps costs almost nothing.
//
// A focusable div covers both and carries the ARIA slider semantics, because
// canvas has none.

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { IDLE_GAP_MS, type Step } from "@/lib/format";
import { fmtDuration } from "@/lib/summary";
import { KIND_LABEL } from "./glyphs";

// Four bands, top to bottom: the tick rail, the failure rail, a row of time
// labels, and the elapsed-time axis. They are laid out by hand because they
// have to stay clear of each other at every width.
const PAD = 8;
const RAIL_Y = 20;      // centre of the tick rail
const RAIL_H = 30;
const FAIL_Y = 45;      // centre of the failure rail
const LABEL_Y = 58;     // baseline of the time labels
const AXIS_Y = 72;      // centre of the elapsed-time axis

type Props = {
  steps: Step[];
  pos: number;
  onPos: (n: number) => void;
  /** One byte per step: 0 is dimmed by the active filter. null means no filter. */
  mask?: Uint8Array | null;
  /** n and p. The page decides whether they mean failures or matches. */
  onSeek?: (dir: 1 | -1) => void;
  height?: number;
};

// Canvas colours live in CSS custom properties so themes reach the pixels, but
// reading them forces a style recalc. They are read once per theme change and
// held, because paintHead runs on every frame of a drag.
const NAMES = ["--tick", "--tick-tool", "--risk", "--grid", "--text-3", "--idle", "--mono", "--accent"];
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

/** The cross that marks a failure, drawn over whatever shape the step had.
 *  Failure is never signalled by colour alone: the tick itself changes shape,
 *  a marker appears on the rail below, and the panels say "failed" in words. */
function drawFail(g: CanvasRenderingContext2D, x: number, y: number, wide: boolean) {
  if (!wide) {
    // At tight spacing a failure is twice as wide and taller than its
    // neighbours, so it still reads as different without any colour.
    g.fillRect(x - 1, y - 8, 2, 16);
    return;
  }
  g.beginPath();
  g.moveTo(x - 4.2, y - 4.2);
  g.lineTo(x + 4.2, y + 4.2);
  g.moveTo(x + 4.2, y - 4.2);
  g.lineTo(x - 4.2, y + 4.2);
  g.stroke();
}

/** Same eight shapes as glyphs.tsx, drawn at tick scale. */
function drawGlyph(g: CanvasRenderingContext2D, kind: string, x: number, y: number, wide: boolean) {
  if (!wide) {
    // Below ~3px of spacing the shapes stop being distinguishable, so the
    // rail degrades to a density plot rather than lying about resolution.
    g.fillRect(x - 0.5, y - 5, 1, 10);
    return;
  }
  switch (kind) {
    case "user":
      g.fillRect(x - 2.5, y - 2.5, 5, 5);
      break;
    case "text":
      g.fillRect(x - 3.5, y - 1, 7, 2);
      break;
    case "thinking":
      g.beginPath();
      g.arc(x, y, 2.4, 0, Math.PI * 2);
      g.stroke();
      break;
    case "tool-call":
      g.beginPath();
      g.moveTo(x, y - 3.4);
      g.lineTo(x + 3.2, y + 2.4);
      g.lineTo(x - 3.2, y + 2.4);
      g.closePath();
      g.fill();
      break;
    case "tool-result":
      g.beginPath();
      g.moveTo(x, y + 3.4);
      g.lineTo(x + 3.2, y - 2.4);
      g.lineTo(x - 3.2, y - 2.4);
      g.closePath();
      g.stroke();
      break;
    case "system":
      g.beginPath();
      g.moveTo(x - 3, y);
      g.lineTo(x + 3, y);
      g.moveTo(x, y - 3);
      g.lineTo(x, y + 3);
      g.stroke();
      break;
    case "attachment":
      g.beginPath();
      g.moveTo(x, y - 3);
      g.lineTo(x + 3, y);
      g.lineTo(x, y + 3);
      g.lineTo(x - 3, y);
      g.closePath();
      g.stroke();
      break;
    default:
      g.beginPath();
      g.arc(x, y, 1.2, 0, Math.PI * 2);
      g.fill();
  }
}

export default function Timeline({ steps, pos, onPos, mask = null, onSeek, height = 84 }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const base = useRef<HTMLCanvasElement>(null);
  const head = useRef<HTMLCanvasElement>(null);
  const hit = useRef<HTMLDivElement>(null);
  const size = useRef({ w: 0, h: height });
  const dragging = useRef(false);
  const raf = useRef(0);
  const pending = useRef(-1);

  const n = steps.length;
  const firstT = n ? steps[0].t : 0;
  const lastT = n ? steps[n - 1].t : 0;
  const span = Math.max(1, lastT - firstT);

  const xOf = useCallback(
    (i: number, w: number) => PAD + ((i + 0.5) * (w - PAD * 2)) / Math.max(1, n),
    [n],
  );
  const iOf = useCallback(
    (x: number, w: number) =>
      Math.max(0, Math.min(n - 1, Math.floor(((x - PAD) / (w - PAD * 2)) * n))),
    [n],
  );
  const tx = useCallback(
    (t: number, w: number) => PAD + ((t - firstT) / span) * (w - PAD * 2),
    [firstT, span],
  );

  // ---- static layer -------------------------------------------------------

  const paintBase = useCallback(() => {
    const cv = base.current;
    const el = wrap.current;
    if (!cv || !el || !n) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = el.clientWidth;
    const h = el.clientHeight;
    size.current = { w, h };
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    const g = cv.getContext("2d");
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    const tick = cssVar("--tick") || "#788292";
    const tool = cssVar("--tick-tool") || "#8f86c4";
    const risk = cssVar("--risk") || "#e47777";
    const grid = cssVar("--grid") || "rgba(255,255,255,.07)";
    const dim = cssVar("--text-3") || "#788292";
    const idle = cssVar("--idle") || "rgba(255,255,255,.14)";

    // rail baselines
    g.strokeStyle = grid;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(PAD, RAIL_Y + RAIL_H / 2 + 0.5);
    g.lineTo(w - PAD, RAIL_Y + RAIL_H / 2 + 0.5);
    g.moveTo(PAD, AXIS_Y + 0.5);
    g.lineTo(w - PAD, AXIS_Y + 0.5);
    g.stroke();

    const spacing = (w - PAD * 2) / Math.max(1, n);
    const wide = spacing >= 3;

    // idle gaps, shaded on the time axis so a 40-minute pause reads as a pause
    g.fillStyle = idle;
    for (let i = 1; i < n; i++) {
      const d = steps[i].t - steps[i - 1].t;
      if (d <= IDLE_GAP_MS) continue;
      const a = tx(steps[i - 1].t, w);
      const b = tx(steps[i].t, w);
      if (b - a < 1.5) continue;
      g.fillRect(a, AXIS_Y - 7, b - a, 14);
    }

    // Ticks. A filter *dims* what does not match rather than removing it, so
    // the density and position of every step stay honest — otherwise a
    // filtered timeline lies about where the run spent its time.
    const cols = Math.max(1, Math.floor(w - PAD * 2));
    g.lineWidth = 1.25;

    if (wide) {
      // Few enough steps that each gets its own shape. Dimmed first, matching
      // over the top, failures last, so nothing important is painted over.
      const passes: { keep: (i: number) => boolean; scale: number }[] = mask
        ? [{ keep: (i) => !mask[i], scale: 0.18 }, { keep: (i) => !!mask[i], scale: 1 }]
        : [{ keep: () => true, scale: 1 }];

      for (const pass of passes) {
        let lastKind = "";
        let lastAlpha = -1;
        for (let i = 0; i < n; i++) {
          const s = steps[i];
          if (s.err || !pass.keep(i)) continue;
          const alpha = (s.kind === "meta" ? 0.45 : 0.85) * pass.scale;
          if (s.kind !== lastKind) {
            const col = s.kind === "tool-call" || s.kind === "tool-result" ? tool : tick;
            g.fillStyle = col;
            g.strokeStyle = col;
            lastKind = s.kind;
          }
          if (alpha !== lastAlpha) { g.globalAlpha = alpha; lastAlpha = alpha; }
          drawGlyph(g, s.kind, xOf(i, w), RAIL_Y, wide);
        }
      }

      g.fillStyle = risk;
      g.strokeStyle = risk;
      g.lineWidth = 1.6;
      for (const pass of passes) {
        g.globalAlpha = pass.scale;
        for (let i = 0; i < n; i++) {
          if (!steps[i].err || !pass.keep(i)) continue;
          drawFail(g, xOf(i, w), RAIL_Y, wide);
        }
      }
    } else {
      // Below three pixels a step no longer has a shape of its own, and many
      // steps share a column. Deciding what each column holds first turns
      // ~7,700 draw calls into ~1,500 — which is what makes re-painting the
      // rail on every keystroke of a search cheap enough to keep up.
      const tone = new Uint8Array(cols);     // 0 empty · 1 ordinary · 2 tool
      const solid = new Uint8Array(cols);    // holds at least one non-meta step
      const held = new Uint16Array(cols);    // steps in this column
      const hit = new Uint16Array(cols);     // matching steps in this column
      const err = new Uint8Array(cols);
      const errHit = new Uint8Array(cols);

      for (let i = 0; i < n; i++) {
        const s = steps[i];
        const c = Math.min(cols - 1, Math.max(0, Math.floor(xOf(i, w) - PAD)));
        const matched = !mask || mask[i] === 1;
        if (s.err) {
          err[c] = 1;
          if (matched) errHit[c] = 1;
          continue;
        }
        const t = s.kind === "tool-call" || s.kind === "tool-result" ? 2 : 1;
        if (t > tone[c]) tone[c] = t;
        if (s.kind !== "meta") solid[c] = 1;
        held[c]++;
        if (matched) hit[c]++;
      }

      if (!mask) {
        let lastStyle = -1;
        for (let c = 0; c < cols; c++) {
          if (!tone[c]) continue;
          const style = tone[c] * 2 + solid[c];
          if (style !== lastStyle) {
            g.fillStyle = tone[c] === 2 ? tool : tick;
            g.globalAlpha = solid[c] ? 0.85 : 0.45;
            lastStyle = style;
          }
          g.fillRect(PAD + c, RAIL_Y - 5, 1, 10);
        }
      } else {
        // A column here holds about five steps, so "bright if any of them
        // matched" would light up almost the whole rail and tell you nothing.
        // The dim base is every step — position and density stay honest — and
        // the bright bar's *height* is the share of that column that matched,
        // which makes a filtered rail a density plot rather than a blanket.
        g.globalAlpha = 0.18;
        g.fillStyle = tick;
        for (let c = 0; c < cols; c++) {
          if (tone[c]) g.fillRect(PAD + c, RAIL_Y - 5, 1, 10);
        }
        g.globalAlpha = 1;
        let lastTone = -1;
        for (let c = 0; c < cols; c++) {
          if (!hit[c]) continue;
          if (tone[c] !== lastTone) {
            g.fillStyle = tone[c] === 2 ? tool : tick;
            lastTone = tone[c];
          }
          const h = Math.max(3, Math.round((10 * hit[c]) / held[c]));
          g.fillRect(PAD + c, RAIL_Y - h / 2, 1, h);
        }
      }

      g.fillStyle = risk;
      let lastErrAlpha = -1;
      for (let c = 0; c < cols; c++) {
        if (!err[c]) continue;
        const alpha = mask && !errHit[c] ? 0.18 : 1;
        if (alpha !== lastErrAlpha) { g.globalAlpha = alpha; lastErrAlpha = alpha; }
        g.fillRect(PAD + c - 1, RAIL_Y - 8, 2, 16);
      }
    }
    g.globalAlpha = 1;
    g.lineWidth = 1.25;

    // time axis marks — aggregated the same way once there are more steps than
    // pixels, since past that point the extra draws land on top of each other.
    g.fillStyle = dim;
    g.globalAlpha = 0.75;
    if (n > cols) {
      const axis = new Uint8Array(cols);
      for (let i = 0; i < n; i++) {
        axis[Math.min(cols - 1, Math.max(0, Math.floor(tx(steps[i].t, w) - PAD)))] = 1;
      }
      for (let c = 0; c < cols; c++) if (axis[c]) g.fillRect(PAD + c, AXIS_Y - 3, 1, 6);
    } else {
      for (let i = 0; i < n; i++) g.fillRect(tx(steps[i].t, w) - 0.4, AXIS_Y - 3, 0.8, 6);
    }
    g.globalAlpha = 1;

    // time labels at the ends plus the largest gap in the middle
    g.font = "9px " + (cssVar("--mono") || "monospace");
    g.fillStyle = dim;
    g.textBaseline = "middle";
    if (lastT > firstT) {
      g.textAlign = "left";
      g.fillText(new Date(firstT).toLocaleString(), PAD, LABEL_Y);
      g.textAlign = "right";
      g.fillText(fmtDuration(lastT - firstT) + " wall", w - PAD, LABEL_Y);
      let bi = -1;
      let bd = 0;
      for (let i = 1; i < n; i++) {
        const d = steps[i].t - steps[i - 1].t;
        if (d > bd) { bd = d; bi = i; }
      }
      if (bi > 0 && bd > IDLE_GAP_MS) {
        const a = tx(steps[bi - 1].t, w);
        const b = tx(steps[bi].t, w);
        if (b - a > 46) {
          g.textAlign = "center";
          g.fillText("idle " + fmtDuration(bd), (a + b) / 2, LABEL_Y);
        }
      }
    }
  }, [n, steps, tx, xOf, firstT, lastT, mask]);

  // ---- playhead layer -----------------------------------------------------

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
      const g = cv.getContext("2d");
      if (!g) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      const s = steps[Math.max(0, Math.min(n - 1, p))];
      if (!s) return;

      const accent = cssVar("--accent") || "#8a7cf6";
      const x = xOf(p, w);
      const t2 = tx(s.t, w);

      g.strokeStyle = accent;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(Math.round(x) + 0.5, 4);
      g.lineTo(Math.round(x) + 0.5, FAIL_Y + 5);
      g.stroke();

      // the connector: where this step sits in step order vs in real time
      g.globalAlpha = 0.55;
      g.setLineDash([2, 2]);
      g.beginPath();
      g.moveTo(x, FAIL_Y + 5);
      g.lineTo(t2, AXIS_Y - 7);
      g.stroke();
      g.setLineDash([]);
      g.globalAlpha = 1;

      g.beginPath();
      g.moveTo(Math.round(t2) + 0.5, AXIS_Y - 7);
      g.lineTo(Math.round(t2) + 0.5, AXIS_Y + 7);
      g.stroke();

      g.fillStyle = accent;
      g.beginPath();
      g.moveTo(x, 6);
      g.lineTo(x + 4.5, 0);
      g.lineTo(x - 4.5, 0);
      g.closePath();
      g.fill();
    },
    [n, steps, tx, xOf],
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

  // ---- interaction --------------------------------------------------------

  // One state commit per frame. Dragging fires pointermove far faster than
  // React can usefully re-render a 5,000-row panel.
  const commit = useCallback(
    (i: number) => {
      pending.current = i;
      paintHead(i);
      if (raf.current) return;
      raf.current = requestAnimationFrame(() => {
        raf.current = 0;
        if (pending.current >= 0) onPos(pending.current);
      });
    },
    [onPos, paintHead],
  );

  const fromEvent = useCallback(
    (e: { clientX: number }) => {
      const el = wrap.current;
      if (!el) return 0;
      const r = el.getBoundingClientRect();
      return iOf(e.clientX - r.left, r.width);
    },
    [iOf],
  );

  useEffect(() => () => { if (raf.current) cancelAnimationFrame(raf.current); }, []);

  const onDown = (e: React.PointerEvent) => {
    if (!n) return;
    dragging.current = true;
    hit.current?.setPointerCapture(e.pointerId);
    commit(fromEvent(e));
  };
  const onMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    commit(fromEvent(e));
  };
  const onUp = (e: React.PointerEvent) => {
    dragging.current = false;
    try { hit.current?.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
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
    else if (e.key === "n" || e.key === "N") { e.preventDefault(); onSeek?.(1); return; }
    else if (e.key === "p" || e.key === "P") { e.preventDefault(); onSeek?.(-1); return; }
    else return;
    e.preventDefault();
    onPos(Math.max(0, Math.min(n - 1, next)));
  };

  const cur = steps[Math.max(0, Math.min(n - 1, pos))];
  const valueText = cur
    ? `step ${pos + 1} of ${n}, ${KIND_LABEL[cur.kind]}${cur.tool ? " " + cur.tool : ""}${cur.err ? ", failed" : ""}`
    : "no steps";

  return (
    <div className="track" ref={wrap} style={{ height }}>
      <canvas ref={base} aria-hidden />
      <canvas ref={head} aria-hidden />
      <div
        className="track-hit"
        ref={hit}
        role="slider"
        tabIndex={0}
        aria-label="Playhead. Arrow keys step, Home and End jump to the ends, n and p jump to the next and previous failed step."
        aria-valuemin={1}
        aria-valuemax={Math.max(1, n)}
        aria-valuenow={pos + 1}
        aria-valuetext={valueText}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onKeyDown={onKey}
      />
    </div>
  );
}
