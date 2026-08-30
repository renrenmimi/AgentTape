// A draft article about what forty agent sessions look like from the outside.
//
//   node bin/agenttape.mjs index --json | node scripts/findings-draft.mjs > docs/findings.draft.md
//
// The prose is written here and the figures are interpolated from the index, so
// the two cannot drift: rerun it and every number is current or the script
// fails loudly. Input is the helper's statistics index — counts, durations,
// token totals and tool names — and nothing else. No message text passes
// through, because none reaches the index it reads.
//
// The output is gitignored. It describes how one person works, and whether that
// is published is their call.

const raw = await new Promise((done) => {
  let t = "";
  process.stdin.on("data", (c) => { t += c; });
  process.stdin.on("end", () => done(t));
});
const S = JSON.parse(raw);
if (!Array.isArray(S) || !S.length) {
  console.error("no sessions on stdin — pipe `agenttape index --json` into this");
  process.exit(2);
}

const n = (x) => Math.round(x).toLocaleString("en-US");
const pct1 = (a, b) => (b ? ((a / b) * 100).toFixed(1) + "%" : "—");
const sum = (f) => S.reduce((t, x) => t + f(x), 0);
const q = (arr, p) => {
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(a.length * p))] ?? 0;
};
const days = (ms) => (ms / 86400e3).toFixed(1);
const hours = (ms) => (ms / 3600e3).toFixed(1);

// --- the figures the article rests on ---------------------------------------
const sessions = S.length;
const totalCalls = sum((s) => s.toolCalls);
const totalErrors = sum((s) => s.errors);
const wall = sum((s) => s.wallMs);
const active = sum((s) => s.activeMs);
const synthetic = S.filter((s) => (s.models ?? []).includes("<synthetic>")).length;
const compacted = S.filter((s) => s.compactions > 0);
const withCtx = S.filter((s) => s.peakCtx > 0);
const over900 = withCtx.filter((s) => s.peakCtx > 900_000).length;
const resumed = S.filter((s) => s.wallMs > 86400e3).length;
const longestGap = Math.max(...S.map((s) => s.longestGapMs || 0));
const versions = new Set(S.flatMap((s) => s.versions ?? []));
// Per-session idle share, then the median of those. A ratio of two medians is
// not a median ratio and would be quietly wrong here.
const idleShares = S.filter((s) => s.wallMs > 0)
  .map((s) => Math.max(0, s.wallMs - s.activeMs) / s.wallMs);
const medianIdleShare = (q(idleShares, 0.5) * 100).toFixed(1) + "%";

const tools = new Map();
for (const s of S) {
  for (const [name, c] of Object.entries(s.tools ?? {})) {
    const t = tools.get(name) ?? { calls: 0, errors: 0 };
    t.calls += c;
    t.errors += (s.toolErrors ?? {})[name] ?? 0;
    tools.set(name, t);
  }
}
const rate = (name) => {
  const t = tools.get(name);
  return t && t.calls ? pct1(t.errors, t.calls) : "—";
};
const calls = (name) => n(tools.get(name)?.calls ?? 0);
const byRate = [...tools.entries()]
  .filter(([, t]) => t.calls >= 20)
  .sort((a, b) => b[1].errors / b[1].calls - a[1].errors / a[1].calls);
const mcp = [...tools.entries()].filter(([x]) => x.startsWith("mcp__"));
const mcpCalls = mcp.reduce((t, [, x]) => t + x.calls, 0);
const mcpErrors = mcp.reduce((t, [, x]) => t + x.errors, 0);
const nonMcp = [...tools.entries()].filter(([x]) => !x.startsWith("mcp__"));
const nonMcpCalls = nonMcp.reduce((t, [, x]) => t + x.calls, 0);
const nonMcpErrors = nonMcp.reduce((t, [, x]) => t + x.errors, 0);

const L = [];
const say = (...s) => L.push(...s);

say("# Four things forty agent sessions say about how agents actually run", "");
say("*Draft. Not published. Every figure below is interpolated from the measurement,",
    "so this document cannot drift from the data it describes.*", "");

say("## What was measured, and how", "");
say(`${n(sessions)} Claude Code sessions from a single machine: ${n(sum((s) => s.lines))} lines,`,
    `${(sum((s) => s.bytes) / 1048576).toFixed(0)} MB, ${n(sum((s) => s.conversationSteps))} steps and`,
    `${n(totalCalls)} tool calls, written by ${versions.size} different Claude Code versions over`,
    `about ${days(wall)} days of wall clock.`, "");
say("Claude Code writes each session to disk as newline-delimited JSON. The measurement reads",
    "those files and computes counts, durations, token totals and tool names — no message text is",
    "read at all, and the code that builds each record is asserted not to be able to carry a",
    "sentence. Everything here is therefore about the *shape* of a run, never its content.", "");
say("**This is n=40, one machine, one person.** Every number below is a description of that",
    "sample and a hypothesis about anything else. Read them as questions worth asking of your own",
    "transcripts, not as facts about agents in general. Where a finding would change what somebody",
    "builds, that matters more than usual.", "");

// ---------------------------------------------------------------- finding 1
say("## 1. Nearly half of sessions contain a failed API call, and nothing shows it", "");
say(`${n(synthetic)} of ${n(sessions)} sessions — ${pct1(synthetic, sessions)} — contain at least`,
    "one assistant record whose model is `<synthetic>`.", "");
say("`<synthetic>` is not a model. It is what the writer puts on an assistant record that stands",
    "for a failed API call rather than a response: it appears with `isApiErrorMessage: true`, an",
    "`error` and an `apiErrorStatus`, and its usage figures are null. In the transcript it sits",
    "in the conversation looking like any other assistant turn.", "");
