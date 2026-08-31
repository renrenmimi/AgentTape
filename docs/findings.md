# Four things 40 agent sessions say about how agents actually run

*Every figure here is interpolated from the measurement that produced it, so this
document cannot drift from the data it describes. Two of the four findings are
facts about a file format and about how sessions are used. The other two are
rates from one machine, and they are an invitation rather than a result — the
tool that produced them ships with the repository so you can put your own number
beside mine.*

## What was measured, and how

40 Claude Code sessions from a single machine: 76,985 lines,
408 MB, 77,026 steps and 15,959 tool calls,
written by 24 different Claude Code versions over about
354.0 days of wall clock.

Claude Code writes each session to disk as newline-delimited JSON. The measurement reads
those files and computes counts, durations, token totals and tool names — no message text is
read at all, and the code that builds each record is asserted not to be able to carry a
sentence. Everything here is therefore about the *shape* of a run, never its content.

You can run it:

```bash
node bin/agenttape.mjs stats
```

**This is n=40, one machine, one person.** That is enough to establish what a
format does and not enough to establish a rate. The two findings below that are about the
format are stated as findings. The two that are rates are stated with their n and a question.

## 1. Nearly half of sessions contain a failed API call, and nothing shows it

18 of 40 sessions — 45.0% — contain at
least one assistant record whose model is `<synthetic>`.

`<synthetic>` is not a model. It is what the writer puts on an assistant record that stands
for a failed API call rather than a response: it appears with `isApiErrorMessage: true`, an
`error` and an `apiErrorStatus`, and its usage figures are null. In the transcript it sits
in the conversation looking like any other assistant turn.

**What it implies.** If you are measuring agent reliability from a transcript, a failed API
call is not in your error count unless you went looking for that field specifically. There
is no single flag meaning "this went wrong" — a step has failed if a tool result carries
`is_error`, *or* the record is an API error, *or* a system record has `level: "error"`, *or*
a permission prompt was denied. Four different signals. Anything counting one of them is
undercounting.

**This one does not depend on my corpus.** It is a statement about what the writer emits
and what a reader has to look for. The share will differ on your machine; the four signals
will not.

## 2. A session is a project lifecycle, not a sitting

Across the corpus, wall-clock time totals **354.0 days** and active time —
everything outside gaps longer than two minutes — totals **4.0 days**.
That is **98.9% idle**. Taking each session's own idle share and reading off
the middle of those — not the ratio of two medians, which is a different and wronger number —
the median session is **94.4%** idle. 23 of
40 sessions span more than a day. The longest single gap inside one session is
**58.1 days**.

**What it implies.** "Session duration" computed as last timestamp minus first is not a
measure of anything. A session is a container that gets reopened for weeks, so any per-session
rate — errors per hour, tokens per minute — is meaningless unless the gaps come out first.
It also means a transcript spans versions: 24 different writer versions
appear across this corpus, so a single file can hold records in two different shapes.

Two smaller consequences of the same fact, both of which cost me a day each. Timestamps
run backwards — a later line can carry an earlier time, because subagent records are written
back into the file after the fact — so anything that assumes monotonic time will produce a
negative duration eventually. And about a quarter of lines carry no timestamp at all.

**This one does not depend on my corpus either.** The ratio will differ; that a session is
a container rather than an episode is a property of how the tool is used, and it would be
surprising to *not* replicate.

## 3. Context reaches the ceiling; compaction rarely catches it — on my machine

7 of 40 sessions compacted at all
(17.5%). Meanwhile the median peak context is
**462,337 tokens**, 26 sessions passed 200k, and
**9 passed 900k**.

The largest single-step increase in a session is a median of **435,589
tokens** and reaches 975,826 at worst. One step, half a context window.

**What it implies, if it holds for you.** Sessions stopping at the wall rather than
compacting past it would mean the thing to watch is not the compaction rate but the single
step that puts a large payload in the array — usually a whole-file read. That payload is then
re-sent on every subsequent turn, a cost that compounds silently. Attributing growth to the
step that caused it is more useful than a total.

**This is a rate from 40 sessions on one machine, and I would not defend it in
public as a general claim.** What is your compaction rate? `agenttape stats` prints it over
your own transcripts in a couple of seconds and reads no message text to do it.

## 4. Browser-automation tools failed an order of magnitude more often than the shell — on my machine

740 failed steps across 15,959 tool calls. The rate is not
remotely uniform:

| tool | calls | failure rate |
| --- | --- | --- |
| `mcp__Claude_Browser__browser_batch` | 43 | 16.3% |
| `mcp__Claude_Browser__computer` | 466 | 10.5% |
| `mcp__Claude_Browser__preview_click` | 22 | 9.1% |
| `mcp__Claude_Browser__javascript_tool` | 1,200 | 8.2% |
| `mcp__Claude_Browser__preview_resize` | 37 | 8.1% |
| `mcp__Claude_Browser__preview_stop` | 72 | 6.9% |
| `mcp__Claude_Browser__preview_start` | 183 | 4.9% |
| `mcp__Claude_Browser__navigate` | 428 | 4.7% |
| `AskUserQuestion` | 25 | 4.0% |

Grouped: MCP tools account for 22.0% of calls
and fail at **6.6%**; everything else fails at **1.9%**.

**What it implies, if it holds for you.** Retry policy would want to differ by tool class.
A uniform "retry twice on failure" is tuned for neither: wasteful against a tool that fails a
fiftieth of the time, insufficient against one that fails a sixth of the time. High-failure
classes also want different *prompting* — an agent that knows a browser action is unreliable
can be told to verify rather than assume, which an agent driving a shell does not need.

The pattern is not surprising in hindsight: these tools drive a live browser, so they fail
for reasons that have nothing to do with the agent — a page not settled, an element not there
yet, a session that timed out.

**This is the weakest of the four and I want to say so clearly.** It is one machine, one
person, and in the browser case a single MCP server. The direction I believe; the number I do
not. Run `agenttape stats` and tell me yours.

## What this does not establish

One machine. One person. 40 sessions. 24 writer versions. The
work is skewed toward a particular kind of task, the tool mix reflects one person's setup, and
the browser-automation figures come from one MCP server rather than from browser automation in
general.

Findings 1 and 2 are about a file format and about how sessions are used. Both would be
surprising to *not* replicate, and neither rests on how many sessions I have. Findings 3 and 4
are rates, and a rate from 40 sessions on one machine is a hypothesis with a number
attached. I have deliberately not published them as results.

The useful move is not to believe any of this. It is to run the same measurement over your
own transcripts, which is why the measurement ships with the tool rather than staying in my
notes:

```bash
node bin/agenttape.mjs stats            # or --json, for a machine
```

It reads no message text, prints no titles, and states n beside every figure. If your
numbers differ from mine, that is the finding.

---

Produced by AgentTape from 40 sessions, with `agenttape stats`.
© 2026 Weiren Feng. All rights reserved.
