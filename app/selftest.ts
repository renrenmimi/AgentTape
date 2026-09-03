// ?selftest=1 — the assertions a screenshot cannot make.
//
// These run against the live DOM after a session is loaded. They exist because
// the interesting claims in this application are behavioural: that the step
// list stays bounded when the tape has thousands of entries, that failure is
// never signalled by colour alone, that going to Compare and back does not
// lose your place, and that keyboard users can reach every control.
//
// The rule that shapes the whole file: **operate the interface**. A block gets
// to its starting state the way a person does — by clicking the control that
// says what it is going to do — and waits for the consequence it is about to
// read rather than for a promise or a number of frames. The short list of
// things still driven directly is enumerated in verify.mjs and each one says
// why.
//
// Nothing in this file, and nothing in the application, touches `window`
// unless the flag is present.

import { TAPE_FORMAT, type TapeFile, type TapeStep } from "@/lib/tape";
import { ctx2d } from "./canvas";

type Filterish = { tools: string[]; minChars: number; query: string };

type Api = {
  tape: { steps: unknown[] } | null;
  view: { steps: { i: number; err: boolean; tool: string; kind: string }[] } | null;
  pos: number;
  gpos: number;
  setPos: (n: number) => void;
  goToGlobal: (n: number) => void;
  onDemo: () => Promise<void>;
  loadTapeFile: (f: TapeFile) => void;
  setShowMeta: (b: boolean) => void;
  filter: Filterish;
  setFilter: (f: Filterish) => void;
  matches: number;
  mask: Uint8Array;
  seekNext: (dir: 1 | -1) => void;
  where: string;
  goToView: (v: string) => void;
  setSessionsOpen: (b: boolean) => void;
  tab: string;
  setTab: (t: string) => void;
  leftMode: string;
  setLeftMode: (m: string) => void;
  delegations: { step: number; run: unknown }[];
  setChecksOpen: (b: boolean) => void;
  checksOpen: boolean;
  setKeysOpen: (b: boolean) => void;
  keysOpen: boolean;
  setInside: (n: number) => void;
  reportText: () => string;
  events: { kind: string; step: number; target: string }[];
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
 * Nothing in this suite used to fail when the page threw. Two real defects
 * were found and fixed in one round — both keyboard handlers cast `e.target`
 * to an element when a programmatic keydown arrives with `window` as its
 * target, killing the handler with an uncaught TypeError — and **the score did
 * not move**: 141 before, 141 after. Two genuine bugs, invisible to a
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

/** A shortcut, sent the way the page receives one: on the window. */
const shortcut = (k: string, opts: KeyboardEventInit = {}) =>
  window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...opts }));

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

/**
 * Wait for the observable consequence, never for a promise or a frame count.
 *
 * This is the rule the whole teardown problem came from. `await a.onDemo()`
 * resolves when the fetch and the parse are done, which says nothing about
 * whether React has re-rendered with the result. `await settle(6)` is the same
 * bet in a different currency: six frames is enough until something upstream
 * does network work and it is not.
 *
 * So nothing here waits on a promise or on a number of frames to establish
 * that a state change has landed. It waits for the thing it is actually
 * waiting for, and says so when it does not arrive.
 */
const until = async (cond: () => boolean, tries = 240): Promise<boolean> => {
  for (let i = 0; i < tries; i++) {
    if (cond()) return true;
    await frame();
  }
  return cond();
};

/**
 * Wait until the thing stops changing.
 *
 * `until` needs a consequence to wait for, and an assertion that nothing
 * happened has none — which is why "n at the last match does nothing" was
 * checked after a fixed two frames and read a playhead that had not finished
 * moving from the step before. For those, the state to wait on is quiescence.
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
  if (!(await until(() => !!find(), 160))) throw new Error(`nothing on screen to ${what}`);
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

/** Tick the checkbox for one tool, opening the Filters popover as a person would. */
async function pickTool(name: string): Promise<void> {
  await click(".replay-jumps button", /^filters/i, "open the filters");
  if (!(await until(() => document.querySelectorAll(".tool-opt").length > 0, 90))) {
    throw new Error("the filters popover opened with no tools in it");
  }
  const opt = [...document.querySelectorAll<HTMLElement>(".tool-opt")]
    .find((l) => (l.querySelector(".tool-opt-name")?.textContent ?? "").trim() === name);
  const box = opt?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (!box) throw new Error(`the filters popover has no entry for ${name}`);
  box.click();
  await click(".popover-foot button", /^done$/i, "close the filters");
}

/** Take every filter off, through the control that says so. */
async function clearFilters(): Promise<void> {
  const chip = [...document.querySelectorAll<HTMLElement>(".chips button")]
    .find((b) => /clear filters/i.test(b.textContent ?? ""));
  if (chip) { chip.click(); return; }
  await click(".list-empty button", /clear filters/i, "clear the filters");
}

/**
 * Send a key to the position rail, focusing it first, the way a person reaches
 * it. Defined here rather than inside a block because several blocks need it
 * and the alternative was each of them calling a setter instead.
 */
function trackKey(k: string, opts: KeyboardEventInit = {}): void {
  const el = document.querySelector<HTMLElement>(".replay-rail .track-hit");
  el?.focus();
  el?.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...opts }));
}

/** Put the playhead at the start, by pressing Home on the rail. */
const home = () => until(() => { trackKey("Home"); return api().pos === 0; }, 60);

/**
 * Put the playhead on a given step, by pressing Home and then walking right.
 *
 * There is no control that jumps to an arbitrary index — a person clicks a row
 * or drags — so this is the keyboard route, which is a real one and is
 * bounded: it is only used for positions inside the thirty-one step demo. The
 * two places that need a position in a six-thousand step tape still set it
 * directly, and say so.
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

/** How many steps the replay believes it is showing, read off the rail. */
const shownSteps = () =>
  Number(document.querySelector(".replay-rail .track-hit")?.getAttribute("aria-valuemax") ?? 0);

/** The demo tape's own length, so "is the demo loaded" is a fact, not a guess. */
const DEMO_STEPS = 31;

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
 * How many separate marks the position rail actually has on screen. Used twice:
 * once to check the rail draws one per step, and again to check that filtering
 * dims ticks rather than deleting them.
 *
 * The band deliberately stops above the rail's baseline. A line drawn across
 * every column would make every column look occupied, which is a measurement
 * of the baseline rather than of the ticks.
 */
function countPaintedTicks(n: number): { usable: boolean; groups: number; why: string } {
  const canvas = document.querySelector<HTMLCanvasElement>(".replay-rail .track canvas");
  if (!canvas) return { usable: false, groups: 0, why: "no canvas" };
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const spacing = (canvas.width / dpr - 16) / n;
  if (spacing < 6) return { usable: false, groups: 0, why: `spacing ${spacing.toFixed(2)}px` };
  // The canvas was created with willReadFrequently because the flag is set;
  // options passed here would be ignored, so this just takes the context.
  const g = ctx2d(canvas);
  const band = g?.getImageData(0, Math.round(4 * dpr), canvas.width, Math.round(20 * dpr));
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
const DECLARED_ASSERTIONS = 353;

/**
 * How many `ok(` and `skip(` call sites this file contains.
 *
 * The second counter, and the reason there has to be one. The declared total
 * above is accumulated while the suite runs, so it cannot see an assertion that
 * is written and never reached — the source still contains it and the run
 * simply never gets there. This one is counted statically by verify.mjs, from
 * outside, and the two have to move together.
 *
 * It said 161 for a round. Not because an assertion was added since — because
 * the counter that produced it was a per-line regex that dropped any line whose
 * text contained the word "skipped". A scanner that stops early reports a
 * smaller number confidently, which is why this is now counted twice by methods
 * that fail differently and the two have to agree.
 */
export const DECLARED_CALL_SITES = 320;

/**
 * Which mode the run is in, and what that mode is supposed to produce.
 *
 * The session-index block needs the local helper. It used to decide for itself
 * by probing 127.0.0.1:4319 — so on a machine with a helper running it
 * exercised four assertions, and on one without it skipped them, and *the
 * suite behaved differently depending on what happened to be running on the
 * box*. That is not something a gate can be built on. The driver decides now,
 * with `?helper=1`, and each mode declares what it produces. Asking for the
 * helper mode without a helper is a failure rather than a skip: the mode was
 * requested and could not be delivered.
 */
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
   * The helper block used to answer "the helper is not running" with
   * `ok(true, "…skipped…")`, which is a vacuous pass — the exact thing this
   * project's own rule checker refuses to call a pass. Worse, that branch
   * emitted one result where the other emitted four, so the suite's total
   * depended on whether a helper happened to be running. A frozen count and an
   * environment-dependent total cannot both be true.
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
    // trip, and nothing else in this suite reads rendered text looking for them.
    const junk = /\bundefined\b|\bNaN\b|\[object Object\]/;
    const guilty: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>(".detail-panel *, .shell *, .replay-left *")) {
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
    const heading = (document.querySelector(".step-head-title")?.textContent ?? "").trim();
    const want = api().view?.steps[at];
    ok(!!want && new RegExp(`\\b${(want.i + 1).toLocaleString("en-US")}\\b`).test(heading),
      "the step panel is showing the step the playhead is on",
      `heading "${heading}" for step ${(want?.i ?? -1) + 1}`);
  }

  // Last, so it covers everything above it.
  // Aggregated, never truncated. These two used to keep the first three
  // distinct messages, which is exactly how a detection layer that works ends
  // up reporting nothing useful.
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
 * The last block the suite entered, published as it goes.
 *
 * For the case where nothing is reported at all. A browser that hangs and is
 * killed by the runner's own limit produces no signal — that is the WebKit 2287
 * failure this project already refused once — so the driver reads this on
 * timeout and can say where it stopped instead of that it stopped.
 */
let CURRENT_BLOCK = "(before the first block)";

