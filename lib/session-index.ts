// Building the cross-session index, once.
//
// Two callers need this: the local helper, which streams files off disk, and
// the browser, which slices File handles the user granted through the File
// System Access API. What differs between them is where the bytes come from.
// Everything else — which cached entries are still true, what a record looks
// like, in what order the work happens — is here, because two implementations
// of "what a session looks like from the outside" would drift and one of them
// would drift into showing something it should not.

import type { Entry, Step, TapeMeta } from "./format.ts";
import { sessionStats, type SessionStats } from "./stats.ts";

export type SessionSource = {
  project: string;
  session: string;
  /** Size and modification time, the two halves of the cache key. */
  bytes: number;
  mtime: number;
  /** Produce the index. Node streams a file; the browser walks a Blob. */
  index: () => Promise<{
    meta: TapeMeta;
    steps: Step[];
    entries: Entry[];
    pairs: Map<number, number>;
  }>;
};

export type IndexCache = Record<string, SessionStats>;

export const cacheKeyOf = (s: { project: string; session: string }): string =>
  `${s.project}/${s.session}`;

/**
 * A cached entry is still true when the size *and* the modification time both
 * match. Sound because a transcript is only ever appended to: any new line
 * moves both. An in-place rewrite preserving both would slip past, which is a
 * stated limit rather than an oversight.
 */
export function isFresh(hit: SessionStats | undefined, s: SessionSource): boolean {
  return !!hit && hit.bytes === s.bytes && hit.mtime === s.mtime;
}

export type IndexProgress = (done: number, total: number, indexed: number, cached: number) => void;

export async function buildSessionIndex(
  sources: SessionSource[],
  cache: IndexCache,
  onProgress?: IndexProgress,
): Promise<{ entries: IndexCache; cached: number; indexed: number; failed: number }> {
  const entries: IndexCache = {};
  let cached = 0;
  let indexed = 0;
  let failed = 0;

  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const key = cacheKeyOf(s);
    const hit = cache[key];
    if (isFresh(hit, s)) {
      entries[key] = hit;
      cached++;
    } else {
      try {
        const { meta, steps, entries: rows, pairs } = await s.index();
        entries[key] = sessionStats(
          { project: s.project, session: s.session, bytes: s.bytes, mtime: s.mtime },
          meta, steps, rows, pairs,
        );
        indexed++;
      } catch {
        // A file that will not index is left out rather than fatal: one
        // half-written transcript should not cost you the other thirty-nine.
        failed++;
        continue;
      }
    }
    onProgress?.(i + 1, sources.length, indexed, cached);
  }

  return { entries, cached, indexed, failed };
}

/** Newest first, which is the order somebody scanning for "what did I break" wants. */
export const byRecency = (entries: IndexCache): SessionStats[] =>
  Object.values(entries).sort((a, b) => b.mtime - a.mtime);
