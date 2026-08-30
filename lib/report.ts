// A session, written down so it can be pasted somewhere.
//
// The smallest thing in this repository and probably the most used: it is how
// you tell a colleague what happened without sending them a transcript.
//
// The safety property is structural, not editorial. This module is handed the
// index and a small number of derived figures, and every line it writes is a
// count, a duration, a token total, a step number, or a name from the writer's
// own vocabulary. It never reads a body and never reaches for a preview, so the
// output is safe to paste anywhere by construction rather than by care —
// verify.mjs proves it by generating a report from a transcript in which every
// text field is the same marker and asserting no marker comes out.

import type { Step, Tape } from "./format.ts";
import type { RuleResult } from "./assert.ts";
import type { Delegation } from "./subagents.ts";
import { contextProfile } from "./stats.ts";
import {
  fmtBytes, fmtDuration, fmtInt, fmtTokens, type JumpTrace, type Summary,
} from "./summary.ts";

const BLOCKS = "▁▂▃▄▅▆▇█";

/** The context profile as eight levels of block, so it survives a paste. */
export function sparkline(values: number[]): string {
  const top = Math.max(...values, 0);
  if (!top) return "";
  return values
    .map((v) => BLOCKS[Math.min(BLOCKS.length - 1, Math.round((v / top) * (BLOCKS.length - 1)))])
    .join("");
}

const row = (k: string, v: string) => `| ${k} | ${v} |`;

function failures(
  steps: Step[],
  pairs: Map<number, number>,
  shownIndex: (i: number) => number,
  limit = 20,
): string[] {
  const byIndex = new Map<number, Step>();
  for (const s of steps) byIndex.set(s.i, s);
  const bad = steps.filter((s) => s.err);
  const out = ["| step | kind | tool | why |", "| --- | --- | --- | --- |"];
  for (const s of bad.slice(0, limit)) {
    // The flag is on the result; the name is on the call it answers.
    const mate = pairs.get(s.i);
    const tool = s.tool || (mate !== undefined ? byIndex.get(mate)?.tool ?? "" : "");
    out.push(`| ${fmtInt(shownIndex(s.i) || s.i + 1)} | ${s.kind} | ${tool ? "`" + tool + "`" : "—"} | ${s.errWhy || "error"} |`);
  }
  if (bad.length > limit) out.push(`| … | | | ${fmtInt(bad.length - limit)} more |`);
  return out;
}

export type ReportInput = {
  tape: Tape;
  summary: Summary;
  trace: JumpTrace | null;
  delegations: Delegation[];
  assertions: RuleResult[];
  /** Pairs a failed result back to the call that names the tool. */
  pairs: Map<number, number>;
  /** How a step is numbered on screen, so the report agrees with the app. */
  shownIndex: (globalIndex: number) => number;
};

