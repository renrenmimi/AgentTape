// Four numbers over a corpus of sessions, computed from the same statistics
// records the helper and the browser overview already produce.
//
// There is no parsing here and no filesystem: `sessionStats` has already
// reduced each session to counts, durations, token totals and tool names, and
// this reduces those to four figures. That ordering is the privacy property —
// a corpus summary cannot leak what a session record does not carry, and a
// session record carries no prose.
//
// Deliberately not a fourth implementation. `agenttape stats` and the script
// that generates the article both call this, so a figure quoted in the article
// and a figure printed on somebody else's machine came out of one function.

import { fmtBytes } from "./summary.ts";
import type { SessionStats } from "./stats.ts";

/** The model id Claude Code writes when an API call failed. */
export const SYNTHETIC = "<synthetic>";

/**
 * Near enough to a million-token window to call it the ceiling. Sessions that
 * pass this stopped rather than compacted, which is the finding.
 */
export const CEILING = 900_000;

/** A context total worth noticing on any window size. */
export const LARGE_CONTEXT = 200_000;

export type ToolRate = { tool: string; calls: number; errors: number; rate: number };

export type CorpusSummary = {
  /** Sessions summarised. Printed with every figure, because a rate without
   *  its n invites exactly the over-claim this whole exercise was about. */
  n: number;
  bytes: number;
  lines: number;
  steps: number;
  toolCalls: number;
  writerVersions: number;

  /** 1. A failed API call leaves `<synthetic>` in the model field and nothing else. */
  failedApi: { sessions: number; share: number };

  /** 2. A session is a project lifecycle, not a sitting. */
  time: {
    wallMs: number;
    activeMs: number;
    idleShare: number;
    /** Per session, then the middle of those — not a ratio of two medians. */
    medianIdleShare: number;
    spanningOverADay: number;
    longestGapMs: number;
  };

  /** 3. Context reaches the ceiling; compaction almost never catches it. */
  context: {
    medianPeak: number;
    overLarge: number;
    overCeiling: number;
    compacted: number;
    medianJump: number;
    largestJump: number;
  };

  /** 4. Failure rate per tool, sorted, with the counts behind each rate. */
  tools: ToolRate[];
  byClass: { mcp: ToolRate; rest: ToolRate };
  failedSteps: number;
};

const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

const rate = (tool: string, calls: number, errors: number): ToolRate => ({
  tool, calls, errors, rate: calls ? errors / calls : 0,
});

/** Everything the four findings are about, and nothing that could carry prose. */
export function summariseCorpus(sessions: SessionStats[]): CorpusSummary {
  const S = sessions;
  const sum = (f: (s: SessionStats) => number) => S.reduce((t, s) => t + f(s), 0);

  const calls = new Map<string, number>();
  const errs = new Map<string, number>();
  for (const s of S) {
    for (const [t, n] of Object.entries(s.tools ?? {})) calls.set(t, (calls.get(t) ?? 0) + n);
    for (const [t, n] of Object.entries(s.toolErrors ?? {})) errs.set(t, (errs.get(t) ?? 0) + n);
  }

  const tools = [...calls.entries()]
    .map(([t, n]) => rate(t, n, errs.get(t) ?? 0))
    .sort((a, b) => b.rate - a.rate || b.calls - a.calls);

  const isMcp = (t: string) => t.startsWith("mcp__");
  const bucket = (want: (t: string) => boolean, label: string) => {
    let c = 0, e = 0;
    for (const t of tools) if (want(t.tool)) { c += t.calls; e += t.errors; }
    return rate(label, c, e);
  };

  const wallMs = sum((s) => s.wallMs);
  const activeMs = sum((s) => s.activeMs);
  const idleShares = S.filter((s) => s.wallMs > 0)
    .map((s) => Math.max(0, s.wallMs - s.activeMs) / s.wallMs);

  return {
    n: S.length,
    bytes: sum((s) => s.bytes),
    lines: sum((s) => s.lines),
    steps: sum((s) => s.steps),
    toolCalls: sum((s) => s.toolCalls),
    writerVersions: new Set(S.flatMap((s) => s.versions ?? [])).size,

    failedApi: {
      sessions: S.filter((s) => (s.models ?? []).includes(SYNTHETIC)).length,
      share: S.length ? S.filter((s) => (s.models ?? []).includes(SYNTHETIC)).length / S.length : 0,
    },

    time: {
      wallMs,
      activeMs,
      idleShare: wallMs ? (wallMs - activeMs) / wallMs : 0,
      medianIdleShare: median(idleShares),
      spanningOverADay: S.filter((s) => s.wallMs > 86_400_000).length,
      longestGapMs: S.reduce((m, s) => Math.max(m, s.longestGapMs), 0),
    },

    context: {
      medianPeak: median(S.map((s) => s.peakCtx)),
      overLarge: S.filter((s) => s.peakCtx > LARGE_CONTEXT).length,
      overCeiling: S.filter((s) => s.peakCtx > CEILING).length,
      compacted: S.filter((s) => s.compactions > 0).length,
      medianJump: median(S.map((s) => s.jumpBy)),
      largestJump: S.reduce((m, s) => Math.max(m, s.jumpBy), 0),
    },

    tools,
    byClass: { mcp: bucket(isMcp, "mcp"), rest: bucket((t) => !isMcp(t), "everything else") },
    failedSteps: sum((s) => s.errors),
  };
}

