// One build directory each.
//
// `next dev` and `next build` wrote to the same `.next`, so a dev server left
// running in another terminal would rewrite it under a production build — or a
// production build would rewrite it under the dev server. The symptom is
// `Cannot find module './331.js'` from a `next start` that is reading half of
// one build and half of another, and it cost three rounds of this project
// before anybody treated it as a bug rather than as bad luck.
//
// The fix is that they never share a directory. Development writes to
// `.next-dev`; `next build` and `next start` are both non-development phases,
// so they agree on `.next` and cannot be split from each other.

import { PHASE_DEVELOPMENT_SERVER } from "next/constants.js";

/** @type {(phase: string) => import("next").NextConfig} */
export default (phase) => ({
  distDir: phase === PHASE_DEVELOPMENT_SERVER ? ".next-dev" : ".next",
});
