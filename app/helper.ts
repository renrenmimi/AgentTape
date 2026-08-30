"use client";

// Talking to the local helper, in one place.
//
// Both the empty state and the comparison panel need the same thing: a list of
// sessions from 127.0.0.1, fetched without printing a red error into the
// console when nothing is listening there. That rule lives here so the two
// callers cannot drift apart on it.

import { useCallback, useEffect, useState } from "react";

export const HELPER = "http://127.0.0.1:4319";

export type HelperAgent = {
  id: string;
  bytes: number;
  /** The parent tool_use id, from the sidecar. Empty when there is no sidecar. */
  toolUseId: string;
  agentType: string;
};

export type HelperSession = {
  project: string;
  session: string;
  bytes: number;
  lines: number;
  tools: number;
  mtime: number;
  /** Subagent transcripts beside this session. */
  agents: HelperAgent[];
};

// Probing a port nothing is listening on logs net::ERR_CONNECTION_REFUSED in
// red, at the network layer, before any JavaScript sees it — a .catch() cannot
// suppress it. A working page that prints a red error looks broken, so the
// probe only runs unasked once the helper has answered at least once on this
// machine.
const SEEN_KEY = "agenttape-helper-seen";

export function helperSeenBefore(): boolean {
  try {
    return window.localStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberHelper(seen: boolean): void {
  try {
    if (seen) window.localStorage.setItem(SEEN_KEY, "1");
    else window.localStorage.removeItem(SEEN_KEY);
  } catch {
    /* private mode: the probe just stays manual */
  }
}

export function isLocal(): boolean {
  if (typeof location === "undefined") return false;
  return location.hostname === "localhost" || location.hostname === "127.0.0.1";
}

export const fileUrl = (s: { project: string; session: string }): string =>
  `${HELPER}/file?project=${encodeURIComponent(s.project)}&session=${encodeURIComponent(s.session)}`;

export const subagentUrl = (
  s: { project: string; session: string },
  agent: string,
): string =>
  `${HELPER}/subagent?project=${encodeURIComponent(s.project)}` +
  `&session=${encodeURIComponent(s.session)}&agent=${encodeURIComponent(agent)}`;

export type HelperState = {
  sessions: HelperSession[] | null;
  probing: boolean;
  asked: boolean;
  failed: boolean;
  probe: () => void;
};

export function useHelperSessions(): HelperState {
  const [sessions, setSessions] = useState<HelperSession[] | null>(null);
  const [probing, setProbing] = useState(false);
  const [asked, setAsked] = useState(false);
  const [failed, setFailed] = useState(false);

  const probe = useCallback(() => {
    if (!isLocal()) return;
    setProbing(true);
    setAsked(true);
    setFailed(false);
    const ac = new AbortController();
    const timer = window.setTimeout(() => ac.abort(), 1500);
    fetch(HELPER + "/sessions", { signal: ac.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j: { sessions?: HelperSession[] }) => {
        const list = Array.isArray(j.sessions) ? j.sessions : [];
        setSessions(list.map((x) => ({ ...x, agents: x.agents ?? [] })));
        rememberHelper(true);
      })
      .catch(() => {
        setFailed(true);
        rememberHelper(false);
      })
      .finally(() => {
        window.clearTimeout(timer);
        setProbing(false);
      });
  }, []);

  useEffect(() => {
    if (!isLocal() || !helperSeenBefore()) return;
    probe();
  }, [probe]);

  return { sessions, probing, asked, failed, probe };
}
