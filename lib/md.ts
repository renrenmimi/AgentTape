// The smallest Markdown reader that can render docs/format-notes.md.
//
// Not a Markdown library and not trying to be. It handles the subset that file
// actually uses — headings, paragraphs, bullet lists, fenced code, tables,
// horizontal rules, and inline code, bold, italic and links — and it produces
// data rather than HTML, so the page renders it as React elements and there is
// no escaping to get wrong.
//
// The alternative was keeping the prose in a TypeScript module and the file in
// docs/, and asserting the two agree. One of them would still have rotted. The
// file stays canonical because that is what a stranger reads on GitHub, and
// this reads the file.

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong"; v: Inline[] }
  | { t: "em"; v: Inline[] }
  | { t: "link"; v: Inline[]; href: string };

export type Block =
  | { b: "heading"; level: number; text: Inline[] }
  | { b: "para"; text: Inline[] }
  | { b: "list"; items: Inline[][] }
  | { b: "code"; text: string; lang: string }
  | { b: "table"; head: Inline[][]; rows: Inline[][][] }
  | { b: "hr" };

/**
 * Inline spans, left to right, code first.
 *
 * Code first because a code span is the one thing that must not have its
 * contents interpreted: `**` inside backticks is two asterisks, and a reader
 * that handles emphasis before code gets that wrong on exactly the text this
 * document is full of.
 */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let i = 0;
  let plain = "";
  const flush = () => {
    if (plain) out.push({ t: "text", v: plain });
    plain = "";
  };

  while (i < src.length) {
    const c = src[i];

    if (c === "`") {
      const end = src.indexOf("`", i + 1);
      if (end > i) {
        flush();
        out.push({ t: "code", v: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    if (c === "[") {
      const close = src.indexOf("](", i);
      if (close > i) {
        const stop = src.indexOf(")", close + 2);
        if (stop > close) {
          flush();
          out.push({
            t: "link",
            v: parseInline(src.slice(i + 1, close)),
            href: src.slice(close + 2, stop),
          });
          i = stop + 1;
          continue;
        }
      }
    }

    if (c === "*" && src[i + 1] === "*") {
      const end = src.indexOf("**", i + 2);
      if (end > i + 1) {
        flush();
        out.push({ t: "strong", v: parseInline(src.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }

    if (c === "*") {
      const end = src.indexOf("*", i + 1);
      if (end > i + 1 && !/\s/.test(src[i + 1])) {
        flush();
        out.push({ t: "em", v: parseInline(src.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }

    plain += c;
    i++;
  }
  flush();
  return out;
}

const cells = (row: string): string[] =>
  row.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());

const isDivider = (row: string): boolean =>
  /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(row) && row.includes("-");

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) body.push(lines[i++]);
      i++; // the closing fence
      out.push({ b: "code", text: body.join("\n"), lang });
      continue;
    }

    if (/^#{1,6}\s/.test(line)) {
      const level = line.match(/^#+/)?.[0].length ?? 1;
      out.push({ b: "heading", level, text: parseInline(line.replace(/^#+\s*/, "")) });
      i++;
      continue;
    }

    if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      out.push({ b: "hr" });
      i++;
      continue;
    }

    if (line.trimStart().startsWith("|") && isDivider(lines[i + 1] ?? "")) {
      const head = cells(line).map(parseInline);
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && lines[i].trimStart().startsWith("|")) {
        rows.push(cells(lines[i]).map(parseInline));
        i++;
      }
      out.push({ b: "table", head, rows });
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: Inline[][] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        let text = lines[i].replace(/^\s*[-*]\s+/, "");
        i++;
        // A wrapped bullet continues on an indented line.
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*[-*]\s+/.test(lines[i])) {
          text += " " + lines[i].trim();
          i++;
        }
        items.push(parseInline(text));
      }
      out.push({ b: "list", items });
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\s*[-*]\s|\|)/.test(lines[i]) &&
           !/^(-{3,}|\*{3,})\s*$/.test(lines[i])) {
      para.push(lines[i].trim());
      i++;
    }
    if (para.length) out.push({ b: "para", text: parseInline(para.join(" ")) });
    else i++;
  }

  return out;
}

/** Every heading, for a contents list. */
export const headings = (blocks: Block[]): { level: number; text: string; slug: string }[] =>
  blocks
    .filter((b): b is Extract<Block, { b: "heading" }> => b.b === "heading")
    .map((h) => {
      const text = plainText(h.text);
      return { level: h.level, text, slug: slugify(text) };
    });

export function plainText(inline: Inline[]): string {
  return inline
    .map((n) => (n.t === "text" || n.t === "code" ? n.v : plainText(n.v)))
    .join("");
}

export const slugify = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
