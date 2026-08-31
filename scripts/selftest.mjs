#!/usr/bin/env node
// Run the in-page suite in a real browser, and exit non-zero when it fails.
//
//   npm run build && npx next start -p 3000 &
//   node scripts/selftest.mjs                     # http://127.0.0.1:3000/?selftest=1
//   node scripts/selftest.mjs http://127.0.0.1:3111/
//   node scripts/selftest.mjs --helper            # …with the local helper too
//
// No dependencies, and deliberately none. Node 22 has a built-in `WebSocket`
// and Chrome speaks the DevTools Protocol over it, so the whole driver is this
// file. The alternative was a browser-automation library, and the argument
// against it is this machine: a webkit-2287 installed against a playwright
// expecting webkit-2336 hangs on launch with no output at all, which is exactly
// the failure mode a test harness must not have. A driver you can read in one
// sitting fails in ways you can see.
//
// It exists as a committed file for the same reason. The sibling project
// deleted its driver after the round that wrote it and consequently cannot run
// its assertions at all today.

import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const URL_ARG = process.argv.find((a) => a.startsWith("http")) ?? "http://127.0.0.1:3000/";

/**
 * Which mode to run in, decided here rather than by what happens to be running
 * on the machine.
 *
 * The overview block needs the local helper. It used to probe for one and adapt,
 * so the suite behaved differently depending on the box — four assertions
 * answered here, four skipped there. A gate cannot be built on that, and next
 * round this becomes a gate on a runner where the helper will never be up.
 *
 * Default is `no-helper`: the page is told not to exercise that path, and the
 * four assertions come back marked skipped whether or not a helper is running.
 * `--helper` asks for the other mode, and is refused up front if nothing
 * answers — asking for a mode and silently not getting it is the failure this
 * whole item exists to remove.
 */
const HELPER = process.argv.includes("--helper");
const HELPER_URL = "http://127.0.0.1:4319/health";

const q = (u, k) => u + (u.includes("?") ? "&" : "?") + k;
let TARGET = URL_ARG.includes("selftest=") ? URL_ARG : q(URL_ARG, "selftest=1");
if (HELPER && !TARGET.includes("helper=")) TARGET = q(TARGET, "helper=1");
const TIMEOUT_MS = Number(process.env.SELFTEST_TIMEOUT ?? 120_000);
const T0 = Date.now();
const secs = () => ((Date.now() - T0) / 1000).toFixed(1);

// ---------------------------------------------------------------- finding chrome

/**
 * Where Chrome is, in the order somebody would look.
 *
 * `CHROME_PATH` first because that is what a runner sets, then the macOS
 * application, then the names a Linux runner has on PATH. It has to work on
 * both without editing, or it will be edited into working on one.
 */
const CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
].filter(Boolean);

async function findChrome() {
  for (const c of CANDIDATES) {
    if (c.includes("/")) {
      try { await access(c, constants.X_OK); return c; } catch { continue; }
    } else {
      const found = await new Promise((res) => {
        const p = spawn("command", ["-v", c], { shell: true, stdio: ["ignore", "pipe", "ignore"] });
        let out = "";
        p.stdout.on("data", (d) => { out += d; });
        p.on("close", () => res(out.trim() || null));
        p.on("error", () => res(null));
      });
      if (found) return found;
    }
  }
  return null;
}

// ---------------------------------------------------------------- the protocol

let nextId = 1;
function rpc(ws, method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const onMessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id !== id) return;
      ws.removeEventListener("message", onMessage);
      m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result);
    };
    ws.addEventListener("message", onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevTools(port, deadline) {
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return await r.json();
    } catch { /* not up yet */ }
    await sleep(120);
  }
  throw new Error(`Chrome did not open a debugging port on ${port}`);
}

// ---------------------------------------------------------------- reporting

