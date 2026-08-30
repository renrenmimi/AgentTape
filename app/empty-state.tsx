"use client";

// The empty state carries the privacy claim, because that is the first thing
// someone needs to believe before they drop months of private work onto a web
// page. The claim is checkable: there is no upload endpoint in this app, and
// the only network call it ever makes is to 127.0.0.1, only when the page is
// itself being served from localhost.

import { useCallback, useEffect, useRef, useState } from "react";
import { fmtBytes, fmtDuration, fmtInt } from "@/lib/summary";
import { isLocal, useHelperSessions, type HelperSession } from "./helper";

type Props = {
  /** Several at once: a transcript plus the agent-*.jsonl files beside it. */
  onFiles: (files: File[]) => void;
  onHelperPick: (session: HelperSession) => void;
  onDemo: () => void;
  progress: { pct: number; lines: number; label: string } | null;
  error: string;
};

export default function EmptyState({ onFiles, onHelperPick, onDemo, progress, error }: Props) {
  const [over, setOver] = useState(false);
  const { sessions, probing, asked, failed, probe } = useHelperSessions();
  // Whether the helper block belongs on the page depends on `location`, which
  // the server does not have. Deciding after mount keeps the first client
  // render identical to the server's.
  const [mounted, setMounted] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { setMounted(true); }, []);

  const take = useCallback(
    (files: FileList | null) => {
      const list = files ? [...files] : [];
      if (list.length) onFiles(list);
    },
    [onFiles],
  );

  return (
    <div className="drop">
      <div className="drop-card">
        <h1>AgentTape</h1>
        <p className="lede">
          Open a Claude Code session that already happened and replay it. Nothing to instrument,
          nothing to set up before the run — the transcript is already on your disk.
        </p>

        <ul className="can-do">
          <li><b>Watch the messages array grow</b>, step by step, with the token cost of each entry.</li>
          <li><b>Find the step that blew up the context</b> — and see whether that payload is still
            being re-sent every turn since.</li>
          <li><b>Search and filter</b> by tool, by payload size, by text, and step through the
            matches or the failures.</li>
          <li><b>See inside delegated work.</b> A session that hands a job to a subagent keeps only
            the summary; the rest is in a file beside it.</li>
          <li><b>Compare two runs</b> and find where they stopped agreeing.</li>
          <li><b>Assert what a run should have done</b> — search before write, a context ceiling,
            no tool called five times in a row.</li>
          <li><b>Export a structure-only tape</b> that is safe to attach to a bug report.</li>
        </ul>

        <p className="lede lede-cta">
          Never seen it? <b>Load the demo tape</b> — a fictional run with two tool failures, a
          context blow-up, a compaction, a delegation and a 38-minute silence in it.
        </p>

        {progress && (
          <>
            <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100}
              aria-valuenow={Math.round(progress.pct)} aria-label="Parsing progress">
              <i style={{ width: progress.pct + "%" }} />
            </div>
            <p className="empty-note">
              {progress.label} · {fmtInt(progress.lines)} lines · {Math.round(progress.pct)}%
            </p>
          </>
        )}

        <div
          className={"dropzone" + (over ? " over" : "")}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); take(e.dataTransfer.files); }}
        >
          Drop a <code>.jsonl</code> transcript or a <code>.tape.json</code> here
          <span className="dropzone-sub">
            several at once is fine — add the <code>agent-*.jsonl</code> files beside a session
            and the delegated runs are attached too
          </span>
        </div>

        <div className="drop-actions">
          <button type="button" className="btn btn-accent btn-lead" onClick={onDemo}>
            Load the demo tape
          </button>
          <button type="button" className="btn" onClick={() => input.current?.click()}>
            Choose a file
          </button>
          <input
            ref={input}
            type="file"
            multiple
            accept=".jsonl,.json"
            className="sr-only"
            aria-label="Choose a transcript file"
            onChange={(e) => take(e.target.files)}
          />
        </div>

        {error && <div className="err-box">{error}</div>}

        {mounted && isLocal() && (
          <div className="sessions">
            <div className="helper-row">
              <span className="eyebrow">
                {probing && "Looking for the local helper…"}
                {!probing && sessions === null && !failed &&
                  "Local helper — lists your sessions so you do not have to hunt for the file"}
                {!probing && failed &&
                  "Local helper not running — start it with npm run helper, then look again"}
                {!probing && sessions && sessions.length > 0 && `Recent sessions · ${sessions.length}`}
                {!probing && sessions && sessions.length === 0 && "The helper is running but found no sessions"}
              </span>
              {!probing && (sessions === null || failed) && (
                <button type="button" className="btn btn-sm" onClick={probe}>
                  {asked ? "Look again" : "Look for it"}
                </button>
              )}
            </div>
            {sessions?.map((s) => (
              <button
                type="button"
                className="session-row"
                key={s.project + "/" + s.session}
                onClick={() => onHelperPick(s)}
              >
                <span className="proj">{s.project}</span>
                <span className="meta">{s.session.slice(0, 8)}</span>
                <span className="meta">
                  {fmtBytes(s.bytes)} · {fmtInt(s.lines)} lines · {fmtInt(s.tools)} tools
                  {s.agents?.length ? ` · ${fmtInt(s.agents.length)} subagents` : ""}
                </span>
                <span className="meta">{fmtDuration(Date.now() - s.mtime)} ago</span>
              </button>
            ))}
          </div>
        )}

        <div className="privacy">
          <b>Your transcripts never leave this machine.</b> Parsing runs in the browser, on the
          file you point at. There is no upload, no account and no backend that receives
          transcript content — the only request this page can make goes to 127.0.0.1, and only
          when the page is served from localhost. Use <b>Export redacted tape</b> to produce a
          structure-only file that is safe to attach to a bug report.
        </div>
      </div>
    </div>
  );
}
