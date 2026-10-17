// The browser entry point.
//
// Everything that talks to the network or the DOM lives here, and nothing else
// does — components.jsx is pure, which is what lets test/console.test.js render
// every state without a browser.

import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import { Console } from './components.jsx';
import { headline } from './state.js';
import { KONAMI, KONAMI_LINE, konamiStep } from './konami.js';
import { lateLine } from './late.js';

// For whoever opens the developer tools, which is the one reader who already
// knows where the rest of this is written down.
console.info('fleetwright: the comments are the documentation here. Start at CLAUDE.md.');

/**
 * One poll of the coordinator, folded into the shape the components want.
 *
 * `reachable: false` rather than an exception, because "we cannot reach the
 * coordinator" is a state the page must render honestly rather than a failure
 * to be logged — a page that keeps showing the last good data with a ticking
 * clock over it is the most convincing lie a stale UI tells.
 */
async function poll() {
  try {
    const [fleet, list] = await Promise.all([
      fetch('/api/hosts', { credentials: 'same-origin' }).then((r) => r.json()),
      fetch('/api/intent', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ verb: 'list' }),
      }).then((r) => r.json()),
    ]);
    return {
      reachable: true,
      hosts: fleet.hosts || [],
      events: fleet.events || [],
      sessions: list.sessions || [],
    };
  } catch {
    return { reachable: false, hosts: [], events: [], sessions: [] };
  }
}

function App() {
  const [snap, setSnap] = useState({ hosts: [], sessions: [], events: [], reachable: true });

  useEffect(() => {
    let live = true;
    const tick = async () => {
      const next = await poll();
      if (live) setSnap((prev) => (next.reachable ? next : { ...prev, reachable: false }));
    };
    tick();
    const timer = setInterval(tick, 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  // Eight seconds, or Escape. It is one line and it should not outstay itself.
  const [egg, setEgg] = useState(/** @type {string|null} */ (null));
  useEffect(() => {
    let at = 0;
    /** @type {ReturnType<typeof setTimeout>|undefined} */
    let hide;
    /** @param {KeyboardEvent} e */
    const onKey = (e) => {
      if (e.key === 'Escape') return setEgg(null);
      // Typing into a field is typing, not a cheat code.
      const t = /** @type {HTMLElement|null} */ (e.target);
      if (t?.closest?.('input, textarea, [contenteditable]')) return;
      at = konamiStep(at, e.key);
      if (at < KONAMI.length) return;
      at = 0;
      setEgg(KONAMI_LINE);
      clearTimeout(hide);
      hide = setTimeout(() => setEgg(null), 8000);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      clearTimeout(hide);
    };
  }, []);

  /**
   * Answering is not wired to a verb yet — `answer` is Phase 3 of docs/plan.md
   * and needs a protocol bump. Saying so is better than a button that silently
   * does nothing, which is the failure this whole page exists to stop.
   */
  const onAnswer = (session) => {
    const rc = session.rcUrl;
    if (rc) window.open(rc, '_blank', 'noopener');
  };

  // The small hours, in the same quiet slot the Konami line uses, and only
  // under a settled headline: late.js says why.
  const late = headline(snap).settled ? lateLine(new Date()) : null;
  return <Console snap={snap} onAnswer={onAnswer} egg={egg ?? late} />;
}

const root = document.getElementById('console-root');
if (root) render(<App />, root);
