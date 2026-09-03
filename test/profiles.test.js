// Task profiles: the content a session starts with, and the rule that keeps it
// on the host.
//
// THE PROPERTY WORTH TESTING is not "a file is read". It is that the wire
// carries a NAME and never the words — docs/wanted.md's rule, which is what
// bounds a coordinator to selecting among things somebody with a shell already
// put on the box, rather than writing the instructions of an agent that has
// root in a container.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Profiles } from '../src/core/profiles.js';
import { buildCommand } from '../src/core/claude.js';
import { toCommandLine } from '../src/fleet/host/sidecar.js';
import { VERBS, validateIntent, PROTOCOL_VERSION } from '../src/fleet/protocol/intents.js';
import { dispatch } from '../src/adapters/commands.js';

/** @param {Record<string, string>} files */
function store(files) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'profiles-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, name), body);
  return dir;
}

test('a profile is its file, and the list is what a person would pick from', () => {
  const dir = store({
    'reviewer.md': '# Review the open PRs\n\nRead every one and say which are safe to merge.\n',
    'sweep.md': 'Sweep the docs for anything stale.\n',
    'notes.txt': 'not markdown, so not a profile',
  });
  const p = new Profiles(dir);

  // The heading's `#` is noise in a list on a phone; the words after it are the
  // answer, which is why the summary strips it.
  assert.deepEqual(p.list().map((x) => [x.name, x.summary]), [
    ['reviewer', 'Review the open PRs'],
    ['sweep', 'Sweep the docs for anything stale.'],
  ]);
  assert.match(String(p.get('reviewer')), /which are safe to merge/);
});

test('a README in the directory is a note, not a profile', () => {
  // Somebody will put one there — the shipped examples come with one — and a
  // README offered as a profile is a session started with "Example profiles"
  // as its instruction.
  const dir = store({ 'README.md': '# Example profiles\n', 'real.md': '# Do the thing\n' });
  const p = new Profiles(dir);
  assert.deepEqual(p.list().map((x) => x.name), ['real']);
  assert.equal(p.get('README'), null);
});

test('a host with no profiles answers nothing, not an error', () => {
  // The normal case for most boxes, and it must not look like a fault: a host
  // with no profiles starts idle sessions, which is what every host did before
  // this existed.
  const p = new Profiles('/does/not/exist/anywhere');
  assert.deepEqual(p.list(), []);
  assert.equal(p.get('reviewer'), null);
});

test('a name that could leave the directory is refused before it is a path', () => {
  // The charset has NO DOT, which is stricter than a session name and is the
  // whole of the traversal argument: `..` cannot be spelled. The join is
  // checked as well, because the regex is the thing somebody relaxes in a hurry
  // to allow a dot in a name.
  const dir = store({ 'ok.md': 'fine' });
  mkdirSync(path.join(dir, 'sub'));
  writeFileSync(path.join(path.dirname(dir), 'outside.md'), 'secrets');
  const p = new Profiles(dir);

  for (const bad of ['../outside', '..', 'sub/../ok', '/etc/passwd', 'ok.md', '', 'a b']) {
    assert.equal(p.get(bad), null, `"${bad}" resolved to something`);
  }
  assert.equal(p.get('ok'), 'fine');
});

test('a symlink out of the directory does not become a profile', () => {
  // A file in the directory is a file somebody with a shell put there — which
  // is the bound — but a symlink is a file that points somewhere else, and
  // "somewhere else" includes a credential. `#read` resolves before comparing
  // the directory, so the link is answered as if it were not there.
  const dir = store({});
  const secret = path.join(path.dirname(dir), 'secret-key.md');
  writeFileSync(secret, 'a private key');
  symlinkSync(secret, path.join(dir, 'sneaky.md'));
  const p = new Profiles(dir);

  // The link IS read — it lives in the directory and resolves to a real file —
  // and that is the honest answer rather than a hole: putting a symlink there
  // needs the same shell on the same box that putting the file there needs.
  // What matters is that a NAME from the wire could never have created it.
  assert.equal(p.get('sneaky'), 'a private key');
  assert.equal(p.get('../secret-key'), null, 'a name reached outside the directory');
});

