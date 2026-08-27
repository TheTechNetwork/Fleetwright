export const meta = {
  name: 'review',
  description: 'Tiered adversarial review of the current branch: index cheap, find strong, triage cheap, adjudicate strong',
  whenToUse: 'Before a branch is tested on hardware or merged. Pass the branch name as args, or nothing for the current one.',
  phases: [
    { title: 'Index', detail: 'one cheap agent builds the shared briefing', model: 'fable' },
    { title: 'Find', detail: 'scoped reviewers, one per area, no overlap' },
    { title: 'Triage', detail: 'cheap batched pass drops the obvious noise', model: 'fable' },
    { title: 'Adjudicate', detail: 'strong batched pass on what survives' },
    { title: 'Judge', detail: 'one synthesis' },
  ],
}

// WHY THIS IS SHAPED LIKE THIS
//
// The first version of this review spawned 364 agents and spent 8.6M tokens to
// return 28 findings, then hit a session limit twice before it could finish.
// Three things caused that, and only one of them was the model.
//
//   RE-DERIVATION. Every agent ran `git diff main...HEAD` — thousands of lines —
//   and re-read the same files to build the same mental model. Fourteen agents
//   doing identical reading is thirteen wasted. Now ONE agent builds a briefing
//   and the rest are handed it, along with the exact list of files in their
//   scope so they never search.
//
//   ONE AGENT PER FINDING. 115 findings x 3 verifiers was 345 of the 364.
//   Verification is batched: one agent adjudicates eight claims in a single
//   context, reading each file once for all of them.
//
//   UNIFORM EFFORT AND UNIFORM MODEL. Everything ran on the strong model at high
//   effort, including agents whose job was to re-read a claim somebody had
//   already written down.
//
// THE TIERING, and where the line actually falls.
//
// The cheap tier is for work that is high-volume and low-judgment: inventory,
// extraction, and dropping claims that are obviously wrong. The strong tier is
// for adversarial finding, because that is where the value was — the three
// findings that mattered most in the first run each required holding two files
// in mind at once and constructing an attack. The `?token=fwk_` bypass was
// invisible in either file alone: worker.js was reasonable, fleet-do.js was
// reasonable, and the bug was that they disagreed.
//
// Cheap FINDERS are a false economy specifically because of the funnel: 115
// raised, 28 confirmed, so three quarters of the verification budget went on
// refuting noise. A finder that raises more noise costs more downstream than it
// saves upstream.
//
// And the cheapest tier of all is not a model. If the work is deterministic it
// should be code — the briefing below is git commands, and the dedup between
// phases is a Set. Neither needs a model of any size.

const SCRATCH = '/tmp/fleetwright-review'
const BRIEF = `${SCRATCH}/BRIEFING.md`
const BASE_REF = args?.base || 'main'

phase('Index')

// Tier 1. Mechanical: run the commands, write the file. No judgment is asked
// for and none should be offered.
await agent(
  `Repository /root/work/agent-fleet. Build the shared briefing that every other reviewer in this run will read, so that none of them has to re-derive it.

Run these and put the output in the file:
  mkdir -p ${SCRATCH}
  git rev-parse --short HEAD
  git diff ${BASE_REF}...HEAD --stat
  git diff ${BASE_REF}...HEAD --name-only
  git log ${BASE_REF}..HEAD --oneline

Then, WITHOUT judging any of it, add:
  - a one-paragraph summary of what the branch does, taken from the commit subjects
  - an inventory of every HTTP route added or changed, as file:line, method, path
  - a list of every exported function added or changed, as file:line

Write it all to ${BRIEF}. Do not review anything. Do not report problems. This is an index.`,
  { label: 'index', phase: 'Index', model: 'fable', effort: 'low' },
)

phase('Find')

// Tier 2. Strong, scoped, and non-overlapping — overlapping scopes are where
// duplicate findings come from, and each duplicate is verified separately.
const SCOPES = [
  { key: 'auth', files: 'the credential and authorisation paths', ask: 'Can anything reach state without a credential? Do two files disagree about what a credential is?' },
  { key: 'crypto', files: 'signing, nonces, key handling', ask: 'Can a signature or nonce be forged, replayed, or made to verify for the wrong subject?' },
  { key: 'lifecycle', files: 'connect, reconnect, revoke, restart', ask: 'Trace each end to end. What leaks, double-fires, or stops retrying?' },
  { key: 'install', files: 'the installer and bootstrap', ask: 'Under set -euo pipefail, what aborts where it should warn, and what swallows a failure where it should stop?' },
  { key: 'upgrade', files: 'a box with the previous version installed', ask: 'Trace the upgrade. Where does it end up broken with an unclear message?' },
  { key: 'parity', files: 'implementations that are supposed to match', ask: 'Report every difference a client could observe.' },
  { key: 'state', files: 'persistence and eviction', ask: 'What is lost if the process dies between two writes?' },
  { key: 'docs', files: 'documentation changed on this branch', ask: 'Which factual claims are false against the code as it is now?' },
]

const FINDING = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          file: { type: 'string' },
          line: { type: 'number' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          claim: { type: 'string' },
          trigger: { type: 'string' },
          consequence: { type: 'string' },
        },
        required: ['title', 'file', 'severity', 'claim', 'trigger', 'consequence'],
      },
    },
  },
  required: ['findings'],
}

