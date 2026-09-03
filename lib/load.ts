// Reading a transcript without ever holding it.
//
// The file arrives as a Blob (a dropped File, or a Response body from the
// local helper). It is walked one megabyte at a time: each chunk is scanned
// for newline *bytes*, which gives exact byte offsets, and each line is
// decoded on its own. Nothing but the index survives the walk.
//
// Bodies come back later through `body(i)`, which slices the same Blob at the
// offset the index recorded. A run of fixture C keeps ~35 MB of index in
// memory and leaves 76 MB of transcript on disk where it belongs.

import { bodyOf, createIndexer, finishIndex, pushLine } from "./parser.ts";
import { RAW_RECORD_LIMIT, type RawRecord, type Step, type StepBody, type Tape, type TapeMeta }
  from "./format.ts";

const CHUNK = 1 << 20;
const NL = 10;

export type LoadProgress = {
  bytes: number;
  total: number;
  lines: number;
  phase: "reading" | "indexing" | "done";
};

const decoder = new TextDecoder("utf-8", { fatal: false });
const EMPTY = new Uint8Array(0);

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Index a newline-delimited transcript held in a Blob.
 *
 * `onProgress` is called once per chunk. The awaits between chunks are real
 * yields, so a 76 MB file paints a progress bar instead of freezing the tab.
 */
export async function loadJsonlBlob(
  blob: Blob,
  label: string,
  onProgress?: (p: LoadProgress) => void,
  signal?: { aborted: boolean },
): Promise<Tape> {
  const ix = createIndexer(label);
  const total = blob.size;
  let carry: Uint8Array = new Uint8Array(0);
  let lineStart = 0; // absolute byte offset of the line currently being built
  let read = 0;

  while (read < total) {
    if (signal?.aborted) throw new Error("cancelled");
    const end = Math.min(read + CHUNK, total);
    const buf = new Uint8Array(await blob.slice(read, end).arrayBuffer());
    read = end;

    // Walk the chunk's newlines. `base` is the absolute offset of buf[0].
    const base = end - buf.length;
    let from = 0;
    for (let k = 0; k < buf.length; k++) {
      if (buf[k] !== NL) continue;
      const slice = buf.subarray(from, k);
      const bytes = carry.length ? concat(carry, slice) : slice;
      pushLine(ix, decoder.decode(bytes), lineStart, bytes.length);
      carry = EMPTY;
      from = k + 1;
      lineStart = base + from;
    }
    const tail = buf.subarray(from);
    if (tail.length) {
      // Copy rather than keep a view: `buf` is a whole megabyte and holding a
      // view of it would pin the chunk until the next newline turns up.
      const kept = new Uint8Array(tail.length);
      kept.set(tail);
      carry = carry.length ? concat(carry, kept) : kept;
    }

    onProgress?.({ bytes: read, total, lines: ix.meta.lines, phase: "reading" });
  }

  if (carry.length) pushLine(ix, decoder.decode(carry), lineStart, carry.length);

  const { meta, steps, entries } = finishIndex(ix);
  meta.bytes = total;
  onProgress?.({ bytes: total, total, lines: meta.lines, phase: "done" });

  return {
    meta, steps, entries,
    body: makeBlobReader(blob, steps),
    raw: makeRawReader(blob, steps),
  };
}

/**
 * Lazy body reader with a tiny cache. The cache holds eight entries because
 * the detail panel asks for the same two or three steps repeatedly while the
 * playhead sits still, and one of them can be 1.34 MB.
 */
function makeBlobReader(blob: Blob, steps: Step[]): (i: number) => Promise<StepBody> {
  const cache = new Map<number, StepBody>();
  const LIMIT = 8;
  return async (i: number) => {
    const hit = cache.get(i);
    if (hit) return hit;
    const s = steps[i];
    const empty: StepBody = { text: null, input: undefined, parts: [], placeholder: false, chars: 0 };
    if (!s) return empty;
    const bytes = new Uint8Array(await blob.slice(s.off, s.off + s.len).arrayBuffer());
    let out = empty;
    try {
      out = bodyOf(JSON.parse(decoder.decode(bytes)), s.bi);
    } catch {
      out = { ...empty, text: null, chars: 0 };
    }
    if (cache.size >= LIMIT) cache.delete(cache.keys().next().value as number);
    cache.set(i, out);
    return out;
  };
}

/**
 * The line itself, read back from the same Blob at the same offsets.
 *
 * Bounded on the way out rather than on the way in: the slice is one line,
 * which is what `body()` already reads, but a 1.34 MB line rendered whole is a
 * stalled tab. The count of what was cut travels with the text so the panel can
 * say so instead of ending mid-token.
 */
function makeRawReader(blob: Blob, steps: Step[]): (i: number) => Promise<RawRecord | null> {
  return async (i: number) => {
    const s = steps[i];
    if (!s) return null;
    const bytes = new Uint8Array(await blob.slice(s.off, s.off + s.len).arrayBuffer());
    const text = decoder.decode(bytes);
    return {
      text: text.slice(0, RAW_RECORD_LIMIT),
      chars: text.length,
      bytes: s.len,
      line: s.line,
      truncated: text.length > RAW_RECORD_LIMIT,
    };
  };
}

/** Same walk, but over a string. Used by verify.mjs and by small pasted tapes. */
export function loadJsonlString(text: string, label: string): Tape {
  const ix = createIndexer(label);
  const enc = new TextEncoder();
  let off = 0;
  const lines = text.split("\n");
  for (let k = 0; k < lines.length; k++) {
    const len = enc.encode(lines[k]).length;
    if (k < lines.length - 1 || lines[k].length) pushLine(ix, lines[k], off, len);
    off += len + 1;
  }
  const { meta, steps, entries } = finishIndex(ix);
  meta.bytes = enc.encode(text).length;

  const bodies = new Map<number, StepBody>();
  for (const s of steps) {
    try {
      bodies.set(s.i, bodyOf(JSON.parse(lines[s.line - 1]), s.bi));
    } catch {
      /* a line that would not index will not read either */
    }
  }
  const empty: StepBody = { text: null, input: undefined, parts: [], placeholder: false, chars: 0 };
  return {
    meta, steps, entries,
    body: async (i) => bodies.get(i) ?? empty,
    raw: async (i) => {
      const s = steps[i];
      const text = s ? lines[s.line - 1] ?? "" : "";
      if (!s) return null;
      return {
        text: text.slice(0, RAW_RECORD_LIMIT),
        chars: text.length,
        bytes: s.len,
        line: s.line,
        truncated: text.length > RAW_RECORD_LIMIT,
      };
    },
  };
}

export type { TapeMeta };
