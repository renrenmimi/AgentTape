"use client";

// Replay: two columns, and one step explained at a time.
//
// What used to be here was a header of twelve statistics, a filter bar, a
// legend of eight symbols, an eighty-four pixel timeline and a context chart —
// something over three hundred pixels of instrument before the first piece of
// content. All of it was useful to somebody who already knew the tool. None of
// it answered "what is step 7".
//
// So: a list of steps on the left that says what each one is, and one panel on
// the right that shows it. The position rail is still here because it is the
// one thing a list is bad at — where in the run you are, and how dense the
// failures are — and it is thirty pixels tall instead of eighty-four.
//
// The same component draws a delegated run. `nested` turns off the routes that
// belong to a top-level session; everything else is identical, which is the
// point of it being one component.

import { useEffect, useMemo, useRef, useState } from "react";
import type { Step, Tape } from "@/lib/format";
import type { Filter, FilterIndex } from "@/lib/filter";
import { isActive } from "@/lib/filter";
import { fmtClock, fmtDuration, fmtInt, type JumpTrace, type Summary } from "@/lib/summary";
import { stepKindLabel } from "@/lib/labels";
import type { Delegation } from "@/lib/subagents";
import Timeline from "./timeline";
import StepList from "./step-list";
import MessagesPanel from "./messages-panel";
import StepDetail from "./step-detail";
import ContextView from "./context-view";
import RecordData from "./record-data";
import { FilterChips, FiltersButton, SearchBox } from "./filter-bar";
import RailLegend from "./rail-legend";
import { CrossIcon, ListIcon, NextIcon, PrevIcon, WarnIcon } from "./icons";

export type LeftMode = "steps" | "messages";
export type DetailTab = "details" | "context" | "record";

export const DETAIL_TABS: { id: DetailTab; label: string }[] = [
  { id: "details", label: "Details" },
  { id: "context", label: "Context" },
  { id: "record", label: "Record data" },
];

type Props = {
  title: string;
  tape: Tape;
  /** Steps in view order. Filtering dims; it never removes. */
  steps: Step[];
  pos: number;
  onPos: (k: number) => void;
  curGlobal: number;
  pairs: Map<number, number>;
  shownIndex: (globalIndex: number) => number;
  onSelectStep: (globalIndex: number) => void;
  summary: Summary;
  trace: JumpTrace | null;
  compactions: number[];
  jumpAt: number;
  fellAtShown: number;

  leftMode: LeftMode;
  onLeftMode: (m: LeftMode) => void;
  tab: DetailTab;
  onTab: (t: DetailTab) => void;

  /** Null on a nested run, which does not carry the filter. */
  filter: Filter | null;
  onFilter: (f: Filter) => void;
  filterIndex: FilterIndex | null;
  matches: number;
  mask: Uint8Array | null;
  ordinal: number;
  onSeek: (dir: 1 | -1) => void;
  onJumpCompaction: () => void;

  metaSteps: number;
  showMeta: boolean;
  onShowMeta: (v: boolean) => void;

  delegatedMask: Uint8Array | null;
  delegation: Delegation | null;
  onLoadSubagent: (() => void) | null;
  subLoading: boolean;
  subError: string;
  offeredBytes: number;
  onEnterSubagent?: () => void;

  /** One byte per messages-array entry: 1 when a step in it matches. */
  entryHits: Uint8Array | null;
  entriesOpen: Set<number>;
  onEntriesOpen: (s: Set<number>) => void;
  follow: boolean;
  onFollow: (v: boolean) => void;

  /** Bumped by the owner when a jump should scroll the list. */
  revealKey: number;
  /** Held by the owner, so leaving Replay and coming back keeps the position. */
  listScroll: number;
  onListScroll: (y: number) => void;
  nested?: boolean;
};