export function markdownReport({
  tape, summary: s, trace, delegations, assertions, pairs, shownIndex,
}: ReportInput): string {
  const L: string[] = [];
  const cached = s.cacheRead ? ` (${fmtTokens(s.cacheRead)} from cache)` : "";

  L.push("## Session");
  L.push("");
  L.push("| | |");
  L.push("| --- | --- |");
  L.push(row("steps", fmtInt(s.conversationSteps) +
    (s.metaSteps ? ` (+${fmtInt(s.metaSteps)} bookkeeping)` : "")));
  L.push(row("turns", fmtInt(s.turns)));
  L.push(row("tool calls", fmtInt(s.toolCalls)));
  L.push(row("errors", fmtInt(s.errors)));
  L.push(row("wall clock", fmtDuration(s.wallMs)));
  L.push(row("active", fmtDuration(s.activeMs) +
    (s.idleGaps ? ` · ${fmtInt(s.idleGaps)} gaps over two minutes` : "")));
  L.push(row("tokens in", fmtTokens(s.input + s.cacheRead + s.cacheCreate) + cached));
  L.push(row("tokens out", fmtTokens(s.output)));
  L.push(row("peak context", fmtTokens(s.peakCtx)));
  L.push(row("models", s.models.length ? s.models.join(", ") : "—"));
  L.push(row("source", `${fmtBytes(tape.meta.bytes)}, ${fmtInt(tape.meta.lines)} lines` +
    (tape.meta.redacted ? " (redacted tape)" : "")));
  if (tape.meta.versions.length) L.push(row("writer", tape.meta.versions.join(", ")));
  L.push("");

  if (s.tools.length) {
    L.push("## Tools");
    L.push("");
    L.push("| tool | calls | failed |");
    L.push("| --- | --- | --- |");
    for (const t of s.tools) {
      L.push(`| \`${t.name}\` | ${fmtInt(t.count)} | ${t.errors ? fmtInt(t.errors) : "—"} |`);
    }
    L.push("");
  }

  if (s.errors) {
    L.push("## Failures");
    L.push("");
    L.push(...failures(tape.steps, pairs, shownIndex));
    L.push("");
  }

  L.push("## Context");
  L.push("");
  const spark = sparkline(contextProfile(tape.steps));
  if (spark) L.push(`\`${spark}\`  peak ${fmtTokens(s.peakCtx)}`);
  if (s.jumpBy > 0) {
    let line = `Largest single-step increase: **+${fmtTokens(s.jumpBy)}** at step ` +
      `${fmtInt(shownIndex(s.jumpAt) || s.jumpAt + 1)}.`;
    if (trace && !trace.unknown) {
      if (trace.fellAt < 0) {
        line += ` Still in the array ${fmtInt(trace.stepsSince)} steps later; ` +
          `${fmtInt(trace.turnsSince)} turns re-sent it.`;
      } else if (trace.fellToCompaction) {
        line += ` Dropped at the compaction ${fmtInt(trace.stepsSince)} steps later.`;
      } else {
        line += ` Context fell below that level ${fmtInt(trace.stepsSince)} steps later; ` +
          "nothing in the transcript says why.";
      }
    }
    L.push("");
    L.push(line);
  }
  if (s.compactAt.length) {
    L.push("");
    L.push(`Compacted ${fmtInt(s.compactAt.length)} ` +
      `time${s.compactAt.length === 1 ? "" : "s"}, at step` +
      `${s.compactAt.length === 1 ? "" : "s"} ` +
      s.compactAt.map((i) => fmtInt(shownIndex(i) || i + 1)).join(", ") + ".");
  }
  L.push("");

  if (delegations.length) {
    const loaded = delegations.filter((d) => d.run);
    L.push("## Delegated work");
    L.push("");
    L.push(`${fmtInt(delegations.length)} delegation${delegations.length === 1 ? "" : "s"}. ` +
      (loaded.length
        ? `${fmtInt(loaded.length)} of them loaded, adding ` +
          `${fmtInt(loaded.reduce((n, d) => n + (d.run?.steps ?? 0), 0))} steps and ` +
          `${fmtInt(loaded.reduce((n, d) => n + (d.run?.toolCalls ?? 0), 0))} tool calls ` +
          "that the main transcript does not contain."
        : "None of those runs is loaded, so the work they did is not in this report."));
    if (loaded.length) {
      L.push("");
      L.push("| at step | steps | tool calls | failed |");
      L.push("| --- | --- | --- | --- |");
      for (const d of loaded) {
        L.push(`| ${fmtInt(shownIndex(d.step) || d.step + 1)} | ${fmtInt(d.run?.steps ?? 0)} | ` +
          `${fmtInt(d.run?.toolCalls ?? 0)} | ${d.run?.errors ? fmtInt(d.run.errors) : "—"} |`);
      }
    }
    L.push("");
  }

  if (assertions.length) {
    const failed = assertions.filter((r) => !r.pass);
    L.push("## Assertions");
    L.push("");
    L.push(`${fmtInt(assertions.length - failed.length)} of ${fmtInt(assertions.length)} held.`);
    if (failed.length) {
      L.push("");
      L.push("| rule | why | step |");
      L.push("| --- | --- | --- |");
      for (const r of failed) {
        L.push(`| ${r.label} | ${r.detail} | ` +
          `${r.at >= 0 ? fmtInt(shownIndex(r.at) || r.at + 1) : "—"} |`);
      }
    }
    L.push("");
  }

  L.push("---");
  L.push("");
  // Attribution without a URL, deliberately. verify.mjs asserts that no shipped
  // file names a host other than 127.0.0.1, which is what makes "this app
  // contacts nothing" checkable rather than claimed. A convenience link is not
  // worth loosening that for — and loosening a check to accommodate a nicety is
  // exactly how a real identifier got committed last round.
  L.push("Structure and counts only — no message text. Produced by AgentTape.");
  L.push("");
  return L.join("\n");
}
