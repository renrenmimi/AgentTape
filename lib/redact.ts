// Making a run safe to hand to a stranger.
//
// The design is subtractive rather than filtering: the redactor is not given
// the transcript at all. It reads the *index*, which holds numbers, enumerated
// writer vocabulary (record types, tool names, models), and exactly one
// content-bearing field — the 96-character `preview`. That field is replaced,
// so there is no path by which a body can reach the output.
//
// A second pass then re-checks every string that survived against a whitelist,
// because "there is no path" is a claim about code that will change.

import type { Step, Tape } from "./format.ts";
import { TAPE_FIELDS, TAPE_FORMAT, stepToTape, type TapeFile, type TapeStep } from "./tape.ts";

/** Labels this codebase produces for a failure. Nothing else may pass through. */
const ERROR_LABELS = new Set([
  "", "api error", "system error", "permission denied", "tool reported an error",
]);

/**
 * Names that may be kept verbatim: writer record types, tool names, model ids.
 * No slashes, no spaces, no dots-with-slashes — nothing that can carry a path
 * or a URL. `<synthetic>` and `mcp__server__tool` both pass; `/Users/x` and
 * `https://…` both fail.
 */
const SAFE_NAME = /^[A-Za-z0-9_.:<>+-]{1,80}$/;

export function scrubName(v: string, what: string): string {
  if (!v) return "";
  return SAFE_NAME.test(v) ? v : "[" + what + " " + v.length.toLocaleString("en-US") + " chars]";
}

/** `[text 1,284 chars]` — the length is kept because it is the useful part. */
export function placeholder(what: string, chars: number): string {
  if (!chars) return "[" + what + " empty]";
  return "[" + what + " " + chars.toLocaleString("en-US") + " chars]";
}

const BODY_WORD: Record<string, string> = {
  "user": "text",
  "text": "text",
  "thinking": "thinking",
  "tool-call": "input",
  "tool-result": "result",
  "system": "system",
  "attachment": "attachment",
  "meta": "meta",
};

export function placeholderFor(step: { kind: string; chars: number }): string {
  return placeholder(BODY_WORD[step.kind] ?? "body", step.chars);
}

/** Redact one indexed step. Every free-form string is replaced or whitelisted. */
export function redactStep(s: Step): TapeStep {
  const t = stepToTape(s);
  t.p = placeholderFor(s);
  t.y = scrubName(t.y ?? "", "type");
  if (t.n) t.n = scrubName(t.n, "tool");
  if (t.d) t.d = scrubName(t.d, "model");
  if (t.w && !ERROR_LABELS.has(t.w)) t.w = "error";
  // Opaque correlation ids: kept so calls still pair, but capped and shaped.
  if (t.u) t.u = scrubName(t.u.slice(0, 80), "id");
  if (t.m) t.m = scrubName(t.m.slice(0, 80), "id");
  if (t.z) t.z = [t.z[0], t.z[1], t.z[2], scrubName(String(t.z[3]), "trigger")];
  return t;
}

/**
 * Build the export. Note what is *not* read: `tape.body`, which is the only
 * function that can reach the transcript, is never called.
 */
export function redactTape(tape: Tape): TapeFile {
  const file: TapeFile = {
    format: TAPE_FORMAT,
    redacted: true,
    note:
      "Structure only. Every text body, tool input, tool result, path and URL " +
      "was replaced by a placeholder that keeps its length. Safe to attach to " +
      "a bug report.",
    label: "redacted session",
    session: {
      id: tape.meta.sessionId ? placeholder("id", tape.meta.sessionId.length) : "",
      bytes: tape.meta.bytes,
      lines: tape.meta.lines,
      badLines: tape.meta.badLines,
      versions: tape.meta.versions.map((v) => scrubName(v, "version")),
    },
    fields: TAPE_FIELDS,
    steps: tape.steps.map(redactStep),
  };
  if ("bodies" in file) delete (file as { bodies?: unknown }).bodies;
  return file;
}

/**
 * Independent audit of a finished export. Rather than asking "does this string
 * look safe?", it asks "is this string in a slot allowed to hold a name?" —
 * a much narrower question. Every other slot must hold a placeholder or one of
 * this codebase's own fixed labels. Returns the offending paths so a test can
 * name them.
 */
export function auditRedacted(file: TapeFile): string[] {
  const bad: string[] = [];
  const placeholderRe = /^\[[a-z ]+ (empty|[\d,]+ chars)\]$/;

  /** Slots that may hold writer vocabulary verbatim. */
  const NAME_SLOTS = /^(\.format|\.label|\.session\.versions\[\d+\]|\.steps\[\d+\]\.(y|n|d|r|k|u|m)|\.steps\[\d+\]\.z\[3\])$/;
  /** Slots that hold this file's own documentation, compared exactly. */
  const docs = new Map<string, string>([
    [".note", file.note ?? ""],
    [".format", TAPE_FORMAT],
    [".label", "redacted session"],
  ]);

  const walk = (v: unknown, path: string): void => {
    if (typeof v === "string") {
      if (path.startsWith(".fields.")) return;            // the legend, written here
      if (docs.get(path) === v) return;
      if (placeholderRe.test(v)) return;
      if (ERROR_LABELS.has(v) && /\.w$/.test(path)) return;
      if (NAME_SLOTS.test(path) && SAFE_NAME.test(v)) return;
      bad.push(path);
      return;
    }
    if (Array.isArray(v)) { v.forEach((x, i) => walk(x, path + "[" + i + "]")); return; }
    if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) walk(x, path + "." + k);
    }
  };

  if (file.bodies !== undefined) bad.push(".bodies (must not exist)");
  if (file.redacted !== true) bad.push(".redacted (must be true)");
  walk(file, "");
  return bad;
}
