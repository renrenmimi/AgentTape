"use client";

// Every session you have granted access to, as a table.
//
// This is the index — which session to open — and not a second dashboard.
// Five columns by default, the rest behind a Columns menu or a row you expand,
// because thirteen columns is a wall to scan rather than a list to pick from.
//
// There is deliberately no title column, no first message and no summary.
// Every one of those is written from a prompt, which makes it the content this
// project exists to keep on your own machine. A session here is a project
// directory, an id and a clock — the same three things the helper prints — and
// verify.mjs asserts that nothing else gets in.
//
// The helper block is the part that was actively misleading before. On the
// deployed site it said "The helper is not running. Start it with npm run
// helper and come back", which reads as an instruction that would work. It
// cannot: the helper only answers to a page served from localhost, and that is
// a security boundary rather than a bug to be worked around. Away from
// localhost the block now says when the route is available and how to get
// there, and the page makes no request to loopback at all.
//
// Note the name: `session-overview.tsx` is the overview of one session. These
// were both called "overview" and it was one word doing two jobs.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fmtBytes, fmtDate, fmtDuration, fmtInt, fmtTokens } from "@/lib/summary";
import { isLocal, overviewUrl, useHelperSessions, type SessionStats } from "./helper";
import {
  SUPPORT_NOTE, buildLocalIndex, clearLocalCache, collectFromDirectory, collectFromFiles,
  localCacheSize, pickerSupport, type LocalIndexResult, type PickerSupport,
} from "./local-index";
import Menu, { type MenuItem } from "./menu";
import { BackIcon, FolderIcon } from "./icons";

type Col = {
  key: string;
  label: string;
  /** Right-aligned numbers, left-aligned names. */
  num?: boolean;
  get: (s: SessionStats) => number | string;
  show: (s: SessionStats, scale: number) => React.ReactNode;
  title?: string;
};

const COLS: Col[] = [
  { key: "session", label: "Session", get: (s) => s.session,
    show: (s) => (
      <span className="ov-id">
        <code>{s.session.slice(0, 8)}</code>
        <span className="ov-proj" title={s.project}>{s.project}</span>
      </span>
    ) },
  { key: "mtime", label: "Last written", get: (s) => s.mtime,
    show: (s) => <>{fmtDate(s.mtime)}</> },
  { key: "conversationSteps", label: "Steps", num: true, get: (s) => s.conversationSteps,
    show: (s) => <>{fmtInt(s.conversationSteps)}</> },
  { key: "errors", label: "Tool failures", num: true, get: (s) => s.errors,
    show: (s) => <span className={s.errors ? "cell-error" : "dim"}>{s.errors ? fmtInt(s.errors) : "—"}</span> },
  { key: "activeMs", label: "Active", num: true, get: (s) => s.activeMs,
    title: "Wall-clock time with every gap over two minutes removed",
    show: (s) => <>{s.activeMs ? fmtDuration(s.activeMs) : "—"}</> },

  // Off by default. Every one is still sortable and still reachable.
  { key: "toolCalls", label: "Tool calls", num: true, get: (s) => s.toolCalls,
    show: (s) => <>{fmtInt(s.toolCalls)}</> },
  { key: "wallMs", label: "Wall clock", num: true, get: (s) => s.wallMs,
    show: (s) => <>{s.wallMs ? fmtDuration(s.wallMs) : "—"}</> },
  { key: "peakCtx", label: "Peak context", num: true, get: (s) => s.peakCtx,
    show: (s) => <>{s.peakCtx ? fmtTokens(s.peakCtx) : "—"}</> },
  { key: "compactions", label: "Compactions", num: true, get: (s) => s.compactions,
    show: (s) => <span className={s.compactions ? "" : "dim"}>{s.compactions || "—"}</span> },
  { key: "delegations", label: "Delegations", num: true, get: (s) => s.delegations,
    title: "How many times work was handed to a subagent, and how many of those runs are on disk",
    show: (s) => (
      <span className={s.delegations ? "" : "dim"}>
        {s.delegations || "—"}
        {s.delegations > 0 && s.agents?.length !== s.delegations && (
          <span className="dim"> /{s.agents?.length ?? 0}</span>
        )}
      </span>
    ) },
  { key: "bytes", label: "Size", num: true, get: (s) => s.bytes,
    show: (s) => <>{fmtBytes(s.bytes)}</> },
  { key: "ctxProfile", label: "Context", num: true, get: (s) => s.peakCtx,
    title: "Context growth across the session. One vertical scale across every row.",
    show: (s, scale) => <Spark profile={s.ctxProfile} peak={s.peakCtx} scale={scale} /> },
];

