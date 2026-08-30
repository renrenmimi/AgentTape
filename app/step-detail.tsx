"use client";

// What is under the playhead, in full.
//
// Bodies are fetched here and nowhere else. A body can be 1.34 MB — the
// largest single line in the probe fixtures — so it is read asynchronously
// from the source Blob and then revealed in bounded windows. "Show all" on a
// megabyte of tool output would put a megabyte of text nodes into the DOM and
// stall the tab, so past a quarter of a megabyte the offer changes to a
// download instead.

import { useEffect, useMemo, useRef, useState } from "react";
import { BODY_WINDOW, INLINE_BODY_LIMIT, type Step, type StepBody, type Tape } from "@/lib/format";
import { fmtBytes, fmtClock, fmtDate, fmtDuration, fmtInt, fmtTokens } from "@/lib/summary";
import { cumulativeChars, deltaAt } from "@/lib/delta";
import type { Delegation } from "@/lib/subagents";
import NestedRun from "./nested-run";
import { KIND_LABEL } from "./glyphs";

const HUGE = 262144; // above this, offer a download rather than a reveal
// Revealed text is emitted in blocks rather than as one text node. A single
// 165k-character node inside a wrapping <pre> costs Chrome a 400 ms layout;
// blocks with content-visibility skip layout entirely while off screen. Splits
// land on newlines so the wrapping is identical to one unbroken node.
const CHUNK_CHARS = 4000;
const SETTLE_MS = 120; // how long the playhead must sit still before a body is read

type Props = {
  tape: Tape;
  curStep: number;
  pairs: Map<number, number>;
  onSelectStep: (globalIndex: number) => void;
  /** What to call a step on screen — its position in the visible view. */
  shownIndex: (globalIndex: number) => number;
  /** Set when this step handed its work to a subagent. */
  delegation: Delegation | null;
  onLoadSubagent: (() => void) | null;
  subLoading: boolean;
  subError: string;
  offeredBytes: number;
  /** True when the playhead is on a step the active filter excludes. */
  outOfFilter: boolean;
  /** Open a loaded delegated run and step through it. */
  onEnterSubagent?: () => void;
};

/** Signed, so a context drop across a compaction reads as a drop. */
const signed = (n: number) => (n > 0 ? "+" : n < 0 ? "−" : "") + fmtTokens(Math.abs(n));

function durationBetween(a: Step, b: Step): number {
  if (a.ts !== null && b.ts !== null) return b.ts - a.ts;
  return b.t - a.t;
}

