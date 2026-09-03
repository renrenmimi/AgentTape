// What one session looks like from the outside.
//
// This is the record the cross-session overview is built from, and the record
// that gets cached on disk. Its defining property is negative: **there is no
// field here that can hold a sentence.** Every value is a count, a duration, a
// timestamp, a token total, or a name drawn from a vocabulary the writer
// chose — tool names, model ids, the project directory, the session id.
//
// That is what makes it safe to write to a cache file and safe to put on a
// screen. A session title, a first message, a subagent's description: all of
// them are written from a prompt, and none of them is here. verify.mjs takes a
// transcript whose every text field is a distinctive marker, builds one of
// these from it, and asserts that no marker survives.

import type { Entry, Step, TapeMeta } from "./format.ts";
import { findDelegations } from "./subagents.ts";
import { summarise } from "./summary.ts";

/** How many points the context sparkline gets. Enough to show a plateau or a
 *  cliff, small enough that four hundred of them are still a small file. */
export const PROFILE_BUCKETS = 24;

/** A subagent transcript sitting beside a session. Ids and sizes only — the
 *  sidecar's `description` is written from a prompt and is never read. */
export type SubagentRef = {
  id: string;
  bytes: number;
  /** The parent tool_use id, from the sidecar. Empty when there is none. */
  toolUseId: string;
  agentType: string;
};

export type SessionStats = {
  project: string;
  session: string;
  bytes: number;
  mtime: number;
  lines: number;
  badLines: number;
  steps: number;
  conversationSteps: number;
  metaSteps: number;
  turns: number;
  toolCalls: number;
  tools: Record<string, number>;
  toolErrors: Record<string, number>;
  errors: number;
  firstT: number;
  lastT: number;
  wallMs: number;
  activeMs: number;
  idleGaps: number;
  longestGapMs: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
  peakCtx: number;
  jumpBy: number;
  compactions: number;
  delegations: number;
  models: string[];
  versions: string[];
  ctxProfile: number[];
  /**
   * Attached after the index is built and deliberately never cached: these
   * files appear and change without the session's own size or mtime moving.
   */
  agents?: SubagentRef[];
};

/** Peak context per bucket, carried forward so a bucket with no assistant turn
 *  in it does not read as a drop to zero. */
export function contextProfile(steps: Step[], buckets = PROFILE_BUCKETS): number[] {
  const out = new Array<number>(buckets).fill(0);
  if (!steps.length) return out;
  for (let i = 0; i < steps.length; i++) {
    const b = Math.min(buckets - 1, Math.floor((i * buckets) / steps.length));
    if (steps[i].ctx > out[b]) out[b] = steps[i].ctx;
  }
  for (let b = 1; b < buckets; b++) if (!out[b]) out[b] = out[b - 1];
  return out;
}

export function sessionStats(
  id: { project: string; session: string; bytes: number; mtime: number },
  meta: TapeMeta,
  steps: Step[],
  entries: Entry[],
  pairs: Map<number, number>,
): SessionStats {
  // summarise() reads the index only; the readers are here to satisfy the type.
  const sum = summarise({
    meta, steps, entries,
    body: async () => ({ text: null, input: undefined, parts: [], placeholder: true, chars: 0 }),
    raw: async () => null,
  });
  const dels = findDelegations(steps, pairs);

  const tools: Record<string, number> = {};
  const toolErrors: Record<string, number> = {};
  for (const t of sum.tools) {
    tools[t.name] = t.count;
    if (t.errors) toolErrors[t.name] = t.errors;
  }

  return {
    project: id.project,
    session: id.session,
    bytes: id.bytes,
    mtime: id.mtime,
    lines: meta.lines,
    badLines: meta.badLines,
    steps: steps.length,
    conversationSteps: sum.conversationSteps,
    metaSteps: sum.metaSteps,
    turns: sum.turns,
    toolCalls: sum.toolCalls,
    tools,
    toolErrors,
    errors: sum.errors,
    firstT: sum.firstT,
    lastT: sum.lastT,
    wallMs: sum.wallMs,
    activeMs: sum.activeMs,
    idleGaps: sum.idleGaps,
    longestGapMs: sum.longestGapMs,
    input: sum.input,
    output: sum.output,
    cacheRead: sum.cacheRead,
    cacheCreate: sum.cacheCreate,
    peakCtx: sum.peakCtx,
    jumpBy: sum.jumpBy,
    compactions: sum.compactAt.length,
    delegations: dels.length,
    models: sum.models,
    versions: meta.versions,
    ctxProfile: contextProfile(steps),
  };
}
