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
import { summarise } from "./lib/summary.ts";
import { EMPTY_FILTER, applyFilter, buildFilterIndex, isActive, seek } from "./lib/filter.ts";

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
for (const item of ["side by side", "assertion", "live recording", "subagents", "OpenAI"]) {
  ok(readme.toLowerCase().includes(item.toLowerCase()), "the roadmap names: " + item);
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
ok(remoteUrls.length === 0, "no shipped file names a host other than 127.0.0.1",
  remoteUrls.join(", "));

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
