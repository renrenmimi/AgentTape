"use client";

// The application. Owns the loaded session and the playhead; every view is a
// projection of those two things.
//
// Two rules shape this file.
//
// The playhead is a *global* step index rather than a position in the filtered
// view, so hiding bookkeeping records or turning a filter on does not move it.
// Each child converts as it needs to, through `shownIndex`.
//
// And view state is held here rather than inside the views. Going to Compare
// and back must not lose the step you were on, the filter you set, which
// messages you had expanded or which run B you had loaded — so those live in
// this component and the views are handed them. The alternative, keeping every
// view mounted and hidden, trades a real state model for a CSS trick and one
// of the two copies always ends up stale.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { pairTools } from "@/lib/parser";
import { loadJsonlBlob } from "@/lib/load";
import { tapeFromFile, serializeTape, type TapeFile } from "@/lib/tape";
import { redactTape } from "@/lib/redact";
import { fmtInt, summarise, traceJump } from "@/lib/summary";
import {
  EMPTY_FILTER, applyFilter, buildFilterIndex, entryMask, isActive, matchOrdinal, seek,
  type Filter,
} from "@/lib/filter";
import { DEFAULT_RULES, checkAll, type Rule } from "@/lib/assert";
import { markdownReport } from "@/lib/report";
import { factLine, keyEvents, leadEvents, recordNotes, type KeyEvent } from "@/lib/events";
import {
  agentIdFromName, findDelegations, pairBySidecar, pairByTime, summariseRun,
  type Delegation, type SubRun,
} from "@/lib/subagents";
import type { Tape } from "@/lib/format";
import { fileUrl, subagentUrl, type HelperAgent, type HelperSession, type SessionStats } from "./helper";
import Shell, { type ChecksSummary, type ViewName } from "./shell";
import Home from "./home";
import { OpenDialog, type OpenError, type Progress } from "./open-session";
import SessionOverview from "./session-overview";
import Replay, { type DetailTab, type LeftMode } from "./replay";
import Compare from "./compare";
import Checks from "./checks";
import AllSessions from "./all-sessions";
import Shortcuts from "./shortcuts";
import NestedWorkbench from "./nested-workbench";
import { useDialogFocus } from "./dialog";
import type { MenuItem } from "./menu";
import { armErrorTrap, runSelfTest } from "./selftest";

type SourceKind = "demo" | "file" | "helper";

const SOURCE_LABEL: Record<SourceKind, string> = {
  demo: "Demo",
  file: "Local file",
  helper: "Local helper",
};

const DEMO_HINT =
  "This is the demo. Start with a tool failure, then look at the context jump.";

