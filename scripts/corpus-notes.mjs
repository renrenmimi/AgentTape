// What the whole corpus says, from statistics alone.
//
//   node bin/agenttape.mjs index --json | node scripts/corpus-notes.mjs > docs/corpus-notes.md
//
// The input is the helper's statistics index and nothing else: counts,
// durations, token totals, and names from the writer's own vocabulary. No
// message text passes through this script because none reaches the index it
// reads — that boundary is enforced in lib/stats.ts and asserted in verify.mjs.
//
// The output is deliberately gitignored. It is a description of how one person
// works, computed from their own transcripts, and whether any of it is worth
// publishing is their call and not this script's.

const raw = await new Promise((done) => {
  let text = "";
  process.stdin.on("data", (c) => { text += c; });
  process.stdin.on("end", () => done(text));
});

const S = JSON.parse(raw);
if (!Array.isArray(S) || !S.length) {
  console.error("no sessions on stdin — pipe `agenttape index --json` into this");
  process.exit(2);
}

const n = (x) => Math.round(x).toLocaleString("en-US");
const pct = (a, b) => (b ? ((a / b) * 100).toFixed(1) + "%" : "—");
const dur = (ms) => {
  if (!ms) return "0";
  const s = Math.round(ms / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
};
const mb = (b) => (b / 1048576).toFixed(1) + " MB";
const q = (arr, p) => {
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(a.length * p))] ?? 0;
};
const sum = (arr, f) => arr.reduce((t, x) => t + f(x), 0);

const L = [];
const say = (...s) => L.push(...s);

say("# What the corpus says", "");
say("Computed from the helper's statistics index — counts, durations, token totals and",
    "tool names. No message text was read to produce any figure here.", "");
say(`${n(S.length)} sessions · ${n(sum(S, (s) => s.lines))} lines · ${mb(sum(S, (s) => s.bytes))}`,
    `· ${n(sum(S, (s) => s.conversationSteps))} steps · ${n(sum(S, (s) => s.toolCalls))} tool calls`, "");

// ------------------------------------------------------------------ size
say("## How long a session is", "");
const steps = S.map((s) => s.conversationSteps);
const bytes = S.map((s) => s.bytes);
say("| | steps | lines | bytes | tool calls |", "| --- | --- | --- | --- | --- |");
for (const [label, p] of [["shortest", 0], ["p25", 0.25], ["median", 0.5], ["p75", 0.75],
                          ["p90", 0.9], ["longest", 1]]) {
  say(`| ${label} | ${n(q(steps, p))} | ${n(q(S.map((s) => s.lines), p))} | ` +
      `${mb(q(bytes, p))} | ${n(q(S.map((s) => s.toolCalls), p))} |`);
}
say("");
const big = [...S].sort((a, b) => b.conversationSteps - a.conversationSteps);
const topShare = sum(big.slice(0, 5), (s) => s.conversationSteps) / sum(S, (s) => s.conversationSteps);
say(`The five longest sessions hold ${pct(topShare, 1)} of every step in the corpus.`,
    `The median session is ${n(q(steps, 0.5))} steps; the longest is ${n(q(steps, 1))}.`, "");

// ------------------------------------------------------------------ tools
say("## Which tools, how often, and how badly", "");
const tools = new Map();
for (const s of S) {
  for (const [name, c] of Object.entries(s.tools ?? {})) {
    const t = tools.get(name) ?? { calls: 0, errors: 0, sessions: 0 };
    t.calls += c;
    t.sessions += 1;
    t.errors += (s.toolErrors ?? {})[name] ?? 0;
    tools.set(name, t);
  }
}
const totalCalls = sum(S, (s) => s.toolCalls);
const ranked = [...tools.entries()].sort((a, b) => b[1].calls - a[1].calls);
say(`${ranked.length} distinct tools were called ${n(totalCalls)} times.`, "");
say("| tool | calls | share | sessions | failed | failure rate |",
    "| --- | --- | --- | --- | --- | --- |");
for (const [name, t] of ranked.slice(0, 20)) {
  say(`| \`${name}\` | ${n(t.calls)} | ${pct(t.calls, totalCalls)} | ${t.sessions} | ` +
      `${n(t.errors)} | ${pct(t.errors, t.calls)} |`);
}
if (ranked.length > 20) say(`| … | | | | | ${ranked.length - 20} more tools |`);
say("");
const mcp = ranked.filter(([x]) => x.startsWith("mcp__"));
say(`MCP tools: ${mcp.length} of ${ranked.length} distinct names, ` +
    `${pct(sum(mcp, ([, t]) => t.calls), totalCalls)} of all calls.`, "");
const worst = ranked.filter(([, t]) => t.calls >= 20).sort((a, b) => (b[1].errors / b[1].calls) - (a[1].errors / a[1].calls));
say("", "Highest failure rates among tools called at least twenty times:", "");
say("| tool | calls | failure rate |", "| --- | --- | --- |");
for (const [name, t] of worst.slice(0, 8)) {
  say(`| \`${name}\` | ${n(t.calls)} | ${pct(t.errors, t.calls)} |`);
}
say("");

