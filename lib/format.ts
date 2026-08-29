// The shape AgentTape works in, and the vocabulary it uses to talk about a run.
//
// Everything here is derived from docs/format-notes.md, which was written by
// probing real transcripts. Two findings drive the whole model:
//
//   * A transcript line is one *content block*, not one API message. Grouping
//     back up by `message.id` is what reconstructs the messages array.
//   * A quarter of the lines are editor bookkeeping with no timestamp. They
//     are kept as `meta` steps and filtered out of the default view rather
//     than dropped, so nothing about the file is silently invisible.

/** What a step is, as far as the timeline is concerned. Drives tick shape. */
export type StepKind =
  | "user"        // a human turn
  | "text"        // assistant prose
  | "thinking"    // assistant reasoning block
  | "tool-call"   // tool_use
  | "tool-result" // tool_result
  | "system"      // hook output, api error, compact boundary
  | "attachment"  // editor context injected around a turn
  | "meta";       // bookkeeping records and unrecognised types

export const STEP_KINDS: StepKind[] = [
  "user", "text", "thinking", "tool-call", "tool-result",
  "system", "attachment", "meta",
];

/** Kinds that make up the conversation proper — the default timeline view. */
export const CONVERSATION_KINDS = new Set<StepKind>([
  "user", "text", "thinking", "tool-call", "tool-result", "system",
]);

/** Record types that carry no conversation, only editor state. */
export const BOOKKEEPING_TYPES = new Set([
  "custom-title", "ai-title", "last-prompt", "mode", "queue-operation",
  "file-history-snapshot", "file-history-delta", "pr-link", "atis-latch",
]);

export type TokenUse = {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
};

export type CompactInfo = {
  pre: number;
  post: number;
  dropped: number;
  trigger: string;
};

/**
 * One row of the index. Deliberately flat and mostly numeric: fixture C
 * produces ~10.7k of these and they must stay small enough to hold while the
 * 76 MB body they describe stays on disk.
 *
 * `off`/`len` are byte coordinates into the source Blob. `preview` is the only
 * content-bearing field, capped at PREVIEW_MAX characters so the messages
 * panel can render a summary line without touching the file.
 */
export type Step = {
  i: number;
  line: number;
  off: number;
  len: number;
  /** Index of this block inside `message.content`, or -1 for blockless records. */
  bi: number;
  kind: StepKind;
  /** The record's raw `type`, kept verbatim so unknown types stay legible. */
  rawType: string;
  role: "user" | "assistant" | null;
  /** Timestamp as written, or null when the record carries none. */
  ts: number | null;
  /** Timestamp clamped to a running maximum — transcripts step backwards. */
  t: number;
  err: boolean;
  /** Why it failed, as a short fixed label. Never carries transcript text. */
  errWhy: string;
  tool: string;
  toolUseId: string;
  msgId: string;
  model: string;
  usage: TokenUse | null;
  /** input + cache_read at this point, carried forward between assistant turns. */
  ctx: number;
  /** Characters in this block's payload, before any truncation. */
  chars: number;
  preview: string;
  /** Index into Tape.entries — which messages-array row this step landed in. */
  entry: number;
  compact: CompactInfo | null;
};

/** One row of the reconstructed messages array. */
export type Entry = {
  i: number;
  role: "user" | "assistant";
  msgId: string;
  model: string;
  /** Inclusive step range that built this entry. */
  from: number;
  to: number;
  t: number;
  /** Output tokens the model spent producing it (assistant turns only). */
  output: number;
  ctx: number;
  chars: number;
  err: boolean;
};

export type TapeMeta = {
  /** "jsonl" for a parsed transcript, "tape" for a .tape.json. */
  source: "jsonl" | "tape";
  /** True when text bodies were replaced by placeholders. */
  redacted: boolean;
  label: string;
  sessionId: string;
  bytes: number;
  lines: number;
  badLines: number;
  /** Writer versions seen in the file, e.g. ["2.1.219", "2.1.221"]. */
  versions: string[];
};

/**
 * A loaded run. `body(i)` is async because a raw transcript keeps its bodies
 * on disk; a .tape.json resolves them from memory (or to a placeholder).
 */
export type Tape = {
  meta: TapeMeta;
  steps: Step[];
  entries: Entry[];
  body: (i: number) => Promise<StepBody>;
};

/** The full payload of one step, fetched on demand. */
export type StepBody = {
  /** Present for text/thinking/tool-result and string-content user turns. */
  text: string | null;
  /** Present for tool-call. */
  input: unknown;
  /** Non-text parts of a tool_result, described but not decoded. */
  parts: { type: string; chars: number }[];
  /** True when the body was replaced by a placeholder rather than read. */
  placeholder: boolean;
  /** Characters in the original body, even when `text` is truncated or absent. */
  chars: number;
};

export const PREVIEW_MAX = 96;

/** Bodies above this render truncated, with an explicit control to see more. */
export const INLINE_BODY_LIMIT = 2048;

/** How much more each "show more" click reveals. Bounded so 1.3 MB cannot
 *  land in the DOM in one go. */
export const BODY_WINDOW = 65536;

/** A gap longer than this is idle time, not work. */
export const IDLE_GAP_MS = 120_000;

export const emptyUse = (): TokenUse => ({
  input: 0, output: 0, cacheRead: 0, cacheCreate: 0,
});
