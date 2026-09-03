"use client";

// The Details subview: what this step is, and what it carried.
//
// The order is the order somebody reads in. What the step is, then its
// content — the tool input, or the text — then the other half of the exchange
// when there is one, then the accounting. The array delta and the metadata are
// under a control each, because they are the answers to a second question and
// were previously between the reader and the first one.
//
// Pairing is stated in four distinguishable ways, because they are four
// different situations: this call returned in 1.2 s · this call has no
// recorded result · this call's result failed · this result answers the call
// at step 6. A single "not found" for the middle two was the old behaviour and
// it hid a cut-off run inside a shrug.

import { useEffect, useMemo, useRef, useState } from "react";
import type { Step, StepBody, Tape } from "@/lib/format";
import { fmtBytes, fmtClock, fmtDate, fmtDuration, fmtInt, fmtTokens } from "@/lib/summary";
import { cumulativeChars, deltaAt } from "@/lib/delta";
import { stepKindLabel } from "@/lib/labels";
import type { Delegation } from "@/lib/subagents";
import NestedRun from "./nested-run";
import { BodyView } from "./body-view";
import { CrossIcon, WarnIcon } from "./icons";

const SETTLE_MS = 120; // how long the playhead must sit still before a body is read

type Props = {
  tape: Tape;
  curStep: number;
  pairs: Map<number, number>;
  onSelectStep: (globalIndex: number) => void;
  shownIndex: (globalIndex: number) => number;
  delegation: Delegation | null;
  onLoadSubagent: (() => void) | null;
  subLoading: boolean;
  subError: string;
  offeredBytes: number;
  onEnterSubagent?: () => void;
  /** Set on a nested run, where the parent's routes do not apply. */
  nested?: boolean;
};

/** Signed, so a context drop across a compaction reads as a drop. */
const signed = (n: number) => (n > 0 ? "+" : n < 0 ? "−" : "") + fmtTokens(Math.abs(n));

function durationBetween(a: Step, b: Step): number {
  if (a.ts !== null && b.ts !== null) return b.ts - a.ts;
  return b.t - a.t;
}

function Disclosure({
  title, hint, children, open, onToggle,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="sec sec-fold">
      <button
        type="button"
        className="details-toggle details-toggle-sm"
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className="details-caret" aria-hidden>{open ? "−" : "+"}</span>
        <span>{title}</span>
        {hint && <span className="details-hint">{hint}</span>}
      </button>
      {open && <div className="fold-body">{children}</div>}
    </div>
  );
}