export default function Page() {
  // ---- the session --------------------------------------------------------
  const [tape, setTape] = useState<Tape | null>(null);
  const [sourceKind, setSourceKind] = useState<SourceKind>("file");
  const [gpos, setGpos] = useState(0);
  const [showMeta, setShowMeta] = useState(false);
  const [filter, setFilter] = useState<Filter>(EMPTY_FILTER);
  const [subRuns, setSubRuns] = useState<Map<number, SubRun>>(() => new Map());
  // Set when the tape came from the helper, which knows where the rest of the
  // work is. A dropped transcript has no such handle.
  const [origin, setOrigin] = useState<{ project: string; session: string; agents: HelperAgent[] } | null>(null);
  const [subLoading, setSubLoading] = useState(-1);
  const [subError, setSubError] = useState("");
  const [rules, setRules] = useState<Rule[]>(DEFAULT_RULES);

  // ---- where you are ------------------------------------------------------
  const [view, setView] = useState<ViewName>("overview");
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [openDialog, setOpenDialog] = useState(false);
  const [checksOpen, setChecksOpen] = useState(false);
  const [keysOpen, setKeysOpen] = useState(false);
  const [inside, setInside] = useState(-1);
  const [visitedReplay, setVisitedReplay] = useState(false);
  const [hintOff, setHintOff] = useState(false);
  /**
   * Bumped whenever a session opens or closes.
   *
   * Activating a control that replaces the whole page destroys the control:
   * the button a keyboard user pressed is gone, focus falls back to `<body>`,
   * and the next Tab starts again from the top of the document. Moving focus
   * to the heading of what arrived is the difference between landing
   * somewhere and being put back at the door.
   */
  const [landed, setLanded] = useState(0);

  // ---- replay state, held here so leaving and coming back keeps it --------
  const [leftMode, setLeftMode] = useState<LeftMode>("steps");
  const [tab, setTab] = useState<DetailTab>("details");
  const [entriesOpen, setEntriesOpen] = useState<Set<number>>(() => new Set());
  const [follow, setFollow] = useState(true);
  const [revealKey, setRevealKey] = useState(0);
  const [compareB, setCompareB] = useState<Tape | null>(null);

  // ---- loading ------------------------------------------------------------
  const [offer, setOffer] = useState<{ file: File; attached: number } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<OpenError | null>(null);
  const [exporting, setExporting] = useState(false);
  const [flash, setFlash] = useState("");
  const [copyFallback, setCopyFallback] = useState<string | null>(null);
  /**
   * Which load is the current one.
   *
   * A slow parse followed by a second choice used to be a race the first file
   * could win: the reader finished later and adopted its result over the one
   * the user actually asked for. Every load takes a ticket and only the
   * holder of the current ticket is allowed to change what is on screen.
   */
  const loadToken = useRef(0);

  // ---- derived ------------------------------------------------------------

  const stepView = useMemo(() => {
    if (!tape) return null;
    const steps = showMeta ? tape.steps : tape.steps.filter((s) => s.kind !== "meta");
    const at = new Int32Array(tape.steps.length).fill(-1);
    steps.forEach((s, k) => { at[s.i] = k; });
    return { steps, at };
  }, [tape, showMeta]);

  const pairs = useMemo(() => (tape ? pairTools(tape.steps) : new Map<number, number>()), [tape]);
  const summary = useMemo(() => (tape ? summarise(tape) : null), [tape]);

  // Built once per tape: lowercasing ten thousand previews on every keystroke
  // is the difference between a filter that keeps up with typing and one that
  // does not.
  const filterIndex = useMemo(
    () => (tape ? buildFilterIndex(tape.steps, pairs) : null),
    [tape, pairs],
  );

  const assertions = useMemo(
    () => (tape ? checkAll(tape.steps, rules, pairs) : []),
    [tape, rules, pairs],
  );

  const jumpTrace = useMemo(
    () => (tape && summary ? traceJump(tape.steps, summary.jumpAt, summary.jumpBy) : null),
    [tape, summary],
  );

  const filtering = isActive(filter);
  const { mask, count: matches } = useMemo(() => {
    if (!stepView || !filterIndex) return { mask: new Uint8Array(0), count: 0 };
    return applyFilter(stepView.steps, filterIndex, filter);
  }, [stepView, filterIndex, filter]);

  /** Nearest visible view position for a global step index. */
  const viewIndexOf = useCallback(
    (gi: number): number => {
      if (!stepView || !tape) return 0;
      const clamped = Math.max(0, Math.min(tape.steps.length - 1, gi));
      if (stepView.at[clamped] >= 0) return stepView.at[clamped];
      for (let d = 1; d < tape.steps.length; d++) {
        const a = clamped - d;
        const b = clamped + d;
        if (a >= 0 && stepView.at[a] >= 0) return stepView.at[a];
        if (b < stepView.at.length && stepView.at[b] >= 0) return stepView.at[b];
      }
      return 0;
    },
    [stepView, tape],
  );

  const pos = stepView ? viewIndexOf(gpos) : 0;
  const curGlobal = stepView && stepView.steps.length
    ? stepView.steps[Math.min(pos, stepView.steps.length - 1)].i
    : 0;

  const setPos = useCallback(
    (k: number) => {
      if (!stepView || !stepView.steps.length) return;
      const clamped = Math.max(0, Math.min(stepView.steps.length - 1, k));
      setGpos(stepView.steps[clamped].i);
    },
    [stepView],
  );

  const goToGlobal = useCallback((gi: number) => {
    setGpos(gi);
    setRevealKey((k) => k + 1);
  }, []);

  const ordinal = useMemo(
    () => (filtering && stepView ? matchOrdinal(mask, pos) : 0),
    [filtering, stepView, mask, pos],
  );
  const entryHits = useMemo(
    () => (filtering && stepView && tape ? entryMask(tape.entries.length, stepView.steps, mask) : null),
    [filtering, stepView, tape, mask],
  );

  const delegations = useMemo<Delegation[]>(() => {
    if (!tape) return [];
    return findDelegations(tape.steps, pairs).map((d) => ({ ...d, run: subRuns.get(d.step) ?? null }));
  }, [tape, pairs, subRuns]);

  const delegatedMask = useMemo(() => {
    if (!stepView || !delegations.length) return null;
    const at = new Set(delegations.map((d) => d.step));
    const out = new Uint8Array(stepView.steps.length);
    stepView.steps.forEach((s, k) => { if (at.has(s.i)) out[k] = 1; });
    return out;
  }, [stepView, delegations]);

  const curDelegation = useMemo(
    () => delegations.find((d) => d.step === curGlobal) ?? null,
    [delegations, curGlobal],
  );

  /** The number a step is called on screen: its position in the visible view. */
  const shownIndex = useCallback(
    (gi: number) => (stepView && stepView.at[gi] >= 0 ? stepView.at[gi] + 1 : 0),
    [stepView],
  );

  const allEvents = useMemo(
    () => (tape && summary ? keyEvents(tape, summary, pairs) : []),
    [tape, summary, pairs],
  );
  // The delegated runs that have been attached change what a delegation event
  // says, so the lead list is derived from the full list rather than cached.
  const events = useMemo(() => leadEvents(allEvents), [allEvents]);
  const notes = useMemo(
    () => (tape && summary ? recordNotes(tape, summary, pairs) : []),
    [tape, summary, pairs],
  );

  /**
   * n and p. With no filter they step through failures, which is what they
   * have always done; with a filter they step through matches, because that is
   * what you were looking at when you pressed the key.
   */
  const seekNext = useCallback(
    (dir: 1 | -1) => {
      if (!stepView || !stepView.steps.length) return;
      if (filtering) {
        const hit = seek(mask, pos, dir);
        if (hit >= 0) { setPos(hit); setRevealKey((k) => k + 1); }
        return;
      }
      for (let i = pos + dir; i >= 0 && i < stepView.steps.length; i += dir) {
        if (stepView.steps[i].err) { setPos(i); setRevealKey((k) => k + 1); return; }
      }
    },
    [stepView, filtering, mask, pos, setPos],
  );

  /** Compactions in view order, so the chart marks and the jump agree. */
  const compactions = useMemo(
    () => (stepView && summary ? summary.compactAt.map((i) => stepView.at[i]).filter((i) => i >= 0) : []),
    [stepView, summary],
  );

  const jumpCompaction = useCallback(() => {
    if (!compactions.length) return;
    setPos(compactions.find((i) => i > pos) ?? compactions[0]);
    setRevealKey((k) => k + 1);
  }, [compactions, pos, setPos]);

  // ---- navigation ---------------------------------------------------------

  const goToView = useCallback((v: ViewName) => {
    setSessionsOpen(false);
    setView(v);
    if (v === "replay") setVisitedReplay(true);
  }, []);

  /** A jump from somewhere else: land on the step, in the right subview. */
  const inspect = useCallback((globalIndex: number, want: DetailTab = "details") => {
    setSessionsOpen(false);
    setGpos(globalIndex);
    setTab(want);
    setView("replay");
    setVisitedReplay(true);
    setRevealKey((k) => k + 1);
    // Focus the panel that now holds the evidence, so a keyboard user is where
    // the answer is rather than back at the top of the page.
    window.setTimeout(() => {
      document.getElementById("detail-panel")?.focus();
    }, 0);
  }, []);

  const onEvent = useCallback(
    (e: KeyEvent) => inspect(e.step, e.target === "context" ? "context" : "details"),
    [inspect],
  );

  // ---- loading ------------------------------------------------------------

  const reset = useCallback(() => {
    loadToken.current++;
    setTape(null);
    setGpos(0);
    setFilter(EMPTY_FILTER);
    setError(null);
    setProgress(null);
    setSubRuns(new Map());
    setOrigin(null);
    setSubError("");
    setSubLoading(-1);
    setInside(-1);
    setCompareB(null);
    setView("overview");
    setVisitedReplay(false);
    setEntriesOpen(new Set());
    setTab("details");
    setLeftMode("steps");
    setChecksOpen(false);
    setSessionsOpen(false);
    setLanded((k) => k + 1);
  }, []);

  const adopt = useCallback((t: Tape, kind: SourceKind) => {
    setTape(t);
    setSourceKind(kind);
    setGpos(0);
    setFilter(EMPTY_FILTER);
    setProgress(null);
    setError(null);
    setSubRuns(new Map());
    setSubError("");
    setSubLoading(-1);
    setInside(-1);
    setCompareB(null);
    setEntriesOpen(new Set());
    setTab("details");
    setLeftMode("steps");
    setVisitedReplay(false);
    setHintOff(false);
    // Everything arrives at the overview, whether it came from the landing
    // page, the global Open button or the session index.
    setView("overview");
    setSessionsOpen(false);
    setOpenDialog(false);
    setLanded((k) => k + 1);
  }, []);

  const loadTapeJson = useCallback(
    async (text: string, label: string, kind: SourceKind, ticket: number): Promise<Tape> => {
      const parsed = JSON.parse(text) as TapeFile;
      const t = tapeFromFile(parsed);
      t.meta.label = t.meta.label || label;
      if (ticket === loadToken.current) adopt(t, kind);
      return t;
    },
    [adopt],
  );

  const loadBlob = useCallback(
    async (blob: Blob, label: string, kind: SourceKind, ticket: number): Promise<Tape | null> => {
      if (blob.size === 0) {
        setProgress(null);
        setError({ text: `${label} is empty — there is nothing in it to read.` });
        return null;
      }
      setError(null);
      setProgress({ label, lines: 0, bytes: 0, total: blob.size });
      try {
        const t = await loadJsonlBlob(blob, label, (p) => {
          if (ticket !== loadToken.current) return;
          setProgress({ label, lines: p.lines, bytes: p.bytes, total: p.total });
        });
        if (ticket !== loadToken.current) return null;
        if (t.steps.length === 0) {
          setProgress(null);
          setError({
            text: `Nothing in ${label} looked like a Claude Code transcript record.`,
            detail: `${fmtInt(t.meta.lines)} lines read, ${fmtInt(t.meta.badLines)} of which ` +
              "could not be parsed as JSON.",
          });
          return null;
        }
        adopt(t, kind);
        return t;
      } catch (e) {
        if (ticket !== loadToken.current) return null;
        setProgress(null);
        setError({
          text: `${label} could not be read as a transcript or a tape.`,
          detail: e instanceof Error ? e.message : String(e),
        });
        return null;
      }
    },
    [adopt],
  );

  /**
   * Index a subagent file and hang it on the delegation it belongs to.
   *
   * `toolUseId` comes from the sidecar when there is one and is exact. Without
   * it the pairing is by time: a subagent runs strictly between its call and
   * that call's result, which identified the right parent for all sixteen
   * files in the large fixture with no ambiguity. Where the window is
   * ambiguous this refuses rather than guessing, and the file stays unattached.
   */
  const attachSubagent = useCallback(
    async (blob: Blob, agentId: string, toolUseId: string, dels: Delegation[]) => {
      const sub = await loadJsonlBlob(blob, agentId, undefined);
      const first = sub.steps.find((s) => s.t)?.t ?? 0;
      let at = toolUseId ? pairBySidecar(dels, toolUseId) : -1;
      const how: SubRun["pairedBy"] = at >= 0 ? "sidecar" : "time";
      if (at < 0) at = pairByTime(dels, first);
      if (at < 0) return false;
      const run = summariseRun(sub, agentId, how);
      setSubRuns((prev) => new Map(prev).set(dels[at].step, run));
      return true;
    },
    [],
  );

  /**
   * Read a second run without disturbing the one on screen. The comparison
   * holds it itself, so nothing here calls adopt().
   */
  const readTape = useCallback(async (blob: Blob, label: string): Promise<Tape | null> => {
    const name = label.toLowerCase();
    if (!name.endsWith(".jsonl")) {
      try {
        const parsed = JSON.parse(await blob.text()) as TapeFile;
        const t = tapeFromFile(parsed);
        t.meta.label = t.meta.label || label;
        return t;
      } catch {
        /* not a tape: fall through and try it as a transcript */
      }
    }
    try {
      const t = await loadJsonlBlob(blob, label);
      return t.steps.length ? t : null;
    } catch {
      return null;
    }
  }, []);

  const compareFromFile = useCallback((f: File) => readTape(f, f.name), [readTape]);

  const compareFromHelper = useCallback(
    async (session: HelperSession): Promise<Tape | null> => {
      const res = await fetch(fileUrl(session));
      if (!res.ok) throw new Error(`the helper returned ${res.status}`);
      return readTape(await res.blob(), session.session.slice(0, 8) + ".jsonl");
    },
    [readTape],
  );

  const compareFromDemo = useCallback(async (): Promise<Tape | null> => {
    const res = await fetch("./demo.tape.json");
    if (!res.ok) throw new Error(`the demo tape returned ${res.status}`);
    const t = tapeFromFile(JSON.parse(await res.text()) as TapeFile);
    t.meta.label = t.meta.label || "demo";
    return t;
  }, []);

  const onFiles = useCallback(
    async (files: File[]) => {
      const ticket = ++loadToken.current;
      setError(null);
      const subs = files.filter((f) => agentIdFromName(f.name) !== "");
      const sidecars = new Map<string, string>();
      for (const f of files) {
        const m = /^agent-([A-Za-z0-9_-]+)\.meta\.json$/.exec(f.name);
        if (!m) continue;
        try {
          // Two fields exist here; `description` is prose about the user's work
          // and is never read.
          const meta = JSON.parse(await f.text()) as { toolUseId?: unknown };
          if (typeof meta.toolUseId === "string") sidecars.set(m[1], meta.toolUseId);
        } catch {
          /* an unreadable sidecar just means pairing falls back to time */
        }
      }
      const main = files.find((f) => agentIdFromName(f.name) === "" && !/\.meta\.json$/.test(f.name));
      if (!main) {
        setError({
          text: "That drop held only subagent files. Add the session's own .jsonl and they will " +
            "be attached to the calls that delegated to them.",
        });
        return;
      }

      const name = main.name.toLowerCase();
      if (!/\.(jsonl|json)$/.test(name)) {
        setError({
          text: `${main.name} is not a supported file. This reads .jsonl transcripts and ` +
            ".tape.json exports.",
        });
        return;
      }

      let loaded: Tape | null = null;
      if (name.endsWith(".jsonl")) {
        loaded = await loadBlob(main, main.name, "file", ticket);
      } else {
        // A .json that is not a tape is still worth trying as JSONL rather than
        // refusing on the strength of a file extension.
        setProgress({ label: main.name, lines: 0, bytes: 0, total: main.size });
        try {
          loaded = await loadTapeJson(await main.text(), main.name, "file", ticket);
        } catch {
          loaded = await loadBlob(main, main.name, "file", ticket);
        }
      }
      if (!loaded || !subs.length || ticket !== loadToken.current) return;

      const dels = findDelegations(loaded.steps, pairTools(loaded.steps));
      let attached = 0;
      for (const f of subs) {
        const id = agentIdFromName(f.name);
        if (await attachSubagent(f, id, sidecars.get(id) ?? "", dels)) attached++;
      }
      if (attached < subs.length) {
        setSubError(
          `${subs.length - attached} of ${subs.length} subagent files could not be matched to a ` +
          "call in this transcript.",
        );
      }
    },
    [loadBlob, loadTapeJson, attachSubagent],
  );

  const onHelperPick = useCallback(
    async (session: HelperSession) => {
      const ticket = ++loadToken.current;
      const label = session.session.slice(0, 8);
      setError(null);
      setProgress({ label, lines: 0, bytes: session.bytes, total: session.bytes });
      try {
        const res = await fetch(fileUrl(session));
        if (!res.ok) throw new Error(`the helper returned ${res.status}`);
        const t = await loadBlob(await res.blob(), label, "helper", ticket);
        if (t && ticket === loadToken.current) {
          setOrigin({ project: session.project, session: session.session, agents: session.agents ?? [] });
        }
      } catch (e) {
        if (ticket !== loadToken.current) return;
        setProgress(null);
        setError({
          text: "That session could not be read from the local helper.",
          detail: e instanceof Error ? e.message : String(e),
        });
      }
    },
    [loadBlob],
  );

  /** Fetch one delegated run from the helper, on demand. */
  const loadSubagent = useCallback(
    async (d: Delegation) => {
      if (!origin) return;
      const agent = origin.agents.find((a) => a.toolUseId === d.toolUseId);
      if (!agent) { setSubError("The helper does not have a file for this call."); return; }
      setSubLoading(d.step);
      setSubError("");
      try {
        const res = await fetch(subagentUrl(origin, agent.id));
        if (!res.ok) throw new Error(`the helper returned ${res.status}`);
        const ok = await attachSubagent(await res.blob(), agent.id, agent.toolUseId, delegations);
        if (!ok) setSubError("That file could not be matched to this call.");
      } catch (e) {
        setSubError(e instanceof Error ? e.message : String(e));
      } finally {
        setSubLoading(-1);
      }
    },
    [origin, delegations, attachSubagent],
  );

  const onDemo = useCallback(async () => {
    const ticket = ++loadToken.current;
    setError(null);
    setProgress({ label: "the demo", lines: 0, bytes: 0, total: 0 });
    try {
      const res = await fetch("./demo.tape.json");
      if (!res.ok) throw new Error(`the demo tape returned ${res.status}`);
      const text = await res.text();
      if (ticket !== loadToken.current) return;
      await loadTapeJson(text, "demo", "demo", ticket);
    } catch (e) {
      if (ticket !== loadToken.current) return;
      setProgress(null);
      setError({
        text: "The demo tape could not be loaded.",
        detail: e instanceof Error ? e.message : String(e),
      });
    }
  }, [loadTapeJson]);

  // ---- export -------------------------------------------------------------

  /**
   * The session, written down. Structure and counts only, which is a property
   * of lib/report.ts rather than of this handler — it is never given a body.
   */
  const onReport = useCallback(async () => {
    if (!tape || !summary) return;
    const text = markdownReport({
      tape, summary, trace: jumpTrace, delegations, assertions, pairs, shownIndex,
    });
    try {
      await navigator.clipboard.writeText(text);
      setFlash("The Markdown summary is on the clipboard.");
    } catch {
      // Clipboard permission is not guaranteed and a toast that says "Copied"
      // when nothing was copied is worse than no toast. Show the text instead,
      // ready to select.
      setCopyFallback(text);
    }
  }, [tape, summary, jumpTrace, delegations, assertions, pairs, shownIndex]);

  const onExport = useCallback(async () => {
    if (!tape) return;
    setExporting(true);
    try {
      // redactTape reads the index only. tape.body — the one function that can
      // reach the transcript — is never called on this path.
      const file = redactTape(tape);
      const blob = new Blob([serializeTape(file)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "session.tape.json";
      a.click();
      URL.revokeObjectURL(url);
      setFlash("Downloaded session.tape.json — structure and counts, no message text.");
    } finally {
      setExporting(false);
    }
  }, [tape]);

  const exportItems: MenuItem[] = tape
    ? [
      {
        label: "Copy Markdown summary",
        note: "counts and structure, no message text",
        onSelect: () => { void onReport(); },
      },
      {
        label: "Download redacted tape",
        note: "session.tape.json — safe to attach to a bug report",
        onSelect: () => { void onExport(); },
        disabled: exporting,
      },
    ]
    : [];

  /**
   * Files dropped while a session is already open.
   *
   * Subagent files pair straight into the run on screen; a transcript is
   * ambiguous, so it asks rather than guessing.
   */
  const onDropWhileLoaded = useCallback(
    async (files: File[]) => {
      if (!tape) return;
      setSubError("");
      const subs = files.filter((f) => agentIdFromName(f.name) !== "");
      const main = files.find(
        (f) => agentIdFromName(f.name) === "" && !/\.meta\.json$/.test(f.name),
      );

      let attached = 0;
      if (subs.length) {
        const dels = findDelegations(tape.steps, pairs);
        for (const f of subs) {
          if (await attachSubagent(f, agentIdFromName(f.name), "", dels)) attached++;
        }
        if (attached < subs.length) {
          setSubError(
            `${subs.length - attached} of ${subs.length} subagent files did not match a call in ` +
            "this run.",
          );
        }
      }
      if (main) setOffer({ file: main, attached });
      else if (!subs.length) setSubError("Nothing in that drop looked like a transcript.");
    },
    [tape, pairs, attachSubagent],
  );

  // ---- keyboard -----------------------------------------------------------

  const anyOverlay = keysOpen || checksOpen || openDialog || inside >= 0 || !!offer || !!copyFallback;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Not a cast. A keydown dispatched on `window` rather than typed into an
      // element — which is what a programmatic shortcut looks like — has a
      // target that is not an element at all, and `closest` throws on it.
      const t = e.target instanceof HTMLElement ? e.target : null;
      const tag = t?.tagName;
      const typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" ||
        t?.isContentEditable === true;

      // Escape closes the topmost thing, from anywhere including a text box.
      if (e.key === "Escape") {
        if (keysOpen) { setKeysOpen(false); e.preventDefault(); }
        else if (copyFallback) { setCopyFallback(null); e.preventDefault(); }
        else if (offer) { setOffer(null); e.preventDefault(); }
        else if (openDialog) { setOpenDialog(false); e.preventDefault(); }
        else if (inside >= 0) { setInside(-1); e.preventDefault(); }
        else if (checksOpen) { setChecksOpen(false); e.preventDefault(); }
        else if (typing) (t as HTMLInputElement).blur();
        return;
      }
      if (typing) return;

      // While a layer is up it owns the keyboard; only "?" gets through.
      if (anyOverlay) {
        if (e.key === "?") { setKeysOpen((v) => !v); e.preventDefault(); }
        return;
      }
      if (e.key === "?") { setKeysOpen(true); e.preventDefault(); return; }
      if (!tape) return;

      if (e.key === "c" || e.key === "C") { e.preventDefault(); goToView("compare"); return; }
      if (e.key === "a" || e.key === "A") { e.preventDefault(); setChecksOpen(true); return; }
      if (e.key === "/") {
        e.preventDefault();
        goToView("replay");
        setLeftMode("steps");
        window.setTimeout(() => {
          document.querySelector<HTMLInputElement>("input.filter-input")?.focus();
        }, 0);
        return;
      }

      if (view !== "replay" || sessionsOpen) return;
      // The rail, the chart and the list own their own arrow keys.
      if (t?.closest(".track-hit, .chart-hit, [role='listbox']")) return;
      if (!stepView || !stepView.steps.length) return;

      const n = stepView.steps.length;
      const big = e.shiftKey ? 10 : 1;
      let next = pos;
      if (e.key === "ArrowRight") next = pos + big;
      else if (e.key === "ArrowLeft") next = pos - big;
      else if (e.key === "PageDown") next = pos + 50;
      else if (e.key === "PageUp") next = pos - 50;
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = n - 1;
      else if (e.key === "n" || e.key === "N" || e.key === "p" || e.key === "P") {
        e.preventDefault();
        seekNext(e.key === "n" || e.key === "N" ? 1 : -1);
        return;
      } else return;
      e.preventDefault();
      setPos(Math.max(0, Math.min(n - 1, next)));
      setRevealKey((k) => k + 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    tape, stepView, pos, setPos, seekNext, keysOpen, checksOpen, openDialog, inside, offer,
    copyFallback, anyOverlay, view, sessionsOpen, goToView,
  ]);

  // The heading of whatever just arrived, once it is on screen. Runs in the
  // commit that rendered it, because `landed` changes in the same batch.
  useEffect(() => {
    if (!landed) return;
    document.querySelector<HTMLElement>(".view-title, .home-title")?.focus();
  }, [landed]);

  // A status message is news, not furniture: it goes away.
  useEffect(() => {
    if (!flash) return;
    const id = window.setTimeout(() => setFlash(""), 6000);
    return () => window.clearTimeout(id);
  }, [flash]);

  // ---- self test ----------------------------------------------------------

  useEffect(() => {
    if (typeof window === "undefined") return;
    const flags = new URLSearchParams(window.location.search);
    const selftest = flags.has("selftest");
    // ?debug=1 exposes the handle without running the suite, so a measurement
    // harness can drive a real tape instead of the synthetic one.
    if (!selftest && !flags.has("debug")) return;
    const api = {
      get tape() { return tape; },
      get view() { return stepView; },
      get pos() { return pos; },
      get gpos() { return gpos; },
      setPos,
      goToGlobal,
      onDemo,
      onExport,
      setShowMeta,
      get filter() { return filter; },
      setFilter,
      get matches() { return matches; },
      get mask() { return mask; },
      seekNext,
      get where() { return sessionsOpen ? "sessions" : view; },
      goToView,
      setSessionsOpen,
      get tab() { return tab; },
      setTab,
      get leftMode() { return leftMode; },
      setLeftMode,
      setChecksOpen,
      get checksOpen() { return checksOpen; },
      setKeysOpen,
      get keysOpen() { return keysOpen; },
      setInside,
      // The self-test has no subagent file on disk, so it needs a way to hang a
      // run on a delegation. Behind the flag, like everything else here.
      attachSyntheticRun: () => {
        const d = delegations[0];
        if (!d) return;
        const sub = tapeFromFile({
          format: "agenttape/1", redacted: false, label: "synthetic subagent",
          session: { id: "", bytes: 0, lines: 6, badLines: 0, versions: [] }, fields: {},
          steps: Array.from({ length: 6 }, (_, i) => ({
            k: i % 2 === 0 ? "tool-call" : "tool-result",
            y: i % 2 === 0 ? "assistant" : "user",
            r: i % 2 === 0 ? "assistant" : "user",
            ts: d.from + i * 1000, c: 40 + i, b: 0, p: "synthetic subagent step " + i,
            x: 1000 + i * 100,
            ...(i % 2 === 0 ? { n: "Bash", u: "st" + i, m: "sm" + i } : { u: "st" + (i - 1) }),
          })),
        });
        setSubRuns((prev) => new Map(prev).set(d.step, summariseRun(sub, "synthetic", "manual")));
      },
      get assertions() { return assertions; },
      get rules() { return rules; },
      setRules,
      get events() { return allEvents; },
      // Behind the flag: the native folder picker cannot be driven headlessly,
      // so a harness needs a way to hand the same Files to the same indexer.
      indexFiles: async (files: File[]) => {
        const { buildLocalIndex, collectFromFiles } = await import("./local-index");
        return buildLocalIndex(collectFromFiles(files));
      },
      pickerSupport: async () => (await import("./local-index")).pickerSupport(),
      reportText: () => (tape && summary
        ? markdownReport({ tape, summary, trace: jumpTrace, delegations, assertions, pairs, shownIndex })
        : ""),
      get delegations() { return delegations; },
      get origin() { return origin; },
      loadSubagent,
      loadTapeFile: (f: TapeFile) => adopt(tapeFromFile(f), "file"),
    };
    (window as unknown as Record<string, unknown>).__agenttape = api;
  }, [
    tape, stepView, pos, gpos, setPos, goToGlobal, onDemo, onExport, adopt, filter, matches, mask,
    seekNext, delegations, origin, loadSubagent, assertions, rules, keysOpen, checksOpen,
    jumpTrace, shownIndex, summary, view, sessionsOpen, goToView, tab, leftMode, allEvents, pairs,
  ]);

  /**
   * Start the suite once, from an effect that has nothing to re-run for.
   *
   * It used to be scheduled inside the effect above, whose dependency list is
   * every piece of state on this page. That effect re-runs constantly, and each
   * run cleared the pending timeout and set a new one — harmless while the
   * suite was idle, and not harmless at all once it had started: the suite
   * changes state, the state change re-runs the effect, and four hundred
   * milliseconds later a *second* suite began, then a third, then a fourth.
   */
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!new URLSearchParams(window.location.search).has("selftest")) return;
    // Armed before the suite starts, so a throw during the first render is
    // collected rather than missed.
    armErrorTrap();
    const id = window.setTimeout(() => { void runSelfTest(); }, 400);
    return () => window.clearTimeout(id);
  }, []);

  // ---- render -------------------------------------------------------------

  const checksSummary: ChecksSummary | null = tape
    ? {
      pass: assertions.filter((r) => r.pass).length,
      fail: assertions.filter((r) => !r.pass).length,
      vacuous: assertions.filter((r) => r.vacuous).length,
      total: assertions.length,
    }
    : null;

  const insideRun = inside >= 0 ? subRuns.get(inside) ?? null : null;

  const shell = (
    <Shell
      sessionLabel={tape ? tape.meta.label : ""}
      sourceLabel={tape ? (tape.meta.redacted ? "Redacted tape" : SOURCE_LABEL[sourceKind]) : ""}
      view={tape && !sessionsOpen ? view : null}
      onView={goToView}
      onOpen={() => setOpenDialog(true)}
      onSessions={() => setSessionsOpen(true)}
      onShortcuts={() => setKeysOpen(true)}
      onFormat={() => { window.location.href = "/format"; }}
      checks={checksSummary}
      onChecks={() => setChecksOpen(true)}
      exportItems={exportItems}
      exporting={exporting}
      onCloseSession={reset}
    />
  );

  const layers = (
    <>
      {flash && (
        <div className="flash" role="status">
          <span>{flash}</span>
          <button type="button" className="btn btn-sm" onClick={() => setFlash("")}>Dismiss</button>
        </div>
      )}
      {openDialog && (
        <OpenDialog
          lead="file"
          onClose={() => setOpenDialog(false)}
          onFiles={onFiles}
          onDemo={() => { void onDemo(); }}
          progress={progress}
          error={error}
          replacing={!!tape}
        />
      )}
      {copyFallback !== null && (
        <CopyFallback text={copyFallback} onClose={() => setCopyFallback(null)} />
      )}
      {keysOpen && <Shortcuts onClose={() => setKeysOpen(false)} />}
    </>
  );

  if (!tape || !stepView || !summary) {
    return (
      <>
        <a className="skip" href="#main">Skip to content</a>
        {shell}
        {layers}
        {sessionsOpen ? (
          <AllSessions
            backLabel="the start"
            onBack={() => setSessionsOpen(false)}
            onOpen={(s: SessionStats) => {
              setSessionsOpen(false);
              void onHelperPick({
                project: s.project, session: s.session, bytes: s.bytes, lines: s.lines,
                tools: s.toolCalls, mtime: s.mtime, agents: s.agents ?? [],
              });
            }}
          />
        ) : (
          <Home
            onFiles={onFiles}
            onDemo={() => { void onDemo(); }}
            onBrowseLocal={() => setSessionsOpen(true)}
            progress={progress}
            error={error}
          />
        )}
      </>
    );
  }

  return (
    <div
      className={
        // `app-fixed` is what gives Replay its two independent scroll regions.
        // Every other view is ordinary page flow, and does not get the class.
        "app" +
        (view === "replay" && !sessionsOpen ? " app-fixed" : "") +
        (dragOver ? " app-drop" : "")
      }
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        setDragOver(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragOver(false);
        void onDropWhileLoaded([...e.dataTransfer.files]);
      }}
    >
      <a className="skip" href="#main">Skip to content</a>
      {shell}
      {layers}

      {dragOver && (
        <div className="drop-hint" aria-hidden>
          <b>Drop to add</b>
          <span>
            <code>agent-*.jsonl</code> pairs into this run · a transcript asks whether to open it
            or compare with it
          </span>
        </div>
      )}

      {offer && (
        <DropOffer
          attached={offer.attached}
          onCancel={() => setOffer(null)}
          onOpen={() => { const f = offer.file; setOffer(null); void onFiles([f]); }}
          onCompare={() => {
            const f = offer.file;
            setOffer(null);
            void (async () => {
              const t = await compareFromFile(f);
              if (t) { setCompareB(t); goToView("compare"); }
            })();
          }}
        />
      )}

      {insideRun && (
        <NestedWorkbench
          run={insideRun}
          parentStep={shownIndex(inside) || inside + 1}
          parentLabel={tape.meta.label}
          onClose={() => setInside(-1)}
        />
      )}

      {checksOpen && (
        <Checks
          steps={tape.steps}
          tools={filterIndex ? filterIndex.tools.map((t) => t.name) : []}
          rules={rules}
          onRules={setRules}
          pairs={pairs}
          shownIndex={shownIndex}
          onGo={(i) => { setChecksOpen(false); inspect(i, "details"); }}
          onClose={() => setChecksOpen(false)}
        />
      )}

      {sessionsOpen ? (
        <AllSessions
          backLabel={tape.meta.label || "this session"}
          onBack={() => setSessionsOpen(false)}
          onOpen={(s: SessionStats) => {
            setSessionsOpen(false);
            void onHelperPick({
              project: s.project, session: s.session, bytes: s.bytes, lines: s.lines,
              tools: s.toolCalls, mtime: s.mtime, agents: s.agents ?? [],
            });
          }}
        />
      ) : view === "overview" ? (
        <SessionOverview
          tape={tape}
          summary={summary}
          events={events}
          eventTotal={allEvents.length}
          notes={notes}
          facts={factLine(summary)}
          sourceLabel={tape.meta.redacted ? "Redacted tape" : SOURCE_LABEL[sourceKind]}
          shownIndex={shownIndex}
          atStep={shownIndex(curGlobal) || pos + 1}
          visited={visitedReplay}
          onExplore={() => goToView("replay")}
          onEvent={onEvent}
          onAllEvents={() => inspect(events[0]?.step ?? curGlobal, "details")}
          onContext={() => inspect(
            summary.jumpBy > 0 ? summary.jumpAt : curGlobal, "context")}
          hint={sourceKind === "demo" && !hintOff ? DEMO_HINT : ""}
          onDismissHint={() => setHintOff(true)}
        />
      ) : view === "compare" ? (
        <Compare
          a={tape}
          b={compareB}
          onSetB={setCompareB}
          onLoadB={compareFromFile}
          onLoadBFromHelper={compareFromHelper}
          onLoadDemo={compareFromDemo}
        />
      ) : (
        <Replay
          title="Replay"
          tape={tape}
          steps={stepView.steps}
          pos={pos}
          onPos={setPos}
          curGlobal={curGlobal}
          pairs={pairs}
          shownIndex={shownIndex}
          onSelectStep={goToGlobal}
          summary={summary}
          trace={jumpTrace}
          compactions={compactions}
          jumpAt={stepView.at[summary.jumpAt] >= 0 ? stepView.at[summary.jumpAt] : 0}
          fellAtShown={jumpTrace && jumpTrace.fellAt >= 0 ? shownIndex(jumpTrace.fellAt) : 0}
          leftMode={leftMode}
          onLeftMode={setLeftMode}
          tab={tab}
          onTab={setTab}
          filter={filter}
          onFilter={setFilter}
          filterIndex={filterIndex}
          matches={matches}
          mask={mask}
          ordinal={ordinal}
          onSeek={seekNext}
          onJumpCompaction={jumpCompaction}
          metaSteps={summary.metaSteps}
          showMeta={showMeta}
          onShowMeta={setShowMeta}
          delegatedMask={delegatedMask}
          delegation={curDelegation}
          onLoadSubagent={
            curDelegation && origin && !curDelegation.run
              ? () => { void loadSubagent(curDelegation); }
              : null
          }
          subLoading={subLoading === curGlobal}
          subError={curDelegation && !curDelegation.run ? subError : ""}
          offeredBytes={
            origin?.agents.find((a) => a.toolUseId === curDelegation?.toolUseId)?.bytes ?? 0
          }
          onEnterSubagent={curDelegation?.run ? () => setInside(curDelegation.step) : undefined}
          entryHits={entryHits}
          entriesOpen={entriesOpen}
          onEntriesOpen={setEntriesOpen}
          follow={follow}
          onFollow={setFollow}
          revealKey={revealKey}
        />
      )}
    </div>
  );
}

