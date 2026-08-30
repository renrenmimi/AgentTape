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

Drag the playhead, or use the keyboard: `←` `→` to step, `Shift` to move ten at
a time, `Home` / `End` for the ends, `n` / `p` to jump to the next and previous
failure — or, when a filter is on, the next and previous match.

**A filter bar**, because dragging is not a query. Five thousand turns is too
many to find anything in by hand. Pick tool names from a menu that lists every
tool in the tape with its call count; set a size threshold, so "show me what
blew up the context" is one control; jump between compactions; or type free
text.

Search reads the 96-character summaries the index already holds, **never the
bodies** — reading bodies would pull the transcript back into memory and undo
the design the rest of this is built on. The control says so, because a search
that quietly misses matches is worse than one that states what it covers.

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
context-jump trace, and the twelve-character redaction test. It also asserts the
repository's own guarantees: the ignore rules, the absence of any remote host,
that nothing lands on `window` outside the self-test flag, that the search path
never reaches for a body, and that the helper only points at directories this
repository can produce.

`?selftest=1` asserts against the live DOM: the timeline paints one tick per
step, filtering dims that tick rather than deleting it, keyboard navigation
moves the playhead, `n` steps to the next match while a filter is on, a
playhead that stops matching is not moved, the messages panel stays virtualised
on a six-thousand-step tape, failure is stated in words as well as in colour,
every control is keyboard-reachable and named, and the stylesheet honours
`prefers-reduced-motion`.

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

## Roadmap

Out of scope, in rough order of how much I want them. Each line says why it is
still out, because "not yet" without a reason is just a wish.

- **Reading the `subagents/` directory.** *Deferred, and it is a known blind
  spot rather than a missing feature.* Subagent transcripts live beside the
  session at `<sessionId>/subagents/agent-<id>.jsonl`, and `isSidechain` is
  `false` on **every** record of a main-session file — all 8,733 that carried
  the field across the three probe fixtures. So a main file cannot even tell
  you that work happened elsewhere: an `Agent` call is a call and a result with
  a summary, and everything the subagent actually did is invisible. Sixteen
  such calls appear in the large fixture. Fixing it means loading several files
  as one run and deciding how a subagent's steps sit on a single playhead,
  which is a data-model change, not an addition.
- **Comparing two runs side by side** — the same task, two models or two
  prompts, with the diverging step marked. *Deferred because the interesting
  half is the alignment: two runs of the same task do not share step indices,
  and a diff that lines them up by position would be worse than none.*
- **Assertions over tapes** — "this run must not exceed 200k context", "this
  tool must never be called twice in a row" — turning a tape into a regression
  test. *Deferred because it wants a stable tape format to assert against, and
  `agenttape/1` has not been used by anyone but me yet.*
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
lib/       parser, tape container, redactor, summary, filter, step delta
bin/       the local helper
docs/      what the transcript format actually is
scripts/   builds the demo tape
verify.mjs static checks
```

Three runtime dependencies: `next`, `react`, `react-dom`. Same as AgentLab.

© 2026 Weiren Feng. All rights reserved.
