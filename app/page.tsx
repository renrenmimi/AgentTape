"use client";

// The workbench. Owns the loaded tape and the playhead; everything else is a
// view of those two things.
//
// The playhead is stored as a *global* step index rather than a position in
// the filtered view, so toggling bookkeeping records on and off does not move
// it. Each child converts as it needs to.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { pairTools } from "@/lib/parser";
import { loadJsonlBlob } from "@/lib/load";
import { tapeFromFile, serializeTape, type TapeFile } from "@/lib/tape";
import { redactTape } from "@/lib/redact";
import { fmtInt, summarise } from "@/lib/summary";
import type { Tape } from "@/lib/format";
import { KIND_LABEL, KindGlyph, FailGlyph } from "./glyphs";
import EmptyState from "./empty-state";
import SummaryStrip from "./summary-strip";
import Timeline from "./timeline";
import ContextChart from "./context-chart";
import MessagesPanel from "./messages-panel";
import StepDetail from "./step-detail";
import { runSelfTest } from "./selftest";

const LEGEND_KINDS = ["user", "text", "thinking", "tool-call", "tool-result", "system"] as const;

export default function Page() {
  const [tape, setTape] = useState<Tape | null>(null);
  const [gpos, setGpos] = useState(0);
  const [showMeta, setShowMeta] = useState(false);
  const [progress, setProgress] = useState<{ pct: number; lines: number; label: string } | null>(null);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);
  const sliderHost = useRef<HTMLDivElement>(null);

  // ---- derived ------------------------------------------------------------

  const view = useMemo(() => {
    if (!tape) return null;
    const steps = showMeta ? tape.steps : tape.steps.filter((s) => s.kind !== "meta");
    const at = new Int32Array(tape.steps.length).fill(-1);
    steps.forEach((s, k) => { at[s.i] = k; });
    return { steps, at };
  }, [tape, showMeta]);

  const pairs = useMemo(() => (tape ? pairTools(tape.steps) : new Map<number, number>()), [tape]);
  const summary = useMemo(() => (tape ? summarise(tape) : null), [tape]);

  /** Nearest visible view position for a global step index. */
  const viewIndexOf = useCallback(
    (gi: number): number => {
      if (!view || !tape) return 0;
      const clamped = Math.max(0, Math.min(tape.steps.length - 1, gi));
      if (view.at[clamped] >= 0) return view.at[clamped];
      for (let d = 1; d < tape.steps.length; d++) {
        const a = clamped - d;
        const b = clamped + d;
        if (a >= 0 && view.at[a] >= 0) return view.at[a];
        if (b < view.at.length && view.at[b] >= 0) return view.at[b];
      }
      return 0;
    },
    [view, tape],
  );

  const pos = view ? viewIndexOf(gpos) : 0;
  const curGlobal = view && view.steps.length ? view.steps[Math.min(pos, view.steps.length - 1)].i : 0;

  const setPos = useCallback(
    (k: number) => {
      if (!view || !view.steps.length) return;
      const clamped = Math.max(0, Math.min(view.steps.length - 1, k));
      setGpos(view.steps[clamped].i);
    },
    [view],
  );

  const goToGlobal = useCallback((gi: number) => setGpos(gi), []);

  /** The number a step is called on screen: its position in the visible view. */
  const shownIndex = useCallback(
    (gi: number) => (view && view.at[gi] >= 0 ? view.at[gi] + 1 : 0),
    [view],
  );

  // ---- loading ------------------------------------------------------------

  const reset = useCallback(() => {
    setTape(null);
    setGpos(0);
    setError("");
    setProgress(null);
  }, []);

  const adopt = useCallback((t: Tape) => {
    setTape(t);
    setGpos(0);
    setProgress(null);
    setError("");
  }, []);

  const loadTapeJson = useCallback(async (text: string, label: string) => {
    const parsed = JSON.parse(text) as TapeFile;
    const t = tapeFromFile(parsed);
    t.meta.label = t.meta.label || label;
    adopt(t);
  }, [adopt]);

  const loadBlob = useCallback(
    async (blob: Blob, label: string, asJsonl: boolean) => {
      setError("");
      setProgress({ pct: 0, lines: 0, label });
      try {
        if (!asJsonl) {
          await loadTapeJson(await blob.text(), label);
          return;
        }
        const t = await loadJsonlBlob(blob, label, (p) => {
          setProgress({
            pct: p.total ? (p.bytes / p.total) * 100 : 100,
            lines: p.lines,
            label,
          });
        });
        adopt(t);
      } catch (e) {
        setProgress(null);
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [adopt, loadTapeJson],
  );

  const onFile = useCallback(
    async (file: File) => {
      const name = file.name.toLowerCase();
      if (name.endsWith(".jsonl")) {
        await loadBlob(file, file.name, true);
        return;
      }
      // A .json that is not a tape is still worth trying as JSONL rather than
      // refusing on the strength of a file extension.
      setError("");
      setProgress({ pct: 0, lines: 0, label: file.name });
      try {
        await loadTapeJson(await file.text(), file.name);
      } catch {
        await loadBlob(file, file.name, true);
      }
    },
    [loadBlob, loadTapeJson],
  );

  const onHelperPick = useCallback(
    async (url: string, label: string) => {
      setError("");
      setProgress({ pct: 0, lines: 0, label });
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`helper returned ${res.status}`);
        await loadBlob(await res.blob(), label, true);
      } catch (e) {
        setProgress(null);
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [loadBlob],
  );

  const onDemo = useCallback(async () => {
    setError("");
    setProgress({ pct: 0, lines: 0, label: "demo" });
    try {
      const res = await fetch("./demo.tape.json");
      if (!res.ok) throw new Error(`demo tape returned ${res.status}`);
      await loadTapeJson(await res.text(), "demo");
    } catch (e) {
      setProgress(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [loadTapeJson]);

  const onExport = useCallback(async () => {
    if (!tape) return;
    setExporting(true);
    try {
      // redactTape reads the index only. tape.body — the one function that can
      // reach the transcript — is never called on this path.
      const file = redactTape(tape);
      const blob = new Blob([serializeTape(file)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "session.tape.json";
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  }, [tape]);

  // ---- keyboard -----------------------------------------------------------

  useEffect(() => {
    if (!view || !view.steps.length) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (t.closest(".track-hit")) return; // the slider owns its own keys
      const tag = t.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || t.isContentEditable) return;
      const n = view.steps.length;
      const big = e.shiftKey ? 10 : 1;
      let next = pos;
      if (e.key === "ArrowRight") next = pos + big;
      else if (e.key === "ArrowLeft") next = pos - big;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = n - 1;
      else if (e.key === "n" || e.key === "N" || e.key === "p" || e.key === "P") {
        const dir = e.key === "n" || e.key === "N" ? 1 : -1;
        for (let i = pos + dir; i >= 0 && i < n; i += dir) {
          if (view.steps[i].err) { setPos(i); break; }
        }
        e.preventDefault();
        return;
      } else return;
      e.preventDefault();
      setPos(Math.max(0, Math.min(n - 1, next)));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, pos, setPos]);

  // Focus the playhead once a tape is open so the keys work without a click.
  useEffect(() => {
    if (!tape) return;
    sliderHost.current?.querySelector<HTMLElement>(".track-hit")?.focus();
  }, [tape]);

  // ---- self test ----------------------------------------------------------

  useEffect(() => {
    if (typeof window === "undefined") return;
    const flags = new URLSearchParams(window.location.search);
    const selftest = flags.has("selftest");
    // ?debug=1 exposes the handle without running the suite, so a measurement
    // harness can drive a real tape instead of the synthetic one.
    if (!selftest && !flags.has("debug")) return;
    const api = {
      get tape() { return tape; },
      get view() { return view; },
      get pos() { return pos; },
      get gpos() { return gpos; },
      setPos,
      goToGlobal,
      onDemo,
      onExport,
      setShowMeta,
      loadTapeFile: (f: TapeFile) => adopt(tapeFromFile(f)),
    };
    (window as unknown as Record<string, unknown>).__agenttape = api;
    if (!selftest) return;
    const id = window.setTimeout(() => { void runSelfTest(); }, 400);
    return () => window.clearTimeout(id);
  }, [tape, view, pos, gpos, setPos, goToGlobal, onDemo, onExport, adopt]);

  // ---- render -------------------------------------------------------------

  if (!tape || !view || !summary) {
    return (
      <main className="tape">
        <EmptyState
          onFile={onFile}
          onHelperPick={onHelperPick}
          onDemo={onDemo}
          progress={progress}
          error={error}
        />
      </main>
    );
  }

  const cur = view.steps[Math.min(pos, view.steps.length - 1)];

  return (
    <main className="tape">
      <SummaryStrip
        tape={tape}
        summary={summary}
        onExport={onExport}
        onClose={reset}
        exporting={exporting}
      />

      <section className="tracks" ref={sliderHost} aria-label="Timeline">
        <div className="track-head">
          <span className="eyebrow">timeline</span>
          <div className="legend">
            {LEGEND_KINDS.map((k) => (
              <span className="legend-item" key={k}>
                <KindGlyph kind={k} />
                {KIND_LABEL[k]}
              </span>
            ))}
            <span className="legend-item" style={{ color: "var(--risk)" }}>
              <FailGlyph />
              failed — also marked on the rail below
            </span>
          </div>
          <span className="spacer" />
          <span className="entry-tok">
            step {pos + 1} / {view.steps.length}
            {cur?.tool ? ` · ${cur.tool}` : ""}
          </span>
          {summary.metaSteps > 0 && (
            <label className="filter-toggle">
              <input type="checkbox" checked={showMeta} onChange={(e) => setShowMeta(e.target.checked)} />
              Show {fmtInt(summary.metaSteps)} bookkeeping records
            </label>
          )}
          <span className="entry-tok">
            <kbd>←</kbd> <kbd>→</kbd> step · <kbd>n</kbd> <kbd>p</kbd> failures · <kbd>Home</kbd> <kbd>End</kbd>
          </span>
        </div>

        <Timeline steps={view.steps} pos={pos} onPos={setPos} />

        <ContextChart
          steps={view.steps}
          pos={pos}
          jumpAt={view.at[summary.jumpAt] >= 0 ? view.at[summary.jumpAt] : 0}
          jumpBy={summary.jumpBy}
          peakCtx={summary.peakCtx}
          compactAt={summary.compactAt.map((i) => view.at[i]).filter((i) => i >= 0)}
          onPos={setPos}
        />
      </section>

      <div className="body">
        <MessagesPanel
          entries={tape.entries}
          steps={tape.steps}
          curStep={curGlobal}
          redacted={tape.meta.redacted}
          onSelectStep={goToGlobal}
          shownIndex={shownIndex}
        />
        <StepDetail
          tape={tape}
          curStep={curGlobal}
          pairs={pairs}
          onSelectStep={goToGlobal}
          shownIndex={shownIndex}
        />
      </div>
    </main>
  );
}