function BodyView({ body, title, step }: { body: StepBody | null; title: string; step: Step }) {
  const [shown, setShown] = useState(INLINE_BODY_LIMIT);

  useEffect(() => { setShown(INLINE_BODY_LIMIT); }, [step.i]);

  const text = body?.text ?? "";
  const chunks = useMemo(() => {
    const visible = text.slice(0, shown);
    const out: string[] = [];
    let at = 0;
    while (at < visible.length) {
      const hard = Math.min(visible.length, at + CHUNK_CHARS);
      // Prefer the last newline inside the window so the blocks line up with
      // the text's own lines. A body with no newlines in it at all — a
      // minified payload, a single JSON blob — is split at the hard boundary
      // instead; the text already wraps at arbitrary points, so the seam is
      // not visible, and without it the whole body lands in one block and the
      // opt-out below does nothing.
      let end = hard;
      if (hard < visible.length) {
        const nl = visible.lastIndexOf("\n", hard);
        if (nl > at) end = nl + 1;
      }
      out.push(visible.slice(at, end));
      at = end;
    }
    return out;
  }, [text, shown]);

  if (!body) return <p className="placeholder">reading…</p>;

  if (body.placeholder) {
    return (
      <p className="placeholder">
        {step.preview || "[redacted]"} — this tape carries structure only, so the body was
        never written into it.
      </p>
    );
  }

  if (!text) {
    if (body.parts.length) {
      return (
        <p className="placeholder">
          {body.parts.map((p) => `${p.type} · ${fmtBytes(p.chars)}`).join("  ·  ")}
          {" — not decoded"}
        </p>
      );
    }
    return <p className="placeholder">empty</p>;
  }

  const remaining = text.length - shown;
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `step-${step.i + 1}-${title.replace(/\W+/g, "-")}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <pre className={"body" + (shown > INLINE_BODY_LIMIT ? " tall" : "")}>
        {chunks.map((c, i) => (
          <span className="body-chunk" key={i}>{c}</span>
        ))}
        {remaining > 0 ? "\n…" : ""}
      </pre>
      {remaining > 0 && (
        <div className="body-more">
          <span>{fmtInt(remaining)} more characters</span>
          <button type="button" className="btn btn-sm" onClick={() => setShown((s) => s + BODY_WINDOW)}>
            Show {fmtBytes(Math.min(BODY_WINDOW, remaining))} more
          </button>
          {remaining <= HUGE ? (
            <button type="button" className="btn btn-sm" onClick={() => setShown(text.length)}>
              Show all
            </button>
          ) : (
            <button type="button" className="btn btn-sm" onClick={download}>
              Download {fmtBytes(text.length)}
            </button>
          )}
        </div>
      )}
    </>
  );
}

export default function StepDetail({
  tape, curStep, pairs, onSelectStep, shownIndex,
  delegation, onLoadSubagent, subLoading, subError, offeredBytes, outOfFilter, onEnterSubagent,
}: Props) {
  const steps = tape.steps;
  const step = steps[curStep];
  const cum = useMemo(() => cumulativeChars(steps), [steps]);
  const delta = deltaAt(steps, cum, curStep);
  const [body, setBody] = useState<StepBody | null>(null);
  const [mateBody, setMateBody] = useState<StepBody | null>(null);
  const token = useRef(0);

  const mateIdx = step ? pairs.get(step.i) : undefined;
  const mate = mateIdx !== undefined ? steps[mateIdx] : undefined;

  useEffect(() => {
    if (!step) return;
    const mine = ++token.current;
    setBody(null);
    setMateBody(null);
    let alive = true;
    // Wait for the playhead to settle. Dragging across a session passes over
    // every large line in it, and a 1.34 MB line costs more than one frame to
    // slice and parse — enough to be felt as a stutter in the gesture.
    const id = window.setTimeout(() => {
      if (!alive) return;
      tape.body(step.i).then((b) => { if (alive && token.current === mine) setBody(b); });
      if (mateIdx !== undefined) {
        tape.body(mateIdx).then((b) => { if (alive && token.current === mine) setMateBody(b); });
      }
    }, SETTLE_MS);
    return () => { alive = false; window.clearTimeout(id); };
  }, [tape, step, mateIdx]);

  if (!step) {
    return (
      <section className="pane" aria-label="Step detail">
        <div className="pane-head"><h2>Step</h2></div>
        <div className="pane-body"><p className="empty-note" style={{ padding: 14 }}>No step selected.</p></div>
      </section>
    );
  }

  const prev = steps[step.i - 1];
  const sincePrev = prev ? step.t - prev.t : 0;
  const isCall = step.kind === "tool-call";
  const isResult = step.kind === "tool-result";
  const pairDur = mate ? Math.abs(durationBetween(isCall ? step : mate, isCall ? mate : step)) : 0;

  return (
    <section className="pane" aria-label="Step detail">
      <div className="pane-head">
        <h2>Step {fmtInt(shownIndex(step.i) || step.i + 1)}</h2>
        <span className="spacer" />
        <span className="entry-tok">
          {tape.meta.source === "jsonl"
            ? `line ${fmtInt(step.line)} · ${fmtBytes(step.len)}`
            : `entry ${fmtInt(step.entry + 1)}`}
        </span>
      </div>
      <div className="pane-body">
        <div className="detail">
          <div className="d-title">
            <span className="d-kind">{KIND_LABEL[step.kind]}</span>
            {step.tool && <b>{step.tool}</b>}
            {step.err && <span className="d-flag">{step.errWhy || "failed"}</span>}
            {delegation && <span className="d-kind d-kind-accent">delegated</span>}
            {outOfFilter && <span className="d-out">out of filter</span>}
          </div>

          <div className="d-row">
            <span>when</span>
            <span className="d-val">
              {step.ts === null ? "no timestamp" : `${fmtDate(step.t)} ${fmtClock(step.t)}`}
              {sincePrev > 0 && (
                <span style={{ color: "var(--text-3)" }}> · +{fmtDuration(sincePrev)} since previous</span>
              )}
            </span>
          </div>

          <div className="d-row">
            <span>record</span>
            <span className="d-val">
              {step.rawType}
              {step.role ? ` · ${step.role}` : ""}
              {step.model ? ` · ${step.model}` : ""}
            </span>
          </div>

          {step.usage && (
            <div className="d-row">
              <span>tokens</span>
              <span className="d-val">
                in {fmtTokens(step.usage.input)} · out {fmtTokens(step.usage.output)} ·
                {" "}cache read {fmtTokens(step.usage.cacheRead)} · write {fmtTokens(step.usage.cacheCreate)}
              </span>
            </div>
          )}

          <div className="d-row">
            <span>context</span>
            <span className="d-val">{fmtTokens(step.ctx)} tokens in the array here</span>
          </div>

          {step.compact && (
            <div className="d-row">
              <span>compaction</span>
              <span className="d-val">
                {fmtTokens(step.compact.pre)} → {fmtTokens(step.compact.post)} ·
                {" "}{fmtTokens(step.compact.dropped)} dropped · trigger {step.compact.trigger}
              </span>
            </div>
          )}

          {(isCall || isResult) && (
            <div className="d-row">
              <span>{isCall ? "result" : "call"}</span>
              <span className="d-val">
                {mate ? (
                  <>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => onSelectStep(mate.i)}
                    >
                      go to step {fmtInt(shownIndex(mate.i) || mate.i + 1)}
                    </button>
                    {pairDur > 0 && (
                      <span style={{ marginLeft: 8, color: "var(--text-3)" }}>
                        took {fmtDuration(pairDur)}
                      </span>
                    )}
                    {(isCall ? mate.err : step.err) && (
                      <span style={{ marginLeft: 8, color: "var(--risk)" }}>errored</span>
                    )}
                  </>
                ) : (
                  <span style={{ color: "var(--text-3)" }}>not found in this transcript</span>
                )}
              </span>
            </div>
          )}

          {delegation && (
            <NestedRun
              delegation={delegation}
              onLoad={onLoadSubagent}
              loading={subLoading}
              error={subError}
              offeredBytes={offeredBytes}
              onEnter={() => onEnterSubagent?.()}
            />
          )}

          {delta && (
            <div className="delta" aria-label="What this step added to the messages array">
              <span className="eyebrow">array delta</span>
              <dl>
                <dt>appended</dt>
                <dd>
                  {delta.entry < 0 ? (
                    <span className="delta-dim">nothing — this record is not part of the array</span>
                  ) : delta.newEntry ? (
                    <>entry {fmtInt(delta.entry + 1)}<span className="delta-dim"> · {delta.role}</span></>
                  ) : (
                    <>
                      <span className="delta-dim">a block to entry </span>
                      {fmtInt(delta.entry + 1)}
                    </>
                  )}
                </dd>

                <dt>carried</dt>
                <dd>
                  {fmtInt(delta.chars)}<span className="delta-dim"> chars</span>
                  {delta.output > 0 && (
                    <>{" · "}{fmtTokens(delta.output)}<span className="delta-dim"> out</span></>
                  )}
                </dd>

                <dt>context</dt>
                <dd>
                  {fmtTokens(delta.ctxBefore)} → {fmtTokens(delta.ctxAfter)}
                  {delta.ctxDelta !== 0 && (
                    <b className={delta.ctxDelta > 0 ? "delta-up" : "delta-down"}>
                      {" "}{signed(delta.ctxDelta)}
                    </b>
                  )}
                </dd>

                <dt>array now</dt>
                <dd>
                  {fmtInt(Math.max(0, delta.entriesSoFar))}<span className="delta-dim"> entries · </span>
                  {fmtInt(delta.charsSoFar)}<span className="delta-dim"> chars</span>
                </dd>
              </dl>
            </div>
          )}

          <div className="d-sec">
            <div className="d-sec-head">
              <span className="eyebrow">
                {isCall ? "tool input" : isResult ? "tool result" : "body"}
              </span>
              <span className="spacer" />
              <span className="entry-tok">{fmtInt(step.chars)} characters</span>
            </div>
            <BodyView body={body} title={step.tool || step.kind} step={step} />
          </div>

          {mate && (isCall || isResult) && (
            <div className="d-sec">
              <div className="d-sec-head">
                <span className="eyebrow">{isCall ? "tool result" : "tool input"}</span>
                <span className="spacer" />
                <span className="entry-tok">{fmtInt(mate.chars)} characters</span>
              </div>
              <BodyView body={mateBody} title={mate.tool || mate.kind} step={mate} />
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
