"use client";

// One session, answered in the order somebody asks.
//
// What is this · how big was it · what happened in it that is worth looking at
// · take me there. Everything else — twenty-odd figures that used to be the
// first thing on screen — is below, in a section somebody opens when they want
// it.
//
// Two rules hold this page honest. The sentence under the figures is built
// from counts and nothing else, so it cannot become a claim about whether the
// run went well; and the absence of a recorded failure is written as the
// absence of a recorded failure, never as success.
//
// Note the name. `all-sessions.tsx` is the index of every session on the
// machine; this is the overview *of one*. They were both called "overview"
// for a while and that was one word doing two jobs.

import { useState } from "react";
import type { Tape } from "@/lib/format";
import {
  fmtBytes, fmtDate, fmtDuration, fmtInt, fmtTokens, type Summary,
} from "@/lib/summary";
import type { KeyEvent, RecordNote } from "@/lib/events";
import { CrossIcon, InfoIcon, NextIcon, WarnIcon } from "./icons";

type Props = {
  tape: Tape;
  summary: Summary;
  /** The short list, already chosen and ordered by lib/events.ts. */
  events: KeyEvent[];
  /** All of them, in the same order, for when somebody asks to see the rest. */
  allEvents: KeyEvent[];
  notes: RecordNote[];
  facts: string;
  sourceLabel: string;
  /** What a step is called on screen, so a jump lands on the number it named. */
  shownIndex: (globalIndex: number) => number;
  /** Steps the session was opened at, so a return does not say "step 1". */
  atStep: number;
  visited: boolean;
  onExplore: () => void;
  onEvent: (e: KeyEvent) => void;
  onContext: () => void;
  /** Set for the demo only: one dismissible line suggesting where to start. */
  hint: string;
  onDismissHint: () => void;
};