export default function Replay(p: Props) {
  const [drawer, setDrawer] = useState(false);

  /**
   * The tool a step belongs to, following a result back to the call that names
   * it. A tool_result carries no tool name of its own — the name is on the
   * call — so a list of "Tool call · Edit" followed by a bare "Tool result"
   * makes the reader do the pairing in their head. Resolved for display only:
   * the index is untouched and Record data still shows the record as written.
   */
  const toolOf = useMemo(() => {
    const byIndex = new Map<number, Step>();
    for (const s of p.tape.steps) byIndex.set(s.i, s);
    return (gi: number): string => {
      const s = byIndex.get(gi);
      if (!s) return "";
      if (s.tool) return s.tool;
      if (s.kind !== "tool-result") return "";
      const call = p.pairs.get(gi);
      return call === undefined ? "" : byIndex.get(call)?.tool ?? "";
    };
  }, [p.tape, p.pairs]);

  const drawerTrigger = useRef<HTMLButtonElement>(null);
  const leftRef = useRef<HTMLElement>(null);

  const n = p.steps.length;
  const cur = p.steps[Math.max(0, Math.min(n - 1, p.pos))];
  const filtering = !!p.filter && isActive(p.filter);
  const outOfFilter = filtering && !!p.mask && p.mask[p.pos] === 0;
  const shown = cur ? p.shownIndex(cur.i) || p.pos + 1 : 0;

  // The drawer is a narrow-screen shape only; on a wide screen the column is
  // simply there. Checking the media query at event time rather than at render
  // time keeps the server and the first client render identical.
  const narrow = () =>
    typeof window !== "undefined" && window.matchMedia("(max-width: 899px)").matches;

  useEffect(() => {
    if (!drawer) return;
    leftRef.current?.querySelector<HTMLElement>("input, [role='listbox']")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setDrawer(false);
      drawerTrigger.current?.focus();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [drawer]);

  const pick = (k: number) => {
    p.onPos(k);
    if (narrow()) { setDrawer(false); drawerTrigger.current?.focus(); }
  };

  const mate = cur ? p.pairs.get(cur.i) : undefined;
  const mateStep = mate !== undefined ? p.tape.steps[mate] : undefined;

  return (
    <main className="view view-replay" id="main">
      <div className="replay-bar">
        <h1 className="replay-title">{p.title}</h1>

        <button
          type="button"
          className="btn btn-sm only-narrow"
          ref={drawerTrigger}
          aria-expanded={drawer}
          onClick={() => setDrawer(true)}
        >
          <ListIcon />
          <span>Steps {fmtInt(shown)}/{fmtInt(n)}</span>
        </button>

        <div className="stepnav">
          <button
            type="button"
            className="btn btn-sm btn-icon"
            aria-label="Previous step"
            disabled={p.pos <= 0}
            onClick={() => p.onPos(p.pos - 1)}
          >
            <PrevIcon />
          </button>
          <span className="stepnav-at" aria-live="off">
            Step {fmtInt(shown)} of {fmtInt(n)}
          </span>
          <button
            type="button"
            className="btn btn-sm btn-icon"
            aria-label="Next step"
            disabled={p.pos >= n - 1}
            onClick={() => p.onPos(p.pos + 1)}
          >
            <NextIcon />
          </button>
        </div>

        <div className="replay-rail">
          <Timeline
            steps={p.steps}
            pos={p.pos}
            onPos={p.onPos}
            mask={filtering ? p.mask : null}
            delegated={p.delegatedMask}
            onSeek={p.onSeek}
            shownIndex={p.shownIndex}
            toolOf={toolOf}
          />
          <RailLegend delegations={!!p.delegatedMask} />
        </div>

        <div className="replay-jumps">
          <button type="button" className="btn btn-sm" onClick={() => p.onSeek(1)}>
            Next {filtering ? "match" : "failure"}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={p.onJumpCompaction}
            disabled={p.compactions.length === 0}
            title={p.compactions.length
              ? "Go to the next context compaction"
              : "This session was never compacted"}
          >
            Compaction
            {p.compactions.length > 0 && <span className="btn-tail">{p.compactions.length}</span>}
          </button>
          {p.filter && p.filterIndex && (
            <FiltersButton filter={p.filter} onFilter={p.onFilter} index={p.filterIndex} />
          )}
        </div>
      </div>

      {p.filter && <FilterChips filter={p.filter} onFilter={p.onFilter} />}

      {outOfFilter && (
        <p className="note note-warning replay-notice" role="status">
          <WarnIcon />
          <span className="note-text">
            The selected step is outside the current filter. It has been left where it was rather
            than moved.
          </span>
        </p>
      )}

      <div className={"replay-cols" + (drawer ? " drawer-open" : "")}>
        {drawer && (
          <div
            className="drawer-scrim only-narrow"
            onClick={() => { setDrawer(false); drawerTrigger.current?.focus(); }}
          />
        )}

        <aside
          className={"replay-left" + (drawer ? " open" : "")}
          ref={leftRef}
          aria-label="Steps and messages"
        >
          <div className="left-head">
            <div className="segmented" role="tablist" aria-label="What the list shows">
              <button
                type="button"
                role="tab"
                id="left-tab-steps"
                aria-selected={p.leftMode === "steps"}
                aria-controls="left-panel"
                tabIndex={p.leftMode === "steps" ? 0 : -1}
                className={"seg" + (p.leftMode === "steps" ? " seg-on" : "")}
                onClick={() => p.onLeftMode("steps")}
                onKeyDown={(e) => {
                  if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                    e.preventDefault();
                    p.onLeftMode("messages");
                  }
                }}
              >
                Steps
              </button>
              <button
                type="button"
                role="tab"
                id="left-tab-messages"
                aria-selected={p.leftMode === "messages"}
                aria-controls="left-panel"
                tabIndex={p.leftMode === "messages" ? 0 : -1}
                className={"seg" + (p.leftMode === "messages" ? " seg-on" : "")}
                onClick={() => p.onLeftMode("messages")}
                onKeyDown={(e) => {
                  if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                    e.preventDefault();
                    p.onLeftMode("steps");
                  }
                }}
              >
                Messages
              </button>
            </div>
            <button
              type="button"
              className="btn btn-sm only-narrow"
              onClick={() => { setDrawer(false); drawerTrigger.current?.focus(); }}
            >
              Done
            </button>
          </div>

          <div
            className="left-panel"
            id="left-panel"
            role="tabpanel"
            aria-labelledby={p.leftMode === "steps" ? "left-tab-steps" : "left-tab-messages"}
          >
            {p.leftMode === "steps" ? (
              <>
                {p.filter && (
                  <SearchBox
                    filter={p.filter}
                    onFilter={p.onFilter}
                    matches={p.matches}
                    total={n}
                    ordinal={p.ordinal}
                  />
                )}
                {filtering && p.matches === 0 ? (
                  <div className="list-empty">
                    <p className="empty-title">No matching steps</p>
                    <p className="empty-line">
                      This session still has {fmtInt(n)} steps; none of them matches what is being
                      filtered for. The step on the right is unchanged.
                    </p>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => p.onFilter({ tools: [], minChars: 0, query: "" })}
                    >
                      Clear filters
                    </button>
                  </div>
                ) : (
                  <StepList
                    steps={p.steps}
                    pos={p.pos}
                    onPos={pick}
                    mask={filtering ? p.mask : null}
                    delegated={p.delegatedMask}
                    shownIndex={p.shownIndex}
                    toolOf={toolOf}
                    revealKey={p.revealKey}
                    scrollTop={p.listScroll}
                    onScrollTop={p.onListScroll}
                  />
                )}
                {p.metaSteps > 0 && (
                  <label className="check left-foot">
                    <input
                      type="checkbox"
                      checked={p.showMeta}
                      onChange={(e) => p.onShowMeta(e.target.checked)}
                    />
                    <span>Show {fmtInt(p.metaSteps)} bookkeeping records</span>
                  </label>
                )}
              </>
            ) : (
              <MessagesPanel
                entries={p.tape.entries}
                steps={p.tape.steps}
                curStep={p.curGlobal}
                redacted={p.tape.meta.redacted}
                onSelectStep={p.onSelectStep}
                shownIndex={p.shownIndex}
                entryHits={p.entryHits}
                toolOf={toolOf}
                open={p.entriesOpen}
                onOpen={p.onEntriesOpen}
                follow={p.follow}
                onFollow={p.onFollow}
              />
            )}
          </div>
        </aside>

        <section className="replay-main" aria-label="The selected step">
          <header className="step-head">
            {/* The focus target for a jump from anywhere else. A ring around
                the whole panel read as a selected container rather than as
                "focus is here"; a ring around the heading reads as itself. */}
            <h2 className="step-head-title" id="step-heading" tabIndex={-1}>
              Step {fmtInt(shown)}
              <span className="step-head-sep" aria-hidden> · </span>
              <span className="step-head-kind">{cur ? stepKindLabel(cur) : "—"}</span>
              {cur && toolOf(cur.i) && <span className="step-head-tool">{toolOf(cur.i)}</span>}
              {cur?.err && (
                <span className="tag tag-error tag-lg">
                  <CrossIcon size={12} />
                  Failed
                </span>
              )}
            </h2>
            <p className="step-head-meta">
              {cur && cur.ts !== null ? fmtClock(cur.t) : "no timestamp"}
              {cur && mateStep && (
                <>
                  <span className="dot" aria-hidden>·</span>
                  {cur.kind === "tool-call"
                    ? `result at step ${fmtInt(p.shownIndex(mateStep.i) || mateStep.i + 1)}`
                    : `answers the call at step ${fmtInt(p.shownIndex(mateStep.i) || mateStep.i + 1)}`}
                  {cur.ts !== null && mateStep.ts !== null && (
                    <> in {fmtDuration(Math.abs(mateStep.t - cur.t))}</>
                  )}
                </>
              )}
              {cur && !mateStep && cur.kind === "tool-call" && (
                <><span className="dot" aria-hidden>·</span>no result recorded</>
              )}
            </p>
          </header>

          <div className="tabs" role="tablist" aria-label="What to show about this step">
            {DETAIL_TABS.map((t) => (
              <button
                type="button"
                key={t.id}
                role="tab"
                id={"tab-" + t.id}
                aria-selected={p.tab === t.id}
                aria-controls="detail-panel"
                tabIndex={p.tab === t.id ? 0 : -1}
                className={"tab" + (p.tab === t.id ? " tab-on" : "")}
                onClick={() => p.onTab(t.id)}
                onKeyDown={(e) => {
                  const i = DETAIL_TABS.findIndex((x) => x.id === p.tab);
                  if (e.key === "ArrowRight") {
                    e.preventDefault();
                    p.onTab(DETAIL_TABS[(i + 1) % DETAIL_TABS.length].id);
                  } else if (e.key === "ArrowLeft") {
                    e.preventDefault();
                    p.onTab(DETAIL_TABS[(i - 1 + DETAIL_TABS.length) % DETAIL_TABS.length].id);
                  }
                }}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div
            className="detail-panel"
            id="detail-panel"
            role="tabpanel"
            aria-labelledby={"tab-" + p.tab}
          >
            {p.tab === "details" && (
              <StepDetail
                tape={p.tape}
                curStep={p.curGlobal}
                pairs={p.pairs}
                onSelectStep={p.onSelectStep}
                shownIndex={p.shownIndex}
                delegation={p.delegation}
                onLoadSubagent={p.onLoadSubagent}
                subLoading={p.subLoading}
                subError={p.subError}
                offeredBytes={p.offeredBytes}
                onEnterSubagent={p.onEnterSubagent}
                nested={p.nested}
              />
            )}
            {p.tab === "context" && (
              <ContextView
                steps={p.steps}
                pos={p.pos}
                onPos={p.onPos}
                summary={p.summary}
                trace={p.trace}
                compactions={p.compactions}
                jumpAt={p.jumpAt}
                shownIndex={p.shownIndex}
                fellAtShown={p.fellAtShown}
              />
            )}
            {p.tab === "record" && (
              <RecordData
                tape={p.tape}
                curStep={p.curGlobal}
                shownIndex={p.shownIndex}
                onSelectStep={p.onSelectStep}
              />
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
