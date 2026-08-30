"use client";

// Building the cross-session index in the browser, with no server at all.
//
// The helper walks ~/.claude/projects with Node. This walks the same directory
// with the File System Access API, after the user has granted read access to
// it, and hands the results to the *same* index builder — lib/session-index.ts
// — so there is one definition of what a session looks like from the outside
// and one freshness rule, not two that drift.
//
// Nothing leaves the machine. A directory handle is a capability the user
// granted to this page; it is not a URL and there is nothing to upload it to.

import { loadJsonlBlob } from "@/lib/load";
import { pairTools } from "@/lib/parser";
import {
  buildSessionIndex, byRecency, type IndexCache, type IndexProgress, type SessionSource,
} from "@/lib/session-index";
import type { SessionStats, SubagentRef } from "@/lib/stats";

// Directory-handle iteration is not in the DOM types this project builds
// against. Declared here rather than pulled in as a dependency.
type DirEntry = [string, FileSystemDirectoryHandle | FileSystemFileHandle];
type WalkableDir = FileSystemDirectoryHandle & {
  entries(): AsyncIterableIterator<DirEntry>;
};

// The API is Chromium-only at the time of writing. The fallback is a file input
// with `webkitdirectory`, which is far older and far more widely supported, and
// which hands over the same thing by a worse route: every file at once, with no
// persistent permission.
export type PickerSupport = "directory-picker" | "webkitdirectory" | "none";

