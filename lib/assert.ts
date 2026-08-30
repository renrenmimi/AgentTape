// Stating what a run was supposed to do, and checking whether it did.
//
// This is the part that makes AgentTape a testing tool rather than only a
// debugging one. The failure it exists to catch is the quiet one: the day your
// agent stops searching before it writes, and nothing breaks, and the output is
// merely worse.
//
// The vocabulary is deliberately tiny. Five rules, each a plain object, each
// answering a question somebody actually asks about a run. It is not a query
// language and should not become one: the moment a rule needs a parser, the
// thing being tested has stopped being the run and started being the rule.
//
// Every rule is checked against the index alone — tool names, timings, token
// counts, error flags. No rule reads a body, so a redacted tape can be asserted
// against exactly as well as the transcript it came from.

import type { Step } from "./format.ts";

export type Rule =
  /** Every call to `then` must have a call to `first` somewhere before it. */
  | { kind: "before"; first: string; then: string }
  /** No tool called more than `n` times in a row. Optionally only one tool. */
  | { kind: "max-repeats"; n: number; tool?: string }
  /** Context never exceeds `n` tokens. */
  | { kind: "max-context"; n: number }
  /** No tool call takes longer than `n` seconds to return. */
  | { kind: "max-tool-seconds"; n: number }
  /** The run finishes without an error and without an unanswered tool call. */
  | { kind: "ends-clean" };

export type RuleResult = {
  rule: Rule;
  /** The rule as a sentence, for the panel. */
  label: string;
  pass: boolean;
  /** Why it passed or failed, in one line. */
  detail: string;
  /** Global step index of the offending step, or -1. */
  at: number;
  /**
   * True when the rule had nothing to check — no call to the tool it names, no
   * context figures at all. Reported separately from a pass, because "nothing
   * violated this" and "this was never tested" are different facts.
   */
  vacuous: boolean;
};

const n = (x: number) => x.toLocaleString("en-US");

export function ruleLabel(r: Rule): string {
  switch (r.kind) {
    case "before": return `${r.first} happens before ${r.then}`;
    case "max-repeats":
      return r.tool
        ? `${r.tool} is not called more than ${n(r.n)} times in a row`
        : `no tool is called more than ${n(r.n)} times in a row`;
    case "max-context": return `context never exceeds ${n(r.n)} tokens`;
    case "max-tool-seconds": return `no tool call takes longer than ${n(r.n)} seconds`;
    case "ends-clean": return "the run ends without an error";
  }
}

/** A starting set: the questions worth asking about almost any run. */
export const DEFAULT_RULES: Rule[] = [
  { kind: "ends-clean" },
  { kind: "max-repeats", n: 5 },
  { kind: "max-context", n: 200_000 },
  { kind: "max-tool-seconds", n: 120 },
];

const calls = (steps: Step[]): Step[] => steps.filter((s) => s.kind === "tool-call");

function checkBefore(steps: Step[], r: Extract<Rule, { kind: "before" }>): Omit<RuleResult, "rule" | "label"> {
  let seenFirst = false;
  for (const s of calls(steps)) {
    if (s.tool === r.first) seenFirst = true;
    else if (s.tool === r.then && !seenFirst) {
      return {
        pass: false,
        detail: `${r.then} was called with no ${r.first} before it`,
        at: s.i,
        vacuous: false,
      };
    }
  }
  const everThen = calls(steps).some((s) => s.tool === r.then);
  if (!everThen) {
    return { pass: true, detail: `${r.then} was never called`, at: -1, vacuous: true };
  }
  return { pass: true, detail: `every ${r.then} had a ${r.first} before it`, at: -1, vacuous: false };
}

function checkRepeats(steps: Step[], r: Extract<Rule, { kind: "max-repeats" }>): Omit<RuleResult, "rule" | "label"> {
  const list = calls(steps);
  if (!list.length) return { pass: true, detail: "this run called no tools", at: -1, vacuous: true };
  let run = 0;
  let prev = "";
  for (const s of list) {
    if (r.tool && s.tool !== r.tool) { run = 0; prev = ""; continue; }
    run = s.tool === prev ? run + 1 : 1;
    prev = s.tool;
    if (run > r.n) {
      return {
        pass: false,
        detail: `${s.tool} was called ${n(run)} times in a row`,
        at: s.i,
        vacuous: false,
      };
    }
  }
  if (r.tool && !list.some((s) => s.tool === r.tool)) {
    return { pass: true, detail: `${r.tool} was never called`, at: -1, vacuous: true };
  }
  return { pass: true, detail: `the longest run of one tool was ${n(longestRun(list, r.tool))}`, at: -1, vacuous: false };
}

