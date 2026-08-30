"use client";

// Keeping the keyboard inside a dialog while one is open.
//
// Moving focus in is half of it. The other half is that Tab must not walk out
// the back of the dialog into the workbench behind it, which is exactly what a
// keyboard user experiences as the page having lost them. Escape is handled by
// the page, which knows what is open.

import { useEffect, type RefObject } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

export function useDialogFocus(panel: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = panel.current;
    const was = document.activeElement as HTMLElement | null;
    el?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !el) return;
      const stops = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)]
        .filter((n) => n.offsetParent !== null || n === document.activeElement);
      if (!stops.length) { e.preventDefault(); el.focus(); return; }
      const first = stops[0];
      const last = stops[stops.length - 1];
      const here = document.activeElement;
      if (!el.contains(here)) { e.preventDefault(); first.focus(); return; }
      if (e.shiftKey && here === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && here === last) { e.preventDefault(); first.focus(); }
    };

    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      was?.focus?.();
    };
  }, [panel]);
}
