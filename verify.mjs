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

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
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
import { markdownReport, sparkline } from "./lib/report.ts";
import {
  DEFAULT_RULES, RULES_FORMAT, checkAll, checkRule, parseRule, parseRuleSet,
  ruleLabel, serializeRuleSet, tally,
} from "./lib/assert.ts";

const root = new URL("./", import.meta.url).pathname;
let failed = 0, checked = 0;
const ok = (cond, label, note) => {
  checked++;
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
  ok(/does not read what they said/.test(verdictLine(ident)), "…and the verdict says why");

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
  ["CI does not run the in-page suite", /CI does not run the in-page suite/i],
]) {
  ok(re.test(limits), "the limits section states: " + what);
}

// walk every source file we ship
const skip = new Set(["node_modules", ".next", ".git", "out"]);
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(p);
  }
})(root);

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
const emptySrc = read("app/empty-state.tsx");
ok(/Look for it|Look again/.test(emptySrc),
  "…and there is a control to look for it the first time");
ok(/Look for it|Look again/.test(read("app/compare.tsx")),
  "…on the comparison panel too");
// One implementation, so the two panels cannot drift apart on it.
const probeImpls = [emptySrc, read("app/compare.tsx")]
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
const ovSrc = read("app/overview.tsx");
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
ok(/hit\.bytes === f\.st\.size && hit\.mtime === f\.st\.mtimeMs/.test(helperCode),
  "the cache is keyed by the file's size and mtime together");


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
const appSrc = read("app/page.tsx") + read("app/empty-state.tsx");
ok(!/meta\.description|\.description\b/.test(appSrc),
  "the page never reads a subagent description either");

// The helper used to resolve ../out and tell the user to "build to ./out".
// Nothing in this repository writes an out/ directory — `next build` writes
// .next — so following the instruction failed. Every directory the helper
// resolves or advertises must be one that exists or that a script produces.
const PRODUCED_BY_A_SCRIPT = new Set([".next"]); // what `next build` writes
const helperResolves = [...helperCode.matchAll(/new URL\(\s*["']\.\.\/([^"'/]+)/g)].map((m) => m[1]);
for (const dir of helperResolves) {
  ok(existsSync(join(root, dir)) || PRODUCED_BY_A_SCRIPT.has(dir),
    "the helper only resolves a directory this repository can produce: " + dir);
}
// Same rule for what it tells the user, which is where the original bug lived.
const advertised = [...helper.matchAll(/(?:^|[\s"'`(])\.\/([a-z][a-z0-9_-]*)\/?(?=[\s"'`.,)]|$)/gm)]
  .map((m) => m[1])
  .filter((d) => d !== "bin");
for (const dir of new Set(advertised)) {
  ok(existsSync(join(root, dir)) || PRODUCED_BY_A_SCRIPT.has(dir),
    "the helper never advertises a directory this repository cannot produce: ./" + dir);
}
ok(!/serveStatic|APP_ROOT/.test(helperCode),
  "the helper has one path-resolution surface, not two");

console.log(`\n${checked - failed}/${checked} checks passed`);
process.exit(failed ? 1 : 0);
