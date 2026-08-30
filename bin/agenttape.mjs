#!/usr/bin/env node
// AgentTape's local helper: a session list and a read-only transcript feed.
//
//   node bin/agenttape.mjs            list recent sessions, then serve
//   node bin/agenttape.mjs --list     list and exit
//   node bin/agenttape.mjs --all      do not stop at the twenty most recent
//   node bin/agenttape.mjs --port N   default 4319
//
//   node bin/agenttape.mjs check <rules.json> <tape.jsonl|tape.tape.json>
//                                     check a run against stated expectations
//                                     and exit non-zero if any of them failed
//   node bin/agenttape.mjs index      build the cross-session statistics index
//   node bin/agenttape.mjs index --json   …and print it, for analysis
//
// It runs alongside `npm run dev` and answers two questions for the page:
// which sessions exist, and give me that one. It does not serve the app —
// Next.js already does that, and a second way to serve it would be a second
// path-resolution surface to get wrong in a tool whose entire job is refusing
// to hand over the wrong file.
//
// It is a convenience, not a requirement: the web app parses a dropped file
// with no helper at all, and the deployed build is drag-and-drop only.
//
// What it will not do:
//   * bind anywhere but 127.0.0.1
//   * serve a path that does not resolve inside ~/.claude/projects
//   * read, print or transmit a session title — titles are derived from user
//     prompts, so they leak the content this whole project exists to protect.
//     The same rule covers a subagent's `description`: it is written from the
//     prompt that spawned it, so the sidecar is read for its ids and never for
//     that field
//   * write anything inside ~/.claude/projects, or anywhere at all except one
//     cache file of its own, in its own cache directory. That cache holds
//     statistics — counts, durations, token totals, tool names — and no text
//     from any transcript
//
// No dependencies. Node 22.18 or newer, because `check` imports the parser and
// the rule checker as TypeScript modules and relies on the type stripping that
// became unflagged there.

import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { extname, join, resolve, sep } from "node:path";

const PROJECTS = join(homedir(), ".claude", "projects");

/**
 * The one place this program writes. Deliberately nowhere near the transcripts:
 * a cache under ~/.claude/projects would be a file the helper had put inside
 * the tree it promises only to read.
 */
const CACHE_DIR = process.platform === "darwin"
  ? join(homedir(), "Library", "Caches", "agenttape")
  : join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "agenttape");
const CACHE_FILE = join(CACHE_DIR, "sessions.json");
const CACHE_FORMAT = "agenttape-index/1";
const DEFAULT_PORT = 4319;
// Claude Code names project directories after the encoded path, which starts
// with a hyphen — so a leading hyphen has to be allowed. What must not get
// through is a separator, a traversal, or a bare dot; those are checked below.
const SAFE_SEGMENT = /^[A-Za-z0-9._-]{1,255}$/;

const argv = process.argv.slice(2);
const flag = (name) => argv.includes("--" + name);
const value = (name, fallback) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

// `check` and `index` import the parser as TypeScript and rely on the type
// stripping that stopped needing a flag in 22.18. Saying so beats letting Node
// fail inside an import with a message about an unexpected token.
const NODE_MIN = "22.18.0";
function nodeIsOldEnough() {
  const [a, b] = process.versions.node.split(".").map(Number);
  return a > 22 || (a === 22 && b >= 18);
}
function requireNode(what) {
  if (nodeIsOldEnough()) return;
  console.error(
    `\n  ${what} needs Node ${NODE_MIN} or newer — this is ${process.versions.node}.\n` +
    `  It reads the parser as TypeScript, which older Node cannot do without a flag.\n` +
    "  Everything else in this tool works on any Node 18.\n",
  );
  process.exit(2);
}

