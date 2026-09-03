"use client";

// The Context subview: how the array grew, and how long it all took.
//
// Two things share this panel because they are two axes over the same run and
// somebody looking at one usually wants the other. The context chart is
// indexed by step order; the time track is indexed by the clock. Keeping them
// apart is deliberate — a single axis that is "mostly step order but stretched
// where there is a gap" is a chart of neither.
//
// The sentence under the chart is the one place in this application most at
// risk of overclaiming, so it is written to the limit of what the index can
// prove. Context is one number per turn, not an inventory of the array, so
// this can say the level never fell back — which is a strong signal — and it
// says which of the two it is doing rather than dressing the inference up.

import type { Step } from "@/lib/format";
import { fmtDuration, fmtInt, fmtTokens, type JumpTrace, type Summary } from "@/lib/summary";
import ContextChart, { ContextTable } from "./context-chart";
import TimeTrack from "./time-track";
import { InfoIcon, WarnIcon } from "./icons";

type Props = {
  /** Steps in view order. */
  steps: Step[];
  pos: number;
  onPos: (k: number) => void;
  summary: Summary;
  trace: JumpTrace | null;
  /** View positions of the compact boundaries. */
  compactions: number[];
  /** View position of the largest observed increase. */
  jumpAt: number;
  shownIndex: (globalIndex: number) => number;
  /** Where the level fell back, numbered the way everything else is. */
  fellAtShown: number;
};

/**
 * What became of the payload the largest increase added.
 *
 * Three outcomes, each labelled with what kind of statement it is: a
 * measurement, a recorded event, or an observation with no recorded cause.
 */
function traceLine(t: JumpTrace | null, fellAtShown: number):
  { text: string; tone: "warning" | "info" } | null {
  if (!t) return null;
  if (t.unknown) {
    return {
      text: "This tape carries no context figures after that step, so what became of the " +
        "payload cannot be traced.",
      tone: "info",
    };
  }
  const turns = `${fmtInt(t.turnsSince)} model turn${t.turnsSince === 1 ? "" : "s"} re-sent it` +
    (t.resent > 0 ? `, ${fmtTokens(t.resent)} of re-reading` : "");
  if (t.fellAt < 0) {
    return {
      text: `Context never fell back below that level in the ${fmtInt(t.stepsSince)} steps that ` +
        `followed, and ${turns}. That is a measurement of the level, not proof that the same ` +
        "payload is still in the array — context is one number per turn, not an inventory.",
      tone: "warning",
    };
  }
  if (t.fellToCompaction) {
    return {
      text: `The level fell at the compaction ${fmtInt(t.stepsSince)} steps later, which the ` +
        `writer recorded. Before that, ${turns}.`,
      tone: "info",
    };
  }
  return {
    text: `Context fell below that level at step ${fmtInt(fellAtShown)}, ${fmtInt(t.stepsSince)} ` +
      `steps later. Nothing in the transcript says why. Before that, ${turns}.`,
    tone: "info",
  };
}

export default function ContextView({
  steps, pos, onPos, summary, trace, compactions, jumpAt, shownIndex, fellAtShown,
}: Props) {
  const s = summary;
  const line = traceLine(trace, fellAtShown);
  const measured = s.peakCtx > 0;

  return (
    <div className="pane-body context-view">
      <section className="sec">
        <h3 className="sec-title">Context size</h3>
        {!measured ? (
          <p className="empty-line">
            No record in this session carries token usage, so context is unknown rather than
            zero. Nothing is drawn here because there is nothing measured to draw.
          </p>
        ) : (
          <>
            <ContextChart
              steps={steps}
              pos={pos}
              onPos={onPos}
              jumpAt={jumpAt}
              jumpBy={s.jumpBy}
              peakCtx={s.peakCtx}
              compactAt={compactions}
              shownIndex={shownIndex}
            />
            <ContextTable steps={steps} onPos={onPos} shownIndex={shownIndex} />
          </>
        )}
      </section>

      {measured && (
        <section className="sec">
          <h3 className="sec-title">Largest observed increase</h3>
          {s.jumpBy > 0 ? (
            <>
              <p className="sec-lead">
                <b>+{fmtTokens(s.jumpBy)}</b> at step{" "}
                <button type="button" className="btn-link" onClick={() => onPos(jumpAt)}>
                  {fmtInt(shownIndex(steps[jumpAt]?.i ?? 0) || jumpAt + 1)}
                </button>
                . Context is written once per model turn, so this is the step where the rise was
                <b> reported</b>, not necessarily the step that caused it: whatever entered the
                array did so at or before this point.
              </p>
              {line && (
                <p className={"note note-" + line.tone}>
                  {line.tone === "warning" ? <WarnIcon /> : <InfoIcon />}
                  <span className="note-text">{line.text}</span>
                </p>
              )}
            </>
          ) : (
            <p className="empty-line">No single step increased context measurably.</p>
          )}
        </section>
      )}

      <section className="sec">
        <h3 className="sec-title">Compactions</h3>
        {compactions.length === 0 ? (
          <p className="empty-line">
            This session was never compacted, as far as the file records.
          </p>
        ) : (
          <>
            <p className="sec-lead">
              {fmtInt(compactions.length)} compact boundar
              {compactions.length === 1 ? "y" : "ies"} recorded. A compaction is the writer
              telling us the array was cut down.
            </p>
            <ul className="jump-list">
              {compactions.map((k) => {
                const st = steps[k];
                const c = st?.compact;
                return (
                  <li key={k}>
                    <button type="button" className="btn btn-sm" onClick={() => onPos(k)}>
                      Step {fmtInt(shownIndex(st?.i ?? 0) || k + 1)}
                    </button>
                    <span className="jump-detail">
                      {c
                        ? `${fmtTokens(c.pre)} → ${fmtTokens(c.post)} · ${fmtTokens(c.dropped)} dropped` +
                          (c.trigger ? ` · trigger ${c.trigger}` : "")
                        : "recorded as a compact boundary"}
                    </span>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </section>

      <section className="sec">
        <h3 className="sec-title">Time</h3>
        <dl className="facts">
          <dt>Wall clock</dt>
          <dd>{s.wallMs ? fmtDuration(s.wallMs) : "not recorded"}</dd>
          <dt>Active</dt>
          <dd>
            {s.activeMs ? fmtDuration(s.activeMs) : "not recorded"}
            <span className="dim"> · every gap over two minutes removed</span>
          </dd>
          <dt>Idle gaps</dt>
          <dd>
            {s.idleGaps
              ? <>{fmtInt(s.idleGaps)} · longest {fmtDuration(s.longestGapMs)}</>
              : "none over two minutes"}
          </dd>
        </dl>
        <p className="sec-lead">
          These two are different numbers because a session gets resumed. The track below is
          real elapsed time, so a gap in it is a gap in the record.
        </p>
        <TimeTrack steps={steps} pos={pos} onPos={onPos} />
      </section>
    </div>
  );
}
