"use client";

// Where you are in the run: one tick per step, thirty pixels tall.
//
// This used to be four stacked bands — ticks, a failure rail, a row of clock
// labels and an elapsed-time axis — eighty-four pixels of it, above a context
// chart, above the content. That is a lot of instrument to read before you can
// start. The elapsed-time half was not wrong, it was in the wrong place: it
// now lives in the Context view next to the durations it explains, and what is
// left here is a position control.
//
// Two canvases on top of each other. The lower one holds the ticks and is
// repainted when the tape, the size, the filter or the theme changes; the
// upper one holds the playhead and is repainted on every move, so dragging
// across ten thousand steps costs one line and a triangle per frame.
//
// A focusable div covers both and carries the slider semantics, because canvas
// has none.

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { Step } from "@/lib/format";
import { stepLabel } from "@/lib/labels";
import { ctx2d } from "./canvas";

const PAD = 8;
export const TRACK_H = 30;
const RAIL_Y = 15;

type Props = {
  steps: Step[];
  pos: number;
  onPos: (n: number) => void;
  /** One byte per step: 0 is dimmed by the active filter. null means no filter. */
  mask?: Uint8Array | null;
  /** One byte per step: 1 handed its work to a subagent. */
  delegated?: Uint8Array | null;
  /** n and p. The owner decides whether they mean failures or matches. */
  onSeek?: (dir: 1 | -1) => void;
  /** What a step is called on screen, for the slider's spoken value. */
  shownIndex?: (globalIndex: number) => number;
  /** The tool a step belongs to, so the spoken value names it. */
  toolOf?: (globalIndex: number) => string;
  height?: number;
};