const HELP = `
  agenttape — replay and check Claude Code sessions that already happened

  Nothing here talks to the network. Every command reads files under
  ~/.claude/projects and writes nothing but one cache file of its own.

  agenttape check <rules.json> <tape>   check a run against stated expectations
                                        exit 0 held · 1 failed · 2 unreadable
      --json                            print the result as JSON instead
      Both a .jsonl transcript and a redacted .tape.json work, and give the
      same answer: no rule reads a message body. Example rule sets are in
      examples/ — start with lenient.rules.json.

  agenttape index                       build the cross-session statistics index
      --json                            print it, for analysis

  agenttape                             list recent sessions and serve them to
                                        the page on 127.0.0.1 (Ctrl-C to stop)
      --list                            list and exit, serving nothing
      --all                             do not stop at the twenty most recent
      --port N                          default ${DEFAULT_PORT}

  agenttape --help                      this

  Node ${NODE_MIN} or newer. There is no install step and nothing is published
  to npm: clone the repository and run the file.

  Full rule reference: docs/rules.md
`;

const PORT = Number(value("port", DEFAULT_PORT)) || DEFAULT_PORT;
const LIMIT = flag("all") ? Infinity : Number(value("limit", 20)) || 20;

// ---------------------------------------------------------------- scanning

/**
 * Count lines and tool calls without parsing anything. The needle is matched
 * against raw bytes with an overlap between chunks, so a 76 MB transcript costs
 * one sequential read and no JSON parsing at all.
 */
async function scanFile(path) {
  const NEEDLE = Buffer.from('"type":"tool_use"');
  const OVERLAP = NEEDLE.length - 1;
  let lines = 0;
  let tools = 0;
  let tail = Buffer.alloc(0);
  let lastByte = 10;

  await new Promise((done, fail) => {
    const rs = createReadStream(path, { highWaterMark: 1 << 20 });
    rs.on("data", (chunk) => {
      for (let i = 0; i < chunk.length; i++) if (chunk[i] === 10) lines++;
      if (chunk.length) lastByte = chunk[chunk.length - 1];
      const hay = tail.length ? Buffer.concat([tail, chunk]) : chunk;
      let from = 0;
      for (;;) {
        const at = hay.indexOf(NEEDLE, from);
        if (at === -1) break;
        tools++;
        from = at + NEEDLE.length;
      }
      tail = hay.subarray(Math.max(0, hay.length - OVERLAP));
    });
    rs.on("end", () => done());
    rs.on("error", fail);
  });

  // A trailing newline ends the last line rather than starting another.
  return { lines: lastByte === 10 ? lines : lines + 1, tools };
}