function paste(res, url) {
  const bad = res.results.filter((r) => !r.ok && !r.skipped);
  const out = [];
  out.push(`**AgentTape in-page suite** — ${bad.length} of ${res.total} assertions failed ` +
    `(${res.pass} passed, ${res.skipped} not run here), in ${res.mode} mode.`);
  if (res.total !== res.expected) {
    out.push("");
    out.push(`The suite declares ${res.expected} assertions and ran ${res.total}. ` +
      "A short run means a block did not finish, not that a check was removed.");
  }
  out.push("");
  out.push("| assertion | detail |");
  out.push("| --- | --- |");
  for (const r of bad) out.push(`| ${r.label} | ${r.note ? r.note : "—"} |`);
  out.push("");
  out.push(`Reproduce: \`npx next start -p 3000 & node scripts/selftest.mjs ${url}` +
    `${HELPER ? " --helper" : ""}\``);
  return out.join("\n");
}

// ---------------------------------------------------------------- main

// Fail fast on the mistake everybody makes first: running this without the
// server up. Waiting two minutes to say "the suite never reported" when the
// answer is "nothing is listening" is the difference between a useful CI log
// and a useless one.
let servedHtml = "";
try {
  const r = await fetch(TARGET, { method: "GET" });
  if (!r.ok) throw new Error(`${r.status}`);
  servedHtml = await r.text();
} catch (e) {
  console.error(
    `\n  Nothing is serving ${TARGET} (${e instanceof Error ? e.message : e}).\n` +
    "  Start it first:  npm run build && npx next start -p 3000\n",
  );
  process.exit(2);
}

/**
 * Is the thing on that port the build in this working tree?
 *
 * A server left over from another terminal answers on the port and serves a
 * build nobody here compiled — which has cost this project a morning twice, and
 * a green run against a stale build is worse than a red one because it is a
 * lie about code that was never loaded. `next build` writes a BUILD_ID and the
 * served page carries it, so the two can simply be compared.
 */
try {
  const want = (await readFile(new URL("../.next/BUILD_ID", import.meta.url), "utf8")).trim();
  if (want && !servedHtml.includes(want)) {
    console.error(
      `\n  The server on that port is not serving this build.\n` +
      `  .next/BUILD_ID is ${want} and the page does not mention it.\n` +
      "  Something else is on the port, or the build is newer than the server.\n",
    );
    process.exit(2);
  }
} catch {
  // No BUILD_ID: somebody is pointing this at a server built elsewhere, which
  // is allowed. The check is for the accident, not for the deliberate case.
}

if (HELPER) {
  const up = await fetch(HELPER_URL).then((r) => r.ok).catch(() => false);
  if (!up) {
    console.error(
      "\n  --helper was asked for and nothing is answering on 127.0.0.1:4319.\n" +
      "  Start it first:  npm run helper\n",
    );
    process.exit(2);
  }
}

const chrome = await findChrome();
if (!chrome) {
  console.error(
    "\n  No Chrome found. Set CHROME_PATH, or install one of:\n" +
    "    google-chrome · google-chrome-stable · chromium · chromium-browser\n",
  );
  process.exit(2);
}

const profile = await mkdtemp(join(tmpdir(), "agenttape-selftest-"));
const port = 9222 + Math.floor(Math.random() * 900);
const child = spawn(chrome, [
  "--headless=new",
  "--disable-gpu",
  "--no-sandbox",                 // CI containers run as root; there is no untrusted content here
  "--disable-dev-shm-usage",      // small /dev/shm in containers crashes the renderer otherwise
  "--no-first-run",
  "--no-default-browser-check",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });

const chromeStderr = [];
child.stderr.on("data", (d) => chromeStderr.push(String(d)));

