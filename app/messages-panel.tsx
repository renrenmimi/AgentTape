"use client";

// The messages array, as it stood at the playhead.
//
// This is AgentLab's "watch the array grow" panel pointed at a real run. Rows
// are messages-array entries — assistant blocks sharing a message.id are one
// entry, because that is one API message even though the transcript writes it
// as several lines. Only entries that existed at the playhead are rendered.
//
// The list is virtualised against a prefix-sum of row heights. Heights are
// computed rather than measured: a collapsed row is a fixed header, and an
// expanded row is that header plus one fixed-height line per block. That keeps
// the arithmetic exact with no measure-then-reflow pass, which matters because
// fixture C reaches ~5,400 entries.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Entry, Step } from "@/lib/format";
import { fmtInt, fmtTokens } from "@/lib/summary";
import { KIND_LABEL } from "./glyphs";

const HEAD = 36;
const GAP = 6;
const BLK = 22;
const BLK_PAD = 9;
const OVER = 400; // px of overscan above and below the viewport

type Props = {
  entries: Entry[];
  steps: Step[];
  curStep: number;
  redacted: boolean;
  onSelectStep: (globalIndex: number) => void;
};

export default function MessagesPanel({ entries, steps, curStep, redacted, onSelectStep }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState<Set<number>>(() => new Set());
  const [follow, setFollow] = useState(true);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(600);
  const raf = useRef(0);

  const cur = steps[curStep];
  const curEntry = cur ? cur.entry : -1;
  const visible = curEntry + 1;

  const heightOf = useCallback(
    (i: number) => {
      const e = entries[i];
      if (!e) return HEAD + GAP;
      const isOpen = open.has(i) || i === curEntry;
      if (!isOpen) return HEAD + GAP;
      return HEAD + BLK_PAD + (e.to - e.from + 1) * BLK + GAP;
    },
    [entries, open, curEntry],
  );

  // The buffer is allocated once per tape and refilled in place. Allocating a
  // fresh one per playhead move is 43 KB of garbage a frame on a large tape,
  // which shows up as a collection pause in the middle of a drag.
  const buffer = useRef<Float64Array>(new Float64Array(0));
  if (buffer.current.length !== entries.length + 1) {
    buffer.current = new Float64Array(entries.length + 1);
  }
  const offsets = useMemo(() => {
    const out = buffer.current;
    for (let i = 0; i < entries.length; i++) out[i + 1] = out[i] + heightOf(i);
    return out;
  }, [entries, heightOf]);

  const totalH = visible > 0 ? offsets[visible] : 0;

  // ---- scroll plumbing ----------------------------------------------------

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

  // Follow the playhead: park the current entry two thirds down the viewport
  // so the entries just before it stay in shot.
  useEffect(() => {
    if (!follow || curEntry < 0) return;
    const el = scroller.current;
    if (!el) return;
    const bottom = offsets[curEntry + 1];
    const want = Math.max(0, bottom - el.clientHeight * 0.66);
    if (Math.abs(el.scrollTop - want) > 4) {
      el.scrollTop = want;
      setScrollTop(want);
    }
  }, [follow, curEntry, offsets]);

  // ---- window -------------------------------------------------------------

  const [from, to] = useMemo(() => {
    if (visible <= 0) return [0, 0];
    const findIdx = (y: number) => {
      let lo = 0;
      let hi = visible;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (offsets[mid + 1] <= y) lo = mid + 1;
        else hi = mid;
      }
      return Math.min(lo, visible - 1);
    };
    const a = findIdx(Math.max(0, scrollTop - OVER));
    const b = findIdx(scrollTop + viewH + OVER);
    return [a, Math.min(visible, b + 1)];
  }, [offsets, scrollTop, viewH, visible]);

  const toggle = (i: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  const rows = [];
  for (let i = from; i < to; i++) {
    const e = entries[i];
    if (!e) continue;
    const isCur = i === curEntry;
    const isOpen = open.has(i) || isCur;
    const cls = [
      "entry",
      e.role === "user" ? "entry-user" : "entry-assistant",
      e.err ? "entry-err" : "",
      isCur ? "entry-now" : "",
    ].join(" ");
    const first = steps[e.from];
    const label = first ? first.preview : "";

    rows.push(
      <div key={i} className={cls} style={{ top: offsets[i], height: heightOf(i) - GAP }}>
        <div className="entry-card">
          <button
            type="button"
            className="entry-head"
            aria-expanded={isOpen}
            onClick={() => toggle(i)}
          >
            <span className="entry-idx">{fmtInt(i + 1)}</span>
            <span className="entry-role">{e.role}</span>
            <span className="entry-sum">{label || <em style={{ opacity: 0.6 }}>no summary</em>}</span>
            {e.err && <span className="entry-fail">failed</span>}
            <span className="entry-tok">
              {e.output ? "+" + fmtTokens(e.output) + " out" : fmtInt(e.chars) + " ch"}
            </span>
            <span className="entry-caret" aria-hidden>{isOpen ? "−" : "+"}</span>
          </button>
          {isOpen && (
            <div className="entry-blocks">
              {Array.from({ length: e.to - e.from + 1 }, (_, k) => {
                const s = steps[e.from + k];
                if (!s) return null;
                const ahead = s.i > curStep;
                return (
                  <button
                    type="button"
                    key={s.i}
                    className={[
                      "blk",
                      s.i === curStep ? "blk-now" : "",
                      ahead ? "blk-ahead" : "",
                      s.err ? "blk-err" : "",
                    ].join(" ")}
                    onClick={() => onSelectStep(s.i)}
                    aria-current={s.i === curStep ? "step" : undefined}
                  >
                    <span className="blk-i">{fmtInt(s.i + 1)}</span>
                    <span className="blk-kind">{s.tool || KIND_LABEL[s.kind]}</span>
                    <span className="blk-sum">
                      {redacted ? <em style={{ opacity: 0.7 }}>{s.preview}</em> : s.preview}
                    </span>
                    <span className="blk-chars">{s.chars ? fmtInt(s.chars) : ""}</span>
                    <span className="blk-fail">{s.err ? "failed" : ""}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>,
    );
  }

  return (
    <section className="pane" aria-label="Messages array">
      <div className="pane-head">
        <h2>Messages array</h2>
        <span className="stat-v" style={{ fontSize: 12 }}>
          {fmtInt(Math.max(0, visible))}
          <small>of {fmtInt(entries.length)} entries</small>
        </span>
        <span className="spacer" />
        <label className="filter-toggle">
          <input
            type="checkbox"
            checked={follow}
            onChange={(e) => setFollow(e.target.checked)}
          />
          Follow playhead
        </label>
      </div>
      <div className="pane-body" ref={scroller} onScroll={onScroll} data-testid="messages-scroller">
        {visible > 0 ? (
          <>
            <div className="vlist" style={{ height: totalH }} data-count={visible}>
              {rows}
            </div>
            <p className="list-foot">
              {fmtInt(Math.max(0, visible))} entries so far · {fmtInt(curStep + 1)} steps replayed
            </p>
          </>
        ) : (
          <p className="empty-note" style={{ padding: "14px" }}>
            Nothing in the array yet — the playhead is before the first message.
          </p>
        )}
      </div>
    </section>
  );
}
