"use client";

// A delegated call, in whichever of its five states it is in.
//
// The states are distinguishable on purpose, because they are five different
// facts and the old panel collapsed the middle three into one:
//
//   1. the call is here and the run is not in this file
//   2. …and there is a file on offer that can be fetched
//   3. …and it is being read right now
//   4. the run is attached, and here is how it was matched
//   5. a file was offered and could not be matched to this call
//
// The wording of (1) matters most. "No delegated work happened" would be
// false; what is true is that this file records the call and the summary that
// came back, and nothing about what happened in between. `isSidechain` is
// false on every record of a main transcript, so a reader of the main file
// cannot even tell that something is missing — which is exactly why it is said
// here in words.

import type { Delegation, SubRun } from "@/lib/subagents";
import { fmtBytes, fmtDuration, fmtInt, fmtTokens } from "@/lib/summary";
import { BranchIcon, WarnIcon } from "./icons";

type Props = {
  delegation: Delegation;
  /** Given when the run can still be fetched: the helper knows where it is. */
  onLoad: (() => void) | null;
  loading: boolean;
  error: string;
  /** Bytes the helper reported, so the offer can say how big it is. */
  offeredBytes: number;
  onEnter: () => void;
  /** True inside a delegated run: there is no second level to step into. */
  nested: boolean;
};

const PAIRED_BY: Record<SubRun["pairedBy"], string> = {
  sidecar: "Matched exactly, by the tool_use id in its sidecar file.",
  time: "Matched by when it ran — a subagent runs strictly between its call and that call's " +
    "result, and only one file fell inside this window. That is strong evidence, not an " +
    "identifier: nothing inside a subagent transcript points back at its parent.",
  manual: "Attached by hand.",
};

export default function NestedRun({
  delegation, onLoad, loading, error, offeredBytes, onEnter, nested,
}: Props) {
  const run = delegation.run;

  if (!run) {
    return (
      <section className="sec sec-delegated">
        <h3 className="sec-title">
          <BranchIcon />
          Delegated work
        </h3>
        <p className="sec-lead">
          This step handed its work to a subagent. <b>This delegated run is not included in the
          file.</b> It lives beside the session, as{" "}
          <code>subagents/agent-&lt;id&gt;.jsonl</code>, and the main transcript records the call
          and the summary that came back — not what happened in between.
        </p>

        {error && (
          <p className="note note-error" role="status">
            <WarnIcon />
            <span className="note-text">{error}</span>
          </p>
        )}

        {loading ? (
          <p className="empty-line" role="status">Reading the delegated run…</p>
        ) : onLoad ? (
          <button type="button" className="btn" onClick={onLoad}>
            Load the delegated run
            {offeredBytes > 0 && <span className="btn-tail">{fmtBytes(offeredBytes)}</span>}
          </button>
        ) : (
          <p className="sec-lead dim">
            To see inside, drop the <code>agent-*.jsonl</code> files alongside the transcript, or
            open the session through the local helper. Dropping them together is enough — the
            sidecar names the call each one belongs to.
          </p>
        )}
      </section>
    );
  }

  const wall = run.lastT && run.firstT ? run.lastT - run.firstT : 0;

  return (
    <section className="sec sec-delegated">
      <h3 className="sec-title">
        <BranchIcon />
        Delegated run
        <span className="sec-count">{run.agentId.slice(0, 12)}</span>
      </h3>

      <dl className="facts">
        <dt>Steps</dt>
        <dd>
          {fmtInt(run.steps)}
          <span className="dim"> · {fmtInt(run.lines)} lines · {fmtBytes(run.bytes)}</span>
        </dd>
        <dt>Tool calls</dt>
        <dd>
          {fmtInt(run.toolCalls)}
          {run.errors > 0 && <span className="cell-error"> · {fmtInt(run.errors)} failed</span>}
        </dd>
        <dt>Tokens</dt>
        <dd>
          {fmtTokens(run.input + run.cacheRead + run.cacheCreate)}<span className="dim"> in · </span>
          {fmtTokens(run.output)}<span className="dim"> out</span>
        </dd>
        <dt>Wall clock</dt>
        <dd>{wall ? fmtDuration(wall) : "not recorded"}</dd>
        <dt>Tools</dt>
        <dd>
          {run.tools.length === 0
            ? <span className="dim">none</span>
            : run.tools.slice(0, 8).map((t) => `${t.name} ×${t.count}`).join(" · ") +
              (run.tools.length > 8 ? ` · +${run.tools.length - 8} more` : "")}
        </dd>
        <dt>How it was matched</dt>
        <dd>{PAIRED_BY[run.pairedBy]}</dd>
      </dl>

      {!nested && (
        <div className="delegated-enter">
          <button type="button" className="btn btn-primary" onClick={onEnter}>
            Open this delegated run
          </button>
          <p className="sec-lead dim">
            It opens with its own step list, context view and record data, and a way back to this
            step. It does not carry the filter, the comparison or the checks — those belong to
            the run you opened.
          </p>
        </div>
      )}
    </section>
  );
}
