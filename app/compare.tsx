"use client";

// Two runs, and what is actually being compared.
//
// This was a full-screen modal over the workbench with no way back to context
// and no way to see A while choosing B. It is a view now, next to Overview and
// Replay, which means A stays open behind it and switching back does not
// reload anything.
//
// The rule is on screen before the result, because the result is meaningless
// without it: each run is reduced to the tools it called, in order, and those
// two lists are compared. **Message text is never read.** Two runs of the same
// task differ in almost every word, so comparing text answers "they diverged
// at step 2" every time. The cost of the rule is that alignment is positional,
// and one extra call early in a run shifts everything after it — which the
// panel says out loud rather than presenting a shift as a fork.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Step, Tape } from "@/lib/format";
import {
  buildSpine, compareSpines, realignLine, verdictLine, type Comparison, type SpineEvent,
} from "@/lib/compare";
import { fmtBytes, fmtDuration, fmtInt, fmtTokens, summarise } from "@/lib/summary";
import { isLocal, useHelperSessions, type HelperSession } from "./helper";
import { ctx2d } from "./canvas";
import { FileIcon, PlayIcon } from "./icons";

const PAD = 8;
const H = 36;

const NAMES = ["--chart-tick", "--chart-tick-tool", "--chart-fail", "--chart-warn", "--chart-grid"];
let palette: Record<string, string> | null = null;
function cssVar(name: string): string {
  if (!palette) {
    const css = getComputedStyle(document.documentElement);
    palette = {};
    for (const n of NAMES) palette[n] = css.getPropertyValue(n).trim();
  }
  return palette[name] ?? "";
}

/**
 * One run's rail. Both are drawn against `scale` steps rather than their own
 * length, so the shorter run visibly stops short instead of being stretched to
 * match — normalising each to its own width would make two runs of very
 * different sizes look the same, which is the first thing you want to see.
 */
function Rail({ steps, scale, mark, label }: {
  steps: Step[]; scale: number; mark: number; label: string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);

  const paint = useCallback(() => {
    const el = wrap.current;
    const canvas = cv.current;
    if (!el || !canvas || !steps.length) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = el.clientWidth;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(H * dpr);
    const g = ctx2d(canvas);
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, H);

    const tick = cssVar("--chart-tick") || "#6b7686";
    const tool = cssVar("--chart-tick-tool") || "#4a6bc4";
    const risk = cssVar("--chart-fail") || "#b42318";
    const warn = cssVar("--chart-warn") || "#7a460c";
    const grid = cssVar("--chart-grid") || "#dde4ee";

    const span = Math.max(1, scale);
    const xOf = (i: number) => PAD + ((i + 0.5) * (w - PAD * 2)) / span;

    // how far this run reaches on the shared scale
    g.fillStyle = grid;
    g.fillRect(PAD, H / 2 - 1, Math.max(0, xOf(steps.length - 1) - PAD), 2);

    const y = H / 2;
    let last = "";
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      if (s.err) continue;
      if (s.kind !== last) {
        const col = s.kind === "tool-call" || s.kind === "tool-result" ? tool : tick;
        g.fillStyle = col;
        g.globalAlpha = s.kind === "meta" ? 0.4 : 0.85;
        last = s.kind;
      }
      g.fillRect(xOf(i), y - 6, 1, 12);
    }
    g.globalAlpha = 1;
    g.fillStyle = risk;
    for (let i = 0; i < steps.length; i++) {
      if (steps[i].err) g.fillRect(Math.round(xOf(i)) - 1, y - 8, 2, 16);
    }

    if (mark >= 0) {
      const x = Math.round(xOf(mark)) + 0.5;
      g.strokeStyle = warn;
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(x, 2);
      g.lineTo(x, H - 2);
      g.stroke();
      g.fillStyle = warn;
      g.beginPath();
      g.moveTo(x, 8);
      g.lineTo(x + 4.5, 1);
      g.lineTo(x - 4.5, 1);
      g.closePath();
      g.fill();
    }
  }, [steps, scale, mark]);

  useLayoutEffect(() => { paint(); }, [paint]);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => paint());
    ro.observe(el);
    const onTheme = () => { palette = null; paint(); };
    window.addEventListener("agenttape:theme", onTheme);
    return () => { ro.disconnect(); window.removeEventListener("agenttape:theme", onTheme); };
  }, [paint]);

  return (
    <div className="cmp-rail-row">
      <span className="cmp-rail-label">{label}</span>
      <div className="cmp-rail" ref={wrap} style={{ height: H }}>
        <canvas ref={cv} aria-hidden />
      </div>
    </div>
  );
}