function longestRun(list: Step[], only?: string): number {
  let best = 0, run = 0, prev = "";
  for (const s of list) {
    if (only && s.tool !== only) { run = 0; prev = ""; continue; }
    run = s.tool === prev ? run + 1 : 1;
    prev = s.tool;
    if (run > best) best = run;
  }
  return best;
}

function checkContext(steps: Step[], r: Extract<Rule, { kind: "max-context" }>): Omit<RuleResult, "rule" | "label"> {
  let peak = 0, at = -1;
  for (const s of steps) {
    if (s.ctx > peak) { peak = s.ctx; at = s.i; }
  }
  if (!peak) return { pass: true, detail: "this tape carries no context figures", at: -1, vacuous: true };
  if (peak > r.n) {
    return { pass: false, detail: `context reached ${n(peak)} tokens`, at, vacuous: false };
  }
  return { pass: true, detail: `context peaked at ${n(peak)} tokens`, at, vacuous: false };
}

function checkToolSeconds(
  steps: Step[],
  r: Extract<Rule, { kind: "max-tool-seconds" }>,
  pairs: Map<number, number>,
): Omit<RuleResult, "rule" | "label"> {
  let worst = 0, at = -1, measured = 0;
  // Indexed once. A scan per call is 28 million comparisons on a large tape.
  const byIndex = new Map<number, Step>();
  for (const s of steps) byIndex.set(s.i, s);
  for (const s of calls(steps)) {
    const res = pairs.get(s.i);
    if (res === undefined) continue;
    const a = byIndex.get(res);
    if (!a) continue;
    const from = s.ts ?? s.t;
    const to = a.ts ?? a.t;
    if (!from || !to) continue;
    measured++;
    const secs = (to - from) / 1000;
    if (secs > worst) { worst = secs; at = s.i; }
  }
  if (!measured) return { pass: true, detail: "no tool call could be timed", at: -1, vacuous: true };
  if (worst > r.n) {
    return { pass: false, detail: `a call took ${worst.toFixed(1)} seconds`, at, vacuous: false };
  }
  return { pass: true, detail: `the slowest call took ${worst.toFixed(1)} seconds`, at, vacuous: false };
}

function checkEndsClean(steps: Step[], pairs: Map<number, number>): Omit<RuleResult, "rule" | "label"> {
  const real = steps.filter((s) => s.kind !== "meta");
  if (!real.length) return { pass: true, detail: "this run has no steps", at: -1, vacuous: true };

  const lastErr = [...real].reverse().find((s) => s.err);
  const last = real[real.length - 1];
  if (last.err) {
    return { pass: false, detail: `the run's last step failed: ${last.errWhy || "error"}`, at: last.i, vacuous: false };
  }
  const dangling = calls(steps).find((s) => !pairs.has(s.i));
  if (dangling) {
    return {
      pass: false,
      detail: `${dangling.tool || "a tool"} was called and never returned`,
      at: dangling.i,
      vacuous: false,
    };
  }
  const errs = real.filter((s) => s.err).length;
  return {
    pass: true,
    detail: errs
      ? `the run recovered: ${n(errs)} step${errs === 1 ? "" : "s"} failed along the way, the last did not`
      : "no step in the run failed",
    at: errs ? (lastErr?.i ?? -1) : -1,
    vacuous: false,
  };
}

export function checkRule(steps: Step[], rule: Rule, pairs: Map<number, number>): RuleResult {
  const label = ruleLabel(rule);
  switch (rule.kind) {
    case "before": return { rule, label, ...checkBefore(steps, rule) };
    case "max-repeats": return { rule, label, ...checkRepeats(steps, rule) };
    case "max-context": return { rule, label, ...checkContext(steps, rule) };
    case "max-tool-seconds": return { rule, label, ...checkToolSeconds(steps, rule, pairs) };
    case "ends-clean": return { rule, label, ...checkEndsClean(steps, pairs) };
  }
}

export function checkAll(steps: Step[], rules: Rule[], pairs: Map<number, number>): RuleResult[] {
  return rules.map((r) => checkRule(steps, r, pairs));
}

export const tally = (rs: RuleResult[]): { pass: number; fail: number; vacuous: number } => ({
  pass: rs.filter((r) => r.pass).length,
  fail: rs.filter((r) => !r.pass).length,
  vacuous: rs.filter((r) => r.vacuous).length,
});
