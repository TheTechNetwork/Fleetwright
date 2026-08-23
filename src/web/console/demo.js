// Realistic data, so the page can be opened and judged without a fleet.
//
// Every field here is one the coordinator genuinely returns — see openapi.json.
// The states are chosen to cover what a person is actually in: mostly calm, a
// machine that cannot be vouched for, a session asking something, and the
// coordinator having gone away.

const now = Date.now();

export const SCENARIOS = {
  calm: {
    label: 'Nothing needs you',
    snap: {
      reachable: true,
      enrolled: 3,
      now,
      hosts: [
        { hostId: 'deb13-staging', connected: true, state: 'healthy', healthAt: now - 4000, health: { labels: ['linux', 'debian13'] } },
        { hostId: 'workshop', connected: true, state: 'healthy', healthAt: now - 9000, health: { labels: ['linux', 'gpu'] } },
        { hostId: 'attic-pi', connected: true, state: 'healthy', healthAt: now - 21000, health: { labels: ['arm64'] } },
      ],
      sessions: [
        { name: 'cc-brave-otter', title: 'refactor the billing importer', status: 'running', hostId: 'workshop' },
        { name: 'cc-quiet-badger', title: 'upgrade the payment SDK', status: 'running', hostId: 'deb13-staging' },
        { name: 'cc-plain-heron', title: 'nightly dependency audit', status: 'stopped', hostId: 'attic-pi' },
      ],
      events: [
        { event: 'intent', verb: 'start', actor: 'eli@thetech.network', text: 'eli@thetech.network asked for start', at: now - 400000 },
        { event: 'session.ended', hostId: 'attic-pi', name: 'cc-plain-heron', text: 'finished cleanly', at: now - 120000 },
      ],
    },
  },

  asking: {
    label: 'A session is asking you something',
    snap: {
      reachable: true,
      enrolled: 3,
      now,
      hosts: [
        { hostId: 'deb13-staging', connected: true, state: 'healthy', healthAt: now - 3000, health: { labels: ['linux'] } },
        { hostId: 'workshop', connected: true, state: 'healthy', healthAt: now - 7000, health: { labels: ['gpu'] } },
        { hostId: 'attic-pi', connected: true, state: 'healthy', healthAt: now - 15000, health: { labels: ['arm64'] } },
      ],
      sessions: [
        { name: 'cc-brave-otter', title: 'refactor the billing importer', status: 'running', hostId: 'workshop' },
        {
          name: 'cc-quiet-badger',
          title: 'upgrade the payment SDK',
          status: 'running',
          hostId: 'deb13-staging',
          prompt: {
            id: 'a41c',
            kind: 'resume',
            question: 'Resume this session from a summary, or in full?',
            options: [
              { index: 1, label: 'Resume from summary' },
              { index: 2, label: 'Resume full session' },
            ],
          },
        },
      ],
      events: [
        { event: 'session.awaiting-input', hostId: 'deb13-staging', name: 'cc-quiet-badger', text: 'Resume this session from a summary, or in full?', at: now - 30000 },
      ],
    },
  },

  withheld: {
    label: 'A prompt whose text stays on the box',
    snap: {
      reachable: true,
      enrolled: 1,
      now,
      hosts: [{ hostId: 'deb13-staging', connected: true, state: 'healthy', healthAt: now - 2000, health: { labels: ['linux'] } }],
      sessions: [
        {
          name: 'cc-swift-marten',
          title: 'clean up the release branch',
          status: 'running',
          hostId: 'deb13-staging',
          // AGENT_FLEET_PROMPT_TEXT is off, so a permission dialog — which names
          // a command — sends its question and not its options.
          prompt: { id: 'b72f', kind: 'permission', question: 'A tool wants permission to run.', options: [] },
        },
      ],
      events: [],
    },
  },

  degraded: {
    label: 'A machine that cannot be vouched for',
    snap: {
      reachable: true,
      enrolled: 3,
      now,
      hosts: [
        { hostId: 'deb13-staging', connected: true, state: 'healthy', healthAt: now - 5000, health: { labels: ['linux'] } },
        { hostId: 'workshop', connected: true, state: 'degraded', healthAt: now - 8000, reason: 'claude is not logged in on this host' },
        { hostId: 'attic-pi', connected: false, state: 'offline', healthAt: now - 400000, reason: 'socket closed: 1006, and it has not dialled back in' },
      ],
      sessions: [{ name: 'cc-brave-otter', title: 'refactor the billing importer', status: 'running', hostId: 'deb13-staging' }],
      events: [{ event: 'host.refused', hostId: 'attic-pi', text: 'that host is not enrolled', at: now - 60000 }],
    },
  },

  unreachable: {
    label: 'The coordinator has gone away',
    snap: {
      reachable: false,
      enrolled: 3,
      now,
      hosts: [
        { hostId: 'deb13-staging', connected: true, state: 'healthy', healthAt: now - 90000, health: { labels: ['linux'] } },
        { hostId: 'workshop', connected: true, state: 'healthy', healthAt: now - 95000, health: { labels: ['gpu'] } },
      ],
      sessions: [{ name: 'cc-brave-otter', title: 'refactor the billing importer', status: 'running', hostId: 'workshop' }],
      events: [],
    },
  },

  empty: {
    label: 'No machines yet',
    snap: { reachable: true, enrolled: 0, now, hosts: [], sessions: [], events: [] },
  },
};