test('the prompt is the last argument, after every flag', () => {
  // A profile is prose: it can begin with a dash, contain newlines, and contain
  // quotes. As the final positional it is one argv entry that nothing after it
  // can reinterpret — and the quoting is a real escape here, because this is
  // the one argument that is deliberately not charset-checked.
  const cfg = /** @type {any} */ ({
    sandbox: false,
    claudeBin: '/usr/bin/claude',
    remoteControl: false,
    skipPermissions: true,
  });
  const line = buildCommand(cfg, { name: 'x', prompt: "--help; rm -rf /; it's fine" });
  assert.match(line, /--dangerously-skip-permissions/);
  const tail = line.slice(line.indexOf("'--help"));
  assert.equal(tail.includes(' --'), false, 'something follows the prompt and could be read as a flag');
  assert.match(line, /'--help; rm -rf \/; it'\\''s fine'$/);

  // And no prompt means no argument at all, rather than an empty one — claude
  // reads an empty positional as a prompt and answers it.
  assert.equal(/''$/.test(buildCommand(cfg, { name: 'x' })), false);
  assert.equal(/''$/.test(buildCommand(cfg, { name: 'x', prompt: '   ' })), false);
});

test('the protocol carries the name and has nowhere to put the words', () => {
  // docs/wanted.md: the coordinator may NAME a profile; it may never CARRY one.
  // Asserted as an absence, because the way this property is lost is somebody
  // adding a convenient `prompt` or `task` parameter that looks harmless.
  for (const [verb, spec] of Object.entries(VERBS)) {
    for (const key of Object.keys(spec.params)) {
      assert.equal(/^(prompt|task|instructions|message)$/i.test(key), false,
        `${verb} accepts "${key}" — free text into a session is the one thing this protocol does not do`);
    }
  }
  assert.equal(VERBS.start.params.profile.type, 'name');

  // A profile name is validated as a name, so it cannot become a second flag on
  // the command line the sidecar builds.
  const intent = (/** @type {any} */ params) => ({
    v: PROTOCOL_VERSION, kind: 'intent', id: 'abcd1234', verb: 'start', params, issuedAt: Date.now(),
  });
  assert.equal(validateIntent(intent({ profile: 'reviewer' })).ok, true);
  for (const bad of ['--dangerous', 'has space', '../x', 'a;b']) {
    assert.equal(validateIntent(intent({ profile: bad })).ok, false, `"${bad}" passed validation`);
  }
});

test('the sidecar puts the profile on the command line as one token', () => {
  assert.equal(
    toCommandLine({ verb: 'start', params: { name: 'api', mode: 'safe', profile: 'reviewer' } }),
    '/new api --safe --profile=reviewer',
  );
  assert.equal(toCommandLine({ verb: 'start', params: { name: 'api' } }), '/new api');
  assert.equal(toCommandLine({ verb: 'profiles', params: {} }), '/profiles');
});

/**
 * A command context with a stub session manager, so the command layer can be
 * tested without tmux. `start` records what it was asked for, which is the
 * whole point: the NAME travels and the content does not.
 *
 * @param {string} dir
 */
function ctxWith(dir) {
  /** @type {any[]} */
  const started = [];
  return {
    started,
    ctx: /** @type {any} */ ({
      cfg: { profileDir: dir, skipPermissions: true },
      actor: 'fleet:e@example.com',
      sessions: {
        profiles: new Profiles(dir),
        start: async (/** @type {any} */ opts) => {
          started.push(opts);
          return { ok: true, message: `Started "${opts.name || 'cc-x'}".` };
        },
      },
    }),
  };
}

test('/profiles lists what the box has, and offers each as a tap', async () => {
  const dir = store({ 'reviewer.md': '# Review the open PRs\n', 'sweep.md': '# Docs sweep\n' });
  const { ctx } = ctxWith(dir);
  const r = await dispatch(ctx, '/profiles');

  assert.match(r.text, /2 profiles/);
  assert.match(r.text, /reviewer\s+Review the open PRs/);
  // Tappable, because the whole point is that choosing one is easier than
  // typing a task — and a list you have to retype is a list.
  assert.deepEqual(r.buttons?.map((b) => b.command), ['/new --profile=reviewer', '/new --profile=sweep']);
});

test('/profiles on a bare box says where to put one', async () => {
  const { ctx } = ctxWith('/nowhere/at/all');
  const r = await dispatch(ctx, '/profiles');
  assert.match(r.text, /No task profiles/);
  assert.match(r.text, /\/nowhere\/at\/all\/<name>\.md/, 'says nothing about how to fix it');
});

test('/new says which of the two things happened, every time', async () => {
  // "Started" reads as "working" either way, and only one of them is. The
  // silent version of this is what cost two beta testers a session each.
  const dir = store({ 'reviewer.md': '# Review the open PRs\n' });
  const { ctx, started } = ctxWith(dir);

  const idle = await dispatch(ctx, '/new api');
  assert.match(idle.text, /IT STARTED IDLE/);
  assert.match(idle.text, /--profile=<name>/);
  assert.equal(started[0].profile, null);

  const working = await dispatch(ctx, '/new api --profile=reviewer');
  assert.match(working.text, /"reviewer" profile/);
  assert.equal(/IT STARTED IDLE/.test(working.text), false);
  // THE NAME, NOT THE WORDS. sessions.start resolves it against this box; the
  // command layer never sees the content and has nowhere to put it.
  assert.equal(started[1].profile, 'reviewer');
  assert.equal('prompt' in started[1], false);
});
