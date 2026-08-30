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

import { EMPTY_FILTER, SIZE_STEPS, isActive, type Filter, type FilterIndex } from "@/lib/filter";
import { fmtInt } from "@/lib/summary";

type Props = {
  filter: Filter;
  onFilter: (f: Filter) => void;
  index: FilterIndex;
  matches: number;
  total: number;
  compactions: number[];
  onJumpCompaction: () => void;
  outOfFilter: boolean;
};

export default function FilterBar({
  filter, onFilter, index, matches, total, compactions, onJumpCompaction, outOfFilter,
}: Props) {
  const active = isActive(filter);

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
          {index.tools.map((t) => (
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

      <label className="filter-field">
        <span className="sr-only">Minimum payload size</span>
        <select
          className="filter-input"
          value={filter.minChars}
          aria-label="Minimum payload size in characters"
          onChange={(e) => onFilter({ ...filter, minChars: Number(e.target.value) })}
        >
          {SIZE_STEPS.map((s) => (
            <option value={s.value} key={s.value}>{s.label}</option>
          ))}
        </select>
      </label>

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