async function listSessions({ deep }) {
  let projects;
  try {
    projects = await readdir(PROJECTS, { withFileTypes: true });
  } catch {
    return { error: `no ~/.claude/projects directory (looked in ${PROJECTS})`, sessions: [] };
  }

  const found = [];
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    let files;
    try {
      files = await readdir(join(PROJECTS, p.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      // Main sessions only. The subagents/ directory is a v1 non-goal.
      if (!f.isFile() || extname(f.name) !== ".jsonl") continue;
      const full = join(PROJECTS, p.name, f.name);
      const st = await stat(full).catch(() => null);
      if (!st) continue;
      found.push({
        project: p.name,
        session: f.name.slice(0, -6),
        bytes: st.size,
        mtime: st.mtimeMs,
        lines: 0,
        tools: 0,
        agents: [],
      });
    }
  }

  found.sort((a, b) => b.mtime - a.mtime);
  const head = found.slice(0, deep);
  for (const s of head) {
    const counted = await scanFile(join(PROJECTS, s.project, s.session + ".jsonl"));
    s.lines = counted.lines;
    s.tools = counted.tools;
    s.agents = await listAgents(s.project, s.session);
  }
  return { sessions: head, total: found.length };
}

/**
 * The subagent files beside a session, with the id of the call each belongs to.
 *
 * That id comes from the `.meta.json` sidecar, which is the only place the link
 * exists — nothing inside a subagent transcript points back at its parent. The
 * sidecar also carries a `description` written from the prompt that spawned the
 * agent; it is prose about the user's work, so it is never read here and never
 * sent. Only the ids and the agent type leave this function.
 */
async function listAgents(project, session) {
  const dir = join(PROJECTS, project, session, "subagents");
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
    const id = e.name.slice("agent-".length, -".jsonl".length);
    if (!e.name.startsWith("agent-") || !SAFE_SEGMENT.test(id)) continue;
    const st = await stat(join(dir, e.name)).catch(() => null);
    const rec = { id, bytes: st ? st.size : 0, toolUseId: "", agentType: "" };
    try {
      const meta = JSON.parse(await readFile(join(dir, `agent-${id}.meta.json`), "utf8"));
      // Two fields, deliberately. `description` is not one of them.
      if (typeof meta.toolUseId === "string") rec.toolUseId = meta.toolUseId;
      if (typeof meta.agentType === "string") rec.agentType = meta.agentType;
    } catch {
      /* no sidecar: the page falls back to pairing by time */
    }
    out.push(rec);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

// ------------------------------------------------------------- statistics

/**
 * Statistics for one session, read one line at a time and never held whole.
 *
 * The record itself is built by lib/stats.ts, which is where the property that
 * matters is documented and tested: no field of it can hold a sentence.
 */
async function indexTranscript(session, path) {
  const { createIndexer, pushLine, finishIndex, pairTools } = await import("../lib/parser.ts");
  const ix = createIndexer(session);
  let off = 0;
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    const len = Buffer.byteLength(line);
    pushLine(ix, line, off, len);
    off += len + 1;
  }
  const { meta, steps, entries } = finishIndex(ix);
  return { meta, steps, entries, pairs: pairTools(steps) };
}

async function readCache() {
  try {
    const raw = JSON.parse(await readFile(CACHE_FILE, "utf8"));
    if (raw?.format !== CACHE_FORMAT || typeof raw.entries !== "object") return {};
    return raw.entries ?? {};
  } catch {
    return {};
  }
}

async function writeCache(entries) {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(CACHE_FILE, JSON.stringify({ format: CACHE_FORMAT, entries }));
  } catch (e) {
    // A cache that cannot be written is slow, not broken.
    console.error(`  could not write the index cache: ${e.message}`);
  }
}

/**
 * Statistics for every session, using the cache for the ones that have not
 * changed. A transcript is only appended to, so file size and mtime together
 * are enough to know an entry is still true; either changing re-indexes it.
 */
async function buildIndex({ onProgress } = {}) {
  const cache = await readCache();
  const entries = {};
  const found = [];

  let projects;
  try {
    projects = await readdir(PROJECTS, { withFileTypes: true });
  } catch {
    return { sessions: [], cached: 0, indexed: 0, error: `no ${PROJECTS}` };
  }

  for (const p of projects) {
    if (!p.isDirectory()) continue;
    let files;
    try {
      files = await readdir(join(PROJECTS, p.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.isFile() || extname(f.name) !== ".jsonl") continue;
      const path = join(PROJECTS, p.name, f.name);
      const st = await stat(path).catch(() => null);
      if (st) found.push({ project: p.name, session: f.name.slice(0, -6), path, st });
    }
  }

  // The iteration, the freshness rule and the record itself all live in
  // lib/session-index.ts, shared with the browser. Only where the bytes come
  // from differs.
  const { buildSessionIndex, byRecency } = await import("../lib/session-index.ts");
  const built = await buildSessionIndex(
    found.map((f) => ({
      project: f.project,
      session: f.session,
      bytes: f.st.size,
      mtime: f.st.mtimeMs,
      index: () => indexTranscript(f.session, f.path),
    })),
    cache,
    onProgress,
  );

  // Written before the agent lists are attached, on purpose: the cache is keyed
  // by the transcript's own size and mtime, and a subagent file can appear or
  // change without either moving. Anything that can go stale that way is
  // recomputed on every build instead.
  await writeCache(built.entries);
  const sessions = byRecency(built.entries);
  for (const s of sessions) s.agents = await listAgents(s.project, s.session);
  return { sessions, cached: built.cached, indexed: built.indexed };
}

// ---------------------------------------------------------------- printing

const fmtBytes = (n) =>
  n >= 1 << 20 ? (n / (1 << 20)).toFixed(1) + " MB"
    : n >= 1 << 10 ? Math.round(n / (1 << 10)) + " KB"
      : n + " B";

const fmtAgo = (ms) => {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 90) return s + "s ago";
  const m = Math.round(s / 60);
  if (m < 90) return m + "m ago";
  const h = Math.round(m / 60);
  if (h < 48) return h + "h ago";
  return Math.round(h / 24) + "d ago";
};

