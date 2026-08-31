// ?selftest=1 — the assertions a screenshot cannot make.
//
// These run against the live DOM after a tape is loaded. They exist because
// the interesting claims in this app are behavioural: that the timeline draws
// one tick per step, that the messages list stays bounded when the tape has
// thousands of entries, that failure is never signalled by colour alone, and
// that keyboard users can reach every control.
//
// Nothing in this file, and nothing in the app, touches `window` unless the
// flag is present.

import { TAPE_FORMAT, type TapeFile, type TapeStep } from "@/lib/tape";
import { ctx2d } from "./canvas";

type Filterish = { tools: string[]; minChars: number; query: string };

type Api = {
  tape: { steps: unknown[] } | null;
  view: { steps: { i: number; err: boolean; tool: string }[] } | null;
  pos: number;
  setPos: (n: number) => void;
  onDemo: () => Promise<void>;
  loadTapeFile: (f: TapeFile) => void;
  setShowMeta: (b: boolean) => void;
  filter: Filterish;
  setFilter: (f: Filterish) => void;
  matches: number;
  mask: Uint8Array;
  seekNext: (dir: 1 | -1) => void;
  delegations: { step: number; run: unknown }[];
  setComparing: (b: boolean) => void;
  comparing: boolean;
  setAsserting: (b: boolean) => void;
  setKeysOpen: (b: boolean) => void;
  keysOpen: boolean;
  setInside: (n: number) => void;
  reportText: () => string;
  indexFiles: (files: File[]) => Promise<{ sessions: unknown[]; indexed: number; cached: number }>;
  pickerSupport: () => Promise<string>;
  attachSyntheticRun?: () => void;
  assertions: { pass: boolean; vacuous: boolean; at: number }[];
  rules: unknown[];
  setRules: (r: unknown[]) => void;
};

/**
 * Everything the page threw or logged as an error, for the whole run.
 *
 * Nothing in this suite used to fail when the page threw. Last round two real
 * defects were found and fixed — both keyboard handlers cast `e.target` to an
 * element when a programmatic keydown arrives with `window` as its target,
 * killing the handler with an uncaught TypeError — and **the score did not
 * move**: 141 before, 141 after. Two genuine bugs, invisible to a
 * 159-assertion suite and doubly invisible to CI.
 *
 * One assertion over this array would have caught both without anybody writing
 * a test for either. That is the whole argument for it.
 */
const TRAP: { threw: string[]; logged: string[] } = { threw: [], logged: [] };
let armed = false;

/**
 * An error that React or Next emits unavoidably and that says nothing about
 * this application. Every entry has to name what it is, because an allowlist
 * is how a check stops being a check — and this one is empty until something
 * forces it not to be.
 */
const ALLOWED_CONSOLE: { why: string; re: RegExp }[] = [];

/**
 * Distinct messages with their repeat counts, most frequent first, all of them.
 *
 * The alternative is truncation, and truncation is how a check that works
 * reports nothing: the slots fill with whatever happened first and the distinct
 * thing that mattered is past the cut. Long is better than silent.
 */
function tally(xs: string[]): string {
  const n = new Map<string, number>();
  for (const x of xs) n.set(x, (n.get(x) ?? 0) + 1);
  return [...n.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([m, c]) => (c > 1 ? `${m} ×${c}` : m))
    .join(" · ");
}

/** Called before the suite starts, so a throw during first render is caught too. */
export function armErrorTrap(): void {
  if (armed) return;
  armed = true;
  window.addEventListener("error", (e) => {
    TRAP.threw.push(`${e.message} (${e.filename?.split("/").pop() ?? "?"}:${e.lineno})`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = (e as PromiseRejectionEvent).reason;
    TRAP.threw.push("unhandled rejection: " + (r instanceof Error ? r.message : String(r)));
  });
  const real = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    const text = args.map((x) => (x instanceof Error ? x.message : String(x))).join(" ");
    if (!ALLOWED_CONSOLE.some((a) => a.re.test(text))) TRAP.logged.push(text.slice(0, 200));
    real(...args);
  };
}

const NO_FILTER: Filterish = { tools: [], minChars: 0, query: "" };

/** A shortcut, sent the way the page receives one: on the window. */
const shortcut = (k: string, opts: KeyboardEventInit = {}) =>
  window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...opts }));

/**
 * Click the control a person would click, found by what it says.
 *
 * It waits for the control first. A person does not click a button that is not
 * there yet either — and the first version of this did, silently, because it
 * returned false and the caller went on to wait four seconds for a consequence
 * that was never coming.
 */
async function click(selector: string, says: RegExp, what: string): Promise<void> {
  const find = () => [...document.querySelectorAll<HTMLElement>(selector)]
    .find((e) => says.test((e.textContent ?? "").trim()));
  if (!(await until(() => !!find(), 120))) throw new Error(`nothing on screen to ${what}`);
  find()?.click();
}

/**
 * Type into a control the way a keystroke does.
 *
 * Setting `.value` alone is invisible to React: it tracks the previous value on
 * the node and suppresses the change when they match. Going through the native
 * setter defeats that tracker, which is what a real keystroke does one
 * character at a time.
 */
function typeInto(el: HTMLInputElement, value: string): void {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Tick the checkbox for one tool, opening the menu first as a person would. */
async function pickTool(name: string): Promise<void> {
  const menu = document.querySelector<HTMLDetailsElement>("details.tool-menu");
  if (!menu) throw new Error("no tool menu to pick a tool from");
  menu.open = true;
  if (!(await until(() => document.querySelectorAll(".tool-opt").length > 0, 60))) {
    throw new Error("the tool menu opened with nothing in it");
  }
  const opt = [...document.querySelectorAll<HTMLElement>(".tool-opt")]
    .find((l) => (l.querySelector(".tool-opt-name")?.textContent ?? "").trim() === name);
  const box = opt?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (!box) throw new Error(`the tool menu has no entry for ${name}`);
  box.click();
  menu.open = false;
}

/**
 * Send a key to the playhead, focusing it first, the way a person reaches it.
 * Defined here rather than inside a block because several blocks need it and
 * the alternative was each of them calling a setter instead.
 */
function trackKey(k: string, opts: KeyboardEventInit = {}): void {
  const el = document.querySelector<HTMLElement>(".track-hit");
  el?.focus();
  el?.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...opts }));
}

/** Put the playhead at the start, by pressing Home on it. */
const home = () => until(() => { trackKey("Home"); return api().pos === 0; }, 60);

/**
 * Put the playhead on a given step, by pressing Home and then walking right.
 *
 * There is no control that jumps to an arbitrary index — a person drags — so
 * this is the keyboard route, which is a real one and is bounded: it is only
 * used for positions inside the thirty-one step demo. The two places that need
 * a position in a six-thousand step tape still set it directly, and say so.
 */
async function goTo(k: number): Promise<boolean> {
  if (!(await home())) return false;
  for (let i = 0; i < k; i++) {
    const from = api().pos;
    trackKey("ArrowRight");
    await until(() => api().pos !== from, 20);
  }
  return api().pos === k;
}

/** How many steps the workbench believes it is showing, read off the slider. */
const shownSteps = () =>
  Number(document.querySelector(".track-hit")?.getAttribute("aria-valuemax") ?? 0);

/** The demo tape's own length, so "is the demo loaded" is a fact, not a guess. */
const DEMO_STEPS = 31;

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

/**
 * Wait for the observable consequence, never for a promise or a frame count.
 *
 * This is the rule the whole teardown problem came from. `await a.onDemo()`
 * resolves when the fetch and the parse are done, which says nothing about
 * whether React has re-rendered with the result — and `a` is the api object
 * captured at the first render, so its callbacks close over that render's
 * state. `await settle(6)` is the same bet in a different currency: six frames
 * is enough until something upstream does network work and it is not.
 *
 * So nothing in this suite waits on a promise or on a number of frames to
 * establish that a state change has landed. It waits for the thing it is
 * actually waiting for, and says so when it does not arrive.
 */
const quiet = async (read: () => string | number, same = 3): Promise<void> => {
  let last = read();
  let n = 0;
  for (let i = 0; i < 120; i++) {
    await frame();
    const v = read();
    if (v === last) { if (++n >= same) return; } else { last = v; n = 0; }
  }
};

