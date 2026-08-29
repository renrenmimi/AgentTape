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
loopback:

```
  #   project                                   session     size   lines  tools  modified
  ──────────────────────────────────────────────────────────────────────────────────────
  1   -Users-you-code-some-project              00000000  76.6 MB  10,757  2,660  2h ago
  2   -Users-you-code-another-one               11111111   5.4 MB   1,268    296  1d ago
```

Structure only. The helper never reads or prints a session title — titles are
generated from your prompts, so they leak exactly what this project exists to
protect.

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
failure.

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

**Tool call detail** — the input, the matched result, whether it errored, and
the wall-clock time between the two.

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
characters, and the twelve-character redaction test. It also asserts the
repository's own guarantees: the ignore rules, the absence of any remote host,
and that nothing lands on `window` outside the self-test flag.

`?selftest=1` asserts against the live DOM: the timeline paints one tick per
step, keyboard navigation moves the playhead, the messages panel stays
virtualised on a six-thousand-step tape, failure is stated in words as well as
in colour, every control is keyboard-reachable and named, and the stylesheet
honours `prefers-reduced-motion`.

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

See `docs/format-notes.md` for what the format actually looks like — including
the finding that reshaped the whole design: a transcript line is one content
*block*, not one message.

## Roadmap

Out of scope for v1, in rough order of how much I want them:

- **Comparing two runs side by side** — the same task, two models or two
  prompts, with the diverging step marked.
- **Assertions over tapes** — "this run must not exceed 200k context", "this
  tool must never be called twice in a row" — turning a tape into a regression
  test.
- **Live recording while an agent runs**, rather than after the fact.
- **Reading the `subagents/` directory.** There are hundreds of those files;
  v1 handles main sessions only, and `isSidechain` is `false` on every record
  of a main-session file, so subagent work is invisible from inside one.
- **Formats other than Claude Code** — OpenAI and LangChain adapters.

## Repository

```
app/       the Next.js app — no UI library, no CSS framework, no state library
lib/       the parser, the tape container, the redactor, the summary
bin/       the local helper
docs/      what the transcript format actually is
scripts/   builds the demo tape
verify.mjs static checks
```

Three runtime dependencies: `next`, `react`, `react-dom`. Same as AgentLab.

© 2026 Weiren Feng. All rights reserved.