const pad = (s, n) => String(s).padEnd(n);
const padS = (s, n) => String(s).padStart(n);

function printList({ sessions, total, error }) {
  if (error) {
    console.error(error);
    return;
  }
  if (!sessions.length) {
    console.log("No .jsonl transcripts under ~/.claude/projects.");
    return;
  }
  const w = Math.min(46, Math.max(...sessions.map((s) => s.project.length)));
  console.log("");
  console.log(
    "  " + pad("#", 4) + pad("project", w + 2) + pad("session", 10) +
    padS("size", 9) + padS("lines", 8) + padS("tools", 7) + padS("agents", 8) + "  modified",
  );
  console.log("  " + "─".repeat(w + 2 + 10 + 9 + 8 + 7 + 8 + 12));
  sessions.forEach((s, i) => {
    console.log(
      "  " + pad(i + 1, 4) +
      pad(s.project.length > w ? s.project.slice(0, w - 1) + "…" : s.project, w + 2) +
      pad(s.session.slice(0, 8), 10) +
      padS(fmtBytes(s.bytes), 9) +
      padS(s.lines.toLocaleString("en-US"), 8) +
      padS(s.tools.toLocaleString("en-US"), 7) +
      padS(s.agents.length ? String(s.agents.length) : "—", 8) +
      "  " + fmtAgo(s.mtime),
    );
  });
  if (total > sessions.length) {
    console.log(`\n  ${sessions.length} of ${total} sessions shown — pass --all for the rest.`);
  }
  console.log("\n  Titles are not read and not shown: they are generated from your prompts.");
  console.log("  \"agents\" counts the subagent transcripts beside each session.");
}

// ---------------------------------------------------------------- serving

/**
 * Resolve a request to a file, or refuse. Every rejection is deliberate:
 * segments are validated before they are joined, the result is realpath'd so a
 * symlink cannot point out of the tree, and the resolved path is re-checked
 * against the realpath'd root with a separator so /projects-evil cannot pass
 * as /projects.
 *
 * Subagent transcripts go through this same function rather than a second one.
 * They sit two directories deeper, so `agent` is one more segment held to the
 * same rule, and everything after the join is unchanged. A second resolver
 * would be a second place to get this wrong.
 */
async function resolveTranscript(project, session, agent = "") {
  if (!project || !session) return { error: "project and session are both required" };
  if (!SAFE_SEGMENT.test(project) || !SAFE_SEGMENT.test(session))
    return { error: "project and session must be plain path segments" };
  if (agent && !SAFE_SEGMENT.test(agent))
    return { error: "agent must be a plain path segment" };
  if (project.includes("..") || session.includes("..") || agent.includes("..") ||
      project === "." || session === "." || agent === ".")
    return { error: "no traversal" };

  const root = await realpath(PROJECTS).catch(() => null);
  if (!root) return { error: "no projects directory" };

  const candidate = agent
    ? resolve(root, project, session, "subagents", `agent-${agent}.jsonl`)
    : resolve(root, project, session + ".jsonl");
  const real = await realpath(candidate).catch(() => null);
  if (!real) return { error: agent ? "no such subagent" : "no such session" };
  if (real !== candidate) return { error: "refusing to follow a symlink out of the tree" };
  if (!real.startsWith(root + sep)) return { error: "outside ~/.claude/projects" };
  if (extname(real) !== ".jsonl") return { error: "not a transcript" };

  const st = await stat(real).catch(() => null);
  if (!st || !st.isFile()) return { error: "not a regular file" };
  return { path: real, size: st.size };
}

