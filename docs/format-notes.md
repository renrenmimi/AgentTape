# Claude Code transcript format — observed structure

Findings from a throwaway probe run over three local transcripts on
2026-08-28. The probe emitted **key names, counts and byte sizes only**; no
message text, no file paths and no session titles were read into the notes.
The fixtures themselves are never copied into this repository.

| fixture | bytes | lines | longest line | record types | tool calls |
| --- | --- | --- | --- | --- | --- |
| A (small) | 217,471 | 70 | 20,177 | 9 | 10 |
| B (medium) | 5,677,364 | 1,268 | 330,863 | 9 | 296 |
| C (large) | 80,344,859 | 10,757 | 1,341,227 | 11 | 2,660 |

`agenttape` is designed against what follows, not against any published schema.
Everything here is descriptive: the writer is free to change it, so the parser
treats every field as optional and every unrecognised value as data rather than
as an error.

---

## 1. File layout

```
~/.claude/projects/<project-dir>/<sessionId>.jsonl
~/.claude/projects/<project-dir>/<sessionId>/subagents/agent-<id>.jsonl
```

One JSON object per line, newline-delimited, UTF-8. No trailing-comma or
multi-line objects were seen: every line in all three fixtures parsed
standalone (`bad_json = 0` in 12,095 lines). The parser still tolerates a
malformed line by skipping it, because a transcript can be truncated mid-write
while a session is live.

Lines are appended in write order, which is **close to but not exactly**
chronological — see §6.

## 2. Top-level record types

Eleven `type` values were observed:

| type | A | B | C | carries `message` | carries `uuid`/`parentUuid` | carries `timestamp` |
| --- | --- | --- | --- | --- | --- | --- |
| `assistant` | 25 | 558 | 4,282 | yes | yes | yes |
| `user` | 14 | 319 | 2,760 | yes | yes | yes |
| `attachment` | 5 | 61 | 663 | no | yes | yes |
| `system` | 1 | 6 | 39 | no | yes | yes |
| `queue-operation` | 8 | 46 | 259 | no | no | yes |
| `custom-title` | 5 | 80 | 694 | no | no | no |
| `ai-title` | 5 | 75 | 688 | no | no | no |
| `last-prompt` | 6 | 79 | 713 | no | no | no |
| `mode` | 1 | 44 | 653 | no | no | no |
| `file-history-snapshot` | — | — | 4 | no | no | no |
| `file-history-delta` | — | — | 2 | no | no | yes |

**Not observed anywhere:** `pr-link`, `atis-latch`. They may exist in other
builds; the parser handles them the same way it handles any unknown type.

The last six types are *bookkeeping*: they record editor state, not the
conversation. In fixture C they are 2,748 of 10,757 lines — 26% of the file.
Feeding them to the timeline would bury the actual run, so AgentTape classifies
them as `meta` steps and hides them behind a filter rather than dropping them.

Keys observed per record type:

```
assistant   type sessionId uuid parentUuid isSidechain userType entrypoint cwd
            version gitBranch timestamp message requestId effort slug
            attributionMcpServer attributionMcpTool isApiErrorMessage error
            apiErrorStatus
user        …the same identity keys… message origin permissionMode promptId
            promptSource toolUseResult sourceToolAssistantUUID isMeta
            isCompactSummary isVisibleInTranscriptOnly toolDenialKind
            classifierMetaLines
attachment  …identity keys… attachment
system      …identity keys… content subtype level hasOutput stopReason
            toolUseID hookCount hookInfos hookErrors hookAdditionalContext
            preventedContinuation compactMetadata logicalParentUuid source
            retryInMs retryAttempt maxRetries error isMeta
queue-op.   type sessionId timestamp operation content
custom-title / ai-title / last-prompt / mode
            type sessionId + one payload key (customTitle | aiTitle |
            lastPrompt+leafUuid | mode)
file-history-snapshot   type messageId snapshot isSnapshotUpdate
file-history-delta      type messageId snapshotMessageId timestamp
                        trackingPath backup
```

