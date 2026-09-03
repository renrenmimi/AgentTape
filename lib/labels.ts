// What to call a step on screen.
//
// This is a presentation layer and it is deliberately a separate one. A
// tool_result is written by the transcript with `role: "user"`, because that
// is how the API carries it — and calling it "user" in a list of steps is
// accurate about the protocol and wrong about what happened, since no user
// typed it.
//
// So the index keeps `kind`, `rawType` and `role` exactly as the file wrote
// them, and this maps them to task-level names for the list. Nothing here
// changes the data: Record data still shows the real record type and the real
// role, and a filter still matches on them. Two names for one step, both true,
// neither pretending to be the other.

import type { Step, StepKind } from "./format.ts";

/** The task-level name for a kind, with no tool attached. */
export const KIND_NAME: Record<StepKind, string> = {
  "user": "User message",
  "text": "Assistant response",
  "thinking": "Thinking",
  "tool-call": "Tool call",
  "tool-result": "Tool result",
  "system": "System record",
  "attachment": "Attachment",
  "meta": "Bookkeeping record",
};

/** The short form, for a chip or a legend. */
export const KIND_SHORT: Record<StepKind, string> = {
  "user": "User",
  "text": "Response",
  "thinking": "Thinking",
  "tool-call": "Tool call",
  "tool-result": "Tool result",
  "system": "System",
  "attachment": "Attachment",
  "meta": "Bookkeeping",
};

/**
 * What a step is called in the list: the kind, and the tool where there is one.
 *
 * A compaction is named for what it is rather than for the record type that
 * carried it, because "System record" is what the file says and "Context
 * compaction" is what happened.
 *
 * `tool` is passed in because a tool_result does not carry the name of the
 * tool it answers — the name is on the call. A row reading "Tool result" with
 * no name, next to a row reading "Tool call · Edit", makes the reader do the
 * pairing themselves. The caller resolves the name through the pair map and
 * hands it here; nothing in the index is changed to do it.
 */
export function stepLabel(s: Step, tool?: string): string {
  if (s.compact) return "Context compaction";
  const base = KIND_NAME[s.kind];
  const name = tool ?? s.tool;
  return name ? `${base} · ${name}` : base;
}

/** The same, without the tool — used where the tool is shown separately. */
export const stepKindLabel = (s: Step): string =>
  s.compact ? "Context compaction" : KIND_NAME[s.kind];

/**
 * How the record described itself, for the places that show the real thing.
 * Never used as the list label: this is the file's vocabulary, not the user's.
 */
export function rawDescriptor(s: Step): string {
  const bits = [s.rawType];
  if (s.role) bits.push(`role ${s.role}`);
  if (s.bi >= 0) bits.push(`block ${s.bi}`);
  return bits.join(" · ");
}
