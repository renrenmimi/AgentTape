"use client";

// The filter bar. Four controls and a count.
//
// The tool menu is a native <details>, which means it opens with the keyboard,
// closes with Escape and needs no state of its own. The size threshold is a
// <select> of presets rather than a free number field: "show me what blew up
// the context" should be one movement, not a decision about what number to
// type.
//
// The search note is not decoration. Search reads the 96-character previews
// the index already holds, never the bodies, because reading bodies would pull
// the transcript back into memory. That limit is written on the control, since
// a search that quietly misses matches is worse than one that says what it
// covers.

import { EMPTY_FILTER, SIZE_PRESETS, isActive, type Filter, type FilterIndex } from "@/lib/filter";
import { useState } from "react";
import { fmtInt } from "@/lib/summary";

type Props = {
  filter: Filter;
  onFilter: (f: Filter) => void;
  index: FilterIndex;
  matches: number;
  total: number;
  /** Which match the playhead is on, 1-based, or 0 when it is not on one. */
  ordinal: number;
  compactions: number[];
  onJumpCompaction: () => void;
  outOfFilter: boolean;
};

export default function FilterBar({
  filter, onFilter, index, matches, total, ordinal, compactions, onJumpCompaction, outOfFilter,
}: Props) {
  const active = isActive(filter);
  // A session can call a hundred MCP tools. Twenty-eight is already more than
  // a menu should ask anyone to read.
  const [toolQuery, setToolQuery] = useState("");
  const q = toolQuery.trim().toLowerCase();
  const shown = q ? index.tools.filter((t) => t.name.toLowerCase().includes(q)) : index.tools;

  const toggleTool = (name: string) => {
    const has = filter.tools.includes(name);
    onFilter({
      ...filter,
      tools: has ? filter.tools.filter((t) => t !== name) : [...filter.tools, name],
    });
  };

  return (
    <div className="filters" role="search" aria-label="Filter steps">
      <span className="eyebrow">filter</span>

      <div className="filter-field">
        <input
          type="search"
          className="filter-input"
          value={filter.query}
          placeholder="search summaries and tools"
          aria-label="Search step summaries, tool names and record types. Summaries only — full bodies are not searched."
          onChange={(e) => onFilter({ ...filter, query: e.target.value })}
        />
        <span className="filter-note" aria-hidden>
          summaries only, not full text
        </span>
      </div>

      <details className="tool-menu">
        <summary aria-label={`Filter by tool. ${filter.tools.length || "no"} selected of ${index.tools.length}.`}>
          tools
          {filter.tools.length > 0 && <b> {filter.tools.length}</b>}
        </summary>
        <div className="tool-menu-panel">
          {index.tools.length === 0 && <p className="empty-note">This tape has no tool calls.</p>}
          {index.tools.length > 6 && (
            <input
              type="search"
              className="tool-menu-search"
              value={toolQuery}
              placeholder={`filter ${index.tools.length} tool names`}
              aria-label="Filter the list of tool names"
              onChange={(e) => setToolQuery(e.target.value)}
            />
          )}
          {index.tools.length > 0 && shown.length === 0 && (
            <p className="empty-note">No tool name contains that.</p>
          )}
          {shown.map((t) => (
            <label className="tool-opt" key={t.name}>
              <input
                type="checkbox"
                checked={filter.tools.includes(t.name)}
                onChange={() => toggleTool(t.name)}
              />
              <span className="tool-opt-name">{t.name}</span>
              <span className="tool-opt-n">{fmtInt(t.count)}</span>
            </label>
          ))}
        </div>
      </details>

      <div className="filter-field">
        <label className="filter-note" htmlFor="min-chars">≥ chars</label>
        <input
          id="min-chars"
          type="number"
          min={0}
          step={1000}
          list="size-presets"
          className="filter-input filter-num"
          value={filter.minChars || ""}
          placeholder="any size"
          aria-label="Minimum payload size in characters. Any number; the list offers common ones."
          onChange={(e) => {
            const n = Number(e.target.value);
            onFilter({ ...filter, minChars: Number.isFinite(n) && n > 0 ? Math.floor(n) : 0 });
          }}
        />
        <datalist id="size-presets">
          {SIZE_PRESETS.map((v) => <option value={v} key={v} />)}
        </datalist>
      </div>

      <button
        type="button"
        className="btn btn-sm"
        onClick={onJumpCompaction}
        disabled={compactions.length === 0}
        title={
          compactions.length
            ? "Jump to the next context compaction"
            : "This session was never compacted"
        }
      >
        compaction{compactions.length ? ` (${compactions.length})` : "s: none"}
      </button>

      <span className="spacer" />

      {outOfFilter && (
        <span className="filter-out" title="The playhead is on a step that does not match. It was left where it was rather than moved.">
          playhead out of filter
        </span>
      )}

      <span className="filter-count" aria-live="polite">
        {active
          ? `${fmtInt(matches)} of ${fmtInt(total)} match`
          : `${fmtInt(total)} steps`}
      </span>

      {active && matches > 0 && (
        // Where the playhead sits among the matches. Without this, pressing n
        // on the last match does nothing and there is no way to know why.
        <span className={"filter-pos" + (ordinal === matches ? " filter-pos-end" : "")}>
          {ordinal === 0
            ? "not on a match"
            : ordinal === matches
              ? `on match ${fmtInt(ordinal)} of ${fmtInt(matches)} · last`
              : `on match ${fmtInt(ordinal)} of ${fmtInt(matches)}`}
        </span>
      )}

      <button
        type="button"
        className="btn btn-sm"
        onClick={() => onFilter(EMPTY_FILTER)}
        disabled={!active}
      >
        Clear filter
      </button>
    </div>
  );
}
