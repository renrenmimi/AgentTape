// Static checks, run with:  node verify.mjs
//
// The parser and the redactor are imported as modules and exercised against
// fixtures generated here in code. No real transcript is read: a checker that
// needs one of my sessions to pass is a checker nobody else can run, and this
// repository is going to be public.
//
// The rest reads the source as text, to assert the things that are properties
// of the repository rather than of a function — that the ignore rules are in
// place, that the app has no remote endpoint, and that nothing lands on
// `window` outside the self-test flag.

import { fileURLToPath } from "node:url";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { checkContrast } from "./scripts/contrast.mjs";
import { join } from "node:path";
import { homedir } from "node:os";

import { createIndexer, pushLine, finishIndex, pairTools, bodyOf } from "./lib/parser.ts";
import { loadJsonlString } from "./lib/load.ts";
import { redactTape, redactStep, auditRedacted, placeholder, scrubName } from "./lib/redact.ts";
import { tapeFromFile, serializeTape, TAPE_FORMAT } from "./lib/tape.ts";
import { summarise, traceJump } from "./lib/summary.ts";
import { EMPTY_FILTER, applyFilter, buildFilterIndex, isActive, seek } from "./lib/filter.ts";
import { cumulativeChars, deltaAt } from "./lib/delta.ts";
import {
  DELEGATION_TOOLS, agentIdFromName, delegationSummary, findDelegations,
  isDelegation, pairBySidecar, pairByTime, summariseRun,
} from "./lib/subagents.ts";
import { buildSpine, compareSpines, realignLine, verdictLine } from "./lib/compare.ts";
import { contextProfile, sessionStats } from "./lib/stats.ts";
import { formatCorpus, summariseCorpus } from "./lib/corpus.ts";
import { markdownReport, sparkline } from "./lib/report.ts";
import { headings, parseInline, parseMarkdown, plainText, slugify } from "./lib/md.ts";
import {
  DEFAULT_RULES, RULES_FORMAT, checkAll, checkRule, parseRule, parseRuleSet,
  ruleLabel, serializeRuleSet, tally,
} from "./lib/assert.ts";

const root = new URL("./", import.meta.url).pathname;
let failed = 0, checked = 0;
/**
 * Which lines of this file actually ran an assertion.
 *
 * A check that never executes is worse than a missing one: it is counted, it
 * is green, and it is evidence of nothing. This file has already shipped one —
 * a whole block appended after `process.exit`, which nothing revealed except
 * that the total did not move. So every call site is recorded as it fires and
 * the set is compared with the call sites in the source at the end.
 */
const fired = new Set();

/**
 * Where `name(` is called, by character offset, skipping comments, strings,
 * template literals and regex literals.
 *
 * The second method, and the reason there has to be one. A per-line regex is a
 * scanner with no idea what it is looking at: this repository's counted lines
 * out of existence because they mentioned the word "skipped", and then counted
 * one more out because a regex literal *inside an assertion* said
 * `const skip = \(` and the exclusion pattern matched the regex's own text.
 * That is AgentLab's bug wearing a different hat — a scanner that stops or
 * skips on an incidental character sequence and reports a smaller number
 * confidently — and the only reliable way to find it is a second method that
 * disagrees.
 */
function callOffsets(src, names) {
  const out = [];
  const isId = (c) => (c >= "0" && c <= "9") || (c >= "A" && c <= "Z") ||
    (c >= "a" && c <= "z") || c === "_" || c === "$";
  const n = src.length;
  let i = 0, prev = "";
  while (i < n) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2; continue;
    }
    if (c === '"' || c === "'") {
      const q = c; i++;
      while (i < n && src[i] !== q) i += src[i] === "\\" ? 2 : 1;
      i++; prev = q; continue;
    }
    if (c === "`") {
      i++;
      let depth = 0;
      while (i < n) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === "$" && src[i + 1] === "{") { depth++; i += 2; continue; }
        if (src[i] === "}" && depth > 0) { depth--; i++; continue; }
        if (src[i] === "`" && depth === 0) break;
        i++;
      }
      i++; prev = "`"; continue;
    }
    // A slash is a regex only where a value may begin. Getting this wrong in
    // the other direction is what makes a scanner swallow the rest of a file.
    if (c === "/" && (prev === "" || "(,=:[!&|?{};+-*%~^<>".includes(prev))) {
      i++;
      let cls = false;
      while (i < n) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === "[") cls = true;
        else if (src[i] === "]") cls = false;
        else if (src[i] === "/" && !cls) break;
        else if (src[i] === "\n") break;
        i++;
      }
      i++;
      while (i < n && "gimsuyd".includes(src[i])) i++;
      prev = "/"; continue;
    }
    if (isId(c)) {
      let j = i;
      while (j < n && isId(src[j])) j++;
      const word = src.slice(i, j);
      if (names.includes(word) && src[j] === "(" && prev !== "." && !isId(prev)) out.push(i);
      prev = word[word.length - 1];
      i = j; continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

/** Those offsets as line numbers. */
function callLinesOf(src, names) {
  const nl = [];
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") nl.push(i);
  return new Set(callOffsets(src, names).map((o) => {
    let lo = 0, hi = nl.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (nl[m] < o) lo = m + 1; else hi = m; }
    return lo + 1;
  }));
}
const callerLine = () => {
  const at = (new Error().stack ?? "").split("\n")[3] ?? "";
  const m = at.match(/verify\.mjs:(\d+):/);
  return m ? Number(m[1]) : 0;
};

const ok = (cond, label, note) => {
  checked++;
  fired.add(callerLine());
  if (!cond) { failed++; console.log("  FAIL  " + label + (note ? "   [" + note + "]" : "")); }
};
const section = (s) => console.log("\n" + s);

// ---------------------------------------------------------------- fixtures

// Every record type docs/format-notes.md observed, plus two the probe never
// saw but the brief listed, plus one nobody has ever seen.
const TYPES = [
  "user", "assistant", "system", "attachment", "custom-title", "ai-title",
  "last-prompt", "mode", "queue-operation", "file-history-snapshot",
  "file-history-delta", "pr-link", "atis-latch", "type-from-the-future",
];

const usage = (input, out, read, create) => ({
  input_tokens: input, output_tokens: out,
  cache_read_input_tokens: read, cache_creation_input_tokens: create,
  cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: create },
  server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
  service_tier: "standard", inference_geo: "xx", speed: "fast", iterations: [],
});

// Bodies deliberately made of material a redactor must not leak: absolute
// paths, URLs, credentials, prose. They avoid tool names and this codebase's
// own error labels, both of which are kept on purpose.
const BODIES = [
  "/Users/somebody/Documents/quarterly-forecast/private-notes.md line 118 mentions the merger",
  "https://internal.example.invalid/dashboards/7fd2?token=zx9Q-KKa1-77bnT-Lp0v2 opens the board",
  "The migration deleted 4,102 rows from customers_archive before anyone noticed on Tuesday",
  "postgres://analytics:h4nd-p1ck3d-s3cr3t@db.internal.invalid:5432/warehouse?sslmode=require",
  "qKm2vRXpLd9wZbT4nHsY7eUj0iAgFcO5MxQ1BrWnVkPtHyLzDaSfEoIuCbGvNjRmXwZq",
];

function makeLines() {
  const L = [];
  const at = (n) => new Date(Date.parse("2026-02-02T08:00:00Z") + n * 1000).toISOString();

  L.push(JSON.stringify({
    type: "user", sessionId: "s1", uuid: "u0", parentUuid: null, isSidechain: false,
    timestamp: at(0), version: "9.9.9", cwd: "/Users/somebody/work/app",
    message: { role: "user", content: [{ type: "text", text: BODIES[0] }] },
  }));

  // thinking + text + tool_use sharing one message.id — one API message split
  // across three lines, which is how the writer really does it.
  L.push(JSON.stringify({
    type: "assistant", sessionId: "s1", uuid: "u1", parentUuid: "u0", timestamp: at(4),
    version: "9.9.9",
    message: { role: "assistant", id: "msg_01QkTvbRmXpLd9wZbT4nHsY7", model: "claude-opus-5", stop_reason: null,
      usage: usage(500, 120, 8000, 500),
      content: [{ type: "thinking", thinking: BODIES[2], signature: "sig" }] },
  }));
  L.push(JSON.stringify({
    type: "assistant", sessionId: "s1", uuid: "u2", parentUuid: "u1", timestamp: at(6),
    message: { role: "assistant", id: "msg_01QkTvbRmXpLd9wZbT4nHsY7", model: "claude-opus-5",
      content: [{ type: "text", text: BODIES[1] }] },
  }));
  L.push(JSON.stringify({
    type: "assistant", sessionId: "s1", uuid: "u3", parentUuid: "u2", timestamp: at(8),
    message: { role: "assistant", id: "msg_01QkTvbRmXpLd9wZbT4nHsY7", model: "claude-opus-5",
      content: [{ type: "tool_use", id: "toolu_01ZxNm4PqRsTuVwXyZaBcDeF", name: "Bash",
        input: { command: BODIES[3] }, caller: { type: "assistant" } }] },
  }));
  // tool_result with a STRING body and no is_error key at all
  L.push(JSON.stringify({
    type: "user", sessionId: "s1", uuid: "u4", parentUuid: "u3", timestamp: at(11),
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01ZxNm4PqRsTuVwXyZaBcDeF", content: BODIES[4] }] },
  }));

  // tool_result with an ARRAY body mixing text and an image
  L.push(JSON.stringify({
    type: "assistant", sessionId: "s1", uuid: "u5", parentUuid: "u4", timestamp: at(13),
    message: { role: "assistant", id: "msg_01BdGhJkLmNpQrStUvWxYz23", model: "claude-opus-5", usage: usage(600, 90, 20000, 300),
      content: [{ type: "tool_use", id: "toolu_01FgHjKlMnPqRsTuVwXyZa34", name: "mcp__demo__fetch", input: { url: BODIES[1] } }] },
  }));
  L.push(JSON.stringify({
    type: "user", sessionId: "s1", uuid: "u6", parentUuid: "u5", timestamp: at(19),
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01FgHjKlMnPqRsTuVwXyZa34", is_error: true,
      content: [{ type: "text", text: BODIES[0] },
                { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA".repeat(64) } }] }] },
  }));

  // an assistant record with NO usage at all
  L.push(JSON.stringify({
    type: "assistant", sessionId: "s1", uuid: "u7", parentUuid: "u6", timestamp: at(22),
    message: { role: "assistant", id: "msg_01CdEfGhJkLmNpQrStUvWx45", model: "<synthetic>",
      content: [{ type: "text", text: BODIES[2] }] },
    isApiErrorMessage: true, apiErrorStatus: 529, error: BODIES[0],
  }));

  // a string message.content rather than an array
  L.push(JSON.stringify({
    type: "user", sessionId: "s1", uuid: "u8", parentUuid: "u7", timestamp: at(24),
    message: { role: "user", content: BODIES[3] },
  }));

  // a timestamp that goes backwards
  L.push(JSON.stringify({
    type: "assistant", sessionId: "s1", uuid: "u9", parentUuid: "u8", timestamp: at(2),
    message: { role: "assistant", id: "msg_01DeFgHjKlMnPqRsTuVwXy56", model: "claude-opus-5", usage: usage(700, 40, 90000, 200),
      content: [{ type: "text", text: BODIES[4] }] },
  }));

  // a compact boundary
  L.push(JSON.stringify({
    type: "system", sessionId: "s1", uuid: "u10", parentUuid: "u9", timestamp: at(30),
    subtype: "compact_boundary", level: "info", content: BODIES[2],
    compactMetadata: { preTokens: 90700, postTokens: 12000, cumulativeDroppedTokens: 78700,
      durationMs: 4100, trigger: "auto", preservedMessages: { uuids: [], allUuids: [], anchorUuid: "" } },
  }));

  // the turn after the compaction, carrying the reduced context. Without this
  // the fixture never shows a payload leaving the array and the trace has
  // nothing to find.
  L.push(JSON.stringify({
    type: "assistant", sessionId: "s1", uuid: "u11", parentUuid: "u10", timestamp: at(34),
    message: { role: "assistant", id: "msg_01EfGhJkLmNpQrStUvWxYz67", model: "claude-opus-5",
      usage: usage(400, 60, 11600, 0),
      content: [{ type: "text", text: BODIES[1] }] },
  }));

  // malformed JSON, in the middle, exactly as a half-flushed write would look
  L.push('{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"' + BODIES[0]);

  // a line that parses but is not an object
  L.push('"just a string"');
  L.push("[1,2,3]");
  L.push("");

  // one record of every remaining type, each carrying a body a leak would show
  for (const t of TYPES) {
    if (t === "user" || t === "assistant" || t === "system") continue;
    const rec = { type: t, sessionId: "s1", timestamp: at(40) };
    if (t === "attachment") { rec.uuid = "a-" + t; rec.attachment = { type: "file", content: BODIES[1] }; }
    else if (t === "custom-title") rec.customTitle = BODIES[0];
    else if (t === "ai-title") rec.aiTitle = BODIES[2];
    else if (t === "last-prompt") { rec.lastPrompt = BODIES[3]; rec.leafUuid = "u0"; }
    else if (t === "mode") rec.mode = "acceptEdits";
    else if (t === "queue-operation") { rec.operation = "enqueue"; rec.content = BODIES[4]; }
    else if (t === "file-history-snapshot") { rec.messageId = "fh1"; rec.snapshot = { messageId: "fh1", trackedFileBackups: {} }; }
    else if (t === "file-history-delta") { rec.messageId = "fh1"; rec.trackingPath = BODIES[0]; }
    else rec.payload = BODIES[1];
    L.push(JSON.stringify(rec));
  }
  return L;
}

const LINES = makeLines();
const TEXT = LINES.join("\n");

// ---------------------------------------------------------------- parsing

section("parser");
const tape = loadJsonlString(TEXT, "verify");
const S = summarise(tape);

ok(tape.meta.lines === LINES.length, "every line is accounted for",
  `${tape.meta.lines} of ${LINES.length}`);
ok(tape.meta.badLines === 3, "malformed and non-object lines are counted, not thrown",
  `badLines=${tape.meta.badLines}`);
ok(tape.steps.length > 0, "the file still produced steps after the malformed line",
  `${tape.steps.length} steps`);

for (const t of TYPES) {
  ok(tape.steps.some((s) => s.rawType === t), "record type parses: " + t);
}
ok(tape.steps.find((s) => s.rawType === "type-from-the-future")?.kind === "meta",
  "an unknown record type degrades to a generic step rather than throwing");
ok(tape.steps.find((s) => s.rawType === "pr-link")?.kind === "meta",
  "a documented-but-unobserved type degrades the same way");

const noUsage = tape.steps.find((s) => s.msgId === "msg_01CdEfGhJkLmNpQrStUvWx45");
ok(noUsage && noUsage.usage === null, "a message with no usage parses");
ok(noUsage && noUsage.ctx > 0, "a message with no usage inherits the running context",
  `ctx=${noUsage?.ctx}`);
ok(noUsage?.err === true, "isApiErrorMessage marks the step as failed");

const stringContent = tape.steps.find((s) => s.bi === -1 && s.role === "user");
ok(!!stringContent, "a string message.content parses as one step");

for (const kind of ["user", "text", "thinking", "tool-call", "tool-result", "system", "attachment", "meta"]) {
  ok(tape.steps.some((s) => s.kind === kind), "step kind produced: " + kind);
}

const backwards = tape.steps.findIndex((s) => s.ts !== null && s.i > 0 && s.ts < tape.steps[s.i - 1].t);
ok(backwards >= 0, "the fixture really does step backwards in time");
ok(tape.steps.every((s, i) => i === 0 || s.t >= tape.steps[i - 1].t),
  "the monotonic clock never goes backwards");

const pairs = pairTools(tape.steps);
const calls = tape.steps.filter((s) => s.kind === "tool-call");
ok(calls.length === 2, "both tool calls were found", `${calls.length}`);
ok(calls.every((c) => pairs.has(c.i)), "every tool call is paired with its result");
const errResult = tape.steps.find((s) => s.kind === "tool-result" && s.err);
ok(!!errResult, "is_error: true marks the result as failed");
const okResult = tape.steps.find((s) => s.kind === "tool-result" && !s.err);
ok(!!okResult, "a tool_result with no is_error key is NOT treated as a failure");

const m1 = tape.entries.filter((e) => e.msgId === "msg_01QkTvbRmXpLd9wZbT4nHsY7");
ok(m1.length === 1, "three assistant lines sharing a message.id become one array entry",
  `${m1.length} entries`);
ok(m1[0] && m1[0].to - m1[0].from === 2, "that entry spans all three blocks");

const compact = tape.steps.find((s) => s.compact);
ok(!!compact && compact.compact.dropped === 78700, "a compact boundary keeps its token figures");
ok(S.compactAt.length === 1, "the summary finds the compaction");
ok(S.jumpBy > 60000, "the summary finds the largest context jump", `+${S.jumpBy}`);
ok(S.errors >= 2, "the summary counts every failure signal, not just is_error", `${S.errors}`);
ok(S.tools.length === 2 && S.tools.some((t) => t.name === "mcp__demo__fetch"),
  "MCP tool names survive as tool names");

section("parser — degenerate input");
for (const [label, input] of [
  ["an empty file", ""],
  ["a file of blank lines", "\n\n\n"],
  ["a file of one malformed line", "{not json"],
  ["a file with no trailing newline", '{"type":"mode","mode":"x"}'],
  ["a null literal", "null"],
  ["a bare number", "42"],
]) {
  let threw = "";
  try { loadJsonlString(input, "x"); } catch (e) { threw = String(e); }
  ok(threw === "", "does not throw on " + label, threw);
}
ok(bodyOf(undefined, 0).text === null, "bodyOf tolerates an undefined record");
ok(bodyOf({ message: { content: [] } }, 5).text === null, "bodyOf tolerates a block index past the end");

// offsets must point at the right bytes, including past multi-byte characters
section("parser — byte offsets");
{
  const withUnicode = [
    JSON.stringify({ type: "mode", mode: "üñïçø∂é ✂ 世界" }),
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "second" }] } }),
  ].join("\n");
  const t2 = loadJsonlString(withUnicode, "u");
  const buf = Buffer.from(withUnicode, "utf8");
  ok(t2.steps.length === 2, "both lines indexed");
  for (const s of t2.steps) {
    const slice = buf.subarray(s.off, s.off + s.len).toString("utf8");
    let parsed = null;
    try { parsed = JSON.parse(slice); } catch { /* reported below */ }
    ok(parsed !== null && parsed.type === s.rawType,
      "the recorded byte range re-reads as the same record (line " + s.line + ")");
  }
}