/** Everything that can be on top of a view, in the order Escape closes them. */
const LAYERS = ".layer, .scrim";

/**
 * What a block needs before it starts, checked and repaired in one place.
 *
 * This is the change that mattered most, and eighteen failures are why. They
 * were downstream symptoms with no diagnostic content: eleven said "the
 * shortcut sheet did not open" when the fault was that a block three sections
 * earlier had left a four-step synthetic tape loaded with an overlay on top of
 * it. Eighteen mysterious failures should have been one clear one.
 *
 * So every block declares what it starts from. If the state is wrong it is put
 * right; if it cannot be put right, this throws naming the block and what it
 * actually found, which the wrapper turns into a single failed assertion. It
 * adds no assertion of its own — the frozen count is what makes a score
 * comparable, and a guard that inflates the denominator every time somebody
 * adds a block would undo it.
 */
async function need(block: string): Promise<void> {
  CURRENT_BLOCK = block;
  (window as unknown as Record<string, unknown>).__selftest_at = { block, at: Date.now() };
  // Layers close the way they close for a person: Escape, which the page
  // documents in its own shortcut sheet. Repeated because Escape closes one
  // layer at a time, which is the behaviour rather than a limitation.
  for (let i = 0; i < 6; i++) {
    if (!document.querySelector(LAYERS)) break;
    shortcut("Escape");
    await until(() => !document.querySelector(LAYERS), 20);
  }
  if (!(await until(() => !document.querySelector(LAYERS)))) {
    throw new Error(`${block}: a layer from the previous block would not close`);
  }

  // The demo is loaded the way a person loads it: Open session, then the demo
  // button in the dialog. There is no call into the page here and nothing
  // captured — a block arrives at its starting state through the same path a
  // user takes, which is why there is no leakage to defend against.
  if (api().tape === null || shownStepsAnywhere() !== DEMO_STEPS) {
    await click(".shell-bar button", /open session/i, `${block}: open the session dialog`);
    if (!(await until(() => !!document.querySelector(".dialog")))) {
      throw new Error(`${block}: the Open session dialog did not appear`);
    }
    await click(".dialog button", /try a demo/i, `${block}: load the demo`);
    if (!(await until(() => !document.querySelector(".dialog") && api().tape !== null, 240))) {
      throw new Error(`${block}: loading the demo through the dialog did not take`);
    }
  }

  // Blocks assert against Replay unless they say otherwise, so that is where
  // `need` leaves the page.
  if (api().where !== "replay") {
    await click(".view-tab", /^replay$/i, `${block}: go to Replay`);
  }
  if (!(await until(() => !!document.querySelector(".replay-rail .track-hit")))) {
    throw new Error(`${block}: the demo is loaded but Replay did not render`);
  }
  if (!(await until(() => api().view?.steps.length === DEMO_STEPS))) {
    throw new Error(
      `${block}: the demo is loaded but the view is showing ` +
      `${api().view?.steps.length ?? 0} steps`,
    );
  }
  if (api().leftMode !== "steps") {
    await click(".left-head .seg", /^steps$/i, `${block}: put the list back on Steps`);
  }
  if (api().tab !== "details") {
    await click(".tabs .tab", /^details$/i, `${block}: put the panel back on Details`);
  }
  if (api().filter.query || api().filter.tools.length || api().filter.minChars) {
    await clearFilters();
    await until(() => api().matches === (api().view?.steps.length ?? 0), 120);
  }
}

/** How many steps are loaded, whichever view is on screen. */
const shownStepsAnywhere = (): number => api().view?.steps.length ?? 0;

