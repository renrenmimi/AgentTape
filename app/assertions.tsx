"use client";

// Expectations about a run, checked against it.
//
// Five rules, each editable in place. Not a query language: every rule is a
// sentence with a hole or two in it, and the holes are a number or a tool name
// the tape actually contains. The moment this needs a parser, the thing under
// test has stopped being the run.

import { useEffect, useMemo, useRef, useState } from "react";
import type { Step } from "@/lib/format";
import {
  DEFAULT_RULES, RULES_FORMAT, checkAll, parseRuleSet, serializeRuleSet,
  type Rule, type RuleResult,
} from "@/lib/assert";
import { fmtInt } from "@/lib/summary";
import { useDialogFocus } from "./dialog";

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

function Num({ value, onChange, label, width = 92 }: {
  value: number; onChange: (n: number) => void; label: string; width?: number;
}) {
  return (
    <input
      type="number"
      min={1}
      className="filter-input rule-num"
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
      className="filter-input rule-tool"
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
function RuleRow({ r, tools, onChange, onRemove }: {
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
          <Num value={r.n} label="how many times in a row" width={70}
            onChange={(n) => onChange({ ...r, n })} />
          <span>times in a row</span>
        </>
      )}
      {r.kind === "max-context" && (
        <>
          <span>context never exceeds</span>
          <Num value={r.n} label="context ceiling in tokens" width={110}
            onChange={(n) => onChange({ ...r, n })} />
          <span>tokens</span>
        </>
      )}
      {r.kind === "max-tool-seconds" && (
        <>
          <span>no tool call takes longer than</span>
          <Num value={r.n} label="how many seconds" width={80}
            onChange={(n) => onChange({ ...r, n })} />
          <span>seconds</span>
        </>
      )}
      {r.kind === "ends-clean" && <span>the run ends without an error</span>}
      <span className="spacer" />
      <button type="button" className="btn btn-sm" onClick={onRemove}
        aria-label={"Remove the rule: " + r.kind}>
        Remove
      </button>
    </div>
  );
}

function Row({ res, shownIndex, onGo, children }: {
  res: RuleResult; shownIndex: (i: number) => number; onGo: (i: number) => void; children: React.ReactNode;
}) {
  return (
    <li className={"rule" + (res.pass ? (res.vacuous ? " rule-vacuous" : " rule-pass") : " rule-fail")}>
      <span className="rule-mark">{res.pass ? (res.vacuous ? "—" : "PASS") : "FAIL"}</span>
      <div className="rule-main">
        {children}
        <p className="rule-detail">
          {res.detail}
          {res.vacuous && <span className="rule-dim"> · nothing to check</span>}
        </p>
      </div>
      {res.at >= 0 ? (
        <button type="button" className="btn btn-sm rule-go" onClick={() => onGo(res.at)}>
          step {fmtInt(shownIndex(res.at) || res.at + 1)}
        </button>
      ) : (
        <span className="rule-dim">no step</span>
      )}
    </li>
  );
}

const ADDABLE: { kind: Rule["kind"]; make: (tools: string[]) => Rule; label: string }[] = [
  { kind: "before", label: "one tool before another",
    make: (t) => ({ kind: "before", first: t[0] ?? "", then: t[1] ?? t[0] ?? "" }) },
  { kind: "max-repeats", label: "repeats in a row", make: () => ({ kind: "max-repeats", n: 5 }) },
  { kind: "max-context", label: "context ceiling", make: () => ({ kind: "max-context", n: 200_000 }) },
  { kind: "max-tool-seconds", label: "slow tool call", make: () => ({ kind: "max-tool-seconds", n: 120 }) },
  { kind: "ends-clean", label: "ends without an error", make: () => ({ kind: "ends-clean" }) },
];

export default function Assertions({
  steps, tools, rules, onRules, pairs, shownIndex, onGo, onClose,
}: Props) {
  const results = useMemo(() => checkAll(steps, rules, pairs), [steps, rules, pairs]);
  const panel = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const [problems, setProblems] = useState<string[]>([]);

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

  const open = async (f: File) => {
    const { set, problems: found } = parseRuleSet(await f.text());
    setProblems(found);
    if (set.rules.length) onRules(set.rules);
  };

  useDialogFocus(panel);

  return (
    <div className="asserts" role="dialog" aria-modal="true" aria-label="Assertions about this run"
      tabIndex={-1} ref={panel}>
      <div className="cmp-head">
        <span className="eyebrow">assertions</span>
        <span className="cmp-name">
          {results.filter((r) => r.pass).length} of {results.length} hold
        </span>
        <span className="spacer" />
        <button type="button" className="btn btn-sm" onClick={save} disabled={rules.length === 0}>
          Save rule set
        </button>
        <button type="button" className="btn btn-sm" onClick={() => file.current?.click()}>
          Load rule set
        </button>
        <input
          ref={file}
          type="file"
          accept=".json"
          className="sr-only"
          aria-label="Load a rule set"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void open(f);
            e.target.value = "";
          }}
        />
        <button type="button" className="btn btn-sm" onClick={() => { setProblems([]); onRules(DEFAULT_RULES); }}>
          Reset to defaults
        </button>
        <button type="button" className="btn btn-sm" onClick={onClose}>Close</button>
      </div>

      <div className="cmp-body">
        {problems.length > 0 && (
          <div className="err-box" role="status">
            <b>That rule set had problems:</b>
            <ul className="rule-problems">
              {problems.map((p) => <li key={p}>{p}</li>)}
            </ul>
          </div>
        )}

        <div className="cmp-rule">
          <span className="cmp-rule-tag">what this is for</span>
          <p>
            The failure worth catching is the quiet one: the day your agent stops searching before
            it writes, nothing breaks and the output is merely worse. State the expectation, and
            the next tape either holds it or names the step where it stopped.
            <b> Every rule is checked against the index</b> — tool names, timings, token counts,
            error flags — so a redacted tape can be asserted against exactly as well as the
            transcript it came from.
          </p>
          <p>
            Save the set and the same expectations run outside this page:
            {" "}<code>agenttape check expectations.rules.json a-tape.jsonl</code> prints a line per
            rule and <b>exits non-zero when one fails</b>, which is what puts it in a CI job.
            The format is documented in <code>docs/rules.md</code>.
          </p>
        </div>

        <ul className="rules">
          {results.map((res, i) => (
            <Row key={i} res={res} shownIndex={shownIndex} onGo={onGo}>
              <RuleRow
                r={rules[i]}
                tools={tools}
                onChange={(r) => onRules(rules.map((x, k) => (k === i ? r : x)))}
                onRemove={() => onRules(rules.filter((_, k) => k !== i))}
              />
            </Row>
          ))}
          {rules.length === 0 && <li className="empty-note">No rules. Add one below.</li>}
        </ul>

        <div className="rule-add">
          <span className="eyebrow">add a rule</span>
          {ADDABLE.map((a) => (
            <button type="button" className="btn btn-sm" key={a.kind}
              onClick={() => onRules([...rules, a.make(tools)])}>
              {a.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