// ---------------------------------------------------------------- redaction

section("redaction");
const scrubbed = redactTape(tape);
const wire = serializeTape(scrubbed);

ok(scrubbed.redacted === true, "the export is flagged redacted");
ok(scrubbed.bodies === undefined, "the export carries no bodies key");
ok(scrubbed.steps.length === tape.steps.length, "the export keeps every step");
ok(auditRedacted(scrubbed).length === 0, "the slot-by-slot audit is clean",
  auditRedacted(scrubbed).join(", "));

// the substring test: nothing 12 characters long survives from any body
const MIN = 12;
let leaks = 0;
let firstLeak = "";
for (const body of BODIES) {
  for (let i = 0; i + MIN <= body.length; i++) {
    const needle = body.slice(i, i + MIN);
    if (wire.includes(needle)) { leaks++; if (!firstLeak) firstLeak = "offset " + i; }
  }
}
ok(leaks === 0, `no ${MIN}-character run from any body survives redaction`,
  leaks ? `${leaks} leaks, first at ${firstLeak}` : "");

// same test against every body the parser could reach, not just the seeded ones
let reachable = 0, reachableLeaks = 0;
for (const s of tape.steps) {
  const b = bodyOf(JSON.parse(LINES[s.line - 1] || "{}"), s.bi);
  const text = b.text;
  if (!text || text.length < MIN) continue;
  reachable++;
  for (let i = 0; i + MIN <= text.length; i++) {
    if (wire.includes(text.slice(i, i + MIN))) reachableLeaks++;
  }
}
ok(reachableLeaks === 0, `no ${MIN}-character run from any reachable body survives`,
  `${reachable} bodies checked, ${reachableLeaks} leaks`);

// previews are the one content-bearing field in the index; they must all go
ok(tape.steps.some((s) => s.preview.length > 20), "the index really does hold previews");
ok(scrubbed.steps.every((s) => !s.p || /^\[[a-z ]+ (empty|[\d,]+ chars)\]$/.test(s.p)),
  "every preview became a placeholder");

// lengths are kept, because the length is the useful part
const withChars = tape.steps.find((s) => s.chars > 40);
const asTape = redactStep(withChars);
ok(asTape.c === withChars.chars, "the character count survives redaction");
ok(asTape.p.includes(withChars.chars.toLocaleString("en-US")),
  "the placeholder states the original length", asTape.p);

// correlation ids are renumbered, not carried
ok(scrubbed.steps.every((s) => !s.u || /^t\d+$/.test(s.u)), "tool_use ids are renumbered",
  scrubbed.steps.find((s) => s.u && !/^t\d+$/.test(s.u))?.u ?? "");
ok(scrubbed.steps.every((s) => !s.m || /^m\d+$/.test(s.m)), "message ids are renumbered");
{
  const call = scrubbed.steps.find((s) => s.k === "tool-call");
  const res = scrubbed.steps.find((s) => s.k === "tool-result");
  ok(!!call && !!res && call.u === res.u, "renumbering keeps a call paired with its result",
    `${call?.u} vs ${res?.u}`);
  const original = tape.steps.find((s) => s.kind === "tool-call");
  ok(!wire.includes(original.toolUseId), "the original tool_use id does not appear in the export");
  const withMsg = tape.steps.find((s) => s.msgId);
  ok(!wire.includes(withMsg.msgId), "the original message id does not appear in the export");
}

// paths and URLs cannot be smuggled through a name slot
ok(scrubName("/Users/somebody/notes.md", "path").startsWith("["), "a path is not a safe name");
ok(scrubName("https://example.invalid/x", "url").startsWith("["), "a URL is not a safe name");
ok(scrubName("mcp__Claude_Browser__javascript_tool", "tool") === "mcp__Claude_Browser__javascript_tool",
  "an MCP tool name is a safe name");
ok(scrubName("<synthetic>", "model") === "<synthetic>", "the synthetic model id is a safe name");
ok(placeholder("text", 1284) === "[text 1,284 chars]", "the placeholder matches the documented shape");
ok(placeholder("text", 0) === "[text empty]", "an empty body says so");

// a hostile record: tool name and model carrying a path and a URL
{
  const hostile = loadJsonlString(JSON.stringify({
    type: "assistant", timestamp: "2026-02-02T08:00:00Z",
    message: { role: "assistant", id: "msg_hostile", model: "/Users/x/model",
      content: [{ type: "tool_use", id: "toolu_hostile", name: "https://evil.invalid/tool", input: { a: 1 } }] },
  }), "h");
  const out = redactTape(hostile);
  ok(auditRedacted(out).length === 0, "a path in a tool name still audits clean",
    auditRedacted(out).join(","));
  ok(!serializeTape(out).includes("evil.invalid"), "a URL in a tool name does not survive");
  ok(!serializeTape(out).includes("/Users/x"), "a path in a model id does not survive");
}

// ---------------------------------------------------------------- round trip

section("tape round trip");
const reloaded = tapeFromFile(JSON.parse(wire));
ok(reloaded.steps.length === tape.steps.length, "a serialized tape reloads with the same step count");
ok(reloaded.entries.length === tape.entries.length, "entries regroup identically",
  `${reloaded.entries.length} vs ${tape.entries.length}`);
ok(reloaded.meta.redacted === true, "the reloaded tape knows it is redacted");
ok(JSON.stringify(summarise(reloaded).tools) === JSON.stringify(S.tools),
  "the summary survives the round trip");
{
  let threw = "";
  try { tapeFromFile({ format: "something-else", steps: [] }); } catch (e) { threw = String(e); }
  ok(threw !== "", "a foreign format is refused");
  ok(tapeFromFile({ format: TAPE_FORMAT, steps: [null, {}] }).steps.length === 2,
    "a tape with holes in it still loads");
}

// ---------------------------------------------------------------- indexer API

section("indexer");
{
  const ix = createIndexer("direct");
  pushLine(ix, LINES[0], 0, Buffer.byteLength(LINES[0]));
  const out = finishIndex(ix);
  ok(out.steps.length === 1, "pushLine/finishIndex work without the Blob path");
  ok(out.meta.versions.length === 1, "writer versions are collected", out.meta.versions.join(","));
}

// ---------------------------------------------------------------- filtering

section("filtering");
{
  const fx = buildFilterIndex(tape.steps, pairs);
  const all = (f) => applyFilter(tape.steps, fx, f);

  ok(!isActive(EMPTY_FILTER), "the empty filter is not active");
  ok(all(EMPTY_FILTER).count === tape.steps.length, "the empty filter matches every step");

  ok(fx.tools.length === 2, "the tool list holds every tool called", fx.tools.map((t) => t.name).join(","));
  ok(fx.tools.every((t) => t.count === 1), "each tool carries its call count");
  ok(fx.tools[0].count >= fx.tools[1].count, "the tool list is ordered by call count");

  // A result inherits its call's name, so filtering to one tool gives you both
  // halves of the exchange rather than a call with its answer filtered away.
  const call = tape.steps.find((s) => s.kind === "tool-call" && s.tool === "Bash");
  const result = tape.steps.find((s) => s.kind === "tool-result" && s.toolUseId === call.toolUseId);
  ok(fx.tool[result.i] === "Bash", "a tool_result inherits the name of its call", fx.tool[result.i]);
  const byTool = all({ ...EMPTY_FILTER, tools: ["Bash"] });
  ok(byTool.mask[call.i] === 1 && byTool.mask[result.i] === 1,
    "filtering to one tool keeps both the call and its result");
  ok(byTool.count === 2, "and nothing else", String(byTool.count));

  const big = tape.steps.filter((s) => s.chars >= 60).length;
  ok(all({ ...EMPTY_FILTER, minChars: 60 }).count === big, "the size threshold counts what it should");
  ok(all({ ...EMPTY_FILTER, minChars: 10 ** 9 }).count === 0, "an impossible threshold matches nothing");

  ok(all({ ...EMPTY_FILTER, query: "bash" }).count === 2, "search finds a tool name case-insensitively");
  ok(all({ ...EMPTY_FILTER, query: "BASH" }).count === 2, "…in either case");
  ok(all({ ...EMPTY_FILTER, query: "assistant" }).count > 0, "search covers record types");
  ok(all({ ...EMPTY_FILTER, query: "zzzznotpresentzzzz" }).count === 0, "a miss is a miss");

  // The filters AND together rather than widening each other.
  const both = all({ tools: ["Bash"], minChars: 10 ** 9, query: "" });
  ok(both.count === 0, "two filters intersect rather than union");

  // Search reads previews, and previews are truncated at PREVIEW_MAX. A body
  // longer than that has a tail the search cannot see — which is exactly the
  // limit the UI states, asserted here so it stays true.
  const long = tape.steps.find((s) => s.chars > 200 && s.preview.length < s.chars);
  ok(!!long, "the fixture has a body longer than its preview");
  ok(fx.hay[long.i].length < long.chars,
    "the searchable text is the preview, not the body",
    `${fx.hay[long.i].length} chars searchable of ${long.chars}`);

  const mask = all({ ...EMPTY_FILTER, tools: ["Bash"] }).mask;
  const first = [...mask].indexOf(1);
  const last = [...mask].lastIndexOf(1);
  ok(seek(mask, -1, 1) === first, "seek forward finds the first match");
  ok(seek(mask, last, 1) === -1, "seek forward stops at the end rather than wrapping");
  ok(seek(mask, tape.steps.length, -1) === last, "seek back finds the last match");
  ok(seek(mask, first, -1) === -1, "seek back stops at the start");
}

// ---------------------------------------------------------------- subagents

section("delegated work");
{
  ok(DELEGATION_TOOLS.has("Agent"), "Agent is recognised as a delegation");
  ok(!DELEGATION_TOOLS.has("TaskCreate") && !DELEGATION_TOOLS.has("TaskUpdate"),
    "the task-list tools are not mistaken for delegation");

  ok(agentIdFromName("agent-0123456789012345.jsonl") === "0123456789012345",
    "an agent id is read off its filename");
  ok(agentIdFromName("/some/where/agent-b1.jsonl") === "b1", "…including from a path");
  ok(agentIdFromName("session.jsonl") === "", "a main transcript is not an agent file");
  ok(agentIdFromName("agent-x.meta.json") === "", "a sidecar is not an agent file");
  ok(agentIdFromName("agent-../escape.jsonl") === "", "a traversal is not an agent id");

  // A main transcript with two delegations, one of which never came back.
  const at = (n) => new Date(Date.parse("2026-03-03T10:00:00Z") + n * 1000).toISOString();
  const call = (uuid, id, ts) => JSON.stringify({
    type: "assistant", sessionId: "d", uuid, timestamp: ts, isSidechain: false,
    message: { role: "assistant", id: "m" + uuid, model: "claude-opus-5",
      content: [{ type: "tool_use", id, name: "Agent", input: { a: 1 } }] },
  });
  const result = (uuid, id, ts) => JSON.stringify({
    type: "user", sessionId: "d", uuid, timestamp: ts,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "summary" }] },
  });
  const main = loadJsonlString([
    JSON.stringify({ type: "user", sessionId: "d", uuid: "u0", timestamp: at(0),
      message: { role: "user", content: [{ type: "text", text: "go" }] } }),
    call("c1", "toolu_one", at(10)),
    result("r1", "toolu_one", at(60)),
    call("c2", "toolu_two", at(70)),
    result("r2", "toolu_two", at(120)),
    call("c3", "toolu_three", at(130)),          // never comes back
  ].join("\n"), "main");

  const mainPairs = pairTools(main.steps);
  const dels = findDelegations(main.steps, mainPairs);
  ok(dels.length === 3, "every Agent call is found", String(dels.length));
  ok(dels.every((d) => isDelegation(main.steps[d.step])), "…and each is a delegation step");
  ok(dels[0].result > dels[0].step, "a delegation knows its result step");
  ok(dels[2].result === -1, "a delegation with no result says so");
  ok(dels[2].to === Infinity, "…and leaves its window open");
  ok(dels[0].to > dels[0].from, "a closed window runs forwards");

  ok(pairBySidecar(dels, "toolu_two") === 1, "a sidecar id picks its delegation exactly");
  ok(pairBySidecar(dels, "toolu_nope") === -1, "an unknown sidecar id matches nothing");

  const t = (n) => Date.parse(at(n));
  ok(pairByTime(dels, t(30)) === 0, "a start time inside the first window pairs with it");
  ok(pairByTime(dels, t(90)) === 1, "…and inside the second, with that one");
  ok(pairByTime(dels, t(200)) === 2, "a time after an open-ended call pairs with it");
  ok(pairByTime(dels, t(-100)) === -1, "a time before every window pairs with nothing");
  // A gap between two windows is genuinely unknown, and must stay unknown.
  ok(pairByTime(dels, t(65)) === -1, "a time in the gap between two windows pairs with nothing");
  ok(pairByTime(dels, t(61)) === 0,
    "a time just past a window still pairs, inside the two-second slack", String(pairByTime(dels, t(61))));

  // Ambiguity must refuse rather than guess: two windows open at once.
  const overlapping = findDelegations(loadJsonlString([
    call("a", "toolu_a", at(10)),
    call("b", "toolu_b", at(11)),
    result("ra", "toolu_a", at(90)),
    result("rb", "toolu_b", at(91)),
  ].join("\n"), "over").steps, new Map());
  ok(overlapping.length === 2, "two parallel delegations are both found");
  ok(pairByTime(overlapping, t(50)) === -1,
    "a time inside two open windows refuses to pick one");

  // summariseRun over an indexed subagent transcript
  const subLines = [];
  for (let i = 0; i < 6; i++) {
    subLines.push(i % 2 === 0
      ? JSON.stringify({ type: "assistant", sessionId: "s", agentId: "z1", uuid: "z" + i,
          timestamp: at(20 + i), isSidechain: true,
          message: { role: "assistant", id: "sm" + i, model: "claude-opus-5",
            usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 },
            content: [{ type: "tool_use", id: "st" + i, name: i === 0 ? "Bash" : "Read", input: { a: i } }] } })
      : JSON.stringify({ type: "user", sessionId: "s", agentId: "z1", uuid: "z" + i,
          timestamp: at(20 + i), isSidechain: true,
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: "st" + (i - 1),
            is_error: i === 1, content: "out" }] } }));
  }
  const sub = loadJsonlString(subLines.join("\n"), "sub");
  const run = summariseRun(sub, "z1", "time");
  ok(run.agentId === "z1" && run.pairedBy === "time", "a run carries its id and how it was matched");
  ok(run.toolCalls === 3, "a run counts its tool calls", String(run.toolCalls));
  ok(run.errors === 1, "…and its failures", String(run.errors));
  ok(run.tools[0].name === "Read" && run.tools[0].count === 2, "tools are ordered by call count",
    JSON.stringify(run.tools));
  ok(run.output === 15 && run.cacheRead === 300, "tokens are summed across the run",
    `${run.output} out, ${run.cacheRead} cached`);
  ok(run.lastT > run.firstT, "a run has a duration");
  ok(sub.steps.every((x) => x.rawType === "assistant" || x.rawType === "user"),
    "a subagent transcript parses with the same reader as a main one");

  const withRun = dels.map((d, i) => (i === 0 ? { ...d, run } : d));
  const sum = delegationSummary(withRun);
  ok(sum.total === 3 && sum.loaded === 1, "the summary counts total and loaded separately");
  ok(sum.toolCalls === 3, "…and adds up the work that was invisible", String(sum.toolCalls));
  ok(delegationSummary(dels).loaded === 0 && delegationSummary(dels).total === 3,
    "with nothing loaded it still reports that work exists elsewhere");
}

// ---------------------------------------------------------------- assertions

section("assertions");
{
  // A synthetic run per rule, so each check is exercised both ways.
  const mk = (spec) => {
    const at = (n) => new Date(Date.parse("2026-05-05T09:00:00Z") + n * 1000).toISOString();
    const L = [];
    let t = 0;
    spec.forEach(([name, opts], i) => {
      const o = opts ?? {};
      L.push(JSON.stringify({ type: "assistant", sessionId: "as", uuid: "a" + i, timestamp: at(t),
        message: { role: "assistant", id: "m" + i, model: "claude-opus-5",
          usage: { input_tokens: 10, output_tokens: 5,
            cache_read_input_tokens: o.ctx ?? 1000, cache_creation_input_tokens: 0 },
          content: [{ type: "tool_use", id: "t" + i, name, input: {} }] } }));
      t += o.secs ?? 1;
      if (o.dangling) return;
      L.push(JSON.stringify({ type: "user", sessionId: "as", uuid: "r" + i, timestamp: at(t),
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t" + i,
          is_error: !!o.err, content: "out" }] } }));
      t += 1;
    });
    const tape = loadJsonlString(L.join("\n"), "assert");
    return { tape, pairs: pairTools(tape.steps) };
  };
  const run = (spec, rule) => {
    const { tape, pairs } = mk(spec);
    return checkRule(tape.steps, rule, pairs);
  };

  ok(DEFAULT_RULES.length >= 4, "there is a default rule set", String(DEFAULT_RULES.length));
  ok(DEFAULT_RULES.every((r) => typeof ruleLabel(r) === "string" && ruleLabel(r).length > 10),
    "every rule reads as a sentence");

  // search happens before write — the rule this feature exists for
  const before = { kind: "before", first: "Grep", then: "Write" };
  ok(run([["Grep"], ["Write"]], before).pass, "a search before a write holds");
  ok(run([["Grep"], ["Write"], ["Write"]], before).pass, "…and covers every later write");
  const broke = run([["Write"], ["Grep"]], before);
  ok(!broke.pass, "a write with no search before it fails");
  ok(broke.at === 0, "…and names the offending step", String(broke.at));
  ok(/no Grep before it/.test(broke.detail), "…in words", broke.detail);
  const novac = run([["Grep"], ["Read"]], before);
  ok(novac.pass && novac.vacuous, "a run that never writes is not tested by the rule");
  ok(/never called/.test(novac.detail), "…and says so rather than claiming a pass");

  // no tool more than N times in a row
  const rep = { kind: "max-repeats", n: 2 };
  ok(run([["Bash"], ["Bash"], ["Read"]], rep).pass, "two in a row is within a limit of two");
  const tooMany = run([["Bash"], ["Bash"], ["Bash"]], rep);
  ok(!tooMany.pass, "three in a row is not");
  ok(/3 times in a row/.test(tooMany.detail), "…and counts them", tooMany.detail);
  ok(run([["Bash"], ["Read"], ["Bash"]], rep).pass, "the run resets when another tool intervenes");
  const scoped = { kind: "max-repeats", n: 1, tool: "Read" };
  ok(run([["Bash"], ["Bash"], ["Read"]], scoped).pass, "a scoped rule ignores other tools");
  ok(!run([["Read"], ["Read"]], scoped).pass, "…and still catches its own");
  ok(run([["Bash"]], scoped).vacuous, "…and is vacuous when its tool never ran");

  // context ceiling
  const ceil = { kind: "max-context", n: 5000 };
  ok(run([["Bash", { ctx: 4000 }]], ceil).pass, "context under the ceiling holds");
  const over = run([["Bash", { ctx: 4000 }], ["Bash", { ctx: 9000 }]], ceil);
  ok(!over.pass && over.at === 2, "context over it fails at the step that reached the peak",
    `at ${over.at}`);
  ok(/9,010 tokens/.test(over.detail), "…and reports the peak", over.detail);

  // slow tool call
  const slow = { kind: "max-tool-seconds", n: 10 };
  ok(run([["Bash", { secs: 3 }]], slow).pass, "a quick call holds");
  const late = run([["Bash", { secs: 45 }]], slow);
  ok(!late.pass, "a slow one does not");
  ok(/45.0 seconds/.test(late.detail), "…and reports how slow", late.detail);

  // ends clean
  const clean = { kind: "ends-clean" };
  ok(run([["Bash"], ["Read"]], clean).pass, "a run with no failures ends clean");
  const recovered = run([["Bash", { err: true }], ["Read"]], clean);
  ok(recovered.pass, "a run that failed and recovered still ends clean");
  ok(/recovered/.test(recovered.detail), "…and the recovery is reported rather than hidden",
    recovered.detail);
  const ended = run([["Read"], ["Bash", { err: true }]], clean);
  ok(!ended.pass, "a run whose last step failed does not");
  const hung = run([["Read"], ["Bash", { dangling: true }]], clean);
  ok(!hung.pass, "…nor one with a tool that never returned");
  ok(/never returned/.test(hung.detail), "…which is named as a different fault", hung.detail);

  // a redacted tape asserts exactly as well as the transcript it came from
  {
    const { tape, pairs } = mk([["Grep"], ["Write"], ["Bash", { ctx: 9000 }]]);
    const rules = [before, ceil, clean, { kind: "max-repeats", n: 2 }];
    const direct = checkAll(tape.steps, rules, pairs);
    const scrubbedTape = tapeFromFile(JSON.parse(serializeTape(redactTape(tape))));
    const viaTape = checkAll(scrubbedTape.steps, rules, pairTools(scrubbedTape.steps));
    ok(direct.map((r) => r.pass).join() === viaTape.map((r) => r.pass).join(),
      "every rule gives the same answer on a redacted tape",
      `${direct.map((r) => r.pass)} vs ${viaTape.map((r) => r.pass)}`);
  }

  const t = tally(checkAll(mk([["Grep"], ["Write"]]).tape.steps, DEFAULT_RULES,
    mk([["Grep"], ["Write"]]).pairs));
  ok(t.pass + t.fail === DEFAULT_RULES.length, "the tally adds up");

  // No rule may read a body: a redacted tape has none, and must still work.
  const assertSrc = readFileSync(join(root, "lib/assert.ts"), "utf8")
    .replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  ok(!/\bbody\b|\.preview\b/.test(assertSrc), "no rule reaches for a body or a preview");
}

