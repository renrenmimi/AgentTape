"use client";

// The landing page: two ways to start, with the explanation next to each.
//
// What is deliberately not here is the seven-item feature list the old empty
// state opened with. Every line of it was true and none of it was the next
// thing to do, so the two buttons that are the next thing to do sat below the
// fold on a laptop. The features are still findable — they are the session
// itself — and they are not asked to compete with the demo button for the
// first screen.
//
// The privacy claim stays on this screen, because it is what somebody needs to
// believe before dropping months of private work onto a web page, and because
// it is checkable: there is no upload endpoint in this application and the
// only request it can make goes to 127.0.0.1, from a page served by localhost.

import { OpenPanel, type OpenError, type Progress } from "./open-session";
import { FolderIcon, ListIcon } from "./icons";

type Props = {
  onFiles: (files: File[]) => void;
  onDemo: () => void;
  onBrowseLocal: () => void;
  progress: Progress | null;
  error: OpenError | null;
};

export default function Home({ onFiles, onDemo, onBrowseLocal, progress, error }: Props) {
  return (
    <main className="home" id="main">
      <div className="home-inner">
        <h1 className="home-title">See what happened in an agent session.</h1>
        <p className="home-lede">
          Replay a Claude Code transcript, inspect tool calls, and trace changes in context.
        </p>

        <OpenPanel
          lead="demo"
          onFiles={onFiles}
          onDemo={onDemo}
          progress={progress}
          error={error}
          replacing={false}
        >
          <div className="home-explain">
            <p>
              <b>The demo</b> is a fictional session with two tool failures, a context jump, a
              compaction and a delegated run in it.
            </p>
            <p>
              <b>Your own transcripts</b> are already on disk, at{" "}
              <code>~/.claude/projects</code>. Nothing needs to be instrumented before a run.
            </p>
          </div>
        </OpenPanel>

        <nav className="home-side" aria-label="Other ways in">
          <button type="button" className="btn btn-quiet" onClick={onBrowseLocal}>
            <FolderIcon />
            <span>Browse local sessions</span>
          </button>
          <a className="btn btn-quiet" href="/format">
            <ListIcon />
            <span>Supported format</span>
          </a>
        </nav>
      </div>
    </main>
  );
}
