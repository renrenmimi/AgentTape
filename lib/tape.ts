// The .tape.json container.
//
// Two things ship in this shape: a redacted export (structure, no words) and
// the hand-authored demo. They differ by one optional key — `bodies` — so the
// app has a single load path and the redactor has nothing to opt out of.
//
// Keys are one character because a redacted export of a ten-thousand-step
// session has to stay small enough to attach to an issue. A `fields` legend
// travels inside the file so it is still readable without this source.

import { buildEntries } from "./parser.ts";
import type { Step, StepBody, StepKind, Tape } from "./format.ts";

export const TAPE_FORMAT = "agenttape/1";

export const TAPE_FIELDS: Record<string, string> = {
  k: "kind", y: "record type", r: "role", ts: "timestamp (epoch ms)",
  e: "error", w: "error reason", n: "tool name", u: "tool_use id",
  m: "message id", d: "model", g: "[input, output, cache_read, cache_create]",
  x: "context tokens", c: "characters in the body", b: "block index",
  p: "one-line summary", z: "[pre, post, dropped, trigger] on a compact boundary",
};

export type TapeStep = {
  k: StepKind;
  y: string;
  r?: "user" | "assistant";
  ts?: number;
  e?: 1;
  w?: string;
  n?: string;
  u?: string;
  m?: string;
  d?: string;
  g?: [number, number, number, number];
  x?: number;
  c?: number;
  b?: number;
  p?: string;
  z?: [number, number, number, string];
};

export type TapeFile = {
  format: string;
  redacted: boolean;
  note?: string;
  label: string;
  session: {
    id: string;
    bytes: number;
    lines: number;
    badLines: number;
    versions: string[];
  };
  fields: Record<string, string>;
  steps: TapeStep[];
  /** Present only in hand-authored tapes. A redacted export never has it. */
  bodies?: Record<string, string>;
};

export function stepToTape(s: Step): TapeStep {
  const t: TapeStep = { k: s.kind, y: s.rawType };
  if (s.role) t.r = s.role;
  if (s.ts !== null) t.ts = s.ts;
  if (s.err) t.e = 1;
  if (s.errWhy) t.w = s.errWhy;
  if (s.tool) t.n = s.tool;
  if (s.toolUseId) t.u = s.toolUseId;
  if (s.msgId) t.m = s.msgId;
  if (s.model) t.d = s.model;
  if (s.usage) t.g = [s.usage.input, s.usage.output, s.usage.cacheRead, s.usage.cacheCreate];
  if (s.ctx) t.x = s.ctx;
  if (s.chars) t.c = s.chars;
  if (s.bi >= 0) t.b = s.bi;
  if (s.preview) t.p = s.preview;
  if (s.compact) t.z = [s.compact.pre, s.compact.post, s.compact.dropped, s.compact.trigger];
  return t;
}

function tapeToStep(t: TapeStep, i: number, clock: { v: number }): Step {
  const ts = typeof t.ts === "number" ? t.ts : null;
  if (ts !== null && ts > clock.v) clock.v = ts;
  return {
    i,
    line: i + 1,
    off: 0,
    len: 0,
    bi: typeof t.b === "number" ? t.b : -1,
    kind: t.k,
    rawType: t.y ?? "unknown",
    role: t.r ?? null,
    ts,
    t: clock.v,
    err: t.e === 1,
    errWhy: t.w ?? "",
    tool: t.n ?? "",
    toolUseId: t.u ?? "",
    msgId: t.m ?? "",
    model: t.d ?? "",
    usage: t.g
      ? { input: t.g[0] ?? 0, output: t.g[1] ?? 0, cacheRead: t.g[2] ?? 0, cacheCreate: t.g[3] ?? 0 }
      : null,
    ctx: t.x ?? 0,
    chars: t.c ?? 0,
    preview: t.p ?? "",
    entry: -1,
    compact: t.z ? { pre: t.z[0] ?? 0, post: t.z[1] ?? 0, dropped: t.z[2] ?? 0, trigger: t.z[3] ?? "" } : null,
  };
}

/** Turn a parsed .tape.json into the same Tape the JSONL path produces. */
export function tapeFromFile(file: TapeFile): Tape {
  if (!file || file.format !== TAPE_FORMAT)
    throw new Error("not an " + TAPE_FORMAT + " file");
  const clock = { v: 0 };
  const raw = Array.isArray(file.steps) ? file.steps : [];
  const steps = raw.map((t, i) => tapeToStep(t ?? ({} as TapeStep), i, clock));
  const entries = buildEntries(steps);
  const bodies = file.bodies ?? {};

  const body = async (i: number): Promise<StepBody> => {
    const s = steps[i];
    const text = bodies[String(i)];
    if (typeof text === "string")
      return { text, input: undefined, parts: [], placeholder: false, chars: text.length };
    return {
      text: null,
      input: undefined,
      parts: [],
      placeholder: true,
      chars: s ? s.chars : 0,
    };
  };

  return {
    meta: {
      source: "tape",
      redacted: file.redacted !== false,
      label: file.label || "tape",
      sessionId: file.session?.id ?? "",
      bytes: file.session?.bytes ?? 0,
      lines: file.session?.lines ?? steps.length,
      badLines: file.session?.badLines ?? 0,
      versions: file.session?.versions ?? [],
    },
    steps,
    entries,
    body,
  };
}

/**
 * Serialize with one step per line. `JSON.stringify(x, null, 2)` would triple
 * the size; a single line would be unreadable. This keeps it greppable.
 */
export function serializeTape(file: TapeFile): string {
  const head = {
    format: file.format,
    redacted: file.redacted,
    note: file.note,
    label: file.label,
    session: file.session,
    fields: file.fields,
  };
  const lines: string[] = [];
  for (const [k, v] of Object.entries(head)) {
    if (v === undefined) continue;
    lines.push("  " + JSON.stringify(k) + ": " + JSON.stringify(v) + ",");
  }
  lines.push('  "steps": [');
  file.steps.forEach((s, i) => {
    lines.push("    " + JSON.stringify(s) + (i === file.steps.length - 1 ? "" : ","));
  });
  lines.push(file.bodies ? "  ]," : "  ]");
  if (file.bodies) {
    lines.push('  "bodies": {');
    const keys = Object.keys(file.bodies);
    keys.forEach((k, i) => {
      lines.push("    " + JSON.stringify(k) + ": " + JSON.stringify(file.bodies![k]) +
        (i === keys.length - 1 ? "" : ","));
    });
    lines.push("  }");
  }
  return "{\n" + lines.join("\n") + "\n}\n";
}
