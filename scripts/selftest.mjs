#!/usr/bin/env node
// Run the in-page suite in a real browser, and exit non-zero when it fails.
//
//   npm run build && npx next start -p 3000 &
//   node scripts/selftest.mjs                     # http://127.0.0.1:3000/?selftest=1
//   node scripts/selftest.mjs http://127.0.0.1:3111/
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
import { access, mkdtemp, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const URL_ARG = process.argv.find((a) => a.startsWith("http")) ?? "http://127.0.0.1:3000/";
const TARGET = URL_ARG.includes("selftest=")
  ? URL_ARG
  : URL_ARG + (URL_ARG.includes("?") ? "&" : "?") + "selftest=1";
const TIMEOUT_MS = Number(process.env.SELFTEST_TIMEOUT ?? 120_000);

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
    `(${res.pass} passed, ${res.skipped} not run here).`);
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
  out.push(`Reproduce: \`npx next start -p 3000 & node scripts/selftest.mjs ${url}\``);
  return out.join("\n");
}

// ---------------------------------------------------------------- main

// Fail fast on the mistake everybody makes first: running this without the
// server up. Waiting two minutes to say "the suite never reported" when the
// answer is "nothing is listening" is the difference between a useful CI log
// and a useless one.
try {
  const r = await fetch(TARGET, { method: "GET" });
  if (!r.ok) throw new Error(`${r.status}`);
} catch (e) {
  console.error(
    `\n  Nothing is serving ${TARGET} (${e instanceof Error ? e.message : e}).\n` +
    "  Start it first:  npm run build && npx next start -p 3000\n",
  );
  process.exit(2);
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
    console.error(`\n  The suite never reported. ${TARGET} did not set window.__selftest ` +
      `within ${Math.round(TIMEOUT_MS / 1000)}s.`);
    if (threw.length) console.error("  The page threw: " + threw[0].split("\n")[0]);
    code = 2;
  } else {
    const bad = res.results.filter((r) => !r.ok && !r.skipped);
    console.log(`\n  ${res.pass}/${res.total} passed · ${bad.length} failed · ` +
      `${res.skipped} not run here · ${res.expected} declared\n`);
    for (const r of bad) console.log(`  FAIL  ${r.label}${r.note ? "   [" + r.note + "]" : ""}`);

    // The protocol saw these too. The suite has its own trap for them and
    // asserts on it; this is the second pair of eyes, and it catches anything
    // thrown before the trap was armed.
    for (const t of [...new Set(threw)]) console.log(`  THREW ${t.split("\n")[0]}`);
    for (const l of [...new Set(logged)]) console.log(`  LOG   ${l}`);

    const short = res.total !== res.expected;
    if (bad.length || short || threw.length) {
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
