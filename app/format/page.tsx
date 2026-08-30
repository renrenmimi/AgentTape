// The transcript format, as a page.
//
// docs/format-notes.md stays canonical — it is what a stranger reads on GitHub,
// and a second copy in a TypeScript module would be a second thing to keep
// true. This reads that file at build time and renders it with lib/md.ts, so
// there is one source and nothing to keep in agreement.
//
// A server component, so the read happens once during the build and the page
// ships as static HTML. Nothing here runs in the browser.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Metadata } from "next";
import Link from "next/link";
import { headings, parseMarkdown, plainText, slugify, type Block, type Inline } from "@/lib/md";

export const metadata: Metadata = {
  title: "The Claude Code transcript format — AgentTape",
  description:
    "What Claude Code writes to disk for every session, and the four things about it that are " +
    "not what you would guess. Field notes from parsing forty sessions.",
};

const SOURCE = join(process.cwd(), "docs", "format-notes.md");

function Spans({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        if (n.t === "text") return <span key={i}>{n.v}</span>;
        if (n.t === "code") return <code key={i}>{n.v}</code>;
        if (n.t === "strong") return <strong key={i}><Spans nodes={n.v} /></strong>;
        if (n.t === "em") return <em key={i}><Spans nodes={n.v} /></em>;
        return (
          <a key={i} href={n.href} rel="noreferrer">
            <Spans nodes={n.v} />
          </a>
        );
      })}
    </>
  );
}

function Rendered({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((b, i) => {
        if (b.b === "hr") return <hr key={i} />;
        if (b.b === "code") return <pre key={i}><code>{b.text}</code></pre>;
        if (b.b === "list") {
          return (
            <ul key={i}>
              {b.items.map((it, k) => <li key={k}><Spans nodes={it} /></li>)}
            </ul>
          );
        }
        if (b.b === "table") {
          return (
            <div className="doc-table" key={i}>
              <table>
                <thead>
                  <tr>{b.head.map((h, k) => <th key={k}><Spans nodes={h} /></th>)}</tr>
                </thead>
                <tbody>
                  {b.rows.map((r, k) => (
                    <tr key={k}>{r.map((c, j) => <td key={j}><Spans nodes={c} /></td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        if (b.b === "heading") {
          const id = slugify(plainText(b.text));
          const H = (["h1", "h2", "h3", "h4", "h5", "h6"] as const)[Math.min(5, b.level - 1)];
          return <H key={i} id={id}><Spans nodes={b.text} /></H>;
        }
        return <p key={i}><Spans nodes={b.text} /></p>;
      })}
    </>
  );
}

export default function FormatPage() {
  const src = readFileSync(SOURCE, "utf8");
  const blocks = parseMarkdown(src);
  const toc = headings(blocks).filter((h) => h.level === 2);

  return (
    <main className="doc">
      <header className="doc-head">
        <Link href="/" className="btn btn-sm">← AgentTape</Link>
        <span className="spacer" />
        <span className="eyebrow">reference</span>
      </header>

      <div className="doc-body">
        <nav className="doc-toc" aria-label="Contents">
          <span className="eyebrow">contents</span>
          <ol>
            {toc.map((h) => (
              <li key={h.slug}><a href={"#" + h.slug}>{h.text}</a></li>
            ))}
          </ol>
          <p className="doc-toc-note">
            This page renders <code>docs/format-notes.md</code> from the repository. That file is
            the canonical copy; there is no second one to keep in agreement.
          </p>
        </nav>

        <article className="doc-prose">
          <Rendered blocks={blocks} />
        </article>
      </div>
    </main>
  );
}
