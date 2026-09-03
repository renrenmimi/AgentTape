"use client";

// Long text, rendered without stalling the tab.
//
// A single line in the probe fixtures reaches 1.34 MB. Three rules come out of
// that, and they are the whole of this file.
//
// Reveal in bounded windows, never all at once — "show all" on a megabyte puts
// a megabyte of text nodes in the DOM. Past a quarter of a megabyte the offer
// changes from revealing to downloading, because at that size the honest
// answer is a file.
//
// Emit the revealed part in blocks rather than as one text node: a single
// 165k-character node inside a wrapping <pre> costs Chrome a 400 ms layout,
// and blocks with content-visibility skip layout entirely while off screen.
// Splits land on newlines so the wrapping is identical to one unbroken node.
//
// And render as text, always. A transcript is untrusted input that this
// application observes; nothing in it is ever interpreted as markup.

import { useEffect, useMemo, useState } from "react";
import { BODY_WINDOW, INLINE_BODY_LIMIT, type StepBody } from "@/lib/format";
import { fmtBytes, fmtInt } from "@/lib/summary";

const HUGE = 262144; // above this, offer a download rather than a reveal
const CHUNK_CHARS = 4000;

export function LongText({
  text, name, initial = INLINE_BODY_LIMIT, mono = true, resetKey,
}: {
  text: string;
  /** Used for the download filename and nothing else. */
  name: string;
  initial?: number;
  mono?: boolean;
  /** Changing this collapses the view again — a new step starts closed. */
  resetKey: string | number;
}) {
  const [shown, setShown] = useState(initial);

  useEffect(() => { setShown(initial); }, [resetKey, initial]);

  const chunks = useMemo(() => {
    const visible = text.slice(0, shown);
    const out: string[] = [];
    let at = 0;
    while (at < visible.length) {
      const hard = Math.min(visible.length, at + CHUNK_CHARS);
      // Prefer the last newline inside the window so the blocks line up with
      // the text's own lines. A body with no newlines at all — a minified
      // payload, one JSON blob — is split at the hard boundary instead; the
      // text already wraps at arbitrary points so the seam is invisible, and
      // without it the whole body lands in one block and this does nothing.
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

  const remaining = text.length - shown;
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name.replace(/\W+/g, "-") || "text"}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <pre className={"code-block" + (mono ? "" : " code-prose") + (shown > initial ? " tall" : "")}>
        {chunks.map((c, i) => (
          <span className="code-chunk" key={i}>{c}</span>
        ))}
        {remaining > 0 ? "\n…" : ""}
      </pre>
      {remaining > 0 && (
        <div className="body-more">
          <span className="body-more-count">{fmtInt(remaining)} more characters</span>
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

/** A step's payload, with a sentence for each of the ways there is not one. */
export function BodyView({
  body, name, stepIndex, preview,
}: {
  body: StepBody | null;
  name: string;
  stepIndex: number;
  preview: string;
}) {
  if (!body) return <p className="empty-line">Reading…</p>;

  if (body.placeholder) {
    return (
      <p className="empty-line">
        {preview || "[redacted]"} — this tape carries structure only, so the body was never
        written into it.
      </p>
    );
  }

  const text = body.text ?? "";
  if (!text) {
    if (body.parts.length) {
      return (
        <p className="empty-line">
          {body.parts.map((p) => `${p.type} · ${fmtBytes(p.chars)}`).join("  ·  ")}
          {" — recorded but not decoded"}
        </p>
      );
    }
    return <p className="empty-line">Empty.</p>;
  }

  return <LongText text={text} name={`step-${stepIndex + 1}-${name}`} resetKey={stepIndex} />;
}
