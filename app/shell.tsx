"use client";

// The frame: where you are, and what you can do from anywhere.
//
// Seven controls used to sit in one row — Open session, All sessions, Checks,
// Export, Help, Theme, More — four of them dropdowns, and at 1150px the
// session's own name was squeezed to seventy-five pixels to make room for
// them. The fix is not a smaller font; it is that those seven belong to two
// different scopes and were pretending to belong to one.
//
//   the bar          things that are true with or without a session open:
//                    open one, list them all, and everything low-frequency
//   the session row  things that are about *this* session: which view, whether
//                    it meets its checks, and how to get it out
//
// Three groups in the bar, two on the session row, and the row was empty on
// its right-hand side anyway. Below 720px the session row keeps only the tabs
// and everything else folds into the one menu — a single collapse instead of
// the cliff at 1024 where six controls vanished at once.
//
// The brand is not the page heading. Every view supplies its own `h1`, so a
// screen reader reading the headings gets "AgentTape · Overview" rather than
// "AgentTape" three times.

import Menu, { type MenuItem } from "./menu";
import { useTheme, THEME_LABEL, type Theme } from "./theme-provider";
import { ChecksIcon, ExportIcon, FileIcon, FolderIcon } from "./icons";

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
    label: `Theme: ${THEME_LABEL[t]}`,
    selected: theme === t,
    onSelect: () => setTheme(t),
  }));

  /**
   * One menu, and everything in it is a named action.
   *
   * It is not the mystery drawer that a "More" usually is: it holds help, the
   * theme and closing the session, and on a narrow screen it also holds the
   * three controls the bar and the session row had to give up — each still
   * spelled out, so opening it explains itself.
   */
  const moreItems: MenuItem[] = [
    { label: "Keyboard shortcuts", onSelect: onShortcuts },
    { label: "Supported format", note: "what a Claude Code transcript is", onSelect: onFormat },
    ...themeItems,
    ...(sessionLabel
      ? [{
        label: "Close session",
        note: "returns to the start; the file is not touched",
        onSelect: onCloseSession,
      }]
      : []),
  ];

  /** The same menu on a narrow screen, plus what the rows had to drop. */
  const narrowItems: MenuItem[] = [
    { label: "All sessions", onSelect: onSessions },
    ...(checks ? [{ label: `Checks — ${checksWord(checks)}`, onSelect: onChecks }] : []),
    ...exportItems,
    ...moreItems,
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
          // A button rather than a label, for one reason: the name is
          // truncated, and a truncated name has to be recoverable by hover
          // *and* by focus. A `title` covers the mouse and nothing else, so
          // this is focusable, carries the whole name as its accessible name,
          // and does something useful when activated.
          <button
            type="button"
            className="shell-session"
            aria-label={`${sourceLabel} · ${sessionLabel}. Go to the overview.`}
            onClick={() => onView("overview")}
          >
            <span className="shell-source">{sourceLabel}</span>
            <span className="shell-sep" aria-hidden>·</span>
            <span className="shell-label">{sessionLabel}</span>
            <span className="shell-tip" aria-hidden>{sessionLabel}</span>
          </button>
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
        <Menu label="More" items={narrowItems} look="quiet" className="bar-narrow" />
        <Menu label="More" items={moreItems} look="quiet" className="bar-wide" />
      </div>

      {view && (
        <div className="shell-views">
          <nav className="view-tabs" aria-label="Session views">
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

          <span className="spacer" />

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
            <Menu
              label={exporting ? "Exporting…" : "Export"}
              icon={<ExportIcon />}
              items={exportItems}
              className="bar-wide"
            />
          )}
        </div>
      )}
    </header>
  );
}
