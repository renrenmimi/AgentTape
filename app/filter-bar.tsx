"use client";

// Search, filters, and what is currently being filtered.
//
// Three pieces, placed where each is used rather than in one bar at the top:
// the search box sits directly above the list it searches, the tool and size
// conditions live behind a Filters button, and whatever is currently in force
// is a row of chips that is always on screen. A filter you cannot see is a
// filter you will blame the data for.
//
// The scope note on the search box is not decoration. Search reads the
// 96-character previews the index already holds and never a body, because
// reading bodies would pull the transcript back into memory — which is the
// design the whole tool is built around. A search that quietly misses matches
// is worse than one that says what it covers.

import { useEffect, useId, useRef, useState } from "react";
import { EMPTY_FILTER, SIZE_PRESETS, isActive, type Filter, type FilterIndex } from "@/lib/filter";
import { fmtInt } from "@/lib/summary";
import { CrossIcon, FilterIcon, SearchIcon } from "./icons";

export function SearchBox({
  filter, onFilter, matches, total, ordinal,
}: {
  filter: Filter;
  onFilter: (f: Filter) => void;
  matches: number;
  total: number;
  ordinal: number;
}) {
  const id = useId();
  const active = isActive(filter);
  return (
    <div className="search">
      <label className="search-label" htmlFor={id}>Search summaries</label>
      <div className="search-field">
        <SearchIcon />
        <input
          id={id}
          type="search"
          className="input filter-input"
          value={filter.query}
          placeholder="tool name, record type, summary text"
          aria-describedby={id + "-note"}
          onChange={(e) => onFilter({ ...filter, query: e.target.value })}
        />
      </div>
      <p className="search-note" id={id + "-note"}>
        Summaries, tool names and record types. Full message bodies are not searched.
      </p>
      <p className="search-count" aria-live="polite">
        {active
          ? `${fmtInt(matches)} of ${fmtInt(total)} steps match` +
            (matches > 0 && ordinal > 0
              ? ` · on match ${fmtInt(ordinal)}${ordinal === matches ? " (last)" : ""}`
              : matches > 0 ? " · the selected step is not one of them" : "")
          : `${fmtInt(total)} steps`}
      </p>
    </div>
  );
}

/** The conditions in force, always visible, each removable on its own. */
export function FilterChips({
  filter, onFilter,
}: { filter: Filter; onFilter: (f: Filter) => void }) {
  if (!isActive(filter)) return null;
  const chips: { key: string; label: string; clear: () => void }[] = [];
  if (filter.query.trim()) {
    chips.push({
      key: "q",
      label: `text: ${filter.query.trim()}`,
      clear: () => onFilter({ ...filter, query: "" }),
    });
  }
  for (const t of filter.tools) {
    chips.push({
      key: "tool:" + t,
      label: `tool: ${t}`,
      clear: () => onFilter({ ...filter, tools: filter.tools.filter((x) => x !== t) }),
    });
  }
  if (filter.minChars > 0) {
    chips.push({
      key: "min",
      label: `at least ${fmtInt(filter.minChars)} characters`,
      clear: () => onFilter({ ...filter, minChars: 0 }),
    });
  }
  return (
    <div className="chips" aria-label="Filters in force">
      {chips.map((c) => (
        <span className="chip" key={c.key}>
          <span className="chip-text">{c.label}</span>
          <button
            type="button"
            className="chip-x"
            aria-label={`Remove filter: ${c.label}`}
            onClick={c.clear}
          >
            <CrossIcon size={12} />
          </button>
        </span>
      ))}
      <button type="button" className="btn btn-quiet btn-sm" onClick={() => onFilter(EMPTY_FILTER)}>
        Clear filters
      </button>
    </div>
  );
}

/** Tool names and payload size, behind a button, with the count on the button. */
export function FiltersButton({
  filter, onFilter, index,
}: { filter: Filter; onFilter: (f: Filter) => void; index: FilterIndex }) {
  const [open, setOpen] = useState(false);
  const [toolQuery, setToolQuery] = useState("");
  const host = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!host.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [open]);

  const q = toolQuery.trim().toLowerCase();
  const shown = q ? index.tools.filter((t) => t.name.toLowerCase().includes(q)) : index.tools;
  const n = filter.tools.length + (filter.minChars > 0 ? 1 : 0);

  const toggleTool = (name: string) => {
    const has = filter.tools.includes(name);
    onFilter({
      ...filter,
      tools: has ? filter.tools.filter((t) => t !== name) : [...filter.tools, name],
    });
  };

  return (
    <div className="popover-host" ref={host}>
      <button
        type="button"
        className={"btn btn-sm" + (n ? " btn-on" : "")}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <FilterIcon />
        <span>Filters</span>
        {n > 0 && <span className="btn-tail">{n}</span>}
      </button>

      {open && (
        <div
          className="popover"
          id={id}
          role="group"
          aria-label="Filter steps by tool and payload size"
          onKeyDown={(e) => {
            if (e.key !== "Escape") return;
            e.stopPropagation();
            setOpen(false);
            host.current?.querySelector("button")?.focus();
          }}
        >
          <div className="popover-sec">
            <h3 className="popover-title">Tool</h3>
            {index.tools.length === 0 ? (
              <p className="empty-line">This session called no tools.</p>
            ) : (
              <>
                {index.tools.length > 6 && (
                  <input
                    type="search"
                    className="input"
                    value={toolQuery}
                    placeholder={`Find one of ${index.tools.length} tool names`}
                    aria-label="Find a tool name"
                    onChange={(e) => setToolQuery(e.target.value)}
                  />
                )}
                {shown.length === 0 && <p className="empty-line">No tool name contains that.</p>}
                <div className="tool-opts">
                  {shown.map((t) => (
                    <label className="check tool-opt" key={t.name}>
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
              </>
            )}
          </div>

          <div className="popover-sec">
            <h3 className="popover-title">Payload size</h3>
            <label className="field">
              <span className="field-label">At least this many characters</span>
              <input
                type="number"
                min={0}
                step={1000}
                list="size-presets"
                className="input"
                value={filter.minChars || ""}
                placeholder="any size"
                onChange={(e) => {
                  const v = Number(e.target.value);
                  onFilter({ ...filter, minChars: Number.isFinite(v) && v > 0 ? Math.floor(v) : 0 });
                }}
              />
            </label>
            <datalist id="size-presets">
              {SIZE_PRESETS.map((v) => <option value={v} key={v} />)}
            </datalist>
          </div>

          <div className="popover-foot">
            <button
              type="button"
              className="btn btn-sm"
              disabled={!isActive(filter)}
              onClick={() => onFilter(EMPTY_FILTER)}
            >
              Clear filters
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setOpen(false)}>Done</button>
          </div>
        </div>
      )}
    </div>
  );
}