// ------------------------------------------------------- session statistics

section("session statistics");
{
  // A transcript in which *every* text field is a distinctive marker. If any of
  // them reaches the statistics record, the record is not what it claims to be.
  const MARK = "ZZMARKERZZ";
  const at = (n) => new Date(Date.parse("2026-08-08T09:00:00Z") + n * 1000).toISOString();
  const lines = [
    JSON.stringify({ type: "custom-title", sessionId: "s", customTitle: MARK + "-title" }),
    JSON.stringify({ type: "ai-title", sessionId: "s", aiTitle: MARK + "-aititle" }),
    JSON.stringify({ type: "last-prompt", sessionId: "s", lastPrompt: MARK + "-prompt", leafUuid: "u0" }),
    JSON.stringify({ type: "user", sessionId: "s", uuid: "u0", timestamp: at(0), version: "9.9.9",
      cwd: "/Users/" + MARK + "/work", gitBranch: MARK + "-branch",
      message: { role: "user", content: [{ type: "text", text: MARK + "-said" }] } }),
    JSON.stringify({ type: "assistant", sessionId: "s", uuid: "u1", timestamp: at(4),
      message: { role: "assistant", id: "m1", model: "claude-opus-5",
        usage: { input_tokens: 20, output_tokens: 10, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 },
        content: [{ type: "thinking", thinking: MARK + "-thought", signature: "s" }] } }),
    JSON.stringify({ type: "assistant", sessionId: "s", uuid: "u2", timestamp: at(6),
      message: { role: "assistant", id: "m1", model: "claude-opus-5",
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: MARK + "-command" } }] } }),
    JSON.stringify({ type: "user", sessionId: "s", uuid: "u3", timestamp: at(9),
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", is_error: true,
        content: MARK + "-output" }] } }),
    JSON.stringify({ type: "attachment", sessionId: "s", uuid: "u4", timestamp: at(10),
      attachment: { type: "file", content: MARK + "-attached" } }),
    JSON.stringify({ type: "assistant", sessionId: "s", uuid: "u5", timestamp: at(12),
      message: { role: "assistant", id: "m2", model: "claude-opus-5",
        usage: { input_tokens: 20, output_tokens: 40, cache_read_input_tokens: 90000, cache_creation_input_tokens: 0 },
        content: [{ type: "tool_use", id: "t2", name: "Agent", input: { prompt: MARK + "-delegated" } }] } }),
    JSON.stringify({ type: "user", sessionId: "s", uuid: "u6", timestamp: at(40),
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: MARK + "-summary" }] } }),
  ];
  const tape = loadJsonlString(lines.join("\n"), "marked");
  const st = sessionStats(
    { project: "-a-project", session: "0000-1111", bytes: 1234, mtime: 5678 },
    tape.meta, tape.steps, tape.entries, pairTools(tape.steps),
  );

  const wire = JSON.stringify(st);
  ok(!wire.includes(MARK),
    "no text from a transcript reaches the statistics record",
    wire.includes(MARK) ? wire.slice(wire.indexOf(MARK) - 30, wire.indexOf(MARK) + 20) : "");
  ok(tape.steps.some((x) => x.preview.includes(MARK)),
    "…and the marker really was in the index it was built from");

  // Every string in the record must be an identifier or a name from the
  // writer's own vocabulary — never prose.
  const strings = [];
  const walk = (v, path) => {
    if (typeof v === "string") { strings.push([path, v]); return; }
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, path + "[" + i + "]"));
    if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, path + "." + k);
  };
  walk(st, "");
  const allowed = /^(\.project|\.session|\.models\[\d+\]|\.versions\[\d+\]|\.tools\.[^.]+|\.toolErrors\.[^.]+)$/;
  const stray = strings.filter(([path]) => !allowed.test(path));
  ok(stray.length === 0, "every string in the record is an identifier or a tool, model or version name",
    stray.map(([p]) => p).join(", "));
  ok(strings.some(([p]) => p === ".project") && strings.some(([p]) => p === ".session"),
    "a session is identified by its project directory and its id");

  // `agenttape stats` is built on these records and gets the same test the
  // pasteable report gets — the output is meant to be shared, and a corpus
  // summary that could carry a sentence would be worse than no subcommand.
  {
    const sum = summariseCorpus([st, st]);
    const asJson = JSON.stringify(sum);
    const asText = formatCorpus(sum, "~/.claude/projects");
    ok(!asJson.includes(MARK) && !asText.includes(MARK),
      "no text from a transcript reaches the corpus summary either");
    ok(tape.steps.some((x) => x.preview.includes(MARK)),
      "…and the marker really was in the records it was summarised from");

    // The session's own identifiers are allowed in a record and are not
    // allowed in a summary: a summary is about a corpus, not about a session.
    ok(!asJson.includes("-a-project") && !asJson.includes("0000-1111"),
      "…and neither does a project directory or a session id");
    ok(!asText.includes("-a-project") && !/0000-1111/.test(asText),
      "…including in the human-readable form");

    // n on every figure. A rate without its n is the over-claim this exists to
    // avoid, so the count appears beside each of the four.
    for (const [what, re] of [
      ["the failed-API share", /\d+ of 2 sessions contain one/],
      ["the idle figures", /idle over 2 sessions/],
      ["the context distribution", /of 2 passed 200k/],
      ["the compaction rate", /\d+ of 2 compacted/],
      ["the corpus size itself", /^\s*n = 2, one machine/m],
    ]) ok(re.test(asText), "the summary prints n beside " + what, asText.slice(0, 0));

    ok(/These are your numbers, not anybody else's/.test(asText),
      "…and says whose numbers they are");

    // Same rule as the session record: every string in a corpus summary must
    // be a tool name or one of this module's own labels. A summary is about a
    // corpus, so there is nothing else for a string to be.
    const strs = [];
    const dig = (v, path) => {
      if (typeof v === "string") { strs.push([path, v]); return; }
      if (Array.isArray(v)) return v.forEach((x, i) => dig(x, path + "[" + i + "]"));
      if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) dig(x, path + "." + k);
    };
    dig(sum, "");
    const named = /^(\.tools\[\d+\]\.tool|\.byClass\.(mcp|rest)\.tool)$/;
    const odd = strs.filter(([path]) => !named.test(path));
    ok(odd.length === 0, "…and every string in the summary is a tool name or a class label",
      odd.map(([p]) => p).join(", "));
    ok(strs.length > 0, "…with the check having something to check");
  }
  ok(st.tools.Bash === 1 && st.tools.Agent === 1, "tool counts are by name",
    JSON.stringify(st.tools));
  ok(st.toolErrors.Bash === 1, "…and so are their failures");
  ok(st.delegations === 1, "a delegation is counted");
  ok(st.peakCtx === 90020, "the peak context is carried", String(st.peakCtx));
  ok(st.errors >= 1 && st.idleGaps === 0, "errors and gaps are counted");

  ok(st.ctxProfile.length === 24, "the sparkline profile is a fixed width",
    String(st.ctxProfile.length));
  ok(st.ctxProfile.every((v) => typeof v === "number"), "…of numbers");
  ok(st.ctxProfile[st.ctxProfile.length - 1] >= st.ctxProfile[0],
    "…and it carries forward rather than dropping to zero");
  ok(contextProfile([]).every((v) => v === 0), "an empty run profiles as flat");

}

// ------------------------------------------------------------------ report

