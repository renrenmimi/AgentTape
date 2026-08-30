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
import { fmtInt, summarise, traceJump } from "@/lib/summary";
import { EMPTY_FILTER, applyFilter, buildFilterIndex, isActive, seek, type Filter } from "@/lib/filter";
import {
  agentIdFromName, delegationSummary, findDelegations, pairBySidecar, pairByTime, summariseRun,
  type Delegation, type SubRun,
} from "@/lib/subagents";
import type { Tape } from "@/lib/format";
import { KIND_LABEL, KindGlyph, FailGlyph, DelegateGlyph } from "./glyphs";
import EmptyState, { HELPER, type HelperAgent, type HelperSession } from "./empty-state";
import SummaryStrip from "./summary-strip";
import Timeline from "./timeline";
import ContextChart from "./context-chart";
import MessagesPanel from "./messages-panel";
import StepDetail from "./step-detail";
import FilterBar from "./filter-bar";
import { runSelfTest } from "./selftest";

const LEGEND_KINDS = ["user", "text", "thinking", "tool-call", "tool-result", "system"] as const;

export default function Page() {
  const [tape, setTape] = useState<Tape | null>(null);
  const [gpos, setGpos] = useState(0);
  const [showMeta, setShowMeta] = useState(false);
  const [filter, setFilter] = useState<Filter>(EMPTY_FILTER);
  // Subagent runs, keyed by the global step index of the call that delegated.
  const [subRuns, setSubRuns] = useState<Map<number, SubRun>>(() => new Map());
  // Set when the tape came from the helper, which knows where the rest of the
  // work is. A dropped transcript has no such handle.
  const [origin, setOrigin] = useState<{ project: string; session: string; agents: HelperAgent[] } | null>(null);
  const [subLoading, setSubLoading] = useState(-1);
  const [subError, setSubError] = useState("");
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

  // Built once per tape: lowercasing ten thousand previews on every keystroke
  // is the difference between a filter that keeps up with typing and one that
  // does not.
  const filterIndex = useMemo(
    () => (tape ? buildFilterIndex(tape.steps, pairs) : null),
    [tape, pairs],
  );

  // What became of the payload the biggest jump added. Derived from the index
  // over the whole tape, not the filtered view, so hiding bookkeeping records
  // cannot change the answer.
  const jumpTrace = useMemo(
    () => (tape && summary ? traceJump(tape.steps, summary.jumpAt, summary.jumpBy) : null),
    [tape, summary],
  );

  const filtering = isActive(filter);
  const { mask, count: matches } = useMemo(() => {
    if (!view || !filterIndex) return { mask: new Uint8Array(0), count: 0 };
    return applyFilter(view.steps, filterIndex, filter);
  }, [view, filterIndex, filter]);

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

  /** Every delegation, with whatever run has been attached to it. */
  const delegations = useMemo<Delegation[]>(() => {
    if (!tape) return [];
    return findDelegations(tape.steps, pairs).map((d) => ({ ...d, run: subRuns.get(d.step) ?? null }));
  }, [tape, pairs, subRuns]);

  const delegated = useMemo(() => {
    if (!view) return null;
    if (!delegations.length) return null;
    const at = new Set(delegations.map((d) => d.step));
    const out = new Uint8Array(view.steps.length);
    view.steps.forEach((s, k) => { if (at.has(s.i)) out[k] = 1; });
    return out;
  }, [view, delegations]);

  const curDelegation = useMemo(
    () => delegations.find((d) => d.step === curGlobal) ?? null,
    [delegations, curGlobal],
  );


  /**
   * n and p. With no filter they step through failures, which is what they have
   * always done; with a filter they step through matches, because that is what
   * you were looking at when you pressed the key.
   */
  const seekNext = useCallback(
    (dir: 1 | -1) => {
      if (!view || !view.steps.length) return;
      if (filtering) {
        const hit = seek(mask, pos, dir);
        if (hit >= 0) setPos(hit);
        return;
      }
      for (let i = pos + dir; i >= 0 && i < view.steps.length; i += dir) {
        if (view.steps[i].err) { setPos(i); return; }
      }
    },
    [view, filtering, mask, pos, setPos],
  );

  /** Compactions in view order, so the chart marks and the jump agree. */
  const compactions = useMemo(
    () => (view && summary ? summary.compactAt.map((i) => view.at[i]).filter((i) => i >= 0) : []),
    [view, summary],
  );

  const jumpCompaction = useCallback(() => {
    if (!compactions.length) return;
    // Forward to the next one, wrapping to the first — a session has a handful
    // of these and cycling is the whole interaction.
    setPos(compactions.find((i) => i > pos) ?? compactions[0]);
  }, [compactions, pos, setPos]);

  /** The number a step is called on screen: its position in the visible view. */
  const shownIndex = useCallback(
    (gi: number) => (view && view.at[gi] >= 0 ? view.at[gi] + 1 : 0),
    [view],
  );

  // ---- loading ------------------------------------------------------------

  const reset = useCallback(() => {
    setTape(null);
    setGpos(0);
    setFilter(EMPTY_FILTER);
    setError("");
    setProgress(null);
    setSubRuns(new Map());
    setOrigin(null);
    setSubError("");
    setSubLoading(-1);
  }, []);

  const adopt = useCallback((t: Tape) => {
    setTape(t);
    setGpos(0);
    setFilter(EMPTY_FILTER);
    setProgress(null);
    setError("");
    setSubRuns(new Map());
    setSubError("");
    setSubLoading(-1);
  }, []);

  const loadTapeJson = useCallback(async (text: string, label: string): Promise<Tape> => {
    const parsed = JSON.parse(text) as TapeFile;
    const t = tapeFromFile(parsed);
    t.meta.label = t.meta.label || label;
    adopt(t);
    return t;
  }, [adopt]);

  const loadBlob = useCallback(
    async (blob: Blob, label: string, asJsonl: boolean): Promise<Tape | null> => {
      setError("");
      setProgress({ pct: 0, lines: 0, label });
      try {
        if (!asJsonl) return await loadTapeJson(await blob.text(), label);
        const t = await loadJsonlBlob(blob, label, (p) => {
          setProgress({
            pct: p.total ? (p.bytes / p.total) * 100 : 100,
            lines: p.lines,
            label,
          });
        });
        adopt(t);
        return t;
      } catch (e) {
        setProgress(null);
        setError(e instanceof Error ? e.message : String(e));
        return null;
      }
    },
    [adopt, loadTapeJson],
  );

  /**
   * Index a subagent file and hang it on the delegation it belongs to.
   *
   * `toolUseId` comes from the sidecar when there is one and is exact. Without
   * it the pairing is by time: a subagent runs strictly between its call and
   * that call's result, which identified the right parent for all sixteen files
   * in the large fixture with no ambiguity. Where the window is ambiguous this
   * refuses rather than guessing, and the file stays unattached.
   */
  const attachSubagent = useCallback(
    async (blob: Blob, agentId: string, toolUseId: string, dels: Delegation[]) => {
      const sub = await loadJsonlBlob(blob, agentId, undefined);
      const first = sub.steps.find((s) => s.t)?.t ?? 0;
      let at = toolUseId ? pairBySidecar(dels, toolUseId) : -1;
      const how: SubRun["pairedBy"] = at >= 0 ? "sidecar" : "time";
      if (at < 0) at = pairByTime(dels, first);
      if (at < 0) return false;
      const run = summariseRun(sub, agentId, how);
      setSubRuns((prev) => new Map(prev).set(dels[at].step, run));
      return true;
    },
    [],
  );

  const onFiles = useCallback(
    async (files: File[]) => {
      setError("");
      const subs = files.filter((f) => agentIdFromName(f.name) !== "");
      const sidecars = new Map<string, string>();
      for (const f of files) {
        const m = /^agent-([A-Za-z0-9_-]+)\.meta\.json$/.exec(f.name);
        if (!m) continue;
        try {
          // Two fields exist here; `description` is prose about the user's work
          // and is never read.
          const meta = JSON.parse(await f.text()) as { toolUseId?: unknown };
          if (typeof meta.toolUseId === "string") sidecars.set(m[1], meta.toolUseId);
        } catch {
          /* an unreadable sidecar just means pairing falls back to time */
        }
      }
      const main = files.find((f) => agentIdFromName(f.name) === "" && !/\.meta\.json$/.test(f.name));
      if (!main) {
        setError("No transcript in that drop — only subagent files. Add the session's own .jsonl.");
        return;
      }

      const name = main.name.toLowerCase();
      let loaded: Tape | null = null;
      if (name.endsWith(".jsonl")) {
        loaded = await loadBlob(main, main.name, true);
      } else {
        // A .json that is not a tape is still worth trying as JSONL rather than
        // refusing on the strength of a file extension.
        setProgress({ pct: 0, lines: 0, label: main.name });
        try {
          loaded = await loadTapeJson(await main.text(), main.name);
        } catch {
          loaded = await loadBlob(main, main.name, true);
        }
      }
      if (!loaded || !subs.length) return;

      const dels = findDelegations(loaded.steps, pairTools(loaded.steps));
      let attached = 0;
      for (const f of subs) {
        const id = agentIdFromName(f.name);
        if (await attachSubagent(f, id, sidecars.get(id) ?? "", dels)) attached++;
      }
      if (attached < subs.length) {
        setSubError(
          `${subs.length - attached} of ${subs.length} subagent files could not be matched to a call in this transcript.`,
        );
      }
    },
    [loadBlob, loadTapeJson, attachSubagent],
  );

  const onHelperPick = useCallback(
    async (session: HelperSession) => {
      const label = session.session.slice(0, 8);
      setError("");
      setProgress({ pct: 0, lines: 0, label });
      try {
        const url = `${HELPER}/file?project=${encodeURIComponent(session.project)}` +
          `&session=${encodeURIComponent(session.session)}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`helper returned ${res.status}`);
        const t = await loadBlob(await res.blob(), label, true);
        if (t) {
          setOrigin({ project: session.project, session: session.session, agents: session.agents ?? [] });
        }
      } catch (e) {
        setProgress(null);
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [loadBlob],
  );

  /** Fetch one delegated run from the helper, on demand. */
  const loadSubagent = useCallback(
    async (d: Delegation) => {
      if (!origin) return;
      const agent = origin.agents.find((a) => a.toolUseId === d.toolUseId);
      if (!agent) { setSubError("The helper does not have a file for this call."); return; }
      setSubLoading(d.step);
      setSubError("");
      try {
        const url = `${HELPER}/subagent?project=${encodeURIComponent(origin.project)}` +
          `&session=${encodeURIComponent(origin.session)}&agent=${encodeURIComponent(agent.id)}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`helper returned ${res.status}`);
        const ok = await attachSubagent(await res.blob(), agent.id, agent.toolUseId, delegations);
        if (!ok) setSubError("That file could not be matched to this call.");
      } catch (e) {
        setSubError(e instanceof Error ? e.message : String(e));
      } finally {
        setSubLoading(-1);
      }
    },
    [origin, delegations, attachSubagent],
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
        e.preventDefault();
        seekNext(e.key === "n" || e.key === "N" ? 1 : -1);
        return;
      } else return;
      e.preventDefault();
      setPos(Math.max(0, Math.min(n - 1, next)));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [view, pos, setPos, seekNext]);

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
      get filter() { return filter; },
      setFilter,
      get matches() { return matches; },
      get mask() { return mask; },
      seekNext,
      get delegations() { return delegations; },
      get origin() { return origin; },
      loadSubagent,
      loadTapeFile: (f: TapeFile) => adopt(tapeFromFile(f)),
    };
    (window as unknown as Record<string, unknown>).__agenttape = api;
    if (!selftest) return;
    const id = window.setTimeout(() => { void runSelfTest(); }, 400);
    return () => window.clearTimeout(id);
  }, [tape, view, pos, gpos, setPos, goToGlobal, onDemo, onExport, adopt, filter, matches, mask, seekNext, delegations, origin, loadSubagent]);

  // ---- render -------------------------------------------------------------

  if (!tape || !view || !summary) {
    return (
      <main className="tape">
        <EmptyState
          onFiles={onFiles}
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
        delegations={delegationSummary(delegations)}
        onExport={onExport}
        onClose={reset}
        exporting={exporting}
      />

      <section className="tracks" ref={sliderHost} aria-label="Timeline">
        {filterIndex && (
          <FilterBar
            filter={filter}
            onFilter={setFilter}
            index={filterIndex}
            matches={matches}
            total={view.steps.length}
            compactions={compactions}
            onJumpCompaction={jumpCompaction}
            outOfFilter={filtering && mask[pos] === 0}
          />
        )}

        <div className="track-head">
          <span className="eyebrow">timeline</span>
          <div className="legend">
            {LEGEND_KINDS.map((k) => (
              <span className="legend-item" key={k}>
                <KindGlyph kind={k} />
                {KIND_LABEL[k]}
              </span>
            ))}
            {delegations.length > 0 && (
              <span className="legend-item" style={{ color: "var(--accent-text)" }}>
                <DelegateGlyph />
                delegated to a subagent
              </span>
            )}
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
            <kbd>←</kbd> <kbd>→</kbd> step · <kbd>n</kbd> <kbd>p</kbd>{" "}
            {filtering ? "matches" : "failures"} · <kbd>Home</kbd> <kbd>End</kbd>
          </span>
        </div>

        <Timeline
          steps={view.steps}
          pos={pos}
          onPos={setPos}
          mask={filtering ? mask : null}
          delegated={delegated}
          onSeek={seekNext}
        />

        <ContextChart
          steps={view.steps}
          pos={pos}
          jumpAt={view.at[summary.jumpAt] >= 0 ? view.at[summary.jumpAt] : 0}
          jumpBy={summary.jumpBy}
          peakCtx={summary.peakCtx}
          compactAt={compactions}
          trace={jumpTrace}
          fellAtShown={jumpTrace && jumpTrace.fellAt >= 0 ? shownIndex(jumpTrace.fellAt) : 0}
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
          delegation={curDelegation}
          onLoadSubagent={
            curDelegation && origin && !curDelegation.run
              ? () => { void loadSubagent(curDelegation); }
              : null
          }
          subLoading={subLoading === curGlobal}
          subError={curDelegation && !curDelegation.run ? subError : ""}
          offeredBytes={
            origin?.agents.find((a) => a.toolUseId === curDelegation?.toolUseId)?.bytes ?? 0
          }
          outOfFilter={filtering && mask[pos] === 0}
        />
      </div>
    </main>
  );
}
