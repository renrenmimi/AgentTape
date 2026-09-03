"use client";

// Icons, at the one size the interface uses them.
//
// All of them are decorative: every control that carries one also carries a
// word, either visibly or as its accessible name. That is the rule this file
// exists to make easy to keep — none of these takes a label, so none of them
// can quietly become the only thing identifying a button.

type P = { size?: number };

const box = (size: number) => ({
  width: size, height: size, viewBox: "0 0 16 16",
  fill: "none", stroke: "currentColor", strokeWidth: 1.5,
  strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
  "aria-hidden": true, focusable: "false" as const,
});

export const FileIcon = ({ size = 16 }: P) => (
  <svg {...box(size)}><path d="M9 1.8H4.2a1 1 0 0 0-1 1v10.4a1 1 0 0 0 1 1h7.6a1 1 0 0 0 1-1V5.6z" /><path d="M9 1.8v3.8h3.8" /></svg>
);

export const FolderIcon = ({ size = 16 }: P) => (
  <svg {...box(size)}><path d="M1.8 4.2a1 1 0 0 1 1-1h3l1.4 1.6h6a1 1 0 0 1 1 1v6.4a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1z" /></svg>
);

export const PlayIcon = ({ size = 16 }: P) => (
  <svg {...box(size)}><path d="M4.4 2.6l8 5.4-8 5.4z" /></svg>
);

export const PrevIcon = ({ size = 16 }: P) => (
  <svg {...box(size)}><path d="M10 3.2L5.2 8l4.8 4.8" /></svg>
);

export const NextIcon = ({ size = 16 }: P) => (
  <svg {...box(size)}><path d="M6 3.2L10.8 8 6 12.8" /></svg>
);

export const CheckIcon = ({ size = 16 }: P) => (
  <svg {...box(size)}><path d="M2.8 8.4l3.2 3.2 7.2-7.2" /></svg>
);

export const CrossIcon = ({ size = 16 }: P) => (
  <svg {...box(size)}><path d="M3.6 3.6l8.8 8.8M12.4 3.6l-8.8 8.8" /></svg>
);

export const WarnIcon = ({ size = 16 }: P) => (
  <svg {...box(size)}><path d="M8 2.2l6 10.6H2z" /><path d="M8 6.4v3" /><path d="M8 11.2h.01" /></svg>
);

export const InfoIcon = ({ size = 16 }: P) => (
  <svg {...box(size)}><circle cx="8" cy="8" r="6.2" /><path d="M8 7.2v4" /><path d="M8 4.9h.01" /></svg>
);

export const BranchIcon = ({ size = 16 }: P) => (
  <svg {...box(size)}><circle cx="4.4" cy="3.6" r="1.8" /><circle cx="4.4" cy="12.4" r="1.8" />
    <circle cx="11.6" cy="8" r="1.8" /><path d="M4.4 5.4v5.2" /><path d="M4.4 8h5.4" /></svg>
);

export const SearchIcon = ({ size = 16 }: P) => (
  <svg {...box(size)}><circle cx="7.2" cy="7.2" r="4.4" /><path d="M10.4 10.4l3 3" /></svg>
);

export const FilterIcon = ({ size = 16 }: P) => (
  <svg {...box(size)}><path d="M2.4 3.4h11.2L9.4 8.2v4.4l-2.8 1.4V8.2z" /></svg>
);

export const ExportIcon = ({ size = 16 }: P) => (
  <svg {...box(size)}><path d="M8 10.6V2.4" /><path d="M5 5.2L8 2.2l3 3" />
    <path d="M2.8 10v2.6a1 1 0 0 0 1 1h8.4a1 1 0 0 0 1-1V10" /></svg>
);

export const ChecksIcon = ({ size = 16 }: P) => (
  <svg {...box(size)}><path d="M2.4 4.6l1.8 1.8 3-3" /><path d="M2.4 11.2l1.8 1.8 3-3" />
    <path d="M9.6 4.2h4" /><path d="M9.6 10.8h4" /></svg>
);

export const HelpIcon = ({ size = 16 }: P) => (
  <svg {...box(size)}><circle cx="8" cy="8" r="6.2" />
    <path d="M6.3 6.2a1.8 1.8 0 1 1 2.4 1.7c-.5.2-.7.6-.7 1.1v.3" /><path d="M8 11.6h.01" /></svg>
);

export const ThemeIcon = ({ size = 16 }: P) => (
  <svg {...box(size)}><circle cx="8" cy="8" r="3.4" /><path d="M8 1.4v1.6M8 13v1.6M1.4 8h1.6M13 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1" /></svg>
);

export const BackIcon = ({ size = 16 }: P) => (
  <svg {...box(size)}><path d="M13.2 8H3.2" /><path d="M7 3.8L2.8 8 7 12.2" /></svg>
);

export const CompareIcon = ({ size = 16 }: P) => (
  <svg {...box(size)}><path d="M4.4 2.6v10.8" /><path d="M11.6 2.6v10.8" />
    <path d="M1.6 5.4h5.6" /><path d="M8.8 10.6h5.6" /></svg>
);

export const ListIcon = ({ size = 16 }: P) => (
  <svg {...box(size)}><path d="M2.6 4.2h10.8M2.6 8h10.8M2.6 11.8h6.8" /></svg>
);
