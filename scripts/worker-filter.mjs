// Does `worker.yml`'s filter name everything the Worker's bundle actually
// holds? The pure half, so it can be tested without bundling anything.
//
// THE FILTER HAS BEEN WRONG TWICE, in the same way both times. It is a
// hand-written list of directories that has to stay in step with an import
// graph, and an import graph moves when somebody adds a line at the top of a
// file — which is not a moment anybody thinks about a workflow.
//
//   src/core   The protocol module started importing text.js and names.js.
//              The filter named worker/** and src/fleet/** only. Caught by
//              somebody noticing; the comment in worker.yml records it.
//
//   src/mcp    worker.js mounts the remote MCP server's routes, so six files
//              under src/mcp are compiled into the deployed Worker. The filter
//              never named them, and it cost a deploy: 0d3f8af ("Say which
//              origin, because Google will not", #291) changed
//              src/mcp/authorize-page.js and otherwise only docs/ and test/,
//              so worker.yml did not run and production kept the old code
//              until an unrelated commit happened to redeploy it.
//
// A missed deploy is the quietest failure this repository has. Nothing is red,
// no job is skipped in a way anybody sees, and the coordinator serves last
// week's code while main says otherwise.
//
// So the list stops being a thing to remember. esbuild already knows exactly
// which files end up in the bundle — it has to, in order to make one — and
// `--metafile` is that knowledge written down. check-worker-filter.mjs asks it,
// and this file decides whether the answer is covered.

/**
 * Does one of GitHub's `paths:` patterns match a repository-relative file?
 *
 * ONLY THE SHAPES THIS FILTER USES, and deliberately not a general glob. The
 * patterns here are `dir/**` and bare filenames, plus the negation `!**\/*.md`.
 * Implementing the whole of GitHub's syntax would mean writing a matcher whose
 * disagreements with GitHub are invisible until one of them lets a deploy
 * through — a checker that is subtly wrong is worse than no checker.
 *
 * Anything outside those shapes throws rather than guessing, so a pattern this
 * cannot reason about is a loud failure instead of a quiet pass.
 *
 * @param {string} pattern
 * @param {string} file repository-relative, forward slashes
 */
export function matchesPattern(pattern, file) {
  if (pattern.startsWith('!')) throw new Error(`negations are handled by the caller: ${pattern}`);
  if (pattern.endsWith('/**')) return file.startsWith(`${pattern.slice(0, -2)}`);
  if (!pattern.includes('*')) return file === pattern;
  throw new Error(
    `worker.yml has a paths pattern this check cannot reason about: ${pattern}\n` +
      'Teach scripts/worker-filter.mjs the shape, or use dir/** — do not leave it guessing.',
  );
}

/**
 * The files a `paths:` list does NOT cover.
 *
 * Negations are applied the way GitHub applies them: last match wins, so an
 * excluded file is excluded however many positive patterns claimed it. Only
 * `!**\/*.md` is understood, because it is the only one here.
 *
 * @param {string[]} patterns the `paths:` list, verbatim
 * @param {string[]} files repository-relative paths in the bundle
 * @returns {string[]} the uncovered ones
 */
export function uncovered(patterns, files) {
  const positive = patterns.filter((p) => !p.startsWith('!'));
  for (const p of patterns) {
    if (p.startsWith('!') && p !== '!**/*.md') {
      throw new Error(`worker.yml has a negation this check does not understand: ${p}`);
    }
  }
  // A markdown file in the bundle would be a strange thing, and the exclusion
  // is real, so it is honoured rather than assumed away.
  const relevant = files.filter((f) => !f.endsWith('.md'));
  return relevant.filter((f) => !positive.some((p) => matchesPattern(p, f)));
}

/**
 * The directory prefixes a `paths:` list claims, for checking the `changes`
 * job's shell against it.
 *
 * The job cannot read the YAML — it runs before any npm install, on purpose,
 * because it is the cheap gate in front of everything else. So the two lists
 * are written twice and this is what stops them drifting: every prefix the
 * trigger names has to appear literally in the shell that answers the same
 * question on a pull request.
 *
 * @param {string[]} patterns
 */
export function prefixes(patterns) {
  // `/**` off the end, not just `**` — the trailing slash is what
  // matchesPattern wants and what a message reading `'src/mcp//**'` does not.
  return patterns.filter((p) => !p.startsWith('!') && p.endsWith('/**')).map((p) => p.slice(0, -3));
}
