// The browser entry point.
//
// Everything that talks to the network or the DOM lives here, and nothing else
// does — components.jsx is pure, which is what lets test/console.test.js render
// every state without a browser.

import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import { Console } from './components.jsx';

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

  /**
   * Answering is not wired to a verb yet — `answer` is Phase 3 of docs/plan.md
   * and needs a protocol bump. Saying so is better than a button that silently
   * does nothing, which is the failure this whole page exists to stop.
   */
  const onAnswer = (session) => {
    const rc = session.rcUrl;
    if (rc) window.open(rc, '_blank', 'noopener');
  };

  return <Console snap={snap} onAnswer={onAnswer} />;
}

const root = document.getElementById('console-root');
if (root) render(<App />, root);