const ALLOWED_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;

function allowOrigin(req, res) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (!ALLOWED_ORIGIN.test(origin)) return false;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  return true;
}

/** Reject a Host header that is not loopback: cheap DNS-rebinding defence. */
function hostIsLoopback(req) {
  const host = String(req.headers.host ?? "");
  const name = host.replace(/:\d+$/, "");
  return name === "127.0.0.1" || name === "localhost" || name === "[::1]";
}

const json = (res, code, body) => {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
};

function serve(initial) {
  let cache = initial;

  const server = createServer(async (req, res) => {
    if (!hostIsLoopback(req)) { res.writeHead(403).end("loopback only"); return; }
    if (!allowOrigin(req, res)) { res.writeHead(403).end("origin refused"); return; }
    res.setHeader("x-content-type-options", "nosniff");

    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
      res.writeHead(204).end();
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      // Read-only, in the plainest possible way.
      res.writeHead(405, { allow: "GET, HEAD, OPTIONS" }).end("read only");
      return;
    }

    const url = new URL(req.url ?? "/", "http://127.0.0.1");

    if (url.pathname === "/sessions") {
      if (url.searchParams.get("refresh") === "1" || !cache) {
        cache = await listSessions({ deep: LIMIT });
      }
      json(res, 200, cache);
      return;
    }

    // One handler, one resolver. /subagent differs from /file by a segment.
    if (url.pathname === "/file" || url.pathname === "/subagent") {
      const agent = url.pathname === "/subagent" ? url.searchParams.get("agent") : "";
      if (url.pathname === "/subagent" && !agent) {
        json(res, 400, { error: "agent is required" });
        return;
      }
      const found = await resolveTranscript(
        url.searchParams.get("project"),
        url.searchParams.get("session"),
        agent ?? "",
      );
      if (found.error) { json(res, 400, { error: found.error }); return; }
      res.writeHead(200, {
        "content-type": "application/x-ndjson; charset=utf-8",
        "content-length": found.size,
        "cache-control": "no-store",
      });
      if (req.method === "HEAD") { res.end(); return; }
      createReadStream(found.path).pipe(res);
      return;
    }

    if (url.pathname === "/overview") {
      const built = await buildIndex();
      json(res, 200, built);
      return;
    }

    if (url.pathname === "/health") { json(res, 200, { ok: true, projects: PROJECTS }); return; }

    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end(
      "AgentTape helper.\n\n" +
      "  GET /sessions                          the session index\n" +
      "  GET /overview                          statistics for every session\n" +
      "  GET /file?project=&session=            one transcript, read-only\n" +
      "  GET /subagent?project=&session=&agent=  one subagent transcript\n" +
      "  GET /health                            liveness\n\n" +
      "This is not the app. Run `npm run dev` in another terminal and open\n" +
      "http://localhost:3000 — the page will find this helper on its own.\n",
    );
  });

  // 127.0.0.1, never 0.0.0.0. Nothing on this machine's network can reach it.
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`\n  helper on http://127.0.0.1:${PORT}  (loopback only, read-only)`);
    console.log(`  serving transcripts from ${PROJECTS}`);
    console.log("  run `npm run dev` in another terminal and open http://localhost:3000");
    console.log("  — the page finds this helper on its own.\n");
    console.log("  Ctrl-C to stop.");
  });
  server.on("error", (e) => {
    console.error(`  cannot listen on 127.0.0.1:${PORT}: ${e.message}`);
    process.exit(1);
  });
}

// ---------------------------------------------------------------- checking

/**
 * Index a tape the same way the browser does — one line at a time, holding the
 * index and not the file. A .tape.json goes through the same reader the page
 * uses, so a scrubbed tape checks exactly as a transcript does.
 */
