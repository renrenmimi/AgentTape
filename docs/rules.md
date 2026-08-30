# Rule sets

A rule set is a statement about what a run was supposed to do. It is plain JSON,
it holds no transcript and no session, and it is meant to be committed next to
the code the agent works on.

The point of the file is the exit code. `agenttape check` reads a rule set and a
tape and exits non-zero when any rule fails, which is what lets it sit in a CI
job and tell you the day your agent stopped searching before it wrote.

```bash
node bin/agenttape.mjs check expectations.rules.json session.jsonl
```

| exit | meaning |
| --- | --- |
| `0` | every rule held |
| `1` | at least one rule failed |
| `2` | the rule set or the tape could not be read |

Both a raw `.jsonl` transcript and a scrubbed `.tape.json` work. Every rule reads
the index — tool names, timings, token counts, error flags — and none reads a
message body, so **a redacted tape gives exactly the same answers as the
transcript it came from**. You can hand somebody a structure-only tape and they
can check your expectations against it without ever seeing what was said.

---

## The file

```json
{
  "format": "agenttape-rules/1",
  "name": "checkout service — what a good run looks like",
  "note": "Run in CI against the tape from the nightly agent job.",
  "rules": [
    { "kind": "ends-clean" },
    { "kind": "before", "first": "Grep", "then": "Write" },
    { "kind": "max-repeats", "n": 5 },
    { "kind": "max-repeats", "n": 2, "tool": "Bash" },
    { "kind": "max-context", "n": 200000 },
    { "kind": "max-tool-seconds", "n": 120 }
  ]
}
```

`format` is required and versioned. `name` and `note` are yours and are never
read by anything but a human. `rules` is a list, checked in order, and the order
is only the order of the output.

A rule that will not parse is reported by name and skipped rather than taken as
a pass:

```
  rule set: rules[3]: max-context needs a positive number in "n"
  rule set: rules[5]: unknown rule kind "no-more-than"
```

If nothing usable is left, the checker exits `2` rather than declaring success
over an empty list.

---

## The vocabulary

Six shapes, five kinds. It is deliberately not a query language: every rule is a
sentence with one or two holes in it, and the holes are a number or a tool name.
The moment a rule needs a parser, the thing under test has stopped being the run
and started being the rule.

### `ends-clean`

```json
{ "kind": "ends-clean" }
```

The run finished without an error and without a tool call that never came back.

Three outcomes, and the difference between them matters:

- **holds** — nothing failed, or something failed and the run recovered. A run
  that hit an error at step 3 and finished properly *ends clean*, and the output
  says `the run recovered: 1 step failed along the way, the last did not`.
- **fails on a bad ending** — the last step of the run is a failure.
- **fails on a hang** — a tool was called and no result ever arrived. This is a
  different fault from a tool that returned an error and is named as one.

### `before`

```json
{ "kind": "before", "first": "Grep", "then": "Write" }
```

Every call to `then` has a call to `first` somewhere before it. This is the rule
the feature exists for: the quiet failure where an agent stops looking things up
before it changes them, nothing breaks, and the output is merely worse.

Checking the first `then` is enough — if the first one had a `first` before it,
so does every later one.

A run that never calls `then` reports **nothing to check** rather than a pass.
"Nothing violated this" and "this was never tested" are different facts and only
one of them is reassuring.

### `max-repeats`

```json
{ "kind": "max-repeats", "n": 5 }
{ "kind": "max-repeats", "n": 2, "tool": "Bash" }
```

No tool is called more than `n` times consecutively. Consecutive means
consecutive *tool calls* — whatever was said between them does not break the
run. Another tool intervening does.

With `tool`, only that tool is counted and everything else resets the run. A
scoped rule whose tool never ran reports nothing to check.

This is the rule that catches an agent stuck in a loop.

### `max-context`

```json
{ "kind": "max-context", "n": 200000 }
```

`input_tokens + cache_read_input_tokens` never exceeds `n` at any step. The
failure names the step that reached the peak, which is usually a few steps after
the one that caused it — pair it with the context chart to find the payload.

A tape with no token figures in it reports nothing to check.

### `max-tool-seconds`

```json
{ "kind": "max-tool-seconds", "n": 120 }
```

No tool call takes longer than `n` seconds to return, measured between the
`tool_use` and the `tool_result` that answers it. Calls that never returned are
not timed here — that is `ends-clean`'s job.

---

## What a rule cannot be about

Rules read tool names, timings, token counts and error flags. **Nothing in the
checker may read a message body**, and `verify.mjs` asserts that the module does
not mention one.

So *"did it search before writing"* is answerable and *"did it explain itself"*
is not. That boundary is what makes a rule set runnable against a scrubbed tape,
and it is not going to move.

---

## In CI

This repository runs the checker against itself on every push, against two
invented runs committed under `fixtures/` — one that meets the expectations and
one that breaks all five:

```yaml
- name: a run that meets its expectations exits 0
  run: node bin/agenttape.mjs check fixtures/expectations.rules.json fixtures/passing.tape.json
- name: a run that does not exits non-zero
  run: |
    if node bin/agenttape.mjs check fixtures/expectations.rules.json fixtures/failing.tape.json; then
      echo "::error::the checker passed a tape that breaks every rule"
      exit 1
    fi
```

Both fixture tapes are scrubbed to structure, so committing them leaks nothing
by construction rather than by care.

Output looks like this:

```
  failing.tape.json — 23 steps · AgentTape's own expectations

  FAIL  the run ends without an error
        the run's last step failed: tool reported an error  (step 23)
  FAIL  no tool is called more than 5 times in a row
        Bash was called 6 times in a row  (step 14)
  FAIL  context never exceeds 200,000 tokens
        context reached 460,040 tokens  (step 18)
  FAIL  no tool call takes longer than 120 seconds
        a call took 340.0 seconds  (step 20)
  FAIL  Grep happens before Write
        Write was called with no Grep before it  (step 2)

  0 held, 5 failed
```
