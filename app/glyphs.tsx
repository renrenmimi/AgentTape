"use client";

// Tick shapes. Colour tells you whether a step failed; shape tells you what
// kind of step it was. Both are always present, so the timeline stays readable
// with no colour perception at all.
//
// The canvas in timeline.tsx draws the same eight shapes with the same
// proportions. These SVGs exist so the legend can show the real thing rather
// than a coloured square standing in for it.

import type { StepKind } from "@/lib/format";

export const KIND_LABEL: Record<StepKind, string> = {
  "user": "user turn",
  "text": "assistant text",
  "thinking": "thinking",
  "tool-call": "tool call",
  "tool-result": "tool result",
  "system": "system",
  "attachment": "attachment",
  "meta": "bookkeeping",
};

export function KindGlyph({ kind, size = 11 }: { kind: StepKind; size?: number }) {
  const s = size;
  const c = s / 2;
  const stroke = "currentColor";
  const common = { fill: "none", stroke, strokeWidth: 1.3 } as const;
  return (
    <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`} aria-hidden focusable="false">
      {kind === "user" && <rect x={c - 3} y={c - 3} width={6} height={6} fill={stroke} />}
      {kind === "text" && <rect x={c - 4} y={c - 1.5} width={8} height={3} fill={stroke} />}
      {kind === "thinking" && <circle cx={c} cy={c} r={2.7} {...common} />}
      {kind === "tool-call" && (
        <path d={`M${c} ${c - 3.6} L${c + 3.6} ${c + 2.6} L${c - 3.6} ${c + 2.6} Z`} fill={stroke} />
      )}
      {kind === "tool-result" && (
        <path d={`M${c} ${c + 3.6} L${c + 3.6} ${c - 2.6} L${c - 3.6} ${c - 2.6} Z`} {...common} />
      )}
      {kind === "system" && (
        <path d={`M${c - 3.4} ${c} H${c + 3.4} M${c} ${c - 3.4} V${c + 3.4}`} stroke={stroke} strokeWidth={1.4} />
      )}
      {kind === "attachment" && (
        <path d={`M${c} ${c - 3.4} L${c + 3.4} ${c} L${c} ${c + 3.4} L${c - 3.4} ${c} Z`} {...common} />
      )}
      {kind === "meta" && <circle cx={c} cy={c} r={1.3} fill={stroke} />}
    </svg>
  );
}

/** A tool call that handed the work to somebody else. */
export function DelegateGlyph({ size = 11 }: { size?: number }) {
  const c = size / 2;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden focusable="false">
      <path d={`M${c} ${c - 1.2} L${c + 3.6} ${c + 4} L${c - 3.6} ${c + 4} Z`} fill="currentColor" />
      <path d={`M${c} ${c - 4.6} V${c - 2}`} stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" />
      <circle cx={c} cy={c - 5} r={1.3} fill="currentColor" />
    </svg>
  );
}

export function FailGlyph({ size = 11 }: { size?: number }) {
  const c = size / 2;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden focusable="false">
      <path d={`M${c - 3.2} ${c - 3.2} L${c + 3.2} ${c + 3.2} M${c + 3.2} ${c - 3.2} L${c - 3.2} ${c + 3.2}`}
        stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" />
    </svg>
  );
}
