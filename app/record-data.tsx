"use client";

// Record data: what the file actually says, in the file's own vocabulary.
//
// The naming here is the point. **Parsed record** is this application's
// projection — the fields the indexer kept, with the names it gave them.
// **Raw record** is the line, read back from the same Blob at the same byte
// offsets the index recorded. They are two different things and the panel
// never pretends one is the other: a tape built from a `.tape.json` has no
// original line at all and says so, rather than re-serialising the projection
// and presenting it as the source.
//
// Everything renders as text. A transcript is data this application observes,
// not instructions to it and not markup for the browser.

import { useEffect, useRef, useState } from "react";
import { RAW_RECORD_LIMIT, type RawRecord, type Tape } from "@/lib/format";
import { fmtBytes, fmtClock, fmtDate, fmtInt } from "@/lib/summary";
import { rawDescriptor, stepKindLabel } from "@/lib/labels";
import { LongText } from "./body-view";

type Props = {
  tape: Tape;
  curStep: number;
  shownIndex: (globalIndex: number) => number;
  onSelectStep: (globalIndex: number) => void;
};

export default function RecordData({ tape, curStep, shownIndex, onSelectStep }: Props) {
  const step = tape.steps[curStep];
  const [raw, setRaw] = useState<RawRecord | null | "loading">("loading");
  const token = useRef(0);

  useEffect(() => {
    if (!step) return;
    const mine = ++token.current;
    setRaw("loading");
    let alive = true;
    const id = window.setTimeout(() => {
      if (!alive) return;
      tape.raw(step.i).then((r) => { if (alive && token.current === mine) setRaw(r); });
    }, 120);
    return () => { alive = false; window.clearTimeout(id); };
  }, [tape, step]);

  if (!step) {
    return <div className="pane-body"><p className="empty-line">No step selected.</p></div>;
  }

  // The projection, as the indexer holds it. Written out by hand rather than
  // by JSON.stringify(step) so that the two byte offsets, which are an
  // implementation detail of the reader, are labelled as what they are.
  const parsed: Record<string, unknown> = {
    step: shownIndex(step.i) || step.i + 1,
    globalIndex: step.i,
    kind: step.kind,
    recordType: step.rawType,
    role: step.role,
    blockIndex: step.bi,
    messageId: step.msgId || null,
    toolName: step.tool || null,
    toolUseId: step.toolUseId || null,
    model: step.model || null,
    timestamp: step.ts,
    error: step.err,
    errorReason: step.errWhy || null,
    usage: step.usage,
    contextTokens: step.ctx,
    characters: step.chars,
    entry: step.entry,
    compaction: step.compact,
  };
  if (tape.meta.source === "jsonl") {
    parsed.sourceLine = step.line;
    parsed.byteOffset = step.off;
    parsed.byteLength = step.len;
  }

  const entry = step.entry >= 0 ? tape.entries[step.entry] : undefined;

  return (
    <div className="pane-body">
      <section className="sec">
        <h3 className="sec-title">How this record describes itself</h3>
        <dl className="facts">
          <dt>Record type</dt>
          <dd><code>{step.rawType || "(none)"}</code></dd>
          <dt>Role</dt>
          <dd>
            {step.role ? <code>{step.role}</code> : <span className="dim">none</span>}
            {step.role === "user" && step.kind === "tool-result" && (
              <span className="dim">
                {" "}— a tool result is written with the user role by the API. The list calls it
                a tool result; the record still says what it says.
              </span>
            )}
          </dd>
          <dt>Shown in the list as</dt>
          <dd>{stepKindLabel(step)}{step.tool ? ` · ${step.tool}` : ""}</dd>
          <dt>Identity</dt>
          <dd className="mono-line">{rawDescriptor(step)}</dd>
          <dt>Timestamp</dt>
          <dd>
            {step.ts === null
              ? <span className="dim">none in the record</span>
              : <>{fmtDate(step.ts)} {fmtClock(step.ts)}</>}
            {step.ts !== null && step.ts !== step.t && (
              <span className="dim">
                {" "}— ordered as {fmtClock(step.t)}, because transcripts step backwards and the
                index clamps to a running maximum
              </span>
            )}
          </dd>
          <dt>Messages array</dt>
          <dd>
            {entry ? (
              <>
                entry {fmtInt(step.entry + 1)} of {fmtInt(tape.entries.length)}
                <span className="dim">
                  {" "}· built from steps {fmtInt(shownIndex(entry.from) || entry.from + 1)}–
                  {fmtInt(shownIndex(entry.to) || entry.to + 1)}
                </span>
                {entry.from !== entry.to && (
                  <>
                    {" "}
                    <button
                      type="button"
                      className="btn-link"
                      onClick={() => onSelectStep(entry.from)}
                    >
                      Go to the first block
                    </button>
                  </>
                )}
              </>
            ) : (
              <span className="dim">not part of the array</span>
            )}
          </dd>
        </dl>
      </section>

      <section className="sec">
        <h3 className="sec-title">
          Parsed record
          <span className="sec-count">this application&rsquo;s projection</span>
        </h3>
        <p className="sec-lead">
          The fields the indexer kept, under the names it gave them. Not the file&rsquo;s own
          shape.
        </p>
        <LongText
          text={JSON.stringify(parsed, null, 2)}
          name={`step-${step.i + 1}-parsed`}
          initial={4096}
          resetKey={"parsed-" + step.i}
        />
      </section>

      <section className="sec">
        <h3 className="sec-title">
          Raw record
          {raw && raw !== "loading" && (
            <span className="sec-count">
              line {fmtInt(raw.line)} · {fmtBytes(raw.bytes)}
            </span>
          )}
        </h3>
        {raw === "loading" ? (
          <p className="empty-line">Reading the line back from the file…</p>
        ) : raw === null ? (
          <p className="empty-line">
            This session was opened from a <code>.tape.json</code>, which carries the projection
            and not the transcript. There is no original line to show.
          </p>
        ) : (
          <>
            <p className="sec-lead">
              The line as the writer wrote it, read back from the same bytes the index points at.
              {raw.truncated && (
                <>
                  {" "}Shown to the first {fmtInt(RAW_RECORD_LIMIT)} of {fmtInt(raw.chars)}{" "}
                  characters.
                </>
              )}
            </p>
            <LongText
              text={raw.text}
              name={`step-${step.i + 1}-raw`}
              initial={4096}
              resetKey={"raw-" + step.i}
            />
          </>
        )}
      </section>
    </div>
  );
}
