# The Claude Code transcript format

Claude Code writes every session to disk as newline-delimited JSON. The format
is not documented anywhere, and this file is an attempt to change that.

Nothing here is authoritative. It is what forty sessions written by twenty-four
different Claude Code versions on one machine actually contain, checked by
probing them rather than by reading a specification, because there is no
specification to read. The writer is free to change any of it. Treat this as
field notes from someone who had to parse it, and check your own files against
it before trusting a detail.

```
~/.claude/projects/<project-dir>/<sessionId>.jsonl
~/.claude/projects/<project-dir>/<sessionId>/subagents/agent-<id>.jsonl
~/.claude/projects/<project-dir>/<sessionId>/subagents/agent-<id>.meta.json
```

`<project-dir>` is the working directory with `/` replaced by `-`, so a session
in `/Users/you/code/app` lands in `-Users-you-code-app`. That means the
directory name is a path, and a path is often a name — worth knowing before you
put one in a screenshot.

---

## Four things that are not what you would guess

Each of these broke a design that seemed obvious, and each is cheap to get
wrong for a long time before you notice.

### 1. A line is one content **block**, not one message

The natural reading is that each line is an entry in the API `messages` array.
It is not. Each line is a single *content block*, and an assistant turn that
thinks, then speaks, then calls a tool is **three lines** carrying the same
`message.id`.

In the largest probe session, 6,949 of 6,951 array-valued `message.content`
fields hold exactly one block. The two exceptions are batches of images.

To reconstruct what the model was actually sent, group consecutive `assistant`
records by `message.id`. If you skip that, a viewer will claim three turns where
the API saw one, and any per-turn token figure will land on the wrong row.

A consequence worth knowing: **no assistant record ever mixed prose with a tool
call**, and none held two `tool_use` blocks. Parallel tool calls appear as
consecutive lines sharing one `message.id`.

### 2. `isSidechain` is `false` on every record of a main session

It looks like the field that tells you a record belongs to a subagent. In a
main-session file it is `false` on **all 8,733 records** that carry it, across
every fixture checked.

Subagent work is not in the main file at all. It is in a sibling directory, and
the main file keeps only the `Agent` call and the summary that came back. A
reader of one file cannot tell that anything is missing. In one session this
hides 929 of 3,589 tool calls — a quarter of the run.

### 3. Timestamps run backwards

Not often, but reliably: 2, 13 and 179 backward steps in three fixtures of
increasing size. Roughly 26% of lines carry no `timestamp` at all — the
bookkeeping types below.

Anything that needs a monotonic clock has to clamp to a running maximum. Sorting
by timestamp is not the same as reading in file order, and file order is the
truth.

### 4. A session is not a sitting

Sessions are resumed for days or weeks. Across forty sessions, wall-clock time
totals 351 days and active time totals 3.6 days: **99% of elapsed time inside a
session is idle**. The longest single gap inside one session is 58 days.

Twenty-three of forty sessions span more than a day. Reporting "session
duration" as last-minus-first is technically true and almost always useless;
subtract the gaps.

---

## Record types

One JSON object per line, UTF-8, appended in write order. Eleven `type` values
were observed:

| `type` | carries `message` | has `uuid`/`parentUuid` | has `timestamp` | what it is |
| --- | --- | --- | --- | --- |
| `assistant` | yes | yes | yes | one block of a model turn |
| `user` | yes | yes | yes | a human turn, or a tool result |
| `attachment` | no | yes | yes | editor context injected around a turn |
| `system` | no | yes | yes | hook output, API errors, compaction boundaries |
| `queue-operation` | no | no | yes | queued-prompt bookkeeping |
| `custom-title` | no | no | no | the session title you set |
| `ai-title` | no | no | no | the session title generated for you |
| `last-prompt` | no | no | no | the most recent prompt, verbatim |
| `mode` | no | no | no | permission mode changes |
| `file-history-snapshot` | no | no | no | editor undo state |
| `file-history-delta` | no | no | yes | editor undo state |

Documented elsewhere but never observed in any file checked: `pr-link`,
`atis-latch`.

