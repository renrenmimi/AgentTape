// Turning a Claude Code transcript into an index.
//
// The contract this file keeps: a line goes in, a handful of numbers comes
// out, and the line itself is forgotten. Nothing here retains a parsed record
// and nothing accumulates the file as a string, because fixture C is 76 MB
// with a single 1.34 MB line in it. Bodies are re-read from byte offsets by
// lib/load.ts when the playhead actually asks for one.
//
// Every field is treated as optional. The transcript writer is Claude Code's
// private format; it changes between releases (three writer versions appear
// inside one of the probe fixtures), so an unrecognised type becomes a generic
// step and a missing key becomes a zero, never an exception.

import {
  BOOKKEEPING_TYPES,
  PREVIEW_MAX,
  type CompactInfo,
  type Entry,
  type Step,
  type StepBody,
  type StepKind,
  type TapeMeta,
  type TokenUse,
} from "./format.ts";

type Rec = Record<string, unknown>;

const isObj = (v: unknown): v is Rec =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) ? v : 0;

/** One line of preview text: whitespace collapsed, hard-capped. */
export function previewOf(s: string, max = PREVIEW_MAX): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : flat.slice(0, max - 1) + "…";
}

/** A readable hint for a tool call, built from its input without dumping it. */
function toolPreview(input: unknown): string {
  if (typeof input === "string") return previewOf(input);
  if (!isObj(input)) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === "string") parts.push(k + ": " + previewOf(v, 48));
    else if (typeof v === "number" || typeof v === "boolean") parts.push(k + ": " + v);
    else if (Array.isArray(v)) parts.push(k + ": [" + v.length + "]");
    else if (isObj(v)) parts.push(k + ": {…}");
    if (parts.join("  ").length >= PREVIEW_MAX) break;
  }
  return previewOf(parts.join("  "));
}

/** Characters in a tool_result payload, and a preview, without decoding images. */
function resultText(content: unknown): { text: string; chars: number; parts: { type: string; chars: number }[] } {
  if (typeof content === "string") return { text: content, chars: content.length, parts: [] };
  if (!Array.isArray(content)) return { text: "", chars: 0, parts: [] };
  let text = "";
  let chars = 0;
  const parts: { type: string; chars: number }[] = [];
  for (const b of content) {
    if (!isObj(b)) continue;
    const t = str(b.type);
    if (t === "text") {
      const s = str(b.text);
      text += (text ? "\n" : "") + s;
      chars += s.length;
      parts.push({ type: "text", chars: s.length });
    } else if (t === "image") {
      // Never touch source.data: it is base64 and can be hundreds of KB.
      const src = isObj(b.source) ? b.source : {};
      parts.push({ type: "image/" + (str(src.media_type) || "?"), chars: str(src.data).length });
    } else {
      parts.push({ type: t || "?", chars: 0 });
    }
  }
  return { text, chars, parts };
}

function usageOf(u: unknown): TokenUse | null {
  if (!isObj(u)) return null;
  return {
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheCreate: num(u.cache_creation_input_tokens),
  };
}

function compactOf(o: Rec): CompactInfo | null {
  const m = o.compactMetadata;
  if (!isObj(m)) return null;
  return {
    pre: num(m.preTokens),
    post: num(m.postTokens),
    dropped: num(m.cumulativeDroppedTokens),
    trigger: str(m.trigger) || "unknown",
  };
}

/**
 * Failure is not one flag. §7 of docs/format-notes.md lists the four signals;
 * the label returned is a fixed string, never anything read out of the file.
 */
function recordError(o: Rec): string {
  if (o.isApiErrorMessage === true) return "api error";
  if (str(o.type) === "system") {
    if (str(o.level) === "error") return "system error";
    if (str(o.subtype) === "api_error") return "api error";
  }
  if (str(o.toolDenialKind)) return "permission denied";
  return "";
}

const BLOCK_KIND: Record<string, StepKind> = {
  text: "text",
  thinking: "thinking",
  tool_use: "tool-call",
  tool_result: "tool-result",
  image: "text",
};

// ---------------------------------------------------------------- indexer

export type Indexer = {
  steps: Step[];
  meta: TapeMeta;
  /** Running maximum of every timestamp seen — transcripts step backwards. */
  clock: number;
  ctx: number;
  versions: Set<string>;
  models: Set<string>;
};

export function createIndexer(label = "session"): Indexer {
  return {
    steps: [],
    meta: {
      source: "jsonl",
      redacted: false,
      label,
      sessionId: "",
      bytes: 0,
      lines: 0,
      badLines: 0,
      versions: [],
    },
    clock: 0,
    ctx: 0,
    versions: new Set(),
    models: new Set(),
  };
}

/**
 * Index one transcript line. `off`/`len` are its byte coordinates in the
 * source; they are the only way the body is ever found again.
 *
 * A line that will not parse increments `badLines` and is otherwise ignored —
 * a live session can be truncated mid-write and that must not abort the file.
 */
