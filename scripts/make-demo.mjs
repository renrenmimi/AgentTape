// Builds public/demo.tape.json.
//
// Every word of this is invented. There is no such repository, no such bug and
// no such run — it is a stage set, built so that each feature of the app has
// something to show: two tool failures, one context blow-up, one long idle gap,
// one delegation to a subagent whose transcript is deliberately absent, and one
// compaction, so the "dropped at the compaction" branch of the context
// attribution has a run it can be demonstrated on.
//
//   node scripts/make-demo.mjs
import { writeFileSync } from "node:fs";
import { serializeTape, TAPE_FIELDS, TAPE_FORMAT } from "../lib/tape.ts";

const T0 = Date.parse("2026-04-14T10:12:04Z");
let clock = T0;
const steps = [];
const bodies = {};

const push = (s, gapMs, body) => {
  clock += gapMs;
  s.ts = clock;
  if (body !== undefined) bodies[String(steps.length)] = body;
  steps.push(s);
};

const user = (text, gap, ctx) =>
  push({ k: "user", y: "user", r: "user", b: 0, c: text.length, x: ctx, p: line(text) }, gap, text);

const think = (mid, text, gap, ctx, usage) =>
  push({ k: "thinking", y: "assistant", r: "assistant", m: mid, d: "claude-opus-5", b: 0,
         c: text.length, x: ctx, g: usage, p: line(text) }, gap, text);

const say = (mid, text, gap, ctx) =>
  push({ k: "text", y: "assistant", r: "assistant", m: mid, d: "claude-opus-5", b: 0,
         c: text.length, x: ctx, p: line(text) }, gap, text);

const call = (mid, id, tool, input, gap, ctx) => {
  const text = JSON.stringify(input, null, 2);
  push({ k: "tool-call", y: "assistant", r: "assistant", m: mid, d: "claude-opus-5", n: tool,
         u: id, b: 0, c: text.length, x: ctx, p: hint(input) }, gap, text);
};

const result = (id, text, gap, ctx, failed) => {
  const s = { k: "tool-result", y: "user", r: "user", u: id, b: 0, c: text.length, x: ctx, p: line(text) };
  if (failed) { s.e = 1; s.w = "tool reported an error"; }
  push(s, gap, text);
};

/** A context compaction, as the writer records it: a system record with figures. */
const compact = (pre, post, gap, text) =>
  push({ k: "system", y: "system", b: -1, c: text.length, x: pre,
         z: [pre, post, pre - post, "auto"], p: line(text) }, gap, text);

const line = (s) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= 96 ? flat : flat.slice(0, 95) + "…";
};
const hint = (input) =>
  line(Object.entries(input).map(([k, v]) => `${k}: ${String(v).slice(0, 48)}`).join("  "));

const S = 1000, M = 60 * S;

// ---------------------------------------------------------------- the run

user(
  "Applying a coupon to a cart with more than one line item gives the wrong total. " +
  "Two items at 20.00 with a 10% coupon comes out as 34.00 instead of 36.00. " +
  "One item is fine. Find it and fix it.",
  0, 12400);

think("m1",
  "Two items wrong, one item right. That smells like the discount being applied inside a " +
  "per-item loop rather than once to the subtotal, or applied once per item and compounding. " +
  "34.00 is 40 minus 6, and 6 is 10% of 20 taken three times, so it is probably compounding. " +
  "Find where the coupon is applied first.",
  4 * S, 12400, [412, 168, 11988, 0]);

say("m1", "Let me find where the coupon is applied.", 2 * S, 12400);

call("m1", "t1", "Bash", { command: "rg -n 'coupon|discount' src/ --type ts" }, 1 * S, 12400);
result("t1",
  "src/checkout/total.ts:14:  const discount = coupon ? coupon.rate : 0;\n" +
  "src/checkout/total.ts:22:      running = applyDiscount(running, discount);\n" +
  "src/checkout/coupon.ts:8:export function applyDiscount(amount: number, rate: number) {\n" +
  "src/checkout/coupon.ts:31:export function parseCoupon(code: string) {\n" +
  "src/cart/summary.ts:57:  // discount is already folded into total\n",
  2 * S, 12400);

think("m2",
  "Before I read the whole file, get a second pair of eyes on the test suite — I want to know " +
  "whether anything else depends on the compounding behaviour before I change it.",
  3 * S, 13200, [980, 190, 12220, 980]);

