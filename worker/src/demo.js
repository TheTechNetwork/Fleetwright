// A fleet that does not exist, for people who need to see the app work.
//
// App Store review needs working credentials, and the real API token can start
// and stop sessions on every box in the fleet. Handing that to a stranger to
// satisfy a form is the wrong trade. So: a second token that serves fabricated
// data.
//
// THE SAFETY PROPERTY IS STRUCTURAL, NOT CAREFUL. worker.js matches this token
// before it touches env.FLEET, and every response here is built from the
// constants below. There is no code path from a demo request to a Durable
// Object, a host socket, or a real session — not "we check first", but "the
// object is never reached". A reviewer holding this token cannot stop your
// work by accident or on purpose.
//
// The data is deliberately plausible rather than obviously fake: an empty
// screen reads as a broken app, and "unable to review, the app showed nothing"
// is the rejection this exists to avoid. The host names say demo so nobody
// reading a support question is misled.

const NOW = 1787100000000;

const SESSIONS = [
  {
    name: 'cc-brave-otter',
    title: 'payments API migration',
    status: 'running',
    detail: 'started · remote control online',
    hostId: 'demo-workshop',
    resumable: true,
    createdAt: NOW - 42 * 60_000,
  },
  {
    name: 'cc-merry-grouse',
    title: 'flaky integration test',
    status: 'awaiting-input',
    detail: 'waiting for an answer',
    hostId: 'demo-workshop',
    resumable: true,
    createdAt: NOW - 12 * 60_000,
  },
  {
    name: 'cc-quiet-heron',
    title: 'docs sweep',
    status: 'stopped',
    detail: 'stopped · resumable',
    hostId: 'demo-attic',
    resumable: true,
    createdAt: NOW - 3 * 3600_000,
  },
];

const HOSTS = [
  { hostId: 'demo-workshop', labels: ['linux', 'gpu'], running: 2, max: 5 },
  { hostId: 'demo-attic', labels: ['linux'], running: 0, max: 3 },
];

/** @param {string} hostId */
function hostEntry(hostId) {
  const host = HOSTS.find((h) => h.hostId === hostId);
  if (!host) throw new Error(`no demo host ${hostId}`);
  const mine = SESSIONS.filter((s) => s.hostId === hostId);
  return {
    hostId,
    state: 'healthy',
    reason: 'reporting normally',
    connected: true,
    connectedAt: NOW - 6 * 3600_000,
    healthAt: NOW - 4_000,
    health: {
      hostId,
      protocol: 1,
      labels: host.labels,
      loadavg: [0.2, 0.1, 0.05],
      freeMemBytes: 6_000_000_000,
      totalMemBytes: 16_000_000_000,
      uptimeSec: 86_400,
      hub: { reachable: true, host: hostId },
      maxSessions: host.max,
      running: host.running,
      free: host.max - host.running,
      loggedIn: true,
      sessions: mine.map((s) => ({ name: s.name, title: s.title, status: s.status, resumable: s.resumable })),
      resumable: mine.filter((s) => s.status === 'stopped').map((s) => s.name),
    },
  };
}

/** @param {typeof SESSIONS[number]} s */
function listEntry(s) {
  return {
    name: s.name,
    title: s.title,
    status: s.status,
    detail: s.detail,
    hostId: s.hostId,
    resumable: s.resumable,
    cwd: '/work',
    uuid: `00000000-0000-4000-8000-${s.name.replace(/[^a-z]/g, '').slice(0, 12).padEnd(12, '0')}`,
    createdBy: 'web',
    createdAt: s.createdAt,
    updatedAt: s.createdAt + 60_000,
    stoppedAt: s.status === 'stopped' ? s.createdAt + 3600_000 : null,
    resumeOnBoot: false,
    skipPermissions: null,
    rcUrl: null,
  };
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

/**
 * Answer a request as the demo fleet, or null if this is not something the
 * demo serves — the caller turns that into a 404 rather than falling through
 * to the real coordinator.
 *
 * @param {URL} url
 * @param {string} method
 * @param {any} body already-parsed JSON, or null
 * @returns {object|null}
 */
export function demoReply(url, method, body) {
  const p = url.pathname;

  if (p === '/api/hosts' && method === 'GET') {
    return {
      ok: true,
      protocol: 1,
      hosts: HOSTS.map((h) => hostEntry(h.hostId)),
      devices: 1,
      events: events(),
    };
  }

  if (p === '/api/events' && method === 'GET') return { ok: true, events: events() };

  // Registration is accepted and discarded. A phone that cannot register looks
  // broken in a way that has nothing to do with what is being reviewed.
  if (p === '/api/devices') return { ok: true, id: 'demo-device' };

  if (p === '/api/intent' && method === 'POST') {
    return intent(String(body?.verb || ''), body?.params?.name ? String(body.params.name) : null);
  }

  const shorthand = p.match(/^\/api\/(list|status|peek|resume|stop|start|health)(?:\/([^/]+))?$/);
  if (shorthand) return intent(shorthand[1], shorthand[2] ? decodeURIComponent(shorthand[2]) : null);

  return null;
}

function events() {
  return [
    { kind: 'session.awaiting-input', name: 'cc-merry-grouse', hostId: 'demo-workshop', at: NOW - 11 * 60_000 },
    { kind: 'session.rc-online', name: 'cc-brave-otter', hostId: 'demo-workshop', at: NOW - 41 * 60_000 },
  ];
}

/** @param {string} verb @param {string|null} name */
function intent(verb, name) {
  if (name !== null && !NAME_RE.test(name)) {
    return { ok: false, error: { code: 'bad_name' }, text: 'A session name is letters, digits, - and _.' };
  }
  const found = name ? SESSIONS.find((s) => s.name === name) : null;
  if (name && !found) return { ok: false, error: { code: 'no_such_session' }, text: `No session called ${name}.` };

  switch (verb) {
    case 'list':
      return {
        ok: true,
        fanout: true,
        sessions: SESSIONS.map(listEntry),
        hosts: HOSTS.map((h) => ({
          hostId: h.hostId,
          ok: true,
          text: `${h.running}/${h.max} running on ${h.hostId}`,
        })),
        text: SESSIONS.map((s) => `▶ ${s.name} · ${s.title}`).join('\n'),
      };
    case 'status':
      return { ok: true, session: listEntry(/** @type {any} */ (found)), text: `${found?.name} · ${found?.detail}` };
    case 'peek':
      return {
        ok: true,
        text:
          `$ npm test\n\n> agent-fleet@0.1.0 test\n\n# tests 274\n# pass 274\n# fail 0\n\n` +
          (found?.status === 'awaiting-input' ? '\nDo you want to proceed? (y/n) ' : ''),
      };
    case 'health':
      return { ok: true, hosts: HOSTS.map((h) => hostEntry(h.hostId)), text: 'All hosts healthy.' };
    case 'start':
      return { ok: true, name: 'cc-lively-finch', hostId: 'demo-workshop', text: 'Started cc-lively-finch on demo-workshop.' };
    case 'stop':
      return { ok: true, text: `Stopped ${name}. The conversation and workspace are kept.` };
    case 'resume':
      return { ok: true, text: `Resumed ${name} on ${found?.hostId}.` };
    default:
      return { ok: false, error: { code: 'unknown_verb' }, text: `No verb called ${verb}.` };
  }
}
