#!/usr/bin/env node
// Measuring the palette against the surfaces it is actually painted on.
//
// A token table is a promise about legibility, and the only way a promise like
// that stays true through a redesign is if something measures it. This reads
// app/tokens.css, resolves every pair the application actually renders, and
// computes the WCAG 2.2 contrast ratio for it.
//
// Two ratios, because WCAG asks for two. Body text needs 4.5:1; large text
// (>=18.66px bold or >=24px) and the visual boundary of a control or a graph
// need 3:1. Each pair below declares which it is, so a value that is fine for
// a border and not for a sentence cannot be filed under the wrong one.
//
//   node scripts/contrast.mjs          # print the table
//   node scripts/contrast.mjs --quiet  # only the failures
//
// verify.mjs imports checkContrast() from here, so this is the same
// measurement in CI and on a desk rather than two that can disagree.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Pull one theme's custom properties out of the token file. */
export function readTokens(css = readFileSync(join(root, "app/tokens.css"), "utf8")) {
  const themes = { light: {}, dark: {} };
  const blocks = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  for (const [, selector, body] of blocks) {
    const which = /\[data-theme="dark"\]/.test(selector)
      ? "dark"
      : /:root|\[data-theme="light"\]/.test(selector)
        ? "light"
        : null;
    if (!which) continue;
    for (const [, name, value] of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
      themes[which][name] = value.trim();
      // `:root` without a theme attribute is the light theme *and* the shared
      // defaults, so anything declared there that dark does not override still
      // applies in dark. Seeding both keeps the resolution honest.
      if (!/data-theme/.test(selector) && themes.dark[name] === undefined) {
        themes.dark[name] = value.trim();
      }
    }
  }
  return themes;
}

const hex = (v) => {
  const m = /^#([0-9a-f]{6})$/i.exec(v.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

const rgba = (v) => {
  const m = /^rgba?\(([^)]+)\)$/.exec(v.trim());
  if (!m) return null;
  const p = m[1].split(",").map((x) => Number(x.trim()));
  return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
};

/** Flatten a translucent colour onto the surface behind it. */
function resolve(value, behind) {
  const solid = hex(value);
  if (solid) return solid;
  const t = rgba(value);
  if (!t) return null;
  const [r, g, b, a] = t;
  return [
    Math.round(r * a + behind[0] * (1 - a)),
    Math.round(g * a + behind[1] * (1 - a)),
    Math.round(b * a + behind[2] * (1 - a)),
  ];
}

const channel = (c) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

const luminance = ([r, g, b]) =>
  0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

export function ratio(fg, bg) {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * Every foreground/background pair the application renders, with the ratio its
 * role has to meet.
 *
 * "text" is 4.5:1 — the AA requirement for body copy, and the one this file
 * exists to hold. "ui" is 3:1, which WCAG 2.2 asks of the visual boundary of a
 * control and of information carried by a graph; a border that only has to be
 * *findable* is held to that and not to the text bar.
 */
export const PAIRS = [
  // page-level text
  ["text-primary", "bg-page", "text", "body text on the page"],
  ["text-primary", "bg-surface", "text", "body text on a surface"],
  ["text-primary", "bg-subtle", "text", "body text on a subtle panel"],
  ["text-primary", "bg-selected", "text", "the selected step's label"],
  ["text-primary", "bg-hover", "text", "a hovered row's label"],
  ["text-secondary", "bg-page", "text", "secondary text on the page"],
  ["text-secondary", "bg-surface", "text", "secondary text on a surface"],
  ["text-secondary", "bg-subtle", "text", "secondary text on a subtle panel"],
  ["text-secondary", "bg-selected", "text", "the selected step's summary"],
  ["text-muted", "bg-surface", "text", "step numbers and placeholders"],
  ["text-muted", "bg-subtle", "text", "muted text on a subtle panel"],
  ["text-muted", "bg-page", "text", "muted text on the page"],
  ["text-accent", "bg-surface", "text", "a link"],
  ["text-accent", "bg-page", "text", "a link on the page"],
  ["text-accent", "bg-selected", "text", "the selected tab's label"],

  // the primary action
  ["action-text", "action-bg", "text", "the primary button"],
  ["action-text", "action-hover", "text", "…hovered"],
  ["action-text", "action-pressed", "text", "…pressed"],

  // status
  ["success-text", "success-bg", "text", "a check that passed"],
  ["success-text", "bg-surface", "text", "…stated inline"],
  ["warning-text", "warning-bg", "text", "an incomplete record"],
  ["warning-text", "bg-surface", "text", "…stated inline"],
  ["error-text", "error-bg", "text", "a failure"],
  ["error-text", "bg-surface", "text", "…stated inline"],
  ["error-text", "bg-selected", "text", "a failure on the selected step"],
  ["info-text", "info-bg", "text", "a neutral notice"],

  // code
  ["code-text", "code-bg", "text", "code"],
  ["code-comment", "code-bg", "text", "a comment in code"],
  ["code-keyword", "code-bg", "text", "a keyword"],
  ["code-string", "code-bg", "text", "a string"],
  ["code-number", "code-bg", "text", "a number"],

  // boundaries and graphs — 3:1, which is what these carry
  ["border-control", "bg-surface", "ui", "the edge of an input"],
  ["border-control", "bg-page", "ui", "the edge of a control on the page"],
  ["focus-ring", "bg-surface", "ui", "the focus ring"],
  ["focus-ring", "bg-page", "ui", "…on the page"],
  ["focus-ring", "bg-selected", "ui", "…on the selected row"],
  ["action-bg", "bg-surface", "ui", "the primary button against the page"],
  ["chart-line", "bg-surface", "ui", "the context line"],
  ["chart-tick", "bg-surface", "ui", "a step tick"],
  ["chart-tick-tool", "bg-surface", "ui", "a tool-call tick"],
  ["chart-fail", "bg-surface", "ui", "a failure mark"],
  ["chart-warn", "bg-surface", "ui", "a compaction mark"],
  ["chart-axis-text", "bg-surface", "text", "an axis label"],
  ["chart-selected", "bg-surface", "ui", "the selected point"],
];

const NEED = { text: 4.5, ui: 3 };

export function checkContrast() {
  const themes = readTokens();
  const out = [];
  for (const theme of ["light", "dark"]) {
    const t = themes[theme];
    const page = hex(t["--bg-page"]);
    for (const [fg, bg, kind, what] of PAIRS) {
      const back = resolve(t[`--${bg}`] ?? "", page);
      const front = resolve(t[`--${fg}`] ?? "", back ?? page);
      if (!front || !back) {
        out.push({ theme, fg, bg, kind, what, ratio: 0, need: NEED[kind], ok: false,
          why: "unresolved" });
        continue;
      }
      const r = ratio(front, back);
      out.push({ theme, fg, bg, kind, what, ratio: r, need: NEED[kind],
        ok: r >= NEED[kind], why: "" });
    }
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const quiet = process.argv.includes("--quiet");
  const rows = checkContrast();
  const bad = rows.filter((r) => !r.ok);
  let theme = "";
  for (const r of rows) {
    if (quiet && r.ok) continue;
    if (r.theme !== theme) { theme = r.theme; console.log(`\n  ${theme}`); }
    console.log(
      `  ${r.ok ? "ok  " : "FAIL"}  ${r.ratio.toFixed(2)}:1  (needs ${r.need})  ` +
      `${r.fg} on ${r.bg} — ${r.what}`,
    );
  }
  console.log(`\n  ${rows.length - bad.length}/${rows.length} pairs meet their ratio\n`);
  process.exit(bad.length ? 1 : 0);
}
