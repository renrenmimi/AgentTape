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
//
// Two routes reach this screen. The local helper serves the index over
// loopback; the File System Access API lets the browser build the same index
// itself from a folder the user grants, with no server anywhere. Both hand the
// work to lib/session-index.ts, so there is one definition of a session record
// and one freshness rule rather than two that drift.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fmtBytes, fmtDate, fmtDuration, fmtInt, fmtTokens } from "@/lib/summary";
import { overviewUrl, type SessionStats } from "./helper";
import {
  SUPPORT_NOTE, buildLocalIndex, clearLocalCache, collectFromDirectory, collectFromFiles,
  localCacheSize, pickerSupport, type LocalIndexResult, type PickerSupport,
} from "./local-index";
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

type Source = "" | "helper" | "local";

type Props = {
  onOpen: (s: SessionStats) => void;
  onClose: () => void;
  /** True when the helper answered on this machine, so its route is worth offering. */
  helperReachable: boolean;
};

export default function Overview({ onOpen, onClose, helperReachable }: Props) {
  const [rows, setRows] = useState<SessionStats[] | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState<Source>("");
  const [sort, setSort] = useState({ key: "mtime", desc: true });
  const [progress, setProgress] = useState("");
  const [local, setLocal] = useState<LocalIndexResult | null>(null);
  const [support, setSupport] = useState<PickerSupport>("none");
  const [cacheBytes, setCacheBytes] = useState(0);
  const dirInput = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useDialogFocus(panel);

  useEffect(() => {
    setSupport(pickerSupport());
    setCacheBytes(localCacheSize());
  }, []);

  const fromHelper = useCallback(() => {
    setBusy(true);
    setErr("");
    setSource("helper");
    setLocal(null);
    fetch(overviewUrl())
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: { sessions?: SessionStats[]; error?: string }) => {
        if (j.error) throw new Error(j.error);
        setRows(j.sessions ?? []);
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  }, []);

  const runLocal = useCallback(async (collect: () => Promise<{ sources: unknown[] } & object>) => {
    setBusy(true);
    setErr("");
    setSource("local");
    setProgress("");
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const found = (await collect()) as any;
      if (!found.sources.length) {
        setErr("No .jsonl transcripts in that folder. Point it at ~/.claude/projects.");
        setRows([]);
        return;
      }
      const res = await buildLocalIndex(found, (done, total, indexed, cached) => {
        setProgress(`${done} of ${total} · ${indexed} read · ${cached} from cache`);
      });
      setLocal(res);
      setRows(res.sessions);
      setCacheBytes(localCacheSize());
      if (!res.cacheWritten) {
        setErr("Indexed, but the browser refused to cache it — the next pass will be just as slow.");
      }
    } catch (e) {
      // An abandoned folder picker throws; that is a decision, not a fault.
      const msg = e instanceof Error ? e.message : String(e);
      if (!/abort/i.test(msg)) setErr(msg);
    } finally {
      setBusy(false);
      setProgress("");
    }
  }, []);

  const pickFolder = useCallback(() => {
    const pick = (window as unknown as {
      showDirectoryPicker?: (o?: { mode?: string }) => Promise<FileSystemDirectoryHandle>;
    }).showDirectoryPicker;
    if (!pick) return;
    void runLocal(async () => collectFromDirectory(await pick({ mode: "read" })));
  }, [runLocal]);

  const load = useCallback(() => {
    if (source === "helper") fromHelper();
    else if (source === "local" && support === "directory-picker") pickFolder();
  }, [source, support, fromHelper, pickFolder]);

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
        {source === "local" && (
          <span className="ov-src">read in this browser · nothing uploaded</span>
        )}
        {source === "helper" && <span className="ov-src">from the local helper</span>}
        {source !== "" && (
          <button type="button" className="btn btn-sm" onClick={load} disabled={busy}>
            {busy ? "Indexing…" : "Refresh"}
          </button>
        )}
        <button type="button" className="btn btn-sm" onClick={onClose}>Close</button>
      </div>

      <div className="ov-body">
        {source === "" && (
          <div className="ov-pick">
            <p className="nested-note">
              Every session on this machine, as statistics: how long, how many tool calls, how
              many failed, how far the context grew. <b>No titles and no message text</b> —
              a session here is a project directory, an id and a clock.
            </p>

            <div className="ov-routes">
              <div className="ov-route">
                <span className="eyebrow">in this browser</span>
                <p>
                  Grant this page read access to <code>~/.claude/projects</code> and it builds the
                  index itself. {SUPPORT_NOTE[support]}
                </p>
                {support === "directory-picker" && (
                  <button type="button" className="btn btn-accent" onClick={pickFolder}>
                    Choose a folder
                  </button>
                )}
                {support === "webkitdirectory" && (
                  <>
                    <button type="button" className="btn btn-accent"
                      onClick={() => dirInput.current?.click()}>
                      Choose a folder
                    </button>
                    <input
                      ref={dirInput}
                      type="file"
                      className="sr-only"
                      aria-label="Choose the projects folder"
                      {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
                      onChange={(e) => {
                        const list = [...(e.target.files ?? [])];
                        e.target.value = "";
                        if (list.length) void runLocal(async () => collectFromFiles(list));
                      }}
                    />
                  </>
                )}
                {support === "none" && <p className="ov-dim">Not available in this browser.</p>}
              </div>

              <div className="ov-route">
                <span className="eyebrow">from the local helper</span>
                <p>
                  {helperReachable
                    ? "The helper is answering on 127.0.0.1 and has already walked the directory."
                    : "The helper is not running. Start it with npm run helper and come back."}
                </p>
                <button type="button" className={"btn" + (helperReachable ? " btn-accent" : "")}
                  onClick={fromHelper} disabled={!helperReachable}>
                  Use the helper
                </button>
              </div>
            </div>

            {cacheBytes > 0 && (
              <p className="ov-note">
                A previous browser index is cached here ({fmtBytes(cacheBytes)}), keyed by each
                file&rsquo;s size and modification time.{" "}
                <button type="button" className="btn btn-sm"
                  onClick={() => { clearLocalCache(); setCacheBytes(0); }}>
                  Clear it
                </button>
              </p>
            )}
          </div>
        )}

        {err && <div className="err-box">{err}</div>}
        {busy && (
          <p className="empty-note">
            Indexing{progress ? ` — ${progress}` : "…"}
          </p>
        )}
        {rows && rows.length === 0 && !err && !busy && <p className="empty-note">No sessions found.</p>}

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

        {rows && rows.length > 0 && (
          <p className="ov-note">
            Statistics only. No session titles, no first messages, no summaries — every one of
            those is written from a prompt. Sparklines share one vertical scale, so the tallest
            line is the session that grew the most context of any of them.
            {local && (
              <>
                {" "}Read <b>{fmtBytes(local.bytes)}</b> across {fmtInt(local.sessions.length)}{" "}
                transcripts in <b>{(local.ms / 1000).toFixed(1)}s</b> — {fmtInt(local.indexed)}{" "}
                parsed, {fmtInt(local.cached)} from the browser cache
                {local.failed ? `, ${fmtInt(local.failed)} unreadable` : ""}.
                {cacheBytes > 0 && (
                  <>
                    {" "}The cache holds {fmtBytes(cacheBytes)} in this browser&rsquo;s local
                    storage, keyed by size and modification time.{" "}
                    <button type="button" className="btn btn-sm"
                      onClick={() => { clearLocalCache(); setCacheBytes(0); }}>
                      Clear it
                    </button>
                  </>
                )}
              </>
            )}
          </p>
        )}
      </div>
    </div>
  );
}
