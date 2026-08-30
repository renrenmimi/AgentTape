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
  tape: unknown;
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
  assertions: { pass: boolean; vacuous: boolean; at: number }[];
  rules: unknown[];
  setRules: (r: unknown[]) => void;
};

const NO_FILTER: Filterish = { tools: [], minChars: 0, query: "" };

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
const settle = async (n = 3) => { for (let i = 0; i < n; i++) await frame(); };

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

export async function runSelfTest(): Promise<void> {
  const results: { ok: boolean; label: string; note?: string }[] = [];
  const ok = (cond: boolean, label: string, note?: string) => {
    results.push({ ok: !!cond, label, note });
  };

  const a = api();
  if (!a) {
    report([{ ok: false, label: "window.__agenttape is exposed under the flag" }]);
    return;
  }

  // ---- load the demo ------------------------------------------------------
  if (!a.tape) {
    await a.onDemo();
    await settle(6);
  }
  const view = api().view;
  ok(!!view && view.steps.length > 0, "a tape is loaded", `${view?.steps.length ?? 0} steps`);
  if (!view) { report(results); return; }

  const n = view.steps.length;

  // ---- timeline ----------------------------------------------------------
  const slider = document.querySelector<HTMLElement>(".track-hit");
  ok(!!slider, "the timeline exposes a slider");
  ok(slider?.getAttribute("role") === "slider", "the slider has role=slider");
  ok(
    Number(slider?.getAttribute("aria-valuemax")) === n,
    "slider range matches the parsed step count",
    `aria-valuemax=${slider?.getAttribute("aria-valuemax")} steps=${n}`,
  );

  // Count the ticks the canvas actually painted. Only meaningful while the
  // shapes are far enough apart not to merge, so it is gated on spacing.
  const painted = countPaintedTicks(n);
  if (painted.usable) {
    ok(painted.groups === n, "the canvas painted one tick per step",
      `painted ${painted.groups}, expected ${n}`);
  } else {
    ok(true, "tick count check skipped — ticks overlap at this width", painted.why);
  }

  // ---- keyboard ----------------------------------------------------------
  const key = (k: string, opts: KeyboardEventInit = {}) => {
    slider?.focus();
    slider?.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...opts }));
  };

  api().setPos(0);
  await settle();
  key("ArrowRight");
  await settle();
  ok(api().pos === 1, "ArrowRight advances the playhead", `pos=${api().pos}`);
  key("ArrowRight", { shiftKey: true });
  await settle();
  ok(api().pos === 11, "Shift+ArrowRight advances by ten", `pos=${api().pos}`);
  key("End");
  await settle();
  ok(api().pos === n - 1, "End jumps to the last step", `pos=${api().pos}`);
  key("Home");
  await settle();
  ok(api().pos === 0, "Home jumps to the first step", `pos=${api().pos}`);

  const firstFail = view.steps.findIndex((s) => s.err);
  if (firstFail >= 0) {
    key("n");
    await settle();
    ok(api().pos === firstFail, "n jumps to the next failed step", `pos=${api().pos} expected ${firstFail}`);
    const secondFail = view.steps.findIndex((s, i) => i > firstFail && s.err);
    if (secondFail >= 0) {
      key("n");
      await settle();
      key("p");
      await settle();
      ok(api().pos === firstFail, "p jumps back to the previous failed step", `pos=${api().pos}`);
    }
  } else {
    ok(false, "the demo tape contains at least one failed step");
  }

  // ---- delegated work is visible even with no subagent file ---------------
  {
    api().loadTapeFile(tapeWithDelegation());
    await settle(6);
    const dels = api().delegations;
    ok(dels.length === 1, "the Agent call is found as a delegation", `${dels.length}`);
    ok(dels[0].run === null, "…with no run attached");

    const stat = [...document.querySelectorAll(".stat")]
      .map((e) => (e.textContent ?? "").trim())
      .find((t) => t.startsWith("delegated"));
    ok(!!stat && /not in this file/.test(stat),
      "the header says work happened that this file does not contain", stat ?? "missing");

    api().setPos(1);
    await settle(4);
    ok(!!document.querySelector(".nested-absent"), "a delegated step shows the absent-work panel");
    const note = (document.querySelector(".nested-absent .nested-note")?.textContent ?? "").trim();
    ok(/not in this file/i.test(note), "…and says so in words", note.slice(0, 60));
    ok(/subagents\/agent-/.test(note), "…and says where the work actually lives");
    const chip = [...document.querySelectorAll(".d-kind")].map((e) => (e.textContent ?? "").trim());
    ok(chip.includes("delegated"), "the step detail marks the step as a delegation", chip.join(","));

    const legend = [...document.querySelectorAll(".legend-item")].map((e) => (e.textContent ?? "").trim());
    ok(legend.some((t) => /delegated/.test(t)), "the timeline legend gains a delegation shape",
      legend.join(" | "));

    api().setPos(0);
    await settle(3);
    ok(!document.querySelector(".nested-absent"), "an ordinary step shows no delegation panel");

    await a.onDemo();
    await settle(6);
  }

  // ---- assertions ---------------------------------------------------------
  {
    const strip = [...document.querySelectorAll(".strip-actions button")]
      .map((e) => (e.textContent ?? "").trim());
    ok(strip.some((t) => /assertion/i.test(t)),
      "the header reports whether the run holds its stated expectations", strip.join(" | "));

    api().setAsserting(true);
    await settle(5);
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
    api().setRules([{ kind: "max-context", n: 1 }]);
    await settle(5);
    ok(document.querySelectorAll(".rule-fail").length === 1, "an impossible ceiling fails");
    const go = document.querySelector<HTMLElement>(".rule-go");
    ok(!!go && /^step \d/.test((go.textContent ?? "").trim()),
      "…and links the offending step", go?.textContent ?? "missing");
    go?.click();
    await settle(5);
    ok(!document.querySelector(".asserts"), "following the link closes the panel");
    ok(!!document.querySelector(".track-hit"), "…and lands back on the workbench");

    api().setAsserting(true);
    await settle(4);
    // A rule that cannot be tested is not a pass.
    api().setRules([{ kind: "before", first: "NoSuchTool", then: "AlsoMissing" }]);
    await settle(5);
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
    await settle(6);
    ok(api().rules.length === 2, "a loaded set replaces the rules", String(api().rules.length));
    ok(document.querySelectorAll(".rule").length === 2, "…and the panel redraws for it");
    ok(!document.querySelector(".rule-problems"), "…with nothing to complain about");

    drop(JSON.stringify({ format: "wrong", rules: [{ kind: "nonsense" }] }));
    await settle(6);
    const said = [...document.querySelectorAll(".rule-problems li")].map((e) => (e.textContent ?? "").trim());
    ok(said.length >= 2, "a broken set is reported rather than silently ignored", said.join(" | "));
    ok(said.some((x) => /unknown rule kind/.test(x)), "…naming the rule that was wrong");
    ok(api().rules.length === 2, "…and the rules that were working are left alone");

    ok(/exits non-zero/.test(document.querySelector(".cmp-rule")?.textContent ?? ""),
      "the panel says the same rules run outside the browser");

    document.querySelector<HTMLElement>(".asserts .cmp-head .btn:last-of-type")?.click();
    await settle(4);
    ok(!document.querySelector(".asserts"), "the panel closes");
  }

  // ---- comparing two runs -------------------------------------------------
  {
    api().setComparing(true);
    await settle(4);
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
    await settle(8);

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
    await settle(4);
    ok(!document.querySelector(".cmp"), "the panel closes");
    ok(!!document.querySelector(".track-hit"), "…and leaves the workbench as it was");
  }

  // ---- the context jump is attributed, not just marked --------------------
  {
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
    const rows = () => [...document.querySelectorAll(".delta dt")].map((e) => (e.textContent ?? "").trim());
    api().setPos(0);
    await settle(3);
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
      api().setPos(i);
      await settle(2);
      const d = readDd();
      if (/a block to entry/.test(d[0])) { extended = d[0]; break; }
    }
    ok(extended !== "", "a step that extends an entry says so rather than claiming a new one", extended);
    api().setPos(0);
    await settle(2);
  }

  // ---- filtering ----------------------------------------------------------
  {
    const ticksBefore = countPaintedTicks(n);
    const tools = [...new Set(view.steps.map((x) => x.tool).filter(Boolean))];
    ok(tools.length > 0, "the demo tape calls tools", tools.join(","));

    const note = document.querySelector(".filter-note");
    ok(!!note && /summaries only/i.test(note.textContent ?? ""),
      "the search control states that it covers summaries, not full text",
      note?.textContent ?? "missing");

    api().setFilter({ ...NO_FILTER, tools: [tools[0]] });
    await settle(4);
    const m = api().matches;
    ok(m > 0 && m < n, "filtering to one tool matches some steps but not all", `${m} of ${n}`);

    const shown = document.querySelector(".filter-count")?.textContent ?? "";
    ok(shown.includes(String(m)), "the match count is on screen", shown);

    // Dimmed, not deleted: the rail must still carry every step, or the
    // timeline would lie about where the run spent its time.
    ok(Number(slider?.getAttribute("aria-valuemax")) === n,
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
      api().setPos(stranded);
      await settle(3);
      ok(api().pos === stranded, "a playhead that stops matching is not moved", `pos=${api().pos}`);
      const flag = document.querySelector(".filter-out");
      ok(!!flag && (flag.textContent ?? "").trim().length > 0,
        "…and it is marked out of filter in words", flag?.textContent ?? "missing");

      // n now means "next match", not "next failure".
      api().seekNext(1);
      await settle(3);
      ok(api().mask[api().pos] === 1, "n steps to the next match while a filter is active",
        `pos=${api().pos}`);
    }

    api().setFilter(NO_FILTER);
    await settle(4);
    ok(api().matches === n || !document.querySelector(".filter-out"),
      "clearing the filter releases the playhead");
    ok(!document.querySelector(".filter-out"), "the out-of-filter marker is gone once cleared");

    // Search covers previews.
    const withPreview = view.steps.find((x) => x.tool === tools[0]);
    api().setFilter({ ...NO_FILTER, query: tools[0].toLowerCase() });
    await settle(4);
    ok(api().matches > 0, "search matches a tool name", `${api().matches} for "${tools[0]}"`);
    ok(!!withPreview, "the searched tool exists in the view");
    api().setFilter(NO_FILTER);
    await settle(3);
  }

  // ---- the filter reaches past the timeline -------------------------------
  {
    const tools = [...new Set(view.steps.map((x) => x.tool).filter(Boolean))];

    // The messages panel marks matching entries rather than hiding them.
    api().setFilter({ ...NO_FILTER, tools: [tools[0]] });
    await settle(5);
    ok(document.querySelectorAll(".entry-hit").length > 0,
      "the messages panel marks entries that match");
    ok(document.querySelectorAll(".entry-match").length > 0, "…in words, not only by opacity");
    ok(document.querySelectorAll(".entry-miss").length > 0,
      "…and dims the ones that do not, rather than removing them");
    const shownEntries = document.querySelectorAll(".entry").length;
    ok(shownEntries === document.querySelectorAll(".entry-hit, .entry-miss").length,
      "every rendered entry is marked one way or the other", String(shownEntries));

    // Where the playhead sits among the matches, so a silent n is legible.
    api().setPos(0);
    await settle(3);
    const posEl = () => (document.querySelector(".filter-pos")?.textContent ?? "").trim();
    ok(!!document.querySelector(".filter-pos"), "the filter bar reports the playhead's match position");
    for (let i = 0; i < 200 && !/· last$/.test(posEl()); i++) {
      api().seekNext(1);
      await settle(1);
    }
    ok(/· last$/.test(posEl()), "…and says so when the playhead is on the last match", posEl());
    const before = api().pos;
    api().seekNext(1);
    await settle(2);
    ok(api().pos === before, "n at the last match does not move the playhead");
    ok(/· last$/.test(posEl()), "…and the reason is still on screen", posEl());

    api().setFilter(NO_FILTER);
    await settle(3);
    ok(!document.querySelector(".filter-pos"), "the position readout goes away with the filter");
    ok(document.querySelectorAll(".entry-miss").length === 0, "…and so do the entry marks");
  }

  // ---- the filter controls take free input --------------------------------
  {
    const num = document.querySelector<HTMLInputElement>("input.filter-num");
    ok(!!num && num.type === "number", "the size threshold takes any number, not only presets");
    ok(!!num?.getAttribute("list"), "…while still offering common ones");
    api().setFilter({ ...NO_FILTER, minChars: 1234 });
    await settle(4);
    ok(document.querySelector<HTMLInputElement>("input.filter-num")?.value === "1234",
      "…and a number outside the presets is accepted");
    api().setFilter(NO_FILTER);
    await settle(3);

    const menu = document.querySelector<HTMLDetailsElement>(".tool-menu");
    if (menu) {
      menu.open = true;
      await settle(3);
      const all = document.querySelectorAll(".tool-opt").length;
      const search = document.querySelector<HTMLInputElement>(".tool-menu-search");
      if (all > 6) {
        ok(!!search, "a long tool menu carries a search box", `${all} tools`);
      } else {
        ok(!search, "a short tool menu does not need one", `${all} tools`);
      }
      menu.open = false;
      await settle(2);
    }
  }

  // ---- the demo can demonstrate everything --------------------------------
  {
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
    api().setPos(firstFail);
    await settle();
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
    const press = (key: string, opts: KeyboardEventInit = {}) =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...opts }));

    press("?");
    await settle(4);
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
    for (let i = 0; i < 8; i++) {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
      await settle(1);
    }
    ok(document.querySelector(".sheet")?.contains(document.activeElement) === true,
      "Tab stays inside the dialog rather than escaping behind it");

    press("Escape");
    await settle(4);
    ok(!document.querySelector(".sheet"), "Escape closes it");

    // c and a reach the two overlays, and Escape gets back out of each.
    press("c");
    await settle(5);
    ok(!!document.querySelector(".cmp"), "c opens the comparison");
    ok(document.activeElement === document.querySelector(".cmp"), "…with focus inside it");
    press("Escape");
    await settle(5);
    ok(!document.querySelector(".cmp"), "Escape closes the comparison");

    press("a");
    await settle(5);
    ok(!!document.querySelector(".asserts"), "a opens the assertions");
    press("Escape");
    await settle(5);
    ok(!document.querySelector(".asserts"), "Escape closes them");

    // The keys must not fire while typing.
    const box = document.querySelector<HTMLInputElement>("input.filter-input");
    box?.focus();
    box?.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true, cancelable: true }));
    await settle(3);
    ok(!document.querySelector(".cmp"), "the shortcuts do not fire inside a text box");
    box?.blur();
    await settle(2);

    // / puts the caret in the search box from anywhere.
    document.querySelector<HTMLElement>(".track-hit")?.focus();
    press("/");
    await settle(3);
    ok(document.activeElement === box, "/ jumps to the search box");
    (document.activeElement as HTMLElement)?.blur();
    await settle(2);

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

  // ---- the overview, if the helper is answering ---------------------------
  {
    const reachable = await fetch("http://127.0.0.1:4319/health")
      .then((r) => r.ok)
      .catch(() => false);

    if (!reachable) {
      ok(true, "overview check skipped — the local helper is not running");
    } else {
      const res = await fetch("http://127.0.0.1:4319/overview").then((r) => r.json());
      const rows = res.sessions ?? [];
      ok(Array.isArray(rows) && rows.length > 0, "the helper returns session statistics",
        `${rows.length} sessions`);

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
      ok(stray.length === 0,
        "no session record carries a string but its identifiers and its vocabulary",
        [...new Set(stray)].join(", "));
      ok(rows.every((r: { ctxProfile?: number[] }) => Array.isArray(r.ctxProfile)),
        "every session carries a context profile for its sparkline");
      ok(rows.every((r: { steps?: number }) => typeof r.steps === "number"),
        "…and the counts the table sorts by");
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
  for (let i = 0; i < 60 && api().view?.steps.length !== BIG; i++) await settle(1);
  await settle(2);
  const big = api().view;
  ok(!!big && big.steps.length === BIG, "the synthetic tape loaded", `${big?.steps.length ?? 0} steps`);
  api().setPos(BIG - 1);
  for (let i = 0; i < 60 && api().pos !== BIG - 1; i++) await settle(1);
  await settle(2);
  const list = document.querySelector(".vlist");
  const rendered = list?.querySelectorAll(".entry").length ?? 0;
  const expected = Number(list?.getAttribute("data-count") ?? 0);
  ok(expected > 1000, "the panel believes it has thousands of entries", `${expected} entries`);
  ok(rendered > 0 && rendered < 120, "the messages panel is virtualised",
    `${rendered} rows in the DOM for ${expected} entries`);
  const nodes = document.querySelectorAll(".pane-body *").length;
  ok(nodes < 3000, "the DOM node count stays bounded", `${nodes} nodes`);

  report(results);
}

function report(results: { ok: boolean; label: string; note?: string }[]): void {
  const pass = results.filter((r) => r.ok).length;
  const lines = results.map((r) =>
    (r.ok ? "  ok   " : "  FAIL ") + r.label + (r.note ? "  [" + r.note + "]" : ""),
  );
  const text = `AgentTape self-test — ${pass}/${results.length} passed\n\n` + lines.join("\n");
  (window as unknown as Record<string, unknown>).__selftest = { pass, total: results.length, results };
  document.title = `selftest ${pass}/${results.length}`;
  const pre = document.createElement("pre");
  pre.className = "selftest-report";
  pre.id = "selftest-report";
  pre.textContent = text;
  document.body.appendChild(pre);
  // eslint-disable-next-line no-console
  console.log(text);
}
