# Build directories

**`next dev` writes to `.next-dev`. `next build` and `next start` write to and
read from `.next`. They never share a directory, and `npm start` builds before
it starts, so a production server can never come up on a directory that a dev
server rewrote underneath it or that a build had not finished writing.**

That paragraph is the whole of it, and it is here because its absence cost three
rounds of this project.

## What it looked like

A dev server left running in another terminal, a production build in this one,
then `next start` — and:

```
⨯ [Error: Cannot find module './331.js'
Require stack:
- .next/server/webpack-runtime.js
```

Every request 500s. Nothing in the error names the cause, so it reads as a
corrupt install: the reflex is `rm -rf node_modules`, which does not help,
followed by `rm -rf .next && npm run build`, which does — and which teaches you
that it was bad luck rather than that two processes are writing one directory.

It happened three times, in three different rounds, and each time it cost
twenty minutes of looking in the wrong place. The second time it was diagnosed
correctly and still not fixed, because a rebuild is faster than a fix.

## Why it is structural now rather than remembered

`next.config.mjs` chooses `distDir` from the phase. Development is the only
phase that gets `.next-dev`; `next build` and `next start` are both
non-development, so they agree with each other and cannot be separated by
accident.

The other half was `next start` racing a build that had not finished. `npm
start` runs `prestart`, which is `next build`, so there is no window in which
`.next` is half-written and something is serving from it. It costs a rebuild
every time you start a production server, which is the correct trade: the
rebuild is forty seconds and the failure mode was twenty minutes.

## What this does not cover

Running two production servers on different ports from one checkout still shares
`.next` between them. That is fine — they are reading, not writing — but a build
while one is serving will still swap the files underneath it. If you need a
production server to stay up across a build, use a second checkout.