export function pickerSupport(): PickerSupport {
  if (typeof window === "undefined") return "none";
  if (typeof (window as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function") {
    return "directory-picker";
  }
  const probe = document.createElement("input");
  if ("webkitdirectory" in probe) return "webkitdirectory";
  return "none";
}

export const SUPPORT_NOTE: Record<PickerSupport, string> = {
  "directory-picker":
    "Your browser can grant this page read access to a folder. Nothing is uploaded — a " +
    "directory handle is a capability, not an address.",
  "webkitdirectory":
    "Your browser cannot grant a folder handle, so the fallback hands every file over at " +
    "once instead. It still reads them here and uploads nothing, but the permission is not " +
    "remembered and you will pick the folder again next time.",
  "none":
    "This browser can do neither: no folder handle and no folder input. Run the local helper " +
    "instead — it walks the same directory and serves the same statistics over loopback.",
};

type Found = {
  sources: SessionSource[];
  agents: Map<string, SubagentRef[]>;
  /** Files that looked like transcripts but sat somewhere unexpected. */
  skipped: number;
};

const sessionOf = (name: string) => (name.endsWith(".jsonl") ? name.slice(0, -6) : "");
const agentOf = (name: string) =>
  /^agent-([A-Za-z0-9_-]+)\.jsonl$/.exec(name)?.[1] ?? "";

/** One transcript, indexed from a Blob by the same reader the workbench uses. */
function sourceFor(project: string, session: string, file: File): SessionSource {
  return {
    project,
    session,
    bytes: file.size,
    // File.lastModified is whole milliseconds; Node's mtimeMs is fractional.
    // The two caches are therefore not interchangeable, which is fine because
    // they are separate — but it is why they are separate.
    mtime: file.lastModified,
    index: async () => {
      const tape = await loadJsonlBlob(file, session);
      return { meta: tape.meta, steps: tape.steps, entries: tape.entries, pairs: pairTools(tape.steps) };
    },
  };
}

/**
 * Walk a granted directory.
 *
 * Tolerant about what was picked: `~/.claude/projects` holds one directory per
 * project, but somebody may well hand over a single project directory instead,
 * and refusing that would be pedantry.
 */
export async function collectFromDirectory(root: FileSystemDirectoryHandle): Promise<Found> {
  const sources: SessionSource[] = [];
  const agents = new Map<string, SubagentRef[]>();
  let skipped = 0;

  const readProject = async (project: string, dir: FileSystemDirectoryHandle) => {
    for await (const [name, handle] of (dir as WalkableDir).entries()) {
      if (handle.kind === "file") {
        const session = sessionOf(name);
        if (!session) continue;
        sources.push(sourceFor(project, session, await handle.getFile()));
      } else if (handle.kind === "directory") {
        // <sessionId>/subagents/agent-<id>.jsonl — counted, never indexed,
        // exactly as the helper counts them.
        let subs: WalkableDir;
        try {
          subs = (await handle.getDirectoryHandle("subagents")) as WalkableDir;
        } catch {
          continue;
        }
        const list: SubagentRef[] = [];
        for await (const [fname, fh] of subs.entries()) {
          const id = agentOf(fname);
          if (!id || fh.kind !== "file") continue;
          const f = await fh.getFile();
          list.push({ id, bytes: f.size, toolUseId: "", agentType: "" });
        }
        if (list.length) agents.set(`${project}/${name}`, list.sort((a, b) => a.id.localeCompare(b.id)));
      }
    }
  };

  let sawProjectDir = false;
  for await (const [name, handle] of (root as WalkableDir).entries()) {
    if (handle.kind === "directory") {
      sawProjectDir = true;
      await readProject(name, handle);
    } else if (sessionOf(name)) {
      skipped++;
    }
  }

  // The picked directory was itself a project directory.
  if (!sawProjectDir || (!sources.length && skipped)) {
    sources.length = 0;
    await readProject(root.name, root);
  }

  return { sources, agents, skipped };
}

/** The `webkitdirectory` fallback: every file at once, with its relative path. */
export function collectFromFiles(files: File[]): Found {
  const sources: SessionSource[] = [];
  const agents = new Map<string, SubagentRef[]>();

  for (const f of files) {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    const parts = rel.split("/").filter(Boolean);
    const name = parts[parts.length - 1];
    if (!name.endsWith(".jsonl")) continue;

    const inSub = parts.length >= 3 && parts[parts.length - 2] === "subagents";
    if (inSub) {
      const id = agentOf(name);
      const session = parts[parts.length - 3];
      const project = parts[parts.length - 4] ?? "";
      if (!id || !session) continue;
      const key = `${project}/${session}`;
      const list = agents.get(key) ?? [];
      list.push({ id, bytes: f.size, toolUseId: "", agentType: "" });
      agents.set(key, list);
      continue;
    }
    // …/<project>/<session>.jsonl, with the picked folder as the first segment.
    const project = parts.length >= 2 ? parts[parts.length - 2] : "";
    sources.push(sourceFor(project, name.slice(0, -6), f));
  }

  for (const list of agents.values()) list.sort((a, b) => a.id.localeCompare(b.id));
  return { sources, agents, skipped: 0 };
}

// ---------------------------------------------------------------- caching

const CACHE_KEY = "agenttape-local-index";
const CACHE_FORMAT = "agenttape-index/1";

export function readLocalCache(): IndexCache {
  try {
    const raw = JSON.parse(window.localStorage.getItem(CACHE_KEY) ?? "null");
    if (raw?.format !== CACHE_FORMAT || typeof raw.entries !== "object") return {};
    return raw.entries ?? {};
  } catch {
    return {};
  }
}

export function writeLocalCache(entries: IndexCache): { ok: boolean; bytes: number } {
  const text = JSON.stringify({ format: CACHE_FORMAT, entries });
  try {
    window.localStorage.setItem(CACHE_KEY, text);
    return { ok: true, bytes: text.length };
  } catch {
    // Quota, or private browsing. A cache that will not write is slow, not
    // broken, and the UI says which.
    return { ok: false, bytes: text.length };
  }
}

export function clearLocalCache(): void {
  try {
    window.localStorage.removeItem(CACHE_KEY);
  } catch {
    /* nothing to clear */
  }
}

export function localCacheSize(): number {
  try {
    return (window.localStorage.getItem(CACHE_KEY) ?? "").length;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------- driving

export type LocalIndexResult = {
  sessions: SessionStats[];
  cached: number;
  indexed: number;
  failed: number;
  bytes: number;
  ms: number;
  cacheWritten: boolean;
};

export async function buildLocalIndex(
  found: Found,
  onProgress?: IndexProgress,
): Promise<LocalIndexResult> {
  const t0 = performance.now();
  const cache = readLocalCache();
  const built = await buildSessionIndex(found.sources, cache, onProgress);
  const written = writeLocalCache(built.entries);
  const sessions = byRecency(built.entries);
  for (const s of sessions) s.agents = found.agents.get(`${s.project}/${s.session}`) ?? [];
  return {
    sessions,
    cached: built.cached,
    indexed: built.indexed,
    failed: built.failed,
    bytes: found.sources.reduce((n, s) => n + s.bytes, 0),
    ms: performance.now() - t0,
    cacheWritten: written.ok,
  };
}