**The last six types are bookkeeping**, not conversation. In the largest fixture
they are 2,748 of 10,757 lines — 26% of the file. Three of them
(`custom-title`, `ai-title`, `last-prompt`) contain **prompt text verbatim**, so
anything that displays "the session title" is displaying something the user
wrote. Treat those three as content, not metadata.

`sessionId` is *not* universal: `file-history-snapshot` records omit it.

## `message`

```
role            "user" | "assistant"
content         string | array of blocks
model           assistant only
id              assistant only — the API message id, and the grouping key
type            assistant only, always "message"
stop_reason     tool_use | end_turn | stop_sequence | max_tokens | null
stop_sequence
stop_details    object
usage           assistant only
diagnostics     { cache_miss_reason: { type, cache_missed_input_tokens? } }
container       rare
context_management  rare
```

Models observed: `claude-opus-5`, `claude-opus-4-8`, `claude-fable-5`, and
**`<synthetic>`**.

`<synthetic>` is not a model. It is what the writer puts on an assistant record
that represents a *failed API call* rather than a response — it appears
alongside `isApiErrorMessage: true`, `error` and `apiErrorStatus`, and its
`usage` has `service_tier`, `inference_geo`, `speed` and `iterations` all
`null`. It shows up in **17 of 40 sessions**, so almost half of all sessions
contain at least one failed API call, and nothing in a normal transcript viewer
makes that visible.

## Content blocks

| block | keys | notes |
| --- | --- | --- |
| `text` | `type text` | |
| `thinking` | `type thinking signature` | not in any public schema |
| `tool_use` | `type id name input caller` | `caller` is an object with a `type` |
| `tool_result` | `type tool_use_id content is_error?` | see below |
| `image` | `type source{type,media_type,data}` | base64, can be hundreds of KB |

**`is_error` is usually absent.** It appeared on 9 of 10, 80 of 296 and 1,352 of
2,660 `tool_result` blocks in three fixtures, and was `true` on only 3, 13 and
68 of them. A parser that requires the key finds no failures at all in some
files. Absent means "no error".

**`tool_result.content` is not always a string.** It is a string about half the
time and an array the rest, and the array holds `text`, `image` and
`tool_reference` blocks. In one session, the twelve largest lines — over a
megabyte each — are results made entirely of base64 images with no text in them
at all. Anything that measures "characters" needs to decide what an image
counts as.

## `usage` — assistant records only

```
input_tokens                 always
output_tokens                always
cache_read_input_tokens      always
cache_creation_input_tokens  always
cache_creation               { ephemeral_1h_input_tokens, ephemeral_5m_input_tokens }
server_tool_use              { web_fetch_requests, web_search_requests }
service_tier                 string | null
inference_geo                string | null
speed                        string | null
iterations                   array | null — per-API-iteration copies of the counters
output_tokens_details        { thinking_tokens } — version-dependent, see below
```

**`input_tokens` is not the size of the prompt.** With prompt caching it is a
rounding error and the real figure lives in `cache_read_input_tokens`. Summing
`input_tokens` across one large session gives 8.5k against 2.0G of cache reads.
Context size at a turn is `input_tokens + cache_read_input_tokens`.

**`output_tokens_details` is version-dependent.** It appeared in 25 records from
writer version 2.1.229 and in none of the 4,840 assistant records written by
2.1.215 through 2.1.226. Do not require it.

## Linking, ordering and time

`parentUuid` chains resolve — every non-null value pointed at a `uuid` earlier
in the same file, with no dangling references anywhere. But most apparent roots
are an artefact: bookkeeping records carry no `uuid` key at all, so they look
like roots. Counting only records that *have* the key, the largest fixture has
**five** genuine roots — one per resume or compaction segment — not 3,018.

`tool_use` ↔ `tool_result` pairing is total and local: 10/10, 296/296 and
2,660/2,660 matched, no duplicate or orphan ids. The result follows its call by
a median of one line and at most six. A small sliding window is enough; no
whole-file map is needed.