export function pushLine(ix: Indexer, line: string, off: number, len: number): void {
  ix.meta.lines += 1;
  ix.meta.bytes = Math.max(ix.meta.bytes, off + len);
  const trimmed = line.trim();
  if (!trimmed) return;

  let o: unknown;
  try {
    o = JSON.parse(trimmed);
  } catch {
    ix.meta.badLines += 1;
    return;
  }
  if (!isObj(o)) {
    ix.meta.badLines += 1;
    return;
  }

  const rawType = str(o.type) || "unknown";
  if (!ix.meta.sessionId && str(o.sessionId)) ix.meta.sessionId = str(o.sessionId);
  if (str(o.version)) ix.versions.add(str(o.version));

  const tsRaw = str(o.timestamp);
  const parsed = tsRaw ? Date.parse(tsRaw) : NaN;
  const ts = Number.isNaN(parsed) ? null : parsed;
  if (ts !== null && ts > ix.clock) ix.clock = ts;
  const t = ix.clock;

  const recErr = recordError(o);
  const compact = compactOf(o);
  const line1 = ix.meta.lines;

  const base = {
    line: line1,
    off,
    len,
    rawType,
    ts,
    t,
    entry: -1,
    compact,
  };

  const emit = (s: Omit<Step, "i" | keyof typeof base> & typeof base): void => {
    const step = s as Step;
    step.i = ix.steps.length;
    ix.steps.push(step);
  };

  const msg = o.message;
  if (isObj(msg)) {
    const role = str(msg.role) === "assistant" ? "assistant" : "user";
    const model = str(msg.model);
    if (model) ix.models.add(model);
    const usage = usageOf(msg.usage);
    if (usage) ix.ctx = usage.input + usage.cacheRead;
    const msgId = str(msg.id);
    const content = msg.content;

    // A string body is the whole turn; the array form is one block per line
    // in practice, but the loop handles any number.
    if (typeof content === "string") {
      emit({
        ...base,
        bi: -1,
        kind: role === "assistant" ? "text" : "user",
        role,
        err: recErr !== "",
        errWhy: recErr,
        tool: "",
        toolUseId: "",
        msgId,
        model,
        usage,
        ctx: ix.ctx,
        chars: content.length,
        preview: previewOf(content),
      });
      return;
    }
    if (!Array.isArray(content)) return;

    for (let bi = 0; bi < content.length; bi++) {
      const b = content[bi];
      if (!isObj(b)) continue;
      const bt = str(b.type);
      // A text block on a user record is a human turn, not assistant prose.
      let kind: StepKind = BLOCK_KIND[bt] ?? "text";
      if (role === "user" && (kind === "text" || kind === "thinking")) kind = "user";
      let tool = "";
      let toolUseId = "";
      let chars = 0;
      let preview = "";
      let err = recErr !== "";
      let errWhy = recErr;

      if (bt === "tool_use") {
        tool = str(b.name);
        toolUseId = str(b.id);
        const enc = JSON.stringify(b.input);
        chars = enc ? enc.length : 0;
        preview = toolPreview(b.input);
      } else if (bt === "tool_result") {
        toolUseId = str(b.tool_use_id);
        const r = resultText(b.content);
        chars = r.chars;
        preview = r.text ? previewOf(r.text) : r.parts.map((p) => p.type).join(", ");
        if (b.is_error === true) {
          err = true;
          errWhy = "tool reported an error";
        }
      } else if (bt === "thinking") {
        chars = str(b.thinking).length;
        preview = previewOf(str(b.thinking));
      } else if (bt === "text") {
        chars = str(b.text).length;
        preview = previewOf(str(b.text));
      } else if (bt === "image") {
        const src = isObj(b.source) ? b.source : {};
        chars = str(src.data).length;
        preview = "image " + (str(src.media_type) || "unknown");
      } else {
        kind = role === "assistant" ? "text" : "user";
        preview = bt ? bt + " block" : "unrecognised block";
      }

      emit({
        ...base,
        bi,
        kind,
        role,
        err,
        errWhy,
        tool,
        toolUseId,
        msgId,
        model,
        usage: bi === 0 ? usage : null,
        ctx: ix.ctx,
        chars,
        preview,
      });
    }
    return;
  }

  // Blockless records: system output, editor attachments, bookkeeping.
  let kind: StepKind = "meta";
  let preview = "";
  let chars = 0;

  if (rawType === "system") {
    kind = "system";
    const c = o.content;
    if (typeof c === "string") {
      chars = c.length;
      preview = previewOf(c);
    } else if (compact) {
      preview = "compact boundary — " + compact.pre.toLocaleString() +
        " → " + compact.post.toLocaleString() + " tokens";
    } else {
      preview = str(o.subtype) || "system";
    }
  } else if (rawType === "attachment") {
    kind = "attachment";
    const a = isObj(o.attachment) ? o.attachment : {};
    const c = a.content;
    if (typeof c === "string") {
      chars = c.length;
      preview = previewOf(c);
    } else {
      preview = str(a.type) || "attachment";
    }
    if (!preview) preview = "attachment";
  } else {
    // Bookkeeping and anything the writer invented since. Named, counted,
    // never inspected — several of these types hold prompt text verbatim.
    kind = "meta";
    preview = BOOKKEEPING_TYPES.has(rawType) ? rawType : rawType + " (unrecognised)";
  }

  emit({
    ...base,
    bi: -1,
    kind,
    role: null,
    err: recErr !== "",
    errWhy: recErr,
    tool: "",
    toolUseId: "",
    msgId: "",
    model: "",
    usage: null,
    ctx: ix.ctx,
    chars,
    preview,
  });
}

