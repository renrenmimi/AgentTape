# Where this stands

**Live: <https://agenttape.vercel.app> · Repository:
<https://github.com/renrenmimi/AgentTape>**

Nine rounds. The tool does what it was built to do, it is deployed, and the
verification is finished. This file records where it stopped and what it does
not do, so the next person does not have to find out.

## What is verified, by what

Every push, on every pull request:

| | |
| --- | --- |
| `node verify.mjs` | 656 assertions over the parser, the redactor, the rule checker, the corpus summary and this repository's own guarantees |
| `npm run counters` | six deliberate breakages of the assertion counting, each required to fail the counter that should catch it, plus an unmutated copy required to come back clean |
| `npm run selftest` | the in-page suite, 168 assertions against a live DOM in a real browser, no-helper mode, against a production build the job serves itself |
| `agenttape check` | the rule checker against two committed fixture tapes, one that meets its expectations and one that breaks all five |

The in-page job asserts three numbers — `164/168 passed · 0 failed · 4 not run
here` — and the mode it ran in. Any of them moving is a red build.

Every number in that table is checked against the thing it describes. The README
said 591 while the file ran 602 once, which is the same class of wrong as a
counter that stops early, so it is a rule now rather than a proofread.

## The four things it does not do

**Comparison aligns positionally, not by longest common subsequence.** Two runs
are reduced to the tools they called and those lists are compared. One extra
call early shifts everything after it; the panel detects the common shapes — a
swapped call, an insertion of one or two — and says which it found, and past
about eight calls of drift it stops trying and says so. Full LCS alignment would
fix that and was never attempted.

**A nested subagent run shows less than a top-level one.** Round four gave it a
playhead, a messages array and its own step detail. It does not give it the
filter, the comparison, the assertions, the redaction export, or a descent into
runs it delegated in turn. Two playheads on one screen is a different design.

**The helper mode is not covered in CI.** The suite has two frozen shapes and CI
runs the one a runner can: no-helper, with the four helper assertions reported
as *not run here* — counted in the denominator, outside the pass count. Nothing
verifies the helper path except running `npm run selftest -- --helper` by hand
with `npm run helper` up, which is exactly the arrangement that let eighteen
assertions rot for two rounds. It is a smaller surface, and it is the same shape
of gap.

**Safari's directory picker is documented, not measured.** The File System
Access API needs a secure context and Safari does not implement it, so the
`webkitdirectory` fallback covers it. That sentence comes from documentation.
The WebKit build on this machine is 2287 against a driver expecting 2336 and
hangs on launch with no output, so it was never run. The Chromium fallback path
was exercised by deleting `showDirectoryPicker` — which tests the code, not the
browser.

## The two rounds when the suite was red and CI was green

This is the most useful thing in the repository.

For rounds five and six, eighteen of the in-page assertions were failing on
`main` while every run of the workflow passed. CI did not open a browser and
nothing else was looking. The workflow file said the suite was run by hand
before every merge, which was true as an intention and false as a fact.

The cause was not in the application. **Four concurrent copies of
`runSelfTest` were running on one page.** It was scheduled inside the effect
that exposes the debug handle, and that effect's dependency list is every piece
of state on the page: the suite changed state, the effect re-ran, it cleared the
pending timeout and set a new one, and four hundred milliseconds later a second
suite began. Then a third. Then a fourth.

Everything followed from that. Failures that looked like leakage between blocks.
A score that moved when an unrelated wait was added anywhere. Four attempted
repairs that each produced a different arbitrary number — 151, 150, 135,
147-unstable — because each of them changed the phasing of four interleaved runs
rather than fixing anything. A note reading `matches 4/4` against a view that had
been thirty-one steps a frame earlier.

**The diagnosis did not come from reading the code.** It came from sampling the
playhead position every frame and seeing it read 247 on a thirty-one step tape.
Nothing about the source suggested concurrency; the source looked correct, and
it was correct, one copy at a time.

Two consequences are worth carrying somewhere else:

* An assertion that fails under the suite and passes when the same sequence is
  driven by hand is a statement about the suite. That was in the record for two
  rounds before it was believed.
* A green tick that covers less than it appears to is worse than a red one. The
  in-page job asserts three numbers and its mode for that reason, and the
  workflow comment keeps the history rather than the intention.

## Where the numbers came from

Four findings over forty sessions on one machine are in
[`docs/findings.md`](findings.md). Two of them are about a file format and are
stated as findings; two are rates and are stated as questions, with
`agenttape stats` attached so a reader can put their own number beside mine.
n=40 cannot support a conclusion. It can support a method.

## Stopping

The verification work is done and the tool is shipped. Anything after this is a
new decision rather than a continuation.

© 2026 Weiren Feng. All rights reserved.