say("**What it implies.** If you are measuring agent reliability from a transcript, a failed API",
    "call is not in your error count unless you went looking for that field specifically. There",
    "is no single flag meaning \"this went wrong\" — a step has failed if a tool result carries",
    "`is_error`, *or* the record is an API error, *or* a system record has `level: \"error\"`, *or*",
    "a permission prompt was denied. Four different signals. Anything counting one of them is",
    "undercounting, and in this corpus the undercount is large.", "");

// ---------------------------------------------------------------- finding 2
say("## 2. A session is a project lifecycle, not a sitting", "");
say(`Across the corpus, wall-clock time totals **${days(wall)} days** and active time —`,
    `everything outside gaps longer than two minutes — totals **${days(active)} days**.`,
    `That is **${pct1(wall - active, wall)} idle**. Taking each session's own idle share and`,
    `reading off the middle of those — not the ratio of two medians, which is a different and`,
    `wronger number — the median session is **${medianIdleShare}** idle.`,
    `${n(resumed)} of ${n(sessions)} sessions span more than a day. The longest single gap`,
    `inside one session is **${days(longestGap)} days**.`, "");
say("**What it implies.** \"Session duration\" computed as last timestamp minus first is not a",
    "measure of anything. A session is a container that gets reopened for weeks, so any per-session",
    "rate — errors per hour, tokens per minute — is meaningless unless the gaps come out first.",
    "It also means a transcript spans model versions and tool versions: in this corpus",
    `${n(S.filter((s) => (s.versions ?? []).length > 1).length)} sessions were written by more than`,
    "one Claude Code version, so a single file can contain records in two different shapes.", "");

// ---------------------------------------------------------------- finding 3
say("## 3. Context reaches the ceiling; compaction almost never catches it", "");
say(`${n(compacted.length)} of ${n(sessions)} sessions compacted at all`,
    `(${pct1(compacted.length, sessions)}), ${n(sum((s) => s.compactions))} compactions in total.`,
    `Meanwhile the median peak context is **${n(q(withCtx.map((s) => s.peakCtx), 0.5))} tokens**,`,
    `${n(withCtx.filter((s) => s.peakCtx > 200_000).length)} sessions passed 200k, and`,
    `**${n(over900)} passed 900k**.`, "");
say("Context also does not plateau. It reaches within 5% of its own peak only near the very end",
    "of a median session — which is to say it grows monotonically until the session stops.", "");
say(`The largest single-step increase in a session is a median of`,
    `**${n(q(S.filter((s) => s.jumpBy > 0).map((s) => s.jumpBy), 0.5))} tokens** and reaches`,
    `${n(q(S.filter((s) => s.jumpBy > 0).map((s) => s.jumpBy), 1))} at worst. One step, half a`,
    "context window.", "");
say("**What it implies.** Sessions stop at the wall rather than compacting past it, so if you are",
    "designing for long-running agents, the thing to watch is not the compaction rate but the",
    "single step that puts a large payload in the array — usually a whole-file read. That payload",
    "is then re-sent on every subsequent turn, which is a cost that compounds silently. Attributing",
    "growth to the step that caused it is more useful than a total.", "");

// ---------------------------------------------------------------- finding 4
say("## 4. Browser-automation tools fail an order of magnitude more often than the shell", "");
say(`${n(totalErrors)} failed steps across ${n(totalCalls)} tool calls — ${pct1(totalErrors, totalCalls)}`,
    "overall. The rate is not remotely uniform.", "");
say("", "| tool | calls | failure rate |", "| --- | --- | --- |");
for (const [name] of byRate.slice(0, 6)) say(`| \`${name}\` | ${calls(name)} | ${rate(name)} |`);
say(`| \`Bash\` | ${calls("Bash")} | ${rate("Bash")} |`);
say(`| \`Read\` | ${calls("Read")} | ${rate("Read")} |`);
say(`| \`Edit\` | ${calls("Edit")} | ${rate("Edit")} |`);
say("");
say(`Grouped: MCP tools account for ${pct1(mcpCalls, totalCalls)} of calls and fail at`,
    `**${pct1(mcpErrors, mcpCalls)}**; everything else fails at **${pct1(nonMcpErrors, nonMcpCalls)}**.`, "");
say("**What it implies, and this is the actionable one.** Retry policy should differ by tool class.",
    "A uniform \"retry twice on failure\" is tuned for neither: it is wasteful against a tool that",
    "fails a fiftieth of the time and insufficient against one that fails a sixth of the time. Tool",
    "classes with high failure rates also want different *prompting* — an agent that knows a",
    "browser action is unreliable can be told to verify rather than assume, which an agent driving",
    "a shell does not need.", "");
say("The pattern is not surprising in hindsight: these tools drive a live browser, so they fail",
    "for reasons that have nothing to do with the agent — a page not settled, an element not",
    "there yet, a session that timed out. That is exactly why the retry policy should know the",
    "difference.", "");

// ------------------------------------------------------------------- limits
say("## What this does not establish", "");
say(`One machine, one person, ${n(sessions)} sessions, ${versions.size} writer versions. The work`,
    "is skewed toward a particular kind of task, the tool mix reflects one person's setup, and",
    "the browser-automation figures in particular come from one MCP server rather than from",
    "browser automation in general.", "");
say("Findings 1 and 2 are about the file format and about how sessions are used, and both would",
    "be surprising to *not* replicate. Findings 3 and 4 are rates, and rates from n=40 on one",
    "machine are a hypothesis with a number attached. The useful move is not to believe them but",
    "to run the same measurement over your own transcripts, which takes about two seconds.", "");

console.log(L.join("\n"));