function Figure({ label, value, tone }: { label: string; value: string; tone?: "error" }) {
  return (
    <div className="figure">
      <span className={"figure-value" + (tone === "error" ? " figure-value-error" : "")}>
        {value}
      </span>
      <span className="figure-label">{label}</span>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

const EVENT_ICON = {
  error: <CrossIcon size={18} />,
  warning: <WarnIcon size={18} />,
  info: <InfoIcon size={18} />,
} as const;

export default function SessionOverview({
  tape, summary, events, allEvents, notes, facts, sourceLabel, shownIndex, atStep, visited,
  onExplore, onEvent, onContext, hint, onDismissHint,
}: Props) {
  const [details, setDetails] = useState(false);
  const [allShown, setAllShown] = useState(false);
  const eventTotal = allEvents.length;
  const rows = allShown ? allEvents : events;
  const s = summary;
  const known = s.input + s.output + s.cacheRead + s.cacheCreate > 0;

  return (
    <main className="view view-overview" id="main">
      <div className="view-inner">
        <header className="view-head">
          <p className="view-eyebrow">
            {sourceLabel}
            {s.firstT > 0 && <> · {fmtDate(s.firstT)}</>}
          </p>
          <h1 className="view-title" tabIndex={-1}>{tape.meta.label || "Untitled session"}</h1>
        </header>

        {hint && (
          <div className="note note-info note-hint" role="status">
            <p className="note-text">{hint}</p>
            <button type="button" className="btn btn-sm" onClick={onDismissHint}>Dismiss</button>
          </div>
        )}

        <section className="summary-card" aria-label="Session at a glance">
          <div className="figures">
            <Figure label="Steps" value={fmtInt(s.conversationSteps)} />
            <Figure label="Tool calls" value={fmtInt(s.toolCalls)} />
            <Figure
              label="Failed tool calls"
              value={fmtInt(s.errors)}
              tone={s.errors > 0 ? "error" : undefined}
            />
          </div>
          <p className="summary-facts">{facts}</p>
          <div className="summary-actions">
            <button type="button" className="btn btn-primary" onClick={onExplore}>
              <span>Explore the session</span>
              <NextIcon />
            </button>
            <span className="summary-at">
              {visited ? `Returns to step ${fmtInt(atStep)}` : "Starts at the first step"}
            </span>
          </div>
        </section>

        {notes.length > 0 && (
          <section className="notes-block" aria-label="What this record does not contain">
            {notes.map((n) => (
              <p className="note note-warning" key={n.kind}>
                <WarnIcon />
                <span className="note-text">{n.text}</span>
              </p>
            ))}
          </section>
        )}

        <section className="events" aria-labelledby="events-title">
          <div className="section-head">
            <h2 id="events-title">Key events</h2>
            {eventTotal > events.length && (
              <button
                type="button"
                className="btn btn-quiet btn-sm"
                aria-expanded={allShown}
                onClick={() => setAllShown((v) => !v)}
              >
                {allShown ? "Show fewer" : `Show all ${fmtInt(eventTotal)} events`}
              </button>
            )}
          </div>

          {rows.length === 0 ? (
            <p className="empty-line">
              {s.errors === 0
                ? "No failed tool calls recorded, and nothing else in this file is flagged. " +
                  "That is what the record says, not a verdict on the work."
                : "Nothing indexed as an event."}
            </p>
          ) : (
            <>
              <ul className="event-list">
                {rows.map((e) => (
                  <li className={"event event-" + e.tone} key={e.kind + ":" + e.step}>
                    <span className="event-icon" aria-hidden>{EVENT_ICON[e.tone]}</span>
                    <span className="event-body">
                      <span className="event-title">{e.title}</span>
                      <span className="event-detail">
                        Step {fmtInt(shownIndex(e.step) || e.step + 1)} — {e.detail}
                      </span>
                    </span>
                    <button
                      type="button"
                      className="btn btn-sm event-go"
                      onClick={() => onEvent(e)}
                    >
                      Inspect step {fmtInt(shownIndex(e.step) || e.step + 1)}
                    </button>
                  </li>
                ))}
              </ul>
              {eventTotal > events.length && (
                <p className="events-more">
                  {allShown
                    ? `All ${fmtInt(eventTotal)} indexed events.`
                    : `Showing ${fmtInt(events.length)} of ${fmtInt(eventTotal)} indexed events, ` +
                      "one of each kind first."}
                </p>
              )}
            </>
          )}
        </section>

        <section className="context-teaser" aria-labelledby="growth-title">
          <div className="section-head"><h2 id="growth-title">Context</h2></div>
          {s.peakCtx === 0 ? (
            <p className="empty-line">
              No record in this file carries token usage, so context is unknown rather than zero.
            </p>
          ) : (
            <p className="teaser-line">
              Context reached <b>{fmtTokens(s.peakCtx)}</b> tokens.{" "}
              {s.jumpBy > 0
                ? <>The largest observed increase was <b>+{fmtTokens(s.jumpBy)}</b> at step{" "}
                  {fmtInt(shownIndex(s.jumpAt) || s.jumpAt + 1)}.</>
                : "No single step increased it measurably."}{" "}
              <button type="button" className="btn-link" onClick={onContext}>
                Open the context view
              </button>
            </p>
          )}
        </section>

        <section className="details-block">
          <button
            type="button"
            className="details-toggle"
            aria-expanded={details}
            onClick={() => setDetails((v) => !v)}
          >
            <span className="details-caret" aria-hidden>{details ? "−" : "+"}</span>
            <span>Session details</span>
            <span className="details-hint">
              timings, tokens, models, the file itself, every tool
            </span>
          </button>

          {details && (
            <div className="details-body">
              <div className="details-grid">
                <dl>
                  <Row label="Wall clock" value={s.wallMs ? fmtDuration(s.wallMs) : "not recorded"} />
                  <Row
                    label="Active time"
                    value={s.activeMs
                      ? <>{fmtDuration(s.activeMs)}<span className="dim"> · gaps over two minutes excluded</span></>
                      : "not recorded"}
                  />
                  <Row
                    label="Idle gaps"
                    value={s.idleGaps
                      ? <>{fmtInt(s.idleGaps)}<span className="dim"> · longest {fmtDuration(s.longestGapMs)}</span></>
                      : "none over two minutes"}
                  />
                  <Row label="First record" value={s.firstT ? `${fmtDate(s.firstT)}` : "no timestamp"} />
                  <Row label="Last record" value={s.lastT ? `${fmtDate(s.lastT)}` : "no timestamp"} />
                  <Row label="Messages-array entries" value={fmtInt(s.turns)} />
                  <Row
                    label="Bookkeeping records"
                    value={s.metaSteps
                      ? <>{fmtInt(s.metaSteps)}<span className="dim"> · hidden from the step list by default</span></>
                      : "none"}
                  />
                </dl>
                <dl>
                  <Row label="Input tokens" value={known ? fmtTokens(s.input) : "unknown"} />
                  <Row label="Cache read" value={known ? fmtTokens(s.cacheRead) : "unknown"} />
                  <Row label="Cache write" value={known ? fmtTokens(s.cacheCreate) : "unknown"} />
                  <Row label="Output tokens" value={known ? fmtTokens(s.output) : "unknown"} />
                  <Row label="Peak context" value={s.peakCtx ? fmtTokens(s.peakCtx) : "unknown"} />
                  <Row
                    label="Largest observed increase"
                    value={s.jumpBy
                      ? <>+{fmtTokens(s.jumpBy)}
                        <span className="dim"> at step {fmtInt(shownIndex(s.jumpAt) || s.jumpAt + 1)}</span></>
                      : "none measurable"}
                  />
                  <Row label="Compactions" value={s.compactAt.length ? fmtInt(s.compactAt.length) : "none"} />
                </dl>
                <dl>
                  <Row label="Models" value={s.models.length ? s.models.join(", ") : "none recorded"} />
                  <Row
                    label="Source"
                    value={tape.meta.source === "jsonl" ? "transcript (.jsonl)" : "tape (.tape.json)"}
                  />
                  <Row
                    label="File"
                    value={tape.meta.bytes
                      ? <>{fmtBytes(tape.meta.bytes)}<span className="dim"> · {fmtInt(tape.meta.lines)} lines</span></>
                      : `${fmtInt(tape.meta.lines)} records`}
                  />
                  <Row
                    label="Unreadable lines"
                    value={tape.meta.badLines ? fmtInt(tape.meta.badLines) : "none"}
                  />
                  <Row
                    label="Writer versions"
                    value={tape.meta.versions.length ? tape.meta.versions.join(", ") : "not recorded"}
                  />
                  <Row
                    label="Redacted"
                    value={tape.meta.redacted ? "yes — structure and counts only" : "no"}
                  />
                </dl>
              </div>

              <h3 className="details-sub">Tools</h3>
              {s.tools.length === 0 ? (
                <p className="empty-line">This session called no tools.</p>
              ) : (
                <table className="data-table tools-table">
                  <thead>
                    <tr>
                      <th scope="col">Tool</th>
                      <th scope="col" className="num">Calls</th>
                      <th scope="col" className="num">Failed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.tools.map((t) => (
                      <tr key={t.name}>
                        <td><code>{t.name}</code></td>
                        <td className="num">{fmtInt(t.count)}</td>
                        <td className={"num" + (t.errors ? " cell-error" : "")}>
                          {t.errors ? fmtInt(t.errors) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