async function readTape(path) {
  const { createIndexer, pushLine, finishIndex, pairTools } = await import("../lib/parser.ts");
  if (path.endsWith(".tape.json") || path.endsWith(".json")) {
    const { tapeFromFile } = await import("../lib/tape.ts");
    const tape = tapeFromFile(JSON.parse(await readFile(path, "utf8")));
    return { steps: tape.steps, pairs: pairTools(tape.steps), meta: tape.meta };
  }
  const ix = createIndexer(path.split("/").pop() ?? "tape");
  let off = 0;
  const rl = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of rl) {
    const len = Buffer.byteLength(line);
    pushLine(ix, line, off, len);
    off += len + 1;
  }
  const { meta, steps } = finishIndex(ix);
  return { steps, pairs: pairTools(steps), meta };
}

const CHECK_FORMAT = "agenttape-check/1";

/**
 * The block somebody pastes into an issue when a check fails in their CI.
 *
 * It is Markdown because that is what issue trackers eat, and it is built from
 * the rule labels and the results — both of which are written by this program
 * from a fixed vocabulary. No part of it comes from a message body, which is
 * the property that makes it safe to paste somewhere public. The tape is named
 * by its basename: a full path says where somebody keeps their work.
 */
function pasteBlock(results, t, set, tape, tapePath, rulesPath) {
  const base = (x) => x.split("/").pop() ?? x;
  const failed = results.filter((r) => !r.pass);
  const out = [];
  out.push(`**\`agenttape check\`** — ${failed.length} of ${results.length} ` +
    `rule${results.length === 1 ? "" : "s"} failed on \`${base(tapePath)}\` ` +
    `(${tape.steps.length.toLocaleString("en-US")} steps)` +
    (set.name ? `, rule set \`${set.name}\`` : "") + ".");
  out.push("");
  out.push("| rule | what happened | step |");
  out.push("| --- | --- | --- |");
  for (const r of failed) {
    out.push(`| ${r.label} | ${r.detail} | ${r.at >= 0 ? (r.at + 1).toLocaleString("en-US") : "—"} |`);
  }
  if (t.vacuous) {
    out.push("");
    out.push(`${t.vacuous} further rule${t.vacuous === 1 ? " had" : "s had"} nothing to check ` +
      "in this run, which is not the same as holding.");
  }
  out.push("");
  out.push(`Reproduce: \`node bin/agenttape.mjs check ${base(rulesPath)} ${base(tapePath)}\``);
  out.push("");
  out.push("Every rule reads the index — tool names, timings, token counts, error flags — " +
    "and none reads a message body, so this block carries no transcript text.");
  return out.join("\n");
}