/**
 * Wait until the thing stops changing.
 *
 * `until` needs a consequence to wait for, and an assertion that nothing
 * happened has none — which is why `seekNext` at the last match was checked
 * after a fixed two frames and read a playhead position that had not finished
 * moving from the step before. For those, the state to wait on is quiescence:
 * the same observation several times running.
 */
/**
 * Put the playhead somewhere, and keep asking until it is there.
 *
 * `setPos` early-returns when the view is momentarily absent, which it is for a
 * frame or two after a tape is reloaded — so a single call followed by a wait
 * can be a call that did nothing followed by a wait for nothing. Issuing it
 * until the position is observed is the only version of this that is not a
 * race.
 */


const until = async (cond: () => boolean, tries = 240): Promise<boolean> => {
  for (let i = 0; i < tries; i++) {
    if (cond()) return true;
    await frame();
  }
  return cond();
};
// `settle(n)` used to live here: wait n frames and hope. Every one of its
// thirty-nine call sites is gone, replaced by a wait on the thing the next line
// reads, so the function is gone too — a helper that can only express the wrong
// kind of wait is a temptation, not a convenience.

function api(): Api {
  return (window as unknown as Record<string, Api>).__agenttape;
}

/** A tape with a delegation in it, so the absent-work state can be asserted. */
function tapeWithDelegation(): TapeFile {
  const t0 = Date.parse("2026-03-03T10:00:00Z");
  const steps: TapeStep[] = [
    { k: "user", y: "user", r: "user", ts: t0, c: 20, b: 0, p: "start", x: 1000 },
    { k: "tool-call", y: "assistant", r: "assistant", m: "m1", d: "claude-opus-5",
      n: "Agent", u: "toolu_selftest_one", ts: t0 + 5000, c: 40, b: 0, p: "delegated work", x: 1200 },
    { k: "tool-result", y: "user", r: "user", u: "toolu_selftest_one",
      ts: t0 + 60000, c: 80, b: 0, p: "summary came back", x: 1400 },
    { k: "text", y: "assistant", r: "assistant", m: "m2", d: "claude-opus-5",
      ts: t0 + 62000, c: 30, b: 0, p: "done", x: 1500 },
  ];
  return {
    format: TAPE_FORMAT, redacted: false, label: "selftest delegation",
    session: { id: "", bytes: 0, lines: steps.length, badLines: 0, versions: [] },
    fields: {}, steps,
  };
}

/** A tape big enough that a list which is not virtualised will show it. */
function syntheticTape(steps: number): TapeFile {
  const out: TapeStep[] = [];
  const t0 = Date.parse("2026-03-01T09:00:00Z");
  for (let i = 0; i < steps; i++) {
    const phase = i % 4;
    const s: TapeStep = {
      k: phase === 0 ? "user" : phase === 1 ? "text" : phase === 2 ? "tool-call" : "tool-result",
      y: phase === 0 || phase === 3 ? "user" : "assistant",
      r: phase === 0 || phase === 3 ? "user" : "assistant",
      ts: t0 + i * 4000,
      c: 40 + (i % 300),
      b: 0,
      p: "synthetic step " + i,
      x: 1000 + i * 40,
    };
    if (phase === 1 || phase === 2) s.m = "m" + Math.floor(i / 4);
    if (phase === 2) { s.n = "Bash"; s.u = "t" + i; }
    if (phase === 3) { s.u = "t" + (i - 1); if (i % 61 === 3) { s.e = 1; s.w = "tool reported an error"; } }
    out.push(s);
  }
  return {
    format: TAPE_FORMAT,
    redacted: false,
    label: "selftest synthetic",
    session: { id: "", bytes: 0, lines: steps, badLines: 0, versions: [] },
    fields: {},
    steps: out,
  };
}

/**
 * How many separate marks the tick rail actually has on screen. Used twice:
 * once to check the timeline draws one per step, and again to check that
 * filtering dims ticks rather than deleting them.
 */
function countPaintedTicks(n: number): { usable: boolean; groups: number; why: string } {
  const canvas = document.querySelector<HTMLCanvasElement>(".track canvas");
  if (!canvas) return { usable: false, groups: 0, why: "no canvas" };
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const spacing = (canvas.width / dpr - 16) / n;
  if (spacing < 6) return { usable: false, groups: 0, why: `spacing ${spacing.toFixed(2)}px` };
  // The canvas was created with willReadFrequently because the flag is set;
  // options passed here would be ignored, so this just takes the context.
  const g = ctx2d(canvas);
  const band = g?.getImageData(0, Math.round(12 * dpr), canvas.width, Math.round(20 * dpr));
  let groups = 0;
  let inRun = false;
  if (band) {
    const { width, height, data } = band;
    for (let x = 0; x < width; x++) {
      let hit = false;
      for (let y = 0; y < height; y++) {
        if (data[(y * width + x) * 4 + 3] > 12) { hit = true; break; }
      }
      if (hit && !inRun) groups++;
      inRun = hit;
    }
  }
  return { usable: true, groups, why: "" };
}

/**
 * How many assertions this suite runs, counting this declaration's own.
 *
 * The set is frozen so that a score can be compared with another score. Round
 * five compared 141/159 with 139/161 and drew a conclusion from it; the
 * denominator had moved, so the two numbers were about different sets and the
 * comparison meant nothing. A suite whose size can drift underneath a
 * measurement is not a measurement.
 *
 * It also catches the failure that has already happened once in the other
 * harness: a block that never runs. If a block throws, or sits behind a
 * condition nothing takes, the count comes up short and this fails by name
 * rather than by the total quietly being a different number nobody checked.
 *
 * Changing the suite means changing this line, deliberately, in the same
 * commit.
 */
const DECLARED_ASSERTIONS = 168;

/**
 * Which mode the run is in, and what that mode is supposed to produce.
 *
 * The overview block needs the local helper. It used to decide for itself by
 * probing 127.0.0.1:4319 — so on a machine with a helper running it exercised
 * four assertions, and on one without it skipped them, and *the suite behaved
 * differently depending on what happened to be running on the box*. That is not
 * something a gate can be built on, and next round this number becomes a gate
 * on a runner where the helper will never be up.
 *
 * So the driver decides, with `?helper=1`, and each mode declares what it
 * produces. Two modes with two frozen shapes is honest; one shape that quietly
 * changes is not. Asking for the helper mode without a helper is a failure
 * rather than a skip: the mode was requested and could not be delivered.
 */
/**
 * How many `ok(` and `skip(` call sites this file contains.
 *
 * The second counter, and the reason there has to be one. The declared total
 * above is accumulated while the suite runs, so it cannot see an assertion that
 * is written and never reached — the source still contains it and the run
 * simply never gets there. This one is counted statically by verify.mjs, from
 * outside, and the two have to move together. Adding an assertion means
 * changing both numbers, deliberately, in the same commit.
 *
 * It said 161 for a round. Not because an assertion was added since — because
 * the counter that produced it was a per-line regex that dropped any line whose
 * text contained the word "skipped". A scanner that stops early reports a
 * smaller number confidently, which is why this is now counted twice by methods
 * that fail differently and the two have to agree.
 */
export const DECLARED_CALL_SITES = 162;

const HELPER_MODE =
  typeof window !== "undefined" && new URLSearchParams(window.location.search).has("helper");
const MODE = HELPER_MODE ? "helper" : "no-helper";
const DECLARED: Record<string, { total: number; skipped: number }> = {
  "no-helper": { total: DECLARED_ASSERTIONS, skipped: 4 },
  "helper": { total: DECLARED_ASSERTIONS, skipped: 0 },
};

/**
 * One run per page load, belt as well as braces.
 *
 * The scheduling bug that started four concurrent suites is fixed where it
 * lived, in the effect that scheduled them. This is here because the cost of
 * getting that wrong again is two rounds of chasing symptoms, and the cost of
 * this line is nothing.
 */
let started = false;

