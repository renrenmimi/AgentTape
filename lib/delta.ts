// What changed between the previous step and this one.
//
// The timeline and the messages panel both answer "what does the array look
// like now". Neither answers the question you actually have when a run goes
// wrong, which is "what did *this* step put in it, and what did that cost".
// This is that answer, and it is deliberately four lines rather than a second
// messages panel.

import type { Step } from "./format.ts";

export type StepDelta = {
  /** Index of the messages-array entry this step landed in, or -1. */
  entry: number;
  /** True when the step opened a new entry rather than extending the last one. */
  newEntry: boolean;
  role: "user" | "assistant" | null;
  /** Characters this step added to the array. */
  chars: number;
  /** Output tokens the model spent producing it, where the record carries usage. */
  output: number;
  ctxBefore: number;
  ctxAfter: number;
  ctxDelta: number;
  /** Running totals as of this step. */
  entriesSoFar: number;
  charsSoFar: number;
};

/**
 * Prefix sum of characters, built once per tape. Summing from zero on every
 * playhead move would be ten thousand additions a frame for a number that
 * never changes.
 */
export function cumulativeChars(steps: Step[]): Float64Array {
  const out = new Float64Array(steps.length + 1);
  for (let i = 0; i < steps.length; i++) out[i + 1] = out[i] + steps[i].chars;
  return out;
}

export function deltaAt(steps: Step[], cum: Float64Array, i: number): StepDelta | null {
  const s = steps[i];
  if (!s) return null;
  const prev = i > 0 ? steps[i - 1] : null;
  return {
    entry: s.entry,
    // An entry index that differs from the previous step's means a row was
    // appended; the same index means this step added a block to the row that
    // was already there.
    newEntry: s.entry >= 0 && (!prev || prev.entry !== s.entry),
    role: s.role,
    chars: s.chars,
    output: s.usage ? s.usage.output : 0,
    ctxBefore: prev ? prev.ctx : 0,
    ctxAfter: s.ctx,
    ctxDelta: s.ctx - (prev ? prev.ctx : 0),
    entriesSoFar: s.entry + 1,
    charsSoFar: cum[i + 1] ?? 0,
  };
}
