// Two runs of the same task, and where they stopped agreeing.
//
// The whole problem is alignment. Two runs of the same task differ in almost
// every word — a model does not phrase anything twice — so comparing text
// answers "they diverged at step 2" every single time, which is no answer.
//
// So the comparison never looks at text. Each run is reduced to its **spine**:
// the ordered list of tools it called, and nothing else. Tool names are chosen
// from a fixed vocabulary rather than generated, so two runs doing the same
// work produce the same spine even when they describe it completely
// differently. The divergence is the first position where those lists differ.
//
// The limit that comes with that rule is stated rather than hidden: alignment
// is positional. One extra step early in a run shifts everything after it, and
// the divergence is then reported at that shift — which is true, but leaves the
// rest unaligned. `realign` exists to say so out loud when it happens.

import type { Step } from "./format.ts";

export type SpineEvent = {
  /** Tool name — the only thing compared. */
  tool: string;
  /** Global step index in that run. */
  step: number;
  /** Payload characters, reported but never compared. */
  chars: number;
  err: boolean;
  t: number;
};

/** The tools a run called, in order. Everything said in between is dropped. */
export function buildSpine(steps: Step[]): SpineEvent[] {
  const out: SpineEvent[] = [];
  for (const s of steps) {
    if (s.kind !== "tool-call") continue;
    out.push({ tool: s.tool || "(unnamed)", step: s.i, chars: s.chars, err: s.err, t: s.t });
  }
  return out;
}

export type CompareVerdict =
  | "identical"    // same tools, same order, all the way
  | "diverged"     // a position where both ran, and called different tools
  | "a-ended"      // they agreed until A stopped calling tools
  | "b-ended"
  | "no-spine";    // at least one run never called a tool

export type Comparison = {
  verdict: CompareVerdict;
  /** Positions that agreed before the divergence. */
  agreed: number;
  /** Index into both spines where they part, or -1. */
  at: number;
  a: SpineEvent | null;
  b: SpineEvent | null;
  lenA: number;
  lenB: number;
  /**
   * When one run has an extra step the other does not, the rest of the spines
   * still match at an offset. This reports that offset and which side carries
   * the extra calls, so "everything after here is misaligned" can be said
   * rather than implied. -1 when no offset within the probe window works.
   */
  realignOffset: number;
  realignSide: "a" | "b" | "";
};

const CONFIRM = 4;   // positions to look at before an offset is believed
const MIN_CONFIRM = 2; // …and the fewest that will do, near the end of a spine
const MAX_SHIFT = 8; // how far to look for a realignment

/**
 * Do the two spines run in step from these positions?
 *
 * Counting stops as soon as either spine runs out — the overlap is all there is
 * to compare, and one run simply being longer is not disagreement. `need`
 * decides whether the overlap was long enough to believe: two matches for a
 * shift, which has to overcome the suspicion of a coincidental tool name, and
 * one for staying in place, which does not.
 */
function matchesAt(
  a: SpineEvent[], b: SpineEvent[], ai: number, bi: number, want: number,
  need = MIN_CONFIRM,
): boolean {
  let k = 0;
  while (k < want) {
    const x = a[ai + k];
    const y = b[bi + k];
    if (!x || !y) break;
    if (x.tool !== y.tool) return false;
    k++;
  }
  return k >= need;
}

/** Where the two runs stop agreeing, comparing tool sequences and nothing else. */
export function compareSpines(a: SpineEvent[], b: SpineEvent[]): Comparison {
  const base: Comparison = {
    verdict: "identical", agreed: 0, at: -1, a: null, b: null,
    lenA: a.length, lenB: b.length, realignOffset: -1, realignSide: "",
  };

  if (!a.length || !b.length) return { ...base, verdict: "no-spine" };

  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i].tool === b[i].tool) i++;

  if (i === n) {
    if (a.length === b.length) return { ...base, agreed: n };
    // One kept going after the other stopped calling tools.
    return {
      ...base,
      verdict: a.length < b.length ? "a-ended" : "b-ended",
      agreed: n,
      at: n,
      a: a[n] ?? null,
      b: b[n] ?? null,
    };
  }

  // Does the rest line up again, and how?
  //
  // Offset zero first, because it is the common case and the one that looked
  // worst when it was missing: the two runs made the same call in the same
  // place and only chose a different tool for it. Reporting that as "a
  // different path from here on" is wrong and alarming.
  let realignOffset = -1;
  let realignSide: "a" | "b" | "" = "";
  const tailA = a.length - i - 1;
  const tailB = b.length - i - 1;
  // Offset zero needs a lower bar than a shift does. A shift has to overcome
  // the suspicion that one matching tool name is a coincidence; staying in
  // place is the null hypothesis, so one match is enough — and two runs that
  // both end here have simply swapped their last call.
  if ((tailA === 0 && tailB === 0) || matchesAt(a, b, i + 1, i + 1, CONFIRM, 1)) {
    realignOffset = 0;
  } else {
    // Otherwise one run has calls the other does not.
    for (let d = 1; d <= MAX_SHIFT && realignOffset < 0; d++) {
      if (matchesAt(a, b, i + d, i, CONFIRM)) { realignOffset = d; realignSide = "a"; }
      else if (matchesAt(a, b, i, i + d, CONFIRM)) { realignOffset = d; realignSide = "b"; }
    }
  }

  return {
    ...base,
    verdict: "diverged",
    agreed: i,
    at: i,
    a: a[i] ?? null,
    b: b[i] ?? null,
    realignOffset,
    realignSide,
  };
}

export function compareRuns(a: Step[], b: Step[]): Comparison {
  return compareSpines(buildSpine(a), buildSpine(b));
}

/** One line of plain English about what the comparison found. */
export function verdictLine(c: Comparison): string {
  const n = (x: number) => x.toLocaleString("en-US");
  switch (c.verdict) {
    case "no-spine":
      return "These runs cannot be aligned: at least one of them never called a tool.";
    case "identical":
      return `Both runs called the same ${n(c.lenA)} tools in the same order. ` +
        "What they said differs, and this comparison does not read what they said.";
    case "a-ended":
      return `They agreed for ${n(c.agreed)} tool calls, then run A stopped and run B kept going ` +
        `for ${n(c.lenB - c.lenA)} more.`;
    case "b-ended":
      return `They agreed for ${n(c.agreed)} tool calls, then run B stopped and run A kept going ` +
        `for ${n(c.lenA - c.lenB)} more.`;
    default:
      return `They agreed for ${n(c.agreed)} tool calls, then took different paths.`;
  }
}

/** The caveat that belongs with a positional alignment, when it applies. */
export function realignLine(c: Comparison): string {
  if (c.verdict !== "diverged") return "";
  if (c.realignOffset < 0) {
    return "The runs do not line up again within eight calls, so everything after this point " +
      "is a different path rather than a shifted one.";
  }
  if (c.realignOffset === 0) {
    const tail = Math.min(c.lenA - c.at - 1, c.lenB - c.at - 1);
    if (tail === 0) return "This is the last tool call in both runs — they swapped it and stopped.";
    return "The calls after this one match again, so the runs swapped a single step rather than " +
      "forking. Only the first divergence is reported — there may be later ones.";
  }
  const side = c.realignSide === "a" ? "A" : "B";
  const k = c.realignOffset;
  return `Run ${side} makes ${k} extra call${k === 1 ? "" : "s"} here and the two line up again ` +
    "afterwards — this is an insertion, not a fork. Alignment is positional, so the comparison " +
    "still reports it as the divergence.";
}