function Side({ e, tape, when }: { e: SpineEvent | null; tape: Tape; when: string }) {
  if (!e) {
    return (
      <div className="cmp-side">
        <h4 className="cmp-side-when">{when}</h4>
        <p className="empty-line">Stopped calling tools here.</p>
      </div>
    );
  }
  const s = tape.steps[e.step];
  return (
    <div className="cmp-side">
      <h4 className="cmp-side-when">{when}</h4>
      <p className="cmp-side-tool"><code>{e.tool}</code></p>
      <dl className="facts">
        <dt>Step</dt><dd>{fmtInt(e.step + 1)}</dd>
        <dt>Payload</dt><dd>{fmtInt(e.chars)} characters</dd>
        <dt>Context</dt><dd>{s && s.ctx ? fmtTokens(s.ctx) : "unknown"}</dd>
        <dt>Outcome</dt>
        <dd className={e.err ? "cell-error" : ""}>{e.err ? "failed" : "returned"}</dd>
      </dl>
    </div>
  );
}

function Delta({ label, a, b, fmt, known }: {
  label: string; a: number; b: number; fmt: (n: number) => string; known?: boolean;
}) {
  const d = b - a;
  if (known === false) {
    return (
      <tr>
        <th scope="row">{label}</th>
        <td className="num dim">unknown</td>
        <td className="num dim">unknown</td>
        <td className="num dim">—</td>
      </tr>
    );
  }
  return (
    <tr>
      <th scope="row">{label}</th>
      <td className="num">{fmt(a)}</td>
      <td className="num">{fmt(b)}</td>
      <td className={"num " + (d === 0 ? "dim" : d > 0 ? "cmp-up" : "cmp-down")}>
        {d === 0 ? "—" : (d > 0 ? "+" : "−") + fmt(Math.abs(d))}
      </td>
    </tr>
  );
}

type Props = {
  a: Tape;
  b: Tape | null;
  onSetB: (t: Tape | null) => void;
  onLoadB: (file: File) => Promise<Tape | null>;
  onLoadBFromHelper: (s: HelperSession) => Promise<Tape | null>;
  onLoadDemo: () => Promise<Tape | null>;
};

type Panel = "tools" | "metrics";

