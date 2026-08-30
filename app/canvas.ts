"use client";

// Getting a 2D context, with one decision in it.
//
// Chrome keeps a canvas on the GPU until something reads pixels back, and warns
// when a canvas that is read from repeatedly was not created with
// willReadFrequently. Setting that flag moves rendering to software, which is
// the wrong trade for a rail that repaints on every frame of a drag.
//
// Nothing in the app reads pixels back. The only reader is the self-test, which
// counts the ticks the timeline actually painted. So the flag is set only when
// the self-test is going to run: production canvases stay on the GPU, and the
// one situation that reads them back gets a canvas that is cheap to read and no
// warning in the console.
//
// The options are only honoured on the first getContext call for a canvas, so
// this must be the only place either canvas asks for its context.

let readback: boolean | null = null;

function wantsReadback(): boolean {
  if (readback !== null) return readback;
  try {
    readback = new URLSearchParams(window.location.search).has("selftest");
  } catch {
    readback = false;
  }
  return readback;
}

export function ctx2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  return canvas.getContext("2d", { willReadFrequently: wantsReadback() });
}
