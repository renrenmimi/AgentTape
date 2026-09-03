#!/usr/bin/env node
// Break the counting on purpose, and require each break to be caught.
//
//   npm run counters
//
// Two counters guard the assertions in this repository, and the reason there
// have to be two is the third mutation below. A check that is written and never
// called is invisible to a counter accumulated during a run — the run simply
// never reaches it — and a check that runs twice round a loop is invisible to a
// counter taken statically over the source. Neither is sufficient. Together
// they are, and this file is what says so out loud rather than hoping.
//
//   accumulated   verify.mjs's EXPECTED_CHECKS, and the in-page suite's
//                 DECLARED_ASSERTIONS, both counted while running
//   static        verify.mjs's call-site reachability audit, and
//                 DECLARED_CALL_SITES over app/selftest.ts
//
// The last case is the one most people would leave out, and it is the one that
// stops this guard from passing while doing nothing: an unmutated copy has to
// come back clean. This project's own audit tool was wrong twice in one round —
// an off-by-one stack frame reported three hundred dead lines, then a regex
// that matched comments reported six — and an instrument that is wrong and an
// injection that misses are the same failure. This is the check for that.
//
// No dependencies and no browser: it copies the tracked files, edits the copy,
// and runs `node verify.mjs` inside it.

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * The files verify.mjs reads. Tracked only, so no build output comes along.
 *
 * There is a second thing this buys, discovered by the guard rather than
 * designed in: the control case fails when a file the checker requires has not
 * been committed. It caught its own script that way, on the run before the
 * `git add` — which is exactly what the control case is for, and the first
 * thing it found was something nobody had planted.
 */
function trackedFiles() {
  return execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
}

function stage() {
  const dir = mkdtempSync(join(tmpdir(), "agenttape-counters-"));
  for (const rel of trackedFiles()) {
    cpSync(join(ROOT, rel), join(dir, rel), { recursive: false, force: true, errorOnExist: false });
  }
  return dir;
}

/** Run the checker in a staged copy. Returns what it said and whether it passed. */
function check(dir) {
  try {
    const out = execFileSync(process.execPath, ["verify.mjs"], {
      cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    return { passed: true, out };
  } catch (e) {
    return { passed: false, out: String(e.stdout ?? "") + String(e.stderr ?? "") };
  }
}

const edit = (dir, rel, fn) => {
  const p = join(dir, rel);
  const before = readFileSync(p, "utf8");
  const after = fn(before);
  if (after === before) throw new Error(`the mutation of ${rel} changed nothing — it missed`);
  writeFileSync(p, after);
};

// ---------------------------------------------------------------- the mutations

const CASES = [
  {
    name: "an assertion appended after process.exit",
    why: "the reachability audit should see a call site that never fired",
    mutate: (dir) => edit(dir, "verify.mjs", (s) =>
      s.replace("process.exit(failed ? 1 : 0);",
        'process.exit(failed ? 1 : 0);\nok(true, "an assertion nobody can reach");')),
    expect: /only its own assertions sit below the marker|actually ran/,
  },
  {
    name: "an assertion deleted",
    why: "the accumulated counter should come up one short",
    mutate: (dir) => edit(dir, "verify.mjs", (s) => {
      const lines = s.split("\n");
      // The last plain single-line `ok(...)` before the audit, so nothing
      // structural moves with it.
      const marker = lines.findIndex((l) => l.includes("// ---") && l.includes("did every check run"));
      for (let i = marker - 1; i > 0; i--) {
        if (/^ok\(.*\);$/.test(lines[i])) { lines.splice(i, 1); return lines.join("\n"); }
      }
      throw new Error("found no single-line assertion to delete");
    }),
    expect: /ran every check it declares/,
  },
  {
    name: "a check that is defined and never called",
    why: "a static scan cannot see this — the source still contains every assertion",
    mutate: (dir) => edit(dir, "verify.mjs", (s) =>
      s.replace("const section = (s) => console.log",
        'const neverCalled = () => { ok(true, "written and unreachable"); };\nconst section = (s) => console.log')),
    expect: /actually ran/,
  },
  {
    name: "a regex literal that a per-line scanner reads as something else",
    why: "the two counters should disagree — that is the only way to catch a scanner that stops early",
    // AgentLab's bug, in the shape this repository can actually wear it. A
    // quote inside a regex is harmless to a per-line scanner; a regex whose
    // *text* matches the scanner's own exclusion pattern is not, and one of
    // those was already sitting in verify.mjs uncounted. So the plant is an
    // assertion whose regex says `const ok = ` — the per-line method drops it,
    // the character-level one counts it, and they have to notice.
    mutate: (dir) => edit(dir, "app/selftest.ts", (s) =>
      s.replace('    await home();\n    await keyMoves("ArrowRight");',
        '    ok(/const ok = "x"/.test("y") === false, "a plant with a regex in it");\n' +
        '    await home();\n    await keyMoves("ArrowRight");')),
    expect: /agree about where they are/,
  },
  {
    name: "the in-page suite gains an assertion without updating its total",
    why: "the static counter should notice a call site the declaration does not",
    mutate: (dir) => edit(dir, "app/selftest.ts", (s) =>
      s.replace('    ok(nodes < 4000,',
        '    ok(1 === 1, "an assertion nobody declared");\n    ok(nodes < 4000,')),
    expect: /the source contains exactly that many/,
  },
];

// ---------------------------------------------------------------- running them

let failed = 0;
const say = (mark, text, note) =>
  console.log(`  ${mark}  ${text}${note ? `\n        ${note}` : ""}`);

console.log("\n  Breaking the counters on purpose.\n");

for (const c of CASES) {
  const dir = stage();
  try {
    c.mutate(dir);
    const r = check(dir);
    if (r.passed) {
      failed++;
      say("MISS", c.name, `nothing failed — ${c.why}`);
    } else if (!c.expect.test(r.out)) {
      // Caught, but by something else. That is not the same as being caught,
      // because the check being tested may still be doing nothing.
      failed++;
      say("WRONG", c.name,
        `it failed, but not on ${c.expect} — ${r.out.match(/^ {2}FAIL.*$/m)?.[0]?.trim() ?? "no FAIL line"}`);
    } else {
      say("ok  ", c.name);
    }
  } catch (e) {
    failed++;
    say("MISS", c.name, `the mutation itself failed: ${e instanceof Error ? e.message : e}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The line most people would leave out. A guard that reports every mutation
// caught while the checker is broken in some other way is a guard that has
// stopped being a guard.
{
  const dir = stage();
  const r = check(dir);
  rmSync(dir, { recursive: true, force: true });
  if (r.passed) say("ok  ", "an unmutated copy still passes");
  else {
    failed++;
    say("MISS", "an unmutated copy still passes",
      `it did not — ${r.out.match(/^ {2}FAIL.*$/m)?.[0]?.trim() ?? "no FAIL line"}`);
  }
}

console.log(failed
  ? `\n  ${failed} of ${CASES.length + 1} went wrong. A counter that cannot be broken is not counting.\n`
  : `\n  ${CASES.length + 1}/${CASES.length + 1} — every break was caught, and an untouched copy is clean.\n`);
process.exit(failed ? 1 : 0);