async function runBlocks(
  ok: (cond: boolean, label: string, note?: string) => void,
  skip: (label: string, why: string) => void,
): Promise<void> {

  // ---- the landing page ---------------------------------------------------
  //
  // The first screen has one job: say what this is and give two ways to start.
  // It is asserted before anything is loaded, because after that it is gone.
  {
    CURRENT_BLOCK = "the landing page";
    const h1 = (document.querySelector("h1")?.textContent ?? "").trim();
    ok(/what happened in an agent session/i.test(h1), "the first heading says what this is", h1);
    ok(document.querySelectorAll("h1").length === 1, "…and there is exactly one of it",
      String(document.querySelectorAll("h1").length));

    const primary = document.querySelector<HTMLElement>(".open-actions .btn-primary");
    ok(!!primary && /try a demo/i.test(primary.textContent ?? ""),
      "the primary action is the demo", primary?.textContent ?? "missing");
    const top = primary?.getBoundingClientRect().top ?? 1e9;
    ok(top < 600, "…and it is above the fold on a 720-pixel viewport", `${Math.round(top)}px down`);

    const second = [...document.querySelectorAll<HTMLElement>(".open-actions .btn")]
      .find((b) => /open a transcript/i.test(b.textContent ?? ""));
    ok(!!second, "a transcript can be opened without the demo");
    const drop = (document.querySelector(".dropzone")?.textContent ?? "");
    ok(/\.jsonl/.test(drop) && /\.tape\.json/.test(drop),
      "both extensions are named where the file goes", drop.slice(0, 80));

    const privacy = (document.querySelector(".privacy-line")?.textContent ?? "").trim();
    ok(/read in your browser, not uploaded/i.test(privacy),
      "the privacy claim is next to the control it is about", privacy);

    const side = (document.querySelector(".home-side")?.textContent ?? "");
    ok(/browse local sessions/i.test(side), "the session index is reachable from here");
    ok(!!document.querySelector('.home-side a[href="/format"]'),
      "…and so is the format reference");

    // The claim above is checkable, and this is the check: nothing in the
    // application posts anywhere. A form or a fetch to a remote host would be
    // the shape of an upload.
    ok(document.querySelectorAll("form[action]").length === 0,
      "there is no form that submits anywhere");
  }

  // ---- opening the demo ---------------------------------------------------
  {
    CURRENT_BLOCK = "opening the demo";
    await click(".open-actions button", /try a demo/i, "load the demo");
    // Both, and this is the part that is easy to get wrong: the DOM commits
    // before React flushes the passive effect that republishes the debug
    // handle, and a double-rAF lands between the two. The rule is not "wait on
    // the DOM" — it is "wait on whichever source of truth the next line reads".
    await until(() => !!api().tape && !!api().view);
    ok(!!api().tape, "a session is loaded");
    ok(api().where === "overview", "…and it opens on the overview, not in the middle of a replay",
      api().where);
    ok(api().view!.steps.length === DEMO_STEPS, "the demo is the tape it says it is",
      `${api().view!.steps.length} steps`);
  }

  const n = DEMO_STEPS;

  // ---- the overview answers the first question ----------------------------
  {
    CURRENT_BLOCK = "the overview answers the first question";
    const h1 = (document.querySelector(".view-title")?.textContent ?? "").trim();
    ok(h1.length > 0, "the overview has a visible heading of its own", h1);
    ok(document.querySelectorAll("h1").length === 1,
      "…and the brand is not competing with it for the h1",
      String(document.querySelectorAll("h1").length));

    const figures = [...document.querySelectorAll(".figure-label")].map((e) => (e.textContent ?? "").trim());
    ok(figures.length === 3, "three figures, not twelve", `${figures.length}: ${figures.join(", ")}`);
    ok(figures.join(",") === "Steps,Tool calls,Failed tool calls",
      "…and they are the three that answer how big and how bad", figures.join(","));

    // The sentence is generated from counts. A fixed demo string would read
    // the same on somebody else's transcript, which is the whole failure.
    const facts = (document.querySelector(".summary-facts")?.textContent ?? "").trim();
    ok(new RegExp(`^${n} steps`).test(facts), "the summary sentence is built from this run's counts",
      facts);
    ok(!/succe|perfect|clean run|went well/i.test(facts),
      "…and says nothing about whether the run went well", facts);

    const explore = [...document.querySelectorAll<HTMLElement>(".summary-actions button")]
      .find((b) => /explore the session/i.test(b.textContent ?? ""));
    ok(!!explore, "there is one obvious next step");

    const events = [...document.querySelectorAll(".event")];
    ok(events.length > 0 && events.length <= 6, "the key events are a short list",
      `${events.length} shown`);
    ok(events.every((e) => !!e.querySelector(".event-go")),
      "…and every one of them goes somewhere");
    const titles = events.map((e) => (e.querySelector(".event-title")?.textContent ?? "").trim());
    ok(titles.some((t) => /^Tool call failed/.test(t)), "the failures are among them", titles.join(" | "));
    ok(titles.some((t) => /^Largest observed context increase/.test(t)),
      "…and so is the context increase, named as observed rather than as a cause",
      titles.join(" | "));
    const detail = (events[0]?.querySelector(".event-detail")?.textContent ?? "").trim();
    ok(/^Step \d/.test(detail), "each event says where it happened", detail);

    // Everything that is not one of the three figures is still here, under a
    // control. Reducing the interface must not be a way of deleting figures.
    const fold = [...document.querySelectorAll<HTMLElement>(".details-toggle")]
      .find((b) => /session details/i.test(b.textContent ?? ""));
    ok(!!fold, "the rest of the statistics are behind a named control");
    ok(fold?.getAttribute("aria-expanded") === "false", "…closed by default");
    fold?.click();
    await until(() => fold?.getAttribute("aria-expanded") === "true", 60);
    // Read the labels, not the concatenated text: a `dt` and its `dd` join
    // with no space between them, so "File" and "249 KB" arrive as "File249"
    // and a word-boundary match on the label silently stops working.
    const labels = [...document.querySelectorAll(".details-body dt")]
      .map((e) => (e.textContent ?? "").trim());
    for (const what of [
      "Wall clock", "Active time", "Idle gaps", "Messages-array entries",
      "Bookkeeping records", "Input tokens", "Cache read", "Cache write",
      "Output tokens", "Peak context", "Largest observed increase", "Compactions",
      "Models", "Source", "File", "Unreadable lines", "Writer versions", "Redacted",
    ]) {
      ok(labels.includes(what), "Session details still carries " + what,
        labels.length + " rows");
    }
    ok(document.querySelectorAll(".tools-table tbody tr").length > 0,
      "…and the per-tool breakdown");
    fold?.click();
    await until(() => fold?.getAttribute("aria-expanded") === "false", 60);

    // A record that is missing a quarter of the work says so.
    const notes = (document.querySelector(".notes-block")?.textContent ?? "");
    ok(/not included in this file/.test(notes),
      "an absent delegated run is stated on the overview, not implied by silence",
      notes.slice(0, 90));
  }

  // ---- an event goes to its evidence --------------------------------------
  {
    CURRENT_BLOCK = "an event goes to its evidence";
    const first = api().events.find((e) => e.kind === "tool-failure");
    ok(!!first, "the demo has a failed tool call to inspect");
    await click(".event-go", /inspect step/i, "inspect the first event");
    await until(() => api().where === "replay" && api().gpos === first!.step, 180);
    ok(api().where === "replay", "the event lands in Replay", api().where);
    ok(api().gpos === first!.step, "…on the exact step it named",
      `${api().gpos} vs ${first!.step}`);
    ok(api().tab === "details", "…with the evidence tab showing", api().tab);

    // The three things somebody following a failure wants, on one screen.
    const panel = (document.querySelector(".detail-panel")?.textContent ?? "");
    ok(/This step failed/.test(panel), "the failure is stated in words", panel.slice(0, 60));
    const head = (document.querySelector(".step-head-title")?.textContent ?? "");
    ok(/Tool result|Tool call/.test(head), "the heading names what kind of step it is", head);
    ok(/Edit|Bash|Read|Write|Agent/.test(head),
      "…and which tool, even though the result does not carry the name", head);
    const secs = [...document.querySelectorAll(".detail-panel .sec-title")]
      .map((e) => (e.textContent ?? "").trim());
    ok(secs.some((t) => /^Tool result/.test(t)), "the result is on the page", secs.join(" | "));
    ok(secs.some((t) => /call this answers/i.test(t)),
      "…and so is the call it answers", secs.join(" | "));
    const pair = (document.querySelector(".pair-line")?.textContent ?? "");
    ok(/Go to step \d/.test(pair), "…with a control that goes to it", pair);
    // Bodies are read once the playhead has settled, so the count is a thing
    // to wait for rather than a thing to sample.
    await until(() => document.querySelectorAll(".detail-panel .code-block").length >= 2, 240);
    ok(document.querySelectorAll(".detail-panel .code-block").length >= 2,
      "both halves of the exchange are shown, not just the one you clicked",
      String(document.querySelectorAll(".detail-panel .code-block").length));
  }

  // ---- a context event goes to the context view ---------------------------
  {
    await need("a context event goes to the context view");
    await click(".view-tab", /^overview$/i, "go back to the overview");
    await until(() => api().where === "overview", 120);
    const jump = api().events.find((e) => e.kind === "context-jump");
    ok(!!jump, "the demo has a context increase to inspect");
    const row = [...document.querySelectorAll<HTMLElement>(".event")]
      .find((e) => /context increase/i.test(e.textContent ?? ""));
    row?.querySelector<HTMLElement>(".event-go")?.click();
    await until(() => api().where === "replay" && api().tab === "context", 180);
    ok(api().tab === "context", "a context event opens the context view", api().tab);
    ok(api().gpos === jump!.step, "…on the step it named", `${api().gpos} vs ${jump!.step}`);

    const readout = (document.querySelector(".chart-readout")?.textContent ?? "");
    ok(/tokens in the array/.test(readout), "the chart says what its numbers are", readout.slice(0, 60));
    ok(/Vertical axis in tokens/.test(readout), "…and what its axes are", readout.slice(-70));

    // Switching to Details must stay on the same step. The old panel reset to
    // the first step whenever the view changed, which is the single most
    // annoying thing a stepped interface can do.
    const at = api().gpos;
    await click(".tabs .tab", /^details$/i, "go to Details");
    await until(() => api().tab === "details", 120);
    ok(api().gpos === at, "going back to Details keeps the same step", `${api().gpos} vs ${at}`);
  }

  // ---- the context view is a chart, not a strip ---------------------------
  {
    await need("the context view is a chart, not a strip");
    await click(".tabs .tab", /^context$/i, "open the context view");
    await until(() => api().tab === "context", 120);

    const chart = document.querySelector<HTMLElement>(".chart-hit");
    ok(!!chart, "the chart is there");
    ok(chart?.getAttribute("role") === "slider", "…and is operable, not a picture");
    ok((chart?.getAttribute("aria-valuetext") ?? "").includes("tokens"),
      "…with a spoken value in the unit it plots", chart?.getAttribute("aria-valuetext") ?? "");
    ok(Number(chart?.getAttribute("aria-valuemax")) === n,
      "…over every step", chart?.getAttribute("aria-valuemax") ?? "");

    const before = api().pos;
    chart?.focus();
    chart?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    await until(() => api().pos !== before, 60);
    ok(api().pos === before + 1, "the chart selects a step with the keyboard", `pos=${api().pos}`);

    // The canvas has a text equivalent that is a control, not a caption.
    const alt = document.querySelector<HTMLElement>(".alt-table .details-toggle");
    ok(!!alt && /as a table/i.test(alt.textContent ?? ""), "the chart can be read as a table");
    alt?.click();
    await until(() => !!document.querySelector(".alt-table table"), 60);
    const rows = document.querySelectorAll(".alt-table tbody tr").length;
    ok(rows > 4, "…with rows in it", `${rows} rows`);
    ok(document.querySelectorAll(".alt-table tbody button").length === rows,
      "…and each row selects that step");
    alt?.click();

    const body = (document.querySelector(".context-view")?.textContent ?? "");
    ok(/Largest observed increase/.test(body), "the largest increase is named as observed", "");
    ok(/reported/.test(body) && /not necessarily the step that caused it/.test(body),
      "…and separated from a claim about what caused it");
    ok(/Compactions/.test(body), "compactions are here");
    ok(/Wall clock/.test(body) && /Active/.test(body) && /Idle gaps/.test(body),
      "…and so is the elapsed-time analysis the old second rail carried");
    ok(!!document.querySelector(".time-track"),
      "…including the real-time axis, so an idle gap is still a gap");
  }

  // ---- the position rail --------------------------------------------------
  {
    await need("the position rail");
    /**
     * The rail, looked up each time rather than held.
     *
     * Holding it was the same mistake as holding the api object: `need` may
     * reload the demo, which remounts Replay, and a node captured before that
     * is detached and answers about a run that is no longer on screen.
     */
    const rail = () => document.querySelector<HTMLElement>(".replay-rail .track-hit");
    ok(!!rail(), "Replay keeps a position rail");
    ok(rail()?.getAttribute("role") === "slider", "…with slider semantics");
    ok(Number(rail()?.getAttribute("aria-valuemax")) === n,
      "…whose range matches the parsed step count",
      `aria-valuemax=${rail()?.getAttribute("aria-valuemax")} steps=${n}`);
    ok(Math.round(document.querySelector(".replay-rail .track")?.getBoundingClientRect().height ?? 0) <= 48,
      "…and it is a strip rather than a second chart",
      `${Math.round(document.querySelector(".replay-rail .track")?.getBoundingClientRect().height ?? 0)}px`);

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
  }

  // ---- keyboard -----------------------------------------------------------
  {
    await need("keyboard");
    /**
     * Press a key at the playhead and wait for the playhead to move.
     *
     * Waiting for the *change* rather than for the expected value keeps the
     * assertion's teeth: it still fails, with the value in the note, when the
     * key lands somewhere else. Waiting a fixed number of frames kept nothing.
     */
    const keyMoves = async (k: string, opts: KeyboardEventInit = {}) => {
      const from = api().pos;
      trackKey(k, opts);
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

    const view = api().view!;
    const firstFail = view.steps.findIndex((s) => s.err);
    ok(firstFail >= 0, "the demo tape contains at least one failed step", String(firstFail));
    await keyMoves("n");
    ok(api().pos === firstFail, "n jumps to the next failed step",
      `pos=${api().pos} expected ${firstFail}`);
    const secondFail = view.steps.findIndex((s, i) => i > firstFail && s.err);
    ok(secondFail >= 0, "…and there is a second one to come back from", String(secondFail));
    await keyMoves("n");
    await keyMoves("p");
    ok(api().pos === firstFail, "p jumps back to the previous failed step", `pos=${api().pos}`);
  }

  // ---- the step list says what each step is -------------------------------
  {
    await need("the step list says what each step is");
    const list = document.querySelector(".step-list");
    ok(!!list, "the left column is a list of steps");
    ok(list?.getAttribute("role") === "listbox", "…with listbox semantics");

    const rows = [...document.querySelectorAll(".step-row")];
    ok(rows.length > 0 && rows.length < n + 6, "…virtualised rather than all at once",
      `${rows.length} rows for ${n} steps`);

    const labels = rows.map((r) => (r.querySelector(".step-label")?.textContent ?? "").trim());
    ok(labels.every((l) => l.length > 0), "every row says what its step is");
    ok(labels.some((l) => /^Tool call · /.test(l)),
      "…in task language, with the tool named", labels.slice(0, 4).join(" | "));
    ok(labels.some((l) => /^User message/.test(l)) || labels.some((l) => /^Assistant response/.test(l)),
      "…and a turn is called a turn rather than a role", labels.slice(0, 4).join(" | "));
    ok(rows.every((r) => (r.querySelector(".step-num")?.textContent ?? "").trim().length > 0),
      "every row carries its own number");

    // The selected row is marked by more than colour, and the list scrolls to
    // it rather than leaving the reader to find it.
    await goTo(0);
    const sel = document.querySelector(".step-row-on");
    ok(!!sel && sel.getAttribute("aria-selected") === "true",
      "the selected row is marked to a screen reader too");

    // A tool result does not carry its tool's name; the list resolves it.
    const view = api().view!;
    const resultAt = view.steps.findIndex((s) => s.kind === "tool-result");
    ok(resultAt > 0, "the demo has a tool result", String(resultAt));
    await goTo(resultAt);
    const onRow = (document.querySelector(".step-row-on .step-label")?.textContent ?? "").trim();
    ok(/^Tool result · /.test(onRow), "a tool result names the tool it answers", onRow);

    // Failure is a word as well as a colour.
    const failAt = view.steps.findIndex((s) => s.err);
    await goTo(failAt);
    const failRow = (document.querySelector(".step-row-on")?.textContent ?? "");
    ok(/Failed/.test(failRow), "a failed step says so in the list", failRow.slice(0, 60));
  }

  // ---- the messages mode is the array, not a chat log ---------------------
  {
    await need("the messages mode is the array, not a chat log");
    await click(".left-head .seg", /^messages$/i, "switch to Messages");
    await until(() => api().leftMode === "messages" && !!document.querySelector(".messages"), 120);
    ok(api().leftMode === "messages", "the left column switches to the messages array");

    const count = (document.querySelector(".messages-count")?.textContent ?? "").trim();
    ok(/of \d+ entries at this step/.test(count), "it says how much of the array exists yet", count);

    // Grouping is the point: an assistant turn written as several lines is one
    // entry, and the blocks inside it map back to steps.
    await goTo(12);
    const cur = document.querySelector(".entry-now");
    ok(!!cur, "the entry holding the playhead is marked");
    const blocks = cur?.querySelectorAll(".blk").length ?? 0;
    ok(blocks >= 1, "…and is expanded to its blocks", `${blocks} blocks`);
    const blkIdx = [...(cur?.querySelectorAll(".blk-i") ?? [])].map((e) => (e.textContent ?? "").trim());
    ok(blkIdx.length === blocks && blkIdx.every((x) => x.length > 0),
      "each block carries the step number it is", blkIdx.join(","));

    // Selecting a block moves the playhead to that step.
    const target = cur?.querySelectorAll<HTMLElement>(".blk")[blocks - 1];
    const want = Number((target?.querySelector(".blk-i")?.textContent ?? "0").replace(/\D/g, ""));
    target?.click();
    await until(() => api().pos + 1 === want, 120);
    ok(api().pos + 1 === want, "selecting a block moves the playhead to that step",
      `pos=${api().pos + 1} wanted ${want}`);

    // Follow playhead is a control, not a behaviour you cannot turn off.
    const follow = document.querySelector<HTMLInputElement>(".messages-head input[type=checkbox]");
    ok(!!follow && follow.checked, "the list follows the playhead by default");
    ok(!!follow?.closest("label")?.textContent?.trim(), "…and the control has a visible name");

    await click(".left-head .seg", /^steps$/i, "switch back to Steps");
    await until(() => api().leftMode === "steps", 120);
  }

  // ---- record data names what it is ---------------------------------------
  {
    await need("record data names what it is");
    await goTo(3);
    await click(".tabs .tab", /^record data$/i, "open Record data");
    await until(() => api().tab === "record", 120);
    const body = () => document.querySelector(".detail-panel")?.textContent ?? "";
    await until(() => /Raw record/.test(body()) && !/Reading the line back/.test(body()), 240);

    ok(/Record type/.test(body()), "the record's own type is shown");
    ok(/Parsed record/.test(body()), "the projection is labelled as a projection");
    ok(/this application’s projection|this application's projection/.test(body()),
      "…in those words, so it cannot be mistaken for the file");
    ok(/Raw record/.test(body()), "the raw record has its own section");
    // The demo is a .tape.json, which has no original line. Saying so is the
    // assertion: a re-serialised projection presented as the source would be
    // exactly the lie the two names exist to prevent.
    ok(/there is no original line to show/i.test(body()),
      "…and a tape says it has no original line rather than inventing one",
      body().slice(body().indexOf("Raw record"), body().indexOf("Raw record") + 180));
    ok(/Messages array/.test(body()) && /entry \d+ of \d+/.test(body()),
      "the step's place in the array is on this page");
  }

  // ---- a report you can paste ---------------------------------------------
  {
    await need("a report you can paste");
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

  // ---- the export menu says what each action does -------------------------
  {
    await need("the export menu says what each action does");
    const trigger = [...document.querySelectorAll<HTMLElement>(".menu-trigger")]
      .find((b) => /^export/i.test((b.textContent ?? "").trim()));
    ok(!!trigger, "there is an Export menu");
    ok(trigger?.getAttribute("aria-haspopup") === "menu", "…announced as a menu");
    trigger?.click();
    await until(() => document.querySelectorAll('[role="menuitem"]').length > 0, 90);
    const items = [...document.querySelectorAll('[role="menuitem"]')]
      .map((e) => (e.querySelector(".menu-item-label")?.textContent ?? "").trim());
    ok(items.includes("Copy Markdown summary"),
      "the report action says it copies Markdown", items.join(" | "));
    ok(items.includes("Download redacted tape"),
      "…and the export action says it downloads a redacted tape", items.join(" | "));
    ok(items.every((t) => !/^report$/i.test(t)),
      "…and nothing is called something that could mean either", items.join(" | "));
    const notes = [...document.querySelectorAll(".menu-item-note")].map((e) => (e.textContent ?? "").trim());
    ok(notes.some((t) => /no message text/.test(t)),
      "the menu says what the summary does not contain", notes.join(" | "));
    shortcut("Escape");
    await until(() => document.querySelectorAll('[role="menuitem"]').length === 0, 60);
  }

  // ---- opening a file the reader cannot use -------------------------------
  //
  // Six states, all of which a person reaches by accident, and one of which
  // was silently broken until somebody tried it: resetting the input so that
  // choosing the *same* file twice fires `change` also empties the `FileList`,
  // which is live — so a reference captured a line earlier emptied with it and
  // every choice looked like a cancelled picker.
  {
    await need("opening a file the reader cannot use");

    /** Hand the dialog a set of files, the way the picker does. */
    const offer = async (files: File[]) => {
      await click(".shell-bar button", /open session/i, "open the session dialog");
      if (!(await until(() => !!document.querySelector(".dialog input[type=file]"), 120))) {
        throw new Error("the Open session dialog has no file control");
      }
      const input = document.querySelector<HTMLInputElement>(".dialog input[type=file]")!;
      const dt = new DataTransfer();
      for (const f of files) dt.items.add(f);
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const dialogText = () => document.querySelector(".dialog")?.textContent ?? "";

    // A dialog opened over a loaded session says what opening a file will do
    // to it.
    await click(".shell-bar button", /open session/i, "open the session dialog");
    await until(() => !!document.querySelector(".dialog"), 120);
    ok(/replaces the session on screen/.test(dialogText()),
      "the dialog says a file will replace what is open");
    ok(/Cancelling leaves it exactly as it is/.test(dialogText()),
      "…and that cancelling will not");

    // Cancelling is a decision, not a fault.
    await offer([]);
    await until(() => /No file chosen/.test(dialogText()), 120);
    ok(/No file chosen. Nothing has changed./.test(dialogText()),
      "a cancelled picker gets a quiet line", dialogText().slice(0, 60));
    ok(!document.querySelector(".dialog .note-error"), "…and no error");
    ok(api().view?.steps.length === DEMO_STEPS, "…and the session is untouched");

    await offer([new File(["hello"], "notes.txt", { type: "text/plain" })]);
    await until(() => !!document.querySelector(".dialog .note-error"), 180);
    ok(/not a supported file/.test(dialogText()),
      "an unsupported extension is named, not swallowed",
      (document.querySelector(".dialog .note-error")?.textContent ?? "").slice(0, 70));
    ok(/\.jsonl/.test(dialogText()) && /\.tape\.json/.test(dialogText()),
      "…alongside what is supported");

    await offer([new File([], "empty.jsonl", { type: "application/x-ndjson" })]);
    await until(() => /is empty/.test(dialogText()), 180);
    ok(/empty.jsonl is empty/.test(dialogText()),
      "an empty file says it is empty rather than parsing to nothing",
      dialogText().slice(dialogText().indexOf("empty.jsonl"), dialogText().indexOf("empty.jsonl") + 60));

    await offer([new File(["not json\nnor this\n"], "broken.jsonl", { type: "application/x-ndjson" })]);
    await until(() => /looked like a Claude Code transcript/.test(dialogText()), 240);
    ok(/Nothing in broken.jsonl looked like a Claude Code transcript record/.test(dialogText()),
      "an unparseable file says what it was not");
    ok(!!document.querySelector(".dialog .note-more"),
      "…with what the reader actually said behind a control");
    ok(api().view?.steps.length === DEMO_STEPS,
      "…and four bad files later the session on screen is still the one you had");

    // A real one, twice. The second pick is the one the live-FileList bug ate.
    const t0 = Date.parse("2026-11-11T09:00:00Z");
    const good = new File([[0, 1, 2].map((i) => JSON.stringify({
      type: "assistant", sessionId: "twice", uuid: "a" + i,
      timestamp: new Date(t0 + i * 1000).toISOString(),
      message: {
        role: "assistant", id: "m" + i, model: "claude-opus-5",
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 * i,
          cache_creation_input_tokens: 0 },
        content: [{ type: "tool_use", id: "t" + i, name: "Bash", input: { cmd: "x" } }],
      },
    })).join("\n")], "twice.jsonl", { type: "application/x-ndjson" });

    await offer([good]);
    await until(() => api().view?.steps.length === 3, 300);
    ok(api().view?.steps.length === 3, "a readable file opens",
      String(api().view?.steps.length ?? 0));
    ok(api().where === "overview", "…on the overview", api().where);
    ok(!document.querySelector(".dialog"), "…and the dialog closes behind it");

    await offer([good]);
    await until(() => !document.querySelector(".dialog"), 300);
    ok(api().view?.steps.length === 3, "…and choosing the same file again opens it again",
      String(api().view?.steps.length ?? 0));
  }

  // ---- delegated work is visible even with no subagent file ---------------
  {
    await need("delegated work is visible even with no subagent file");
    // Not driveable: there is no subagent file on disk in a headless run, and
    // the demo's single delegation is one this block wants a bare tape for.
    api().loadTapeFile(tapeWithDelegation());
    // The next line reads `api().delegations`, so that is what is waited on.
    await until(() => api().delegations.length === 1, 180);
    const dels = api().delegations;
    ok(dels.length === 1, "the Agent call is found as a delegation", `${dels.length}`);
    ok(dels[0].run === null, "…with no run attached");

    await click(".view-tab", /^overview$/i, "look at the overview");
    await until(() => api().where === "overview", 120);
    const notes = (document.querySelector(".notes-block")?.textContent ?? "");
    ok(/not included in this file/.test(notes),
      "the overview says work happened that this file does not contain", notes.slice(0, 90));
    ok(!/no delegated work/i.test(notes),
      "…rather than that no delegated work happened", notes.slice(0, 90));

    await click(".view-tab", /^replay$/i, "go to Replay");
    await until(() => api().where === "replay", 120);
    await goTo(1);
    const panel = document.querySelector(".sec-delegated");
    ok(!!panel, "a delegated step shows the delegated-work section");
    const text = (panel?.textContent ?? "").trim();
    ok(/This delegated run is not included in the file/.test(text),
      "…and says so in the words that are true", text.slice(0, 90));
    ok(/subagents\/agent-/.test(text), "…and says where the work actually lives");
    ok(/drop the/i.test(text) && /agent-\*\.jsonl/.test(text),
      "…and how to supply it", text.slice(-120));
    const tag = (document.querySelector(".step-row-on")?.textContent ?? "");
    ok(/Delegated/.test(tag), "the step list marks the step as a delegation", tag.slice(0, 70));

    await home();
    ok(!document.querySelector(".sec-delegated"), "an ordinary step shows no delegation section");
  }

  // ---- a delegated run can be stepped through -----------------------------
  {
    await need("a delegated run can be stepped through");
    // Not driveable: a nested run needs a subagent file, and there is none in a
    // headless run. The tape and the run are both set directly and say so.
    api().loadTapeFile(tapeWithDelegation());
    await until(() => api().delegations.length === 1, 180);
    // Opening a session lands on the overview, which is the behaviour every
    // other route relies on — so getting to Replay is a click, not an
    // assumption.
    await click(".view-tab", /^replay$/i, "go to Replay");
    await until(() => api().where === "replay" && !!document.querySelector(".step-list"), 180);

    await goTo(1);
    ok(!document.querySelector(".delegated-enter"), "an unloaded delegation offers no way in");

    api().attachSyntheticRun?.();
    await until(() => !!api().delegations[0]?.run && !!document.querySelector(".delegated-enter"), 180);
    ok(!!document.querySelector(".delegated-enter"), "a loaded delegation can be opened");

    await click(".delegated-enter button", /open this delegated run/i, "open the delegated run");
    await until(() => !!document.querySelector(".layer"), 180);
    const wb = document.querySelector(".layer");
    ok(!!wb, "the delegated run opens");
    ok(wb?.getAttribute("role") === "dialog", "…as a dialog");
    ok(!!wb?.querySelector(".step-list"), "…with a step list of its own");
    ok(!!wb?.querySelector(".detail-panel"), "…and its own step panel");
    ok(!wb?.querySelector(".search"), "…and none of the parent's filter");

    const crumbs = (wb?.querySelector(".crumb-trail")?.textContent ?? "");
    ok(/Step \d/.test(crumbs) && /Delegated run/.test(crumbs),
      "a breadcrumb says where this is", crumbs);
    ok(!!wb?.querySelector(".crumbs button"), "…and there is a way back to the parent step");

    const nested = wb?.querySelector<HTMLElement>(".replay-rail .track-hit");
    const before = Number(nested?.getAttribute("aria-valuenow"));
    nested?.focus();
    nested?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
    await until(() => Number(document.querySelector(".layer .replay-rail .track-hit")
      ?.getAttribute("aria-valuenow")) !== before, 90);
    ok(Number(document.querySelector(".layer .replay-rail .track-hit")?.getAttribute("aria-valuenow"))
      === before + 1, "its playhead moves with the arrow keys");

    // The parent's playhead must not have moved while the child had the keys.
    const parentAt = api().pos;
    shortcut("Escape");
    await until(() => !document.querySelector(".layer"), 180);
    ok(!document.querySelector(".layer"), "Escape leaves the delegated run");
    ok(api().pos === parentAt, "…and the parent is on the step it was on",
      `${api().pos} vs ${parentAt}`);
    ok(!!document.querySelector(".sec-delegated"),
      "…looking at the step that delegated");
  }

  // ---- checks -------------------------------------------------------------
  {
    await need("checks");
    const btn = [...document.querySelectorAll<HTMLElement>(".shell-bar button")]
      .find((b) => /^checks/i.test((b.textContent ?? "").trim()));
    ok(!!btn, "the shell offers Checks");
    ok(/failed|passed|not evaluated|No checks/i.test(btn?.textContent ?? ""),
      "…with an outcome on it, not just a number", btn?.textContent ?? "");

    btn?.click();
    await until(() => !!document.querySelector(".drawer"), 180);
    const panel = document.querySelector(".drawer");
    ok(!!panel, "the checks panel opens");
    ok(panel?.getAttribute("role") === "dialog", "…as a dialog");
    ok(/conditions you set/i.test(panel?.textContent ?? ""),
      "…saying these are conditions somebody set rather than a verdict");
    ok(!/certif|guarantee|proves the run/i.test(panel?.textContent ?? ""),
      "…and claiming nothing it cannot");

    const rows = document.querySelectorAll(".check-row").length;
    ok(rows === api().assertions.length && rows > 0, "every check gets a row", String(rows));
    const marks = [...document.querySelectorAll(".outcome")].map((e) => (e.textContent ?? "").trim());
    ok(marks.every((m) => m === "Passed" || m === "Failed" || m === "Not evaluated"),
      "each row says its outcome in words, not by colour alone", marks.join(","));
    ok(document.querySelectorAll(".check-detail").length === rows, "…and each says why");

    // A rule that must fail on the demo, with the offending step linked.
    //
    // Set rather than typed. The panel does let a person change a ceiling, but
    // the assertion below counts *one* failing row, which means replacing the
    // whole set — typing 1 into the existing ceiling leaves the other default
    // rules in place and some of them fail on the demo too.
    api().setRules([{ kind: "max-context", n: 1 }]);
    await until(() => document.querySelectorAll(".check-fail").length === 1, 180);
    ok(document.querySelectorAll(".check-fail").length === 1, "an impossible ceiling fails");
    const go = [...document.querySelectorAll<HTMLElement>(".check-row button")]
      .find((b) => /inspect step/i.test(b.textContent ?? ""));
    ok(!!go, "…and links the offending step", go?.textContent ?? "missing");
    go?.click();
    await until(() => !document.querySelector(".drawer") && api().where === "replay", 180);
    ok(!document.querySelector(".drawer"), "following the link closes the panel");
    ok(api().where === "replay", "…and lands in Replay");
    ok(api().rules.length === 1, "…without losing the rules on the way", String(api().rules.length));

    shortcut("a");
    await until(() => !!document.querySelector(".drawer"), 180);
    // A rule that cannot be tested is not a pass.
    // Not driveable at all: the tool pickers only offer tools that appear in
    // the tape, and a vacuous rule is by definition about one that does not.
    api().setRules([{ kind: "before", first: "NoSuchTool", then: "AlsoMissing" }]);
    await until(() => api().assertions[0]?.vacuous === true
      && document.querySelectorAll(".check-vacuous").length === 1, 180);
    ok(api().assertions[0].vacuous === true, "a check with nothing to check is marked vacuous");
    ok(document.querySelectorAll(".check-vacuous").length === 1,
      "…and shown differently from a pass");
    ok(document.querySelectorAll(".outcome-pass").length === 0,
      "…and is not counted among the passes");
    ok(/Not evaluated/.test(document.querySelector(".outcome")?.textContent ?? ""),
      "…in words");

    // Editing is behind a control, so reading the outcome does not mean
    // reading past four dropdowns to get to it.
    ok(!document.querySelector(".rule-edit"), "the rules are not in edit mode by default");
    await click(".checks-edit .details-toggle", /edit rules/i, "open the editor");
    await until(() => !!document.querySelector(".rule-edit"), 120);
    ok(!!document.querySelector(".rule-edit"), "…and the editor opens when asked for");
    ok(document.querySelectorAll(".rule-add button").length >= 5,
      "all five kinds of check can be added",
      String(document.querySelectorAll(".rule-add button").length));

    // A rule set is a file: it can be written out and read back in.
    const save = [...document.querySelectorAll<HTMLElement>(".drawer button")]
      .find((b) => /save rule set/i.test(b.textContent ?? ""));
    ok(!!save, "the panel can save the current rules as a file");
    const load = document.querySelector<HTMLInputElement>('.drawer input[type="file"]');
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
      && document.querySelectorAll(".check-row").length === 2, 180);
    ok(api().rules.length === 2, "a clean set replaces the rules", String(api().rules.length));
    ok(document.querySelectorAll(".check-row").length === 2, "…and the panel redraws for it");
    ok(!document.querySelector(".problem-list"), "…with nothing to complain about");

    drop(JSON.stringify({ format: "wrong", rules: [{ kind: "nonsense" }] }));
    await until(() => document.querySelectorAll(".problem-list li").length >= 2, 180);
    const said = [...document.querySelectorAll(".problem-list li")].map((e) => (e.textContent ?? "").trim());
    ok(said.length >= 2, "a broken set is reported rather than silently ignored", said.join(" | "));
    ok(said.some((x) => /unknown rule kind/.test(x)), "…naming the rule that was wrong");
    ok(api().rules.length === 2, "…and the rules that were working are left alone");
    ok(/Nothing has been replaced/.test(document.querySelector(".note-error")?.textContent ?? ""),
      "…and the panel says so, so the state is recoverable");

    ok(/exits non-zero/.test(document.querySelector(".drawer")?.textContent ?? ""),
      "the panel says the same checks run outside the browser");

    await click(".drawer-head button", /^close$/i, "close the checks");
    await until(() => !document.querySelector(".drawer"), 180);
    ok(!document.querySelector(".drawer"), "the panel closes");
  }

  // ---- comparing two runs -------------------------------------------------
  {
    await need("comparing two runs");
    shortcut("c");
    await until(() => api().where === "compare" && !!document.querySelector(".view-compare"), 180);
    ok(api().where === "compare", "Compare is a view of its own");
    ok(!!document.querySelector(".view-compare h1"), "…with a heading");
    ok(!!document.querySelector(".shell-views"),
      "…and the other views are still one click away, not behind a modal");

    const lede = (document.querySelector(".view-lede")?.textContent ?? "");
    ok(/tools it called, in order/.test(lede), "the alignment rule is stated before the result", lede);
    ok(/Message contents are not compared/.test(lede),
      "…including that text is never read", lede);
    ok(/positional/i.test(lede), "…and that alignment is positional", lede);

    const sources = [...document.querySelectorAll(".cmp-source-title")].map((e) => (e.textContent ?? "").trim());
    ok(sources.join(",") === "Run A,Run B", "both sources are named", sources.join(","));
    ok(!document.querySelector(".cmp-table"),
      "…and there is no table of zeroes before a second run is chosen");

    // Compare the demo against itself: same tools, same order, and the rule
    // must call that identical without claiming anything about the words.
    await click(".cmp-source-actions button", /use the demo/i, "load the second run");
    await until(() => !!document.querySelector(".cmp-verdict"), 240);

    const verdict = (document.querySelector(".cmp-verdict")?.textContent ?? "").trim();
    ok(/same 9 tools in the same order/.test(verdict),
      "a run compared with itself is identical", verdict);
    ok(/Message contents are not compared/.test(verdict),
      "…and the verdict does not claim the words differed", verdict);
    ok(!/what they said differs/i.test(verdict),
      "…which is the claim this comparison was making and could not support", verdict);

    const rails = document.querySelectorAll(".cmp-rail canvas").length;
    ok(rails === 2, "both runs get a rail", String(rails));
    const scaleNote = document.querySelector(".cmp-scale-note")?.textContent ?? "";
    ok(/share one scale/.test(scaleNote), "…on one shared scale", scaleNote.slice(0, 50));

    // Identical runs have nothing to mark, and must not invent a divergence.
    ok(!document.querySelector(".cmp-at"),
      "no divergence is shown when the runs never diverged");

    await click(".view-compare .tab", /^metrics$/i, "look at the metrics");
    await until(() => !!document.querySelector(".cmp-table"), 120);
    const rows = [...document.querySelectorAll(".cmp-table tbody th")].map((e) => (e.textContent ?? "").trim());
    for (const m of ["Steps", "Tool calls", "Failed steps", "Wall clock", "Active time",
      "Tokens in", "Tokens out", "Peak context", "Compactions"]) {
      ok(rows.includes(m), "the metrics table keeps: " + m);
    }
    const caption = document.querySelector(".cmp-table caption")?.textContent ?? "";
    ok(/Nothing here is a judgement/.test(caption),
      "…and says it is not ranking the two runs", caption);
  }

  // ---- going away and coming back keeps your place ------------------------
  //
  // The whole argument for holding view state above the views. Every row of
  // this block is a way the old modal-over-workbench design lost something.
  {
    await need("going away and coming back keeps your place");
    await goTo(9);
    await click(".left-head .seg", /^messages$/i, "switch to Messages");
    await until(() => api().leftMode === "messages", 120);
    // Expand an entry that is not the current one, so the state is not simply
    // a consequence of where the playhead is.
    const head = document.querySelectorAll<HTMLElement>(".entry-head")[0];
    head?.click();
    await until(() => head?.getAttribute("aria-expanded") === "true", 60);
    const at = api().pos;

    await click(".view-tab", /^compare$/i, "go to Compare");
    await until(() => api().where === "compare", 180);
    ok(!!document.querySelector(".cmp-verdict"),
      "run B is still loaded, so coming back here does not re-read the file");

    await click(".view-tab", /^replay$/i, "come back to Replay");
    await until(() => api().where === "replay", 180);
    ok(api().pos === at, "the step you were on is the step you come back to",
      `${api().pos} vs ${at}`);
    ok(api().leftMode === "messages", "…the list is still in the mode you left it in",
      api().leftMode);
    ok(document.querySelectorAll(".entry-head[aria-expanded=true]").length >= 1,
      "…and the entries you opened are still open");

    await click(".view-tab", /^overview$/i, "go to the overview");
    await until(() => api().where === "overview", 180);
    const back = (document.querySelector(".summary-at")?.textContent ?? "").trim();
    ok(/Returns to step/.test(back), "the overview says where Explore will take you", back);
    await click(".summary-actions button", /explore the session/i, "explore again");
    await until(() => api().where === "replay", 180);
    ok(api().pos === at, "…and it takes you there", `${api().pos} vs ${at}`);

    // All sessions is a neighbour, not a lid.
    await click(".shell-bar button", /all sessions/i, "open the session index");
    await until(() => api().where === "sessions", 180);
    ok(!!document.querySelector(".view-sessions"), "All sessions opens");
    ok(api().tape !== null, "…without closing the session you were reading");
    await click(".view-back", /back to/i, "go back");
    await until(() => api().where === "replay", 180);
    ok(api().where === "replay", "…and going back returns to the view you were in");
    ok(api().pos === at, "…on the same step", `${api().pos} vs ${at}`);

    await click(".left-head .seg", /^steps$/i, "back to Steps");
    await until(() => api().leftMode === "steps", 120);
  }

  // ---- the array delta ----------------------------------------------------
  {
    await need("the array delta");
    await home();
    await click(".detail-panel .details-toggle", /message array change/i, "open the array delta");
    await until(() => document.querySelectorAll(".detail-panel .facts dt").length > 0, 120);
    const rows = () => [...document.querySelectorAll(".detail-panel .fold-body dt")]
      .map((e) => (e.textContent ?? "").trim());
    ok(rows().join(",") === "Appended,Carried,Context,Array so far",
      "the delta reads as a delta rather than a second messages panel", rows().join(","));

    const readDd = () => [...document.querySelectorAll(".detail-panel .fold-body dd")]
      .map((e) => (e.textContent ?? "").trim());
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
    ok(extended !== "", "a step that extends an entry says so rather than claiming a new one",
      extended);
    await home();
  }

  // ---- filtering ----------------------------------------------------------
  {
    await need("filtering");
    const ticksBefore = countPaintedTicks(n);
    const view = api().view!;
    const tools = [...new Set(view.steps.map((x) => x.tool).filter(Boolean))];
    ok(tools.length > 0, "the demo tape calls tools", tools.join(","));

    const note = document.querySelector(".search-note");
    ok(!!note && /Full message bodies are not searched/i.test(note.textContent ?? ""),
      "the search control states what it does not cover", note?.textContent ?? "missing");
    const label = document.querySelector(".search-label");
    ok(!!label && /search summaries/i.test(label.textContent ?? ""),
      "…and is named for what it does search", label?.textContent ?? "missing");
    ok(!!document.querySelector(".replay-left .search"),
      "the search box sits above the list it searches");

    await pickTool(tools[0]);
    await until(() => api().matches !== n, 90);
    const m = api().matches;
    ok(m > 0 && m < n, "filtering to one tool matches some steps but not all", `${m} of ${n}`);

    const shown = document.querySelector(".search-count")?.textContent ?? "";
    ok(shown.includes(String(m)), "the match count is on screen", shown);

    // What is being filtered for is visible without opening anything.
    const chips = [...document.querySelectorAll(".chip-text")].map((e) => (e.textContent ?? "").trim());
    ok(chips.length === 1 && chips[0] === `tool: ${tools[0]}`,
      "the condition in force is a chip, not a state you have to remember", chips.join(" | "));
    ok(!!document.querySelector(".chip-x"), "…and it can be taken off on its own");

    // Dimmed, not deleted: the rail must still carry every step, or the
    // timeline would lie about where the run spent its time.
    ok(Number(document.querySelector(".replay-rail .track-hit")?.getAttribute("aria-valuemax")) === n,
      "filtering does not change the number of steps on the rail");
    const ticksAfter = countPaintedTicks(n);
    if (ticksBefore.usable && ticksAfter.usable) {
      ok(ticksAfter.groups === ticksBefore.groups,
        "filtering dims ticks rather than removing them",
        `${ticksAfter.groups} painted, was ${ticksBefore.groups}`);
    } else {
      skip("filtering dims ticks rather than removing them", ticksAfter.why || ticksBefore.why);
    }
    ok(document.querySelectorAll(".step-row").length > 0,
      "…and the list still shows every step");
    ok(document.querySelectorAll(".step-row-dim").length > 0,
      "…with the ones that do not match marked as such");
    ok([...document.querySelectorAll(".step-row-dim")]
      .some((r) => /Filtered out/.test(r.textContent ?? "")),
      "…in words as well as in weight");

    // The playhead is left alone when it stops matching.
    const stranded = [...api().mask].findIndex((v) => !v);
    ok(stranded >= 0, "some step in the demo does not match", String(stranded));
    await goTo(stranded);
    ok(api().pos === stranded, "a playhead that stops matching is not moved", `pos=${api().pos}`);
    const flag = document.querySelector(".replay-notice");
    ok(!!flag && /outside the current filter/.test(flag.textContent ?? ""),
      "…and it is said in words", flag?.textContent ?? "missing");

    // n now means "next match", not "next failure".
    const wasAt = api().pos;
    trackKey("n");
    await until(() => api().pos !== wasAt, 90);
    ok(api().mask[api().pos] === 1, "n steps to the next match while a filter is active",
      `pos=${api().pos}`);

    await clearFilters();
    await until(() => api().matches === n, 90);
    ok(api().matches === n, "clearing the filter releases the playhead");
    ok(!document.querySelector(".replay-notice"), "the out-of-filter notice is gone once cleared");
    ok(!document.querySelector(".chips"), "…and so are the chips");

    // Search covers previews.
    typeInto(document.querySelector<HTMLInputElement>("input.filter-input")!, tools[0].toLowerCase());
    await until(() => api().matches !== n, 90);
    ok(api().matches > 0, "search matches a tool name", `${api().matches} for "${tools[0]}"`);
    await clearFilters();
    await until(() => api().matches === n, 90);
  }

  // ---- nothing matches, and the page says so ------------------------------
  {
    await need("nothing matches, and the page says so");
    const at = api().pos;
    typeInto(document.querySelector<HTMLInputElement>("input.filter-input")!, "zzz-no-such-thing");
    await until(() => api().matches === 0, 120);
    ok(api().matches === 0, "a query with no matches matches nothing");
    const empty = document.querySelector(".list-empty");
    ok(!!empty, "the list says so rather than going blank");
    ok(/No matching steps/.test(empty?.textContent ?? ""),
      "…in those words", (empty?.textContent ?? "").slice(0, 40));
    ok(/still has \d+ steps/.test(empty?.textContent ?? ""),
      "…and does not claim the session is empty", (empty?.textContent ?? "").slice(0, 120));
    ok(api().pos === at, "the step you were reading is not thrown away", `${api().pos} vs ${at}`);
    ok(!!document.querySelector(".detail-panel .sec-title"),
      "…and its panel is still on screen");
    await clearFilters();
    await until(() => api().matches === n, 120);
    ok(api().matches === n, "clearing from the empty state brings the list back");
  }

  // ---- the filter reaches past the list -----------------------------------
  {
    await need("the filter reaches past the list");
    const view = api().view!;
    const tools = [...new Set(view.steps.map((x) => x.tool).filter(Boolean))];

    await pickTool(tools[0]);
    await until(() => api().matches !== n, 90);
    await click(".left-head .seg", /^messages$/i, "switch to Messages");
    await until(() => api().leftMode === "messages", 120);

    ok(document.querySelectorAll(".entry-hit").length > 0,
      "the messages panel marks entries that match");
    ok([...document.querySelectorAll(".entry-hit")]
      .some((e) => /Match/.test(e.textContent ?? "")),
      "…in words, not only by a border");
    ok(document.querySelectorAll(".entry-miss").length > 0,
      "…and marks the ones that do not, rather than removing them");
    const shownEntries = document.querySelectorAll(".entry").length;
    ok(shownEntries === document.querySelectorAll(".entry-hit, .entry-miss").length,
      "every rendered entry is marked one way or the other", String(shownEntries));

    await click(".left-head .seg", /^steps$/i, "back to Steps");
    await until(() => api().leftMode === "steps", 120);

    // Where the playhead sits among the matches, so a silent n is legible.
    await home();
    const posEl = () => (document.querySelector(".search-count")?.textContent ?? "").trim();
    ok(/on match \d/.test(posEl()) || /not one of them/.test(posEl()),
      "the count says where the playhead sits among the matches", posEl());
    for (let i = 0; i < 200 && !/\(last\)/.test(posEl()); i++) {
      const was = posEl();
      trackKey("n");
      // The readout is what the loop condition reads, so that is what is
      // waited on. Bounded tightly because this runs up to two hundred times.
      await until(() => posEl() !== was, 10);
    }
    ok(/\(last\)/.test(posEl()), "…and says so when the playhead is on the last match", posEl());
    const before = api().pos;
    trackKey("n");
    // Give it a chance to move before asserting that it did not. An assertion
    // about nothing happening that does not wait is an assertion that passes
    // because nothing has rendered yet.
    await until(() => api().pos !== before, 10);
    ok(api().pos === before, "n at the last match does not move the playhead",
      `${before} → ${api().pos} · matches ${api().matches}/${api().view?.steps.length ?? 0}` +
      ` · readout "${posEl()}"`);
    ok(/\(last\)/.test(posEl()), "…and the reason is still on screen", posEl());

    await clearFilters();
    await until(() => api().matches === n, 90);
  }

  // ---- the filter controls take free input --------------------------------
  {
    await need("the filter controls take free input");
    await click(".replay-jumps button", /^filters/i, "open the filters");
    await until(() => !!document.querySelector(".popover"), 120);
    const num = document.querySelector<HTMLInputElement>(".popover input[type=number]");
    ok(!!num, "the size threshold takes any number, not only presets");
    ok(!!num?.getAttribute("list"), "…while still offering common ones");
    typeInto(num!, "1234");
    await until(() => api().filter.minChars === 1234, 90);
    ok(document.querySelector<HTMLInputElement>(".popover input[type=number]")?.value === "1234",
      "…and a number outside the presets is accepted");

    const all = document.querySelectorAll(".tool-opt").length;
    const search = document.querySelector<HTMLInputElement>('.popover input[type="search"]');
    if (all > 6) {
      ok(!!search, "a long tool list carries a search box", `${all} tools`);
    } else {
      ok(!search, "a short tool list does not need one", `${all} tools`);
    }
    ok(document.querySelectorAll(".popover .popover-title").length === 2,
      "the popover is two named groups rather than a row of unlabelled controls");

    await click(".popover-foot button", /^done$/i, "close the filters");
    await until(() => !document.querySelector(".popover"), 120);
    await clearFilters();
    await until(() => api().matches === n, 90);
  }

  // ---- the demo can demonstrate everything --------------------------------
  {
    await need("the demo can demonstrate everything");
    const compactBtn = [...document.querySelectorAll<HTMLButtonElement>(".replay-jumps button")]
      .find((b) => /^compaction/i.test((b.textContent ?? "").trim()));
    ok(!!compactBtn && !compactBtn.disabled,
      "the demo has a compaction, so the jump control is usable",
      compactBtn?.textContent ?? "missing");
    ok(api().delegations.length > 0, "…and a delegation, so the absent-work section has a subject");

    await click(".tabs .tab", /^context$/i, "open the context view");
    await until(() => api().tab === "context", 120);
    const attrib = (document.querySelector(".context-view .note")?.textContent ?? "").trim();
    ok(/fell at the compaction/.test(attrib),
      "…and the compaction branch of the context attribution is demonstrable", attrib);
  }

  // ---- colour is never the only signal ------------------------------------
  {
    await need("colour is never the only signal");
    const view = api().view!;
    const firstFail = view.steps.findIndex((s) => s.err);
    await goTo(firstFail);
    const flag = document.querySelector(".detail-panel .note-error");
    ok(!!flag && /failed/i.test(flag.textContent ?? ""),
      "a failed step states its failure in words in the panel",
      (flag?.textContent ?? "none").slice(0, 60));
    const head = document.querySelector(".step-head-title");
    ok(/Failed/.test(head?.textContent ?? ""), "…and in its heading", head?.textContent ?? "");
    const rowFail = [...document.querySelectorAll(".step-row")]
      .some((e) => /Failed/.test(e.textContent ?? ""));
    ok(rowFail, "…and in the list");

    await click(".left-head .seg", /^messages$/i, "switch to Messages");
    await until(() => api().leftMode === "messages", 120);
    ok([...document.querySelectorAll(".entry-err, .blk-err")].length > 0,
      "a failed block is marked in the messages panel too");
    await click(".left-head .seg", /^steps$/i, "back to Steps");
    await until(() => api().leftMode === "steps", 120);
  }

  // ---- the keys are discoverable and they work ----------------------------
  {
    await need("the keys are discoverable and they work");
    const press = (key: string, opts: KeyboardEventInit = {}) =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...opts }));

    press("?");
    await until(() => !!document.querySelector(".keys-table"), 180);
    ok(!!document.querySelector(".keys-table"), "? opens the shortcut list");
    const listed = document.querySelectorAll(".keys-table tbody tr").length;
    ok(listed >= 10, "…and it lists the keys in one place", String(listed));
    const keyText = (document.querySelector(".keys-table")?.textContent ?? "");
    for (const k of ["n", "p", "Home", "End", "Esc", "/", "PgUp", "PgDn"]) {
      ok(keyText.includes(k), `…including ${k}`);
    }
    ok(/Where/.test(keyText), "…and where each one applies");
    const sheet = document.querySelector(".dialog");
    ok(sheet?.getAttribute("role") === "dialog", "the list is a dialog");
    ok(document.activeElement === sheet, "…and focus moves into it");

    // Tab must not walk out the back of a dialog into the view behind it.
    for (let i = 0; i < 24; i++) {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
      await frame();
      if (i >= 7 && sheet?.contains(document.activeElement)) break;
    }
    ok(document.querySelector(".dialog")?.contains(document.activeElement) === true,
      "Tab stays inside the dialog rather than escaping behind it");

    press("Escape");
    await until(() => !document.querySelector(".keys-table"), 180);
    ok(!document.querySelector(".keys-table"), "Escape closes it");

    // c and a reach the two places they always have.
    press("c");
    await until(() => api().where === "compare", 180);
    ok(api().where === "compare", "c opens the comparison");
    press("Escape");
    await until(() => api().where === "compare", 30);
    ok(api().where === "compare",
      "…and Escape does not close a view, because a view is not a layer");
    await click(".view-tab", /^replay$/i, "back to Replay");
    await until(() => api().where === "replay", 180);

    press("a");
    await until(() => !!document.querySelector(".drawer"), 180);
    ok(!!document.querySelector(".drawer"), "a opens the checks");
    press("Escape");
    await until(() => !document.querySelector(".drawer"), 180);
    ok(!document.querySelector(".drawer"), "Escape closes them");

    // The keys must not fire while typing.
    const box = document.querySelector<HTMLInputElement>("input.filter-input");
    box?.focus();
    box?.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true, cancelable: true }));
    // Nothing is supposed to happen, so there is no consequence to wait for —
    // wait for the page to stop changing instead of guessing at three frames.
    await quiet(() => api().where + document.querySelectorAll(".drawer, .dialog").length);
    ok(api().where === "replay", "the shortcuts do not fire inside a text box", api().where);
    box?.blur();
    await until(() => document.activeElement !== box, 30);

    // / puts the caret in the search box from anywhere.
    document.querySelector<HTMLElement>(".replay-rail .track-hit")?.focus();
    press("/");
    await until(() => document.activeElement === document.querySelector("input.filter-input"), 90);
    ok(document.activeElement === document.querySelector("input.filter-input"),
      "/ jumps to the search box");
    (document.activeElement as HTMLElement)?.blur();
    await until(() => document.activeElement !== box, 30);

    // The list, the rail and the chart each own their arrow keys, so a key
    // pressed in one of them must move the playhead exactly once.
    const listEl = document.querySelector<HTMLElement>(".step-list");
    await home();
    listEl?.focus();
    listEl?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    await until(() => api().pos !== 0, 90);
    ok(api().pos === 1, "an arrow key in the list moves the playhead once, not twice",
      `pos=${api().pos}`);

    ok(!!(await menuOffers(/^help$/i, /keyboard shortcuts/i)),
      "the list is reachable without knowing the key");
  }

  // ---- the session index is honest about what it can see ------------------
  {
    await need("the session index is honest about what it can see");
    await click(".shell-bar button", /all sessions/i, "open the session index");
    await until(() => !!document.querySelector(".view-sessions"), 180);
    const lede = (document.querySelector(".view-sessions .view-lede")?.textContent ?? "");
    ok(/a folder you grant/.test(lede), "it says where its data comes from", lede.slice(0, 80));
    ok(/Nothing is scanned without being asked for/.test(lede),
      "…and does not claim to have looked at your disk", lede);
    ok(/no session title, first message or summary/i.test(lede),
      "…and states what it will never show", lede);

    const routes = [...document.querySelectorAll(".route-title")].map((e) => (e.textContent ?? "").trim());
    ok(routes.length === 2, "there are two ways in", routes.join(" | "));
    ok(routes[0] === "In this browser", "…the one that needs no server first", routes.join(" | "));

    // The helper route's copy depends on where the page is served from, and
    // both branches have to be true wherever this runs. The suite runs on
    // 127.0.0.1, so it is the local branch that is on screen here; the
    // deployed wording is asserted statically in verify.mjs, which can read
    // the source of the branch this run does not take.
    // Which branch of the helper route is on screen depends on where the page
    // is served from, and that is decided after mount so the server and the
    // first client render cannot disagree. Wait for it to be decided.
    const helperText = () => document.querySelectorAll(".route")[1]?.textContent ?? "";
    await until(() => !/Checking what is available/.test(helperText()), 180);
    const helper = helperText();
    ok(/helper/i.test(helper), "the local helper is the second", helper.slice(0, 60));
    ok(/127\.0\.0\.1|loopback/.test(helper),
      "…and says which address it answers on", helper.slice(0, 160));

    await click(".view-back", /back to/i, "go back");
    await until(() => api().where !== "sessions", 180);
  }

  // ---- accessible names and reachability ----------------------------------
  {
    await need("accessible names and reachability");
    const controls = [...document.querySelectorAll<HTMLElement>(
      'button, input, select, textarea, a[href], [role="slider"], [tabindex]',
    )];
    const unreachable = controls.filter((el) => {
      if (el.getAttribute("aria-hidden") === "true") return false;
      if (el.classList.contains("sr-only")) return false;
      // A roving-tabindex group is reached through its container; the members
      // are reached with the arrow keys the container handles.
      if (el.getAttribute("role") === "option") return false;
      if (el.getAttribute("role") === "tab" && el.getAttribute("aria-selected") === "false") return false;
      if (el.getAttribute("role") === "menuitem" || el.getAttribute("role") === "menuitemradio") return false;
      if (el.classList.contains("detail-panel")) return false;
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

    // One h1 per view, and it is not the brand.
    const h1s = [...document.querySelectorAll("h1")].map((e) => (e.textContent ?? "").trim());
    ok(h1s.length === 1, "the view has exactly one first-level heading", h1s.join(" | "));
    ok(!/^AgentTape$/.test(h1s[0] ?? ""), "…and it is not the product name", h1s[0] ?? "");

    // Tabs are tabs to a screen reader, not styled buttons.
    const tabs = [...document.querySelectorAll('[role="tab"]')];
    ok(tabs.length >= 3, "the subviews are a tablist", String(tabs.length));
    ok(tabs.every((t) => !!t.getAttribute("aria-controls")),
      "…and each says which panel it controls");
    ok(document.querySelectorAll('[role="tabpanel"]').length >= 1,
      "…and the panel says which tab it belongs to");
  }

  // ---- reduced motion -----------------------------------------------------
  {
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
  }

  // ---- the page can scroll ------------------------------------------------
  //
  // `overflow: hidden` on the body hid every overflow bug in the application
  // behind a viewport that could not scroll. It is gone, and this is what
  // stops it coming back.
  {
    ok(getComputedStyle(document.body).overflow !== "hidden",
      "the document body is not permanently unscrollable",
      getComputedStyle(document.body).overflow);
    ok(document.documentElement.scrollWidth <= window.innerWidth + 1,
      "…and nothing pushes the page sideways",
      `${document.documentElement.scrollWidth} vs ${window.innerWidth}`);
  }

  // ---- window surface -----------------------------------------------------
  {
    const globals = Object.keys(window).filter((k) => k.startsWith("__agenttape") || k === "__selftest");
    ok(
      globals.every((k) => k === "__agenttape" || k === "__selftest"),
      "only the flagged globals are exposed",
      globals.join(", "),
    );
  }

  // ---- the browser can build the index itself -----------------------------
  {
    await need("the browser can build the index itself");
    const support = await api().pickerSupport();
    ok(["directory-picker", "webkitdirectory", "none"].includes(support),
      "the folder picker is feature-detected, not assumed", support);

    // Two invented transcripts as Files, with the relative paths a folder pick
    // would give them, so the project/session split is exercised too.
    const at = (k: number) => new Date(Date.parse("2026-10-10T09:00:00Z") + k * 1000).toISOString();
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

    // The cache is a place data lands, so it gets the same marker test as every
    // other artefact: nothing a transcript said may reach it.
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

  // ---- the helper's index, if the helper is answering ---------------------
  {
    await need("the helper's index, if the helper is answering");
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
  //
  // Every call below goes through api() rather than a captured reference: the
  // object on window is rebuilt each render, and old closures still point at
  // the previous tape.
  {
    await need("virtualisation on a large tape");
    const BIG = 6000;
    // Not driveable: there is no six-thousand-step file to open in a headless
    // run, and generating one on disk to open through the picker would be a
    // slower way of arriving at the same array.
    api().loadTapeFile(syntheticTape(BIG));
    await until(() => api().view?.steps.length === BIG, 300);
    const big = api().view;
    ok(!!big && big.steps.length === BIG, "the synthetic tape loaded", `${big?.steps.length ?? 0} steps`);

    await click(".view-tab", /^replay$/i, "go to Replay");
    await until(() => !!document.querySelector(".step-list"), 240);
    const listRows = document.querySelectorAll(".step-row").length;
    const listCount = Number(document.querySelector(".step-list-inner")?.getAttribute("data-count") ?? 0);
    ok(listCount === BIG, "the step list knows how long the session is", String(listCount));
    ok(listRows > 0 && listRows < 60, "…and puts a screenful of it in the DOM",
      `${listRows} rows for ${listCount} steps`);

    // The one position that is not reachable by keyboard in reasonable time:
    // six thousand ArrowRights. End would do it, but this block is about the
    // panel at the far end of a large tape rather than about the playhead, so
    // it is set directly and said out loud.
    api().setPos(BIG - 1);
    await until(() => api().pos === BIG - 1, 300);
    await click(".left-head .seg", /^messages$/i, "switch to Messages");
    await until(() => !!document.querySelector(".vlist"), 300);
    const list = document.querySelector(".vlist");
    const rendered = list?.querySelectorAll(".entry").length ?? 0;
    const expected = Number(list?.getAttribute("data-count") ?? 0);
    ok(expected > 1000, "the messages panel believes it has thousands of entries",
      `${expected} entries`);
    ok(rendered > 0 && rendered < 120, "…and is virtualised",
      `${rendered} rows in the DOM for ${expected} entries`);
    const nodes = document.querySelectorAll(".replay-cols *").length;
    ok(nodes < 4000, "the DOM node count stays bounded", `${nodes} nodes`);
  }
}

/** Does a menu offer an item? Opens it, looks, and closes it again. */
async function menuOffers(trigger: RegExp, item: RegExp): Promise<boolean> {
  const find = () => [...document.querySelectorAll<HTMLElement>(".menu-trigger")]
    .find((b) => trigger.test((b.textContent ?? "").trim()));
  if (!(await until(() => !!find(), 90))) return false;
  find()?.click();
  await until(() => document.querySelectorAll('[role="menuitem"]').length > 0, 60);
  const has = [...document.querySelectorAll('[role="menuitem"]')]
    .some((b) => item.test((b.textContent ?? "").trim()));
  shortcut("Escape");
  await until(() => document.querySelectorAll('[role="menuitem"]').length === 0, 60);
  return has;
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
