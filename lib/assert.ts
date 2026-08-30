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

// ---------------------------------------------------------------- rule sets

/**
 * The on-disk shape. Versioned, because the vocabulary will grow and a file
 * written today should still say what it meant a year from now.
 *
 * It carries no run and no transcript — only expectations — so a rule set is
 * safe to commit, safe to share, and safe to point at somebody else's tape.
 */
export const RULES_FORMAT = "agenttape-rules/1";

export type RuleSet = {
  format: string;
  /** What this set is for, written by whoever wrote it. */
  name?: string;
  note?: string;
  rules: Rule[];
};

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : null;

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * Read one rule, or say why not.
 *
 * Deliberately strict about kinds and numbers and deliberately quiet about
 * everything else: a rule set written by hand should fail with a sentence
 * naming the rule, not with a stack trace.
 */
export function parseRule(v: unknown, where: string): { rule?: Rule; problem?: string } {
  if (!isObj(v)) return { problem: `${where}: not an object` };
  const kind = str(v.kind);
  switch (kind) {
    case "ends-clean":
      return { rule: { kind } };
    case "max-context":
    case "max-tool-seconds": {
      const n = num(v.n);
      if (n === null) return { problem: `${where}: ${kind} needs a positive number in "n"` };
      return { rule: { kind, n } };
    }
    case "max-repeats": {
      const n = num(v.n);
      if (n === null) return { problem: `${where}: max-repeats needs a positive number in "n"` };
      const tool = str(v.tool);
      return { rule: tool ? { kind, n, tool } : { kind, n } };
    }
    case "before": {
      const first = str(v.first);
      const then = str(v.then);
      if (!first || !then) return { problem: `${where}: before needs "first" and "then" tool names` };
      return { rule: { kind, first, then } };
    }
    case "":
      return { problem: `${where}: no "kind"` };
    default:
      return { problem: `${where}: unknown rule kind "${kind}"` };
  }
}

/**
 * Read a whole set. Returns whatever parsed plus every problem found, rather
 * than the first one — somebody fixing a hand-written file wants the list.
 */
export function parseRuleSet(input: unknown): { set: RuleSet; problems: string[] } {
  const problems: string[] = [];
  const raw = typeof input === "string" ? safeJson(input, problems) : input;
  if (!isObj(raw)) {
    return { set: { format: RULES_FORMAT, rules: [] }, problems: [...problems, "not a JSON object"] };
  }
  if (str(raw.format) !== RULES_FORMAT) {
    problems.push(`format is "${str(raw.format) || "missing"}", expected "${RULES_FORMAT}"`);
  }
  const rules: Rule[] = [];
  const list = Array.isArray(raw.rules) ? raw.rules : [];
  if (!Array.isArray(raw.rules)) problems.push('"rules" is missing or not a list');
  list.forEach((r, i) => {
    const { rule, problem } = parseRule(r, `rules[${i}]`);
    if (rule) rules.push(rule);
    if (problem) problems.push(problem);
  });
  return {
    set: { format: RULES_FORMAT, name: str(raw.name) || undefined, note: str(raw.note) || undefined, rules },
    problems,
  };
}

function safeJson(text: string, problems: string[]): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    problems.push("not valid JSON: " + (e instanceof Error ? e.message : String(e)));
    return null;
  }
}

/** One rule per line, so a diff on a rule set reads as a diff on expectations. */
export function serializeRuleSet(set: RuleSet): string {
  const head: string[] = [`  "format": ${JSON.stringify(RULES_FORMAT)},`];
  if (set.name) head.push(`  "name": ${JSON.stringify(set.name)},`);
  if (set.note) head.push(`  "note": ${JSON.stringify(set.note)},`);
  const lines = set.rules.map((r, i) =>
    "    " + JSON.stringify(r) + (i === set.rules.length - 1 ? "" : ","));
  return "{\n" + head.join("\n") + "\n  \"rules\": [\n" + lines.join("\n") + "\n  ]\n}\n";
}

export const tally = (rs: RuleResult[]): { pass: number; fail: number; vacuous: number } => ({
  pass: rs.filter((r) => r.pass).length,
  fail: rs.filter((r) => !r.pass).length,
  vacuous: rs.filter((r) => r.vacuous).length,
});
