"use client";

// Checks: conditions you state about a run, and whether this run met them.
//
// The framing is the careful part. These are not a quality score and they do
// not certify anything — they are conditions somebody wrote down, checked
// against the index. A run where every check passes is a run that did not
// break the four rules that happened to be turned on. The panel says that in
// its own words rather than showing a green tick and letting the tick imply
// the rest.
//
// Three outcomes, three treatments. Failed is red with the evidence and the
// step. Passed is green *only* when the check had something to check. A check
// with nothing to check — no call to the tool it names, no context figures at
// all — is neither, and is reported as "not evaluated", because "nothing
// violated this" and "this was never tested" are different facts and the
// second one dressed as the first is how a suite stops meaning anything.
//
// Results first, editing behind a control. Every rule looked like a
// configuration row before, so reading the outcome meant reading past four
// dropdowns to get to it.

import { useEffect, useRef, useState } from "react";
import type { Step } from "@/lib/format";
import {
  DEFAULT_RULES, RULES_FORMAT, checkAll, parseRuleSet, serializeRuleSet,
  type Rule, type RuleResult,
} from "@/lib/assert";
import { fmtInt } from "@/lib/summary";
import { useDialogFocus } from "./dialog";
import { CheckIcon, CrossIcon, InfoIcon } from "./icons";

type Props = {
  steps: Step[];
  tools: string[];
  rules: Rule[];
  onRules: (r: Rule[]) => void;
  pairs: Map<number, number>;
  shownIndex: (globalIndex: number) => number;
  onGo: (globalIndex: number) => void;
  onClose: () => void;
};

function Num({ value, onChange, label, width = 96 }: {
  value: number; onChange: (n: number) => void; label: string; width?: number;
}) {
  return (
    <input
      type="number"
      min={1}
      className="input input-num"
      style={{ width }}
      value={value}
      aria-label={label}
      onChange={(e) => {
        const v = Number(e.target.value);
        if (Number.isFinite(v) && v > 0) onChange(Math.floor(v));
      }}
    />
  );
}

function ToolPick({ value, tools, onChange, label, anyLabel }: {
  value: string; tools: string[]; onChange: (t: string) => void; label: string; anyLabel?: string;
}) {
  return (
    <select
      className="input input-select"
      value={value}
      aria-label={label}
      onChange={(e) => onChange(e.target.value)}
    >
      {anyLabel && <option value="">{anyLabel}</option>}
      {tools.map((t) => <option value={t} key={t}>{t}</option>)}
      {value && !tools.includes(value) && <option value={value}>{value}</option>}
    </select>
  );
}

/** The rule as a sentence with its parameters as controls. */
function RuleEditor({ r, tools, onChange, onRemove }: {
  r: Rule; tools: string[]; onChange: (r: Rule) => void; onRemove: () => void;
}) {
  return (
    <div className="rule-edit">
      {r.kind === "before" && (
        <>
          <ToolPick value={r.first} tools={tools} label="the tool that must come first"
            onChange={(t) => onChange({ ...r, first: t })} />
          <span>happens before</span>
          <ToolPick value={r.then} tools={tools} label="the tool that must come after"
            onChange={(t) => onChange({ ...r, then: t })} />
        </>
      )}
      {r.kind === "max-repeats" && (
        <>
          <ToolPick value={r.tool ?? ""} tools={tools} anyLabel="no tool"
            label="which tool, or any" onChange={(t) => onChange({ ...r, tool: t || undefined })} />
          <span>is called more than</span>
          <Num value={r.n} label="how many times in a row" width={72}
            onChange={(n) => onChange({ ...r, n })} />
          <span>times in a row</span>
        </>
      )}
      {r.kind === "max-context" && (
        <>
          <span>context never exceeds</span>
          <Num value={r.n} label="context ceiling in tokens" width={116}
            onChange={(n) => onChange({ ...r, n })} />
          <span>tokens</span>
        </>
      )}
      {r.kind === "max-tool-seconds" && (
        <>
          <span>no tool call takes longer than</span>
          <Num value={r.n} label="how many seconds" width={84}
            onChange={(n) => onChange({ ...r, n })} />
          <span>seconds</span>
        </>
      )}
      {r.kind === "ends-clean" && <span>the run ends without an error</span>}
      <span className="spacer" />
      <button type="button" className="btn btn-sm" onClick={onRemove}
        aria-label={"Remove the check: " + r.kind}>
        Remove
      </button>
    </div>
  );
}