const deadline = Date.now() + TIMEOUT_MS;
let code = 2;
try {
  await waitForDevTools(port, deadline);

  // The blank tab, so emulation is in place before anything renders.
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error("Chrome opened no page target");

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", () => rej(new Error("could not attach to the page")), { once: true });
  });

  const threw = [];
  const logged = [];
  ws.addEventListener("message", (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    if (m.method === "Runtime.exceptionThrown") {
      const d = m.params.exceptionDetails;
      threw.push(d.exception?.description ?? d.text ?? "exception");
    }
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      logged.push(m.params.args.map((a) => a.description ?? a.value ?? "").join(" ").slice(0, 200));
    }
  });

  await rpc(ws, "Runtime.enable");
  await rpc(ws, "Page.enable");

  // A window this size, so the timeline has room for one tick per step and the
  // canvas readback means something.
  await rpc(ws, "Emulation.setDeviceMetricsOverride", {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  // Measured, because the usual claim about this flag is stronger than what it
  // does here: without it `document.hasFocus()` is false in a headless window,
  // with it true. That is what `:focus-visible` and anything else keyed to the
  // window having focus depend on.
  //
  // Turning it off does not currently move the score, and saying so is the
  // point: the suite's focus assertions read `document.activeElement`, which a
  // window can set while unfocused. So this is not fixing a failure today, it
  // is stopping the next focus assertion somebody writes from passing for the
  // wrong reason.
  await rpc(ws, "Emulation.setFocusEmulationEnabled", { enabled: true });

  await rpc(ws, "Page.navigate", { url: TARGET });

  let res = null;
  while (Date.now() < deadline) {
    const r = await rpc(ws, "Runtime.evaluate", {
      expression: "JSON.stringify(window.__selftest ?? null)",
      returnByValue: true,
    });
    const v = r.result?.value;
    if (v && v !== "null") { res = JSON.parse(v); break; }
    await sleep(200);
  }

  if (!res) {
    // Where it got to, rather than that it did not get anywhere. A hang that
    // the runner kills produces no signal at all; this produces one.
    let at = null;
    try {
      const r = await rpc(ws, "Runtime.evaluate", {
        expression: "JSON.stringify(window.__selftest_at ?? null)", returnByValue: true,
      });
      at = r.result?.value && r.result.value !== "null" ? JSON.parse(r.result.value) : null;
    } catch { /* the page may be gone */ }
    console.error(`\n  The suite never reported. ${TARGET} did not set window.__selftest ` +
      `within ${Math.round(TIMEOUT_MS / 1000)}s (${secs()}s elapsed).`);
    console.error(at
      ? `  It stopped in "${at.block}" after ${at.ran ?? 0} assertions, ` +
        `${((Date.now() - at.at) / 1000).toFixed(1)}s ago.`
      : "  It never entered a block, so the failure is before the first one.");
    if (threw.length) console.error("  The page threw: " + threw[0].split("\n")[0]);
    code = 2;
  } else {
    const bad = res.results.filter((r) => !r.ok && !r.skipped);
    console.log(`\n  [${res.mode}] ${res.pass}/${res.total} passed · ${bad.length} failed · ` +
      `${res.skipped} not run here · ${res.expected} declared, ` +
      `${res.expectedSkips} skips declared · ${secs()}s\n`);
    for (const r of bad) console.log(`  FAIL  ${r.label}${r.note ? "   [" + r.note + "]" : ""}`);

    // The protocol saw these too. The suite has its own trap for them and
    // asserts on it; this is the second pair of eyes, and it catches anything
    // thrown before the trap was armed.
    for (const t of [...new Set(threw)]) console.log(`  THREW ${t.split("\n")[0]}`);
    for (const l of [...new Set(logged)]) console.log(`  LOG   ${l}`);

    const short = res.total !== res.expected;
    const wrongSkips = res.skipped !== res.expectedSkips;
    const wrongMode = res.mode !== (HELPER ? "helper" : "no-helper");
    if (wrongMode) {
      console.log(`  FAIL  the page ran in ${res.mode} and the driver asked for ` +
        `${HELPER ? "helper" : "no-helper"}`);
    }
    if (wrongSkips) {
      console.log(`  FAIL  ${res.skipped} assertions were skipped and ` +
        `${res.mode} declares ${res.expectedSkips}`);
    }
    if (bad.length || short || wrongSkips || wrongMode || threw.length) {
      console.log("\n  ── copy from here " + "─".repeat(52));
      console.log(paste(res, TARGET));
      console.log("  ── to here " + "─".repeat(59) + "\n");
      code = 1;
    } else {
      console.log("");
      code = 0;
    }
  }
  ws.close();
} catch (e) {
  console.error("\n  " + (e instanceof Error ? e.message : String(e)));
  if (chromeStderr.length) console.error("  chrome said: " + chromeStderr.join("").trim().split("\n").slice(-2).join(" "));
  code = 2;
} finally {
  child.kill("SIGKILL");
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
process.exit(code);