export async function runSelfTest(): Promise<void> {
  if (started) return;
  started = true;
  const results: { ok: boolean; label: string; note?: string; skipped?: boolean }[] = [];
  const ok = (cond: boolean, label: string, note?: string) => {
    results.push({ ok: !!cond, label, note });
    (window as unknown as Record<string, unknown>).__selftest_at =
      { block: CURRENT_BLOCK, ran: results.length, at: Date.now() };
  };
  /**
   * An assertion that could not run here, kept in the count and not counted as
   * a pass.
   *
   * The overview block used to answer "the helper is not running" with
   * `ok(true, "…skipped…")`, which is a vacuous pass — the exact thing this
   * project's own rule checker refuses to call a pass. Worse, that branch
   * emitted one result where the other emitted four, so the suite's total
   * depended on whether a helper happened to be running: 160 here, 163 on a
   * machine with one, and neither number comparable with the other. A frozen
   * count and an environment-dependent total cannot both be true.
   */
  const skip = (label: string, why: string) => {
    results.push({ ok: false, skipped: true, label, note: why });
  };

  const a = api();
  if (!a) {
    report([{ ok: false, label: "window.__agenttape is exposed under the flag" }]);
    return;
  }

  try {
    await runBlocks(ok, skip);
  } catch (e) {
    // A throw used to end the run with no report at all: `runSelfTest` is
    // called as `void runSelfTest()`, so the rejection went nowhere and
    // `window.__selftest` was simply never set. A driver waiting for it waits
    // forever, which reads as a hang rather than as a failure.
    ok(false, "the suite ran to the end without throwing",
      e instanceof Error ? e.message : String(e));
  }

  // ---- what no block was looking for --------------------------------------
  //
  // Two classes that every block above would sail past. Neither is about a
  // feature; both are about the page being wrong in a way that reads as
  // plausible on a screenshot.
  {
    await need("what no block was looking for");

    // A formatting bug reaches the screen as a word. `undefined`, `NaN` and
    // `[object Object]` are the three that mean a value did not survive the
    // trip, and nothing in this suite reads rendered text looking for them.
    const junk = /\bundefined\b|\bNaN\b|\[object Object\]/;
    const guilty: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>(".pane-body *, .summary-strip *")) {
      if (el.children.length) continue; // leaves only, so a parent is not blamed twice
      const t = (el.textContent ?? "").trim();
      if (t && junk.test(t)) guilty.push(el.className + ": " + t.slice(0, 40));
    }
    ok(guilty.length === 0, "no rendered text is a value that did not survive the trip",
      tally(guilty));

    // The detail panel and the playhead can disagree without any assertion
    // above noticing: every one of them reads the panel and trusts that it is
    // showing the step the playhead is on.
    const at = 7;
    await goTo(at);
    const heading = ([...document.querySelectorAll('section[aria-label="Step detail"] .pane-head h2')]
      .map((e) => (e.textContent ?? "").trim())[0] ?? "");
    const want = api().view?.steps[at];
    ok(!!want && new RegExp(`\\b${(want.i + 1).toLocaleString("en-US")}\\b`).test(heading),
      "the step detail is showing the step the playhead is on",
      `heading "${heading}" for step ${(want?.i ?? -1) + 1}`);
  }

  // Last, so it covers everything above it.
  // Aggregated, never truncated. These two used to keep the first three
  // distinct messages, which is exactly how a detection layer that works ends
  // up reporting nothing useful: three copies of an early noisy error fill the
  // slots and the one that matters sits past them, invisible. One line per
  // distinct message, with how many times it happened, however many there are.
  ok(TRAP.threw.length === 0, "nothing threw or rejected during the whole run",
    tally(TRAP.threw));
  ok(TRAP.logged.length === 0, "…and nothing was logged as a console error",
    tally(TRAP.logged));

  const want = DECLARED[MODE];
  // Skips first, so the count assertion below is the last thing pushed and can
  // still say `results.length + 1` about the finished total.
  ok(results.filter((r) => r.skipped).length === want.skipped,
    "the run skipped exactly the assertions this mode skips",
    `${results.filter((r) => r.skipped).length} skipped, ${want.skipped} declared for ${MODE}`);
  ok(results.length + 1 === want.total,
    "…and ran every assertion it declares",
    `${results.length + 1} ran, ${want.total} declared for ${MODE}`);
  report(results);
}

/**
 * What a block needs before it starts, checked and repaired in one place.
 *
 * This is the change that matters, and the eighteen failures are why. They were
 * downstream symptoms with no diagnostic content in them: eleven said "the
 * shortcut sheet did not open" when the fault was that a block three sections
 * earlier had left a four-step synthetic tape loaded with an overlay on top of
 * it. Eighteen mysterious failures should have been one clear one.
 *
 * So every block declares what it starts from. If the state is wrong it is put
 * right; if it cannot be put right, this throws naming the block and what it
 * actually found, which the wrapper turns into a single failed assertion. It
 * adds no assertion of its own — the frozen count from the previous commit is
 * what makes a score comparable, and a guard that inflates the denominator
 * every time somebody adds a block would undo it.
 */
/**
 * The last block the suite entered, published as it goes.
 *
 * For the case where nothing is reported at all. A browser that hangs and is
 * killed by the runner's own limit produces no signal — that is the WebKit 2287
 * failure this project already refused once — so the driver reads this on
 * timeout and can say where it stopped instead of that it stopped.
 */
let CURRENT_BLOCK = "(before the first block)";

async function need(block: string): Promise<void> {
  CURRENT_BLOCK = block;
  (window as unknown as Record<string, unknown>).__selftest_at = { block, at: Date.now() };
  // Overlays close the way they close for a person: Escape, which the page
  // documents in its own shortcut sheet. Repeated because Escape closes one
  // layer at a time, which is the behaviour rather than a limitation.
  for (let i = 0; i < 6; i++) {
    if (!document.querySelector(".nested-wb, .cmp, .sheet, .asserts")) break;
    shortcut("Escape");
    await until(() => !document.querySelector(".nested-wb, .cmp, .sheet, .asserts"), 20);
  }

  const shut = () =>
    !document.querySelector(".nested-wb") &&
    !document.querySelector(".cmp") &&
    !document.querySelector(".sheet") &&
    !document.querySelector(".asserts");
  if (!(await until(shut))) {
    const open = [".nested-wb", ".cmp", ".sheet", ".asserts"].filter((c) => document.querySelector(c));
    throw new Error(`${block}: an overlay from the previous block would not close (${open.join(" ")})`);
  }

  // The demo is loaded the way a person loads it: close what is open, then
  // press the button on the empty state. There is no call into the page here
  // and nothing captured — a block arrives at its starting state through the
  // same path a user takes, which is why there is no leakage to defend against.
  if (shownSteps() !== DEMO_STEPS) {
    await click("header.strip button", /^close$/i, `${block}: leave the loaded run`);
    if (!(await until(() => !!document.querySelector(".drop-card")))) {
      throw new Error(`${block}: Close did not return to the empty state`);
    }
    await click(".drop-actions button", /load the demo tape/i, `${block}: load the demo tape`);
    if (!(await until(() => shownSteps() === DEMO_STEPS))) {
      throw new Error(
        `${block}: needs the demo tape (${DEMO_STEPS} steps) and the workbench shows ` +
        `${shownSteps()} — loading it through the interface did not take`,
      );
    }
  }
  if (!(await until(() => !!document.querySelector(".track-hit")))) {
    throw new Error(`${block}: the demo is loaded but the workbench did not render`);
  }
  // The tape and the view are two different facts. While a delegated run is
  // open the view is the subagent's steps, and closing the overlay takes the
  // DOM out before it takes the view out — so a block can start with the demo
  // loaded and still be asserting against a four-step view.
  if (!(await until(() => api().view?.steps.length === DEMO_STEPS))) {
    throw new Error(
      `${block}: the demo is loaded but the view is showing ` +
      `${api().view?.steps.length ?? 0} steps — a delegated run is still open`,
    );
  }
}