`sessionId` is **not** universal: `file-history-snapshot` records omit it
(10,751 of 10,757 lines in fixture C carry it).

## 3. `message`

```
message.role            "user" | "assistant"
message.content         string | array of blocks
message.model           assistant only
message.id              assistant only — the API message id
message.type            assistant only, always "message"
message.stop_reason     tool_use | end_turn | stop_sequence | max_tokens | null
message.stop_sequence
message.stop_details    object
message.usage           assistant only
message.diagnostics     { cache_miss_reason: { type, cache_missed_input_tokens? } }
message.container       rare (7 records in B and C combined)
message.context_management  rare, same records
```

Models seen: `claude-opus-5`, `claude-fable-5`, and `<synthetic>` — the last
is what the writer puts on an assistant record that represents a failed API
call rather than a model response.

### The single most important finding

**One content block per line.** In fixture C, 6,949 of 6,951 array-valued
`message.content` fields hold exactly one block; the two exceptions are image
batches (`8` and `3` blocks). Claude Code does not write an API message per
line — it writes a *block* per line, and consecutive `assistant` records that
share a `message.id` are one API message.

That inverts the naive design. A step is not "a message"; a step is a line. To
show the messages array as the API would have seen it, records must be
**grouped back up** by `message.id`. AgentTape does exactly that: the timeline
is per block, the messages panel is per group.

A consequence: no assistant record ever mixed text with a tool call, and no
record ever held two `tool_use` blocks (`multi-tool_use = 0` in all three
fixtures). Parallel tool calls appear as consecutive lines sharing one
`message.id`.

## 4. Content blocks

| block type | keys | A | B | C |
| --- | --- | --- | --- | --- |
| `tool_use` | `type id name input caller` | 10 | 296 | 2,660 |
| `tool_result` | `type tool_use_id content is_error?` | 10 | 296 | 2,660 |
| `thinking` | `type thinking signature` | 11 | 189 | 917 |
| `text` | `type text` | 4 | 76 | 714 |
| `image` | `type source{type,media_type,data}` | — | — | 9 |

Three corrections to the shape given in the brief:

1. **`thinking` and `image` blocks exist** and were not listed. `thinking`
   carries a `signature`; `image` carries a base64 `source.data` that can be
   hundreds of KB and must never be decoded eagerly.
2. **`tool_use` has a fifth key, `caller`**, an object with a `type` field.
3. **`is_error` is usually absent.** It is present on 9/10, 80/296 and
   1,352/2,660 `tool_result` blocks, and *true* on only 3, 13 and 68 of them.
   Absent must be read as "no error"; a parser that requires the key sees no
   failures at all in fixture B.

`tool_result.content` is **not** always a string:

```
string                          A 10   B 170   C 1,678
array of { type: "text", … }           B 148   C 1,815
array of { type: "image", … }          B  13   C   141
array of { type: "tool_reference" }    B   4   C     8
```

## 5. `usage` (assistant records only)

```
input_tokens                  number      always
output_tokens                 number      always
cache_creation_input_tokens   number      always
cache_read_input_tokens       number      always
cache_creation                { ephemeral_1h_input_tokens,
                                ephemeral_5m_input_tokens }
server_tool_use               { web_fetch_requests, web_search_requests }
service_tier                  string | null
inference_geo                 string | null
speed                         string | null
iterations                    array | null — per-API-iteration copies of the
                              four token counters plus a `type`
output_tokens_details         { thinking_tokens } — **only in fixture A**
```

`output_tokens_details` appeared in 25 records total, all in fixture A
(writer version 2.1.229), and in none of the 4,840 assistant records of
B and C (versions 2.1.215–2.1.226). It is version-dependent and optional.

The four `*_tokens` fields are the only ones AgentTape depends on. Context
size at a turn is `input_tokens + cache_read_input_tokens`; observed maxima
were 59,965 (A), 486,486 (B) and 997,435 (C).

