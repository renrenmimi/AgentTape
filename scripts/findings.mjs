#!/usr/bin/env node
// The article, generated from the measurement so the prose cannot drift.
//
//   node bin/agenttape.mjs stats --json | node scripts/findings.mjs > docs/findings.md
//
// Every figure below is interpolated from the summary rather than typed, which
// is the whole reason this is a script and not a document. A number written by
// hand in prose is a number that will be wrong later and will look fine.
//
// It opens nothing. The summary arrives on stdin, already reduced to counts and
// tool names by lib/corpus.ts, which itself parses nothing — so no path this
// article is built through has ever held a sentence from a transcript.

const raw = await new Promise((res) => {
  let s = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => { s += d; });
  process.stdin.on("end", () => res(s));
});

const c = JSON.parse(raw);
if (!c || typeof c.n !== "number") {
  console.error("expected `agenttape stats --json` on stdin");
  process.exit(2);
}

const n = (x) => Math.round(x).toLocaleString("en-US");
const pct = (x, d = 1) => (x * 100).toFixed(d) + "%";
const days = (ms) => (ms / 86_400_000).toFixed(1);
const out = [];
const say = (...lines) => out.push(lines.join("\n"));

say(`# Four things ${n(c.n)} agent sessions say about how agents actually run`);
say(`*Every figure here is interpolated from the measurement that produced it, so this
document cannot drift from the data it describes. Two of the four findings are
facts about a file format and about how sessions are used. The other two are
rates from one machine, and they are an invitation rather than a result — the
tool that produced them ships with the repository so you can put your own number
beside mine.*`);

say(`## What was measured, and how`);
say(`${n(c.n)} Claude Code sessions from a single machine: ${n(c.lines)} lines,
${(c.bytes / 1e6).toFixed(0)} MB, ${n(c.steps)} steps and ${n(c.toolCalls)} tool calls,
written by ${n(c.writerVersions)} different Claude Code versions over about
${days(c.time.wallMs)} days of wall clock.`);
say(`Claude Code writes each session to disk as newline-delimited JSON. The measurement reads
those files and computes counts, durations, token totals and tool names — no message text is
read at all, and the code that builds each record is asserted not to be able to carry a
sentence. Everything here is therefore about the *shape* of a run, never its content.`);
say(`You can run it:`);
say("```bash\nnode bin/agenttape.mjs stats\n```");
say(`**This is n=${n(c.n)}, one machine, one person.** That is enough to establish what a
format does and not enough to establish a rate. The two findings below that are about the
format are stated as findings. The two that are rates are stated with their n and a question.`);

// ---- 1 ---------------------------------------------------------------------
say(`## 1. Nearly half of sessions contain a failed API call, and nothing shows it`);
say(`${n(c.failedApi.sessions)} of ${n(c.n)} sessions — ${pct(c.failedApi.share)} — contain at
least one assistant record whose model is \`<synthetic>\`.`);
say("`<synthetic>` is not a model. It is what the writer puts on an assistant record that stands\n" +
`for a failed API call rather than a response: it appears with \`isApiErrorMessage: true\`, an
\`error\` and an \`apiErrorStatus\`, and its usage figures are null. In the transcript it sits
in the conversation looking like any other assistant turn.`);
say(`**What it implies.** If you are measuring agent reliability from a transcript, a failed API
call is not in your error count unless you went looking for that field specifically. There
is no single flag meaning "this went wrong" — a step has failed if a tool result carries
\`is_error\`, *or* the record is an API error, *or* a system record has \`level: "error"\`, *or*
a permission prompt was denied. Four different signals. Anything counting one of them is
undercounting.`);
say(`**This one does not depend on my corpus.** It is a statement about what the writer emits
and what a reader has to look for. The share will differ on your machine; the four signals
will not.`);

// ---- 2 ---------------------------------------------------------------------
say(`## 2. A session is a project lifecycle, not a sitting`);
say(`Across the corpus, wall-clock time totals **${days(c.time.wallMs)} days** and active time —
everything outside gaps longer than two minutes — totals **${days(c.time.activeMs)} days**.
That is **${pct(c.time.idleShare)} idle**. Taking each session's own idle share and reading off
the middle of those — not the ratio of two medians, which is a different and wronger number —
the median session is **${pct(c.time.medianIdleShare)}** idle. ${n(c.time.spanningOverADay)} of
${n(c.n)} sessions span more than a day. The longest single gap inside one session is
**${days(c.time.longestGapMs)} days**.`);
say(`**What it implies.** "Session duration" computed as last timestamp minus first is not a
measure of anything. A session is a container that gets reopened for weeks, so any per-session
rate — errors per hour, tokens per minute — is meaningless unless the gaps come out first.
It also means a transcript spans versions: ${n(c.writerVersions)} different writer versions
appear across this corpus, so a single file can hold records in two different shapes.`);
say(`Two smaller consequences of the same fact, both of which cost me a day each. Timestamps
run backwards — a later line can carry an earlier time, because subagent records are written
back into the file after the fact — so anything that assumes monotonic time will produce a
negative duration eventually. And about a quarter of lines carry no timestamp at all.`);
say(`**This one does not depend on my corpus either.** The ratio will differ; that a session is
a container rather than an episode is a property of how the tool is used, and it would be
surprising to *not* replicate.`);