call("m2", "t1a", "Agent", {
  description: "audit coupon dependants",
  prompt: "Find every test and call site that depends on applyDiscount being called per item.",
}, 2 * S, 13200);
result("t1a",
  "Checked 31 test files and 12 call sites. Nothing outside src/checkout depends on the " +
  "per-item behaviour; two tests assert the compounded figure directly and will need updating " +
  "with the fix. Full working notes are in this agent's own transcript.",
  4 * M + 12 * S, 13600);

think("m2b",
  "Good — the blast radius is two tests. Now read the file.",
  3 * S, 14100, [1720, 240, 12380, 1720]);

call("m2b", "t2", "Read", { file_path: "src/checkout/total.ts" }, 1 * S, 14100);

// The blow-up: a 2,900-line file read whole into the array. It is written out
// in full — invented line by invented line — because a demo that only claims to
// be large cannot demonstrate the size filter, the truncated body, or the
// windowed reveal. Roughly 78k tokens of context arrive here and never leave
// until the compaction.
const bigRead = (() => {
  const head = [
    'import { applyDiscount, parseCoupon } from "./coupon";',
    'import type { Cart, LineItem, Money } from "../types";',
    "",
  ];
  const rules = [
    "const TAX_ROUNDING = 2;",
    "const ZERO_RATED = new Set([\"GB-BOOKS\", \"IE-FOOD\"]);",
    "function normaliseCurrency(v: Money): Money { return { ...v, code: v.code.toUpperCase() }; }",
    "function lineSubtotal(item: LineItem): number { return item.price * item.qty; }",
    "function isZeroRated(item: LineItem): boolean { return ZERO_RATED.has(item.taxClass); }",
    "function round(n: number): number { return Math.round(n * 100) / 100; }",
  ];
  const lines = [...head];
  while (lines.length < 2899) {
    const i = lines.length;
    if (i === 13) lines.push("  const discount = coupon ? coupon.rate : 0;");
    else if (i === 18) lines.push("");
    else if (i === 19) lines.push("  let running = 0;");
    else if (i === 20) lines.push("  for (const item of cart.items) {");
    else if (i === 21) lines.push("\trunning = applyDiscount(running + item.price * item.qty, discount);");
    else if (i === 22) lines.push("  }");
    else if (i === 23) lines.push("  return round(running);");
    else if (i % 17 === 0) lines.push("");
    else if (i % 5 === 0) lines.push(rules[i % rules.length]);
    else lines.push(`function rule${i}(cart: Cart): number { return lineSubtotal(cart.items[${i % 9}]) * ${1 + (i % 4)}; }`);
  }
  lines.push("}");
  return lines.map((t, k) => String(k + 1).padStart(6) + "\t" + t).join("\n") + "\n";
})();
result("t2", bigRead, 4 * S, 18200);

think("m3",
  "There it is. `applyDiscount` is called once per iteration, so with two items the discount " +
  "lands on the first item's subtotal twice. It should be applied once, after the loop. " +
  "That whole file is now in the array, which is 78k tokens I will re-send on every turn " +
  "for the rest of this session — I should have read a range.",
  5 * S, 96800, [3140, 302, 93660, 78600]);

call("m3", "t3", "Edit", {
  file_path: "src/checkout/total.ts",
  old_string: "    running = applyDiscount(running + item.price * item.qty, discount);",
  new_string: "    running += item.price * item.qty;",
}, 2 * S, 96800);

result("t3",
  "Error: String to replace not found in file.\n" +
  "The file uses tabs for indentation, not spaces. No edits were made.",
  1 * S, 96800, true);

think("m4",
  "Indentation mismatch — the read output showed the line numbers with a tab after them and I " +
  "copied spaces. Read the exact range instead of guessing at the whitespace.",
  3 * S, 97400, [1010, 214, 96390, 640]);

say("m4", "The file is tab-indented. Reading the exact lines before editing.", 2 * S, 97400);

call("m4", "t4", "Read", { file_path: "src/checkout/total.ts", offset: 18, limit: 8 }, 1 * S, 97400);
result("t4",
  "    18\t\n" +
  "    19\t  const coupon = parseCoupon(cart.couponCode);\n" +
  "    20\t  let running = 0;\n" +
  "    21\t  for (const item of cart.items) {\n" +
  "    22\t\trunning = applyDiscount(running + item.price * item.qty, discount);\n" +
  "    23\t  }\n" +
  "    24\t  return round(running);\n",
  2 * S, 97400);

think("m5",
  "Two changes: accumulate the subtotal in the loop, and apply the discount once on the way " +
  "out. Keep `round` where it is so the currency behaviour does not move.",
  3 * S, 98100, [860, 188, 97240, 700]);