async function check(rulesPath, tapePath, opts = {}) {
  const { parseRuleSet, checkAll, tally } = await import("../lib/assert.ts");
  const asJson = !!opts.json;
  // With --json the only thing on stdout is the JSON. Complaints go to stderr,
  // so `agenttape check ... --json | jq` keeps working when the rule set is bad.
  const say = asJson ? (m) => process.stderr.write(m + "\n") : (m) => console.log(m);

  let text;
  try {
    text = await readFile(rulesPath, "utf8");
  } catch (e) {
    console.error(`cannot read the rule set: ${e.message}`);
    console.error("two to copy: examples/lenient.rules.json, examples/strict.rules.json");
    return 2;
  }
  const { set, problems } = parseRuleSet(text);
  for (const p of problems) console.error("  rule set: " + p);
  if (!set.rules.length) {
    console.error("no usable rules — nothing to check. The reference is docs/rules.md.");
    return 2;
  }

  let tape;
  try {
    tape = await readTape(tapePath);
  } catch (e) {
    console.error(`cannot read the tape: ${e.message}`);
    return 2;
  }

  const results = checkAll(tape.steps, set.rules, tape.pairs);
  const t = tally(results);

  if (asJson) {
    console.log(JSON.stringify({
      format: CHECK_FORMAT,
      pass: t.fail === 0,
      tape: { name: tapePath.split("/").pop(), steps: tape.steps.length },
      ruleSet: { name: set.name || "", rules: set.rules.length },
      tally: { held: t.pass - t.vacuous, failed: t.fail, vacuous: t.vacuous },
      results: results.map((r) => ({
        kind: r.rule.kind,
        label: r.label,
        pass: r.pass,
        vacuous: r.vacuous,
        detail: r.detail,
        // One-based, to match what the page and the paste block show.
        step: r.at >= 0 ? r.at + 1 : null,
      })),
    }));
    return t.fail ? 1 : 0;
  }

  const name = set.name ? ` · ${set.name}` : "";
  say(`\n  ${tapePath.split("/").pop()} — ${tape.steps.length.toLocaleString("en-US")} steps${name}\n`);
  for (const r of results) {
    const mark = r.pass ? (r.vacuous ? "    " : "ok  ") : "FAIL";
    const at = r.at >= 0 ? `  (step ${(r.at + 1).toLocaleString("en-US")})` : "";
    say(`  ${mark}  ${r.label}`);
    say(`        ${r.detail}${at}`);
  }
  const vac = t.vacuous ? `, ${t.vacuous} with nothing to check` : "";
  say(`\n  ${t.pass - t.vacuous} held, ${t.fail} failed${vac}\n`);

  if (t.fail) {
    say("  ── copy from here " + "─".repeat(52));
    say(pasteBlock(results, t, set, tape, tapePath, rulesPath));
    say("  ── to here " + "─".repeat(59) + "\n");
  }

  // The exit code is the point: it is what lets this sit in somebody's CI.
  return t.fail ? 1 : 0;
}

// ---------------------------------------------------------------- main

if (!argv.length && !process.stdout.isTTY) {
  // Piped with no arguments: almost certainly somebody expecting output, not
  // somebody expecting a server. Say what the no-argument behaviour is rather
  // than starting one into a pipe that will never be read.
  console.log(HELP);
  process.exit(0);
}

if (argv[0] === "help" || flag("help") || argv.includes("-h")) {
  console.log(HELP);
  process.exit(0);
}

if (argv[0] === "index") {
  requireNode("agenttape index");
  const t0 = Date.now();
  let last = 0;
  const built = await buildIndex({
    onProgress: (done, total, indexed, cached) => {
      const now = Date.now();
      if (now - last < 250 && done !== total) return;
      last = now;
      process.stderr.write(`\r  ${done}/${total} sessions · ${indexed} indexed · ${cached} cached   `);
    },
  });
  process.stderr.write("\n");
  if (built.error) {
    console.error("  " + built.error);
    process.exit(2);
  }
  if (flag("json")) {
    console.log(JSON.stringify(built.sessions));
  } else {
    const ms = Date.now() - t0;
    console.log(`\n  ${built.sessions.length} sessions · ${built.indexed} indexed · ` +
      `${built.cached} from cache · ${(ms / 1000).toFixed(1)}s`);
    console.log(`  cache: ${CACHE_FILE}\n`);
  }
  process.exit(0);
}

if (argv[0] === "check") {
  requireNode("agenttape check");
  const rest = argv.slice(1).filter((a) => !a.startsWith("--"));
  if (rest.length < 2) {
    console.error(
      "\n  usage: agenttape check <rules.json> <tape.jsonl|tape.tape.json> [--json]\n\n" +
      "  A rule set is plain JSON stating what the run was supposed to do.\n" +
      "  Two to copy: examples/lenient.rules.json, examples/strict.rules.json\n" +
      "  The reference is docs/rules.md. Exit 0 held, 1 failed, 2 unreadable.\n",
    );
    process.exit(2);
  }
  process.exit(await check(rest[0], rest[1], { json: flag("json") }));
}

const listing = await listSessions({ deep: LIMIT });
printList(listing);
if (!flag("list")) serve(listing);
