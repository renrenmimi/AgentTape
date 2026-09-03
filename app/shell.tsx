"use client";

// The frame: where you are, and what you can do from anywhere.
//
// The bar this replaces carried twelve statistics. Statistics are not
// navigation — they moved to the overview, where a figure can have a label
// next to it and room to be read — and what is left here is the four things
// that are true no matter which view is open: which session, how to open
// another, how to check it, how to get it out.
//
// The brand is not the page heading. Every view supplies its own `h1`, so a
// screen reader reading the headings of this page gets "AgentTape · Overview"
// rather than "AgentTape" three times.

import Menu, { type MenuItem } from "./menu";
import { useTheme, THEME_LABEL, type Theme } from "./theme-provider";
import {
  ChecksIcon, ExportIcon, FileIcon, FolderIcon, HelpIcon, ThemeIcon,
} from "./icons";

export type ViewName = "overview" | "replay" | "compare";

export const VIEWS: { id: ViewName; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "replay", label: "Replay" },
  { id: "compare", label: "Compare" },
];

export type ChecksSummary = { pass: number; fail: number; vacuous: number; total: number };

type Props = {
  /** What is open, in a form a person recognises. Empty when nothing is. */
  sessionLabel: string;
  /** "Demo", "Local file", "Redacted tape" — where the bytes came from. */
  sourceLabel: string;
  view: ViewName | null;
  onView: (v: ViewName) => void;
  onOpen: () => void;
  onSessions: () => void;
  onShortcuts: () => void;
  onFormat: () => void;
  /** Null while nothing is loaded: there is nothing to check or export. */
  checks: ChecksSummary | null;
  onChecks: () => void;
  exportItems: MenuItem[];
  /** True while the redacted export is being written. */
  exporting: boolean;
  onCloseSession: () => void;
};

/** pass / fail / not evaluated, in words, for the Checks button. */
export function checksWord(c: ChecksSummary): string {
  if (c.total === 0) return "No checks";
  if (c.fail > 0) return `${c.fail} failed`;
  if (c.vacuous === c.total) return "None evaluated";
  return `${c.pass - c.vacuous} passed`;
}

export default function Shell({
  sessionLabel, sourceLabel, view, onView, onOpen, onSessions, onShortcuts, onFormat,
  checks, onChecks, exportItems, exporting, onCloseSession,
}: Props) {
  const { theme, setTheme } = useTheme();

  const themeItems: MenuItem[] = (["light", "dark", "system"] as Theme[]).map((t) => ({
    label: THEME_LABEL[t],
    selected: theme === t,
    onSelect: () => setTheme(t),
  }));

  const helpItems: MenuItem[] = [
    { label: "Keyboard shortcuts", onSelect: onShortcuts },
    { label: "Supported format", note: "what a Claude Code transcript is", onSelect: onFormat },
  ];

  // The narrow bar keeps Open session and folds the rest into one menu with
  // words in it. Nothing moves into a menu that is not also reachable from the
  // view it belongs to — Checks and Export are session-level actions and the
  // overview links to both.
  const wideItems: MenuItem[] = sessionLabel
    ? [{
      label: "Close session",
      note: "returns to the start; the file is not touched",
      onSelect: onCloseSession,
    }]
    : [{ label: "Supported format", onSelect: onFormat }];

  const narrowItems: MenuItem[] = [
    { label: "All sessions", onSelect: onSessions },
    ...(checks ? [{ label: `Checks — ${checksWord(checks)}`, onSelect: onChecks }] : []),
    ...exportItems,
    ...(sessionLabel ? [{ label: "Close session", onSelect: onCloseSession }] : []),
    ...helpItems,
    ...themeItems.map((t) => ({ ...t, label: `Theme: ${t.label}` })),
  ];

  return (
    <header className="shell">
      <div className="shell-bar">
        <div className="shell-brand">
          <svg className="shell-mark" viewBox="0 0 32 32" fill="none" aria-hidden>
            <rect x="4" y="9" width="24" height="14" rx="3" stroke="currentColor" strokeWidth="1.8" />
            <circle cx="11.5" cy="16" r="2.8" stroke="currentColor" strokeWidth="1.8" />
            <circle cx="20.5" cy="16" r="2.8" stroke="currentColor" strokeWidth="1.8" />
            <path d="M14.6 16h2.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          <span className="shell-name">AgentTape</span>
        </div>

        {sessionLabel && (
          <div className="shell-session">
            <span className="shell-source">{sourceLabel}</span>
            <span className="shell-sep" aria-hidden>·</span>
            <span className="shell-label" title={sessionLabel}>{sessionLabel}</span>
          </div>
        )}

        <span className="spacer" />

        <button type="button" className="btn btn-sm" onClick={onOpen}>
          <FileIcon />
          <span>Open session</span>
        </button>
        <button type="button" className="btn btn-sm bar-wide" onClick={onSessions}>
          <FolderIcon />
          <span>All sessions</span>
        </button>

        {checks && (
          <button
            type="button"
            className={"btn btn-sm bar-wide" + (checks.fail > 0 ? " btn-fail" : "")}
            onClick={onChecks}
          >
            <ChecksIcon />
            <span>Checks</span>
            <span className="btn-tail">{checksWord(checks)}</span>
          </button>
        )}

        {exportItems.length > 0 && (
          <span className="bar-wide">
            <Menu
              label={exporting ? "Exporting…" : "Export"}
              icon={<ExportIcon />}
              items={exportItems}
            />
          </span>
        )}

        <span className="bar-wide">
          <Menu label="Help" icon={<HelpIcon />} items={helpItems} look="quiet" />
        </span>
        <span className="bar-wide">
          <Menu label="Theme" icon={<ThemeIcon />} items={themeItems} look="quiet" />
        </span>

        {/* Two menus, one visible at a time, chosen by the stylesheet rather
            than by measuring the window — measuring means the server and the
            first client render can disagree, and the fix for that is always a
            flash. The wide one holds the single action that has no room for a
            button of its own; the narrow one holds everything the bar drops. */}
        <span className="bar-wide">
          <Menu label="More" items={wideItems} look="quiet" />
        </span>
        <span className="bar-narrow">
          <Menu label="More" items={narrowItems} look="quiet" />
        </span>
      </div>

      {view && (
        <nav className="shell-views" aria-label="Session views">
          {VIEWS.map((v) => (
            <button
              type="button"
              key={v.id}
              className={"view-tab" + (v.id === view ? " view-tab-on" : "")}
              aria-current={v.id === view ? "page" : undefined}
              onClick={() => onView(v.id)}
            >
              {v.label}
            </button>
          ))}
        </nav>
      )}
    </header>
  );
}