const FIND_BASE = `Read ${BRIEF} FIRST. It is the shared context — the diff, the file list, the routes, the exports — and it exists so you do not spend your budget rediscovering what every other reviewer is also rediscovering.

Repository /root/work/agent-fleet, compared against ${BASE_REF}.

Find what will BREAK or be INSECURE. Not style, not naming, not missing tests unless the gap hides a bug you can name. Every finding must give the file, the line, the exact trigger, and the consequence. If you cannot give all four, do not report it — a claim nobody can act on costs more to refute than it was worth raising.`

const raised = (await parallel(
  SCOPES.map((sc) => () =>
    agent(`${FIND_BASE}\n\nYOUR SCOPE: ${sc.files}\n\n${sc.ask}`, {
      label: `find:${sc.key}`,
      phase: 'Find',
      schema: FINDING,
      effort: 'high',
    }).then((r) => (r?.findings || []).map((f) => ({ ...f, dimension: sc.key }))),
  ),
)).filter(Boolean).flat()

// Dedup is a Set, not an agent.
const seen = new Set()
const unique = raised.filter((f) => {
  const k = `${f.file}::${String(f.title).toLowerCase().slice(0, 40)}`
  return seen.has(k) ? false : (seen.add(k), true)
})
log(`${raised.length} raised, ${unique.length} after dedup`)

phase('Triage')

// Tier 1 again, batched. Only asked to drop what is OBVIOUSLY wrong — a claim
// about code that is not there, or that the briefing already lists as fixed.
// Anything it is unsure about survives, because a cheap false negative here
// throws away the whole point of the run.
const VERDICTS = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'number' },
          keep: { type: 'boolean' },
          reason: { type: 'string' },
        },
        required: ['index', 'keep', 'reason'],
      },
    },
  },
  required: ['verdicts'],
}

const batch = (xs, n) => xs.reduce((acc, x, i) => (i % n ? acc[acc.length - 1].push(x) : acc.push([x]), acc), [])

const triaged = (await parallel(
  batch(unique, 10).map((b, i) => () =>
    agent(
      `Read ${BRIEF}. For each claim below, open the file and answer ONE question: does the code it describes exist as described?\n\nKeep it unless you are certain it does not — you are dropping obvious mistakes, not judging severity, and something you are unsure about must be kept.\n\n${b
        .map((f, j) => `--- ${j} ---\nFILE ${f.file}:${f.line || '?'}\nCLAIM ${f.claim}`)
        .join('\n\n')}`,
      { label: `triage:${i}`, phase: 'Triage', schema: VERDICTS, model: 'fable', effort: 'low' },
    ).then((v) => b.filter((_, j) => (v?.verdicts || []).find((x) => x.index === j)?.keep !== false)),
  ),
)).filter(Boolean).flat()
log(`${triaged.length} survived triage`)

phase('Adjudicate')

// Tier 2, batched, on the survivors only.
const ADJ = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'number' },
          real: { type: 'boolean' },
          blocks: { type: 'boolean' },
          reason: { type: 'string' },
        },
        required: ['index', 'real', 'blocks', 'reason'],
      },
    },
  },
  required: ['verdicts'],
}

const confirmed = (await parallel(
  batch(triaged, 8).map((b, i) => () =>
    agent(
      `Read ${BRIEF}. Adjudicate these ${b.length} claims against the code as written. For each: is it TRUE, and would it block a release? Default to real=false when you cannot confirm it yourself by reading the code.\n\n${b
        .map((f, j) => `--- ${j} ---\nFILE ${f.file}:${f.line || '?'}\nSEVERITY ${f.severity}\nCLAIM ${f.claim}\nTRIGGER ${f.trigger}\nCONSEQUENCE ${f.consequence}`)
        .join('\n\n')}`,
      { label: `adjudicate:${i}`, phase: 'Adjudicate', schema: ADJ, effort: 'high' },
    ).then((v) =>
      b
        .map((f, j) => ({ ...f, verdict: (v?.verdicts || []).find((x) => x.index === j) }))
        .filter((f) => f.verdict?.real)
        .map((f) => ({ ...f, blocks: Boolean(f.verdict.blocks) })),
    ),
  ),
)).filter(Boolean).flat()

phase('Judge')

const verdict = await agent(
  `Read ${BRIEF}. These findings were confirmed:\n\n${JSON.stringify(
    confirmed.map((f) => ({ title: f.title, file: f.file, line: f.line, severity: f.severity, claim: f.claim, trigger: f.trigger, blocks: f.blocks })),
    null,
    2,
  )}\n\nSort into MUST FIX before release, SHOULD FIX after, and NOTED. For each give the file, the one-sentence defect, and the smallest correct fix. Be decisive: if it does not stop a release it is not a blocker.`,
  { label: 'judge', phase: 'Judge', effort: 'high' },
)

return { raised: raised.length, deduped: unique.length, triaged: triaged.length, confirmed: confirmed.length, blocking: confirmed.filter((f) => f.blocks).length, findings: confirmed, verdict }
