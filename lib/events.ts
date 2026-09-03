// What happened in this session that is worth looking at, as an index.
//
// The overview needs a short list of places to go. The temptation is to write
// a paragraph about what the run was trying to do and where it went wrong,
// which would be a guess dressed as a finding — the transcript records what
// was said and done, not what anybody meant.
//
// So this is an index, not a summary. Every entry is a fact the parser already
// established (a result carried an error flag; context rose by this much
// between these two steps; the writer recorded a compaction) plus the step to
// go and look at. Nothing here ranks causes, and nothing here says a run
// succeeded: the absence of a recorded failure is reported as the absence of a
// recorded failure.
//
// The ordering is fixed so that two people looking at the same file see the
// same list in the same order.

import type { Step, Tape } from "./format.ts";
import type { Summary } from "./summary.ts";
import { fmtDuration, fmtInt, fmtTokens } from "./summary.ts";
import { findDelegations } from "./subagents.ts";

export type EventKind =
  | "tool-failure"
  | "unanswered-call"
  | "context-jump"
  | "compaction"
  | "delegation"
  | "idle-gap";

/** Which subview of the replay answers this event. */
export type EventTarget = "details" | "context";

export type KeyEvent = {
  kind: EventKind;
  /** Global step index to select. */
  step: number;
  /** Short label. Never generated prose — a fixed phrase plus indexed values. */
  title: string;
  /** One line of measured detail, or "" when there is nothing measured to add. */
  detail: string;
  /** Where the evidence for this event lives. */
  target: EventTarget;
  /**
   * Severity, and only severity.
   *
   * Six kinds and six hues would make this list the colour wall it is
   * deliberately not. Colour says how much it matters; the icon beside it says
   * what kind of thing it is, and the title says both in words. Four tones,
   * six silhouettes.
   */
  tone: "error" | "warning" | "info" | "neutral";
};

/**
 * Severity order. Deliberately a constant rather than a heuristic: a list that
 * reorders itself according to what it thinks matters most is a list that
 * cannot be compared between two runs.
 */
const ORDER: EventKind[] = [
  "tool-failure", "unanswered-call", "context-jump", "compaction", "delegation", "idle-gap",
];

const rank = (k: EventKind) => ORDER.indexOf(k);

/** A gap has to be this long before it is worth a row of its own. */
export const NOTABLE_GAP_MS = 300_000;

export function keyEvents(tape: Tape, summary: Summary, pairs: Map<number, number>): KeyEvent[] {
  const steps = tape.steps;
  const byIndex = new Map<number, Step>();
  for (const s of steps) byIndex.set(s.i, s);
  const out: KeyEvent[] = [];

  // Failures. The error flag rides on the result; the tool name rides on the
  // call it answers, so a failure with no name attached is looked up rather
  // than reported as "(unnamed)".
  for (const s of steps) {
    if (!s.err) continue;
    const mate = pairs.get(s.i);
    const tool = s.tool || (mate !== undefined ? byIndex.get(mate)?.tool ?? "" : "");
    out.push({
      kind: "tool-failure",
      step: s.i,
      title: tool ? `Tool call failed · ${tool}` : "A step failed",
      detail: s.errWhy || "the record carries an error flag with no reason",
      target: "details",
      tone: "error",
    });
  }

  // A call with no result is a different fact from a call that failed, and the
  // run may simply have been cut off mid-flight.
  for (const s of steps) {
    if (s.kind !== "tool-call" || pairs.has(s.i)) continue;
    out.push({
      kind: "unanswered-call",
      step: s.i,
      title: `No result recorded · ${s.tool || "unnamed tool"}`,
      detail: "the call is in the file and nothing answers it",
      target: "details",
      tone: "warning",
    });
  }

  // The biggest step-to-step rise in context. "Observed" is doing real work in
  // that name: context is one number per turn, so this is the largest increase
  // the file records, not necessarily the largest thing that was added.
  if (summary.jumpBy > 0 && summary.jumpAt > 0) {
    out.push({
      kind: "context-jump",
      step: summary.jumpAt,
      title: `Largest observed context increase · +${fmtTokens(summary.jumpBy)}`,
      detail: `context reached ${fmtTokens(byIndex.get(summary.jumpAt)?.ctx ?? 0)} tokens here`,
      target: "context",
      tone: "warning",
    });
  }

  for (const i of summary.compactAt) {
    const s = byIndex.get(i);
    const c = s?.compact;
    out.push({
      kind: "compaction",
      step: i,
      title: "Context compaction",
      detail: c
        ? `${fmtTokens(c.pre)} → ${fmtTokens(c.post)}, ${fmtTokens(c.dropped)} dropped` +
          (c.trigger ? ` · trigger ${c.trigger}` : "")
        : "the writer recorded a compact boundary here",
      target: "context",
      tone: "warning",
    });
  }

  for (const d of findDelegations(steps, pairs)) {
    out.push({
      kind: "delegation",
      step: d.step,
      title: "Work delegated to a subagent",
      detail: d.run
        ? `${fmtInt(d.run.steps)} steps and ${fmtInt(d.run.toolCalls)} tool calls, loaded from beside this session`
        : "this delegated run is not included in the file",
      target: "details",
      tone: "info",
    });
  }

  if (summary.longestGapMs >= NOTABLE_GAP_MS && summary.longestGapAt > 0) {
    out.push({
      kind: "idle-gap",
      step: summary.longestGapAt,
      title: `Longest gap between records · ${fmtDuration(summary.longestGapMs)}`,
      detail: "nothing was written to the transcript across this gap",
      target: "context",
      tone: "neutral",
    });
  }

  return out.sort((a, b) => rank(a.kind) - rank(b.kind) || a.step - b.step);
}

