#!/usr/bin/env node
// Dialogs in the pinned Claude Code that nobody has listed, as a model reads
// them (docs/decide-design.md, section D; docs/ci.md).
//
//   CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_AI_TOKEN=… node scripts/claude-dialog-drift.mjs
//
// ADVISORY, NEVER GATING. scripts/claude-dialog-check.mjs is the gate: it
// fails when a dialog DIALOGS names is one the matchers would miss. This finds
// the ones DIALOGS does not name, which is how the trust dialog's rewording
// got past everything once. Each component that looks like a dialog (a
// question and a choice-like option among its strings) and holds no DIALOGS
// anchor is asked the fleet's two pinned questions; a confident "asked" with
// a confident kind becomes a GitHub warning annotation and a line in the job
// summary. The model's label is a claim, and a claim does not make a required
// check red, so this exits 0 whatever it finds.
//
// NO SECRETS, NO STEP. A fork's pull request has neither variable, and then
// this prints a notice and does nothing, as apt-repo.yml does. Renovate's
// Claude Code bumps are in-repository, so they get it.
//
// WHAT IS SENT is the component's own string literals, from a public binary:
// nothing of any session, so no mask.

import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { DIALOGS, enclosingFunction, literals } from '../src/fleet/host/claude-dialogs.js';
import { decideRequest, readDecideAnswer, DECIDE_MODEL, DECIDE_P_AWAITING, DECIDE_KIND_CONFIDENCE } from '../src/core/decide-questions.js';
import { claudeCodeVersion, fetchBinary } from './claude-dialog-check.mjs';

/** More than any release has drawn; past it the walk has lost the plot and says so. */
const MAX_CLUSTERS = 400;
/** What one cluster may send: the same ceiling a host's pane has. */
const MAX_STATE_BYTES = 4096;

/** A string a dialog would offer as a choice. */
const CHOICE_RE = /^(?:\d\.\s+)?(?:Yes|No|Allow|Deny|Continue|Cancel|Exit|Approve|Reject|Trust|Proceed|Skip|Keep|Use)\b/;
/** A question a dialog would ask: prose, ending in a question mark. */
const QUESTION_RE = /^[A-Z][^\n]{8,200}\?$/;

/**
 * Every dialog-shaped component in the binary that holds no DIALOGS anchor,
 * as its string literals.
 *
 * @param {string} source  the CLI binary, read as latin1
 * @returns {{ at: number, strings: string[] }[]}
 */
export function dialogClusters(source) {
  const anchors = DIALOGS.map((d) => d.anchor);
  /** @type {Map<number, string[]>} */
  const seen = new Map();
  for (const m of source.matchAll(/"([A-Z][^"\\\n]{8,200}\?)"/g)) {
    if (!QUESTION_RE.test(m[1])) continue;
    const region = enclosingFunction(source, /** @type {number} */ (m.index));
    if (!region || seen.has(region.start)) continue;
    const code = source.slice(region.start, region.end);
    const strings = literals(code);
    if (!strings.some((s) => CHOICE_RE.test(s.trim()))) continue;
    if (anchors.some((a) => code.includes(a))) continue;
    seen.set(region.start, strings);
    if (seen.size > MAX_CLUSTERS) break;
  }
  return [...seen].map(([at, strings]) => ({ at, strings }));
}

/** @param {string[]} strings */
function stateOf(strings) {
  let state = '';
  for (const s of strings) {
    const next = state ? `${state}\n${s}` : s;
    if (Buffer.byteLength(next) > MAX_STATE_BYTES) break;
    state = next;
  }
  return state;
}

async function main() {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_AI_TOKEN;
  if (!account || !token) {
    console.log('::notice::CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_AI_TOKEN is not set, so the pinned Claude Code was not checked for unlisted dialogs. See docs/ci.md.');
    return;
  }
  const version = claudeCodeVersion();
  const source = readFileSync(process.env.CLAUDE_BIN || fetchBinary(version), 'latin1');
  const clusters = dialogClusters(source);
  if (clusters.length > MAX_CLUSTERS) console.log(`::warning::more than ${MAX_CLUSTERS} dialog-shaped components; only the first were read`);
  const url = `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${DECIDE_MODEL}`;
  /** @type {string[]} */
  const found = [];
  let failed = 0;
  for (const { strings } of clusters.slice(0, MAX_CLUSTERS)) {
    const state = stateOf(strings);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(decideRequest(state)),
        signal: AbortSignal.timeout(20_000),
      });
      const body = await res.json().catch(() => null);
      if (res.status === 401 || res.status === 403) {
        console.log(`::warning::Workers AI refused the token (HTTP ${res.status}); it needs Account → Workers AI → Read. No dialogs were checked.`);
        return;
      }
      const a = res.ok && body?.success ? readDecideAnswer(body.result) : null;
      if (!a) {
        failed++;
        continue;
      }
      if (a.p >= DECIDE_P_AWAITING && a.kind && (a.confidence ?? 0) >= DECIDE_KIND_CONFIDENCE) {
        const quoted = strings.slice(0, 8).map((s) => JSON.stringify(s.slice(0, 120))).join(', ');
        console.log(`::warning title=Unlisted Claude Code dialog::Claude Code ${version} draws what reads as a ${a.kind} dialog (asked ${a.p.toFixed(2)}, kind ${a.confidence?.toFixed(2)}) that DIALOGS does not list: ${quoted}`);
        found.push(`- **${a.kind}** (asked ${a.p.toFixed(2)}, kind ${a.confidence?.toFixed(2)}): ${quoted}`);
      }
    } catch {
      failed++;
    }
  }
  const head = `Claude Code ${version}: ${clusters.length} dialog-shaped components not in DIALOGS, ${found.length} read as a dialog${failed ? `, ${failed} not answered` : ''}.`;
  console.log(head);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Unlisted Claude Code dialogs\n\n${head}\n\n${found.join('\n')}\n\nA model's reading, not a check: add the ones that are real to DIALOGS in src/fleet/host/claude-dialogs.js.\n`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => {
    // Advisory: a broken drift check is a notice, never a red build.
    console.log(`::warning::the dialog drift check could not run: ${e?.message ?? e}`);
  });
}
