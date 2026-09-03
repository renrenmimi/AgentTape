"use client";

// Theme: light, dark, or whatever the operating system says.
//
// Three decisions are baked in here.
//
// A first visitor gets **light**. The old default was dark, which is a fine
// choice for an instrument somebody already knows and a poor one for a page
// somebody is reading for the first time. An explicit choice already stored on
// this machine still wins over that default — changing the default must not
// change anybody's answer.
//
// `system` is a real third state rather than a starting guess: it keeps
// tracking `prefers-color-scheme` for as long as it is selected, so a machine
// that switches at sunset switches this too.
//
// And the only thing that reaches storage is the word "light", "dark" or
// "system". No session, no filename, no view state.

import {
  createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode,
} from "react";

export type Theme = "dark" | "light" | "system";
/** What `system` currently resolves to. The two are not the same fact. */
export type Resolved = "dark" | "light";

const THEME_KEY = "agenttape-theme";

/**
 * Runs before first paint, from the document head, so the first frame is
 * already the right theme. It writes two attributes: the resolved theme, which
 * the stylesheet keys off, and the preference, so the control can render the
 * right selection without waiting for an effect.
 */
export const themeScript =
  `(function(){var d=document.documentElement;var p="light";try{var s=localStorage.getItem(` +
  `"${THEME_KEY}");if(s==="light"||s==="dark"||s==="system")p=s;}catch(e){}` +
  `var r=p==="system"?(window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)")` +
  `.matches?"dark":"light"):p;d.dataset.theme=r;d.dataset.themePref=p;})();`;

type Ctx = { theme: Theme; resolved: Resolved; setTheme: (t: Theme) => void };

const ThemeContext = createContext<Ctx>({
  theme: "light",
  resolved: "light",
  setTheme: () => {},
});

const systemPrefers = (): Resolved =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";

/** Tell the canvases to repaint: they read their colours from CSS properties. */
function repaintCanvases(): void {
  window.dispatchEvent(new CustomEvent("agenttape:theme"));
}

function apply(resolved: Resolved, pref: Theme): void {
  const d = document.documentElement;
  if (d.dataset.theme === resolved && d.dataset.themePref === pref) return;
  d.dataset.theme = resolved;
  d.dataset.themePref = pref;
  repaintCanvases();
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  // The server has no storage and no media query, so the first client render
  // has to match the server's: "light", unconditionally. The effect below
  // adopts whatever the pre-paint script already put on the element, which is
  // the real answer and has been on screen since before hydration.
  const [theme, setThemeState] = useState<Theme>("light");
  const [resolved, setResolved] = useState<Resolved>("light");

  useEffect(() => {
    const d = document.documentElement;
    const pref = d.dataset.themePref;
    const next: Theme = pref === "dark" || pref === "light" || pref === "system" ? pref : "light";
    setThemeState(next);
    setResolved(next === "system" ? systemPrefers() : next);
  }, []);

  // Only while `system` is selected. A machine that flips at sunset flips this
  // with it; a machine whose owner chose light stays light.
  useEffect(() => {
    if (theme !== "system" || typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      const r = mq.matches ? "dark" : "light";
      setResolved(r);
      apply(r, "system");
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    const r: Resolved = next === "system" ? systemPrefers() : next;
    setThemeState(next);
    setResolved(r);
    apply(r, next);
    try {
      window.localStorage.setItem(THEME_KEY, next);
    } catch {
      /* private mode: the choice applies now and is not remembered */
    }
  }, []);

  const value = useMemo(() => ({ theme, resolved, setTheme }), [theme, resolved, setTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);

export const THEME_LABEL: Record<Theme, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
};
