// Builds the rule set and the two scrubbed tapes that CI checks itself against.
//
// Every step of both runs is invented. They are written as *redacted* tapes —
// structure only, every body replaced by a placeholder that keeps its length —
// so they are safe to commit by construction rather than by care. The whole
// point of committing them is that the exit code of `agenttape check` is
// demonstrated in this repository's own workflow, on every push, rather than
// claimed in a README.
//
//   node scripts/make-fixtures.mjs
import { writeFileSync } from "node:fs";
import { loadJsonlString } from "../lib/load.ts";
import { redactTape } from "../lib/redact.ts";
import { serializeTape } from "../lib/tape.ts";
import { DEFAULT_RULES, RULES_FORMAT, serializeRuleSet } from "../lib/assert.ts";

const T0 = Date.parse("2026-07-07T09:00:00Z");

/**
 * A run written as a list of [tool, options]. Everything said in it is the same
 * invented sentence, because none of it survives redaction anyway.
 */
function run(spec, { close = true } = {}) {
  const lines = [];
  let t = 0;
  const at = () => new Date(T0 + t * 1000).toISOString();
  const say = (text) => "an invented line of an invented run — " + text;

  lines.push(JSON.stringify({
    type: "user", sessionId: "fixture", uuid: "u0", parentUuid: null, isSidechain: false,
    timestamp: at(), version: "0.0.0-fixture",
    message: { role: "user", content: [{ type: "text", text: say("the opening request") }] },
  }));

  spec.forEach(([tool, opts], i) => {
    const o = opts ?? {};
    t += o.think ?? 2;
    lines.push(JSON.stringify({
      type: "assistant", sessionId: "fixture", uuid: "a" + i, parentUuid: i ? "r" + (i - 1) : "u0",
      isSidechain: false, timestamp: at(),
      message: {
        role: "assistant", id: "m" + i, model: "claude-fixture-1",
        usage: {
          input_tokens: 40, output_tokens: 30,
          cache_read_input_tokens: o.ctx ?? 4_000 + i * 900,
          cache_creation_input_tokens: 0,
        },
        content: [{ type: "tool_use", id: "t" + i, name: tool, input: { note: say("a tool input") } }],
      },
    }));
    if (o.dangling) return;
    t += o.secs ?? 3;
    lines.push(JSON.stringify({
      type: "user", sessionId: "fixture", uuid: "r" + i, parentUuid: "a" + i, isSidechain: false,
      timestamp: at(),
      message: {
        role: "user",
        content: [{
          type: "tool_result", tool_use_id: "t" + i, is_error: !!o.err,
          content: say("a tool result of " + (o.size ?? 300) + " characters").padEnd(o.size ?? 300, "."),
        }],
      },
    }));
  });

  // A run that ends on its failed tool result is a run that ended badly; one
  // that says something afterwards recovered. The two fixtures differ here on
  // purpose, so `ends-clean` is demonstrated in both directions.
  if (!close) return loadJsonlString(lines.join("\n"), "fixture");

  t += 2;
  lines.push(JSON.stringify({
    type: "assistant", sessionId: "fixture", uuid: "z", parentUuid: "r" + (spec.length - 1),
    isSidechain: false, timestamp: at(),
    message: {
      role: "assistant", id: "mz", model: "claude-fixture-1",
      usage: { input_tokens: 40, output_tokens: 60, cache_read_input_tokens: 9_000, cache_creation_input_tokens: 0 },
      content: [{ type: "text", text: say("the closing summary") }],
    },
  }));

  return loadJsonlString(lines.join("\n"), "fixture");
}

// The scrubbed file is written exactly as the redactor produced it. Nothing —
// not even a helpful label — is added afterwards, because the audit in
// verify.mjs is strict about which slots may hold free text and loosening it
// for provenance would loosen it for everything. Where these came from is
// recorded here and in docs/rules.md instead.
const write = (path, tape) => {
  const file = redactTape(tape);
  writeFileSync(new URL("../" + path, import.meta.url), serializeTape(file));
  return file;
};

// A run that meets every expectation: it searches before it writes, repeats
// nothing, stays well inside the context ceiling, answers quickly, ends clean.
const passing = run([
  ["Read"], ["Grep"], ["Read"], ["Write"], ["Bash"], ["Bash"],
  ["Read"], ["Edit"], ["Bash"], ["Write"], ["Bash"],
]);

// A run that breaks four of the five, each in a different way.
const failing = run([
  ["Write"],                                   // …with no Grep before it
  ["Bash"], ["Bash"], ["Bash"], ["Bash"], ["Bash"], ["Bash"], ["Bash"],  // seven in a row
  ["Read", { ctx: 460_000 }],                  // over the ceiling
  ["Bash", { secs: 340 }],                     // a slow call
  ["Grep", { err: true }],                     // and it ends on a failure
], { close: false });

const p = write("fixtures/passing.tape.json", passing);
const f = write("fixtures/failing.tape.json", failing);

const set = {
  format: RULES_FORMAT,
  name: "AgentTape's own expectations",
  note: "What a run of this kind is supposed to look like. Checked in CI against " +
    "two invented tapes, one that holds these and one that does not.",
  rules: [...DEFAULT_RULES, { kind: "before", first: "Grep", then: "Write" }],
};
writeFileSync(new URL("../fixtures/expectations.rules.json", import.meta.url), serializeRuleSet(set));

console.log(`fixtures: ${set.rules.length} rules · passing ${p.steps.length} steps · failing ${f.steps.length} steps`);
