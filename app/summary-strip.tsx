"use client";

// The header strip. Every figure here answers a question you would otherwise
// ask by scrolling.
//
// Wall-clock and active duration sit next to each other on purpose. The probe
// fixtures span 323 h and 213 h of wall-clock because sessions get resumed for
// days; the same runs hold about five hours of actual work. Showing only the
// first number would be worse than showing none.

import type { Tape } from "@/lib/format";
import { fmtBytes, fmtDuration, fmtInt, fmtTokens, type Summary } from "@/lib/summary";
import { useTheme } from "./theme-provider";

type Props = {
  tape: Tape;
  summary: Summary;
  onExport: () => void;
  onClose: () => void;
  exporting: boolean;
};

function Stat({ k, v, sub, risk }: { k: string; v: string; sub?: string; risk?: boolean }) {
  return (
    <div className={"stat" + (risk ? " stat-risk" : "")}>
      <span className="eyebrow stat-k">{k}</span>
      <span className="stat-v">
        {v}
        {sub && <small>{sub}</small>}
      </span>
    </div>
  );
}

export default function SummaryStrip({ tape, summary, onExport, onClose, exporting }: Props) {
  const { theme, toggleTheme } = useTheme();
  const s = summary;

  return (
    <header className="strip">
      <div className="strip-brand">
        <svg className="strip-mark" viewBox="0 0 32 32" fill="none" aria-hidden>
          <rect x="4" y="9" width="24" height="14" rx="3" stroke="currentColor" strokeWidth="1.8" />
          <circle cx="11.5" cy="16" r="2.8" stroke="currentColor" strokeWidth="1.8" />
          <circle cx="20.5" cy="16" r="2.8" stroke="currentColor" strokeWidth="1.8" />
          <path d="M14.6 16h2.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        <b>AgentTape</b>
      </div>

      <Stat k="steps" v={fmtInt(s.conversationSteps)} sub={s.metaSteps ? `+${fmtInt(s.metaSteps)} meta` : undefined} />
      <Stat k="turns" v={fmtInt(s.turns)} />
      <Stat k="wall clock" v={fmtDuration(s.wallMs)} />
      <Stat k="active" v={fmtDuration(s.activeMs)} sub={s.idleGaps ? `${s.idleGaps} gaps` : undefined} />
      <Stat k="tool calls" v={fmtInt(s.toolCalls)} />
      <Stat k="errors" v={fmtInt(s.errors)} risk={s.errors > 0} />
      <Stat
        k="tokens in"
        v={fmtTokens(s.input + s.cacheRead + s.cacheCreate)}
        sub={`${fmtTokens(s.cacheRead)} cached`}
      />
      <Stat k="tokens out" v={fmtTokens(s.output)} />
      <Stat k="peak context" v={fmtTokens(s.peakCtx)} />
      <Stat k="model" v={s.models.length ? s.models.join(", ") : "—"} />
      <Stat k="source" v={fmtBytes(tape.meta.bytes)} sub={`${fmtInt(tape.meta.lines)} lines`} />

      <div className="strip-tools" aria-label="Tool calls by name">
        {s.tools.slice(0, 8).map((t) => (
          <span className="tool-chip" key={t.name} title={`${t.name}: ${t.count} calls${t.errors ? `, ${t.errors} failed` : ""}`}>
            {t.name}
            <b>{t.count}</b>
            {t.errors > 0 && <i aria-label={`${t.errors} failed`}>✕{t.errors}</i>}
          </span>
        ))}
        {s.tools.length > 8 && (
          <span className="tool-chip">+{s.tools.length - 8} more</span>
        )}
      </div>

      <div className="strip-actions">
        {tape.meta.redacted && <span className="d-kind">redacted tape</span>}
        <button type="button" className="btn btn-sm" onClick={onExport} disabled={exporting}>
          {exporting ? "Exporting…" : "Export redacted tape"}
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={toggleTheme}
          aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
        >
          {theme === "dark" ? "Light" : "Dark"}
        </button>
        <button type="button" className="btn btn-sm" onClick={onClose}>
          Close
        </button>
      </div>
    </header>
  );
}