/**
 * The short list, with one entry from every kind that occurred.
 *
 * Taking the first N of a sorted list means twelve failures bury the single
 * compaction, and the compaction is the thing somebody has not seen. So each
 * kind gets its leader first, in severity order, and only then is the rest of
 * the space filled — which keeps the list short without hiding a whole class
 * of event behind a scrollbar.
 */
export function leadEvents(all: KeyEvent[], limit = 6): KeyEvent[] {
  const seen = new Set<EventKind>();
  const lead: KeyEvent[] = [];
  for (const e of all) {
    if (seen.has(e.kind)) continue;
    seen.add(e.kind);
    lead.push(e);
  }
  const picked = new Set(lead);
  const rest = all.filter((e) => !picked.has(e));
  return [...lead, ...rest].slice(0, limit).sort((a, b) => rank(a.kind) - rank(b.kind) || a.step - b.step);
}

export const countByKind = (all: KeyEvent[]): Map<EventKind, number> => {
  const n = new Map<EventKind, number>();
  for (const e of all) n.set(e.kind, (n.get(e.kind) ?? 0) + 1);
  return n;
};

/**
 * Facts about how complete the record is.
 *
 * Everything the overview cannot show has a reason, and every reason is one of
 * these. They are reported as their own state rather than folded into a green
 * tick, because "no failures recorded" and "no failures recorded and a quarter
 * of the run is in a file you did not open" are different sentences.
 */
export type RecordNote = {
  kind: "redacted" | "bad-lines" | "no-usage" | "no-timestamps" | "delegated-missing";
  text: string;
};

export function recordNotes(
  tape: Tape,
  summary: Summary,
  pairs: Map<number, number>,
): RecordNote[] {
  const notes: RecordNote[] = [];

  if (tape.meta.redacted) {
    notes.push({
      kind: "redacted",
      text: "This is a redacted tape: it carries structure and counts, and no message text.",
    });
  }
  if (tape.meta.badLines > 0) {
    notes.push({
      kind: "bad-lines",
      text: `${fmtInt(tape.meta.badLines)} of ${fmtInt(tape.meta.lines)} lines could not be read ` +
        "and are not counted anywhere on this page.",
    });
  }
  if (!summary.input && !summary.output && !summary.cacheRead && !summary.peakCtx) {
    notes.push({
      kind: "no-usage",
      text: "No record in this file carries token usage, so context and token figures are unknown " +
        "rather than zero.",
    });
  }
  if (!summary.firstT && !summary.lastT) {
    notes.push({
      kind: "no-timestamps",
      text: "No record in this file carries a timestamp, so durations cannot be measured.",
    });
  }

  const dels = findDelegations(tape.steps, pairs);
  const missing = dels.filter((d) => !d.run).length;
  if (missing > 0) {
    notes.push({
      kind: "delegated-missing",
      text: `${fmtInt(missing)} delegated run${missing === 1 ? " is" : "s are"} not included in ` +
        "this file. What happened inside is not on this page.",
    });
  }

  return notes;
}

/**
 * One factual line about the run, built from counts and nothing else.
 *
 * It used to read "31 steps · 9 tool calls · 2 tool failures", which is the
 * three figures directly above it, in words. A caption that restates the thing
 * it captions is furniture. This carries what the figures cannot: how long,
 * how much of that was work, how many messages the array ended up with, and
 * the structural events that have no number of their own.
 *
 * No adjectives and no conclusion about whether the work went well — every
 * clause is a figure the index produced.
 */
export function factLine(summary: Summary): string {
  const parts: string[] = [];

  parts.push(`${fmtInt(summary.turns)} message${summary.turns === 1 ? "" : "s"} in the array`);

  if (summary.wallMs > 0) {
    parts.push(
      summary.activeMs > 0 && summary.activeMs < summary.wallMs
        ? `${fmtDuration(summary.wallMs)} wall clock, ${fmtDuration(summary.activeMs)} active`
        : `${fmtDuration(summary.wallMs)} wall clock`,
    );
  }

  if (summary.compactAt.length) {
    parts.push(`${fmtInt(summary.compactAt.length)} compaction` +
      (summary.compactAt.length === 1 ? "" : "s"));
  }

  if (summary.peakCtx > 0) parts.push(`${fmtTokens(summary.peakCtx)} peak context`);
  if (summary.models.length === 1) parts.push(summary.models[0]);
  else if (summary.models.length > 1) parts.push(`${fmtInt(summary.models.length)} models`);

  return parts.join(" · ");
}