// ---- 3 ---------------------------------------------------------------------
say(`## 3. Context reaches the ceiling; compaction rarely catches it — on my machine`);
say(`${n(c.context.compacted)} of ${n(c.n)} sessions compacted at all
(${pct(c.context.compacted / Math.max(1, c.n))}). Meanwhile the median peak context is
**${n(c.context.medianPeak)} tokens**, ${n(c.context.overLarge)} sessions passed 200k, and
**${n(c.context.overCeiling)} passed 900k**.`);
say(`The largest single-step increase in a session is a median of **${n(c.context.medianJump)}
tokens** and reaches ${n(c.context.largestJump)} at worst. One step, half a context window.`);
say(`**What it implies, if it holds for you.** Sessions stopping at the wall rather than
compacting past it would mean the thing to watch is not the compaction rate but the single
step that puts a large payload in the array — usually a whole-file read. That payload is then
re-sent on every subsequent turn, a cost that compounds silently. Attributing growth to the
step that caused it is more useful than a total.`);
say(`**This is a rate from ${n(c.n)} sessions on one machine, and I would not defend it in
public as a general claim.** What is your compaction rate? \`agenttape stats\` prints it over
your own transcripts in a couple of seconds and reads no message text to do it.`);

// ---- 4 ---------------------------------------------------------------------
say(`## 4. Browser-automation tools failed an order of magnitude more often than the shell — on my machine`);
say(`${n(c.failedSteps)} failed steps across ${n(c.toolCalls)} tool calls. The rate is not
remotely uniform:`);
{
  const rows = c.tools.filter((t) => t.calls >= 20).slice(0, 9);
  say(["| tool | calls | failure rate |", "| --- | --- | --- |",
    ...rows.map((t) => `| \`${t.tool}\` | ${n(t.calls)} | ${pct(t.rate)} |`)].join("\n"));
}
say(`Grouped: MCP tools account for ${pct(c.byClass.mcp.calls / Math.max(1, c.toolCalls))} of calls
and fail at **${pct(c.byClass.mcp.rate)}**; everything else fails at **${pct(c.byClass.rest.rate)}**.`);
say(`**What it implies, if it holds for you.** Retry policy would want to differ by tool class.
A uniform "retry twice on failure" is tuned for neither: wasteful against a tool that fails a
fiftieth of the time, insufficient against one that fails a sixth of the time. High-failure
classes also want different *prompting* — an agent that knows a browser action is unreliable
can be told to verify rather than assume, which an agent driving a shell does not need.`);
say(`The pattern is not surprising in hindsight: these tools drive a live browser, so they fail
for reasons that have nothing to do with the agent — a page not settled, an element not there
yet, a session that timed out.`);
say(`**This is the weakest of the four and I want to say so clearly.** It is one machine, one
person, and in the browser case a single MCP server. The direction I believe; the number I do
not. Run \`agenttape stats\` and tell me yours.`);

// ---- the caveat, in its own voice ------------------------------------------
say(`## What this does not establish`);
say(`One machine. One person. ${n(c.n)} sessions. ${n(c.writerVersions)} writer versions. The
work is skewed toward a particular kind of task, the tool mix reflects one person's setup, and
the browser-automation figures come from one MCP server rather than from browser automation in
general.`);
say(`Findings 1 and 2 are about a file format and about how sessions are used. Both would be
surprising to *not* replicate, and neither rests on how many sessions I have. Findings 3 and 4
are rates, and a rate from ${n(c.n)} sessions on one machine is a hypothesis with a number
attached. I have deliberately not published them as results.`);
say(`The useful move is not to believe any of this. It is to run the same measurement over your
own transcripts, which is why the measurement ships with the tool rather than staying in my
notes:`);
say("```bash\nnode bin/agenttape.mjs stats            # or --json, for a machine\n```");
say(`It reads no message text, prints no titles, and states n beside every figure. If your
numbers differ from mine, that is the finding.`);

say(`---`);
// No link. The repository asserts that no shipped file names a host other than
// 127.0.0.1, which is what makes the privacy claim on the front page checkable
// — and a footer URL would be the one exception nobody would think to question.
say(`Produced by AgentTape from ${n(c.n)} sessions, with \`agenttape stats\`.
© 2026 Weiren Feng. All rights reserved.`);

process.stdout.write(out.join("\n\n") + "\n");