async function runBlocks(
  ok: (cond: boolean, label: string, note?: string) => void,
  skip: (label: string, why: string) => void,
): Promise<void> {

  // ---- load the demo ------------------------------------------------------
  if (!api().tape) {
    await click(".drop-actions button", /load the demo tape/i, "load the demo tape");
    // Both, and this is the part that is easy to get wrong: the DOM commits
    // before React flushes the passive effect that republishes the debug
    // handle, and a double-rAF lands between the two. Waiting only for the
    // slider gets a rendered workbench and a handle still holding the empty
    // state. The rule is not "wait on the DOM" — it is "wait on whichever
    // source of truth the next line reads", and here the next line reads both.
    await until(() => shownSteps() > 0 && !!api().view);
  }
  const view = api().view;
  ok(!!view && view.steps.length > 0, "a tape is loaded", `${view?.steps.length ?? 0} steps`);
  // Bailing out here used to call `report` itself and return, which reported
  // twice and skipped the declared-count check on the way past — the one path
  // where a short run would not have been noticed as a short run. Throwing
  // sends it through the single exit instead.
  if (!view) throw new Error("no tape loaded; the rest of the suite has nothing to run against");

  const n = view.steps.length;

  // ---- timeline ----------------------------------------------------------
  /**
   * The slider, looked up each time rather than held.
   *
   * Holding it was the same mistake as holding the api object: `need` returns
   * to the empty state and loads the demo again, which remounts the workbench,
   * and a node captured before that is detached and answers about a run that
   * is no longer on screen.
   */
  const slider = () => document.querySelector<HTMLElement>(".track-hit");
  ok(!!slider(), "the timeline exposes a slider");
  ok(slider()?.getAttribute("role") === "slider", "the slider has role=slider");
  ok(
    Number(slider()?.getAttribute("aria-valuemax")) === n,
    "slider range matches the parsed step count",
    `aria-valuemax=${slider()?.getAttribute("aria-valuemax")} steps=${n}`,
  );

  // Count the ticks the canvas actually painted. Only meaningful while the
  // shapes are far enough apart not to merge, so it is gated on spacing.
  const painted = countPaintedTicks(n);
  if (painted.usable) {
    ok(painted.groups === n, "the canvas painted one tick per step",
      `painted ${painted.groups}, expected ${n}`);
  } else {
    // Same label either way, so the count does not move with the window width.
    skip("the canvas painted one tick per step", painted.why);
  }

  // ---- keyboard ----------------------------------------------------------
  const key = (k: string, opts: KeyboardEventInit = {}) => {
    slider()?.focus();
    slider()?.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...opts }));
  };

  /**
   * Press a key at the playhead and wait for the playhead to move.
   *
   * Waiting for the *change* rather than for the expected value keeps the
   * assertion's teeth: it still fails, with the value in the note, when the key
   * lands somewhere else. Waiting a fixed number of frames kept nothing — the
   * next line reads `api().pos`, and frames are not a statement about that.
   */
  const keyMoves = async (k: string, opts: KeyboardEventInit = {}) => {
    const from = api().pos;
    key(k, opts);
    await until(() => api().pos !== from, 60);
  };

  await home();
  await keyMoves("ArrowRight");
  ok(api().pos === 1, "ArrowRight advances the playhead", `pos=${api().pos}`);
  await keyMoves("ArrowRight", { shiftKey: true });
  ok(api().pos === 11, "Shift+ArrowRight advances by ten", `pos=${api().pos}`);
  await keyMoves("End");
  ok(api().pos === n - 1, "End jumps to the last step", `pos=${api().pos}`);
  await keyMoves("Home");
  ok(api().pos === 0, "Home jumps to the first step", `pos=${api().pos}`);

  const firstFail = view.steps.findIndex((s) => s.err);
  if (firstFail >= 0) {
    await keyMoves("n");
    ok(api().pos === firstFail, "n jumps to the next failed step", `pos=${api().pos} expected ${firstFail}`);
    const secondFail = view.steps.findIndex((s, i) => i > firstFail && s.err);
    if (secondFail >= 0) {
      await keyMoves("n");
      await keyMoves("p");
      ok(api().pos === firstFail, "p jumps back to the previous failed step", `pos=${api().pos}`);
    }
  } else {
    ok(false, "the demo tape contains at least one failed step");
  }

  // ---- delegated work is visible even with no subagent file ---------------
  {
    await need("delegated work is visible even with no subagent file");
    api().loadTapeFile(tapeWithDelegation());
    // The next line reads `api().delegations`, so that is what is waited on.
    await until(() => api().delegations.length === 1, 120);
    const dels = api().delegations;
    ok(dels.length === 1, "the Agent call is found as a delegation", `${dels.length}`);
    ok(dels[0].run === null, "…with no run attached");

    const stat = [...document.querySelectorAll(".stat")]
      .map((e) => (e.textContent ?? "").trim())
      .find((t) => t.startsWith("delegated"));
    ok(!!stat && /not in this file/.test(stat),
      "the header says work happened that this file does not contain", stat ?? "missing");

    await goTo(1);
    ok(!!document.querySelector(".nested-absent"), "a delegated step shows the absent-work panel");
    const note = (document.querySelector(".nested-absent .nested-note")?.textContent ?? "").trim();
    ok(/not in this file/i.test(note), "…and says so in words", note.slice(0, 60));
    ok(/subagents\/agent-/.test(note), "…and says where the work actually lives");
    const chip = [...document.querySelectorAll(".d-kind")].map((e) => (e.textContent ?? "").trim());
    ok(chip.includes("delegated"), "the step detail marks the step as a delegation", chip.join(","));

    const legend = [...document.querySelectorAll(".legend-item")].map((e) => (e.textContent ?? "").trim());
    ok(legend.some((t) => /delegated/.test(t)), "the timeline legend gains a delegation shape",
      legend.join(" | "));

    await home();
    ok(!document.querySelector(".nested-absent"), "an ordinary step shows no delegation panel");

    // Restoring is the next block's precondition, and it gets there by
    // clicking rather than by calling anything.
  }

  // ---- a report you can paste ---------------------------------------------
  {
    await need("a report you can paste");
    const btn = [...document.querySelectorAll(".strip-actions button")]
      .find((b) => /^report$/i.test((b.textContent ?? "").trim()));
    ok(!!btn, "the header offers a report");
    ok(!!btn?.getAttribute("title"), "…and says what is in it");

    const md = api().reportText();
    ok(md.length > 200, "the report has something in it", `${md.length} chars`);
    const wants: [string, RegExp][] = [
      ["a session table", /\| steps \|/],
      ["a tool breakdown", /\| tool \| calls \| failed \|/],
      ["failures with step numbers", /## Failures/],
      ["a context profile", /peak /],
      ["its provenance", /AgentTape/],
    ];
    for (const [what, re] of wants) ok(re.test(md), "the report carries " + what);

    // The demo tape is fiction, but it is fiction with words in it, and none of
    // them may appear in something built to be pasted into an issue.
    for (const phrase of ["applyDiscount", "coupon", "line item", "npm test"]) {
      ok(!md.includes(phrase), `no demo prose in the report: "${phrase}"`);
    }
    ok(!/`[a-z]+ [a-z]+ [a-z]+ [a-z]+ [a-z]+/i.test(md.replace(/`[▁▂▃▄▅▆▇█]+`/g, "")),
      "…and nothing that reads like a sentence in a code span");
  }

  // ---- assertions ---------------------------------------------------------
  {
    await need("assertions");
    const strip = [...document.querySelectorAll(".strip-actions button")]
      .map((e) => (e.textContent ?? "").trim());
    ok(strip.some((t) => /assertion/i.test(t)),
      "the header reports whether the run holds its stated expectations", strip.join(" | "));

    shortcut("a");
    await until(() => !!document.querySelector(".asserts"));
    const panel = document.querySelector(".asserts");
    ok(!!panel, "the assertions panel opens");
    ok(panel?.getAttribute("role") === "dialog", "…as a dialog");

    const rows = document.querySelectorAll(".rule").length;
    ok(rows === api().assertions.length && rows > 0, "every rule gets a row", String(rows));
    const marks = [...document.querySelectorAll(".rule-mark")].map((e) => (e.textContent ?? "").trim());
    ok(marks.every((m) => m === "PASS" || m === "FAIL" || m === "—"),
      "each row says pass or fail in words, not by colour alone", marks.join(","));
    ok(document.querySelectorAll(".rule-detail").length === rows,
      "…and each says why");

    // A rule that must fail on the demo, with the offending step linked.
    //
    // Set rather than typed. The panel does let a person change a ceiling, but
    // the assertion below counts *one* failing row, which means replacing the
    // whole set — typing 1 into the existing ceiling leaves the other default
    // rules in place and some of them fail on the demo too. Driving it would
    // change what is being asserted, so it stays direct and says so.
    api().setRules([{ kind: "max-context", n: 1 }]);
    await until(() => document.querySelectorAll(".rule-fail").length === 1, 120);
    ok(document.querySelectorAll(".rule-fail").length === 1, "an impossible ceiling fails");
    const go = document.querySelector<HTMLElement>(".rule-go");
    ok(!!go && /^step \d/.test((go.textContent ?? "").trim()),
      "…and links the offending step", go?.textContent ?? "missing");
    go?.click();
    // Two sources on the next two lines, so both are waited on.
    await until(() => !document.querySelector(".asserts") && !!document.querySelector(".track-hit"), 120);
    ok(!document.querySelector(".asserts"), "following the link closes the panel");
    ok(!!document.querySelector(".track-hit"), "…and lands back on the workbench");

    shortcut("a");
    await until(() => !!document.querySelector(".asserts"));
    // A rule that cannot be tested is not a pass.
    // Not driveable at all: the tool pickers only offer tools that appear in
    // the tape, and a vacuous rule is by definition about one that does not.
    api().setRules([{ kind: "before", first: "NoSuchTool", then: "AlsoMissing" }]);
    await until(() => api().assertions[0]?.vacuous === true
      && document.querySelectorAll(".rule-vacuous").length === 1, 120);
    ok(api().assertions[0].vacuous === true, "a rule with nothing to check is marked vacuous");
    ok(document.querySelectorAll(".rule-vacuous").length === 1,
      "…and shown differently from a pass");
    ok(/nothing to check/.test(document.querySelector(".rule-detail")?.textContent ?? ""),
      "…in words");

    // A rule set is a file: it can be written out and read back in.
    const save = [...document.querySelectorAll(".asserts .cmp-head button")]
      .find((b) => /save rule set/i.test(b.textContent ?? ""));
    ok(!!save, "the panel can save the current rules as a file");
    const load = document.querySelector<HTMLInputElement>('.asserts input[type="file"]');
    ok(!!load && !!load.getAttribute("aria-label"), "…and load one back, with a named control");

    const drop = (text: string) => {
      const dt = new DataTransfer();
      dt.items.add(new File([text], "x.rules.json", { type: "application/json" }));
      if (!load) return;
      load.files = dt.files;
      load.dispatchEvent(new Event("change", { bubbles: true }));
    };

    drop(JSON.stringify({
      format: "agenttape-rules/1",
      rules: [{ kind: "max-repeats", n: 3 }, { kind: "ends-clean" }],
    }));
    await until(() => api().rules.length === 2
      && document.querySelectorAll(".rule").length === 2, 120);
    ok(api().rules.length === 2, "a loaded set replaces the rules", String(api().rules.length));
    ok(document.querySelectorAll(".rule").length === 2, "…and the panel redraws for it");
    ok(!document.querySelector(".rule-problems"), "…with nothing to complain about");

    drop(JSON.stringify({ format: "wrong", rules: [{ kind: "nonsense" }] }));
    await until(() => document.querySelectorAll(".rule-problems li").length >= 2, 120);
    const said = [...document.querySelectorAll(".rule-problems li")].map((e) => (e.textContent ?? "").trim());
    ok(said.length >= 2, "a broken set is reported rather than silently ignored", said.join(" | "));
    ok(said.some((x) => /unknown rule kind/.test(x)), "…naming the rule that was wrong");
    ok(api().rules.length === 2, "…and the rules that were working are left alone");

    ok(/exits non-zero/.test(document.querySelector(".cmp-rule")?.textContent ?? ""),
      "the panel says the same rules run outside the browser");

    document.querySelector<HTMLElement>(".asserts .cmp-head .btn:last-of-type")?.click();
    await until(() => !document.querySelector(".asserts"), 120);
    ok(!document.querySelector(".asserts"), "the panel closes");
  }

  // ---- a delegated run can be stepped through -----------------------------
  {
    await need("a delegated run can be stepped through");
    // A tape with a delegation, and a subagent run attached to it by hand, so
    // the nested workbench has something to open without a file on disk.
    api().loadTapeFile(tapeWithDelegation());
    await until(() => api().delegations.length === 1, 120);

    await goTo(1);
    const enter = [...document.querySelectorAll(".nested button")]
      .find((b) => /step through/i.test(b.textContent ?? ""));
    ok(!enter, "an unloaded delegation offers no way in");

    api().attachSyntheticRun?.();
    // Two sources: the run has to be attached and the button has to be drawn.
    await until(() => !!api().delegations[0]?.run
      && [...document.querySelectorAll(".nested button")].some((b) => /step through/i.test(b.textContent ?? "")), 120);
    const enter2 = [...document.querySelectorAll(".nested button")]
      .find((b) => /step through/i.test(b.textContent ?? "")) as HTMLElement | undefined;
    ok(!!enter2, "a loaded delegation can be stepped through");

    enter2?.click();
    await until(() => !!document.querySelector(".nested-wb"), 120);
    const wb = document.querySelector(".nested-wb");
    ok(!!wb, "the nested workbench opens");
    ok(wb?.getAttribute("role") === "dialog", "…as a dialog");
    ok(!!wb?.querySelector(".track-hit"), "…with a playhead of its own");
    ok(!!wb?.querySelector(".vlist"), "…the messages the subagent accumulated");
    ok(!!wb?.querySelector(".detail"), "…and its own step detail");
    ok(!wb?.querySelector(".filters"), "…and none of the parent's filter bar");

    const nested = wb?.querySelector<HTMLElement>(".track-hit");
    const before = Number(nested?.getAttribute("aria-valuenow"));
    nested?.focus();
    nested?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    await until(() => Number(document.querySelector(".nested-wb .track-hit")
      ?.getAttribute("aria-valuenow")) !== before, 60);
    ok(Number(document.querySelector(".nested-wb .track-hit")?.getAttribute("aria-valuenow")) === before + 1,
      "its playhead moves with the arrow keys");

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await until(() => !document.querySelector(".nested-wb") && !!document.querySelector(".track-hit"), 120);
    ok(!document.querySelector(".nested-wb"), "Escape leaves the delegated run");
    ok(!!document.querySelector(".track-hit"), "…and the parent is where it was");

    // Restoring is the next block's precondition, and it gets there by
    // clicking rather than by calling anything.
  }

  // ---- comparing two runs -------------------------------------------------
  {
    await need("comparing two runs");
    shortcut("c");
    await until(() => !!document.querySelector(".cmp"));
    const panel = document.querySelector(".cmp");
    ok(!!panel, "the compare panel opens");
    ok(panel?.getAttribute("role") === "dialog" && panel?.getAttribute("aria-modal") === "true",
      "…as a dialog");

    // Compare the demo against itself: same tools, same order, and the rule
    // must call that identical even though every word is the same too.
    const useDemo = document.querySelector<HTMLElement>(".cmp .drop-actions button:nth-child(2)");
    ok(!!useDemo && /demo/i.test(useDemo.textContent ?? ""), "…with a way to load a second run",
      useDemo?.textContent ?? "missing");
    useDemo?.click();
    // Loading the second run does a fetch and a parse. Waiting eight frames for
    // that was a bet that held until the blocks before this one started doing
    // network work of their own; the verdict appearing is the actual signal.
    await until(() => !!document.querySelector(".cmp-verdict"));

    const rule = document.querySelector(".cmp-rule-tag");
    ok(!!rule && /tool-call sequence/.test(rule.textContent ?? ""),
      "the alignment rule is stated on screen", rule?.textContent ?? "missing");
    const ruleBody = (document.querySelector(".cmp-rule p")?.textContent ?? "");
    ok(/never read/i.test(ruleBody), "…including that text is never read");
    ok(/positional/i.test(ruleBody), "…and that alignment is positional");

    const verdict = (document.querySelector(".cmp-verdict b")?.textContent ?? "").trim();
    ok(/same .* tools in the same order/.test(verdict),
      "a run compared with itself is identical", verdict);

    const rails = document.querySelectorAll(".cmp-rail canvas").length;
    ok(rails === 2, "both runs get a rail", String(rails));
    const scaleNote = document.querySelector(".cmp-scale-note")?.textContent ?? "";
    ok(/share one scale/.test(scaleNote), "…on one shared scale", scaleNote.slice(0, 50));

    const rows = [...document.querySelectorAll(".cmp-table dt")].map((e) => (e.textContent ?? "").trim());
    ok(rows.includes("tool calls") && rows.includes("errors") && rows.includes("peak context"),
      "the summary table carries both runs and the delta", rows.join(","));

    // Identical runs have nothing to mark, and must not invent a divergence.
    ok(!document.querySelector(".cmp-at"),
      "no divergence is shown when the runs never diverged");

    document.querySelector<HTMLElement>(".cmp-head .btn")?.click();
    await until(() => !document.querySelector(".cmp") && !!document.querySelector(".track-hit"), 120);
    ok(!document.querySelector(".cmp"), "the panel closes");
    ok(!!document.querySelector(".track-hit"), "…and leaves the workbench as it was");
  }

  // ---- the context jump is attributed, not just marked --------------------
  {
    await need("the context jump is attributed, not just marked");
    const note = document.querySelector(".chart-note");
    ok(!!note && /largest jump/.test(note.textContent ?? ""), "the largest jump is marked",
      note?.textContent ?? "missing");
    const attrib = document.querySelector(".chart-attrib");
    ok(!!attrib, "the marked jump carries an attribution line");
    const text = (attrib?.textContent ?? "").trim();
    ok(/still in the array|dropped at the compaction|fell below this level|cannot be traced/.test(text),
      "the attribution says what became of the payload, in one of the four forms it can prove", text);
    ok(/re-sent it|cannot be traced/.test(text),
      "…and says what re-sending it has cost", text);
  }

  // ---- the array delta ----------------------------------------------------
  {
    await need("the array delta");
    const rows = () => [...document.querySelectorAll(".delta dt")].map((e) => (e.textContent ?? "").trim());
    await home();
    ok(document.querySelector(".delta") !== null, "the step detail carries an array delta");
    ok(rows().join(",") === "appended,carried,context,array now",
      "the delta reads as a delta rather than a second messages panel", rows().join(","));

    const readDd = () => [...document.querySelectorAll(".delta dd")].map((e) => (e.textContent ?? "").trim());
    const first = readDd();
    ok(/entry 1\b/.test(first[0]), "the first step appends the first entry", first[0]);

    // Somewhere in the demo an assistant turn spans several lines; the second
    // of them must extend the entry rather than append a new one.
    let extended = "";
    for (let i = 1; i < Math.min(n, 40); i++) {
      await goTo(i);
      const d = readDd();
      if (/a block to entry/.test(d[0])) { extended = d[0]; break; }
    }
    ok(extended !== "", "a step that extends an entry says so rather than claiming a new one", extended);
    await home();
  }

  // ---- filtering ----------------------------------------------------------
  {
    await need("filtering");
    const ticksBefore = countPaintedTicks(n);
    const tools = [...new Set(view.steps.map((x) => x.tool).filter(Boolean))];
    ok(tools.length > 0, "the demo tape calls tools", tools.join(","));

    const note = document.querySelector(".filter-note");
    ok(!!note && /summaries only/i.test(note.textContent ?? ""),
      "the search control states that it covers summaries, not full text",
      note?.textContent ?? "missing");

    await pickTool(tools[0]);
    await until(() => api().matches !== n, 60);
    const m = api().matches;
    ok(m > 0 && m < n, "filtering to one tool matches some steps but not all", `${m} of ${n}`);

    const shown = document.querySelector(".filter-count")?.textContent ?? "";
    ok(shown.includes(String(m)), "the match count is on screen", shown);

    // Dimmed, not deleted: the rail must still carry every step, or the
    // timeline would lie about where the run spent its time.
    ok(Number(slider()?.getAttribute("aria-valuemax")) === n,
      "filtering does not change the number of steps on the track");
    const ticksAfter = countPaintedTicks(n);
    if (ticksBefore.usable && ticksAfter.usable) {
      ok(ticksAfter.groups === ticksBefore.groups,
        "filtering dims ticks rather than removing them",
        `${ticksAfter.groups} painted, was ${ticksBefore.groups}`);
    }

    // The playhead is left alone when it stops matching.
    const stranded = [...api().mask].findIndex((v) => !v);
    if (stranded >= 0) {
      await goTo(stranded);
      ok(api().pos === stranded, "a playhead that stops matching is not moved", `pos=${api().pos}`);
      const flag = document.querySelector(".filter-out");
      ok(!!flag && (flag.textContent ?? "").trim().length > 0,
        "…and it is marked out of filter in words", flag?.textContent ?? "missing");

      // n now means "next match", not "next failure".
      const wasAt = api().pos;
      trackKey("n");
      await until(() => api().pos !== wasAt, 60);
      ok(api().mask[api().pos] === 1, "n steps to the next match while a filter is active",
        `pos=${api().pos}`);
    }

    await click(".filters button", /clear filter/i, "clear the filter");
    await until(() => api().matches === n, 60);
    ok(api().matches === n || !document.querySelector(".filter-out"),
      "clearing the filter releases the playhead");
    ok(!document.querySelector(".filter-out"), "the out-of-filter marker is gone once cleared");

    // Search covers previews.
    const withPreview = view.steps.find((x) => x.tool === tools[0]);
    typeInto(document.querySelector<HTMLInputElement>("input.filter-input")!, tools[0].toLowerCase());
    await until(() => api().matches !== n, 60);
    ok(api().matches > 0, "search matches a tool name", `${api().matches} for "${tools[0]}"`);
    ok(!!withPreview, "the searched tool exists in the view");
    await click(".filters button", /clear filter/i, "clear the filter");
    await until(() => api().matches === n, 60);
  }

  // ---- the filter reaches past the timeline -------------------------------
  {
    await need("the filter reaches past the timeline");
    const tools = [...new Set(view.steps.map((x) => x.tool).filter(Boolean))];

    // The messages panel marks matching entries rather than hiding them.
    await pickTool(tools[0]);
    await until(() => api().matches !== n, 60);
    ok(document.querySelectorAll(".entry-hit").length > 0,
      "the messages panel marks entries that match");
    ok(document.querySelectorAll(".entry-match").length > 0, "…in words, not only by opacity");
    ok(document.querySelectorAll(".entry-miss").length > 0,
      "…and dims the ones that do not, rather than removing them");
    const shownEntries = document.querySelectorAll(".entry").length;
    ok(shownEntries === document.querySelectorAll(".entry-hit, .entry-miss").length,
      "every rendered entry is marked one way or the other", String(shownEntries));

    // Where the playhead sits among the matches, so a silent n is legible.
    await home();
    const posEl = () => (document.querySelector(".filter-pos")?.textContent ?? "").trim();
    ok(!!document.querySelector(".filter-pos"), "the filter bar reports the playhead's match position");
    for (let i = 0; i < 200 && !/· last$/.test(posEl()); i++) {
      const was = posEl();
      trackKey("n");
      // The readout is what the loop condition reads, so that is what is
      // waited on. Bounded tightly because this runs up to two hundred times.
      await until(() => posEl() !== was, 10);
    }
    ok(/· last$/.test(posEl()), "…and says so when the playhead is on the last match", posEl());
    const before = api().pos;
    trackKey("n");
    // Give it a chance to move before asserting that it did not. An assertion
    // about nothing happening that does not wait is an assertion that passes
    // because nothing has rendered yet.
    await until(() => api().pos !== before, 10);
    ok(api().pos === before, "n at the last match does not move the playhead",
      `${before} → ${api().pos} · matches ${api().matches}/${api().view?.steps.length ?? 0}` +
      ` · readout "${posEl()}"`);
    ok(/· last$/.test(posEl()), "…and the reason is still on screen", posEl());

    await click(".filters button", /clear filter/i, "clear the filter");
    await until(() => api().matches === n, 60);
    ok(!document.querySelector(".filter-pos"), "the position readout goes away with the filter");
    ok(document.querySelectorAll(".entry-miss").length === 0, "…and so do the entry marks");
  }

  // ---- the filter controls take free input --------------------------------
  {
    await need("the filter controls take free input");
    const num = document.querySelector<HTMLInputElement>("input.filter-num");
    ok(!!num && num.type === "number", "the size threshold takes any number, not only presets");
    ok(!!num?.getAttribute("list"), "…while still offering common ones");
    typeInto(document.querySelector<HTMLInputElement>("input.filter-num")!, "1234");
    await until(() => api().filter.minChars === 1234, 60);
    ok(document.querySelector<HTMLInputElement>("input.filter-num")?.value === "1234",
      "…and a number outside the presets is accepted");
    await click(".filters button", /clear filter/i, "clear the filter");
    await until(() => api().matches === n, 60);

    const menu = document.querySelector<HTMLDetailsElement>(".tool-menu");
    if (menu) {
      menu.open = true;
      await until(() => document.querySelectorAll(".tool-opt").length > 0, 60);
      const all = document.querySelectorAll(".tool-opt").length;
      const search = document.querySelector<HTMLInputElement>(".tool-menu-search");
      if (all > 6) {
        ok(!!search, "a long tool menu carries a search box", `${all} tools`);
      } else {
        ok(!search, "a short tool menu does not need one", `${all} tools`);
      }
      menu.open = false;
      await until(() => document.querySelectorAll(".tool-opt").length === 0, 30);
    }
  }

  // ---- the demo can demonstrate everything --------------------------------
  {
    await need("the demo can demonstrate everything");
    const compactBtn = [...document.querySelectorAll("button")]
      .find((b) => /^compaction/.test((b.textContent ?? "").trim()));
    ok(!!compactBtn && !(compactBtn as HTMLButtonElement).disabled,
      "the demo has a compaction, so the jump control is usable",
      compactBtn?.textContent ?? "missing");
    ok(api().delegations.length > 0, "…and a delegation, so the absent-work panel has a subject");
    const attrib = (document.querySelector(".chart-attrib")?.textContent ?? "").trim();
    ok(/dropped at the compaction/.test(attrib),
      "…and the compaction branch of the context attribution is demonstrable", attrib);
  }

  // ---- colour is never the only signal ------------------------------------
  if (firstFail >= 0) {
    await goTo(firstFail);
    const flag = document.querySelector(".d-flag");
    ok(!!flag && (flag.textContent ?? "").trim().length > 0,
      "a failed step states its failure in words in the detail panel",
      flag?.textContent ?? "none");
    const rowFail = [...document.querySelectorAll(".blk-fail")].some((e) => (e.textContent ?? "").trim());
    ok(rowFail, "a failed block is labelled in words in the messages panel");
  }
  const legendGlyphs = document.querySelectorAll(".legend-item svg").length;
  ok(legendGlyphs >= 6, "the legend shows a distinct shape per step kind", `${legendGlyphs} glyphs`);

  // ---- the keys are discoverable and they work ----------------------------
  {
    await need("the keys are discoverable and they work");
    const press = (key: string, opts: KeyboardEventInit = {}) =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...opts }));

    press("?");
    await until(() => !!document.querySelector(".sheet"));
    ok(!!document.querySelector(".sheet"), "? opens the shortcut sheet");
    const listed = [...document.querySelectorAll(".sheet-row dd")].map((e) => (e.textContent ?? "").trim());
    ok(listed.length >= 8, "…and it lists the keys in one place", String(listed.length));
    const keyText = (document.querySelector(".sheet-list")?.textContent ?? "");
    for (const k of ["n", "p", "Home", "End", "Esc", "/"]) {
      ok(keyText.includes(k), `…including ${k}`);
    }
    ok(document.querySelector(".sheet")?.getAttribute("role") === "dialog",
      "the sheet is a dialog");
    ok(document.activeElement === document.querySelector(".sheet"),
      "…and focus moves into it");

    // Tab must not walk out the back of a dialog into the workbench behind it.
    // Eight presses was a guess at "more stops than the sheet has"; the thing
    // being tested is that focus is still inside afterwards, so press until it
    // has been round at least once and stop on the observable state.
    const sheetEl = document.querySelector(".sheet");
    for (let i = 0; i < 24; i++) {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
      await frame();
      if (i >= 7 && sheetEl?.contains(document.activeElement)) break;
    }
    ok(document.querySelector(".sheet")?.contains(document.activeElement) === true,
      "Tab stays inside the dialog rather than escaping behind it");

    press("Escape");
    await until(() => !document.querySelector(".sheet"), 120);
    ok(!document.querySelector(".sheet"), "Escape closes it");

    // c and a reach the two overlays, and Escape gets back out of each.
    press("c");
    await until(() => !!document.querySelector(".cmp"));
    ok(!!document.querySelector(".cmp"), "c opens the comparison");
    ok(document.activeElement === document.querySelector(".cmp"), "…with focus inside it");
    press("Escape");
    await until(() => !document.querySelector(".cmp"), 120);
    ok(!document.querySelector(".cmp"), "Escape closes the comparison");

    press("a");
    await until(() => !!document.querySelector(".asserts"));
    ok(!!document.querySelector(".asserts"), "a opens the assertions");
    press("Escape");
    await until(() => !document.querySelector(".asserts"), 120);
    ok(!document.querySelector(".asserts"), "Escape closes them");

    // The keys must not fire while typing.
    const box = document.querySelector<HTMLInputElement>("input.filter-input");
    box?.focus();
    box?.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true, cancelable: true }));
    // Nothing is supposed to happen, so there is no consequence to wait for —
    // wait for the page to stop changing instead of guessing at three frames.
    await quiet(() => document.querySelectorAll(".cmp, .asserts, .sheet").length);
    ok(!document.querySelector(".cmp"), "the shortcuts do not fire inside a text box");
    box?.blur();
    await until(() => document.activeElement !== box, 30);

    // / puts the caret in the search box from anywhere.
    document.querySelector<HTMLElement>(".track-hit")?.focus();
    press("/");
    await until(() => document.activeElement === box, 60);
    ok(document.activeElement === box, "/ jumps to the search box");
    (document.activeElement as HTMLElement)?.blur();
    await until(() => document.activeElement !== box, 30);

    const keyBtn = [...document.querySelectorAll(".strip-actions button")]
      .find((b) => /keyboard/i.test(b.getAttribute("aria-label") ?? ""));
    ok(!!keyBtn, "the sheet is reachable without knowing the key");
  }

  // ---- accessible names and reachability ----------------------------------
  const controls = [...document.querySelectorAll<HTMLElement>(
    'button, input, select, textarea, a[href], [role="slider"], [tabindex]',
  )];
  const unreachable = controls.filter((el) => {
    if (el.getAttribute("aria-hidden") === "true") return false;
    if (el instanceof HTMLElement && el.classList.contains("sr-only")) return false;
    return el.tabIndex < 0;
  });
  ok(unreachable.length === 0, "every control is reachable by keyboard",
    unreachable.map((e) => e.className || e.tagName).join(", ") || "none");

  const nameless = controls.filter((el) => {
    if (el.getAttribute("aria-hidden") === "true") return false;
    const label = (el.getAttribute("aria-label") ?? "") + (el.getAttribute("title") ?? "") +
      (el.textContent ?? "") +
      (el.id ? document.querySelector(`label[for="${el.id}"]`)?.textContent ?? "" : "") +
      (el.closest("label")?.textContent ?? "");
    return label.trim().length === 0;
  });
  ok(nameless.length === 0, "every control has an accessible name",
    nameless.map((e) => e.className || e.tagName).join(", ") || "none");

  // ---- reduced motion -----------------------------------------------------
  let reduced = false;
  for (const sheet of [...document.styleSheets]) {
    try {
      for (const rule of [...(sheet.cssRules ?? [])]) {
        if (rule instanceof CSSMediaRule && rule.conditionText.includes("prefers-reduced-motion")) {
          reduced = true;
        }
      }
    } catch {
      /* a cross-origin sheet cannot be inspected; none of ours are */
    }
  }
  ok(reduced, "the stylesheet honours prefers-reduced-motion");

  // ---- window surface -----------------------------------------------------
  const globals = Object.keys(window).filter((k) => k.startsWith("__agenttape") || k === "__selftest");
  ok(
    globals.every((k) => k === "__agenttape" || k === "__selftest"),
    "only the flagged globals are exposed",
    globals.join(", "),
  );

  // ---- the browser can build the index itself -----------------------------
  {
    await need("the browser can build the index itself");
    const support = await api().pickerSupport();
    ok(["directory-picker", "webkitdirectory", "none"].includes(support),
      "the folder picker is feature-detected, not assumed", support);

    // Two invented transcripts as Files, with the relative paths a folder pick
    // would give them, so the project/session split is exercised too.
    const at = (n: number) => new Date(Date.parse("2026-10-10T09:00:00Z") + n * 1000).toISOString();
    const MARK = "WWLEAKWW";
    const make = (session: string, project: string, tools: string[]) => {
      const lines = [
        JSON.stringify({ type: "custom-title", sessionId: session, customTitle: MARK + "-title" }),
        JSON.stringify({ type: "user", sessionId: session, uuid: "u0", timestamp: at(0),
          cwd: "/Users/" + MARK, gitBranch: MARK + "-b", version: "9.9.9",
          message: { role: "user", content: [{ type: "text", text: MARK + "-said" }] } }),
      ];
      tools.forEach((name, i) => {
        lines.push(JSON.stringify({ type: "assistant", sessionId: session, uuid: "a" + i,
          timestamp: at(i * 2 + 1),
          message: { role: "assistant", id: "m" + i, model: "claude-opus-5",
            usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 900 * (i + 1),
              cache_creation_input_tokens: 0 },
            content: [{ type: "tool_use", id: "t" + i, name, input: { note: MARK + "-in" } }] } }));
        lines.push(JSON.stringify({ type: "user", sessionId: session, uuid: "r" + i,
          timestamp: at(i * 2 + 2),
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t" + i,
            is_error: i === 1, content: MARK + "-out" }] } }));
      });
      const f = new File([lines.join("\n")], session + ".jsonl", { type: "application/x-ndjson" });
      Object.defineProperty(f, "webkitRelativePath", {
        value: `projects/${project}/${session}.jsonl`, configurable: true,
      });
      return f;
    };

    window.localStorage.removeItem("agenttape-local-index");
    // Built once and reused: a fresh File gets a fresh lastModified, so
    // rebuilding them would make the cache correctly consider them changed and
    // the second pass below would be testing nothing.
    const files = [
      make("aaaa-1111", "-a-project", ["Bash", "Read", "Bash"]),
      make("bbbb-2222", "-b-project", ["Write"]),
    ];
    const res = await api().indexFiles(files);
    ok(res.sessions.length === 2, "the browser indexes what it was handed", String(res.sessions.length));
    ok(res.indexed === 2 && res.cached === 0, "…parsing both the first time");

    const rows = res.sessions as { project?: string; session?: string; tools?: Record<string, number> }[];
    ok(rows.some((r) => r.project === "-a-project"),
      "…splitting the project out of the path", rows.map((r) => r.project).join(","));
    ok(rows.some((r) => (r.tools ?? {}).Bash === 2), "…and counting its tools");

    // The cache is a new place data lands, so it gets the same marker test as
    // every other artefact: nothing a transcript said may reach it.
    const cached = window.localStorage.getItem("agenttape-local-index") ?? "";
    ok(cached.length > 0, "the browser caches its index", `${cached.length} chars`);
    ok(!cached.includes(MARK), "…and no transcript text reaches that cache",
      cached.includes(MARK) ? cached.slice(cached.indexOf(MARK) - 40, cached.indexOf(MARK) + 20) : "");

    const parsed = JSON.parse(cached) as { entries: Record<string, Record<string, unknown>> };
    const stray: string[] = [];
    for (const rec of Object.values(parsed.entries)) {
      for (const [k, v] of Object.entries(rec)) {
        if (typeof v === "string" && k !== "project" && k !== "session") stray.push(k);
        if (Array.isArray(v) && v.some((x) => typeof x === "string") &&
            k !== "models" && k !== "versions") stray.push(k);
      }
    }
    ok(stray.length === 0, "…and every string in it is an identifier or a name",
      [...new Set(stray)].join(", "));

    // Second pass: the cache is used rather than ignored.
    const again = await api().indexFiles(files);
    ok(again.cached === 2 && again.indexed === 0, "a second pass comes from the cache",
      `${again.cached} cached, ${again.indexed} parsed`);

    window.localStorage.removeItem("agenttape-local-index");
  }

  // ---- the overview, if the helper is answering ---------------------------
  {
    await need("the overview, if the helper is answering");
    // Four labels either way. The mode decides whether they are answered,
    // never how many there are.
    const L = [
      "the helper returns session statistics",
      "no session record carries a string but its identifiers and its vocabulary",
      "every session carries a context profile for its sparkline",
      "…and the counts the table sorts by",
    ] as const;

    if (!HELPER_MODE) {
      const why = "run without ?helper=1, so the helper path was not exercised";
      for (const label of L) skip(label, why);
    } else if (!(await fetch("http://127.0.0.1:4319/health").then((r) => r.ok).catch(() => false))) {
      // Requested and not delivered. A skip here would let a gate pass on a
      // machine where the thing it is gating never ran.
      const why = "?helper=1 was asked for and nothing answered on 127.0.0.1:4319";
      for (const label of L) ok(false, label, why);
    } else {
      const res = await fetch("http://127.0.0.1:4319/overview").then((r) => r.json());
      const rows = res.sessions ?? [];
      ok(Array.isArray(rows) && rows.length > 0, L[0], `${rows.length} sessions`);

      // The property that matters: a statistics record holds no prose.
      const allowed = new Set(["project", "session"]);
      const stray: string[] = [];
      for (const r of rows) {
        for (const [k, v] of Object.entries(r)) {
          if (typeof v === "string" && !allowed.has(k)) stray.push(k);
          if (Array.isArray(v) && v.some((x) => typeof x === "string") &&
              k !== "models" && k !== "versions") stray.push(k);
        }
      }
      ok(stray.length === 0, L[1], [...new Set(stray)].join(", "));
      ok(rows.every((r: { ctxProfile?: number[] }) => Array.isArray(r.ctxProfile)), L[2]);
      ok(rows.every((r: { steps?: number }) => typeof r.steps === "number"), L[3]);
    }
  }

  // ---- virtualisation on a large tape -------------------------------------
  // Every call below goes through api() rather than the captured reference:
  // the object on window is rebuilt each render, and the old closures still
  // point at the previous tape.
  const BIG = 6000;
  api().loadTapeFile(syntheticTape(BIG));
  // Wait for the render rather than assuming a fixed number of frames: the
  // blocks before this one do network work, and a fixed wait made this flaky.
  await until(() => api().view?.steps.length === BIG, 240);
  const big = api().view;
  ok(!!big && big.steps.length === BIG, "the synthetic tape loaded", `${big?.steps.length ?? 0} steps`);
  // The one position that is not reachable by keyboard in reasonable time:
  // six thousand ArrowRights. End would do it, but this block is about the
  // messages panel at the far end of a large tape rather than about the
  // playhead, so it is set directly and said out loud.
  api().setPos(BIG - 1);
  // Two sources on the lines below: the playhead, and the panel drawn from it.
  await until(() => api().pos === BIG - 1 && !!document.querySelector(".vlist"), 240);
  const list = document.querySelector(".vlist");
  const rendered = list?.querySelectorAll(".entry").length ?? 0;
  const expected = Number(list?.getAttribute("data-count") ?? 0);
  ok(expected > 1000, "the panel believes it has thousands of entries", `${expected} entries`);
  ok(rendered > 0 && rendered < 120, "the messages panel is virtualised",
    `${rendered} rows in the DOM for ${expected} entries`);
  const nodes = document.querySelectorAll(".pane-body *").length;
  ok(nodes < 3000, "the DOM node count stays bounded", `${nodes} nodes`);
}

function report(results: { ok: boolean; label: string; note?: string; skipped?: boolean }[]): void {
  const pass = results.filter((r) => r.ok).length;
  const skipped = results.filter((r) => r.skipped).length;
  const fail = results.length - pass - skipped;
  const lines = results.map((r) =>
    (r.skipped ? "  --   " : r.ok ? "  ok   " : "  FAIL ") + r.label +
    (r.note ? "  [" + r.note + "]" : ""),
  );
  // Skipped sits in the denominator and outside the pass count, the same way
  // a vacuous rule does in `agenttape check`. "Nothing violated this" and
  // "this was never tested" are different facts and are reported as two.
  const head = `AgentTape self-test [${MODE}] — ${pass}/${results.length} passed, ` +
    `${fail} failed, ${skipped} not run here`;
  const text = head + "\n\n" + lines.join("\n");
  (window as unknown as Record<string, unknown>).__selftest = {
    pass, fail, skipped, total: results.length,
    mode: MODE, expected: DECLARED[MODE].total, expectedSkips: DECLARED[MODE].skipped,
    results,
  };
  document.title = `selftest ${pass}/${results.length}`;
  const pre = document.createElement("pre");
  pre.className = "selftest-report";
  pre.id = "selftest-report";
  pre.textContent = text;
  document.body.appendChild(pre);
  // eslint-disable-next-line no-console
  console.log(text);
}