export default function StepDetail({
  tape, curStep, pairs, onSelectStep, shownIndex,
  delegation, onLoadSubagent, subLoading, subError, offeredBytes, onEnterSubagent, nested,
}: Props) {
  const steps = tape.steps;
  const step = steps[curStep];
  const cum = useMemo(() => cumulativeChars(steps), [steps]);
  const delta = deltaAt(steps, cum, curStep);
  const [body, setBody] = useState<StepBody | null>(null);
  const [mateBody, setMateBody] = useState<StepBody | null>(null);
  const [showDelta, setShowDelta] = useState(false);
  const [showMeta, setShowMeta] = useState(false);
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
      <div className="pane-body">
        <p className="empty-line">No step selected.</p>
      </div>
    );
  }

  const prev = steps[step.i - 1];
  const sincePrev = prev ? step.t - prev.t : 0;
  const isCall = step.kind === "tool-call";
  const isResult = step.kind === "tool-result";
  const pairDur = mate ? Math.abs(durationBetween(isCall ? step : mate, isCall ? mate : step)) : 0;
  const mateFailed = mate ? (isCall ? mate.err : step.err) : false;

  return (
    <div className="pane-body">
      {step.err && (
        <p className="note note-error" role="status">
          <CrossIcon />
          <span className="note-text">
            This step failed — {step.errWhy || "the record carries an error flag with no reason"}.
          </span>
        </p>
      )}

      <section className="sec">
        <h3 className="sec-title">
          {isCall ? "Tool input" : isResult ? "Tool result" : "Content"}
          <span className="sec-count">{fmtInt(step.chars)} characters</span>
        </h3>
        <BodyView
          body={body}
          name={step.tool || step.kind}
          stepIndex={step.i}
          preview={step.preview}
        />
      </section>

      {(isCall || isResult) && (
        <section className="sec">
          <h3 className="sec-title">
            {isCall ? "Result" : "The call this answers"}
          </h3>
          {mate ? (
            <>
              <p className="pair-line">
                <button type="button" className="btn btn-sm" onClick={() => onSelectStep(mate.i)}>
                  Go to step {fmtInt(shownIndex(mate.i) || mate.i + 1)}
                </button>
                {pairDur > 0 && (
                  <span className="pair-meta">took {fmtDuration(pairDur)}</span>
                )}
                <span className={"pair-state" + (mateFailed ? " pair-state-bad" : "")}>
                  {mateFailed ? "the result carries an error" : "returned without an error flag"}
                </span>
              </p>
              <div className="sec-sub">
                <h4 className="sec-subtitle">
                  {isCall ? "What came back" : "What was sent"}
                  <span className="sec-count">{fmtInt(mate.chars)} characters</span>
                </h4>
                <BodyView
                  body={mateBody}
                  name={mate.tool || mate.kind}
                  stepIndex={mate.i}
                  preview={mate.preview}
                />
              </div>
            </>
          ) : isCall ? (
            <p className="note note-warning">
              <WarnIcon />
              <span className="note-text">
                No result for this call is recorded in this transcript. Either the run was cut off
                before it returned, or the answer is in a file this one does not contain.
              </span>
            </p>
          ) : (
            <p className="note note-warning">
              <WarnIcon />
              <span className="note-text">
                No matching call for this result is recorded in this transcript.
              </span>
            </p>
          )}
        </section>
      )}

      {delegation && (
        <NestedRun
          delegation={delegation}
          onLoad={onLoadSubagent}
          loading={subLoading}
          error={subError}
          offeredBytes={offeredBytes}
          onEnter={() => onEnterSubagent?.()}
          nested={!!nested}
        />
      )}

      {delta && (
        <Disclosure
          title="Message array change"
          hint="what this step put in the array, and what it cost"
          open={showDelta}
          onToggle={() => setShowDelta((v) => !v)}
        >
          <dl className="facts">
            <dt>Appended</dt>
            <dd>
              {delta.entry < 0 ? (
                <span className="dim">nothing — this record is not part of the array</span>
              ) : delta.newEntry ? (
                <>entry {fmtInt(delta.entry + 1)}<span className="dim"> · a new {delta.role} message</span></>
              ) : (
                <>a block to entry {fmtInt(delta.entry + 1)}</>
              )}
            </dd>
            <dt>Carried</dt>
            <dd>
              {fmtInt(delta.chars)}<span className="dim"> characters</span>
              {delta.output > 0 && (
                <>{" · "}{fmtTokens(delta.output)}<span className="dim"> output tokens</span></>
              )}
            </dd>
            <dt>Context</dt>
            <dd>
              {fmtTokens(delta.ctxBefore)} → {fmtTokens(delta.ctxAfter)}
              {delta.ctxDelta !== 0 && (
                <b className={delta.ctxDelta > 0 ? "delta-up" : "delta-down"}>
                  {" "}{signed(delta.ctxDelta)}
                </b>
              )}
            </dd>
            <dt>Array so far</dt>
            <dd>
              {fmtInt(Math.max(0, delta.entriesSoFar))}<span className="dim"> entries · </span>
              {fmtInt(delta.charsSoFar)}<span className="dim"> characters</span>
            </dd>
          </dl>
        </Disclosure>
      )}

      <Disclosure
        title="Metadata"
        hint="timing, tokens, model"
        open={showMeta}
        onToggle={() => setShowMeta((v) => !v)}
      >
        <dl className="facts">
          <dt>When</dt>
          <dd>
            {step.ts === null
              ? "this record carries no timestamp"
              : `${fmtDate(step.t)} ${fmtClock(step.t)}`}
            {sincePrev > 0 && (
              <span className="dim"> · {fmtDuration(sincePrev)} after the previous step</span>
            )}
          </dd>
          <dt>Kind</dt>
          <dd>{stepKindLabel(step)}{step.tool ? ` · ${step.tool}` : ""}</dd>
          {step.model && (<><dt>Model</dt><dd>{step.model}</dd></>)}
          <dt>Tokens</dt>
          <dd>
            {step.usage ? (
              <>
                in {fmtTokens(step.usage.input)} · out {fmtTokens(step.usage.output)} · cache read{" "}
                {fmtTokens(step.usage.cacheRead)} · cache write {fmtTokens(step.usage.cacheCreate)}
              </>
            ) : (
              <span className="dim">this record carries no usage — unknown, not zero</span>
            )}
          </dd>
          <dt>Context here</dt>
          <dd>
            {step.ctx
              ? <>{fmtTokens(step.ctx)} tokens in the array</>
              : <span className="dim">unknown</span>}
          </dd>
          {step.compact && (
            <>
              <dt>Compaction</dt>
              <dd>
                {fmtTokens(step.compact.pre)} → {fmtTokens(step.compact.post)} ·{" "}
                {fmtTokens(step.compact.dropped)} dropped
                {step.compact.trigger ? ` · trigger ${step.compact.trigger}` : ""}
              </dd>
            </>
          )}
          <dt>In the file</dt>
          <dd>
            {tape.meta.source === "jsonl"
              ? <>line {fmtInt(step.line)} · {fmtBytes(step.len)}</>
              : <>tape entry {fmtInt(step.i + 1)}</>}
          </dd>
        </dl>
      </Disclosure>
    </div>
  );
}
