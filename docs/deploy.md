# Deploying

**Deployed: <https://agenttape.vercel.app>**

This file is the ordered list that produced that, and — the more useful half —
what the deployed build cannot do. Every claim below was measured against the
live deployment, not read off the documentation.

## The steps, in order

1. `npm ci && npx next build`. All four routes must come back `○ (Static)`. If
   any of them is dynamic, stop: something has grown a server dependency and
   the rest of this file is no longer true.
2. `npx vercel whoami`. If this fails, authenticate first; nothing below works
   without it.
3. `npx vercel --prod --yes --name agenttape`. The `--name` is required and is
   not cosmetic: Vercel rejects a project name that is not lowercase, and the
   repository is `AgentTape`, so the default derived from the directory is
   refused with a 400.
4. `npx vercel project ls` to read the production alias. It is
   `agenttape.vercel.app`.
5. `gh repo edit renrenmimi/AgentTape --homepage https://agenttape.vercel.app`.

There is no `vercel.json` and none is needed.

| setting | value | why |
| --- | --- | --- |
| Framework preset | Next.js | detected |
| Build command | `next build` | the default |
| Install command | `npm install` | the default |
| Output directory | default | the default |
| Root directory | repository root | there is one project here |
| Node.js version | 20.x or 22.x | Next 15 needs ≥ 18.18. The 22.18 floor in the README is the *checker's*, not the build's — `bin/agenttape.mjs` never runs on Vercel |
| Environment variables | **none** | `process.env` does not appear anywhere under `app/` or `lib/`, and `verify.mjs` asserts it |

`.vercel/` is written by the CLI and is ignored.

## What the deployed build cannot do

The helper, and only the helper. The page talks to `127.0.0.1:4319` **only when
it is itself being served from localhost**, so on any other origin the helper
does not exist and neither does anything it feeds:

* the list of recent sessions on the empty state,
* opening a session by clicking a row,
* the cross-session overview built by walking `~/.claude/projects`.

This is not a limitation to route around. A deployed build has no filesystem to
walk and no business reading one, and the localhost-only rule is the same rule
that makes the privacy claim on the front page checkable.

Measured against the live deployment: the helper block does not render, and
**the only host the page contacts is the origin it was served from**. No request
to `127.0.0.1` is attempted at all.

`agenttape check`, `agenttape stats` and `agenttape index` are the command line.
They read your disk, they are not deployed, and they are the part of this that
is meant to run in somebody else's CI.

## What still works, measured on the deployment

Everything that does not need a filesystem: drag and drop, the demo tape, the
timeline, the messages array, the filter, the comparison, the assertions panel,
the redacted export, the Markdown report, and `/format` — which returned 200
with all twelve of its sections.

Including the cross-session overview, the browser one, where you grant a folder
rather than the helper walking it:

| origin | `isSecureContext` | `showDirectoryPicker` | overview |
| --- | --- | --- | --- |
| `https://agenttape.vercel.app` | **true** | **present** | folder picker |
| `http://localhost` | true | present | folder picker |
| `http://<lan-ip>` | false | absent | falls back to `webkitdirectory` |

The first row is measured on the deployment. The File System Access API needs a
secure context; Vercel serves HTTPS, so the picker is there. The third row is
what a plain-HTTP host would give, and the `webkitdirectory` fallback covers it
— as it also covers Firefox and Safari, which do not implement the picker at
all. Safari's behaviour here is documented rather than measured: the WebKit
build on this machine could not be launched.
