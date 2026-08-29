"use client";

// The empty state carries the privacy claim, because that is the first thing
// someone needs to believe before they drop months of private work onto a web
// page. The claim is checkable: there is no upload endpoint in this app, and
// the only network call it ever makes is to 127.0.0.1, only when the page is
// itself being served from localhost.

import { useCallback, useEffect, useRef, useState } from "react";
import { fmtBytes, fmtDuration, fmtInt } from "@/lib/summary";

export type HelperSession = {
  project: string;
  session: string;
  bytes: number;
  lines: number;
  tools: number;
  mtime: number;
};

const HELPER = "http://127.0.0.1:4319";

type Props = {
  onFile: (file: File) => void;
  onHelperPick: (url: string, label: string) => void;
  onDemo: () => void;
  progress: { pct: number; lines: number; label: string } | null;
  error: string;
};

function isLocal(): boolean {
  if (typeof location === "undefined") return false;
  return location.hostname === "localhost" || location.hostname === "127.0.0.1";
}

export default function EmptyState({ onFile, onHelperPick, onDemo, progress, error }: Props) {
  const [over, setOver] = useState(false);
  const [sessions, setSessions] = useState<HelperSession[] | null>(null);
  const [helperErr, setHelperErr] = useState("");
  // Whether the helper block belongs on the page depends on `location`, which
  // the server does not have. Deciding after mount keeps the first client
  // render identical to the server's.
  const [mounted, setMounted] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    if (!isLocal()) return;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 1500);
    fetch(HELPER + "/sessions", { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j) => setSessions(Array.isArray(j.sessions) ? j.sessions : []))
      .catch(() => setHelperErr("not running"))
      .finally(() => clearTimeout(timer));
    return () => { ac.abort(); clearTimeout(timer); };
  }, []);

  const take = useCallback(
    (files: FileList | null) => {
      const f = files?.[0];
      if (f) onFile(f);
    },
    [onFile],
  );

  return (
    <div className="drop">
      <div className="drop-card">
        <h1>AgentTape</h1>
        <p className="lede">
          Open a Claude Code session that already happened and replay it: the messages array as
          it grew, where the tokens went, and which step was the first to go wrong.
        </p>

        <div
          className={"dropzone" + (over ? " over" : "")}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); take(e.dataTransfer.files); }}
        >
          Drop a <code>.jsonl</code> transcript or a <code>.tape.json</code> here
        </div>

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

        <div className="drop-actions">
          <button type="button" className="btn btn-accent" onClick={() => input.current?.click()}>
            Choose a file
          </button>
          <button type="button" className="btn" onClick={onDemo}>
            Load demo tape
          </button>
          <input
            ref={input}
            type="file"
            accept=".jsonl,.json"
            className="sr-only"
            aria-label="Choose a transcript file"
            onChange={(e) => take(e.target.files)}
          />
        </div>

        {error && <div className="err-box">{error}</div>}

        {mounted && isLocal() && (
          <div className="sessions">
            <span className="eyebrow" style={{ marginBottom: 4 }}>
              {sessions === null && !helperErr && "Looking for the local helper…"}
              {helperErr && "Local helper not running — run npm run helper to list your sessions"}
              {sessions && sessions.length > 0 && `Recent sessions · ${sessions.length}`}
              {sessions && sessions.length === 0 && "Helper found no sessions"}
            </span>
            {sessions?.map((s) => (
              <button
                type="button"
                className="session-row"
                key={s.project + "/" + s.session}
                onClick={() =>
                  onHelperPick(
                    `${HELPER}/file?project=${encodeURIComponent(s.project)}&session=${encodeURIComponent(s.session)}`,
                    s.session.slice(0, 8),
                  )
                }
              >
                <span className="proj">{s.project}</span>
                <span className="meta">{s.session.slice(0, 8)}</span>
                <span className="meta">{fmtBytes(s.bytes)} · {fmtInt(s.lines)} lines · {fmtInt(s.tools)} tools</span>
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
