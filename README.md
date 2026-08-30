# AgentTape

[![ci](https://github.com/renrenmimi/AgentTape/actions/workflows/ci.yml/badge.svg)](https://github.com/renrenmimi/AgentTape/actions/workflows/ci.yml)

**Replay a Claude Code session that already happened.**

Your transcripts never leave this machine. AgentTape opens a `.jsonl` from
`~/.claude/projects/` and parses it entirely in your browser: there is no
upload, no account, and no backend that receives transcript content. The only
network request the page can make goes to `127.0.0.1`, and only when the page
is itself being served from localhost. You can check that claim — `node
verify.mjs` asserts it against every source file in the repository.

---

## Why

When ordinary code has a bug you read the code, find the line, and fix it. When
an agent misbehaves the code is fine — the failure is somewhere in the *run*,
and the run is invisible. Scrolling a chat window will not show you:

- how the messages array grew, turn by turn
- which tool output blew up the context
- where the tokens actually went
- which step was the first one to go wrong

Every tool in this space — LangSmith, Langfuse, Braintrust, Arize Phoenix, W&B
Weave — needs you to instrument your code with their SDK **before** the run.
None of them can open a run that already happened, and none of them read Claude
Code's local transcripts. That gap is this project.

AgentTape is a sibling to [AgentLab](https://github.com/renrenmimi/AgentLab).
AgentLab teaches how an agent works using a hand-authored scenario; AgentTape
shows what an agent actually did, using real transcripts. Same mental model,
opposite direction — a cutaway model in a classroom, and a diagnostic tool in a
workshop. They share a visual language and no code.

## Getting started

```bash
npm install
npm run dev          # http://localhost:3000
```

Then drop a `.jsonl` on the page. That is the whole setup.

For a list of your own sessions without hunting through directories, run the
local helper in another terminal:

```bash
npm run helper       # or: node bin/agenttape.mjs
```

It prints an index of recent sessions and serves them to the page over
loopback. It does not serve the app — `npm run dev` already does that, and a
second way to serve it would only be a second path-resolution surface to get
wrong in a tool whose whole job is refusing to hand over the wrong file.

```
  #   project                                   session     size   lines  tools  modified
  ──────────────────────────────────────────────────────────────────────────────────────
  1   -Users-you-code-some-project              00000000  76.6 MB  10,757  2,660  2h ago
  2   -Users-you-code-another-one               11111111   5.4 MB   1,268    296  1d ago
```

Structure only. The helper never reads or prints a session title — titles are
generated from your prompts, so they leak exactly what this project exists to
protect.

The empty state has a **Look for it** button rather than probing for the helper
on every load: a refused connection to a port nothing is listening on is logged
in red by the browser before any JavaScript can catch it, and a working page
that prints a red error looks broken. Once the helper has answered here, the
page remembers and finds it on its own.

Not sure yet? Press **Load demo tape** on the empty state. It is a fictional
run, invented end to end, with two tool failures, a context blow-up and a
38-minute idle gap in it.

## What it shows

**A timeline**, one tick per step, with the shape encoding the kind of step —
user turn, assistant text, thinking, tool call, tool result, system — and a
separate rail below marking failures. Colour is never the only signal.
Underneath it runs a second axis in *real* elapsed time, so a 38-minute pause
in the middle of a session reads as a 38-minute pause instead of being
flattened into the next tick.

Drag the playhead, or use the keyboard. Press <kbd>?</kbd> for the whole list:
arrows to step, `Shift` for ten at a time, `Home` / `End` for the ends, `n` /
`p` for the next and previous failure — or match, while a filter is on — `/`
for the search box, `c` to compare, `a` for assertions, `Esc` to close whatever
is open.

**A filter bar**, because dragging is not a query. Five thousand turns is too
many to find anything in by hand. Pick tool names from a menu that lists every
tool in the tape with its call count; set a size threshold, so "show me what
blew up the context" is one control; jump between compactions; or type free
text.

Search reads the 96-character summaries the index already holds, **never the
bodies** — reading bodies would pull the transcript back into memory and undo
the design the rest of this is built on. The control says so, because a search
that quietly misses matches is worse than one that states what it covers.

Matching entries are marked in the messages panel and matching steps are marked
on the context chart, so a filter answers "where in the growth did this happen"
as well as "where on the timeline". The bar also says where the playhead sits
among the matches, so `n` doing nothing at the last one stops being a mystery.

Non-matching steps are **dimmed, not removed**, so the position and density of
the run stay honest. Where the timeline is denser than the screen, the dim base
is every step and the height of the bright bar is the share of that column that
matched — a filtered rail is a density plot, not a blanket. A playhead that
stops matching is left where it is and labelled, never jumped.

**The messages array, as it stood at the playhead.** This is the centrepiece.
Entries appear as they were added, the newest one highlighted, each showing its
role, a one-line summary and its token cost. Assistant blocks that share a
`message.id` are grouped into one entry, because that is one API message even
though the transcript writes it as several lines. The list is virtualised: at
step 2,600 of a large session the array is thousands of entries long and the
DOM holds a few dozen of them.

**A context-growth chart** under the timeline, plotting
`input_tokens + cache_read_input_tokens` per step. It exists for one shape: a
step pushes a large payload into the array, the line steps up, and every turn
after it pays to re-send that payload. The largest single-step increase is
marked and clickable. Compact boundaries are marked too, so the drop after a
compaction reads as an event rather than a glitch.

Marking the jump is only half an answer, so a second line says what became of
the payload: `still in the array 18 steps later · 4 turns re-sent it · 314k of
re-reading`, or `dropped at the compaction 28 steps later`, or — when the
context fell and nothing in the transcript explains it — it reports the fall and
declines to explain it. Context is one number per turn, not an inventory, so the
index cannot prove a particular payload is still present, only that the level
never fell back. The line says which of those it is doing.

**Delegated work.** When a session hands a job to a subagent with the `Agent`
tool, the transcript keeps the call and the summary that came back; everything
the subagent did is in a separate file. `isSidechain` is `false` on every record
of a main transcript, so nothing in the file tells you work is missing — in the
largest session this was built against, a quarter of all tool calls were
invisible. Delegated steps now have their own shape on the rail, the header
counts them, and the step says in words that the work exists and is not here.
Drop the `agent-*.jsonl` files alongside the transcript, or open the session
through the helper, and each delegated run appears nested inside the step that
started it — its own strip, its step count, its tools and what it cost.

**Comparing two runs.** Load a second tape and find where the two stopped
agreeing. Alignment is by tool-call sequence and the rule is printed above the
result; the divergence is marked on both rails, which share one scale so a
shorter run stops short instead of being stretched to match.

**Assertions.** State what a run was supposed to do — `Grep happens before
Write`, `context never exceeds 200,000 tokens`, `no tool is called more than
five times in a row`, `no tool call takes longer than 120 seconds`, `the run
ends without an error` — and the panel reports each one with the offending step
linked. Every rule reads the index and none reads a body, so a redacted tape
can be asserted against exactly as well as the transcript it came from.

**Tool call detail** — the input, the matched result, whether it errored, and
the wall-clock time between the two.

**An array delta**, because the timeline and the messages panel both answer
"what does the array look like now" and neither answers "what did this step put
in it". Four lines: which entry was appended and its role, the characters and
output tokens it carried, context before and after with a signed difference,
and the running totals. Signed, because a compaction makes it negative and a
readout that showed 97k → 18k as a gain would be lying about the one event you
most need to see.

**A session summary** — steps, turns, wall-clock and active duration, tool
calls by name, errors, tokens in and out, peak context, models used. Wall-clock
and active sit side by side deliberately: real sessions get resumed over days,
so a run can span 213 hours of wall-clock and contain five hours of work.

## Redaction

**Export redacted tape** produces a `.tape.json` that is safe to attach to a
GitHub issue. It keeps step order, roles, tool names, timings, token counts,
error flags, block types and the *length in characters* of every body. It
replaces every text body, tool input, tool result, file path and URL with a
placeholder that states its length. Correlation ids — `tool_use` ids and
message ids — are renumbered within the tape (`t7`, `m12`) rather than carried,
because agents quote their own tool ids inside message text:

```json
{"k":"tool-result","y":"user","ts":1776...,"e":1,"w":"tool reported an error",
 "u":"t7","x":98600,"c":8420,"b":0,"p":"[result 8,420 chars]"}
```

The design is subtractive rather than filtering. The redactor is never handed
the transcript: it reads the in-memory index, which holds numbers, enumerated
writer vocabulary and exactly one content-bearing field, and it replaces that
field. `tape.body()` — the one function that can reach the file — is not called
on that path. A second pass then re-checks the finished object slot by slot,
and `verify.mjs` asserts that no twelve-character run from any body survives.

AgentTape loads a `.tape.json` as readily as a raw `.jsonl`, so a redacted tape
is something you can send to somebody and have them open.

## Testing

```bash
node verify.mjs                              # static checks
npm run dev                                  # then open:
# http://localhost:3000/?selftest=1          # in-page assertions
```

`verify.mjs` imports the parser and the redactor as modules and runs them
against fixtures generated in code — never against a real transcript, because a
checker that needs one of my sessions is a checker nobody else can run. It
covers every documented record type, unknown types degrading to a generic step,
missing `usage`, malformed JSON mid-file, byte offsets across multi-byte
characters, filtering in each dimension and in combination, the step delta, the
context-jump trace, delegation detection and subagent pairing, run comparison
including its degenerate cases, every assertion rule in both directions, and the
twelve-character redaction test. It also asserts the
repository's own guarantees: the ignore rules, the absence of any remote host,
that nothing lands on `window` outside the self-test flag, that the search path
never reaches for a body, and that the helper only points at directories this
repository can produce.

`?selftest=1` asserts against the live DOM: the timeline paints one tick per
step, filtering dims that tick rather than deleting it, keyboard navigation
moves the playhead, `n` steps to the next match while a filter is on, a
playhead that stops matching is not moved, a delegated step says its work is
elsewhere, the comparison states its alignment rule, an assertion links its
offending step, `?` lists the shortcuts and Tab stays inside a dialog, the
messages panel stays virtualised on a six-thousand-step tape, failure is stated
in words as well as in colour, every control is keyboard-reachable and named,
and the stylesheet honours `prefers-reduced-motion`.

**CI runs `verify.mjs` and a production build. It does not run the in-page
suite** — that needs a browser driving a running server. A green tick on a pull
request does not cover it, which is why the workflow file says so and why every
pull request records having run it by hand.

## Privacy

1. No transcript, and no excerpt of one, is committed. `.gitignore` refuses
   `*.jsonl` at the root, `fixtures/real/`, and every `*.tape.json` except the
   demo.
2. Parsing happens in the browser. There is no upload endpoint anywhere in this
   repository.
3. The helper binds to `127.0.0.1` only, serves `GET` only, refuses any path
   that does not resolve inside `~/.claude/projects`, refuses symlinks out of
   that tree, and checks the `Host` header so a rebinding attack cannot reach
   it from a page you did not open.
4. `docs/format-notes.md` records the transcript format as key names, counts
   and byte sizes. No message text went into it.

## How it handles a 76 MB file

The transcript is never held as a string and never as an array of parsed
records. It is walked one megabyte at a time straight out of the `Blob`, each
chunk scanned for newline *bytes* so line offsets are exact, and each line
indexed into a flat row of mostly-numeric fields and then discarded. Bodies are
re-read from those byte offsets when the playhead asks for one.

The largest single line in the sessions this was built against is 1.34 MB.
Expanding it reveals two kilobytes, then more in bounded windows; past a quarter
of a megabyte the offer changes to a download, because a megabyte of text nodes
would stall the tab.

## One line is one block, not one message

This is the finding that overturned the design, and it is worth stating on its
own because it decides the shape of two of the panels.

A Claude Code transcript does not write an API message per line. It writes a
content **block** per line: in the largest probe fixture, 6,949 of 6,951
array-valued `message.content` fields hold exactly one block, and consecutive
`assistant` records that share a `message.id` are one API message split across
several lines — thinking on one line, prose on the next, the tool call on a
third.

The original assumption was one line, one message. Designing against that would
have produced a messages panel claiming three turns where the API saw one, and
token costs attributed to the wrong rows.

So the two panels disagree deliberately:

- **the timeline is per block**, because a block is the smallest thing that
  happened and the smallest thing you can put a playhead on;
- **the messages panel groups back up by `message.id`**, because that is the
  array the model was actually sent.

The array delta keeps the distinction visible: the first line of a group says
`entry 6`, the next two say `a block to entry 6`.

A consequence worth knowing: no assistant record in any fixture mixed prose with
a tool call, and none held two `tool_use` blocks. Parallel tool calls appear as
consecutive lines sharing one `message.id`.

See `docs/format-notes.md` for the rest of what the format actually looks like,
including the parts of it that are version-dependent.

## Limits

A tool that states its limits is easier to trust than one that implies it has
none. These are the ones worth knowing before you rely on an answer.

**Search matches summaries, not full text.** The index keeps a 96-character
summary of each step and that is what search reads. A word that appears only in
the ninetieth line of a tool result will not be found. This is deliberate:
searching bodies means holding the transcript in memory, which is the thing the
whole design avoids. The control says so on its face rather than in this file.

**Comparison aligns by tool-call sequence, and positionally.** Two runs are
reduced to the tools they called and those lists are compared; message text is
never read, because two runs of the same task differ in almost every word and a
textual comparison would answer "step 2" every time. The cost is that one extra
call early in a run shifts everything after it. The panel detects the common
shapes — a swapped call, an insertion of one or two — and says which it found,
but past about eight calls of drift it stops trying and tells you so. Only the
first divergence is reported; there may be later ones.

**A nested subagent run shows less than a top-level one.** You get its shape,
its step count, its tools, its failures, its tokens and its wall clock. You do
not get a playhead of its own, a messages array, body text, filtering, or the
runs it delegated in turn. Open the file as a transcript in its own right for
those. Two playheads on one screen is a different design and this round did not
attempt it.

**A subagent file without its sidecar is paired by time.** The `.meta.json`
beside each run carries the id of the call that started it and is exact. Nothing
inside a subagent transcript points back at its parent, so a drag-and-drop
without the sidecars falls back to the clock: a subagent ran between its call
and that call's result. That identified all sixteen runs correctly in the
session this was built against, with no ambiguity — but two delegations running
in parallel would produce overlapping windows, and there the pairing declines to
guess and leaves the file unattached rather than hanging it on the wrong call.

**The format came from three transcripts.** Written by four writer versions, on
one machine, by one person. `docs/format-notes.md` records exactly what was
observed and what was not — `pr-link` and `atis-latch` are documented record
types that never appeared; `usage.output_tokens_details` appeared in one writer
version and none of the others. Somebody else's file will carry shapes this
parser has never seen. It is built to bend rather than break: every field is
optional, an unrecognised record type becomes a generic step, a malformed line
is skipped rather than aborting the file. But "it does not crash" is not the
same as "it understood", and a session from a much newer or much older Claude
Code may be read less well than these three were.

**A redacted tape keeps tool names.** That is on purpose — a run whose tool
names were stripped tells you nothing — but it means that if a model mentioned
a tool by name in its reasoning, that name survives into the export. The
twelve-character leak test in `verify.mjs` measures this rather than hiding it:
on the largest fixture, every surviving run of twelve characters is a tool name,
a JSON seam, or the export's own documentation prose, and none is in the
structural residue.

**Assertions can only be about shape.** Rules read tool names, timings, token
counts and error flags. There is no rule that can be about what was *said*,
because nothing in the checker may read a body. "Did it search before writing"
is answerable; "did it explain itself" is not.

**Wall-clock duration is usually not what you want.** Sessions are resumed for
days; one probe fixture spans 213 hours of wall-clock and holds about thirteen
hours of work. Active duration, which drops every gap over two minutes, sits
next to it for that reason.

**CI does not run the in-page suite.** `node verify.mjs` and a production build
run on every push; the browser assertions at `?selftest=1` need a browser
driving a running server and are run by hand before each merge. A green tick
does not cover them.

## Roadmap

Out of scope, in rough order of how much I want them. Each line says why it is
still out, because "not yet" without a reason is just a wish.

- **A subagent run with a playhead of its own.** *The blind spot is closed —
  delegated runs are detected, loaded and nested — but a nested run is a
  summary, not a workbench.* Giving it a playhead means either a second one on
  the same screen or a way to descend into it and come back, and both are a
  navigation design rather than an addition.
- **Realigning a comparison after the divergence.** *The rule reports the first
  place two runs part and detects a swap or a short insertion; past that it
  stops.* A proper longest-common-subsequence alignment would keep the two runs
  side by side all the way down, at the cost of a rule that is much harder to
  put in one sentence above the result — and a rule the reader cannot state is
  worse than a limited one they can.
- **Assertions that run outside the browser.** *The rules are already plain
  data and the checker is a module with no DOM in it,* so `node` could run a
  rule set against a tape in CI. What is missing is a file format for a rule
  set and a decision about where it lives, and inventing one before anybody has
  written rules in anger is how you get the wrong one.
- **Live recording while an agent runs**, rather than after the fact.
  *Deferred because tailing a file that is being appended to means handling
  half-written lines and a moving end, and the whole value of this tool so far
  is that it needs nothing set up before the run.*
- **Formats other than Claude Code** — OpenAI and LangChain adapters.
  *Deferred until the Claude Code reader has been wrong a few more times.* The
  index is already format-agnostic — steps, entries, tokens, tools — so an
  adapter is a parser and nothing else; the risk is generalising the shape
  before the one format I can actually check has stopped surprising me. It has
  surprised me four times already: block-per-line, `is_error` usually absent,
  `tool_result.content` sometimes an array, and timestamps that step backwards.

## Repository

```
app/       the Next.js app — no UI library, no CSS framework, no state library
lib/       parser, tape container, redactor, summary, filter, step delta,
           subagents, comparison, assertions
bin/       the local helper
docs/      what the transcript format actually is
scripts/   builds the demo tape
verify.mjs static checks
```

Three runtime dependencies: `next`, `react`, `react-dom`. Same as AgentLab.

© 2026 Weiren Feng. All rights reserved.