export default function Compare({ a, b, onSetB, onLoadB, onLoadBFromHelper, onLoadDemo }: Props) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [over, setOver] = useState(false);
  const [panel, setPanel] = useState<Panel>("tools");
  const input = useRef<HTMLInputElement>(null);
  const { sessions, probing, asked, failed, probe } = useHelperSessions();
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const run = useCallback(async (load: () => Promise<Tape | null>) => {
    setBusy(true);
    setErr("");
    try {
      const t = await load();
      if (t) onSetB(t);
      else setErr("That file could not be read as a transcript or a tape. Run A is unchanged.");
    } catch (e) {
      setErr((e instanceof Error ? e.message : String(e)) + " — run A is unchanged.");
    } finally {
      setBusy(false);
    }
  }, [onSetB]);

  const sumA = useMemo(() => summarise(a), [a]);
  const sumB = useMemo(() => (b ? summarise(b) : null), [b]);
  const spineA = useMemo(() => buildSpine(a.steps), [a]);
  const spineB = useMemo(() => (b ? buildSpine(b.steps) : []), [b]);
  const cmp: Comparison | null = useMemo(
    () => (b ? compareSpines(spineA, spineB) : null),
    [b, spineA, spineB],
  );

  const scale = Math.max(a.steps.length, b?.steps.length ?? 0);
  const markA = cmp?.a ? cmp.a.step : -1;
  const markB = cmp?.b ? cmp.b.step : -1;
  const usageKnown = !!sumB &&
    sumA.input + sumA.output + sumA.cacheRead > 0 &&
    sumB.input + sumB.output + sumB.cacheRead > 0;

  return (
    <main className="view view-compare" id="main">
      <div className="view-inner">
        <header className="view-head">
          <h1 className="view-title">Compare two runs</h1>
          <p className="view-lede">
            Each run is reduced to the tools it called, in order, and those two lists are
            compared. <b>Message contents are not compared.</b> Alignment is positional: one
            extra call early in a run shifts everything after it.
          </p>
        </header>

        <div className="cmp-sources">
          <section className="cmp-source">
            <h2 className="cmp-source-title">Run A</h2>
            <p className="cmp-source-name">{a.meta.label || "this run"}</p>
            <p className="cmp-source-meta">
              {fmtInt(sumA.conversationSteps)} steps · {fmtInt(sumA.toolCalls)} tool calls
              {a.meta.bytes > 0 && <> · {fmtBytes(a.meta.bytes)}</>}
            </p>
          </section>

          <section className="cmp-source">
            <h2 className="cmp-source-title">Run B</h2>
            {b && sumB ? (
              <>
                <p className="cmp-source-name">{b.meta.label || "second run"}</p>
                <p className="cmp-source-meta">
                  {fmtInt(sumB.conversationSteps)} steps · {fmtInt(sumB.toolCalls)} tool calls
                  {b.meta.bytes > 0 && <> · {fmtBytes(b.meta.bytes)}</>}
                </p>
                <button type="button" className="btn btn-sm" onClick={() => { onSetB(null); setErr(""); }}>
                  Choose a different run
                </button>
              </>
            ) : (
              <>
                <p className="cmp-source-meta">
                  Nothing chosen yet. Pick a second transcript to compare this one against.
                </p>
                <div
                  className={"dropzone dropzone-sm" + (over ? " dropzone-over" : "")}
                  onDragOver={(e) => {
                    if (!e.dataTransfer.types.includes("Files")) return;
                    e.preventDefault();
                    setOver(true);
                  }}
                  onDragLeave={(e) => {
                    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
                    setOver(false);
                  }}
                  onDrop={(e) => {
                    if (!e.dataTransfer.types.includes("Files")) return;
                    e.preventDefault();
                    setOver(false);
                    const f = e.dataTransfer.files?.[0];
                    if (f) void run(() => onLoadB(f));
                  }}
                >
                  <p className="dropzone-line">
                    Drop a <code>.jsonl</code> or <code>.tape.json</code> here
                  </p>
                </div>
                <div className="cmp-source-actions">
                  <button type="button" className="btn btn-primary" disabled={busy}
                    onClick={() => input.current?.click()}>
                    <FileIcon />
                    <span>{busy ? "Reading…" : "Open a transcript"}</span>
                  </button>
                  <button type="button" className="btn" disabled={busy}
                    onClick={() => void run(onLoadDemo)}>
                    <PlayIcon />
                    <span>Use the demo</span>
                  </button>
                  <input ref={input} type="file" accept=".jsonl,.json" className="sr-only"
                    aria-label="Choose the second run"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      e.target.value = "";
                      if (f) void run(() => onLoadB(f));
                    }} />
                </div>

                {mounted && isLocal() && (
                  <div className="helper-list">
                    <div className="helper-row">
                      <span className="helper-state">
                        {probing && "Looking for the local helper…"}
                        {!probing && sessions === null && !failed &&
                          "Local helper — pick a second session from it"}
                        {!probing && failed && "Local helper not running"}
                        {!probing && sessions && `Recent sessions · ${sessions.length}`}
                      </span>
                      {!probing && (sessions === null || failed) && (
                        <button type="button" className="btn btn-sm" onClick={probe}>
                          {asked ? "Look again" : "Look for it"}
                        </button>
                      )}
                    </div>
                    {sessions?.map((s) => (
                      <button type="button" className="session-row" key={s.project + "/" + s.session}
                        disabled={busy}
                        onClick={() => void run(() => onLoadBFromHelper(s))}>
                        <span className="session-proj">{s.project}</span>
                        <span className="session-meta">{s.session.slice(0, 8)}</span>
                        <span className="session-meta">
                          {fmtBytes(s.bytes)} · {fmtInt(s.tools)} tools
                        </span>
                      </button>
                    ))}
                  </div>
                )}
                {err && <p className="note note-error" role="alert"><span className="note-text">{err}</span></p>}
              </>
            )}
          </section>
        </div>

        {b && cmp && sumB && (
          <>
            <p className={"cmp-verdict cmp-verdict-" + cmp.verdict}>
              {verdictLine(cmp)}
            </p>
            {realignLine(cmp) && <p className="cmp-caveat">{realignLine(cmp)}</p>}
            {cmp.verdict === "no-spine" && (
              <p className="cmp-caveat">
                {spineA.length === 0 && spineB.length === 0
                  ? "Neither run called a tool, so there is no sequence to line up."
                  : spineA.length === 0
                    ? "Run A called no tools."
                    : "Run B called no tools."}
              </p>
            )}

            <div className="tabs" role="tablist" aria-label="What to compare">
              <button type="button" role="tab" id="cmp-tab-tools" aria-controls="cmp-panel"
                aria-selected={panel === "tools"} tabIndex={panel === "tools" ? 0 : -1}
                className={"tab" + (panel === "tools" ? " tab-on" : "")}
                onClick={() => setPanel("tools")}
                onKeyDown={(e) => {
                  if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                    e.preventDefault(); setPanel("metrics");
                  }
                }}>
                Tool sequence
              </button>
              <button type="button" role="tab" id="cmp-tab-metrics" aria-controls="cmp-panel"
                aria-selected={panel === "metrics"} tabIndex={panel === "metrics" ? 0 : -1}
                className={"tab" + (panel === "metrics" ? " tab-on" : "")}
                onClick={() => setPanel("metrics")}
                onKeyDown={(e) => {
                  if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                    e.preventDefault(); setPanel("tools");
                  }
                }}>
                Metrics
              </button>
            </div>

            <div className="cmp-panel" id="cmp-panel" role="tabpanel"
              aria-labelledby={panel === "tools" ? "cmp-tab-tools" : "cmp-tab-metrics"}>
              {panel === "tools" ? (
                <>
                  <div className="cmp-rails">
                    <Rail steps={a.steps} scale={scale} mark={markA} label="A" />
                    <Rail steps={b.steps} scale={scale} mark={markB} label="B" />
                    <p className="cmp-scale-note">
                      Both rails share one scale of {fmtInt(scale)} steps, so a shorter run stops
                      short instead of being stretched to fit.
                    </p>
                  </div>

                  {cmp.verdict !== "identical" && cmp.verdict !== "no-spine" && (
                    <div className="cmp-at">
                      <h3 className="sec-title">
                        At tool call {fmtInt(cmp.at + 1)}
                        <span className="sec-count">
                          of {fmtInt(cmp.lenA)} in A, {fmtInt(cmp.lenB)} in B
                        </span>
                      </h3>
                      <div className="cmp-sides">
                        <Side e={cmp.a} tape={a} when="Run A" />
                        <Side e={cmp.b} tape={b} when="Run B" />
                      </div>
                    </div>
                  )}

                  {cmp.verdict === "identical" && (
                    <p className="empty-line">
                      The two tool sequences are the same at every position, so there is no
                      divergence to show.
                    </p>
                  )}
                </>
              ) : (
                <table className="data-table cmp-table">
                  <caption>
                    Counts and durations from each run&rsquo;s own index. Nothing here is a
                    judgement about which run was better.
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">Measure</th>
                      <th scope="col" className="num">A</th>
                      <th scope="col" className="num">B</th>
                      <th scope="col" className="num">B − A</th>
                    </tr>
                  </thead>
                  <tbody>
                    <Delta label="Steps" a={sumA.conversationSteps} b={sumB.conversationSteps} fmt={fmtInt} />
                    <Delta label="Tool calls" a={sumA.toolCalls} b={sumB.toolCalls} fmt={fmtInt} />
                    <Delta label="Failed steps" a={sumA.errors} b={sumB.errors} fmt={fmtInt} />
                    <Delta label="Messages-array entries" a={sumA.turns} b={sumB.turns} fmt={fmtInt} />
                    <Delta label="Wall clock" a={sumA.wallMs} b={sumB.wallMs} fmt={fmtDuration}
                      known={sumA.wallMs > 0 || sumB.wallMs > 0} />
                    <Delta label="Active time" a={sumA.activeMs} b={sumB.activeMs} fmt={fmtDuration}
                      known={sumA.activeMs > 0 || sumB.activeMs > 0} />
                    <Delta
                      label="Tokens in"
                      a={sumA.input + sumA.cacheRead + sumA.cacheCreate}
                      b={sumB.input + sumB.cacheRead + sumB.cacheCreate}
                      fmt={fmtTokens}
                      known={usageKnown}
                    />
                    <Delta label="Tokens out" a={sumA.output} b={sumB.output} fmt={fmtTokens}
                      known={usageKnown} />
                    <Delta label="Peak context" a={sumA.peakCtx} b={sumB.peakCtx} fmt={fmtTokens}
                      known={usageKnown} />
                    <Delta label="Compactions" a={sumA.compactAt.length} b={sumB.compactAt.length}
                      fmt={fmtInt} />
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
      </div>
    </main>
  );
}
