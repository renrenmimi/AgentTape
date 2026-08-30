"use client";

// Which of my sessions went badly?
//
// The workbench answers questions about one session. This answers the one you
// actually have on a Monday, which is which session to open. It is a table of
// statistics and nothing else: every column is a count, a duration, a token
// total or a name from a fixed vocabulary.
//
// There is deliberately no title column, no first message and no summary. Every
// one of those is written from a prompt, which means every one of them is the
// content this whole project exists to keep on your own machine. A session here
// is a project directory, an id and a clock — the same three things the helper
// prints — and verify.mjs asserts that nothing else gets in.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fmtBytes, fmtDate, fmtDuration, fmtInt, fmtTokens } from "@/lib/summary";
import { overviewUrl, type SessionStats } from "./helper";
import { useDialogFocus } from "./dialog";

type Col = {
  key: string;
  label: string;
  /** Right-aligned numbers, left-aligned names. */
  num?: boolean;
  get: (s: SessionStats) => number | string;
  show: (s: SessionStats) => React.ReactNode;
  title?: string;
};

const COLS: Col[] = [
  { key: "project", label: "project", get: (s) => s.project,
    show: (s) => <span className="ov-proj" title={s.project}>{s.project}</span> },
  { key: "session", label: "session", get: (s) => s.session,
    show: (s) => <span className="ov-id">{s.session.slice(0, 8)}</span> },
  { key: "mtime", label: "last written", get: (s) => s.mtime,
    show: (s) => <span>{fmtDate(s.mtime)}</span> },
  { key: "steps", label: "steps", num: true, get: (s) => s.conversationSteps,
    show: (s) => <>{fmtInt(s.conversationSteps)}</> },
  { key: "toolCalls", label: "tools", num: true, get: (s) => s.toolCalls,
    show: (s) => <>{fmtInt(s.toolCalls)}</> },
  { key: "errors", label: "errors", num: true, get: (s) => s.errors,
    show: (s) => <span className={s.errors ? "ov-bad" : ""}>{fmtInt(s.errors)}</span> },
  { key: "wallMs", label: "wall", num: true, get: (s) => s.wallMs,
    show: (s) => <>{fmtDuration(s.wallMs)}</> },
  { key: "activeMs", label: "active", num: true, get: (s) => s.activeMs,
    show: (s) => <>{fmtDuration(s.activeMs)}</> },
  { key: "peakCtx", label: "peak ctx", num: true, get: (s) => s.peakCtx,
    show: (s) => <>{fmtTokens(s.peakCtx)}</> },
  { key: "compactions", label: "compact", num: true, get: (s) => s.compactions,
    title: "How many times the context was compacted",
    show: (s) => <span className={s.compactions ? "ov-warn" : "ov-dim"}>{s.compactions || "—"}</span> },
  { key: "delegations", label: "deleg", num: true, get: (s) => s.delegations,
    title: "How many times work was handed to a subagent, and how many of those runs are on disk",
    show: (s) => (
      <span className={s.delegations ? "ov-acc" : "ov-dim"}>
        {s.delegations || "—"}
        {s.delegations > 0 && s.agents?.length !== s.delegations && (
          <span className="ov-dim"> /{s.agents?.length ?? 0}</span>
        )}
      </span>
    ) },
  { key: "bytes", label: "size", num: true, get: (s) => s.bytes,
    show: (s) => <>{fmtBytes(s.bytes)}</> },
];