// Canvas colours live in CSS custom properties so themes reach the pixels, but
// reading them forces a style recalc. They are read once per theme change and
// held, because the playhead repaints on every frame of a drag.
const NAMES = [
  "--chart-tick", "--chart-tick-tool", "--chart-fail", "--chart-grid",
  "--chart-selected", "--text-accent",
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

/** The cross that marks a failure, drawn over whatever shape the step had.
 *  Failure is never signalled by colour alone: the tick changes shape here,
 *  and the list and the panels say "failed" in words. */
function drawFail(g: CanvasRenderingContext2D, x: number, y: number, wide: boolean) {
  if (!wide) {
    // At tight spacing a failure is twice as wide and taller than its
    // neighbours, so it still reads as different with no colour at all.
    g.fillRect(x - 1, y - 8, 2, 16);
    return;
  }
  g.beginPath();
  g.moveTo(x - 3.8, y - 3.8);
  g.lineTo(x + 3.8, y + 3.8);
  g.moveTo(x + 3.8, y - 3.8);
  g.lineTo(x - 3.8, y + 3.8);
  g.stroke();
}

/** The same eight shapes the legend draws, at tick scale. */
function drawGlyph(g: CanvasRenderingContext2D, kind: string, x: number, y: number, wide: boolean) {
  if (!wide) {
    // Below ~3px of spacing the shapes stop being distinguishable, so the rail
    // degrades to a density plot rather than lying about resolution.
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

export default function Timeline({
  steps, pos, onPos, mask = null, delegated = null, onSeek, shownIndex, toolOf,
  height = TRACK_H,
}: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const base = useRef<HTMLCanvasElement>(null);
  const head = useRef<HTMLCanvasElement>(null);
  const hit = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const raf = useRef(0);
  const pending = useRef(-1);

  const n = steps.length;

  const xOf = useCallback(
    (i: number, w: number) => PAD + ((i + 0.5) * (w - PAD * 2)) / Math.max(1, n),
    [n],
  );
  const iOf = useCallback(
    (x: number, w: number) =>
      Math.max(0, Math.min(n - 1, Math.floor(((x - PAD) / (w - PAD * 2)) * n))),
    [n],
  );

  // ---- static layer -------------------------------------------------------

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

    const tick = cssVar("--chart-tick") || "#6b7686";
    const tool = cssVar("--chart-tick-tool") || "#4a6bc4";
    const risk = cssVar("--chart-fail") || "#b42318";
    const grid = cssVar("--chart-grid") || "#dde4ee";
    const accent = cssVar("--text-accent") || "#2f52b0";

    g.strokeStyle = grid;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(PAD, RAIL_Y + 0.5);
    g.lineTo(w - PAD, RAIL_Y + 0.5);
    g.stroke();

    const spacing = (w - PAD * 2) / Math.max(1, n);
    const wide = spacing >= 3;
    const cols = Math.max(1, Math.floor(w - PAD * 2));
    g.lineWidth = 1.25;

    if (wide) {
      // Few enough steps that each gets its own shape. Dimmed first, matching
      // over the top, failures last, so nothing important is painted over.
      const passes: { keep: (i: number) => boolean; scale: number }[] = mask
        ? [{ keep: (i) => !mask[i], scale: 0.22 }, { keep: (i) => !!mask[i], scale: 1 }]
        : [{ keep: () => true, scale: 1 }];

      for (const pass of passes) {
        let lastKind = "";
        let lastAlpha = -1;
        for (let i = 0; i < n; i++) {
          const s = steps[i];
          if (s.err || !pass.keep(i)) continue;
          const alpha = (s.kind === "meta" ? 0.5 : 0.9) * pass.scale;
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
      // share a column. Deciding what each column holds first turns ~7,700
      // draw calls into ~1,500, which is what keeps a repaint on every
      // keystroke of a search cheap enough to keep up.
      const tone = new Uint8Array(cols);   // 0 empty · 1 ordinary · 2 tool
      const solid = new Uint8Array(cols);  // holds at least one non-meta step
      const held = new Uint16Array(cols);
      const hits = new Uint16Array(cols);
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
        if (matched) hits[c]++;
      }

      if (!mask) {
        let lastStyle = -1;
        for (let c = 0; c < cols; c++) {
          if (!tone[c]) continue;
          const style = tone[c] * 2 + solid[c];
          if (style !== lastStyle) {
            g.fillStyle = tone[c] === 2 ? tool : tick;
            g.globalAlpha = solid[c] ? 0.9 : 0.5;
            lastStyle = style;
          }
          g.fillRect(PAD + c, RAIL_Y - 5, 1, 10);
        }
      } else {
        // A column holds about five steps, so "bright if any of them matched"
        // would light up the whole rail and say nothing. The dim base is every
        // step — position and density stay honest — and the bright bar's
        // *height* is the share of that column that matched, which makes a
        // filtered rail a density plot rather than a blanket.
        g.globalAlpha = 0.22;
        g.fillStyle = tick;
        for (let c = 0; c < cols; c++) {
          if (tone[c]) g.fillRect(PAD + c, RAIL_Y - 5, 1, 10);
        }
        g.globalAlpha = 1;
        let lastTone = -1;
        for (let c = 0; c < cols; c++) {
          if (!hits[c]) continue;
          if (tone[c] !== lastTone) {
            g.fillStyle = tone[c] === 2 ? tool : tick;
            lastTone = tone[c];
          }
          const bh = Math.max(3, Math.round((10 * hits[c]) / held[c]));
          g.fillRect(PAD + c, RAIL_Y - bh / 2, 1, bh);
        }
      }

      g.fillStyle = risk;
      let lastErrAlpha = -1;
      for (let c = 0; c < cols; c++) {
        if (!err[c]) continue;
        const alpha = mask && !errHit[c] ? 0.22 : 1;
        if (alpha !== lastErrAlpha) { g.globalAlpha = alpha; lastErrAlpha = alpha; }
        g.fillRect(PAD + c - 1, RAIL_Y - 8, 2, 16);
      }
    }

    // Delegations, over everything else. A handful per session, and each one
    // stands for a whole run this file does not contain.
    if (delegated) {
      g.strokeStyle = accent;
      g.fillStyle = accent;
      g.lineWidth = 1.3;
      for (let i = 0; i < n; i++) {
        if (!delegated[i]) continue;
        g.globalAlpha = mask && !mask[i] ? 0.3 : 1;
        const x = Math.round(xOf(i, w)) + 0.5;
        g.beginPath();
        g.moveTo(x, RAIL_Y - 9);
        g.lineTo(x, RAIL_Y - 5);
        g.stroke();
        g.beginPath();
        g.arc(x, RAIL_Y - 11, 1.7, 0, Math.PI * 2);
        g.fill();
      }
    }
    g.globalAlpha = 1;
  }, [n, steps, xOf, mask, delegated]);

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
      const g = ctx2d(cv);
      if (!g) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      if (!steps[Math.max(0, Math.min(n - 1, p))]) return;

      const accent = cssVar("--chart-selected") || "#315ccd";
      const x = xOf(p, w);

      g.strokeStyle = accent;
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(Math.round(x) + 0.5, 5);
      g.lineTo(Math.round(x) + 0.5, h - 3);
      g.stroke();

      g.fillStyle = accent;
      g.beginPath();
      g.moveTo(x, 6);
      g.lineTo(x + 4.5, 0);
      g.lineTo(x - 4.5, 0);
      g.closePath();
      g.fill();
    },
    [n, steps, xOf],
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
  const shown = cur && shownIndex ? shownIndex(cur.i) || pos + 1 : pos + 1;
  const valueText = cur
    ? `step ${shown} of ${n}, ${stepLabel(cur, toolOf?.(cur.i))}${cur.err ? ", failed" : ""}`
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
        aria-label="Position in the session. Arrow keys step, Home and End jump to the ends, n and p jump to the next and previous failed step."
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
