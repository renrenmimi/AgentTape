# Deploying

AgentTape is prepared for deployment and is not deployed. This file is what
somebody needs to put it on Vercel, and — more usefully — what they lose by
doing so.

Every claim below was measured against a production build served from a
non-localhost origin, not read off the documentation.

## What Vercel needs

Nothing that is not already in the repository. There is no `vercel.json` and
none is needed.

| setting | value | why |
| --- | --- | --- |
| Framework preset | Next.js | detected |
| Build command | `next build` | the default |
| Install command | `npm install` | the default |
| Output directory | default | the default |
| Root directory | repository root | there is one project here |
| Node.js version | 20.x or 22.x | Next 15 needs ≥ 18.18. The 22.18 floor in the README is the *checker's*, not the build's — `bin/agenttape.mjs` is never run on Vercel |
| Environment variables | **none** | `process.env` does not appear anywhere under `app/` or `lib/` |

All four routes prerender to static content:

```
┌ ○ /            49.6 kB    152 kB
├ ○ /_not-found    995 B    104 kB
├ ○ /format      3.46 kB    106 kB
└ ○ /icon.svg        0 B      0 B
```

There are no API routes, no middleware, no serverless functions and no
revalidation. `/format` reads `docs/format-notes.md` with `readFileSync` at
**build** time, so the file has to be in the repository — it is — and nothing
reads it at request time.

## What stops working, and why

The helper is the whole of it. The page talks to `127.0.0.1:4319` only when it
is itself being served from localhost, so on any other origin the helper does
not exist and neither does anything it feeds:

* the list of recent sessions on the empty state,
* opening a session by clicking a row,
* the cross-session overview built by walking `~/.claude/projects`.

This is not a limitation to route around. A deployed build has no filesystem to
walk and no business reading one, and the localhost-only rule is the same rule
that makes the privacy claim on the front page checkable.

Measured on a production build served from `http://<lan-ip>:3111`: the helper
block does not render, and **the only host the page contacts is the origin it
was served from**. No request to `127.0.0.1` is attempted at all.

## What still works

Everything that does not need a filesystem, which is almost all of it: drag and
drop, the demo tape, the timeline, the messages array, the filter, the
comparison, the assertions panel, the redacted export, the Markdown report, and
`/format`.

Including, with one caveat, the cross-session overview — the browser one, where
you grant a folder rather than the helper walking it.

| origin | `isSecureContext` | `showDirectoryPicker` | overview |
| --- | --- | --- | --- |
| `https://…` (Vercel) | true | present | folder picker |
| `http://localhost` | true | present | folder picker |
| `http://<lan-ip>` | false | **absent** | falls back to `webkitdirectory` |

The File System Access API requires a secure context. Vercel serves HTTPS, so
the picker is available there; the third row is what a plain-HTTP host would
give, and the `webkitdirectory` fallback covers it — as it also covers Firefox
and Safari, which do not implement the picker at all.

## What is not a web feature

`agenttape check` and `agenttape index` are the command line. They read your
disk, they are not deployed, and they are the part of this that is meant to run
in somebody else's CI. See the README.
