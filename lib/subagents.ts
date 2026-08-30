// Delegated work — the blind spot.
//
// When a session hands a job to a subagent, the main transcript keeps the call
// and a summary of what came back. Everything the subagent actually did lands
// in a separate file:
//
//   ~/.claude/projects/<project>/<sessionId>/subagents/agent-<id>.jsonl
//
// and `isSidechain` is *false* on every record of the main file — all 8,733
// that carried the field across the probe fixtures — so a reader of the main
// file cannot even tell that something is missing. In the large fixture this
// hides 929 of 3,589 tool calls: a quarter of the run.
//
// Detection needs only the main file. Loading needs the other files, and the
// hard part is knowing which one belongs to which call.

import type { Step, Tape } from "./format.ts";

/**
 * Tools that hand work to a subagent. `Agent` is the one observed — 16 calls in
 * the large fixture, every one of which has a file beside it. This set is the
 * single place to add another name; nothing else in the codebase decides.
 */
export const DELEGATION_TOOLS = new Set(["Agent"]);

export const isDelegation = (s: Step): boolean =>
  s.kind === "tool-call" && DELEGATION_TOOLS.has(s.tool);

/** `agent-0123456789012345.jsonl` → `0123456789012345`. */
export function agentIdFromName(name: string): string {
  const m = /^agent-([A-Za-z0-9_-]+)\.jsonl$/.exec(name.replace(/^.*\//, ""));
  return m ? m[1] : "";
}

export type Delegation = {
  /** Global step index of the tool_use that delegated. */
  step: number;
  toolUseId: string;
  /** Global step index of the matched result, or -1 if the run was cut off. */
  result: number;
  /** The window the subagent must have run inside. */
  from: number;
  to: number;
  /** The subagent's own run, once one is attached. */
  run: SubRun | null;
};

export type SubRun = {
  agentId: string;
  bytes: number;
  lines: number;
  steps: number;
  toolCalls: number;
  errors: number;
  tools: { name: string; count: number }[];
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  firstT: number;
  lastT: number;
  /** How the file was matched to its call, so the UI can say. */
  pairedBy: "sidecar" | "time" | "manual";
  tape: Tape;
};

/** Every delegation in a main transcript, found without opening anything else. */
export function findDelegations(steps: Step[], pairs: Map<number, number>): Delegation[] {
  const out: Delegation[] = [];
  for (const s of steps) {
    if (!isDelegation(s)) continue;
    const r = pairs.get(s.i);
    const result = r === undefined ? -1 : r;
    out.push({
      step: s.i,
      toolUseId: s.toolUseId,
      result,
      from: s.t,
      // A call with no result never came back; the window stays open.
      to: result >= 0 ? steps[result].t : Number.POSITIVE_INFINITY,
      run: null,
    });
  }
  return out;
}

/**
 * Which delegation does this file belong to?
 *
 * The sidecar `.meta.json` carries the parent's tool_use id and is exact, but
 * it is a separate file — the helper reads it, a drag-and-drop usually will
 * not. Without it, nothing inside a subagent transcript points back at its
 * parent: no field of its first record equals the parent tool_use id.
 *
 * So the fallback is the clock. A subagent runs strictly between its call and
 * the result of that call, and on the large fixture that window identifies the
 * right parent for all sixteen files with no ambiguity at all. Where a start
 * time lands inside two open windows — possible with parallel delegations —
 * this returns -1 rather than picking one, and the file stays unattached.
 */
export function pairByTime(dels: Delegation[], firstT: number, slackMs = 2000): number {
  let hit = -1;
  for (let i = 0; i < dels.length; i++) {
    const d = dels[i];
    if (firstT < d.from - slackMs) continue;
    if (firstT > d.to + slackMs) continue;
    if (hit >= 0) return -1; // ambiguous: refuse rather than guess
    hit = i;
  }
  return hit;
}

export function pairBySidecar(dels: Delegation[], toolUseId: string): number {
  return dels.findIndex((d) => d.toolUseId === toolUseId);
}

/** Everything the nested strip needs, derived from an indexed subagent tape. */
export function summariseRun(
  tape: Tape,
  agentId: string,
  pairedBy: SubRun["pairedBy"],
): SubRun {
  const tools = new Map<string, number>();
  let toolCalls = 0, errors = 0;
  let input = 0, output = 0, cacheRead = 0, cacheCreate = 0;
  let firstT = 0, lastT = 0;

  for (const s of tape.steps) {
    if (s.t) {
      if (!firstT) firstT = s.t;
      lastT = s.t;
    }
    if (s.err) errors++;
    if (s.kind === "tool-call") {
      toolCalls++;
      const name = s.tool || "(unnamed)";
      tools.set(name, (tools.get(name) ?? 0) + 1);
    }
    if (s.usage) {
      input += s.usage.input;
      output += s.usage.output;
      cacheRead += s.usage.cacheRead;
      cacheCreate += s.usage.cacheCreate;
    }
  }

  return {
    agentId,
    bytes: tape.meta.bytes,
    lines: tape.meta.lines,
    steps: tape.steps.length,
    toolCalls,
    errors,
    tools: [...tools.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    input,
    output,
    cacheRead,
    cacheCreate,
    firstT,
    lastT,
    pairedBy,
    tape,
  };
}

/** What the header strip reports about work this file does not contain. */
export function delegationSummary(dels: Delegation[]): {
  total: number;
  loaded: number;
  steps: number;
  toolCalls: number;
} {
  let loaded = 0, steps = 0, toolCalls = 0;
  for (const d of dels) {
    if (!d.run) continue;
    loaded++;
    steps += d.run.steps;
    toolCalls += d.run.toolCalls;
  }
  return { total: dels.length, loaded, steps, toolCalls };
}
