// Everything the header strip and the context chart need, derived in one pass.
//
// Two numbers here are worth the trouble. Wall-clock duration on a real
// transcript is close to meaningless — the probe fixtures span 323 h and
// 213 h because sessions get resumed for days — so active duration, which
// drops every gap over two minutes, sits next to it. And the largest
// single-step jump in context is called out by name, because that is the
// failure this tool exists to make visible: one step pushes a big payload into
// the array and every turn after it pays to re-send.

import { IDLE_GAP_MS, type Step, type Tape } from "./format.ts";

export type Summary = {
  steps: number;
  conversationSteps: number;
  metaSteps: number;
  firstT: number;
  lastT: number;
  wallMs: number;
  activeMs: number;
  idleMs: number;
  idleGaps: number;
  longestGapMs: number;
  longestGapAt: number;
  tools: { name: string; count: number; errors: number }[];
  toolCalls: number;
  errors: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  models: string[];
  peakCtx: number;
  peakCtxAt: number;
  /** The step that added the most context, and by how much. */
  jumpAt: number;
  jumpBy: number;
  compactAt: number[];
  turns: number;
};

export function summarise(tape: Tape): Summary {
  const steps = tape.steps;
  const tools = new Map<string, { count: number; errors: number }>();
  const models = new Set<string>();
  const compactAt: number[] = [];

  let firstT = 0;
  let lastT = 0;
  let activeMs = 0;
  let idleMs = 0;
  let idleGaps = 0;
  let longestGapMs = 0;
  let longestGapAt = 0;
  let prevT = 0;
  let errors = 0;
  let input = 0, output = 0, cacheRead = 0, cacheCreate = 0;
  let peakCtx = 0, peakCtxAt = 0;
  let jumpBy = 0, jumpAt = 0;
  let prevCtx = 0;
  let meta = 0;
  let toolCalls = 0;
  let lastCall: Step | null = null;

  for (const s of steps) {
    if (s.kind === "meta") meta++;
    if (s.err) errors++;
    if (s.model) models.add(s.model);
    if (s.compact) compactAt.push(s.i);

    if (s.t) {
      if (!firstT) firstT = s.t;
      if (prevT) {
        const d = s.t - prevT;
        if (d > IDLE_GAP_MS) {
          idleMs += d;
          idleGaps++;
          if (d > longestGapMs) { longestGapMs = d; longestGapAt = s.i; }
        } else if (d > 0) activeMs += d;
      }
      prevT = s.t;
      lastT = s.t;
    }

    if (s.usage) {
      input += s.usage.input;
      output += s.usage.output;
      cacheRead += s.usage.cacheRead;
      cacheCreate += s.usage.cacheCreate;
    }

    if (s.ctx > peakCtx) { peakCtx = s.ctx; peakCtxAt = s.i; }
    if (s.ctx && prevCtx && s.ctx - prevCtx > jumpBy) {
      jumpBy = s.ctx - prevCtx;
      jumpAt = s.i;
    }
    if (s.ctx) prevCtx = s.ctx;

    if (s.kind === "tool-call") {
      toolCalls++;
      lastCall = s;
      const name = s.tool || "(unnamed)";
      const rec = tools.get(name) ?? { count: 0, errors: 0 };
      rec.count++;
      tools.set(name, rec);
    } else if (s.kind === "tool-result" && s.err && lastCall) {
      // The result carries the error flag; the call carries the name.
      const name = lastCall.tool || "(unnamed)";
      const rec = tools.get(name);
      if (rec) rec.errors++;
    }
  }

  return {
    steps: steps.length,
    conversationSteps: steps.length - meta,
    metaSteps: meta,
    firstT,
    lastT,
    wallMs: lastT && firstT ? lastT - firstT : 0,
    activeMs,
    idleMs,
    idleGaps,
    longestGapMs,
    longestGapAt,
    tools: [...tools.entries()]
      .map(([name, v]) => ({ name, count: v.count, errors: v.errors }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    toolCalls,
    errors,
    input,
    output,
    cacheRead,
    cacheCreate,
    models: [...models].sort(),
    peakCtx,
    peakCtxAt,
    jumpAt,
    jumpBy,
    compactAt,
    turns: tape.entries.length,
  };
}

// ------------------------------------------------------------ formatting

export function fmtInt(n: number): string {
  return n.toLocaleString("en-US");
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 2) + "M";
  if (n >= 10_000) return Math.round(n / 1000) + "k";
  if (n >= 1000) return (n / 1000).toFixed(1) + "k";
  return String(n);
}

export function fmtDuration(ms: number): string {
  if (!ms || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + "m " + String(s % 60).padStart(2, "0") + "s";
  const h = Math.floor(m / 60);
  if (h < 48) return h + "h " + String(m % 60).padStart(2, "0") + "m";
  return Math.floor(h / 24) + "d " + (h % 24) + "h";
}

export function fmtBytes(n: number): string {
  if (n >= 1 << 20) return (n / (1 << 20)).toFixed(1) + " MB";
  if (n >= 1 << 10) return Math.round(n / (1 << 10)) + " KB";
  return n + " B";
}

export function fmtClock(t: number): string {
  if (!t) return "—";
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
}

export function fmtDate(t: number): string {
  if (!t) return "—";
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}
