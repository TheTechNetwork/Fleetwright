#!/usr/bin/env node
// Does Clef-flash earn a place in the fleet, and at what threshold?
// (docs/decide-design.md, section F: "the harness, first and deciding".)
//
//   CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… node scripts/decide-harness.mjs [--out report.json]
//
// Local only, never in CI: it spends (a little) on a real account, and CI on a
// pull request needs no secrets. A full run is ~150 calls of ~500 tokens,
// about 75k input tokens, which is ~260 neurons against a free 10,000 a day.
//
// WHAT IT DECIDES, and nothing else may decide it:
//   DECIDE_P_AWAITING  the lowest threshold at which no negative reads as
//                      asked, on the MASKED text, because masked text is the
//                      only text the fleet will ever send.
//   whether to ship    recall on the reworded dialogs at that threshold must be
//                      clearly above the regexes' own on the same items. If it
//                      is not, there is nothing to build, and this exits 2.
//
// Unmasked runs are here for one number: what the mask costs. The corpus is
// hand-written and the fixtures are committed captures, so sending them
// unmasked from a developer's machine sends nothing a host would have to hide.
//
// BACKENDS. The corpus and the arithmetic do not care what answers; a backend
// is `(state) => Promise<raw Clef-flash-shaped result>`. Workers AI over REST
// is the only one built. Local weights, an ONNX classifier or hosted Jev would
// be another entry in BACKENDS and the same report.

import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { decideRequest, readDecideAnswer, DECIDE_MODEL, DECIDE_KIND_CONFIDENCE as KIND_CONFIDENCE } from '../src/core/decide-questions.js';
import { maskPane } from '../src/core/mask-pane.js';
import { AWAITING_RE } from '../src/fleet/host/watcher.js';
import { readPrompt } from '../src/fleet/host/prompt.js';
import { corpus } from './decide-corpus.mjs';

/** Below this, a reworded-dialog recall is noise, not a reason to ship. */
const MIN_USEFUL_RECALL = 0.5;

const BACKENDS = {
  'workers-ai': () => {
    const account = process.env.CLOUDFLARE_ACCOUNT_ID;
    const token = process.env.CLOUDFLARE_API_TOKEN ?? process.env.CLOUDFLARE_AI_TOKEN;
    if (!account || !token) {
      throw new Error('workers-ai needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (Account → Workers AI → Read).');
    }
    const url = `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${DECIDE_MODEL}`;
    return async (state) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(decideRequest(state)),
        signal: AbortSignal.timeout(20_000),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.success) {
        const err = body?.errors?.[0];
        // A permission failure is the same answer on every item; say it once.
        if (res.status === 401 || res.status === 403) {
          throw Object.assign(new Error(`HTTP ${res.status} code ${err?.code}: ${err?.message}`), { fatal: true });
        }
        throw new Error(`HTTP ${res.status}${err ? ` code ${err.code}: ${err.message}` : ''}`);
      }
      return body.result;
    };
  },
};

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