const ADDABLE: { kind: Rule["kind"]; make: (tools: string[]) => Rule; label: string }[] = [
  { kind: "before", label: "One tool before another",
    make: (t) => ({ kind: "before", first: t[0] ?? "", then: t[1] ?? t[0] ?? "" }) },
  { kind: "max-repeats", label: "Repeats in a row", make: () => ({ kind: "max-repeats", n: 5 }) },
  { kind: "max-context", label: "Context ceiling", make: () => ({ kind: "max-context", n: 200_000 }) },
  { kind: "max-tool-seconds", label: "Slow tool call", make: () => ({ kind: "max-tool-seconds", n: 120 }) },
  { kind: "ends-clean", label: "Ends without an error", make: () => ({ kind: "ends-clean" }) },
];

/** pass / fail / not evaluated — three states, never two. */
function outcomeOf(r: RuleResult): { word: string; cls: string; icon: React.ReactNode } {
  if (!r.pass) return { word: "Failed", cls: "fail", icon: <CrossIcon size={14} /> };
  if (r.vacuous) return { word: "Not evaluated", cls: "vacuous", icon: <InfoIcon size={14} /> };
  return { word: "Passed", cls: "pass", icon: <CheckIcon size={14} /> };
}

export default function Checks({
  steps, tools, rules, onRules, pairs, shownIndex, onGo, onClose,
}: Props) {
  const panel = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [pending, setPending] = useState<Rule[] | null>(null);
  const [results, setResults] = useState<RuleResult[]>([]);

  useDialogFocus(panel);

  useEffect(() => { setResults(checkAll(steps, rules, pairs)); }, [steps, rules, pairs]);

  const save = () => {
    const text = serializeRuleSet({
      format: RULES_FORMAT,
      name: "expectations",
      note: "Written in AgentTape. Run with: agenttape check <this file> <a tape>",
      rules,
    });
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "expectations.rules.json";
    a.click();
    URL.revokeObjectURL(url);
  };

  /**
   * Read a rule set without throwing away the one already loaded.
   *
   * A file with problems in it used to replace whatever parsed and report the
   * rest, which means a typo in rule three could cost you rules four through
   * nine with no way back. Nothing is replaced until the file is clean, or
   * until somebody looks at the problems and says to go ahead anyway.
   */
  const open = async (f: File) => {
    const { set, problems: found } = parseRuleSet(await f.text());
    setProblems(found);
    if (found.length === 0 && set.rules.length) {
      setPending(null);
      onRules(set.rules);
      return;
    }
    setPending(set.rules.length ? set.rules : null);
  };

  const pass = results.filter((r) => r.pass && !r.vacuous).length;
  const fail = results.filter((r) => !r.pass).length;
  const vacuous = results.filter((r) => r.vacuous).length;

  return (
    <div className="scrim scrim-right" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="checks-title"
        tabIndex={-1}
        ref={panel}
      >
        <div className="drawer-head">
          <button type="button" className="btn btn-sm only-narrow" onClick={onClose}>
            Back
          </button>
          <h2 id="checks-title">Checks</h2>
          <span className="spacer" />
          <button type="button" className="btn btn-sm" onClick={onClose}>Close</button>
        </div>

        <div className="drawer-body">
          <p className="checks-summary" aria-live="polite">
            {results.length === 0
              ? "No checks are set."
              : <>
                <b>{fmtInt(fail)}</b> failed · <b>{fmtInt(pass)}</b> passed ·{" "}
                <b>{fmtInt(vacuous)}</b> not evaluated
              </>}
          </p>
          <p className="checks-caveat">
            These are conditions you set, checked against the index — tool names, timings, token
            counts, error flags. Passing means this run did not break them. It is not a statement
            that the session did the right thing.
          </p>

          {problems.length > 0 && (
            <div className="note note-error" role="status">
              <p className="note-text"><b>That rule set had problems.</b> Nothing has been replaced.</p>
              <ul className="problem-list">
                {problems.map((p) => <li key={p}>{p}</li>)}
              </ul>
              <div className="note-actions">
                {pending && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => { onRules(pending); setPending(null); setProblems([]); }}
                  >
                    Use the {fmtInt(pending.length)} rule{pending.length === 1 ? "" : "s"} that parsed
                  </button>
                )}
                <button type="button" className="btn btn-sm"
                  onClick={() => { setProblems([]); setPending(null); }}>
                  Keep what I have
                </button>
              </div>
            </div>
          )}

          {results.length === 0 ? (
            <p className="empty-line">
              No checks are set, so nothing has been evaluated. Add one below, or reset to the
              starting set.
            </p>
          ) : (
            <ul className="check-list">
              {results.map((res, i) => {
                const o = outcomeOf(res);
                return (
                  <li className={"check-row check-" + o.cls} key={i}>
                    <span className={"outcome outcome-" + o.cls}>
                      {o.icon}
                      {o.word}
                    </span>
                    <div className="check-main">
                      <p className="check-label">{res.label}</p>
                      <p className="check-detail">
                        {res.detail}
                        {res.vacuous && (
                          <span className="dim"> — there was nothing in this run to check it against.</span>
                        )}
                      </p>
                    </div>
                    {res.at >= 0 ? (
                      <button type="button" className="btn btn-sm" onClick={() => onGo(res.at)}>
                        Inspect step {fmtInt(shownIndex(res.at) || res.at + 1)}
                      </button>
                    ) : (
                      <span className="dim check-nostep">no step</span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          <div className="checks-edit">
            <button
              type="button"
              className="details-toggle details-toggle-sm"
              aria-expanded={editing}
              onClick={() => setEditing((v) => !v)}
            >
              <span className="details-caret" aria-hidden>{editing ? "−" : "+"}</span>
              <span>Edit rules</span>
              <span className="details-hint">
                {fmtInt(rules.length)} set · five kinds available
              </span>
            </button>

            {editing && (
              <div className="fold-body">
                <ul className="rule-edits">
                  {rules.map((r, i) => (
                    <li key={i}>
                      <RuleEditor
                        r={r}
                        tools={tools}
                        onChange={(next) => onRules(rules.map((x, k) => (k === i ? next : x)))}
                        onRemove={() => onRules(rules.filter((_, k) => k !== i))}
                      />
                    </li>
                  ))}
                  {rules.length === 0 && <li className="empty-line">No rules. Add one below.</li>}
                </ul>

                <h3 className="sec-subtitle">Add a check</h3>
                <div className="rule-add">
                  {ADDABLE.map((a) => (
                    <button type="button" className="btn btn-sm" key={a.kind}
                      onClick={() => onRules([...rules, a.make(tools)])}>
                      {a.label}
                    </button>
                  ))}
                </div>

                <h3 className="sec-subtitle">Rule sets</h3>
                <div className="rule-add">
                  <button type="button" className="btn btn-sm" onClick={save}
                    disabled={rules.length === 0}>
                    Save rule set
                  </button>
                  <button type="button" className="btn btn-sm" onClick={() => file.current?.click()}>
                    Load rule set
                  </button>
                  <button type="button" className="btn btn-sm"
                    onClick={() => { setProblems([]); setPending(null); onRules(DEFAULT_RULES); }}>
                    Reset to the starting set
                  </button>
                  <input
                    ref={file}
                    type="file"
                    accept=".json"
                    className="sr-only"
                    aria-label="Load a rule set"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      e.target.value = "";
                      if (f) void open(f);
                    }}
                  />
                </div>
                <p className="sec-lead dim">
                  A saved set runs outside this page:{" "}
                  <code>agenttape check expectations.rules.json a-tape.jsonl</code> prints a line
                  per rule and exits non-zero when one fails, which is what puts it in a CI job.
                  The format is documented in <code>docs/rules.md</code>.
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
