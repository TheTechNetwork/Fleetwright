// A box that can sign an engine in, with nothing real in it
// (test/engine-signin-hub.test.js).
//
// WHAT STANDS IN, and nothing else does:
//
//   podman    a script that keeps a volume as a directory, runs what the
//             session image would run on this machine, with the volume where
//             the mount would have put it, and ends a container it is told
//             to remove. A real program on disk, started the way the hub
//             starts Podman, so the arguments are what a real one is given.
//   codex     `codex app-server` on its pipes, as far as signing in goes
//   opencode  `opencode serve` on loopback, the same
//
// The runner between them is the real one (sandbox/engine.mjs). Each engine
// answers as its source reads at the version the session image pins; the
// in-process twins of these two, with the references, are in
// test/engine-signin-run.test.js. No real engine is run, and nothing here
// reaches OpenAI or GitHub.
//
// A test steers an engine by leaving a file in the box's directory: what the
// provider said of the code, once it says anything.

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

import { codexSignIn, copilotEntry } from './engine-files.js';

const RUNNER = fileURLToPath(new URL('../../sandbox/engine.mjs', import.meta.url));
const q = (/** @type {string} */ s) => `'${s.replace(/'/g, `'\\''`)}'`;

/** A token as an engine would write it into its sign-in file: found anywhere else, it leaked. */
export const TOKEN = 'rt-LEAKCANARY-0123456789abcdef';
/** The file Codex leaves when it signs in, in the shape the real one writes, each of its three tokens marked. */
const CODEX_SIGNED_IN = codexSignIn({ refresh: TOKEN, access: 'at-LEAKCANARY-0123456789', signature: 'sig-LEAKCANARY-0123456789' });

const CODEX = `
import { createInterface } from 'node:readline';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
const D = process.env.STANDIN_DIR;
const said = (name) => (existsSync(path.join(D, name)) ? readFileSync(path.join(D, name), 'utf8') : null);
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
const auth = path.join(process.env.CODEX_HOME, 'auth.json');
const LOGIN = '0b9d4a51-7f0e-4c7a-9a3c-5f6d2e1b8c90';
let waiting = null;
const done = (success, error) => { clearInterval(waiting); send({ method: 'account/login/completed', params: { loginId: LOGIN, success, error, onboardingEntrypoint: null } }); };
createInterface({ input: process.stdin }).on('line', (text) => {
  const m = JSON.parse(text);
  if (m.method) appendFileSync(path.join(D, 'codex-seen.log'), m.method + '\\n');
  if (m.method === 'initialize') send({ id: m.id, result: { userAgent: 'codex/0.171.0', codexHome: process.env.CODEX_HOME, platformFamily: 'unix', platformOs: 'linux' } });
  else if (m.method === 'account/login/start') {
    if (said('codex-off') !== null) return send({ id: m.id, error: { code: -32600, message: 'device code login is not enabled for this Codex server. Use the browser login or verify the server URL.' } });
    send({ id: m.id, result: { type: 'chatgptDeviceCode', loginId: LOGIN, verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-EFGH' } });
    // Asking OpenAI, until it says something.
    waiting = setInterval(() => {
      if (said('provider-approved') !== null) {
        mkdirSync(path.dirname(auth), { recursive: true });
        writeFileSync(auth, ${JSON.stringify(CODEX_SIGNED_IN)}, { mode: 0o600 });
        // And says its new token out loud, on the stream a session would have passed on.
        process.stderr.write('refreshed, token ${TOKEN}\\n');
        done(true, null);
      } else if (said('provider-refused') !== null) done(false, said('provider-refused'));
    }, 15);
  } else if (m.method === 'account/login/cancel') {
    send({ id: m.id, result: { status: 'canceled' } });
    done(false, 'Login was not completed');
  } else if (m.method === 'account/read') send({ id: m.id, result: { account: existsSync(auth) ? { type: 'chatgpt', email: 'debbie@example.com', planType: 'plus', workspaceName: null } : null, userId: null, requiresOpenaiAuth: true } });
  else if (m.method === 'account/logout') { rmSync(auth, { force: true }); send({ id: m.id, result: {} }); }
});
`;

const OPENCODE = `
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const D = process.env.STANDIN_DIR;
const said = (name) => (existsSync(path.join(D, name)) ? readFileSync(path.join(D, name), 'utf8') : null);
const auth = path.join(process.env.XDG_DATA_HOME, 'opencode', 'auth.json');
const want = 'Basic ' + Buffer.from('opencode:' + process.env.OPENCODE_SERVER_PASSWORD).toString('base64');
let pending = false;
const server = createServer((req, res) => {
  let text = '';
  req.on('data', (c) => (text += c));
  req.on('end', () => {
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (!process.env.OPENCODE_SERVER_PASSWORD || req.headers.authorization !== want) return json(401, { name: 'Unauthorized' });
    if (req.method === 'POST' && req.url === '/provider/github-copilot/oauth/authorize') { pending = true; return json(200, { url: 'https://github.com/login/device', method: 'auto', instructions: 'Enter code: WXYZ-1234' }); }
    if (req.method === 'POST' && req.url === '/provider/github-copilot/oauth/callback') {
      if (!pending) return json(400, { name: 'ProviderAuthOauthMissing', data: { providerID: 'github-copilot' } });
      const waiting = setInterval(() => {
        if (said('provider-approved') !== null) {
          clearInterval(waiting);
          mkdirSync(path.dirname(auth), { recursive: true });
          writeFileSync(auth, JSON.stringify({ 'github-copilot': ${JSON.stringify(copilotEntry(TOKEN))} }) + '\\n', { mode: 0o600 });
          json(200, true);
        } else if (said('provider-refused') !== null) { clearInterval(waiting); json(400, { name: 'ProviderAuthOauthCallbackFailed', data: {} }); }
      }, 15);
      res.on('close', () => clearInterval(waiting));
      return undefined;
    }
    if (req.method === 'DELETE' && req.url === '/auth/github-copilot') {
      const held = existsSync(auth) ? JSON.parse(readFileSync(auth, 'utf8')) : {};
      delete held['github-copilot'];
      mkdirSync(path.dirname(auth), { recursive: true });
      writeFileSync(auth, JSON.stringify(held));
      return json(200, true);
    }
    return json(404, { name: 'NotFound' });
  });
});
// What the real server says of a connection it keeps: \`Keep-Alive: timeout=5\` (opencode serve 1.19.6).
server.keepAliveTimeout = 5000;
server.listen(0, '127.0.0.1', () => console.log('opencode server listening on http://127.0.0.1:' + server.address().port));
`;

/**
 * @param {import('node:test').TestContext} t
 * @returns {{ dir: string, cfg: (patch?: Record<string, unknown>) => any, calls: () => string[], runs: () => string[], volume: (name: string, ...inside: string[]) => string,
 *   provider: (said: 'approved'|'refused', words?: string) => void, set: (name: string, on?: boolean) => void, codexSaw: () => string[], running: (container: string) => boolean }}
 */
export function signinBox(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fw-signin-'));
  const node = process.execPath;
  writeFileSync(path.join(dir, 'codex.mjs'), CODEX);
  writeFileSync(path.join(dir, 'opencode.mjs'), OPENCODE);
  for (const engine of ['codex', 'opencode']) writeFileSync(path.join(dir, engine), `#!/bin/sh\nexec ${q(node)} ${q(path.join(dir, `${engine}.mjs`))} "$@"\n`, { mode: 0o755 });
  const podmanBin = path.join(dir, 'podman');
  writeFileSync(podmanBin, `#!/bin/sh
D=${q(dir)}
printf '%s\\n' "$*" >> "$D/podman.log"
case "$1" in
  --version) echo 'podman version 5.0.0'; exit 0 ;;
  image) [ -e "$D/no-image" ] && exit 1; exit 0 ;;
  rm)
    # As Podman does: whatever runs under that name is ended, and is gone.
    for last; do :; done
    # ONE SLOW REMOVAL, once: how a test has an attempt's tidying up still
    # going when the next attempt begins. It looks for what runs under the
    # name only when it gets round to it, as a slow Podman would.
    if [ -e "$D/slow-rm-once" ]; then rm -f "$D/slow-rm-once"; sleep 0.5; fi
    # Everything in it: the hub starts each run as the head of its own process group.
    if [ -e "$D/ctr-$last.pid" ]; then kill -9 "-$(cat "$D/ctr-$last.pid")" 2>/dev/null; rm -f "$D/ctr-$last.pid"; fi
    exit 0 ;;
  run) ;;
  *) exit 0 ;;
esac
shift
name=''
vol=''
while [ $# -gt 0 ]; do
  case "$1" in
    --name) name="$2"; shift ;;
    -v) case "$2" in *:/engine-home) vol="\${2%%:*}" ;; esac; shift ;;
    # What the box gives a sign-in container and nothing else: the attempt's own word.
    -e) case "$2" in FLEETWRIGHT_SIGNIN_ATTEMPT=*) export "$2" ;; esac; shift ;;
    img) shift; break ;;
  esac
  shift
done
if [ -e "$D/fail-run" ]; then echo 'Error: crun: cannot set memory limit' >&2; exit 125; fi
# A NAMED VOLUME IS MADE ON ITS FIRST MOUNT, and is here what the container
# finds at /engine-home.
mkdir -p "$D/volumes/$vol"
echo $$ > "$D/ctr-$name.pid"
# A CONTAINER HAS A /tmp OF ITS OWN, WHICH GOES WITH IT. The runner makes the
# engine's throwaway home there, and a container that is removed is killed
# where it stands, with nothing tidied up. Here that would be this machine's
# own /tmp, filling with one directory a cancelled sign-in.
mkdir -p "$D/tmp/$name"
export TMPDIR="$D/tmp/$name"
export FLEETWRIGHT_ENGINE_HOME="$D/volumes/$vol" FLEETWRIGHT_CODEX_BIN="$D/codex" FLEETWRIGHT_OPENCODE_BIN="$D/opencode" STANDIN_DIR="$D"
case "$1" in
  fleetwright-engine) shift; exec ${q(node)} ${q(RUNNER)} "$@" ;;
esac
exit 127
`);
  chmodSync(podmanBin, 0o755);
  const calls = () => (existsSync(path.join(dir, 'podman.log')) ? readFileSync(path.join(dir, 'podman.log'), 'utf8').split('\n').filter(Boolean) : []);
  t.after(() => {
    // Whatever a test left running under a container's name.
    for (const line of calls()) {
      const name = /--name (\S+)/.exec(line)?.[1];
      const pidFile = name ? path.join(dir, `ctr-${name}.pid`) : null;
      if (pidFile && existsSync(pidFile)) {
        try {
          process.kill(-Number(readFileSync(pidFile, 'utf8')), 'SIGKILL');
        } catch { /* gone already */ }
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    cfg: (patch = {}) => ({
      stateDir: path.join(dir, 'state'), hostname: 'ops-box', podmanBin,
      sandbox: true, sandboxHookSocket: true, sandboxImage: 'img', sandboxUserns: 'host', sandboxExtraArgs: [], engines: ['codex', 'opencode'],
      ...patch,
    }),
    calls,
    /** Every `podman run`, as its arguments. */
    runs: () => calls().filter((l) => l.startsWith('run ')),
    /** A path inside a volume, as this machine keeps it. */
    volume: (name, ...inside) => path.join(dir, 'volumes', name, ...inside),
    /** What the provider says of the code that is out. */
    provider: (said, words = '') => writeFileSync(path.join(dir, `provider-${said}`), words),
    /** A switch a stand-in reads: `codex-off`, `no-image`, `fail-run`, `slow-rm-once`. */
    set: (name, on = true) => (on ? writeFileSync(path.join(dir, name), '') : rmSync(path.join(dir, name), { force: true })),
    codexSaw: () => (existsSync(path.join(dir, 'codex-seen.log')) ? readFileSync(path.join(dir, 'codex-seen.log'), 'utf8').split('\n').filter(Boolean) : []),
    /** Whether a container of that name is still running. */
    running: (container) => {
      const pidFile = path.join(dir, `ctr-${container}.pid`);
      if (!existsSync(pidFile)) return false;
      try {
        process.kill(Number(readFileSync(pidFile, 'utf8')), 0);
        return true;
      } catch {
        return false;
      }
    },
  };
}