const DEFAULT_COLS = ["session", "mtime", "conversationSteps", "errors", "activeMs"];

/** Context growth, at a glance. One shared vertical scale, so an outlier is one. */
function Spark({ profile, peak, scale }: { profile: number[]; peak: number; scale: number }) {
  const w = 74;
  const h = 16;
  if (!profile.length || !scale) return <span className="dim">—</span>;
  const pts = profile.map((v, i) =>
    `${(i * w) / (profile.length - 1)},${h - 1 - (Math.min(v, scale) / scale) * (h - 2)}`).join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="ov-spark"
      role="img" aria-label={`context grew to ${fmtTokens(peak)} tokens`}>
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

type Source = "" | "helper" | "local";

type Props = {
  onOpen: (s: SessionStats) => void;
  onBack: () => void;
  /** What "back" returns to, so the control can say. */
  backLabel: string;
};

export default function AllSessions({ onOpen, onBack, backLabel }: Props) {
  const [rows, setRows] = useState<SessionStats[] | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState<Source>("");
  const [sort, setSort] = useState({ key: "mtime", desc: true });
  const [progress, setProgress] = useState("");
  const [local, setLocal] = useState<LocalIndexResult | null>(null);
  const [support, setSupport] = useState<PickerSupport>("none");
  const [cacheBytes, setCacheBytes] = useState(0);
  const [shown, setShown] = useState<string[]>(DEFAULT_COLS);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [mounted, setMounted] = useState(false);
  const dirInput = useRef<HTMLInputElement>(null);
  const { sessions: helperSessions, probing, asked, failed, probe } = useHelperSessions();

  useEffect(() => {
    setMounted(true);
    setSupport(pickerSupport());
    setCacheBytes(localCacheSize());
  }, []);

  const helperHere = mounted && isLocal();
  const helperAnswered = !!helperSessions && helperSessions.length >= 0 && !failed;

  const fromHelper = useCallback(() => {
    if (!isLocal()) return;
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
      .catch((e) => setErr("The helper did not answer: " +
        (e instanceof Error ? e.message : String(e))))
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
        setErr("No .jsonl transcripts in that folder. Point it at ~/.claude/projects, or at one " +
          "project directory inside it.");
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
        setErr("Indexed, but this browser refused to cache the result — the next pass will be " +
          "just as slow. Private browsing and a full storage quota both do this.");
      }
    } catch (e) {
      // An abandoned folder picker throws. That is a decision, not a fault.
      const msg = e instanceof Error ? e.message : String(e);
      if (/abort/i.test(msg)) {
        setSource("");
      } else if (/denied|permission/i.test(msg)) {
        setErr("This browser did not grant read access to that folder. Nothing has been read.");
      } else {
        setErr(msg);
      }
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

  const reload = useCallback(() => {
    if (source === "helper") fromHelper();
    else if (source === "local" && support === "directory-picker") pickFolder();
  }, [source, support, fromHelper, pickFolder]);

  const cols = useMemo(() => COLS.filter((c) => shown.includes(c.key)), [shown]);
  const sortCol = COLS.find((c) => c.key === sort.key);
  const sortHidden = !!sortCol && !shown.includes(sortCol.key);

  const sorted = useMemo(() => {
    if (!rows) return [];
    const col = sortCol ?? COLS[1];
    return [...rows].sort((a, b) => {
      const x = col.get(a);
      const y = col.get(b);
      const c = typeof x === "number" && typeof y === "number"
        ? x - y
        : String(x).localeCompare(String(y));
      return sort.desc ? -c : c;
    });
  }, [rows, sort, sortCol]);

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

  const colItems: MenuItem[] = COLS.map((c) => ({
    label: c.label,
    selected: shown.includes(c.key),
    disabled: c.key === "session",
    onSelect: () =>
      setShown((prev) =>
        prev.includes(c.key) ? prev.filter((k) => k !== c.key) : [...prev, c.key]),
  }));

  return (
    <main className="view view-sessions" id="main">
      <div className={"view-inner" + (rows && rows.length > 0 ? " view-inner-wide" : "")}>
        <header className="view-head">
          <button type="button" className="btn btn-quiet btn-sm view-back" onClick={onBack}>
            <BackIcon />
            <span className="view-back-label">Back to {backLabel}</span>
          </button>
          <h1 className="view-title">Local sessions</h1>
          <p className="view-lede">
            Every session in a folder you point this page at, as statistics.
          </p>
        </header>

        {source === "" && (
          <>
            <section className="pick" aria-labelledby="pick-title">
              <h2 className="pick-title" id="pick-title">Choose a folder</h2>
              <p className="pick-note">
                Point it at <code>~/.claude/projects</code>. <b>Nothing is uploaded</b> — the
                files are read here, in your browser, and this page never looks at a folder you
                have not handed it.
              </p>

              {support === "directory-picker" && (
                <button type="button" className="btn btn-primary btn-lead" onClick={pickFolder}>
                  <FolderIcon />
                  <span>Choose a folder</span>
                </button>
              )}
              {support === "webkitdirectory" && (
                <>
                  <button type="button" className="btn btn-primary btn-lead"
                    onClick={() => dirInput.current?.click()}>
                    <FolderIcon />
                    <span>Choose a folder</span>
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
                  <p className="pick-caveat">{SUPPORT_NOTE.webkitdirectory}</p>
                </>
              )}
              {support === "none" && (
                <p className="note note-warning">
                  <span className="note-text">{SUPPORT_NOTE.none}</span>
                </p>
              )}

              <p className="pick-caveat">
                No session title, first message or summary appears in the table. Every one of
                those is written from a prompt.
              </p>
            </section>

            <section className="advanced">
              <button
                type="button"
                className="details-toggle details-toggle-sm"
                aria-expanded={advanced}
                onClick={() => setAdvanced((v) => !v)}
              >
                <span className="details-caret" aria-hidden>{advanced ? "−" : "+"}</span>
                <span>Run locally for the helper</span>
                <span className="details-hint">
                  a second route, and the only one that can open a session by row
                </span>
              </button>

              {advanced && (
                <div className="fold-body">
                  {!mounted ? (
                    <p className="empty-line">Checking what is available here…</p>
                  ) : helperHere ? (
                    <>
                      <p className="sec-lead">
                        {probing && "Looking for the helper on 127.0.0.1…"}
                        {!probing && failed &&
                          "Nothing answered on 127.0.0.1:4319. Start it with npm run helper."}
                        {!probing && !failed && helperAnswered &&
                          "The helper is answering and has already walked the directory."}
                        {!probing && !failed && !helperAnswered &&
                          "The helper walks ~/.claude/projects for you and serves the index over " +
                          "loopback. It is also the only route that can open a session by clicking " +
                          "its row."}
                      </p>
                      <div className="route-actions">
                        <button type="button" className="btn" onClick={fromHelper} disabled={probing}>
                          Use the helper
                        </button>
                        {!probing && (
                          <button type="button" className="btn btn-quiet" onClick={probe}>
                            {asked ? "Look again" : "Look for it"}
                          </button>
                        )}
                      </div>
                    </>
                  ) : (
                    <p className="sec-lead">
                      <b>Available when AgentTape is running locally.</b> The helper answers on{" "}
                      <code>127.0.0.1</code>, and a browser will not let a page on this address
                      reach it. To use it, clone the repository and run <code>npm run helper</code>{" "}
                      alongside <code>npm run dev</code>. This page makes no request to loopback.
                    </p>
                  )}
                </div>
              )}
            </section>
          </>
        )}

        {source === "" && cacheBytes > 0 && (
          <p className="cache-note">
            A previous index from this browser is cached ({fmtBytes(cacheBytes)}), keyed by each
            file&rsquo;s size and modification time.{" "}
            <button type="button" className="btn btn-sm"
              onClick={() => { clearLocalCache(); setCacheBytes(0); }}>
              Clear the cache
            </button>
            <span className="dim"> Clearing removes this browser&rsquo;s index only. No
            transcript is touched.</span>
          </p>
        )}

        {err && <div className="note note-error" role="alert"><span className="note-text">{err}</span></div>}

        {busy && (
          <p className="empty-line" role="status">
            Indexing{progress ? ` — ${progress}` : "…"}
          </p>
        )}

        {rows && rows.length === 0 && !err && !busy && (
          <div className="list-empty">
            <p className="empty-title">No sessions found</p>
            <p className="empty-line">
              That source produced no readable transcripts.
            </p>
            <button type="button" className="btn btn-sm" onClick={() => { setSource(""); setRows(null); }}>
              Choose another source
            </button>
          </div>
        )}

        {rows && rows.length > 0 && (
          <>
            <div className="ov-bar">
              <p className="ov-totals">
                {fmtInt(totals.sessions)} sessions · {fmtInt(totals.steps)} steps ·{" "}
                {fmtInt(totals.tools)} tool calls · {fmtInt(totals.errors)} failures ·{" "}
                {fmtDuration(totals.active)} active · {fmtBytes(totals.bytes)}
              </p>
              <span className="spacer" />
              <span className="ov-src">
                {source === "local" ? "Read in this browser · nothing uploaded" : "From the local helper"}
              </span>
              <Menu label="Columns" items={colItems} look="quiet" />
              <button type="button" className="btn btn-sm" onClick={reload} disabled={busy}>
                {busy ? "Indexing…" : "Refresh"}
              </button>
              <button type="button" className="btn btn-sm"
                onClick={() => { setSource(""); setRows(null); setErr(""); }}>
                Change source
              </button>
            </div>

            {sortHidden && (
              <p className="note note-info">
                <span className="note-text">
                  Sorted by <b>{sortCol?.label}</b>, which is not one of the columns on screen.{" "}
                  <button type="button" className="btn-link"
                    onClick={() => setShown((p) => [...p, sort.key])}>
                    Show that column
                  </button>
                </span>
              </p>
            )}

            <table className="data-table ov-table">
              <caption className="sr-only">
                Every session, by statistics only. No titles and no message text: a session is its
                project directory, its id and its clock.
              </caption>
              <thead>
                <tr>
                  {cols.map((c) => {
                    const on = sort.key === c.key;
                    return (
                      <th key={c.key} scope="col" className={c.num ? "num" : ""} title={c.title}
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
                  <th scope="col"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((s) => {
                  const key = s.project + "/" + s.session;
                  const isOpen = expanded === key;
                  return (
                    <>
                      <tr key={key} className={isOpen ? "row-open" : ""}>
                        {cols.map((c) => (
                          <td key={c.key} className={c.num ? "num" : ""}>{c.show(s, scale)}</td>
                        ))}
                        <td className="ov-actions">
                          <button type="button" className="btn btn-sm"
                            aria-expanded={isOpen}
                            onClick={() => setExpanded(isOpen ? null : key)}>
                            {isOpen ? "Less" : "More"}
                          </button>
                          <button type="button" className="btn btn-sm" onClick={() => onOpen(s)}>
                            Open
                          </button>
                        </td>
                      </tr>
                      {isOpen && (
                        <tr key={key + ":more"} className="row-detail">
                          <td colSpan={cols.length + 1}>
                            <dl className="facts facts-wide">
                              <dt>Project</dt><dd>{s.project || "—"}</dd>
                              <dt>Session id</dt><dd><code>{s.session}</code></dd>
                              <dt>Tool calls</dt><dd>{fmtInt(s.toolCalls)}</dd>
                              <dt>Wall clock</dt><dd>{s.wallMs ? fmtDuration(s.wallMs) : "—"}</dd>
                              <dt>Idle gaps</dt>
                              <dd>
                                {s.idleGaps
                                  ? `${fmtInt(s.idleGaps)} · longest ${fmtDuration(s.longestGapMs)}`
                                  : "none over two minutes"}
                              </dd>
                              <dt>Peak context</dt><dd>{s.peakCtx ? fmtTokens(s.peakCtx) : "unknown"}</dd>
                              <dt>Largest increase</dt>
                              <dd>{s.jumpBy ? "+" + fmtTokens(s.jumpBy) : "—"}</dd>
                              <dt>Tokens</dt>
                              <dd>
                                {fmtTokens(s.input + s.cacheRead + s.cacheCreate)} in ·{" "}
                                {fmtTokens(s.output)} out
                              </dd>
                              <dt>Compactions</dt><dd>{s.compactions || "none"}</dd>
                              <dt>Delegations</dt>
                              <dd>
                                {s.delegations || "none"}
                                {s.delegations > 0 && (
                                  <span className="dim">
                                    {" "}· {fmtInt(s.agents?.length ?? 0)} run
                                    {(s.agents?.length ?? 0) === 1 ? "" : "s"} on disk
                                  </span>
                                )}
                              </dd>
                              <dt>Models</dt><dd>{s.models.length ? s.models.join(", ") : "—"}</dd>
                              <dt>Writer</dt><dd>{s.versions.length ? s.versions.join(", ") : "—"}</dd>
                              <dt>File</dt>
                              <dd>
                                {fmtBytes(s.bytes)} · {fmtInt(s.lines)} lines
                                {s.badLines > 0 && ` · ${fmtInt(s.badLines)} unreadable`}
                              </dd>
                              <dt>Context</dt>
                              <dd><Spark profile={s.ctxProfile} peak={s.peakCtx} scale={scale} /></dd>
                            </dl>
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })}
              </tbody>
            </table>

            <p className="ov-foot">
              Statistics only. Sparklines share one vertical scale, so the tallest line is the
              session that grew the most context of any of them.
              {local && (
                <>
                  {" "}Read <b>{fmtBytes(local.bytes)}</b> across {fmtInt(local.sessions.length)}{" "}
                  transcripts in <b>{(local.ms / 1000).toFixed(1)}s</b> — {fmtInt(local.indexed)}{" "}
                  parsed, {fmtInt(local.cached)} from the browser cache
                  {local.failed ? `, ${fmtInt(local.failed)} unreadable` : ""}.
                </>
              )}
              {cacheBytes > 0 && (
                <>
                  {" "}The cache holds {fmtBytes(cacheBytes)} in this browser&rsquo;s local
                  storage, keyed by size and modification time.{" "}
                  <button type="button" className="btn btn-sm"
                    onClick={() => { clearLocalCache(); setCacheBytes(0); }}>
                    Clear the cache
                  </button>
                  <span className="dim"> This removes the browser index only; no transcript is
                  touched.</span>
                </>
              )}
            </p>
          </>
        )}
      </div>
    </main>
  );
}
