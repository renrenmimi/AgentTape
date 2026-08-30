"use client";

// Two runs, side by side, and the point where they stopped agreeing.
//
// The alignment rule is on screen, not buried: the comparison reduces each run
// to the tools it called and compares those lists. Text is never read. Two runs
// of the same task differ in almost every word, so a textual comparison would
// answer "step 2" every time; a tool-name comparison answers the question you
// actually asked, which is where the agent started doing something else.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Step, Tape } from "@/lib/format";
import { buildSpine, compareSpines, realignLine, verdictLine, type Comparison, type SpineEvent } from "@/lib/compare";
import { fmtBytes, fmtDuration, fmtInt, fmtTokens, summarise, type Summary } from "@/lib/summary";
import { isLocal, useHelperSessions, type HelperSession } from "./helper";
import { ctx2d } from "./canvas";

const PAD = 8;
const H = 34;

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * One run's rail. Both rails are drawn against `scale` steps rather than their
 * own length, so the shorter run visibly stops short instead of being stretched
 * to match — which is the first thing you want to see.
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

    const tick = cssVar("--tick") || "#788292";
    const tool = cssVar("--tick-tool") || "#8f86c4";
    const risk = cssVar("--risk") || "#e47777";
    const warn = cssVar("--warn") || "#e3ad58";
    const grid = cssVar("--grid") || "rgba(255,255,255,.07)";

    const span = Math.max(1, scale);
    const xOf = (i: number) => PAD + ((i + 0.5) * (w - PAD * 2)) / span;

    // how far this run reaches on the shared scale
    g.fillStyle = grid;
    g.fillRect(PAD, H / 2 - 1, Math.max(0, xOf(steps.length - 1) - PAD), 2);

    const y = H / 2;
    let last = "";
    g.lineWidth = 1.1;
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      if (s.err) continue;
      if (s.kind !== last) {
        const col = s.kind === "tool-call" || s.kind === "tool-result" ? tool : tick;
        g.fillStyle = col;
        g.globalAlpha = s.kind === "meta" ? 0.4 : 0.8;
        last = s.kind;
      }
      g.fillRect(xOf(i), y - 5, 1, 10);
    }
    g.globalAlpha = 1;
    g.fillStyle = risk;
    for (let i = 0; i < steps.length; i++) {
      if (steps[i].err) g.fillRect(Math.round(xOf(i)) - 1, y - 7, 2, 14);
    }

    if (mark >= 0) {
      const x = Math.round(xOf(mark)) + 0.5;
      g.strokeStyle = warn;
      g.lineWidth = 1.4;
      g.beginPath();
      g.moveTo(x, 2);
      g.lineTo(x, H - 2);
      g.stroke();
      g.fillStyle = warn;
      g.beginPath();
      g.moveTo(x, 8);
      g.lineTo(x + 4, 2);
      g.lineTo(x - 4, 2);
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
    window.addEventListener("agenttape:theme", paint);
    return () => { ro.disconnect(); window.removeEventListener("agenttape:theme", paint); };
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
        <span className="cmp-side-when">{when}</span>
        <p className="cmp-side-none">stopped calling tools here</p>
      </div>
    );
  }
  const s = tape.steps[e.step];
  return (
    <div className="cmp-side">
      <span className="cmp-side-when">{when}</span>
      <b className="cmp-side-tool">{e.tool}</b>
      <dl>
        <dt>step</dt><dd>{fmtInt(e.step + 1)}</dd>
        <dt>payload</dt><dd>{fmtInt(e.chars)} chars</dd>
        <dt>context</dt><dd>{fmtTokens(s ? s.ctx : 0)}</dd>
        <dt>outcome</dt>
        <dd className={e.err ? "cmp-bad" : ""}>{e.err ? "failed" : "returned"}</dd>
      </dl>
    </div>
  );
}

function Delta({ label, a, b, fmt }: {
  label: string; a: number; b: number; fmt: (n: number) => string;
}) {
  const d = b - a;
  return (
    <>
      <dt>{label}</dt>
      <dd>{fmt(a)}</dd>
      <dd>{fmt(b)}</dd>
      <dd className={d === 0 ? "cmp-same" : d > 0 ? "cmp-up" : "cmp-down"}>
        {d === 0 ? "—" : (d > 0 ? "+" : "−") + fmt(Math.abs(d))}
      </dd>
    </>
  );
}

type Props = {
  a: Tape;
  onClose: () => void;
  onLoadB: (file: File) => Promise<Tape | null>;
  onLoadBFromHelper: (s: HelperSession) => Promise<Tape | null>;
  onLoadDemo: () => Promise<Tape | null>;
};