// ---------------------------------------------------------------- in words

const pct = (x: number, digits = 1) => (x * 100).toFixed(digits) + "%";
const days = (ms: number) => (ms / 86_400_000).toFixed(1) + "d";

/**
 * The four figures, in words, with n on every one of them.
 *
 * A rate printed without its n invites the over-claim this whole exercise was
 * about: forty sessions on one machine cannot support a conclusion, and the
 * output says so rather than leaving it to be inferred. The last line is the
 * point of the subcommand — it ships the measurement, not anybody's numbers.
 */
export function formatCorpus(c: CorpusSummary, where: string): string {
  const n = (x: number) => x.toLocaleString("en-US");
  const L: string[] = [];
  L.push("");
  // `where` arrives already shortened. The same rule the paste block follows:
  // a full path says where somebody keeps their work, and this output is meant
  // to be shareable.
  L.push(`  ${n(c.n)} sessions under ${where}`);
  L.push(`  ${n(c.lines)} lines · ${fmtBytes(c.bytes)} · ${n(c.steps)} steps · ` +
    `${n(c.toolCalls)} tool calls · ${n(c.writerVersions)} writer versions`);
  L.push("");

  L.push("  1  a failed API call leaves <synthetic> in the model field, and nothing else");
  L.push(`     ${n(c.failedApi.sessions)} of ${n(c.n)} sessions contain one — ${pct(c.failedApi.share)}`);
  L.push("");

  L.push("  2  a session is a project lifecycle, not a sitting");
  L.push(`     ${days(c.time.wallMs)} wall against ${days(c.time.activeMs)} active — ` +
    `${pct(c.time.idleShare)} idle over ${n(c.n)} sessions`);
  L.push(`     the median session is ${pct(c.time.medianIdleShare)} idle ` +
    `(each session's own share, then the middle of those)`);
  L.push(`     ${n(c.time.spanningOverADay)} of ${n(c.n)} span more than a day · ` +
    `longest single gap ${days(c.time.longestGapMs)}`);
  L.push("");

  L.push("  3  context reaches the ceiling; compaction almost never catches it");
  L.push(`     median peak ${n(c.context.medianPeak)} tokens · ` +
    `${n(c.context.overLarge)} of ${n(c.n)} passed 200k · ${n(c.context.overCeiling)} passed 900k`);
  L.push(`     ${n(c.context.compacted)} of ${n(c.n)} compacted — ${pct(c.context.compacted / Math.max(1, c.n))} — ` +
    `against ${n(c.context.overCeiling)} that reached the ceiling`);
  L.push(`     largest single-step increase: median ${n(c.context.medianJump)}, ` +
    `worst ${n(c.context.largestJump)}`);
  L.push("");

  L.push("  4  failure rate per tool");
  const shown = c.tools.filter((t) => t.calls >= 10);
  const w = Math.min(44, Math.max(12, ...shown.map((t) => t.tool.length)));
  for (const t of shown) {
    L.push(`     ${t.tool.padEnd(w)} ${String(n(t.calls)).padStart(7)} calls  ` +
      `${pct(t.rate).padStart(6)}  (${n(t.errors)})`);
  }
  if (c.tools.length > shown.length) {
    L.push(`     ${n(c.tools.length - shown.length)} more tools with fewer than ten calls each, not shown`);
  }
  L.push(`     mcp__* ${pct(c.byClass.mcp.rate)} of ${n(c.byClass.mcp.calls)} calls · ` +
    `everything else ${pct(c.byClass.rest.rate)} of ${n(c.byClass.rest.calls)}`);
  L.push("");

  L.push(`  n = ${n(c.n)}, one machine. These are your numbers, not anybody else's —`);
  L.push("  which is the point. docs/findings.md states mine and asks for yours.");
  L.push("");
  return L.join("\n");
}