Tool durations, taken from the two timestamps: median 2–3 seconds, p95 about 19
seconds, maximum around 10 minutes. No negative durations were seen.

## Failure is four different signals

There is no single "this went wrong" flag. A step failed if any of:

- `tool_result.is_error === true`
- the record is `assistant` with `isApiErrorMessage === true`
- a `system` record with `level: "error"` or `subtype: "api_error"`
- `toolDenialKind` present on a `user` record — a denied permission prompt

Across the corpus, 661 steps failed out of 14,443 tool calls, about 4.6%. The
rate is not uniform: shell commands fail around 2%, while browser-automation
MCP tools fail 8–16%.

## Compaction

A `system` record with `subtype: "compact_boundary"` carries `compactMetadata`:

```
preTokens, postTokens, cumulativeDroppedTokens, durationMs, trigger,
preservedMessages { uuids[], allUuids[], anchorUuid },
preservedSegment  { anchorUuid, headUuid, tailUuid }
```

The summary that follows is a `user` record with `isCompactSummary: true`.

Compaction is rarer than you would expect: **4 of 40 sessions** compacted at
all, 9 compactions in total — while the median session peaks at 517k tokens of
context and seven sessions passed 900k. Sessions mostly run up against the
ceiling and stop rather than compacting. Context also rarely plateaus: it
reaches within 5% of its peak only 96% of the way through a median session,
which is to say it grows until the session ends.

## Subagents

```
subagents/agent-<id>.jsonl        the run
subagents/agent-<id>.meta.json    { agentType, description, spawnDepth, toolUseId }
```

The transcript is the same format as a main session, with `isSidechain: true`
on every record and an extra `agentId` on each line matching the filename.
Record types are only `assistant`, `user` and `attachment` — no bookkeeping.

**The sidecar is the only link to the parent.** `toolUseId` is the id of the
`Agent` `tool_use` in the main file. Nothing inside a subagent transcript points
back: no field of its first record equals the parent's tool id.

Without the sidecar, the clock works. A subagent runs strictly between its call
and that call's result; that window identified the correct parent for all
sixteen runs of one session with no ambiguity. Parallel delegations would
overlap, so a pairing built this way should decline rather than guess.

`description` in the sidecar is written from the prompt that spawned the agent.
It is prose about the user's work. Treat it as content.

Delegation is common: 14 of 40 sessions delegate, 305 delegations in total, and
one session delegated 130 times.

## Sizes, and why parsing has to be incremental

| bytes per line | small fixture | medium | large |
| --- | --- | --- | --- |
| < 1 K | 35 | 442 | 3,774 |
| 1–10 K | 27 | 767 | 6,343 |
| 10–50 K | 8 | 48 | 467 |
| 50–200 K | 0 | 3 | 50 |
| 200 K – 1 M | 0 | 8 | 111 |
| > 1 M | 0 | 0 | **12** |

Twelve lines exceed one megabyte in a single 76 MB file, and the largest is
1.34 MB. Those 173 lines above 50 KB are 1.6% of the lines and most of the
bytes. Across the corpus the median session is 5.4 MB and the largest is 76.6
MB.

`JSON.parse` on a whole file is not an option, and neither is holding the parsed
objects. Read bytes, split on `0x0A`, index each line into a flat row, and keep
byte offsets so a body can be re-read on demand.

## Fields worth ignoring

`signature` on thinking blocks, `image.source.data`, `attachment.content`,
`hookInfos[].command`, `snapshot.trackedFileBackups`, `originalFile`,
`structuredPatch`. All large, all content-bearing, none needed to describe what
happened.

## What this document does not know

Forty sessions, one machine, one person, twenty-four writer versions between
2.1.197 and 2.1.251. That is a wide sample of versions and a narrow sample of
users.

Everything above is descriptive. Two documented record types never appeared. One
`usage` field exists in one version and not its neighbours. A session written by
a much newer or much older build will carry shapes nothing here anticipates.

The practical advice that falls out of that: treat every field as optional,
degrade an unrecognised record type to something generic rather than throwing,
skip a malformed line instead of aborting the file, and never assume a key is
present because it was present yesterday.