/**
 * Group the flat step list back into the messages array the API would have
 * seen: consecutive steps sharing role+message.id are one entry. Steps with no
 * role (system, attachments, bookkeeping) do not create entries and do not
 * break a run.
 */
export function buildEntries(steps: Step[]): Entry[] {
  const entries: Entry[] = [];
  let cur: Entry | null = null;
  let curKey = "";

  for (const s of steps) {
    if (s.role === null) {
      if (cur) s.entry = cur.i;
      continue;
    }
    const key = s.role + "|" + s.msgId;
    if (!cur || key !== curKey) {
      cur = {
        i: entries.length,
        role: s.role,
        msgId: s.msgId,
        model: s.model,
        from: s.i,
        to: s.i,
        t: s.t,
        output: 0,
        ctx: s.ctx,
        chars: 0,
        err: false,
      };
      curKey = key;
      entries.push(cur);
    }
    cur.to = s.i;
    cur.chars += s.chars;
    cur.ctx = s.ctx;
    if (s.usage) cur.output += s.usage.output;
    if (s.err) cur.err = true;
    if (!cur.model && s.model) cur.model = s.model;
    s.entry = cur.i;
  }
  return entries;
}

export function finishIndex(ix: Indexer): { meta: TapeMeta; steps: Step[]; entries: Entry[] } {
  ix.meta.versions = [...ix.versions].sort();
  return { meta: ix.meta, steps: ix.steps, entries: buildEntries(ix.steps) };
}

/**
 * Pair every tool-call step with its result. The probe found the result lands
 * within six lines of the call in every fixture, so a bounded forward scan is
 * enough and no whole-file map is built.
 */
export function pairTools(steps: Step[], window = 64): Map<number, number> {
  const pairs = new Map<number, number>();
  const pending = new Map<string, number>();
  for (const s of steps) {
    if (s.kind === "tool-call" && s.toolUseId) pending.set(s.toolUseId, s.i);
    else if (s.kind === "tool-result" && s.toolUseId) {
      const call = pending.get(s.toolUseId);
      if (call !== undefined && s.i - call <= window * 8) {
        pairs.set(call, s.i);
        pairs.set(s.i, call);
        pending.delete(s.toolUseId);
      }
    }
  }
  return pairs;
}

// ---------------------------------------------------------------- bodies

/** Extract the payload of one step from its already-parsed record. */
export function bodyOf(raw: unknown, bi: number): StepBody {
  const empty: StepBody = { text: null, input: undefined, parts: [], placeholder: false, chars: 0 };
  if (!isObj(raw)) return empty;

  const msg = raw.message;
  if (isObj(msg)) {
    const content = msg.content;
    if (typeof content === "string")
      return { ...empty, text: content, chars: content.length };
    if (!Array.isArray(content)) return empty;
    const b = bi >= 0 ? content[bi] : content[0];
    if (!isObj(b)) return empty;
    const bt = str(b.type);
    if (bt === "text") return { ...empty, text: str(b.text), chars: str(b.text).length };
    if (bt === "thinking") return { ...empty, text: str(b.thinking), chars: str(b.thinking).length };
    if (bt === "tool_use") {
      const enc = JSON.stringify(b.input, null, 2) ?? "";
      return { ...empty, input: b.input, text: enc, chars: enc.length };
    }
    if (bt === "tool_result") {
      const r = resultText(b.content);
      return { ...empty, text: r.text, parts: r.parts, chars: r.chars };
    }
    if (bt === "image") {
      const src = isObj(b.source) ? b.source : {};
      return {
        ...empty,
        parts: [{ type: "image/" + (str(src.media_type) || "?"), chars: str(src.data).length }],
        chars: str(src.data).length,
      };
    }
    return empty;
  }

  if (str(raw.type) === "attachment" && isObj(raw.attachment)) {
    const c = raw.attachment.content;
    if (typeof c === "string") return { ...empty, text: c, chars: c.length };
    const enc = JSON.stringify(raw.attachment, null, 2) ?? "";
    return { ...empty, text: enc, chars: enc.length };
  }
  if (typeof raw.content === "string")
    return { ...empty, text: raw.content, chars: raw.content.length };

  return empty;
}