`service_tier`, `inference_geo`, `speed` and `iterations` are `null` on
exactly the records whose model is `<synthetic>`, i.e. the API-error records.

## 6. Linking, ordering and time

**`parentUuid` chains resolve.** Across all three fixtures, every non-null
`parentUuid` pointed at a `uuid` present earlier in the same file
(`dangling = 0`). But most "roots" are an artefact: bookkeeping records carry
no `uuid` key at all, so they look like roots. Counting only records that
*have* the key, fixture C holds **5** genuine roots (`parentUuid: null`) — one
per resume/compaction segment — not 3,018.

**`isSidechain` was `false` on all 8,733 records** that carried it. Subagent
transcripts live in the separate `subagents/` directory, so a main-session file
contains no sidechain. The field cannot be used to detect subagent work from
the main file alone. (v1 does not read `subagents/`.)

**`tool_use` ↔ `tool_result` pairing is total and local.** 10/10, 296/296 and
2,660/2,660 matched, with no duplicate or orphan result ids. The result
follows its call by a median of 1 line and by at most 6 lines in any fixture,
so a small sliding window is enough — no whole-file map required.

Tool wall-clock durations, from the two timestamps:

| | p50 | p95 | max |
| --- | --- | --- | --- |
| A | 2.7 s | 3.1 s | 3.1 s |
| B | 2.0 s | 19.1 s | 622 s |
| C | 3.0 s | 19.4 s | 604 s |

No negative durations were seen.

**Timestamps are not monotonic.** 2, 13 and 179 backward steps respectively.
The elapsed-time axis therefore clamps to a running maximum instead of
trusting each value. 26% of lines in fixture C carry no `timestamp` at all
(the bookkeeping types); those inherit the previous timestamp.

**Sessions span days, not hours.** Fixture B covers 323 h wall-clock, fixture C
covers 213 h — both are resumed repeatedly. Of C's 213 h, 207 h sit inside 104
gaps longer than two minutes, leaving ~5.5 h of active work. Reporting
wall-clock alone would be meaningless, which is why the summary strip reports
active duration next to it.

**Compaction is visible.** A `system` record with `subtype: "compact_boundary"`
carries `compactMetadata` with `preTokens`, `postTokens`,
`cumulativeDroppedTokens`, `durationMs`, `trigger` and the uuids of the
preserved segment; the summary that follows is a `user` record with
`isCompactSummary: true`. Fixture C has 4. Context size drops sharply across
one of these, so the context chart marks them — otherwise the drop reads as a
measurement error.

## 7. Error signals

A failed step is not one flag. AgentTape treats a step as failed when any of:

- `tool_result.is_error === true`
- the record is `assistant` with `isApiErrorMessage === true` (models
  `<synthetic>`, with `error` and `apiErrorStatus` alongside)
- a `system` record with `level: "error"` or `subtype: "api_error"`
- `toolDenialKind` present on a `user` record — a denied permission prompt

Counts of `is_error === true` alone: 3 / 13 / 68, matching the figures in the
brief.

## 8. Line-size distribution — why parsing is incremental

| bytes | A | B | C |
| --- | --- | --- | --- |
| < 1 K | 35 | 442 | 3,774 |
| 1–10 K | 27 | 767 | 6,343 |
| 10–50 K | 8 | 48 | 467 |
| 50–200 K | 0 | 3 | 50 |
| 200 K–1 M | 0 | 8 | 111 |
| > 1 M | 0 | 0 | **12** |

Twelve lines in fixture C exceed one megabyte and the largest is 1.34 MB.
Those 173 lines above 50 KB carry most of the file's bytes while being 1.6% of
its lines. The index therefore stores byte offsets and lengths and re-reads a
body from the `Blob` only when the playhead asks for it.

## 9. Fields deliberately ignored

`signature` (thinking), `image.source.data`, `attachment.content`,
`hookInfos[].command`, `snapshot.trackedFileBackups`, `originalFile`,
`structuredPatch` — all are large, content-bearing, and irrelevant to the
questions v1 answers. They are never read into the index.