/** What to do with a transcript dropped onto a session that is already open. */
function DropOffer({
  attached, onCancel, onOpen, onCompare,
}: { attached: number; onCancel: () => void; onOpen: () => void; onCompare: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useDialogFocus(box);
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="drop-title"
        tabIndex={-1} ref={box}>
        <div className="dialog-head">
          <h2 id="drop-title">A transcript came with that drop</h2>
          <span className="spacer" />
          <button type="button" className="btn btn-sm" onClick={onCancel}>Cancel</button>
        </div>
        <div className="dialog-body">
          {attached > 0 && (
            <p className="sec-lead">
              {fmtInt(attached)} delegated {attached === 1 ? "run" : "runs"} paired into the
              session on screen.
            </p>
          )}
          <p className="sec-lead">
            Open it in place of the current session, or keep the current one and compare the two?
          </p>
          <div className="dialog-actions">
            <button type="button" className="btn btn-primary" onClick={onOpen}>Open it</button>
            <button type="button" className="btn" onClick={onCompare}>Compare with it</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The clipboard refused. Here is the text; select it. */
function CopyFallback({ text, onClose }: { text: string; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  useDialogFocus(box);
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog dialog-wide" role="dialog" aria-modal="true"
        aria-labelledby="copy-title" tabIndex={-1} ref={box}>
        <div className="dialog-head">
          <h2 id="copy-title">Copy this summary</h2>
          <span className="spacer" />
          <button type="button" className="btn btn-sm" onClick={onClose}>Close</button>
        </div>
        <div className="dialog-body">
          <p className="sec-lead">
            This browser would not give the page clipboard access, so nothing has been copied.
            The summary is below — select it and copy it yourself.
          </p>
          <textarea
            ref={area}
            className="copy-area"
            readOnly
            value={text}
            aria-label="Markdown summary of this session"
            onFocus={(e) => e.currentTarget.select()}
          />
          <div className="dialog-actions">
            <button type="button" className="btn"
              onClick={() => { area.current?.focus(); area.current?.select(); }}>
              Select all
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
