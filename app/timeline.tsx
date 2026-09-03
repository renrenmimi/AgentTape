"use client";

// Where you are in the run, and what is worth going to.
//
// The rail this replaces gave every step its own small shape from a vocabulary
// of eight. It was honest — shape carried kind, so the rail stayed readable
// with no colour perception at all — and it was unreadable in a different way:
// thirty-one equally weighted glyphs, none of which a first-time reader could
// name, competing with each other inside a strip thirty pixels tall.
//
// The grammar is now **height and colour**, with three levels and no more:
//
//   quiet   an ordinary step is a short grey tick and a tool call a slightly
//           taller one. Texture, not information — which step it is and what
//           kind it is are in the list beside the rail.
//   event   a failure, a compaction and a delegation are tall and carry a
//           semantic colour, and a different silhouette each, so the three are
//           still told apart with no colour at all.
//   now     the current step is a full-height line with a filled triangle.
//
// The events are also real buttons layered over the canvas: focusable, named,
// and each one a way to get there. The canvas draws the texture; the DOM
// carries the meaning. Past MAX_MARKS events the buttons are dropped, because
// six hundred focus stops is not an accessibility feature.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Step } from "@/lib/format";
import { stepLabel } from "@/lib/labels";
import { fmtInt } from "@/lib/summary";
import { ctx2d } from "./canvas";

const PAD = 8;
export const TRACK_H = 32;
const BASE_Y = 20;

/** Above this many notable events, the rail stops emitting focus stops. */
export const MAX_MARKS = 60;

type MarkKind = "fail" | "compaction" | "delegation";

type Mark = {
  /** Position in the view, which is what `onPos` takes. */
  pos: number;
  kind: MarkKind;
  /** The whole label, as a person would read it out. */
  text: string;
};

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
  /** What a step is called on screen. */
  shownIndex?: (globalIndex: number) => number;
  /** The tool a step belongs to, so a result names the tool it answers. */
  toolOf?: (globalIndex: number) => string;
  height?: number;
};

