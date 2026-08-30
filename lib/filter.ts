// Finding something in a run of ten thousand steps.
//
// Dragging is not a query. This is the part that answers "only the Bash calls",
// "only the steps big enough to have blown up the context", and "where does the
// word `migration` appear".
//
// The one rule that shapes everything here: **search never reads a body**.
// The index holds a 96-character preview per step and that is what is
// searched. Reading bodies would mean pulling the transcript back into memory,
// which is the design this whole tool is built to avoid — so the limit is
// stated in the UI rather than hidden. A search that silently misses matches
// is worse than one that says what it covers.

import type { Step } from "./format.ts";

export type Filter = {
  /** Tool names to keep. Empty means every tool. */
  tools: string[];
  /** Minimum payload characters. Zero means no threshold. */
  minChars: number;
  /** Free text, matched against previews, tool names and record types. */
  query: string;
};

export const EMPTY_FILTER: Filter = { tools: [], minChars: 0, query: "" };

export function isActive(f: Filter): boolean {
  return f.tools.length > 0 || f.minChars > 0 || f.query.trim() !== "";
}

/** Presets for the size threshold, chosen to bracket what a real run holds. */
export const SIZE_STEPS: { label: string; value: number }[] = [
  { label: "any size", value: 0 },
  { label: "≥ 1,000 chars", value: 1_000 },
  { label: "≥ 10,000 chars", value: 10_000 },
  { label: "≥ 50,000 chars", value: 50_000 },
  { label: "≥ 200,000 chars", value: 200_000 },
  { label: "≥ 1,000,000 chars", value: 1_000_000 },
];

export type FilterIndex = {
  /** Effective tool name per global step index; "" where there is none. */
  tool: string[];
  /** Lowercased searchable text per global step index. */
  hay: string[];
  /** Tool names present in this tape, most-called first. */
  tools: { name: string; count: number }[];
};

/**
 * Built once per tape, not per keystroke. Lowercasing ten thousand previews
 * every time a character is typed is the difference between a filter that
 * keeps up with typing and one that does not.
 *
 * A tool_result inherits the name of the call it belongs to, so asking for one
 * tool gives you both halves of the exchange rather than a call with its answer
 * filtered away.
 */
export function buildFilterIndex(steps: Step[], pairs: Map<number, number>): FilterIndex {
  const size = steps.length ? steps[steps.length - 1].i + 1 : 0;
  const tool = new Array<string>(size).fill("");
  const hay = new Array<string>(size).fill("");
  const counts = new Map<string, number>();

  // Two linear passes, not a lookup per result: a scan for the call belonging
  // to each of 2,660 results is 28 million comparisons on a large tape.
  for (const s of steps) {
    tool[s.i] = s.tool;
    if (s.kind === "tool-call" && s.tool) counts.set(s.tool, (counts.get(s.tool) ?? 0) + 1);
  }
  for (const s of steps) {
    if (!tool[s.i] && s.kind === "tool-result") {
      const call = pairs.get(s.i);
      if (call !== undefined) tool[s.i] = tool[call] ?? "";
    }
    hay[s.i] = (s.preview + " " + tool[s.i] + " " + s.rawType + " " + s.kind).toLowerCase();
  }

  return {
    tool,
    hay,
    tools: [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
  };
}

/**
 * A byte per step: 1 matches, 0 does not. Non-matching steps are dimmed rather
 * than dropped, so the mask is parallel to the view instead of replacing it —
 * position and density on the timeline stay honest.
 */
export function applyFilter(
  steps: Step[],
  ix: FilterIndex,
  f: Filter,
): { mask: Uint8Array; count: number } {
  const mask = new Uint8Array(steps.length);
  const q = f.query.trim().toLowerCase();
  const tools = f.tools.length ? new Set(f.tools) : null;
  let count = 0;

  for (let k = 0; k < steps.length; k++) {
    const s = steps[k];
    if (tools && !tools.has(ix.tool[s.i] ?? "")) continue;
    if (f.minChars > 0 && s.chars < f.minChars) continue;
    if (q && !(ix.hay[s.i] ?? "").includes(q)) continue;
    mask[k] = 1;
    count++;
  }
  return { mask, count };
}

/** Next or previous matching position, or -1. Wraps nowhere: it stops at the ends. */
export function seek(mask: Uint8Array, from: number, dir: 1 | -1): number {
  for (let i = from + dir; i >= 0 && i < mask.length; i += dir) {
    if (mask[i]) return i;
  }
  return -1;
}
