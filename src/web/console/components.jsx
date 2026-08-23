// The console, as components.
//
// JSX rather than hand-rolled DOM, and the reason is not ergonomics. The first
// version of this page was 1,650 lines of an `el()` factory and I shipped it
// without ever rendering it, because I could not render it — the only checks
// available were "does it parse" and "does it mention innerHTML", both of which
// it passed while being broken.
//
// A component that returns a value can be rendered to a string in node and
// asserted on. So test/console.test.js renders every state this file can
// produce and checks what comes out. That is the whole argument: not that JSX
// is nicer, but that it makes the thing verifiable by the person who wrote it.
//
// Preact rather than React: same API, 3KB instead of 45, and
// preact-render-to-string is what the tests use.

import { SESSION_STATES, HOST_STATES, sessionState, byUrgency, fleetConfidence } from './state.js';

/** A state, shown as a word and a glyph with colour agreeing rather than carrying. */
function Badge({ vocab, state }) {
  const v = vocab[state] || { word: state, glyph: '?', tone: 'unsure' };
  return (
    <span class={`badge tone-${v.tone}`}>
      <span class="glyph" aria-hidden="true">
        {v.glyph}
      </span>
      <span class="word">{v.word}</span>
    </span>
  );
}

/**
 * The most important thing on the page.
 *
 * docs/psychology.md: "nothing needs you" is where a person is ninety-five
 * percent of the time, so it is a positive claim with its working shown, not an
 * empty state. And when the quiet is NOT trustworthy — a host we cannot vouch
 * for, a coordinator we cannot reach — it says which, because silence that
 * could mean either means nothing.
 */
export function Confidence({ snap }) {
  const c = fleetConfidence(snap);
  return (
    <section class={`confidence ${c.settled ? 'settled' : 'unsettled'}`} aria-live="polite">
      <h1 class="headline">
        <span class="glyph" aria-hidden="true">
          {c.settled ? '+' : '!'}
        </span>
        {c.headline}
      </h1>
      <ul class="because">
        {c.because.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </section>
  );
}

/**
 * A machine, with the registry's own sentence about it.
 *
 * `reason` is rendered verbatim and never truncated. The registry works to make
 * "we don't know" unrepresentable as a benign value — it produces "claude is
 * not logged in on this host", not a blank — and until now nothing anywhere
 * showed it.
 */
export function HostCard({ host }) {
  const state = HOST_STATES[host.state] ? host.state : 'unknown';
  return (
    <li class={`host state-${state}`}>
      <div class="host-head">
        <span class="host-id">{host.hostId}</span>
        <Badge vocab={HOST_STATES} state={state} />
      </div>
      {host.reason ? <p class="reason">{host.reason}</p> : null}
      {host.health?.labels?.length ? <p class="labels">{host.health.labels.join(' · ')}</p> : null}
    </li>
  );
}

/** What a session is asking, and the answers it offered. */
export function Ask({ session, onAnswer }) {
  const p = session.prompt;
  return (
    <li class="ask">
      <div class="ask-head">
        <span class="ask-what">{session.title || session.name}</span>
        <span class="ask-where">{session.hostId}</span>
      </div>
      <p class="question">{p.question}</p>
      {p.options?.length ? (
        <ol class="options">
          {p.options.map((o) => (
            <li key={o.index}>
              <button type="button" class="option" onClick={() => onAnswer?.(session, o)}>
                <span class="ordinal" aria-hidden="true">
                  {o.index}
                </span>
                {o.label}
              </button>
            </li>
          ))}
        </ol>
      ) : (
        // A permission dialog names a command, so without the fleet switch its
        // labels do not leave the box. Saying so beats showing nothing.
        <p class="withheld">
          The choices are not shown because this fleet does not send prompt text off the box. Open the session to
          answer.
        </p>
      )}
    </li>
  );
}

/** Every session, most urgent first. */
export function Wall({ sessions, onAnswer }) {
  const ordered = [...(sessions || [])].sort(byUrgency);
  const waiting = ordered.filter((s) => sessionState(s) === 'waiting');
  return (
    <div class="wall">
      {waiting.length ? (
        <ul class="asks">
          {waiting.map((s) => (
            <Ask key={s.name} session={s} onAnswer={onAnswer} />
          ))}
        </ul>
      ) : null}
      <ul class="sessions">
        {ordered.map((s) => {
          const state = sessionState(s);
          return (
            <li key={s.name} class={`srow state-${state}`}>
              <span class="s-title">{s.title || s.name}</span>
              {s.title && s.title !== s.name ? <span class="s-name">{s.name}</span> : null}
              <span class="s-host">{s.hostId}</span>
              <Badge vocab={SESSION_STATES} state={state} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Who did what. The verified actor, which until this branch was thrown away. */
export function Ledger({ events }) {
  const shown = [...(events || [])].slice(-12).reverse();
  return (
    <ul class="ledger">
      {shown.map((e, i) => (
        <li key={`${e.at}-${i}`} class="entry">
          <span class="e-what">{e.text || e.event}</span>
          {e.actor ? <span class="e-who">{e.actor}</span> : null}
        </li>
      ))}
    </ul>
  );
}

/** The page. */
export function Console({ snap, onAnswer }) {
  return (
    <div class={`console ${snap?.reachable === false ? 'stale' : ''}`}>
      <Confidence snap={snap} />
      <div class="panes">
        <aside class="rail">
          <h2>Machines</h2>
          <ul class="hosts">
            {[...(snap?.hosts || [])]
              .sort((a, b) => (HOST_STATES[a.state]?.rank ?? 9) - (HOST_STATES[b.state]?.rank ?? 9))
              .map((h) => (
                <HostCard key={h.hostId} host={h} />
              ))}
          </ul>
        </aside>
        <main class="main">
          <Wall sessions={snap?.sessions} onAnswer={onAnswer} />
        </main>
        <aside class="side">
          <h2>What happened</h2>
          <Ledger events={snap?.events} />
        </aside>
      </div>
    </div>
  );
}