section("the pasteable report");
{
  // The same marker technique as the statistics record: a transcript where
  // every text field is one distinctive string, and a report that must not
  // contain it anywhere.
  const MARK = "QQLEAKQQ";
  const at = (n) => new Date(Date.parse("2026-09-09T09:00:00Z") + n * 1000).toISOString();
  const marked = loadJsonlString([
    JSON.stringify({ type: "custom-title", sessionId: "r", customTitle: MARK + "1" }),
    JSON.stringify({ type: "user", sessionId: "r", uuid: "u0", timestamp: at(0), version: "9.9.9",
      cwd: "/Users/" + MARK + "/x", gitBranch: MARK + "2",
      message: { role: "user", content: [{ type: "text", text: MARK + "3" }] } }),
    JSON.stringify({ type: "assistant", sessionId: "r", uuid: "u1", timestamp: at(3),
      message: { role: "assistant", id: "m1", model: "claude-opus-5",
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 4000, cache_creation_input_tokens: 0 },
        content: [{ type: "thinking", thinking: MARK + "4", signature: "s" }] } }),
    JSON.stringify({ type: "assistant", sessionId: "r", uuid: "u2", timestamp: at(5),
      message: { role: "assistant", id: "m1", model: "claude-opus-5",
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: MARK + "5" } }] } }),
    JSON.stringify({ type: "user", sessionId: "r", uuid: "u3", timestamp: at(9),
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", is_error: true,
        content: MARK + "6" }] } }),
    JSON.stringify({ type: "system", sessionId: "r", uuid: "u4", timestamp: at(12),
      subtype: "compact_boundary", level: "info", content: MARK + "7",
      compactMetadata: { preTokens: 4010, postTokens: 900, cumulativeDroppedTokens: 3110,
        durationMs: 100, trigger: "auto" } }),
    JSON.stringify({ type: "assistant", sessionId: "r", uuid: "u5", timestamp: at(15),
      message: { role: "assistant", id: "m2", model: "claude-opus-5",
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 890, cache_creation_input_tokens: 0 },
        content: [{ type: "tool_use", id: "t2", name: "Agent", input: { prompt: MARK + "8" } }] } }),
    JSON.stringify({ type: "user", sessionId: "r", uuid: "u6", timestamp: at(40),
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: MARK + "9" }] } }),
  ].join("\n"), MARK + "-label.jsonl");

  const mPairs = pairTools(marked.steps);
  const mSum = summarise(marked);
  const md = markdownReport({
    tape: marked, summary: mSum,
    trace: traceJump(marked.steps, mSum.jumpAt, mSum.jumpBy),
    delegations: findDelegations(marked.steps, mPairs),
    assertions: checkAll(marked.steps, DEFAULT_RULES, mPairs),
    pairs: mPairs,
    shownIndex: (i) => i + 1,
  });

  ok(!md.includes(MARK), "no text from a transcript reaches the report",
    md.includes(MARK) ? md.slice(md.indexOf(MARK) - 40, md.indexOf(MARK) + 20) : "");
  ok(marked.steps.some((x) => x.preview.includes(MARK)),
    "…and the marker really was in the index it was built from");

  // It has to actually say the useful things, or "leaks nothing" is trivial.
  for (const [what, re] of [
    ["the step and turn counts", /\| steps \| /],
    ["the tool breakdown", /\| tool \| calls \| failed \|/],
    ["the failures with their step numbers", /## Failures/],
    ["the tool that failed, by name", /\| `Bash` \|/],
    ["the context profile", /peak /],
    ["the compaction", /Compacted 1 time/],
    ["the delegation", /1 delegation/],
    ["the assertions", /## Assertions/],
    ["where it came from", /AgentTape/],
  ]) {
    ok(re.test(md), "the report carries " + what);
  }
  ok(!/preview|summary of the step/i.test(md), "…and no step summaries");

  ok(sparkline([]) === "", "an empty profile has no sparkline");
  ok(sparkline([0, 0, 0]) === "", "a flat zero profile has none either");
  ok(sparkline([1, 2, 3, 4]).length === 4, "a profile becomes one block per point");
  ok([...sparkline([1, 8])].every((c) => "▁▂▃▄▅▆▇█".includes(c)),
    "…drawn only from blocks that survive a paste");

  const reportSrc = readFileSync(join(root, "lib/report.ts"), "utf8")
    .replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  ok(!/\.preview\b|\bbody\b/.test(reportSrc), "the report module never reaches for a body or a preview");
}

// ---------------------------------------------------------------- rule sets

section("rule sets");
{
  const full = {
    format: RULES_FORMAT,
    name: "a set",
    note: "written by a person",
    rules: [...DEFAULT_RULES, { kind: "before", first: "Grep", then: "Write" },
      { kind: "max-repeats", n: 2, tool: "Bash" }],
  };
  const text = serializeRuleSet(full);
  const back = parseRuleSet(text);
  ok(back.problems.length === 0, "a set this codebase wrote parses with no complaints",
    back.problems.join("; "));
  ok(JSON.stringify(back.set.rules) === JSON.stringify(full.rules), "…and round trips exactly");
  ok(back.set.name === "a set" && back.set.note === "written by a person",
    "…keeping the prose a person wrote");
  ok(text.split("\n").filter((l) => l.startsWith("    {")).length === full.rules.length,
    "one rule per line, so a diff on a set reads as a diff on expectations",
    String(text.split("\n").filter((l) => l.startsWith("    {")).length));

  // Every rejection names the rule rather than throwing.
  const bad = parseRuleSet(JSON.stringify({
    format: "something-else",
    rules: [{ kind: "max-context" }, { kind: "invented" }, {}, "not an object",
      { kind: "before", first: "A" }, { kind: "max-repeats", n: -3 }],
  }));
  ok(bad.set.rules.length === 0, "nothing unusable is kept");
  ok(bad.problems.length === 7, "every problem is reported, not just the first",
    String(bad.problems.length));
  ok(bad.problems.some((p) => /format is "something-else"/.test(p)), "…including a wrong format");
  ok(bad.problems.some((p) => /rules\[1\]: unknown rule kind "invented"/.test(p)),
    "…naming the index and the kind");
  ok(bad.problems.some((p) => /rules\[5\]/.test(p)), "…and rejecting a negative number");
  ok(parseRuleSet("{not json").problems.some((p) => /not valid JSON/.test(p)),
    "garbage is reported as garbage");
  ok(parseRuleSet(null).problems.includes("not a JSON object"), "so is nothing at all");
  ok(parseRule({ kind: "ends-clean" }, "x").rule.kind === "ends-clean",
    "a rule with no parameters needs none");

  // The committed fixtures, and the CI that uses them.
  const rulesPath = join(root, "fixtures/expectations.rules.json");
  ok(existsSync(rulesPath), "the fixture rule set is committed");
  const fixSet = parseRuleSet(readFileSync(rulesPath, "utf8"));
  ok(fixSet.problems.length === 0, "…and parses clean", fixSet.problems.join("; "));
  ok(fixSet.set.rules.length >= 5, "…with a rule of every kind in it",
    String(fixSet.set.rules.length));
  ok(new Set(fixSet.set.rules.map((r) => r.kind)).size === 5,
    "…covering all five kinds", [...new Set(fixSet.set.rules.map((r) => r.kind))].join(","));

  for (const [name, wantFail] of [["passing", false], ["failing", true]]) {
    const f = join(root, `fixtures/${name}.tape.json`);
    ok(existsSync(f), `the ${name} fixture tape is committed`);
    const raw = JSON.parse(readFileSync(f, "utf8"));
    const tape = tapeFromFile(raw);
    const res = checkAll(tape.steps, fixSet.set.rules, pairTools(tape.steps));
    const t = tally(res);
    if (wantFail) {
      ok(t.fail === fixSet.set.rules.length,
        "the failing fixture breaks every rule, so CI proves the non-zero exit",
        `${t.fail} of ${res.length}`);
    } else {
      ok(t.fail === 0, "the passing fixture holds every rule", `${t.fail} failed`);
      ok(t.vacuous === 0, "…and none of them was vacuous", `${t.vacuous} vacuous`);
    }
  }

  const ci = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  ok(/agenttape\.mjs check .*passing\.tape\.json/.test(ci),
    "CI checks the passing fixture");
  ok(/agenttape\.mjs check .*failing\.tape\.json/.test(ci) && /exit 1/.test(ci),
    "…and fails the build if the failing one is not rejected");

  const cli = readFileSync(join(root, "bin/agenttape.mjs"), "utf8");
  ok(/argv\[0\] === "check"/.test(cli), "the checker is a subcommand of the one binary");
  ok(/t\.fail \? 1 : 0/.test(cli), "…and its exit code is the count of failures");
  ok(!existsSync(join(root, "bin/agenttape-check.mjs")), "there is no second binary");
}

// ---------------------------------------------------------------- comparison

section("comparing two runs");
{
  // Spines are built from tool names alone. These fixtures give every run
  // completely different prose, so a textual comparison would call them
  // different immediately — which is the failure mode the rule avoids.
  const runOf = (tools, prose) => {
    const at = (n) => new Date(Date.parse("2026-04-04T09:00:00Z") + n * 1000).toISOString();
    const L = [JSON.stringify({ type: "user", sessionId: "c", uuid: "u0", timestamp: at(0),
      message: { role: "user", content: [{ type: "text", text: prose }] } })];
    tools.forEach((name, i) => {
      L.push(JSON.stringify({ type: "assistant", sessionId: "c", uuid: "a" + i, timestamp: at(i * 10 + 1),
        message: { role: "assistant", id: "m" + i, model: "claude-opus-5",
          usage: { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 100 * i, cache_creation_input_tokens: 0 },
          content: [{ type: "tool_use", id: "t" + i, name, input: { note: prose + i } }] } }));
      L.push(JSON.stringify({ type: "user", sessionId: "c", uuid: "r" + i, timestamp: at(i * 10 + 5),
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t" + i, content: prose + " out " + i }] } }));
    });
    return loadJsonlString(L.join("\n"), "run");
  };

  const A = runOf(["Read", "Bash", "Edit", "Bash"], "the quick brown fox jumps");
  const same = runOf(["Read", "Bash", "Edit", "Bash"], "a completely different sentence entirely");
  ok(buildSpine(A.steps).map((e) => e.tool).join(",") === "Read,Bash,Edit,Bash",
    "the spine is the tools, in order");
  ok(buildSpine(A.steps).length === 4, "…and nothing else");

  const ident = compareSpines(buildSpine(A.steps), buildSpine(same.steps));
  ok(ident.verdict === "identical",
    "two runs with the same tools and totally different words are identical to this rule");
  ok(ident.agreed === 4 && ident.at === -1, "…with nothing to mark");
  // It used to say "What they said differs", which is a claim about text from
  // a comparison that never reads text — and two runs of the *same* file came
  // back with it. What it may say is what it did: the words were not compared.
  ok(/Message contents are not compared/.test(verdictLine(ident)),
    "…and the verdict says what was compared rather than guessing about the rest");
  ok(!/differ/i.test(verdictLine(ident)),
    "…and claims nothing about text it never read", verdictLine(ident));

  const forked = runOf(["Read", "Bash", "Write", "Write"], "third run");
  const d = compareSpines(buildSpine(A.steps), buildSpine(forked.steps));
  ok(d.verdict === "diverged", "a different tool is a divergence");
  ok(d.at === 2 && d.agreed === 2, "…found at the first position that differs", `at ${d.at}`);
  ok(d.a.tool === "Edit" && d.b.tool === "Write", "…and both sides are reported",
    `${d.a?.tool} vs ${d.b?.tool}`);
  ok(d.realignOffset === -1, "a genuine fork does not realign");
  ok(d.realignSide === "", "…and names no side");
  ok(/a different path rather than a shifted one/.test(realignLine(d)),
    "…and says that everything after is a different path, not a shifted one");

  // A substitution: the same call in the same place, a different tool for it,
  // and the rest carrying on in step. Reporting this as a fork was wrong and
  // alarming, so offset zero is checked before any shift.
  const swapped = runOf(["Read", "Bash", "Write", "Bash"], "swap run");
  const sub = compareSpines(buildSpine(A.steps), buildSpine(swapped.steps));
  ok(sub.verdict === "diverged" && sub.at === 2, "a swapped tool is a divergence at that call");
  ok(sub.realignOffset === 0 && sub.realignSide === "",
    "…recognised as a substitution, not a shift", `${sub.realignOffset}/${sub.realignSide}`);
  ok(/swapped a single step rather than forking/.test(realignLine(sub)),
    "…and described as one swapped step");
  ok(/there may be later ones/.test(realignLine(sub)),
    "…while admitting only the first divergence is reported");

  // An insertion: B does one extra call, then carries on identically.
  const inserted = runOf(["Read", "Bash", "Grep", "Edit", "Bash"], "fourth run");
  const ins = compareSpines(buildSpine(A.steps), buildSpine(inserted.steps));
  ok(ins.verdict === "diverged", "an inserted call still reads as a divergence");
  ok(ins.at === 2, "…at the insertion point");
  ok(ins.realignOffset === 1 && ins.realignSide === "b",
    "…but the runs are seen to line up again one call later",
    `${ins.realignSide} +${ins.realignOffset}`);
  ok(/insertion, not a fork/.test(realignLine(ins)), "…and that is stated rather than implied");

  // One run stops early.
  const short = runOf(["Read", "Bash"], "fifth run");
  const ended = compareSpines(buildSpine(A.steps), buildSpine(short.steps));
  ok(ended.verdict === "b-ended", "a run that stops first is named", ended.verdict);
  ok(ended.agreed === 2 && ended.b === null, "…and its side of the divergence is empty");
  ok(/run B stopped/.test(verdictLine(ended)), "…in words");
  const ended2 = compareSpines(buildSpine(short.steps), buildSpine(A.steps));
  ok(ended2.verdict === "a-ended", "…and the other way round");

  // A swap on the last call in both runs: there is nothing after it to line up.
  const lastSwapA = runOf(["Read", "Edit"], "ninth");
  const lastSwapB = runOf(["Read", "Write"], "tenth");
  const tail0 = compareSpines(buildSpine(lastSwapA.steps), buildSpine(lastSwapB.steps));
  ok(tail0.realignOffset === 0, "a swap on the final call is still a substitution");
  ok(/last tool call in both runs/.test(realignLine(tail0)),
    "…and says there is nothing after it, rather than claiming a realignment",
    realignLine(tail0));

  // Degenerate: a run with no tool calls at all.
  const quiet = runOf([], "sixth run");
  const none = compareSpines(buildSpine(A.steps), buildSpine(quiet.steps));
  ok(none.verdict === "no-spine", "a run that never called a tool cannot be aligned");
  ok(/cannot be aligned/.test(verdictLine(none)), "…and the UI is told to say exactly that");
  ok(realignLine(none) === "", "…with no caveat about realignment");

  // Very different lengths must not throw or claim a false divergence.
  const long = runOf(Array.from({ length: 200 }, (_, i) => (i % 2 ? "Bash" : "Read")), "seventh");
  const tiny = runOf(["Read"], "eighth");
  const lop = compareSpines(buildSpine(long.steps), buildSpine(tiny.steps));
  ok(lop.verdict === "b-ended" && lop.agreed === 1,
    "a 200-call run against a 1-call run agrees for one call and says the short one ended",
    `${lop.verdict} after ${lop.agreed}`);
  ok(lop.lenA === 200 && lop.lenB === 1, "…and both lengths are reported");

  // The comparison must never read a body.
  const cmpSrc = readFileSync(join(root, "lib/compare.ts"), "utf8");
  ok(!/\bbody\b/.test(cmpSrc.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")),
    "the comparison never reaches for a body");
  ok(!/\.preview\b/.test(cmpSrc), "…and does not compare previews either");
}

// ---------------------------------------------------------------- jump trace

section("context jump attribution");
{
  const t = traceJump(tape.steps, S.jumpAt, S.jumpBy);
  ok(!!t, "the marked jump can be traced");
  ok(t.by === S.jumpBy && t.at === S.jumpAt, "the trace describes the step the summary marked");
  ok(t.level === tape.steps[S.jumpAt].ctx, "the level is the context immediately after the jump");
  ok(t.resent === t.turnsSince * t.by, "the re-reading cost is turns times payload");
  ok(t.stepsSince >= 0 && t.turnsSince >= 0, "the counts are not negative");

  // The fixture compacts from 90,700 to 12,000, so the payload demonstrably
  // leaves the array — and the writer says why, which is the difference
  // between reporting a fact and guessing at one.
  ok(t.fellAt > t.at, "the trace finds where the context fell back", String(t.fellAt));
  ok(t.fellToCompaction === true, "and attributes it to the recorded compaction");

  ok(traceJump(tape.steps, 0, 0) === null, "a tape with no jump has no trace");
  ok(traceJump(tape.steps, 5, -1) === null, "a negative jump has no trace");

  // A tape with no usage anywhere cannot be traced, and must say so rather
  // than inventing a number.
  const blind = loadJsonlString([
    JSON.stringify({ type: "user", timestamp: "2026-02-02T08:00:00Z", uuid: "b1",
      message: { role: "user", content: [{ type: "text", text: "no usage anywhere" }] } }),
    JSON.stringify({ type: "user", timestamp: "2026-02-02T08:00:01Z", uuid: "b2",
      message: { role: "user", content: [{ type: "text", text: "still none" }] } }),
  ].join("\n"), "blind");
  const bt = traceJump(blind.steps, 1, 100);
  ok(bt !== null && bt.unknown === true, "a tape with no context figures reports that it cannot say");
  ok(bt.stepsSince === 0 && bt.turnsSince === 0, "…and claims nothing");
}

// ---------------------------------------------------------------- step delta

section("step delta");
{
  const cum = cumulativeChars(tape.steps);
  const at = (i) => deltaAt(tape.steps, cum, i);

  ok(at(999999) === null, "a step past the end has no delta");
  ok(at(0).ctxBefore === 0, "the first step starts from an empty context");
  ok(at(0).newEntry === true, "the first step opens the array");

  ok(cum[tape.steps.length] === tape.steps.reduce((a, s) => a + s.chars, 0),
    "the running character total is the sum of every step");
  const last = at(tape.steps.length - 1);
  ok(last.charsSoFar === cum[tape.steps.length], "the last step reports the whole total");

  // Three assistant lines share one message.id, so the first opens an entry and
  // the next two extend it. That is the distinction the readout exists to make.
  const group = tape.entries.find((e) => e.to > e.from);
  ok(!!group, "the fixture has an entry built from several lines");
  ok(at(group.from).newEntry === true, "the first line of a group appends an entry");
  ok(at(group.from + 1).newEntry === false, "the next line extends it rather than appending");
  ok(at(group.from + 1).entry === group.i, "…and reports the same entry");

  // The context delta must be signed, since a compaction makes it negative.
  const compactStep = tape.steps.find((s) => s.compact);
  const after = tape.steps.find((s) => s.i > compactStep.i && s.usage);
  if (after) {
    const d = at(after.i);
    ok(d.ctxDelta === d.ctxAfter - d.ctxBefore, "the context delta is the difference it claims");
  }
  const jump = at(S.jumpAt);
  ok(jump.ctxDelta === S.jumpBy, "the delta at the marked jump matches the summary", `${jump.ctxDelta} vs ${S.jumpBy}`);

  const carried = at(group.from);
  ok(carried.chars === tape.steps[group.from].chars, "the delta carries this step's characters, not the entry's");
}

// ---------------------------------------------------------------- the demo

section("demo tape");
const demoPath = join(root, "public", "demo.tape.json");
ok(existsSync(demoPath), "public/demo.tape.json is committed");
if (existsSync(demoPath)) {
  const demo = tapeFromFile(JSON.parse(readFileSync(demoPath, "utf8")));
  const ds = summarise(demo);
  ok(demo.steps.length >= 20 && demo.steps.length <= 40, "the demo is about 25 steps", `${demo.steps.length}`);
  ok(ds.errors >= 2, "the demo has at least two failures", `${ds.errors}`);
  ok(ds.jumpBy > 20000, "the demo has a context blow-up", `+${ds.jumpBy}`);
  ok(ds.idleGaps >= 1 && ds.longestGapMs > 20 * 60000, "the demo has a long idle gap",
    `${Math.round(ds.longestGapMs / 60000)} min`);
  ok(ds.tools.length >= 3, "the demo exercises several tools", ds.tools.map((t) => t.name).join(","));
  ok(demo.meta.redacted === false, "the demo is not marked redacted — it has real bodies");
  const first = JSON.parse(readFileSync(demoPath, "utf8"));
  ok(first.bodies && Object.keys(first.bodies).length >= 20,
    "the demo carries readable bodies rather than placeholders",
    `${Object.keys(first.bodies ?? {}).length} bodies`);

  // Every feature needs something to show, or it cannot be demonstrated and
  // cannot be asserted against in the browser either.
  ok(ds.compactAt.length >= 1, "the demo has a compaction", String(ds.compactAt.length));
  const demoDels = findDelegations(demo.steps, pairTools(demo.steps));
  ok(demoDels.length >= 1, "the demo has a delegation", String(demoDels.length));
  ok(demoDels.every((d) => d.run === null), "…whose transcript is deliberately absent");
  const demoTrace = traceJump(demo.steps, ds.jumpAt, ds.jumpBy);
  ok(demoTrace.fellToCompaction === true,
    "the demo exercises the dropped-at-the-compaction branch of the attribution");
  ok(ds.tools.length >= 4, "the demo calls several tools", ds.tools.map((t) => t.name).join(","));
  const demoFx = buildFilterIndex(demo.steps, pairTools(demo.steps));
  ok(demoFx.tools.some((t) => t.name === "Agent"), "…including one that delegates");
  ok(demo.steps.some((x) => x.chars > 1000), "the demo has a step big enough for the size filter");
}

// ---------------------------------------------------------------- repository

section("repository");
const read = (p) => (existsSync(join(root, p)) ? readFileSync(join(root, p), "utf8") : "");

const gitignore = read(".gitignore");
ok(/^\*\.jsonl$/m.test(gitignore), ".gitignore refuses *.jsonl at the repository root");
ok(/^fixtures\/real\/$/m.test(gitignore), ".gitignore refuses fixtures/real/");
ok(/^\*\.tape\.json$/m.test(gitignore), ".gitignore refuses stray *.tape.json");
ok(/^!public\/demo\.tape\.json$/m.test(gitignore), ".gitignore keeps the demo tape");

const pkg = JSON.parse(read("package.json"));
ok(Object.keys(pkg.dependencies).length === 3, "three runtime dependencies, as in AgentLab",
  Object.keys(pkg.dependencies).join(","));
ok(!existsSync(join(root, "LICENSE")), "no LICENSE file");

const readme = read("README.md");
ok(readme.trim().endsWith("© 2026 Weiren Feng. All rights reserved."),
  "the README ends with the copyright line");
ok(/never leave (this|your) machine/i.test(readme.slice(0, 1400)),
  "the README states on the first screen that transcripts never leave the machine");
ok(/roadmap/i.test(readme), "the README has a roadmap");
for (const item of ["live recording", "OpenAI"]) {
  ok(readme.toLowerCase().includes(item.toLowerCase()), "the roadmap names: " + item);
}

// The limits section is load-bearing: it is the difference between a tool that
// can be trusted about what it does not do and one that implies it does
// everything. Each of these is a limit somebody could otherwise be caught by.
const limits = readme.slice(readme.indexOf("## Limits"), readme.indexOf("## Roadmap"));
ok(limits.length > 1500, "the README has a limits section of some substance",
  `${limits.length} chars`);
for (const [what, re] of [
  ["search covers summaries, not full text", /summar(y|ies), not full text|not full text/i],
  ["comparison aligns structurally by a stated rule", /aligns by tool-call sequence/i],
  ["a nested subagent run shows less than a top-level one", /nested subagent run shows less/i],
  ["subagent pairing falls back to the clock", /paired by time|falls back to the clock/i],
  ["the format came from three transcripts on one machine", /three transcripts/i],
  ["…written by several writer versions", /writer versions/i],
  ["a redacted tape keeps tool names on purpose", /keeps tool names/i],
  ["assertions can only be about shape", /only be about shape/i],
  ["what the in-page suite can and cannot see, now that it runs in CI",
    /covers what a browser can see, and nothing else/i],
  ["the comparison's blind spot", /blind spot follows from the rule/i],
  ["what a nested run still does not show", /nested run is not the whole workbench/i],
  ["that cross-session statistics need the helper or a granted folder",
    /statistics come from the helper, or from a folder you grant/i],
  ["…and that a deployed build loses the helper and only the helper",
    /deployment loses the helper and nothing else/i],

  ["what the session cache trusts", /trusts size and mtime/i],
  ["that an assertion can only be about shape", /assertion can only be about shape/i],
  ["that a report and a rule set carry tool names", /carry tool names/i],
]) {
  ok(re.test(limits), "the limits section states: " + what);
}

// The format reference is the piece most likely to outlive the app, so it is
// held to being usable by a stranger rather than being my working notes.
const fmt = read("docs/format-notes.md");
ok(fmt.length > 8000, "the format reference has some substance", `${fmt.length} chars`);
for (const [what, re] of [
  ["that a line is a block, not a message", /a line is one content \*\*block\*\*/i],
  ["that isSidechain is always false in a main file", /isSidechain` is `false` on every record/i],
  ["that timestamps run backwards", /Timestamps run backwards/i],
  ["that a session is not a sitting", /A session is not a sitting/i],
  ["where the files live", /~\/\.claude\/projects/],
  ["the record types", /file-history-snapshot/],
  ["that is_error is usually absent", /is_error` is usually absent/i],
  ["that tool_result.content is sometimes an array", /not always a string/i],
  ["what <synthetic> means", /<synthetic>` is not a model/i],
  ["how subagents link to their parent", /only link to the parent/i],
  ["the four failure signals", /Failure is four different signals/i],
  ["what it does not know", /What this document does not know/i],
  ["what a session is on disk", /What a session is, on disk/i],
  ["that a folder is per working directory, not per conversation", /one directory per working directory/i],
  ["what entrypoint is", /`entrypoint`, naming the client/i],
  ["that one file can carry two clients", /can carry two values/i],
  ["that sessionId changes on resume", /Resuming mints a new `sessionId`/i],
  ["that the filename, not sessionId, keys a conversation", /Key a conversation by its filename/i],
  ["what tool-results holds", /tool-results\/<id>\.txt/],
  ["that deleting leaves the transcript in place", /desktop-released\.json/],
  ["what memory/ is", /memory\/` sits beside the transcripts/],
]) {
  ok(re.test(fmt), "the format reference states: " + what);
}
// The reference is rendered from the file, not from a second copy of the prose.
// A module holding the same words would be a second thing to keep true, and one
// of the two would rot.
const fmtPage = read("app/format/page.tsx");
ok(existsSync(join(root, "app/format/page.tsx")), "the format reference has a page");
ok(/docs", "format-notes\.md"/.test(fmtPage) || /format-notes\.md/.test(fmtPage),
  "…which renders the canonical file rather than a copy of it");
ok(Object.keys(pkg.dependencies).length === 3, "still three runtime dependencies",
  Object.keys(pkg.dependencies).join(","));
ok(!/marked|markdown-it|remark|micromark|mdx/i.test(JSON.stringify(pkg)),
  "…and none of them is a Markdown library");

// The reader itself, against the file it exists for.
{
  const blocks = parseMarkdown(fmt);
  const kinds = new Set(blocks.map((b) => b.b));
  for (const k of ["heading", "para", "code", "table", "list", "hr"]) {
    ok(kinds.has(k), "the reader produces a " + k + " from the reference");
  }
  const h2 = headings(blocks).filter((h) => h.level === 2);
  ok(h2.length >= 10, "…and a contents list from its sections", String(h2.length));
  ok(new Set(h2.map((h) => h.slug)).size === h2.length, "…whose anchors are unique");

  const tables = blocks.filter((b) => b.b === "table");
  // Picking the first table couples this to where a section happens to sit in
  // the document; a new section above the old one moved it and the assertion
  // failed on a table it was never about. Take the largest, and require every
  // table to be structurally whole rather than only the one we sampled.
  const table = tables.reduce((a, b) =>
    b.head.length * b.rows.length > a.head.length * a.rows.length ? b : a);
  ok(table.head.length >= 3 && table.rows.length >= 5, "a table keeps its head and its rows",
    `${table.head.length} columns, ${table.rows.length} rows`);
  ok(tables.every((t) => t.head.length >= 2 && t.rows.length >= 1),
    "…and every table in the reference has a head and at least one row",
    `${tables.length} tables`);
  const code = blocks.filter((b) => b.b === "code");
  ok(code.every((c) => !c.text.includes("```")), "a fence never leaks into its own body");

  // Nothing may render as raw markup, which is the whole failure mode of a
  // hand-written reader.
  const flat = blocks.map((b) =>
    b.b === "code" ? "" :
    b.b === "table" ? [...b.head, ...b.rows.flat()].map(plainText).join(" ") :
    b.b === "list" ? b.items.map(plainText).join(" ") :
    b.b === "hr" ? "" : plainText(b.text)).join("\n");
  for (const marker of ["**", "```", "| --- |"]) {
    ok(!flat.includes(marker), `no raw "${marker}" survives into the rendered text`);
  }

  // Code spans win over emphasis, which is the case this document is full of.
  const spans = parseInline("a `**not bold**` and **bold** and *em* and [x](y)");
  ok(spans.find((n) => n.t === "code")?.v === "**not bold**",
    "asterisks inside a code span stay asterisks");
  ok(spans.some((n) => n.t === "strong") && spans.some((n) => n.t === "em"),
    "…while emphasis outside one still works");
  ok(spans.find((n) => n.t === "link")?.href === "y", "…and a link keeps its target");
  ok(plainText(parseInline("`a` **b** *c*")) === "a b c", "plain text strips the markers");
  ok(slugify("usage — assistant records only") === "usage-assistant-records-only",
    "a heading becomes a usable anchor", slugify("usage — assistant records only"));
  ok(parseMarkdown("").length === 0, "an empty document produces nothing");
}

ok(/rules\.md/.test(readme), "the README points at the rule-set format");
ok(/format-notes\.md/.test(readme), "…and at the transcript format");

// walk every source file we ship
// Build output, not source. Both directories, because splitting the dev build
// out of `.next` immediately put a second one on disk and every privacy check
// in this file started reporting Next's own bundles — which is the check
// working, and a reminder that this list is part of the split rather than an
// afterthought to it.
const skip = new Set(["node_modules", ".next", ".next-dev", ".git", "out"]);
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(p);
  }
})(root);

const proseCopies = files
  .map((f) => f.replace(root, ""))
  .filter((f) => /\.(ts|tsx)$/.test(f) && readFileSync(join(root, f), "utf8")
    .includes("A line is one content"));
ok(proseCopies.length === 0, "no TypeScript module holds a second copy of the prose",
  proseCopies.join(", "));

ok(!files.some((f) => f.endsWith(".jsonl")), "no .jsonl file is present in the tree",
  files.filter((f) => f.endsWith(".jsonl")).join(","));

const sources = files.filter((f) => /\.(ts|tsx|mjs|js|css|md|json)$/.test(f) && !f.includes("package-lock"));
const homeLeaks = [];
const uuidLeaks = [];
const remoteUrls = [];
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
for (const f of sources) {
  const body = readFileSync(f, "utf8");
  // The two things that would actually give away a transcript: this machine's
  // home directory, and a session id. Neither may appear anywhere.
  if (body.includes(homedir())) homeLeaks.push(f.replace(root, ""));
  if (UUID.test(body)) uuidLeaks.push(f.replace(root, ""));
  // Only code that ships to the browser or runs the helper can make a request.
  // next-env.d.ts is generated, and prose is allowed to cite a URL.
  const shipped = /\/(app|lib|bin|scripts|public)\//.test(f);
  if (!shipped) continue;
  for (const m of body.matchAll(/https?:\/\/([A-Za-z0-9._-]+)/g)) {
    const host = m[1];
    if (host === "127.0.0.1" || host === "localhost" || host.endsWith(".invalid") ||
        host === "www.w3.org") continue;
    remoteUrls.push(f.replace(root, "") + ": " + host);
  }
}
ok(homeLeaks.length === 0, "no file contains this machine's home directory", homeLeaks.join(", "));
ok(uuidLeaks.length === 0, "no file contains anything shaped like a session id", uuidLeaks.join(", "));

// Session ids are uuids and subagent ids are not — an agent id is a bare run of
// hex, which the uuid check above sails straight past. This one caught a real
// one: the doc comment on agentIdFromName was written with an id copied out of
// my own subagents directory, in a repository that is public.
//
// The invariant is that no shipped file contains a run of eight or more hex
// characters that includes a letter. Placeholders are written as digits so they
// keep it. package-lock is exempt: its hex comes from upstream version strings.
const HEXY = /\b(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/;
const hexLeaks = [];
for (const f of sources) {
  if (f.includes("package-lock")) continue;
  for (const [i, lineText] of readFileSync(f, "utf8").split("\n").entries()) {
    if (HEXY.test(lineText)) hexLeaks.push(`${f.replace(root, "")}:${i + 1}`);
  }
}
ok(hexLeaks.length === 0,
  "no file contains a bare run of hex that could be a session or agent id",
  hexLeaks.slice(0, 4).join(", "));

// Committed tapes are a new class of artefact this round. Exactly one of them
// is allowed to carry readable text — the demo, which is fiction written by
// hand. Every other committed tape must be scrubbed to structure, so that
// adding one cannot leak by accident.
const committedTapes = files
  .filter((f) => f.endsWith(".tape.json"))
  .map((f) => f.replace(root, ""));
ok(committedTapes.length > 0, "there are committed tapes to check", committedTapes.join(", "));

// Corpus notes are a new class of artefact this round: derived from every
// transcript on one machine, containing no message text but describing how one
// person works. Whether that is published is their call, so the default is that
// it is not — and the default has to be enforced rather than remembered.
ok(/^docs\/corpus-notes\.md$/m.test(gitignore),
  "the corpus notes are ignored by name");
// The file may well be on disk — it is meant to be. What must be true is that
// git is told to ignore it, which is checked above, and that nothing else in
// the tree has copied it somewhere the ignore rule does not reach.
const strayCorpus = files
  .map((f) => f.replace(root, ""))
  .filter((f) => /corpus-notes/.test(f) && f !== "docs/corpus-notes.md" && f !== "scripts/corpus-notes.mjs");
ok(strayCorpus.length === 0, "…and no copy of them sits outside that path",
  strayCorpus.join(", "));
const corpusSrc = existsSync(join(root, "scripts/corpus-notes.mjs"))
  ? readFileSync(join(root, "scripts/corpus-notes.mjs"), "utf8") : "";
ok(corpusSrc !== "", "the script that produces them is committed, so the figures can be redone");
ok(!/readFile|createReadStream|readdir|homedir/.test(corpusSrc),
  "…and it opens nothing itself: it reads the statistics index on stdin and no more");

// The write-up, which is published now. It was withheld for four rounds because
// it was a draft, not because the content could not be published — and the
// thing that changed is that the two rates in it are stated as an invitation
// with the tool that produces them attached, rather than as results.
{
  const gen = existsSync(join(root, "scripts/findings.mjs"))
    ? readFileSync(join(root, "scripts/findings.mjs"), "utf8") : "";
  ok(gen !== "", "the script that writes the article is committed, so the figures can be redone");
  ok(!/readFile|createReadStream|readdir|homedir/.test(gen),
    "…and it opens nothing itself: the summary arrives on stdin");
  ok(!/parser\.ts|loadJsonl|createIndexer/.test(gen),
    "…and parses nothing, so no path it is built through has held a sentence");

  const art = read("docs/findings.md");
  ok(art !== "", "the article is committed");
  ok(!/\/Users\/|~\/\.claude/.test(art), "…and names no path");
  ok(!/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/.test(art),
    "…and no session id");
  // Every backticked token in it has to be a tool name, a field name from the
  // format, or a command. A project directory would show up here.
  const ticked = [...art.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);
  // A tool name, a field name, a field-and-value pair from the format, or a
  // command. Anything else in backticks would be somebody's project directory.
  const okToken = /^(mcp__[A-Za-z0-9_]+|[A-Za-z_][A-Za-z0-9_]*(: (true|"[a-z]+"))?|<synthetic>|node bin\/agenttape\.mjs stats|agenttape stats)$/;
  const oddTokens = ticked.filter((t) => !okToken.test(t));
  ok(ticked.length > 5 && oddTokens.length === 0,
    "…and every name in it is a tool, a field or a command", oddTokens.join(", "));

  ok(/n=\d+, one machine, one person/.test(art),
    "…and it states the sample size in its own voice rather than in a footnote");
  ok(/does not depend on my corpus/.test(art),
    "findings 1 and 2 say why they do not rest on the sample size");
  ok(/would not defend it in\s*\n?public as a general claim/.test(art) &&
     /weakest of the four/.test(art),
    "…and 3 and 4 say the opposite, in the author's own voice");
  const points = (art.match(/agenttape(\.mjs)? stats/g) ?? []).length;
  ok(points >= 4, "…and point at the subcommand that lets a reader answer them", String(points));
  ok(/## What this does not establish/.test(art),
    "the caveat is a section rather than a footnote");
  ok(!/^docs\/findings\.md$/m.test(gitignore), "and the article is not ignored");
}
for (const rel of committedTapes) {
  const raw = JSON.parse(readFileSync(join(root, rel), "utf8"));
  if (rel === "public/demo.tape.json") {
    ok(raw.redacted === false, "the demo tape is the one that carries text, and admits it");
    continue;
  }
  ok(raw.redacted === true, `${rel} is scrubbed to structure`);
  ok(raw.bodies === undefined, `${rel} carries no bodies`);
  const bad = auditRedacted(raw);
  ok(bad.length === 0, `${rel} passes the slot-by-slot audit`, bad.slice(0, 3).join(", "));
}
ok(remoteUrls.length === 0, "no shipped file names a host other than 127.0.0.1",
  remoteUrls.join(", "));

// Console hygiene, asserted structurally because a warning is invisible to a
// test suite. Only app/canvas.ts may create a 2D context, since the options are
// honoured on the first call only and a second caller would silently get the
// wrong kind of canvas.
const canvasCallers = sources
  .filter((f) => f.includes("/app/") && !f.endsWith("canvas.ts"))
  .filter((f) => /getContext\s*\(/.test(readFileSync(f, "utf8")));
ok(canvasCallers.length === 0, "only app/canvas.ts creates a 2D context",
  canvasCallers.map((f) => f.replace(root, "")).join(","));
const canvasSrc = read("app/canvas.ts");
ok(/willReadFrequently/.test(canvasSrc), "the context helper decides about readback");
ok(/has\("selftest"\)/.test(canvasSrc),
  "…and only asks for a readable canvas when the self-test will read it");

// ---------------------------------------------------------------- the visual system, measured
//
// A palette is a promise about legibility, and the only thing that keeps a
// promise like that through a redesign is a measurement. scripts/contrast.mjs
// resolves every foreground against the surface it is actually painted on and
// computes the WCAG ratio; this runs it, so a token nobody checked cannot
// reach the interface.

{
  const tokens = read("app/tokens.css");
  ok(tokens !== "", "the colours live in one file");
  ok(/\[data-theme="dark"\]/.test(tokens) && /\[data-theme="light"\]/.test(tokens),
    "…with both themes in it");
  ok(/@import "\.\/tokens\.css"/.test(read("app/globals.css")),
    "…and the stylesheet takes them from there rather than restating them");

  // Every colour a component uses is a role. A hex value in a component is a
  // colour that no measurement can find, which is how an unreadable grey
  // survives a review: it is not in the table anybody checked.
  const cssHex = [];
  for (const [i, line] of read("app/globals.css").split("\n").entries()) {
    if (/^\s*\/\*/.test(line)) continue;
    if (/#[0-9a-fA-F]{3,8}\b/.test(line)) cssHex.push(`globals.css:${i + 1}`);
  }
  ok(cssHex.length === 0, "no component style declares a colour of its own",
    cssHex.slice(0, 4).join(", "));

  // Nothing dims text with opacity. `opacity: .4` on a paragraph produces a
  // colour that is not in the table and cannot be measured against the surface
  // under it, which is the same failure wearing a different hat.
  const dimmed = [];
  for (const [i, line] of read("app/globals.css").split("\n").entries()) {
    if (/^\s*\/\*/.test(line)) continue;
    const m = /(^|[^-])opacity:\s*(0?\.\d+)/.exec(line);
    if (m && Number(m[2]) < 1) dimmed.push(`globals.css:${i + 1}`);
  }
  ok(dimmed.length === 0, "…and no text is made unreadable with opacity instead",
    dimmed.slice(0, 4).join(", "));

  const rows = checkContrast();
  const bad = rows.filter((r) => !r.ok);
  ok(rows.length >= 80, "the contrast check covers the pairs the app renders",
    `${rows.length} pairs`);
  ok(bad.length === 0, "every one of them meets the ratio its role needs",
    bad.map((r) => `${r.theme} ${r.fg}/${r.bg} ${r.ratio.toFixed(2)}`).slice(0, 4).join(", "));
  ok(rows.some((r) => r.kind === "text") && rows.some((r) => r.kind === "ui"),
    "…held to two ratios, because WCAG asks for two");

  // The body used to be permanently unscrollable, which hid every overflow bug
  // in the application behind a viewport that could not move.
  // Comments stripped first: the rule block explains why the declaration is
  // gone, and a check that reads its own explanation as the thing it forbids
  // is a check that can only ever fail.
  const css = read("app/globals.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const body = css.slice(css.indexOf("\nbody {"), css.indexOf("}", css.indexOf("\nbody {")));
  ok(body.length > 20 && !/overflow:\s*hidden/.test(body),
    "the document body is not permanently unscrollable", body.replace(/\s+/g, " ").slice(0, 90));
}

// ---------------------------------------------------------------- the deployed build tells the truth about the helper
//
// The session index used to tell everybody, on the deployed site, to run
// `npm run helper` and come back. The helper answers 127.0.0.1 and a browser
// will not let a page on another origin reach it — so following that
// instruction could not work, and the page said it in the imperative. Both
// branches of that copy are here, and only one of them can be on screen in any
// given run, so this reads the source of the one the in-page suite does not
// take.

{
  const src = read("app/all-sessions.tsx");
  ok(src !== "", "the session index is a module");
  ok(/Available when AgentTape is running locally/.test(src),
    "away from localhost it says when the helper route is available");
  ok(/This page makes no request to loopback/.test(src),
    "…and that it is not quietly trying anyway");
  ok(!/Start it with npm run helper and come back/.test(src),
    "…and no longer gives an instruction that cannot work from a deployed page");

  // Structural, not editorial: the fetch is inside a function that refuses
  // when the page is not local, so the promise above is a property of the code.
  const fromHelper = src.slice(src.indexOf("const fromHelper"), src.indexOf("const runLocal"));
  ok(/if \(!isLocal\(\)\) return;/.test(fromHelper),
    "…because the one request it can make refuses off localhost before making it");
  const fetches = [...src.matchAll(/fetch\(/g)].length;
  ok(fetches === 1, "…and there is only one of them to guard", String(fetches));

  // Clearing the cache is a destructive-sounding control, so it says what it
  // destroys — which is a browser index and not anybody's transcript.
  ok(/no transcript is touched|No\s*\n?\s*transcript is touched/i.test(src),
    "the cache control says clearing it does not touch a transcript");
}

// ---------------------------------------------------------------- the header folds without dropping anything
//
// Below 720px the bar keeps two controls and the session row keeps only its
// tabs; everything else is in one menu. That menu is `display: none` at any
// width where the rows are shown, so no DOM test can open it — which makes the
// invariant a property of the source, and this the place to hold it.

{
  const shell = read("app/shell.tsx");
  ok(shell !== "", "the shell is a module");

  const narrow = shell.slice(shell.indexOf("const narrowItems"), shell.indexOf("return ("));
  ok(narrow.length > 60, "the narrow menu builds its own list", `${narrow.length} chars`);
  for (const [what, re] of [
    ["the session index", /All sessions/],
    ["the checks", /Checks —/],
    ["both export actions", /\.\.\.exportItems/],
    ["everything the wide menu holds", /\.\.\.moreItems/],
  ]) {
    ok(re.test(narrow), "…and it carries " + what);
  }

  // Four groups is the ceiling, and the two that must be findable are named.
  const bar = shell.slice(shell.indexOf('<div className="shell-bar">'), shell.indexOf("{view && ("));
  const groups = (bar.match(/className="btn btn-sm|<Menu/g) ?? []).length;
  ok(groups > 0 && groups <= 4, "the bar declares at most four interaction groups",
    String(groups));
  ok(/Open session/.test(bar) && /All sessions/.test(bar),
    "…and opening a session and the index are two of them");

  // Checks and Export are about one session, so they sit with it.
  const row = shell.slice(shell.indexOf("{view && ("));
  ok(/<ChecksIcon/.test(row) && /<ExportIcon/.test(row),
    "Checks and Export are on the row that belongs to the session");
  ok(!/<ChecksIcon|<ExportIcon/.test(bar), "…and are not also in the bar");

  // One fold, and late. A rule at 1024 was the cliff this replaced.
  const css = read("app/globals.css");
  const folds = [...css.matchAll(/@media \(max-width: (\d+)px\) \{([^@]*?)\n\}/gs)]
    .filter(([, , body]) => /\.bar-wide\s*\{\s*display:\s*none/.test(body))
    .map(([, at]) => Number(at));
  ok(folds.length === 1, "the bar folds at exactly one width", folds.join(", "));
  ok(folds[0] <= 800, "…and not before 800px", `${folds[0]}px`);
}

// ---------------------------------------------------------------- names for steps, and what is under them
//
// The list calls a `tool_result` a tool result. The transcript calls it
// `role: "user"`, because that is how the API carries it. Both are true and
// the interface has to keep them apart: one is a presentation layer, the other
// is the record, and collapsing them would be a change to the data dressed as
// a change to the wording.

{
  const labels = read("lib/labels.ts");
  ok(labels !== "", "the step names are their own module");
  ok(!/\bs\.(kind|rawType|role)\s*=/.test(labels), "…and it assigns nothing on a step");
  ok(/rawDescriptor/.test(labels), "…while still being able to say what the record called itself");
  const record = read("app/record-data.tsx");
  ok(/Parsed record/.test(record) && /Raw record/.test(record),
    "the record panel distinguishes the projection from the line");
  ok(/there is no original line to show/i.test(record),
    "…and says so rather than re-serialising the projection as the source");
  ok(/raw: async \(\) => null/.test(read("lib/tape.ts")),
    "…which is a property of the tape reader, not of the panel");

  // The key-event index is derived, not summarised. Anything that opened a
  // file or read a body here would be a second parsing path.
  const events = read("lib/events.ts");
  ok(events !== "", "the key events are derived in a module");
  ok(!/fetch\(|readFile|\.body\(/.test(events), "…which opens nothing and reads no body");
  ok(/Largest observed context increase/.test(events),
    "…and names the context event as observed rather than as a cause");
  // The sentence moved to the page that says it when the list is empty; the
  // property it guards did not, so the assertion follows it rather than being
  // deleted along with the string it happened to be matching.
  ok(/No failed tool calls recorded/.test(read("app/session-overview.tsx")),
    "…and reports the absence of a recorded failure as exactly that");
  ok(/not a verdict on the work/.test(read("app/session-overview.tsx")),
    "…saying in the same breath that it is not a verdict");
  ok(!/succeeded|success|went well|correct/i.test(events.replace(/^\s*(\/\/|\*).*$/gm, "")),
    "…and never as success");
}

// CI must not be mistaken for covering the in-page suite. The file says so;
// this makes the file keep saying so.
const ci = existsSync(join(root, ".github/workflows/ci.yml"))
  ? readFileSync(join(root, ".github/workflows/ci.yml"), "utf8") : "";
ok(ci !== "", "the CI workflow is committed");
ok(/selftest/.test(ci), "the workflow records that it does not run the in-page suite");
ok(!/@v[1-4]\b/.test(ci), "no CI action is pinned to a deprecated major version",
  (ci.match(/uses: \S+/g) ?? []).join(" "));

// The helper probe must not fire on every load: a refused connection is logged
// in red by the network layer, where no catch can reach it. The rule lives in
// one module now that two panels use it, so it is checked there.
const helperSrc = read("app/helper.ts");
const probeGuard = helperSrc.indexOf("helperSeenBefore()) return");
const probeCall = helperSrc.indexOf("probe();", probeGuard);
ok(probeGuard > 0 && probeCall > probeGuard,
  "the helper is only probed unasked once it has answered here before");
const sessionsSrc = read("app/all-sessions.tsx");
ok(/Look for it|Look again/.test(sessionsSrc),
  "…and there is a control to look for it the first time");
ok(/Look for it|Look again/.test(read("app/compare.tsx")),
  "…on the comparison panel too");
// One implementation, so the two panels cannot drift apart on it.
const probeImpls = [sessionsSrc, read("app/compare.tsx")]
  .filter((src) => /fetch\(\s*HELPER/.test(src)).length;
ok(probeImpls === 0, "neither panel probes the helper itself", String(probeImpls));

// nothing on window unless the flag is set
const page = read("app/page.tsx");
const guard = page.indexOf('has("selftest")');
const expose = page.indexOf("__agenttape");
ok(guard > 0 && expose > guard, "window.__agenttape is only assigned after the selftest guard");
const windowWrites = [];
for (const f of sources.filter((f) => f.includes("/app/") || f.includes("/lib/"))) {
  const body = readFileSync(f, "utf8");
  for (const m of body.matchAll(/window\s*(?:as[^)]*\))?\s*\)?\s*\[?["']?(__\w+)/g)) {
    if (!f.endsWith("page.tsx") && !f.endsWith("selftest.ts")) windowWrites.push(f + ":" + m[1]);
  }
}
ok(windowWrites.length === 0, "no other module writes a global", windowWrites.join(","));

const libFiles = sources.filter((f) => f.includes("/lib/"));
const libFetch = libFiles.filter((f) => /\bfetch\s*\(/.test(readFileSync(f, "utf8")));
ok(libFetch.length === 0, "the parsing library makes no network calls at all",
  libFetch.map((f) => f.replace(root, "")).join(","));

// Search must never reach a body. tape.body() is the only way to one, so the
// filter module must not mention it — this is the assertion that keeps the
// stated limit honest as the code changes.
const filterSrc = read("lib/filter.ts");
ok(!/\bbody\b/.test(filterSrc.replace(/\/\/.*$/gm, "")),
  "the filter module never reaches for a body");
ok(!/\bfetch\s*\(|\bslice\s*\(\s*s\.off/.test(filterSrc),
  "the filter module reads nothing off disk");

// the CLI helper's guarantees, asserted against its source
const helper = read("bin/agenttape.mjs");
// Comments are stripped: this file talks about what it refuses to do, and the
// check should read the code rather than the prose.
const helperCode = helper.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
ok(/\.listen\([^)]*"127\.0\.0\.1"/.test(helperCode), "the helper binds to 127.0.0.1");
ok(!helperCode.includes("0.0.0.0"), "the helper never binds to 0.0.0.0");
ok(/realpath/i.test(helperCode), "the helper resolves symlinks before checking the path");
ok(helperCode.includes("PROJECTS"), "the helper confines itself to the projects directory");
ok(!/customTitle|aiTitle|lastPrompt/.test(helperCode), "the helper never reads a session title");

// The screen built from these records must not grow a text column. The risk is
// naming a field that carries prompt text — not the word "summary" in an import
// path, or "title" on a tooltip.
const ovSrc = read("app/all-sessions.tsx");
const ovCode = ovSrc.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
ok(!/customTitle|aiTitle|lastPrompt|\.preview\b|\.description\b|firstMessage|firstSaid/i.test(ovCode),
  "the overview never reads a field that carries prompt text");
ok(!/\bstats\.(label|note)\b/.test(ovCode), "…nor a free-text label");
ok(/aria-sort/.test(ovSrc), "…and its columns are sortable, accessibly");

// The helper writes one file, and not among the transcripts.
ok(/const CACHE_DIR = /.test(helperCode), "the helper has one cache location");
ok(!/CACHE_DIR[^\n]*PROJECTS|join\(PROJECTS[^)]*cache/i.test(helperCode),
  "…which is not inside ~/.claude/projects");
const writes = [...helperCode.matchAll(/writeFile\(([^,]+),/g)].map((m) => m[1].trim());
ok(writes.length === 1 && writes[0] === "CACHE_FILE",
  "the helper writes exactly one file, and it is the cache", writes.join(", "));
// One index builder, two callers. The helper streams files off disk and the
// browser walks a granted directory; if either grew its own copy of the
// freshness rule or the record shape, one of them would drift into showing
// something it should not.
const indexSrc = read("lib/session-index.ts");
ok(/hit\.bytes === s\.bytes && hit\.mtime === s\.mtime/.test(indexSrc),
  "the cache is keyed by the file's size and mtime together");
ok(/buildSessionIndex/.test(helperCode), "the helper builds its index through the shared module");
const localSrc = read("app/local-index.ts");
ok(/buildSessionIndex/.test(localSrc), "…and so does the browser");
for (const [who, src] of [["the helper", helperCode], ["the browser", localSrc]]) {
  ok(!/sessionStats\s*\(/.test(src.replace(/import[^;]+;/g, "")),
    `${who} does not build a session record itself`);
}
ok(/isFresh/.test(indexSrc), "the freshness rule has one name and one home");

// The browser cache is a new place data lands this round. What goes into it is
// whatever buildSessionIndex produced and nothing else, and there is a way to
// get rid of it, because the UI promises one.
ok(/localStorage\.setItem\(CACHE_KEY/.test(localSrc), "the browser cache has one write site");
ok(/JSON\.stringify\(\{ format: CACHE_FORMAT, entries \}\)/.test(localSrc),
  "…and it stores the index builder's output rather than anything assembled here");
ok(/export function clearLocalCache/.test(localSrc), "…and it can be cleared");
ok(/CACHE_KEY = "agenttape-/.test(localSrc), "…under a namespaced key");
// Feature detection, not user-agent sniffing.
ok(/typeof \(window as \{ showDirectoryPicker\?: unknown \}\)\.showDirectoryPicker === "function"/.test(localSrc),
  "the folder picker is feature-detected");
ok(!/userAgent|navigator\.vendor|isSafari|isChrome/i.test(localSrc),
  "…and no browser is identified by name");
ok(/webkitdirectory/.test(localSrc), "there is a fallback for browsers without it");


// A subagent sidecar carries a `description` written from the prompt that
// spawned it. It is prose about the user's work, in the same class as a session
// title, and must never be read or sent.
ok(!/\bdescription\b/.test(helperCode), "the helper never reads a subagent description");
ok(/toolUseId/.test(helperCode), "…but it does read the id that links a run to its call");
// One resolver, still. /subagent must go through the same function as /file.
const resolverDefs = (helperCode.match(/function resolveTranscript/g) ?? []).length;
ok(resolverDefs === 1, "there is exactly one path resolver", String(resolverDefs));
ok(/subagents/.test(helperCode) && /resolveTranscript\(\s*$|resolveTranscript\(/.test(helperCode),
  "subagent paths are built inside that resolver");
const appSrc = read("app/page.tsx") + read("app/home.tsx") + read("app/open-session.tsx");
ok(!/meta\.description|\.description\b/.test(appSrc),
  "the page never reads a subagent description either");

// The helper used to resolve ../out and tell the user to "build to ./out".
// Nothing in this repository writes an out/ directory — `next build` writes
// .next — so following the instruction failed. Every directory the helper
// resolves or advertises must be one that exists or that a script produces.
//
// The two checks that came out of that bug were written against the exact
// shapes it wore: `new URL("../out")` and the literal "./out". Removing the
// static serving in round three removed both shapes, so both checks have
// matched nothing since and ran zero times for three rounds while counting as
// coverage. They now read what the helper actually does, and each extraction
// is asserted non-empty first, so neither can go quietly vacuous a second time.
const PRODUCED_BY_A_SCRIPT = new Set([".next"]); // what `next build` writes
// `application/json`, `text/plain`: a content-type is not a directory.
const MIME_TOP = new Set(["application", "text", "image", "audio", "video", "multipart"]);
const producible = (d) => existsSync(join(root, d)) || PRODUCED_BY_A_SCRIPT.has(d);

// What it resolves: the modules it reaches for outside its own directory.
const helperResolves = [...helperCode.matchAll(/import\(\s*["']\.\.\/([^"'/]+)\//g)]
  .map((m) => m[1]);
ok(helperResolves.length > 0,
  "the helper resolves something, so this check has something to check",
  helperResolves.join(", "));
for (const dir of new Set(helperResolves)) {
  ok(producible(dir),
    "the helper only resolves a directory this repository can produce: " + dir);
}

// Same rule for what it tells the user, which is where the original bug lived.
const advertised = [...helper.matchAll(/(?:^|[\s"'`(])([a-z][a-z0-9_-]*)\/(?=[a-z])/gm)]
  .map((m) => m[1])
  .filter((d) => !MIME_TOP.has(d));
ok(advertised.length > 0,
  "the helper advertises a path at somebody, so this check has something to check",
  [...new Set(advertised)].join(", "));
for (const dir of new Set(advertised)) {
  ok(producible(dir),
    "the helper never advertises a directory this repository cannot produce: " + dir);
}
ok(!/serveStatic|APP_ROOT/.test(helperCode),
  "the helper has one path-resolution surface, not two");


// ---------------------------------------------------------------- the checker as somebody else's tool
//
// `agenttape check` is the one part of this that is meant to run in a stranger's
// CI, on a machine nobody here will ever see. That makes three things
// load-bearing: the help has to be true, the example rule sets have to be worth
// copying, and the failure output has to be safe to paste somewhere public.

const cliSrc = read("bin/agenttape.mjs");
const helpBlock = cliSrc.slice(cliSrc.indexOf("const HELP = `"), cliSrc.indexOf("`;", cliSrc.indexOf("const HELP = `")));
ok(helpBlock.includes("${NODE_MIN}") || /22\.18/.test(helpBlock),
  "the help states the Node version, which is the first thing that stops somebody");
ok(/npm/.test(helpBlock) && /clone/.test(helpBlock),
  "…and says there is nothing to install, since nothing is published");
ok(/--list|Ctrl-C|serve/.test(helpBlock),
  "…and says what running it with no arguments does, which is not what you would guess");
ok(/examples\//.test(helpBlock), "…and points at the example rule sets by path");

// A rule set that does not parse is a rule set nobody can copy.
const exampleRules = ["examples/lenient.rules.json", "examples/strict.rules.json"];
const parsedExamples = {};
for (const rel of exampleRules) {
  const src = read(rel);
  ok(src !== "", `${rel} exists`);
  const { set, problems } = parseRuleSet(src);
  ok(problems.length === 0, `${rel} parses with nothing to complain about`, problems.join("; "));
  ok(set.rules.length > 0, `${rel} has rules in it`);
  ok((set.note ?? "").length > 80,
    `${rel} says when to reach for it, not just what is in it`);
  parsedExamples[rel] = set;
}

// The two are only worth shipping as a pair if one is genuinely the stricter.
// Asserted by running both, because "strict has a smaller number in it" is a
// statement about the file and this is a statement about behaviour.
{
  const passing = tapeFromFile(JSON.parse(read("fixtures/passing.tape.json")));
  const failing = tapeFromFile(JSON.parse(read("fixtures/failing.tape.json")));
  const run = (set, tape) =>
    tally(checkAll(tape.steps, set.rules, pairTools(tape.steps)));
  const lenient = parsedExamples["examples/lenient.rules.json"];
  const strict = parsedExamples["examples/strict.rules.json"];

  ok(run(lenient, passing).fail === 0 && run(strict, passing).fail === 0,
    "both example rule sets hold on a run that went well");
  const lf = run(lenient, failing).fail;
  const sf = run(strict, failing).fail;
  ok(lf > 0, "the lenient set is not so lenient that it catches nothing", `caught ${lf}`);
  ok(sf > lf, "…and the strict set catches strictly more on the same run", `${sf} vs ${lf}`);
}

// Every reason a step can be marked failed, as a closed vocabulary. This is the
// invariant the paste block rests on: `errWhy` reaches the failure output, and
// the failure output is meant for a public issue tracker. If a reason could
// ever be built from a message, that block would leak on the day it mattered.
{
  const reasons = new Set();
  const scan = (src) => {
    for (const m of src.matchAll(/errWhy\s*[=:]\s*(.+?)[,;\n]/g)) reasons.add(m[1].trim());
    for (const m of src.matchAll(/return\s+"([^"]+)";/g)) void m;
  };
  scan(read("lib/parser.ts"));
  const computed = [...reasons].filter((r) => !/^(recErr|""|errWhy)$/.test(r));
  const literal = computed.every((r) => /^"[a-z ]+"$/.test(r));
  ok(literal, "every failure reason is a literal this program wrote, never a field it read",
    computed.filter((r) => !/^"[a-z ]+"$/.test(r)).join(", "));

  const recordErrorBody = read("lib/parser.ts").slice(
    read("lib/parser.ts").indexOf("function recordError"),
    read("lib/parser.ts").indexOf("const BLOCK_KIND"),
  );
  const returns = [...recordErrorBody.matchAll(/return\s+([^;]+);/g)].map((m) => m[1].trim());
  // "" is the fifth: no error. It is a literal too.
  ok(returns.every((r) => /^"[a-z ]*"$/.test(r)),
    "…and recordError returns only such literals", returns.join(", "));
}

// Behavioural, because the two assertions above read source. A transcript in
// which every text field is one marker, run through the checker's own output
// path: the marker must not reach the paste block or the JSON.
{
  const MARK = "PASTEABLE" + "-MARKER-" + "7Q";
  const at = (n) => new Date(Date.parse("2026-10-10T09:00:00Z") + n * 1000).toISOString();
  const hostile = [
    { type: "user", message: { role: "user", content: MARK }, timestamp: at(0), sessionId: MARK },
    {
      type: "assistant", timestamp: at(1), version: MARK,
      message: {
        role: "assistant", id: "msg_1", model: MARK,
        content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: MARK } }],
        usage: { input_tokens: 10, cache_read_input_tokens: 900_000 },
      },
    },
    {
      type: "user", timestamp: at(2), toolUseResult: MARK,
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_1", is_error: true, content: MARK }],
      },
    },
  ];
  const ix = createIndexer("hostile");
  hostile.forEach((r, i) => pushLine(ix, JSON.stringify(r), i, 1));
  const { steps } = finishIndex(ix);
  const results = checkAll(steps, parsedExamples["examples/strict.rules.json"].rules, pairTools(steps));

  // Non-vacuous: the marker really was in the transcript, and rules really failed.
  ok(hostile.some((r) => JSON.stringify(r).includes(MARK)), "the hostile transcript carries the marker");
  const failed = results.filter((r) => !r.pass);
  ok(failed.length > 0, "…and the strict set failed on it, so there is a paste block to check");

  const asText = results.map((r) => r.label + " " + r.detail).join("\n");
  ok(!asText.includes(MARK), "no rule result carries a word from the transcript");
  ok(!JSON.stringify(results.map((r) => ({ l: r.label, d: r.detail, s: r.at }))).includes(MARK),
    "…and neither does the JSON the --json flag prints");
}

// The README has to make the first minute work for somebody who has never seen
// this: the version they need, and what happens if they just run it.
// What a green tick covers, and why anyone should believe it. The table is the
// claim; the paragraph under it is the reason, and the reason is that this
// suite was red for two rounds while CI was green. Both are asserted, because a
// guarantee without its history is a feature list.
{
  const cover = readme.slice(readme.indexOf("### What a green tick covers"),
    readme.indexOf("### On the sibling project"));
  ok(cover.length > 400, "the README says what a green tick covers");
  for (const [what, re] of [
    ["verify.mjs", /verify\.mjs`? \|/],
    ["the counter guard", /npm run counters`? \|/],
    ["the in-page suite", /npm run selftest`? \|/],
    ["the rule checker", /agenttape check`? \|/],
  ]) ok(re.test(cover), "…naming " + what);
  // Derived rather than restated. Three copies of a number is two chances for
  // one of them to drift, and this file's whole argument is that a number in
  // prose has to be checked against the thing it describes.
  const inPageTotal = Number(read("app/selftest.ts").match(/DECLARED_ASSERTIONS = (\d+);/)?.[1] ?? -1);
  const inPageSkips = Number(read("app/selftest.ts")
    .match(/"no-helper": \{ total: DECLARED_ASSERTIONS, skipped: (\d+) \}/)?.[1] ?? -1);
  const contract = new RegExp(
    `${inPageTotal - inPageSkips}/${inPageTotal} passed · 0 failed ·\\s*\\n?${inPageSkips} not run here`);
  ok(inPageTotal > 0 && inPageSkips >= 0 && contract.test(cover),
    "…and the three numbers the in-page job asserts",
    `${inPageTotal - inPageSkips}/${inPageTotal}, ${inPageSkips} skipped`);
  // Numbers in prose drift. These three are checked against the things they
  // describe, because a README that says 591 when the file runs 599 is the
  // same class of wrong as a counter that stops early.
  const said = (re) => Number(cover.match(re)?.[1] ?? -1);
  // Read out of the file rather than off the binding: the constant is declared
  // at the end, after every check has been counted, so it is in its temporal
  // dead zone here — and the literal is what a reader would compare anyway.
  const declaredChecks = Number(
    read("verify.mjs").match(/const EXPECTED_CHECKS = (\d+);/)?.[1] ?? -1);
  ok(said(/`node verify\.mjs` \| (\d+) assertions/) === declaredChecks,
    "…with verify.mjs's own total, not a number that has drifted from it",
    `README ${said(/`node verify\.mjs` \| (\d+) assertions/)}, file ${declaredChecks}`);
  const inPage = Number(read("app/selftest.ts").match(/DECLARED_ASSERTIONS = (\d+);/)?.[1] ?? -1);
  ok(said(/the in-page suite, (\d+) assertions/) === inPage,
    "…and the in-page suite's declared total", `README ${said(/the in-page suite, (\d+) assertions/)}, file ${inPage}`);
  const guardCases = (read("scripts/counters.mjs").match(/^  \{\n    name: /gm) ?? []).length + 1;
  ok(/six self-inflicted breakages/.test(cover) && guardCases === 6,
    "…and the number of breakages the guard actually inflicts", String(guardCases));

  ok(/red on `main`\s*\n?while CI was green/.test(cover),
    "…and that this suite was red for two rounds while CI was green");
  ok(/247 on a thirty-one step tape/.test(cover),
    "…and that the diagnosis came from sampling rather than from reading the code");
  ok(/each keep their\s*\n?own driver/.test(readme) && !/shared driver/.test(readme),
    "…and that the two projects keep their own drivers rather than sharing one");
}

// ---------------------------------------------------------------- the corpus subcommand
//
// `agenttape stats` exists so a reader can put their own number next to mine.
// It must therefore be one implementation, not a fourth: the helper and the
// browser overview already reduce a session to a statistics record, and this
// reduces those records to four figures without touching a transcript.

{
  const corp = read("lib/corpus.ts");
  ok(corp !== "", "the corpus summary is a module, not a script's private arithmetic");
  ok(!/readFile|createReadStream|readdir|homedir|fetch\(/.test(corp),
    "…and it opens nothing: it takes records that have already been reduced");
  ok(!/parser\.ts|loadJsonl|createIndexer/.test(corp),
    "…and parses nothing either, which is what makes the privacy property structural");
  ok(/import\("\.\.\/lib\/corpus\.ts"\)/.test(cliSrc),
    "the subcommand calls that module rather than doing the arithmetic again");
  ok(/buildIndex\(\{[\s\S]{0,120}root,/.test(cliSrc),
    "…over the index the helper already builds, so there is one statistics path");
  ok(/agenttape stats \[<dir>\]/.test(helpBlock),
    "the help mentions it, including that it takes a directory");
  ok(/n printed with every|n = /.test(helpBlock),
    "…and that every figure comes with its n");
}

// ---------------------------------------------------------------- where it stopped
//
// The closing note. It exists so the next person does not have to discover the
// four things this does not do, and so the two rounds when the suite was red
// while CI was green stay written down — that paragraph is the reason to
// believe the numbers above it, and it is the first thing a tidy-up would cut.

{
  const st9 = read("docs/state.md");
  ok(st9 !== "", "there is a closing note");
  ok(/https:\/\/agenttape\.vercel\.app/.test(st9), "…that says where the thing is");

  for (const [what, re] of [
    ["positional comparison rather than LCS", /aligns positionally, not by longest common/i],
    ["what a nested run still does not show", /nested subagent run shows less/i],
    ["the helper mode not being covered in CI", /helper mode is not covered in CI/i],
    ["Safari's picker being documented rather than measured", /documented, not measured/i],
  ]) ok(re.test(st9), "…and names the limit: " + what);

  ok(/Four concurrent copies of\s*\n?`runSelfTest`/.test(st9),
    "…and the cause of the two red rounds, in the number of copies");
  ok(/247 on a thirty-one step tape/.test(st9),
    "…and that the diagnosis came from sampling, not from reading the code");
  ok(/statement about the suite/.test(st9),
    "…and the lesson that outlives this repository");
  ok(/151, 150, 135,\s*\n?147-unstable/.test(st9),
    "…including the four repairs that each produced a different arbitrary number");

  const declaredChecks9 = Number(
    read("verify.mjs").match(/const EXPECTED_CHECKS = (\d+);/)?.[1] ?? -1);
  ok(Number(st9.match(/`node verify\.mjs` \| (\d+) assertions/)?.[1] ?? -1) === declaredChecks9,
    "…with this file's own total rather than one that has drifted from it");
  ok(/docs\/state\.md/.test(readme), "and the README points at it");
}

ok(/22\.18/.test(readme), "the README states the Node version the checker needs");
ok(/node bin\/agenttape\.mjs check /.test(readme), "…and gives the check command as one line");
ok(/examples\/lenient\.rules\.json/.test(readme), "…and names a rule set they can copy");

// `e.target` is not an element. It is whatever the event was dispatched on,
// and a keydown sent programmatically is dispatched on `window` — which has no
// `closest` and is not a `Node`, so `contains` throws on it. Both keyboard
// handlers in this app used to cast the target to `HTMLElement` and then call
// those methods, which meant any such keydown took the whole handler down with
// an uncaught TypeError. A cast is not a check; this asserts nobody writes one
// back in.
{
  const casts = [];
  for (const f of files.filter((f) => /\/app\/.*\.tsx?$/.test(f))) {
    const src = readFileSync(f, "utf8");
    if (!/addEventListener\("keydown"/.test(src)) continue;
    if (/e\.target as HTML|e\.target as Element|e\.target as Node/.test(src)) {
      casts.push(f.replace(root, ""));
    }
  }
  ok(casts.length === 0,
    "no keyboard handler casts e.target instead of narrowing it", casts.join(", "));
}

// ---------------------------------------------------------------- prepared to deploy, not deployed
//
// The deployment note makes claims about a build nobody here has run on a host.
// Each of the checkable ones is checked, so the note cannot quietly go stale
// the first time somebody adds a route.

{
  const deploy = read("docs/deploy.md");
  ok(deploy !== "", "the deployment note exists");
  ok(/^\*\*Deployed: <https:\/\/[a-z0-9.-]+>\*\*$/m.test(deploy),
    "…and says where it is deployed, at the top");
  ok(/npx vercel --prod --yes --name/.test(deploy),
    "…with the command that produced it, including the lowercase name Vercel demands");
  ok(/1\. |2\. |3\. |4\. |5\. /.test(deploy), "…as an ordered list rather than prose");
  ok(/cannot do/.test(deploy) && /the helper, and only the helper/i.test(deploy),
    "…and what the deployed build cannot do, which is the more useful half");
  ok(/documented rather than measured/.test(deploy),
    "…and marks the one browser claim it could not measure as such");
  ok(/^\.vercel$/m.test(gitignore), "the CLI's own directory is ignored");

  // "Environment variables: none" is a fact about the source, so read the source.
  const envUsers = files
    .filter((f) => /\/(app|lib)\/.*\.(ts|tsx)$/.test(f))
    .filter((f) => /process\.env/.test(readFileSync(f, "utf8")))
    .map((f) => f.replace(root, ""));
  ok(envUsers.length === 0, "the app reads no environment variable, as the note claims",
    envUsers.join(", "));

  // Static everywhere is what makes the "no serverless functions" claim true.
  const serverBits = files
    .map((f) => f.replace(root, ""))
    .filter((f) => /^app\/.*\/(route|middleware)\.tsx?$/.test(f) || /^middleware\.tsx?$/.test(f));
  ok(serverBits.length === 0, "…and has no API route or middleware to make it dynamic",
    serverBits.join(", "));

  // The one build-time filesystem read is fine; a request-time one would not be.
  const fmtPageSrc = read("app/format/page.tsx");
  ok(!/force-dynamic|revalidate\s*=/.test(fmtPageSrc),
    "…and the one page that reads a file does it at build time, not per request");

  ok(/docs\/deploy\.md/.test(readme), "the README points at the deployment note");
}

// Two sentences at the top saying what this is for, before any claim about it.
{
  const body = readme.slice(readme.indexOf("]("));   // past the badge
  const opening = body.slice(body.indexOf("**"), body.indexOf("Your transcripts"));
  ok(opening.length > 200, "the README opens with prose, not with a slogan", String(opening.length));
  ok(/replays? a Claude Code session/i.test(opening),
    "…that says what the tool does in its first sentence");
  ok(/(so you can|instead of|shows you)/i.test(opening),
    "…and what it is for, rather than only what it is");
}

// ---------------------------------------------------------------- the in-page suite is a fixed set
//
// A score is only evidence if the set behind it did not move. Round five
// compared 141/159 with 139/161 and concluded the change had made things
// worse; the denominator had moved, so the two numbers were about different
// sets. The suite now declares its size and fails when the actual count
// differs, which also catches the failure this file has already had — a block
// that never ran.

{
  const st = read("app/selftest.ts");
  const declared = st.match(/const DECLARED_ASSERTIONS = (\d+);/);
  ok(!!declared, "the in-page suite declares how many assertions it runs");

  // The static half. The declared total is accumulated during the run and
  // therefore cannot see an assertion that is written and never reached; this
  // one counts call sites in the source and cannot see how many times a loop
  // goes round. Neither is sufficient and together they are.
  // Counted twice, by methods that fail differently. The per-line one used to
  // be the only one and it was wrong: it dropped six real assertions, five
  // because their text contained the word "skipped" and one because a regex
  // literal inside the assertion read `const skip = \(` and the exclusion
  // pattern matched the regex's own text. A scanner that stops early reports a
  // smaller number confidently, so the only way to catch one is another
  // scanner that does not.
  const CALL = /(?:^|[^\w.$])(ok|skip)\(/;
  const byLine = new Set(st.split("\n")
    .map((l, i) => [l, i + 1])
    .filter(([l]) => !/^\s*(\/\/|\*)/.test(l))
    .filter(([l]) => CALL.test(l))
    .filter(([l]) => !/const (ok|skip)\s*=/.test(l))
    .map(([, n]) => n));
  const byToken = callLinesOf(st, ["ok", "skip"]);
  const onlyLine = [...byLine].filter((n) => !byToken.has(n));
  const onlyToken = [...byToken].filter((n) => !byLine.has(n));
  ok(onlyLine.length === 0 && onlyToken.length === 0,
    "…and two counters that fail differently agree about where they are",
    `line-only ${onlyLine.join(",") || "none"} · token-only ${onlyToken.join(",") || "none"}`);

  const declaredSites = Number(st.match(/DECLARED_CALL_SITES = (\d+);/)?.[1] ?? -1);
  ok(declaredSites > 100, "…and how many call sites it has", String(declaredSites));
  ok(byToken.size === declaredSites,
    "…and the source contains exactly that many",
    `${byToken.size} counted, ${declaredSites} declared`);
  ok(Number(declared?.[1]) > 100, "…and the number is the real one, not a placeholder",
    declared?.[1] ?? "missing");
  ok(/results\.length \+ 1 === want\.total/.test(st),
    "…and compares it against what actually ran, for the mode it ran in");
  ok(/expected: DECLARED\[MODE\]\.total/.test(st),
    "…and hands it to a driver, so CI can fail on a short run too");

  // One exit. The bail-out for "no tape loaded" used to report by itself and
  // return, which reported twice and walked past the count check on the way.
  const stLines = st.split("\n").filter((l) => !/^\s*(\/\/|\*)/.test(l));
  const exits = stLines.filter(
    (l) => /(?:^|[^\w.$])report\(/.test(l) && !/function report\(/.test(l),
  ).length;
  ok(exits === 2, "the suite reports from one place, plus the no-api bail-out",
    `${exits} calls to report`);

  // `ok(true, "…skipped…")` is a vacuous pass, which this project's own rule
  // checker refuses to call a pass. Skipped work says so in its own word.
  ok(!stLines.some((l) => /\bok\(\s*true\s*,/.test(l)),
    "no assertion in the suite is a literal pass");
  ok(/const skip = \(/.test(st) && /skipped: true/.test(st),
    "…because there is a way to say an assertion did not run here");

  // Both branches of the helper block must emit the same number of results, or
  // the frozen total depends on whether a helper happens to be running — 160 on
  // a machine without one, 163 with. Asserted through the shared label list.
  ok(/for \(const label of L\) skip\(label, why\)/.test(st),
    "the helper-dependent block emits one label list either way");

  // Two modes, each with a frozen shape. The block used to probe for a helper
  // and adapt, so the suite behaved differently depending on what happened to
  // be running on the machine — which is not something a gate can be built on,
  // and next round this becomes a gate on a runner where the helper is never
  // up. The driver decides now, and each mode declares what it produces.
  const self = read("verify.mjs");
  ok(/function callOffsets\(/.test(self) && /callLinesOf\(/.test(self),
    "call sites are counted by a scanner that knows what it is looking at");
  ok(/const byToken = callLinesOf\(/.test(self),
    "…and the second counter is that scanner, not a copy of the first");
  ok(/const unseen = \[\.\.\.fired\]/.test(self) && /ok\(unseen\.length === 0,/.test(self),
    "…and the running program's own record is checked against it, both ways");
  ok(/const HELPER_MODE =/.test(st) && /has\("helper"\)/.test(st),
    "the page is told which mode to run in rather than probing for one");
  ok(!/const reachable = await fetch/.test(st),
    "…and no longer decides by looking at what is listening");
  const modes = st.slice(st.indexOf("const DECLARED: Record"), st.indexOf("};", st.indexOf("const DECLARED: Record")));
  ok(/"no-helper": \{ total: DECLARED_ASSERTIONS, skipped: 4 \}/.test(modes) &&
     /"helper": \{ total: DECLARED_ASSERTIONS, skipped: 0 \}/.test(modes),
    "…and both modes declare a total and a skip count", modes.replace(/\s+/g, " ").slice(0, 90));
  ok(/skipped exactly the assertions this mode skips/.test(st),
    "…and a skip that appears where the mode does not declare one is a failure");
  ok(/mode: MODE/.test(st) && /expectedSkips: DECLARED\[MODE\]\.skipped/.test(st),
    "…and the mode and its declared shape reach the driver");

  const drv2 = read("scripts/selftest.mjs");
  ok(/--helper/.test(drv2) && /helper=1/.test(drv2),
    "the driver can ask for the helper mode");
  ok(/nothing is answering on 127\.0\.0\.1:4319/.test(drv2),
    "…and refuses up front when nothing would answer, rather than skipping quietly");
  ok(/res\.mode !== \(HELPER \? "helper" : "no-helper"\)/.test(drv2),
    "…and fails if the page ran in a different mode from the one it asked for");
  ok(/res\.skipped !== res\.expectedSkips/.test(drv2),
    "…and fails on a skip count the mode does not declare");

  // Every block says what it starts from, so a block that starts wrong fails
  // once by name instead of eighteen times by symptom.
  const blocks = [...st.matchAll(/^\s*\/\/ ---- (.+?) -+$/gm)].map((m) => m[1].trim());
  const guarded = [...st.matchAll(/await need\("(.+?)"\)/g)].map((m) => m[1]);
  ok(blocks.length > 15, "the suite is still made of named blocks", `${blocks.length}`);
  ok(guarded.length >= 14, "…and most of them declare their preconditions",
    `${guarded.length} of ${blocks.length}`);
  ok(guarded.every((g) => blocks.includes(g)),
    "…each naming a block that exists, so the message points somewhere",
    guarded.filter((g) => !blocks.includes(g)).join(", "));
  ok(/throw new Error\(`\$\{block\}:/.test(st),
    "…and a precondition that cannot be met names the block that wanted it");

  // The rule the teardown bug came from: wait for the consequence, never for a
  // promise and never for a frame count.
  ok(/const until = async/.test(st) && /const quiet = async/.test(st),
    "the suite can wait on an observable consequence, and on quiescence");

  // The rule that was written last round and then deleted, because the code
  // could not obey it. It could not obey it because the suite predates this
  // project having a browser driver, so it changed state by calling callbacks
  // instead of by operating the interface. That constraint is gone, the code
  // obeys the rule now, and the rule is back.
  ok(!stLines.some((l) => /\ba\.[a-zA-Z]+\(/.test(l) && !/\ba\.re\b/.test(l)),
    "no block calls anything on an object captured during an earlier render");
  ok(!/runBlocks\(\s*a\b/.test(st) && !/^\s*a: Api,/m.test(st),
    "…and the blocks are not handed one to be tempted by");
  ok(!stLines.some((l) => /onDemo\(/.test(l)),
    "the demo is loaded by pressing the button, not by calling the callback behind it");
  ok(/const rail = \(\) =>/.test(st),
    "…and no DOM node is held across a block either: `need` may reload the demo");

  // The DOM twin of that rule, enforced rather than remembered.
  //
  // `need` returns to the empty state and loads the demo again, which remounts
  // the workbench. An element captured before that is detached and answers
  // about a run no longer on screen — which is what `const slider =
  // document.querySelector(".track-hit")` did, silently, for three rounds. So:
  // no single element may be bound at the function-body level of `runBlocks`
  // while a `need` still lies ahead of it. Bindings inside a block are fine,
  // because a block's own `need` runs before them; `.length` is fine because a
  // number cannot go stale.
  {
    const lines = st.split("\n");
    const start = lines.findIndex((l) => /^async function runBlocks\(/.test(l));
    const lastNeed = lines.findLastIndex((l) => /await need\(/.test(l));
    const held = [];
    for (let i = start; i < lastNeed && i < lines.length; i++) {
      if (/^ {2}const \w+ = document\.querySelector\(/.test(lines[i])) {
        held.push(`${i + 1}: ${lines[i].trim().slice(0, 50)}`);
      }
    }
    ok(start > 0 && lastNeed > start,
      "the remount boundaries in the suite can be located", `${start + 1}..${lastNeed + 1}`);
    ok(held.length === 0,
      "…and no element is bound across one of them", held.join(" · "));
  }

  // Every wait observes the thing the next line reads. `settle(n)` could only
  // ever express "wait some frames and hope", so all thirty-nine of its call
  // sites are gone and so is the helper — a function that can only say the
  // wrong thing is a temptation, not a convenience.
  ok(!stLines.some((l) => /\bsettle\(/.test(l)),
    "no wait in the suite counts frames");
  ok(!/const settle = /.test(st),
    "…and the helper that could only count them is gone, not merely unused");

  // What is still driven directly, and the requirement that each one says why.
  const direct = stLines.filter((l) => /api\(\)\.(setPos|setRules|loadTapeFile|attachSyntheticRun)/.test(l));
  ok(direct.length <= 8, "what is left calling into the page directly is a short list",
    `${direct.length} sites`);
  ok(/there is no control that jumps to an arbitrary index|no control that jumps/.test(st) ||
     /six thousand ArrowRights/.test(st),
    "…and the one playhead position that cannot be typed says why");
  ok(/Not driveable at all/.test(st) && /Set rather than typed/.test(st),
    "…and both rule-set replacements say why they are not driven");

  // Operating the interface, rather than reaching past it.
  ok(/function click\(/.test(st) && /function typeInto\(/.test(st) && /async function pickTool\(/.test(st),
    "the suite can click a control, type into one, and open a menu");
  ok(/const shortcut = /.test(st) && /function trackKey\(/.test(st),
    "…and send a shortcut to the window and a key to the playhead");

  // An uncaught error used to be silent. Both of last round's real defects
  // were uncaught TypeErrors and the score did not move by one when they were
  // fixed — 141 before, 141 after. One assertion over a collected list would
  // have caught both without anybody writing a test for either.
  ok(/addEventListener\("error"/.test(st) && /addEventListener\("unhandledrejection"/.test(st),
    "the suite collects what the page threw and what it failed to settle");
  ok(/console\.error = \(/.test(st), "…and what it logged as an error");
  ok(/TRAP\.threw\.length === 0/.test(st) && /TRAP\.logged\.length === 0/.test(st),
    "…and fails on any of it");

  // A detection layer that works and a reporting layer that buries it come to
  // the same thing. These two kept the first three distinct messages, so six of
  // nine planted failures were invisible — measured, not supposed.
  ok(!/TRAP\.(threw|logged)\)\]\.slice\(/.test(st) && !/slice\(0, 3\)/.test(st),
    "the error collectors do not keep only the first few");
  ok(/function tally\(xs: string\[\]\)/.test(st) && /×\$\{c\}/.test(st),
    "…they aggregate instead: every distinct message, with how many times");
  const drv4 = read("scripts/selftest.mjs");
  ok(/const counted = \(xs\)/.test(drv4) && /×\$\{c\}/.test(drv4),
    "…and the driver prints them the same way");

  // The CLI matters more, because its output is what somebody pastes into an
  // issue. Fifty-two rules with twenty-two failures at the far end came back
  // with twenty-two in the list and twenty-two rows in the paste block; ten
  // identical rules came back as ten. Nothing here may start cutting.
  const cli = read("bin/agenttape.mjs");
  const checkBody = cli.slice(cli.indexOf("async function check("), cli.indexOf("// ---------------------------------------------------------------- main"));
  ok(!/\.slice\(0, ?\d+\)/.test(checkBody),
    "the checker's own output truncates nothing");
  const paste = cli.slice(cli.indexOf("function pasteBlock("), cli.indexOf("async function check("));
  ok(!/\.slice\(0, ?\d+\)/.test(paste) && !/new Set\(/.test(paste),
    "…and the block somebody pastes into an issue neither truncates nor de-duplicates");
  const pg = read("app/page.tsx");
  ok(/armErrorTrap\(\);/.test(pg),
    "…armed before the suite starts, so a throw during first render is caught too");

  // The suite must start exactly once. It used to be scheduled inside the
  // effect that exposes the debug handle, whose dependency list is every piece
  // of state on the page: the suite changed state, the effect re-ran, and four
  // hundred milliseconds later a second suite started, then a third, then a
  // fourth. Four concurrent runs mutating one page is the whole explanation
  // for two rounds of symptoms, so the scheduling effect gets its own
  // assertion — an empty dependency list, and nothing to re-run for.
  const sched = pg.slice(pg.indexOf("void runSelfTest()"));
  ok(/\}, \[\]\);/.test(sched.slice(0, 200)),
    "the suite is scheduled from an effect with nothing to re-run for",
    sched.slice(0, 200).split("\n").slice(-3).join(" ").trim());
  ok(/let started = false;/.test(st) && /if \(started\) return;/.test(st),
    "…and refuses a second run even if something schedules one");

  // An allowlist is how a check stops being a check. This one is empty; if it
  // ever is not, every entry has to say what it is and why it is unavoidable.
  const allowFrom = st.indexOf("ALLOWED_CONSOLE") ;
  const allow = st.slice(st.indexOf("= [", allowFrom), st.indexOf("];", allowFrom));
  const entries = (allow.match(/\{\s*why:/g) ?? []).length;
  const whys = (allow.match(/why:\s*"[^"]{12,}"/g) ?? []).length;
  ok(entries === whys, "every console-error exemption says what it is", `${entries} entries, ${whys} explained`);
  ok(/await until\(\) =>/.test(st) === false && (st.match(/await until\(/g) ?? []).length >= 8,
    "…and does so in the places a fixed frame count used to be",
    String((st.match(/await until\(/g) ?? []).length));
}

// ---------------------------------------------------------------- a driver, and no dependency for it
//
// The in-page suite needs a browser. Next round it goes into CI sharing one
// driver with the sibling project, so the driver has to exist as a committed
// file that runs on a Linux runner without editing — and it has to cost
// nothing, because a browser-automation library is what produced a hung launch
// with zero output on this machine.

{
  const drv = read("scripts/selftest.mjs");
  ok(drv !== "", "the driver is committed, not reconstructed each time it is needed");
  ok(!/^import .* from "(?!node:)/m.test(drv),
    "…and imports nothing that is not built into Node");
  ok(Object.keys(pkg.devDependencies ?? {}).every((d) => /^(typescript|@types\/)/.test(d)),
    "…and adds no devDependency either",
    Object.keys(pkg.devDependencies ?? {}).join(", "));
  ok(!/playwright|puppeteer|selenium|webdriver/i.test(JSON.stringify(pkg)),
    "…and no browser-automation library is anywhere near this package");

  // Portability, checked inside the candidate list rather than anywhere in the
  // file. The first version of this matched the string in the *error message*
  // that lists the same names, so deleting a candidate left it green.
  const cands = drv.slice(drv.indexOf("const CANDIDATES"), drv.indexOf("].filter(Boolean)"));
  ok(cands.length > 40, "the driver has a list of places Chrome might be");
  for (const how of ["CHROME_PATH", "Google Chrome.app", "google-chrome", "chromium", "chromium-browser"]) {
    ok(cands.includes(how), "…and looks for it by: " + how);
  }

  ok(/Emulation\.setDeviceMetricsOverride/.test(drv), "it sets a viewport rather than taking one");
  ok(/Emulation\.setFocusEmulationEnabled/.test(drv),
    "…and gives the window focus, so a focus assertion cannot pass for the wrong reason");
  ok(/hasFocus/.test(drv),
    "…with the measured reason written down rather than the usual claim about it");
  ok(/Runtime\.exceptionThrown/.test(drv) && /consoleAPICalled/.test(drv),
    "it watches the protocol for throws and console errors as a second pair of eyes");
  ok(/process\.exit\(code\)/.test(drv) && /code = 1;/.test(drv) && /code = 2;/.test(drv),
    "it exits non-zero on a failure and on a setup problem, differently");
  ok(/── copy from here/.test(drv), "…and prints failures in the same paste-able shape as the checker");
  ok(/res\.total !== res\.expected/.test(drv),
    "…and treats a short run as a failure, not as a smaller number");
  ok(/Nothing is serving/.test(drv),
    "…and says so at once when nothing is serving, rather than after a timeout");
  ok((pkg.scripts ?? {}).selftest === "node scripts/selftest.mjs",
    "there is one command to run it", (pkg.scripts ?? {}).selftest ?? "missing");

  // The workflow comment was true as an intention and false as a fact.
  const wf = read(".github/workflows/ci.yml");
  // Checked as the presence of the correction rather than the absence of the
  // old wording: the old sentence is quoted in the new one, and an absence
  // check on prose is a check anybody can dodge by rephrasing.
  // The correction stays in the file after the gap it describes is closed.
  // What it cost is why the job below asserts three numbers instead of one, so
  // deleting the history would delete the reason for the design.
  ok(/false as a fact/.test(wf),
    "the workflow says what actually happened, not what was intended");
  ok(/eighteen of its assertions were/.test(wf) && /four concurrent copies/.test(wf),
    "…including the cost and the cause");
  ok(/as of round eight/.test(wf) && /scripts\/selftest\.mjs/.test(wf),
    "…and that the gap is closed, and by what");
}

// ---------------------------------------------------------------- one build directory each
//
// `next dev` and `next build` wrote to the same `.next`. A dev server left
// running in another terminal rewrote it under a production build, and
// `next start` then read half of one build and half of another and answered
// every request with `Cannot find module './331.js'`. It cost three rounds,
// twice diagnosed correctly and not fixed, because a rebuild is faster than a
// fix until the third time.

{
  const cfg = read("next.config.mjs");
  ok(cfg !== "", "there is a build configuration at all");
  ok(/PHASE_DEVELOPMENT_SERVER/.test(cfg) && /distDir/.test(cfg),
    "…and it chooses the build directory from the phase");
  ok(/\.next-dev/.test(cfg), "…so development has one of its own");
  // Build and start must agree, which they do by both being not-development.
  // A config that named three directories would have reintroduced the bug in
  // a new place.
  const dirs = [...cfg.matchAll(/"(\.next[a-z-]*)"/g)].map((m) => m[1]);
  ok(new Set(dirs).size === 2 && dirs.includes(".next") && dirs.includes(".next-dev"),
    "…and there are exactly two, so build and start cannot be split apart",
    dirs.join(", "));

  ok((pkg.scripts ?? {}).prestart === "next build",
    "starting a production server builds first, so it cannot read a half-written directory",
    (pkg.scripts ?? {}).prestart ?? "missing");
  ok(/^\.next-dev\/$/m.test(gitignore), "the development directory is ignored");
  // Both build directories are build output, and this file walks source.
  // Missing one turns every privacy check into a report about Next's bundles.
  ok(skip.has(".next") && skip.has(".next-dev"),
    "…and neither build directory is mistaken for source by this checker");

  const bd = read("docs/build-directories.md");
  ok(bd !== "", "the paragraph that would have saved three rounds is written down");
  ok(/Cannot find module/.test(bd),
    "…including the error it produces, since that is what somebody will search for");
  ok(/docs\/build-directories\.md/.test(readme), "…and the README points at it");
}

// ---------------------------------------------------------------- the counters can be broken
//
// A counter nobody has ever broken is a counter nobody knows counts. This
// project's own audit tool was wrong twice in one round — an off-by-one stack
// frame reported three hundred dead lines, then a regex matching comments
// reported six — and an instrument that is wrong and an injection that misses
// are the same failure. `npm run counters` is the check for that failure.

{
  const g = read("scripts/counters.mjs");
  ok(g !== "", "the counter guard is committed");
  ok(!/^import .* from "(?!node:)/m.test(g), "…and imports nothing that is not built into Node");
  for (const [what, re] of [
    ["a regex a per-line scanner misreads", /regex literal that a per-line scanner/],
    ["an assertion appended after process.exit", /appended after process\.exit/],
    ["an assertion deleted", /an assertion deleted/],
    ["a check defined and never called", /defined and never called/],
    ["the in-page suite gaining an assertion", /gains an assertion without updating/],
    ["an unmutated copy still passing", /an unmutated copy still passes/],
  ]) ok(re.test(g), "…and breaks the counting by: " + what);

  // Caught is not the same as caught by the right thing.
  ok(/c\.expect\.test\(r\.out\)/.test(g),
    "…and requires each break to fail the check that is supposed to catch it");
  ok(/expect: \/agree about where they are\//.test(g),
    "…and the regex plant specifically has to trip the two counters disagreeing, " +
    "not merely the total moving");
  ok(/changed nothing — it missed/.test(g),
    "…and treats a mutation that edited nothing as a miss, not as a pass");
  ok(/process\.exit\(failed \? 1 : 0\)/.test(g), "…and exits non-zero when one is not caught");
  ok((pkg.scripts ?? {}).counters === "node scripts/counters.mjs",
    "there is one command to run it", (pkg.scripts ?? {}).counters ?? "missing");
  ok(/npm run counters/.test(read(".github/workflows/ci.yml")),
    "…and CI runs it, since it needs no browser");
}

// ---------------------------------------------------------------- the in-page suite is a gate
//
// As of round eight it runs on every push. For two rounds before that it was
// red on main while this workflow was green, so the job asserts the contract
// rather than only that nothing failed: three numbers, and the mode it ran in.

{
  const wf = read(".github/workflows/ci.yml");
  ok(/^  in-page:$/m.test(wf), "CI has a job for the in-page suite");
  ok(/timeout-minutes:/.test(wf),
    "…with a finite budget, so a hung browser reads as a failure and not as silence");
  ok(/scripts\/selftest\.mjs http:\/\/127\.0\.0\.1:3000\//.test(wf),
    "…driving a production build it served itself");
  ok(/grep -qF "\[no-helper\]"/.test(wf),
    "…asserting the mode it ran in rather than inferring it");
  const total9 = Number(read("app/selftest.ts").match(/DECLARED_ASSERTIONS = (\d+);/)?.[1] ?? -1);
  const skips9 = Number(read("app/selftest.ts")
    .match(/"no-helper": \{ total: DECLARED_ASSERTIONS, skipped: (\d+) \}/)?.[1] ?? -1);
  ok(wf.includes(
    `${total9 - skips9}/${total9} passed · 0 failed · ${skips9} not run here · ` +
    `${total9} declared, ${skips9} skips declared`),
    "…and all three declared numbers, since any of them moving is a red build",
    `${total9 - skips9}/${total9}, ${skips9} skipped`);
  ok(!/--helper/.test(wf), "…and never the helper mode, which cannot run on a runner");
  ok(/set -o pipefail/.test(wf),
    "…with the driver's exit code surviving the pipe into tee");
  ok(/wall time:/.test(wf), "…and the wall time in the log");

  const drv3 = read("scripts/selftest.mjs");
  ok(/BUILD_ID/.test(drv3),
    "the driver refuses a server that is not serving this build");
  ok(/not serving this build/.test(drv3),
    "…and says which build it wanted, since the accident is a leftover process");
  ok(/__selftest_at/.test(drv3) && /__selftest_at/.test(read("app/selftest.ts")),
    "…and a timeout names the block it stopped in rather than only that it stopped");
  ok(/It never entered a block/.test(drv3),
    "…including when it never got that far");
}

// ---------------------------------------------------------------- did every check run
//
// The audit the block above exists for. Every `ok(` in this file is a call site
// that was written to run; the ones that did not are either dead code or a
// check somebody believes is protecting them and is not. Reported by line, so
// the answer is a place in the file rather than a number.

{
  const src = readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n");
  const MARK = "did every check run";
  const self = src.findIndex((l) => l.includes("// ---") && l.includes(MARK)) + 1;
  const sites = [];
  for (let i = 0; i < src.length; i++) {
    const line = src[i];
    // A comment that talks about assertions is not an assertion. Two of this
    // file's own comments say `ok(` and were reported as dead code by the first
    // version of this audit, which is the audit failing rather than the file.
    if (/^\s*(\/\/|\*)/.test(line)) continue;
    // A call, not a property access and not a longer name.
    if (!/(?:^|[^\w.$])ok\(/.test(line) || /const ok\s*=/.test(line)) continue;
    sites.push(i + 1);
  }
  // The audit cannot watch itself fire: its own assertions run after the set of
  // dead lines has been computed. So they are excluded by position and their
  // number is pinned instead, which is the same trick under a different name —
  // if somebody moves an assertion below this marker to hide it, the count moves.
  const mine = sites.filter((n) => n > self);
  const dead = sites.filter((n) => n <= self && !fired.has(n));
  // The other direction, which is the scanner-stopped-early signature: a line
  // that ran an assertion and that the scanner never saw. `fired` is collected
  // by the running program and owes nothing to any regex, so the two methods
  // fail in entirely different ways.
  const byTokenSelf = callLinesOf(src.join("\n"), ["ok"]);
  const unseen = [...fired].filter((n) => !byTokenSelf.has(n));
  ok(self > 0 && sites.length > 20,
    "the reachability audit can see this file's own call sites",
    `${sites.length} call sites, marker at line ${self}`);
  // Three from the audit itself, one from the declared-total check that has to
  // run after every other assertion in the file has been counted.
  // Four from the audit and the declared-total check, plus the one that
  // compares the scanner with the runtime record.
  ok(mine.length === 5, "…and only its own assertions sit below the marker",
    `${mine.length} below line ${self}`);
  ok(dead.length === 0, "every assertion in verify.mjs actually ran",
    dead.length ? `never ran: line ${dead.join(", line ")}` : "");
  ok(unseen.length === 0,
    "…and the scanner saw every line that ran one",
    unseen.length ? `ran but not counted: line ${unseen.join(", line ")}` : "");
}

// ---------------------------------------------------------------- how many checks there are
//
// The accumulated counter. Nothing else here notices an assertion being
// deleted: the total simply comes out smaller and every remaining check still
// passes. Declaring it turns a deletion into a failure, at the cost of one
// number that has to move when the file does — which is the correct trade,
// because the alternative is a suite that shrinks without saying so.
const EXPECTED_CHECKS = 697;
ok(checked + 1 === EXPECTED_CHECKS, "this file ran every check it declares",
  `${checked + 1} ran, ${EXPECTED_CHECKS} declared`);

console.log(`\n${checked - failed}/${checked} checks passed`);
process.exit(failed ? 1 : 0);