call("m5", "t5", "Edit", {
  file_path: "src/checkout/total.ts",
  old_string: "\trunning = applyDiscount(running + item.price * item.qty, discount);\n  }\n  return round(running);",
  new_string: "\trunning += item.price * item.qty;\n  }\n  return round(applyDiscount(running, discount));",
}, 2 * S, 98100);
result("t5", "Applied 1 edit to src/checkout/total.ts:\n  22   →  running += item.price * item.qty;\n  24   →  return round(applyDiscount(running, discount));", 2 * S, 98100);

think("m6", "Run the checkout tests.", 2 * S, 98600, [520, 96, 98080, 500]);
call("m6", "t6", "Bash", { command: "npm test -- checkout" }, 1 * S, 98600);
result("t6",
  "FAIL  src/checkout/total.test.ts\n" +
  "  ✕ applies a coupon once across multiple items (4 ms)\n" +
  "  ✓ leaves an uncoupled cart alone\n" +
  "  ✓ rounds to two decimal places\n\n" +
  "  expected 36.00, received 36.000000000000004\n\n" +
  "Tests: 1 failed, 2 passed, 3 total",
  9 * S, 98600, true);

// The agent stops here. Thirty-eight minutes of nothing.
// It comes back to a compacted context: the 78k file read is gone from the
// array, which is what the context attribution should say happened to it.
compact(98600, 21400, 38 * M,
  "Context compacted: 98,600 tokens in the array, 21,400 kept. The whole-file read from step 8 " +
  "was dropped.");

think("m7",
  "Floating point, not logic — the fix is right and the assertion is too strict for binary " +
  "floats. `round` is applied to the discounted total now rather than to an already-rounded " +
  "running sum, so the last cent arrives with a tail. Round inside `applyDiscount` instead of " +
  "outside it, so every discounted amount is money-shaped before it leaves.",
  6 * S, 22100, [700, 340, 21400, 700]);

call("m7", "t7", "Edit", {
  file_path: "src/checkout/coupon.ts",
  old_string: "  return amount * (1 - rate);",
  new_string: "  return Math.round(amount * (1 - rate) * 100) / 100;",
}, 3 * S, 22100);
result("t7", "Applied 1 edit to src/checkout/coupon.ts:\n   9   →  return Math.round(amount * (1 - rate) * 100) / 100;", 2 * S, 22100);

call("m8", "t8", "Bash", { command: "npm test -- checkout" }, 2 * S, 22900);
result("t8",
  "PASS  src/checkout/total.test.ts\n" +
  "  ✓ applies a coupon once across multiple items (3 ms)\n" +
  "  ✓ leaves an uncoupled cart alone\n" +
  "  ✓ rounds to two decimal places\n\n" +
  "Tests: 3 passed, 3 total",
  8 * S, 22900);

say("m9",
  "Fixed. `applyDiscount` was being called inside the per-item loop, so with two items the " +
  "coupon compounded: 40.00 → 34.00 instead of 36.00. The loop now accumulates the subtotal " +
  "and the discount is applied once on the way out, with rounding moved inside applyDiscount " +
  "so the result is money-shaped.\n\n" +
  "Two files changed: src/checkout/total.ts (lines 22 and 24) and src/checkout/coupon.ts " +
  "(line 9). All three checkout tests pass.",
  3 * S, 23400);

// ---------------------------------------------------------------- write

const file = {
  format: TAPE_FORMAT,
  redacted: false,
  note: "A fictional run, invented end to end for the demo. No real transcript was used.",
  label: "demo — coupon compounding across line items",
  session: { id: "demo", bytes: 0, lines: steps.length, badLines: 0, versions: ["demo"] },
  fields: TAPE_FIELDS,
  steps,
  bodies,
};
file.session.bytes = Buffer.byteLength(serializeTape(file));

const out = new URL("../public/demo.tape.json", import.meta.url);
writeFileSync(out, serializeTape(file));
console.log(`demo.tape.json: ${steps.length} steps, ${Object.keys(bodies).length} bodies, ` +
  `${(file.session.bytes / 1024).toFixed(1)} KB, ` +
  `${steps.filter((s) => s.e).length} failures, ` +
  `${steps.filter((s) => s.n === "Agent").length} delegation, ` +
  `${steps.filter((s) => s.z).length} compaction, ` +
  `longest gap ${Math.round(Math.max(...steps.slice(1).map((s, i) => s.ts - steps[i].ts)) / 60000)} min`);
