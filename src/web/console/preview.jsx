// The console with fake data, so it can be opened and judged.
//
// Separate from app.jsx, which is the real one and talks to the coordinator.
// The build emits this as a single self-contained file — the whole point being
// that somebody can open it, on a phone, without a fleet, and say whether it is
// any good.
//
// That was the gap that mattered: the first version of this page was reviewed
// by reading it. It rendered a topbar and nothing else, and nobody found out
// until it was opened.

import { render } from 'preact';
import { useState } from 'preact/hooks';

import { Console } from './components.jsx';
import { SCENARIOS } from './demo.js';

function Preview() {
  const keys = Object.keys(SCENARIOS);
  const [which, setWhich] = useState(keys[0]);
  const scenario = SCENARIOS[which];

  return (
    <div>
      <div class="preview-bar">
        <span class="preview-label">Preview</span>
        <select
          class="preview-pick"
          value={which}
          onChange={(e) => setWhich(/** @type {any} */ (e.target).value)}
          aria-label="Which state to show"
        >
          {keys.map((k) => (
            <option key={k} value={k}>
              {SCENARIOS[k].label}
            </option>
          ))}
        </select>
      </div>
      <Console snap={scenario.snap} onAnswer={() => {}} />
    </div>
  );
}

const root = document.getElementById('console-root');
if (root) render(<Preview />, root);