/** Context growth, at a glance. Shared vertical scale, so an outlier is one. */
function Spark({ profile, peak, scale }: { profile: number[]; peak: number; scale: number }) {
  const w = 74;
  const h = 16;
  if (!profile.length || !scale) return <span className="ov-dim">—</span>;
  const pts = profile.map((v, i) =>
    `${(i * w) / (profile.length - 1)},${h - 1 - (Math.min(v, scale) / scale) * (h - 2)}`).join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="ov-spark"
      role="img" aria-label={`context grew to ${fmtTokens(peak)} tokens`}>
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

type Props = { onOpen: (s: SessionStats) => void; onClose: () => void };

export default function Overview({ onOpen, onClose }: Props) {
  const [rows, setRows] = useState<SessionStats[] | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(true);
  const [sort, setSort] = useState({ key: "mtime", desc: true });
  const panel = useRef<HTMLDivElement>(null);
  useDialogFocus(panel);

  const load = useCallback(() => {
    setBusy(true);
    setErr("");
    fetch(overviewUrl())
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: { sessions?: SessionStats[]; error?: string }) => {
        if (j.error) throw new Error(j.error);
        setRows(j.sessions ?? []);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const sorted = useMemo(() => {
    if (!rows) return [];
    const col = COLS.find((c) => c.key === sort.key) ?? COLS[2];
    const out = [...rows].sort((a, b) => {
      const x = col.get(a);
      const y = col.get(b);
      const c = typeof x === "number" && typeof y === "number"
        ? x - y
        : String(x).localeCompare(String(y));
      return sort.desc ? -c : c;
    });
    return out;
  }, [rows, sort]);

  // One vertical scale across every sparkline, or a busy session and a quiet
  // one would look identical.
  const scale = useMemo(() => Math.max(1, ...(rows ?? []).map((s) => s.peakCtx)), [rows]);

  const totals = useMemo(() => {
    const r = rows ?? [];
    return {
      sessions: r.length,
      steps: r.reduce((n, s) => n + s.conversationSteps, 0),
      tools: r.reduce((n, s) => n + s.toolCalls, 0),
      errors: r.reduce((n, s) => n + s.errors, 0),
      active: r.reduce((n, s) => n + s.activeMs, 0),
      bytes: r.reduce((n, s) => n + s.bytes, 0),
    };
  }, [rows]);

  return (
    <div className="ov" role="dialog" aria-modal="true" aria-label="All sessions"
      tabIndex={-1} ref={panel}>
      <div className="cmp-head">
        <span className="eyebrow">sessions</span>
        {rows && (
          <span className="cmp-name">
            {fmtInt(totals.sessions)} sessions · {fmtInt(totals.steps)} steps ·{" "}
            {fmtInt(totals.tools)} tool calls · {fmtDuration(totals.active)} active ·{" "}
            {fmtBytes(totals.bytes)}
          </span>
        )}
        <span className="spacer" />
        <button type="button" className="btn btn-sm" onClick={load} disabled={busy}>
          {busy ? "Indexing…" : "Refresh"}
        </button>
        <button type="button" className="btn btn-sm" onClick={onClose}>Close</button>
      </div>

      <div className="ov-body">
        {err && (
          <div className="err-box">
            The helper did not answer: {err}. Start it with <code>npm run helper</code>.
          </div>
        )}
        {busy && !rows && <p className="empty-note">Indexing your sessions…</p>}
        {rows && rows.length === 0 && !err && <p className="empty-note">No sessions found.</p>}

        {rows && rows.length > 0 && (
          <table className="ov-table">
            <caption className="sr-only">
              Every session, by statistics only. No titles and no message text: a session is
              its project directory, its id and its clock.
            </caption>
            <thead>
              <tr>
                {COLS.map((c) => {
                  const on = sort.key === c.key;
                  return (
                    <th key={c.key} className={c.num ? "ov-n" : ""} title={c.title}
                      aria-sort={on ? (sort.desc ? "descending" : "ascending") : "none"}>
                      <button type="button" className="ov-sort"
                        onClick={() => setSort((s) =>
                          s.key === c.key ? { key: c.key, desc: !s.desc } : { key: c.key, desc: true })}>
                        {c.label}
                        <i aria-hidden>{on ? (sort.desc ? "▾" : "▴") : ""}</i>
                      </button>
                    </th>
                  );
                })}
                <th className="ov-n">context</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sorted.map((s) => (
                <tr key={s.project + "/" + s.session}>
                  {COLS.map((c) => (
                    <td key={c.key} className={c.num ? "ov-n" : ""}>{c.show(s)}</td>
                  ))}
                  <td className="ov-n ov-sparkcell">
                    <Spark profile={s.ctxProfile} peak={s.peakCtx} scale={scale} />
                  </td>
                  <td>
                    <button type="button" className="btn btn-sm" onClick={() => onOpen(s)}>
                      Open
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <p className="ov-note">
          Statistics only. No session titles, no first messages, no summaries — every one of
          those is written from a prompt. Sparklines share one vertical scale, so the tallest
          line is the session that grew the most context of any of them.
        </p>
      </div>
    </div>
  );
}