// ---------------------------------------------------------------- context
say("## How context grows", "");
const withCtx = S.filter((s) => s.peakCtx > 0);
say(`| | peak context |`, "| --- | --- |");
for (const [label, p] of [["p25", 0.25], ["median", 0.5], ["p75", 0.75], ["p90", 0.9], ["max", 1]]) {
  say(`| ${label} | ${n(q(withCtx.map((s) => s.peakCtx), p))} |`);
}
say("");
// Where does the profile stop rising? The first bucket within 5% of the peak.
const plateau = [];
for (const s of withCtx) {
  const p = s.ctxProfile ?? [];
  if (!p.length || !s.peakCtx) continue;
  const i = p.findIndex((v) => v >= s.peakCtx * 0.95);
  if (i >= 0) plateau.push(i / (p.length - 1));
}
say(`Context reaches within 5% of its peak by ${pct(q(plateau, 0.5), 1)} of the way through a ` +
    `median session, and by ${pct(q(plateau, 0.25), 1)} in the quarter that plateau earliest.`, "");
const nearLimit = withCtx.filter((s) => s.peakCtx > 900_000).length;
const over200 = withCtx.filter((s) => s.peakCtx > 200_000).length;
say(`${over200} of ${withCtx.length} sessions passed 200k tokens of context; ` +
    `${nearLimit} passed 900k.`, "");
const jumps = S.filter((s) => s.jumpBy > 0).map((s) => s.jumpBy);
say(`The largest single-step increase in a session is a median of ${n(q(jumps, 0.5))} tokens ` +
    `and reaches ${n(q(jumps, 1))} at worst.`, "");
say("");

// ------------------------------------------------------------- compaction
say("## Compaction and delegation", "");
const compacted = S.filter((s) => s.compactions > 0);
say(`${compacted.length} of ${S.length} sessions compacted at least once ` +
    `(${pct(compacted.length, S.length)}), ${n(sum(S, (s) => s.compactions))} compactions in total.`);
if (compacted.length) {
  say(`Sessions that compacted are a median of ${n(q(compacted.map((s) => s.conversationSteps), 0.5))} ` +
      `steps against ${n(q(S.filter((s) => !s.compactions).map((s) => s.conversationSteps), 0.5))} ` +
      "for those that did not.");
}
say("");
const delegated = S.filter((s) => s.delegations > 0);
say(`${delegated.length} of ${S.length} sessions delegated (${pct(delegated.length, S.length)}), ` +
    `${n(sum(S, (s) => s.delegations))} delegations in total.`);
if (delegated.length) {
  say(`Among those that delegate at all, the median is ${n(q(delegated.map((s) => s.delegations), 0.5))} ` +
      `delegations and the most is ${n(q(delegated.map((s) => s.delegations), 1))}.`);
}
say("");

// ------------------------------------------------------------------- time
say("## Where the time goes", "");
const wall = sum(S, (s) => s.wallMs);
const active = sum(S, (s) => s.activeMs);
say(`Wall clock across every session: ${dur(wall)}. Active: ${dur(active)}. ` +
    `**${pct(wall - active, wall)} of elapsed time is idle** — gaps longer than two minutes.`, "");
say(`| | wall | active | idle share |`, "| --- | --- | --- | --- |");
for (const [label, p] of [["p25", 0.25], ["median", 0.5], ["p75", 0.75], ["longest", 1]]) {
  const w = q(S.map((s) => s.wallMs), p);
  const a = q(S.map((s) => s.activeMs), p);
  say(`| ${label} | ${dur(w)} | ${dur(a)} | ${pct(Math.max(0, w - a), w)} |`);
}
say("");
const spans = S.filter((s) => s.wallMs > 24 * 3600e3).length;
say(`${spans} of ${S.length} sessions span more than a day of wall clock — they are resumed, ` +
    "not run in one sitting.", "");
say(`Longest single idle gap in any session: ${dur(Math.max(...S.map((s) => s.longestGapMs || 0)))}.`, "");
say("");

// ---------------------------------------------------------------- errors
say("## Failure", "");
const errs = sum(S, (s) => s.errors);
say(`${n(errs)} failed steps across ${n(totalCalls)} tool calls — ${pct(errs, totalCalls)}.`);
const clean = S.filter((s) => s.errors === 0).length;
say(`${clean} of ${S.length} sessions had no failure at all (${pct(clean, S.length)}).`);
const worstSessions = [...S].sort((a, b) => b.errors - a.errors).slice(0, 3);
say(`The three worst sessions hold ${n(sum(worstSessions, (s) => s.errors))} of them ` +
    `(${pct(sum(worstSessions, (s) => s.errors), errs)}).`, "");

// --------------------------------------------------------------- versions
say("## Models and writer versions", "");
const models = new Map();
for (const s of S) for (const m of s.models ?? []) models.set(m, (models.get(m) ?? 0) + 1);
say("| model | sessions |", "| --- | --- |");
for (const [m, c] of [...models.entries()].sort((a, b) => b[1] - a[1])) say(`| \`${m}\` | ${c} |`);
say("");
const versions = new Map();
for (const s of S) for (const v of s.versions ?? []) versions.set(v, (versions.get(v) ?? 0) + 1);
say(`${versions.size} distinct writer versions appear across the corpus: ` +
    [...versions.keys()].sort().map((v) => "`" + v + "`").join(", ") + ".", "");
const multi = S.filter((s) => (s.versions ?? []).length > 1).length;
say(`${multi} sessions were written by more than one version — they outlived an upgrade.`, "");

console.log(L.join("\n"));
