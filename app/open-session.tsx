"use client";

// Opening a file: the control, its states, and the dialog form of it.
//
// One component, two placements. The landing page shows it inline next to the
// demo button; the global "Open session" button shows the same thing in a
// dialog. Two copies of a control with eight states is two places for one of
// them to forget that cancelling a picker is not an error.
//
// The states, all of which are reachable and none of which is a spinner with
// no words on it: nothing chosen yet · the picker was cancelled · reading ·
// the file is empty · the file is not a format this reads · the parse failed ·
// a session is already open and this would replace it.

import { useCallback, useRef, useState, type ReactNode } from "react";
import { fmtBytes, fmtInt } from "@/lib/summary";
import { useDialogFocus } from "./dialog";
import { FileIcon, PlayIcon } from "./icons";

/**
 * What the reader knows about how far it has got.
 *
 * `total` is the file's size when there is one to know, and zero when there is
 * not. A percentage is only rendered from the first case: a progress bar that
 * animates to a number nobody measured is worse than a line of text, because
 * it is a claim rather than a status.
 */
export type Progress = {
  label: string;
  lines: number;
  bytes: number;
  total: number;
};

export type OpenError = {
  /** One sentence, in the user's terms. */
  text: string;
  /** What the parser actually said, when it said anything. */
  detail?: string;
};

type Props = {
  onFiles: (files: File[]) => void;
  onDemo: () => void;
  progress: Progress | null;
  error: OpenError | null;
  /** True when a session is already open, so the copy can say what happens to it. */
  replacing: boolean;
  /** Rendered under the actions — the landing page puts its side routes there. */
  children?: ReactNode;
  /** The landing page leads with the demo; the dialog leads with the file. */
  lead: "demo" | "file";
};

export function OpenPanel({
  onFiles, onDemo, progress, error, replacing, children, lead,
}: Props) {
  const [over, setOver] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const take = useCallback(
    (files: FileList | null) => {
      const list = files ? [...files] : [];
      // An empty FileList is what the picker hands back when somebody closes
      // it without choosing. That is a decision, not a fault, and it gets a
      // quiet line rather than a red box.
      if (!list.length) { setCancelled(true); return; }
      setCancelled(false);
      onFiles(list);
    },
    [onFiles],
  );

  const pct = progress && progress.total > 0
    ? Math.min(100, Math.round((progress.bytes / progress.total) * 100))
    : null;

  return (
    <div className="open-panel">
      <div className={"open-actions" + (lead === "file" ? " open-actions-file" : "")}>
        {lead === "demo" ? (
          <>
            <button type="button" className="btn btn-primary btn-lead" onClick={onDemo}>
              <PlayIcon />
              <span>Try a demo</span>
            </button>
            <button type="button" className="btn btn-lead" onClick={() => input.current?.click()}>
              <FileIcon />
              <span>Open a transcript</span>
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn btn-primary btn-lead"
              onClick={() => input.current?.click()}>
              <FileIcon />
              <span>Choose a file</span>
            </button>
            <button type="button" className="btn btn-lead" onClick={onDemo}>
              <PlayIcon />
              <span>Try a demo</span>
            </button>
          </>
        )}
        <input
          ref={input}
          type="file"
          multiple
          accept=".jsonl,.json"
          className="sr-only"
          aria-label="Choose a transcript file"
          onChange={(e) => { const f = e.target.files; e.target.value = ""; take(f); }}
        />
      </div>

      <div
        className={"dropzone" + (over ? " dropzone-over" : "")}
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
          take(e.dataTransfer.files);
        }}
      >
        <p className="dropzone-line">
          Or drop a file here — <code>.jsonl</code> or <code>.tape.json</code>
        </p>
        <p className="dropzone-sub">
          Several at once is fine. The <code>agent-*.jsonl</code> files beside a session are
          attached to the calls that delegated to them.
        </p>
      </div>

      <p className="privacy-line">Files are read in your browser, not uploaded.</p>

      {replacing && (
        <p className="note note-info" role="status">
          Opening a file replaces the session on screen. Cancelling leaves it exactly as it is.
        </p>
      )}

      {cancelled && !progress && !error && (
        <p className="note note-quiet" role="status">
          No file chosen. Nothing has changed.
        </p>
      )}

      {progress && (
        <div className="progress-block" role="status">
          {pct === null ? (
            <p className="progress-text">
              Reading {progress.label} — {fmtInt(progress.lines)} lines so far
            </p>
          ) : (
            <>
              <div
                className="progress"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={pct}
                aria-label={`Reading ${progress.label}`}
              >
                <i style={{ width: pct + "%" }} />
              </div>
              <p className="progress-text">
                {progress.label} · {fmtBytes(progress.bytes)} of {fmtBytes(progress.total)} ·{" "}
                {fmtInt(progress.lines)} lines
              </p>
            </>
          )}
        </div>
      )}

      {error && (
        <div className="note note-error" role="alert">
          <p className="note-text">{error.text}</p>
          {error.detail && (
            <details className="note-more">
              <summary>What the reader said</summary>
              <pre className="code-block code-short">{error.detail}</pre>
            </details>
          )}
        </div>
      )}

      {children}
    </div>
  );
}

/** The same panel, as the global Open session dialog. */
export function OpenDialog({ onClose, ...rest }: Props & { onClose: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  useDialogFocus(panel);

  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="open-dialog-title"
        tabIndex={-1}
        ref={panel}
      >
        <div className="dialog-head">
          <h2 id="open-dialog-title">Open a session</h2>
          <span className="spacer" />
          <button type="button" className="btn btn-sm" onClick={onClose}>Cancel</button>
        </div>
        <div className="dialog-body">
          <OpenPanel {...rest} />
        </div>
      </div>
    </div>
  );
}