const regexSees = (text) => AWAITING_RE.test(text) || readPrompt(text) !== null;
const pct = (n, d) => (d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(1)}%`);

/** Lowest threshold, to 4 places, with every negative strictly below it. */
function zeroFalsePositiveThreshold(rows) {
  const worst = Math.max(0, ...rows.filter((r) => !r.asked && r.p !== null).map((r) => r.p));
  return Math.min(1, Math.ceil((worst + 1e-9) * 10_000) / 10_000);
}

function summarise(rows, t) {
  const pos = rows.filter((r) => r.asked && r.p !== null);
  const neg = rows.filter((r) => !r.asked && r.p !== null);
  const rew = pos.filter((r) => r.group === 'reworded');
  const hit = (r) => r.p >= t;
  const agree = rows.filter((r) => r.p !== null && hit(r) === r.asked).length;
  const kinded = pos.filter((r) => r.kindConfidence !== null && r.kindConfidence >= KIND_CONFIDENCE);
  return {
    threshold: t,
    agreement: `${agree}/${rows.filter((r) => r.p !== null).length}`,
    falseAskedOnNegatives: `${neg.filter(hit).length}/${neg.length}`,
    recallReworded: rew.length ? rew.filter(hit).length / rew.length : 0,
    recallRewordedText: `${rew.filter(hit).length}/${rew.length} (${pct(rew.filter(hit).length, rew.length)})`,
    kindAccuracy: `${pos.filter((r) => r.kindChoice === r.kind).length}/${pos.length}`,
    kindAccuracyAtConfidence: `${kinded.filter((r) => r.kindChoice === r.kind).length}/${kinded.length} at confidence ≥ ${KIND_CONFIDENCE}`,
    errors: rows.filter((r) => r.p === null).length,
  };
}

function latency(rows) {
  const ms = rows.map((r) => r.ms).filter((x) => x !== null).sort((a, b) => a - b);
  if (!ms.length) return null;
  const q = (f) => ms[Math.min(ms.length - 1, Math.floor(f * ms.length))];
  return { p50: q(0.5), p90: q(0.9), max: ms[ms.length - 1] };
}

async function main() {
  const { values } = parseArgs({ options: { out: { type: 'string' }, backend: { type: 'string', default: 'workers-ai' }, concurrency: { type: 'string', default: '4' } } });
  const make = BACKENDS[values.backend];
  if (!make) throw new Error(`unknown backend ${values.backend}; known: ${Object.keys(BACKENDS).join(', ')}`);
  const ask = make();
  const items = corpus();

  const jobs = items.flatMap((item) => [
    { item, masked: true, state: maskPane(item.text) },
    { item, masked: false, state: item.text },
  ]);

  let fatal = null;
  const rows = await pool(jobs, Number(values.concurrency), async ({ item, masked, state }) => {
    const base = { id: item.id, group: item.group, asked: item.asked, kind: item.kind, masked, bytes: Buffer.byteLength(state) };
    if (fatal) return { ...base, p: null, ms: null, error: 'skipped after a fatal error' };
    const t0 = performance.now();
    try {
      const answer = readDecideAnswer(await ask(state));
      const ms = Math.round(performance.now() - t0);
      if (!answer) return { ...base, p: null, ms, error: 'unreadable answer' };
      return { ...base, p: answer.p, kindChoice: answer.kind, kindConfidence: answer.confidence, inputTokens: answer.inputTokens, ms };
    } catch (e) {
      if (e.fatal) fatal = e;
      return { ...base, p: null, ms: null, error: String(e.message ?? e) };
    }
  });
  if (fatal) {
    console.error(`stopped: ${fatal.message}`);
    console.error('A 401 with code 10000 means the token lacks Account → Workers AI → Read on this account.');
    process.exit(1);
  }

  const masked = rows.filter((r) => r.masked);
  const unmasked = rows.filter((r) => !r.masked);
  const regexRecall = items.filter((i) => i.group === 'reworded' && regexSees(i.text)).length / items.filter((i) => i.group === 'reworded').length;
  const regexFalse = items.filter((i) => i.group === 'negative' && regexSees(i.text)).length;

  console.log('id'.padEnd(44), 'label'.padEnd(17), 'masked p / kind (conf)'.padEnd(34), 'unmasked p / kind (conf)');
  for (const item of items) {
    const m = masked.find((r) => r.id === item.id);
    const u = unmasked.find((r) => r.id === item.id);
    const cell = (r) => (r.p === null ? `error: ${r.error}` : `${r.p.toFixed(4)} ${r.kindChoice ?? '-'} (${r.kindConfidence?.toFixed(2) ?? '-'}) ${r.ms}ms`);
    console.log(item.id.padEnd(44), `${item.asked ? 'asked' : 'not'} ${item.kind ?? ''}`.padEnd(17), cell(m).padEnd(34), cell(u));
  }

  const tMasked = zeroFalsePositiveThreshold(masked);
  const tUnmasked = zeroFalsePositiveThreshold(unmasked);
  const report = {
    model: DECIDE_MODEL,
    backend: values.backend,
    ranAt: new Date().toISOString(),
    corpus: Object.fromEntries(['fixture', 'historical', 'reworded', 'negative'].map((g) => [g, items.filter((i) => i.group === g).length])),
    regexes: { recallReworded: regexRecall, falseAskedOnNegatives: regexFalse },
    masked: { ...summarise(masked, tMasked), latencyMs: latency(masked) },
    unmasked: { ...summarise(unmasked, tUnmasked), latencyMs: latency(unmasked) },
    // The mask's cost, at the threshold the fleet would actually use.
    maskedVsUnmaskedAtMaskedThreshold: summarise(unmasked, tMasked),
    meanAbsDeltaP: (() => {
      const pairs = items.map((i) => [masked.find((r) => r.id === i.id)?.p, unmasked.find((r) => r.id === i.id)?.p]).filter(([a, b]) => a != null && b != null);
      return pairs.length ? pairs.reduce((s, [a, b]) => s + Math.abs(a - b), 0) / pairs.length : null;
    })(),
    inputTokens: rows.reduce((s, r) => s + (r.inputTokens ?? 0), 0),
    rows,
  };

  const recall = report.masked.recallReworded;
  const ship = report.masked.errors === 0 && recall >= MIN_USEFUL_RECALL && recall > regexRecall;
  report.decision = {
    DECIDE_P_AWAITING: tMasked,
    ship,
    why: ship
      ? `masked recall on reworded dialogs ${pct(recall, 1)} at ${tMasked} with no false asked, against the regexes' ${pct(regexRecall, 1)}`
      : `masked recall on reworded dialogs ${pct(recall, 1)} at ${tMasked}${report.masked.errors ? `, with ${report.masked.errors} errors` : ''}: not clearly above the regexes' ${pct(regexRecall, 1)}; nothing ships`,
  };

  const { rows: _rows, ...summary } = report;
  console.log('\n' + JSON.stringify(summary, null, 2));
  if (values.out) writeFileSync(values.out, JSON.stringify(report, null, 2) + '\n');
  process.exit(ship ? 0 : 2);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