export default function Compare({ a, onClose, onLoadB, onLoadBFromHelper, onLoadDemo }: Props) {
  const [b, setB] = useState<Tape | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const { sessions, probing, asked, failed, probe } = useHelperSessions();

  const run = useCallback(async (load: () => Promise<Tape | null>) => {
    setBusy(true);
    setErr("");
    try {
      const t = await load();
      if (t) setB(t);
      else setErr("That file could not be read as a transcript or a tape.");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

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

  return (
    <div className="cmp" role="dialog" aria-modal="true" aria-label="Compare two runs">
      <div className="cmp-head">
        <span className="eyebrow">compare</span>
        <span className="cmp-name">A · {a.meta.label || "this run"}</span>
        <span className="cmp-vs">vs</span>
        <span className="cmp-name">{b ? `B · ${b.meta.label || "second run"}` : "B · nothing loaded"}</span>
        <span className="spacer" />
        <button type="button" className="btn btn-sm" onClick={onClose}>Close</button>
      </div>

      <div className="cmp-body">
        {!b && (
          <div className="cmp-pick">
            <div
              className={"dropzone" + (over ? " over" : "")}
              onDragOver={(e) => { e.preventDefault(); setOver(true); }}
              onDragLeave={() => setOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setOver(false);
                const f = e.dataTransfer.files?.[0];
                if (f) void run(() => onLoadB(f));
              }}
            >
              Drop the second run here — a <code>.jsonl</code> or a <code>.tape.json</code>
            </div>
            <div className="drop-actions">
              <button type="button" className="btn btn-accent" disabled={busy}
                onClick={() => input.current?.click()}>
                {busy ? "Reading…" : "Choose the second run"}
              </button>
              <button type="button" className="btn" disabled={busy}
                onClick={() => void run(onLoadDemo)}>
                Use the demo tape
              </button>
              <input ref={input} type="file" accept=".jsonl,.json" className="sr-only"
                aria-label="Choose the second run"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void run(() => onLoadB(f));
                }} />
            </div>

            {isLocal() && (
              <div className="sessions">
                <div className="helper-row">
                  <span className="eyebrow">
                    {probing && "Looking for the local helper…"}
                    {!probing && sessions === null && !failed && "Local helper — pick a second session from it"}
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
                    <span className="proj">{s.project}</span>
                    <span className="meta">{s.session.slice(0, 8)}</span>
                    <span className="meta">{fmtBytes(s.bytes)} · {fmtInt(s.lines)} lines · {fmtInt(s.tools)} tools</span>
                    <span className="meta">{fmtDuration(Date.now() - s.mtime)} ago</span>
                  </button>
                ))}
              </div>
            )}
            {err && <div className="err-box">{err}</div>}
          </div>
        )}

        {b && cmp && sumB && (
          <>
            <div className="cmp-rule">
              <span className="cmp-rule-tag">aligned by tool-call sequence</span>
              <p>
                Each run is reduced to the tools it called, in order, and those lists are compared.
                <b> Message text is never read.</b> Two runs of the same task differ in almost every
                word, so comparing text would answer &ldquo;they diverged at step&nbsp;2&rdquo; every
                time. Alignment is <b>positional</b>: an extra call early in one run shifts everything
                after it.
              </p>
            </div>

            <div className={"cmp-verdict cmp-verdict-" + cmp.verdict}>
              <b>{verdictLine(cmp)}</b>
              {realignLine(cmp) && <span className="cmp-caveat">{realignLine(cmp)}</span>}
            </div>

            <div className="cmp-rails">
              <Rail steps={a.steps} scale={scale} mark={markA} label="A" />
              <Rail steps={b.steps} scale={scale} mark={markB} label="B" />
              <p className="cmp-scale-note">
                Both rails share one scale of {fmtInt(scale)} steps, so a shorter run stops short
                instead of being stretched to fit.
              </p>
            </div>

            {cmp.verdict !== "identical" && cmp.verdict !== "no-spine" && (
              <div className="cmp-at">
                <span className="eyebrow">
                  at tool call {fmtInt(cmp.at + 1)} of {fmtInt(cmp.lenA)} / {fmtInt(cmp.lenB)}
                </span>
                <div className="cmp-sides">
                  <Side e={cmp.a} tape={a} when="run A" />
                  <Side e={cmp.b} tape={b} when="run B" />
                </div>
              </div>
            )}

            <div className="cmp-table">
              <dl>
                <dt />
                <dd className="cmp-h">A</dd>
                <dd className="cmp-h">B</dd>
                <dd className="cmp-h">B − A</dd>
                <Delta label="steps" a={sumA.conversationSteps} b={sumB.conversationSteps} fmt={fmtInt} />
                <Delta label="tool calls" a={sumA.toolCalls} b={sumB.toolCalls} fmt={fmtInt} />
                <Delta label="errors" a={sumA.errors} b={sumB.errors} fmt={fmtInt} />
                <Delta label="wall clock" a={sumA.wallMs} b={sumB.wallMs} fmt={fmtDuration} />
                <Delta label="active" a={sumA.activeMs} b={sumB.activeMs} fmt={fmtDuration} />
                <Delta label="tokens in" a={sumA.input + sumA.cacheRead + sumA.cacheCreate}
                  b={sumB.input + sumB.cacheRead + sumB.cacheCreate} fmt={fmtTokens} />
                <Delta label="tokens out" a={sumA.output} b={sumB.output} fmt={fmtTokens} />
                <Delta label="peak context" a={sumA.peakCtx} b={sumB.peakCtx} fmt={fmtTokens} />
              </dl>
            </div>

            <div className="drop-actions">
              <button type="button" className="btn btn-sm" onClick={() => { setB(null); setErr(""); }}>
                Choose a different second run
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