// Canvas colours live in CSS custom properties so themes reach the pixels, but
// reading them forces a style recalc. They are read once per theme change and
// held, because the playhead repaints on every frame of a drag.
const NAMES = [
  "--chart-step", "--chart-tool", "--chart-fail", "--chart-warn", "--chart-grid",
  "--chart-selected", "--accent",
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

/**
 * What to say about a step, in the form the tooltip and the marker share.
 *
 * Short on purpose. The rail is a thing you glance at, and a sentence in a
 * tooltip is a sentence nobody finishes reading.
 */
export function railLabel(
  s: Step,
  shown: number,
  tool: string,
  delegated: boolean,
): string {
  const at = `Step ${fmtInt(shown)}`;
  if (s.err) return tool ? `${at} · ${tool} failed` : `${at} · failed`;
  if (s.compact) return `${at} · Context compaction`;
  if (delegated) return `${at} · Delegated to a subagent`;
  return `${at} · ${stepLabel(s, tool)}`;
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
  /** Which step the tooltip is describing, or -1 for none. */
  const [tipAt, setTipAt] = useState(-1);

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
  /** The same position as a fraction of the marks layer, which is inset by PAD. */
  const fracOf = useCallback((i: number) => (n ? (i + 0.5) / n : 0), [n]);

  const label = useCallback(
    (i: number) => {
      const s = steps[i];
      if (!s) return "";
      return railLabel(
        s,
        shownIndex ? shownIndex(s.i) || i + 1 : i + 1,
        toolOf?.(s.i) ?? s.tool,
        delegated?.[i] === 1,
      );
    },
    [steps, shownIndex, toolOf, delegated],
  );

  /** Every event on the rail, in order. An ordinary step is not an event. */
  const marks = useMemo<Mark[]>(() => {
    const out: Mark[] = [];
    for (let i = 0; i < n; i++) {
      const s = steps[i];
      const kind: MarkKind | null = s.err
        ? "fail"
        : s.compact
          ? "compaction"
          : delegated?.[i] === 1
            ? "delegation"
            : null;
      if (!kind) continue;
      out.push({ pos: i, kind, text: label(i) });
      if (out.length > MAX_MARKS) return [];
    }
    return out;
  }, [n, steps, delegated, label]);

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

    const quiet = cssVar("--chart-step") || "#97a1b2";
    const toolCol = cssVar("--chart-tool") || "#7b88a6";
    const fail = cssVar("--chart-fail") || "#af4854";
    const warn = cssVar("--chart-warn") || "#8a681a";
    const grid = cssVar("--chart-grid") || "#dde3ed";
    const accent = cssVar("--accent") || "#6f82e6";

    // The run itself: one hairline the whole way across, so the extent of the
    // session is visible even where nothing happened.
    g.strokeStyle = grid;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(PAD, BASE_Y + 0.5);
    g.lineTo(w - PAD, BASE_Y + 0.5);
    g.stroke();

    const cols = Math.max(1, Math.floor(w - PAD * 2));
    const dimAt = (i: number) => (mask && mask[i] === 0 ? 0.25 : 1);
    const isEvent = (i: number) =>
      steps[i].err || !!steps[i].compact || delegated?.[i] === 1;

    // ---- texture ----------------------------------------------------------
    {
      if (n <= cols) {
        for (let i = 0; i < n; i++) {
          if (isEvent(i)) continue;
          const s = steps[i];
          const isTool = s.kind === "tool-call" || s.kind === "tool-result";
          g.globalAlpha = dimAt(i) * (s.kind === "meta" ? 0.5 : 1);
          g.fillStyle = isTool ? toolCol : quiet;
          const tall = isTool ? 5 : 3;
          g.fillRect(Math.round(xOf(i, w)), BASE_Y - tall, 1, tall * 2);
        }
      } else {
        // More steps than pixels. Each column reports how much of it is tool
        // work and how much of it matched, which keeps a filtered rail a
        // density plot instead of a blanket.
        const held = new Uint16Array(cols);
        const hits = new Uint16Array(cols);
        const tools = new Uint16Array(cols);
        for (let i = 0; i < n; i++) {
          if (isEvent(i)) continue;
          const s = steps[i];
          const c = Math.min(cols - 1, Math.max(0, Math.floor(xOf(i, w) - PAD)));
          held[c]++;
          if (!mask || mask[i] === 1) hits[c]++;
          if (s.kind === "tool-call" || s.kind === "tool-result") tools[c]++;
        }
        for (let c = 0; c < cols; c++) {
          if (!held[c]) continue;
          const toolish = tools[c] * 2 > held[c];
          g.globalAlpha = mask ? 0.25 + 0.75 * (hits[c] / held[c]) : 1;
          g.fillStyle = toolish ? toolCol : quiet;
          const tall = toolish ? 5 : 3;
          g.fillRect(PAD + c, BASE_Y - tall, 1, tall * 2);
        }
      }
      g.globalAlpha = 1;
    }

    // ---- events -----------------------------------------------------------
    //
    // Tall, semantic, and a different silhouette each: a failure is a bar with
    // a square cap, a compaction a bar with a diamond, a delegation a dot on a
    // stem. Colour is the fast read; the cap is the one that survives without
    // it.
    for (let i = 0; i < n; i++) {
      const s = steps[i];
      const isFail = s.err;
      const isCompact = !isFail && !!s.compact;
      const isDeleg = !isFail && !isCompact && delegated?.[i] === 1;
      if (!isFail && !isCompact && !isDeleg) continue;
      const x = Math.round(xOf(i, w)) + 0.5;
      g.globalAlpha = dimAt(i);

      if (isFail) {
        g.fillStyle = fail;
        g.fillRect(x - 1, BASE_Y - 9, 2, 18);
        g.fillRect(x - 3, BASE_Y - 12, 6, 3);
      } else if (isCompact) {
        g.fillStyle = warn;
        g.fillRect(x - 1, BASE_Y - 6, 2, 15);
        g.beginPath();
        g.moveTo(x, BASE_Y - 13);
        g.lineTo(x + 4, BASE_Y - 9);
        g.lineTo(x, BASE_Y - 5);
        g.lineTo(x - 4, BASE_Y - 9);
        g.closePath();
        g.fill();
      } else {
        g.strokeStyle = accent;
        g.fillStyle = accent;
        g.lineWidth = 2;
        g.beginPath();
        g.moveTo(x, BASE_Y - 4);
        g.lineTo(x, BASE_Y + 7);
        g.stroke();
        g.beginPath();
        g.arc(x, BASE_Y - 9, 2.8, 0, Math.PI * 2);
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

      const now = cssVar("--chart-selected") || "#5f70c6";
      const x = Math.round(xOf(p, w)) + 0.5;

      g.strokeStyle = now;
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(x, 7);
      g.lineTo(x, h - 1);
      g.stroke();

      g.fillStyle = now;
      g.beginPath();
      g.moveTo(x, 8);
      g.lineTo(x + 5, 0);
      g.lineTo(x - 5, 0);
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
    const i = fromEvent(e);
    setTipAt(i);
    if (!dragging.current) return;
    commit(i);
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
  const valueText = cur ? label(Math.min(n - 1, pos)) : "no steps";
  const tipStep = Math.max(0, Math.min(n - 1, tipAt));
  const tip = tipAt >= 0 && n ? label(tipStep) : "";
  const tipFrac = fracOf(tipStep);

  return (
    <div
      className="track"
      ref={wrap}
      style={{ height }}
      onPointerLeave={() => setTipAt(-1)}
    >
      <canvas ref={base} aria-hidden />
      <canvas ref={head} aria-hidden />
      <div
        className="track-hit"
        ref={hit}
        role="slider"
        tabIndex={0}
        aria-label="Position in the session. Arrow keys step, Home and End jump to the ends, n and p jump to the next and previous failure."
        aria-valuemin={1}
        aria-valuemax={Math.max(1, n)}
        aria-valuenow={pos + 1}
        aria-valuetext={valueText}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onFocus={() => setTipAt(pos)}
        onBlur={() => setTipAt(-1)}
        onKeyDown={onKey}
      />

      {marks.length > 0 && (
        <div className="track-marks">
          {marks.map((m) => (
            <button
              type="button"
              key={m.kind + ":" + m.pos}
              className={"track-mark track-mark-" + m.kind}
              style={{ left: fracOf(m.pos) * 100 + "%" }}
              aria-label={m.text + ". Go to it."}
              onFocus={() => setTipAt(m.pos)}
              onBlur={() => setTipAt(-1)}
              onPointerEnter={() => setTipAt(m.pos)}
              onClick={() => onPos(m.pos)}
            />
          ))}
        </div>
      )}

      {tip && (
        <div
          className={"track-tip" + (tipFrac > 0.72 ? " track-tip-end" : "")}
          role="status"
          style={{ left: tipFrac * 100 + "%" }}
        >
          {tip}
        </div>
      )}
    </div>
  );
}
