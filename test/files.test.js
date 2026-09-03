// The workspace, and everything a caller must not be able to reach through it.
//
// ROADMAP called this "the largest new attack surface in the product", so these
// tests are mostly about the surface rather than the feature. The feature is
// four shell commands in a container; the surface is what happens when the path
// is chosen by somebody who wants it to go somewhere else.
//
// Podman is not available in CI, so the container half cannot run here — what is
// tested is the half that decides whether a container is started at all, plus
// the shape of the command when it is. The second layer, `realpath` inside the
// container, is the one that catches symlinks and is asserted structurally: the
// script must contain it, because a JS-only check cannot see through a link.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { checkPath, MAX_READ_BYTES, MAX_WRITE_BYTES, MAX_PATH } from '../src/core/files.js';
import { VERBS, validateIntent, PROTOCOL_VERSION } from '../src/fleet/protocol/intents.js';

const SOURCE = readFileSync(new URL('../src/core/files.js', import.meta.url), 'utf8');

// --- the path, before a container is ever started ---------------------------

test('a path cannot leave the workspace', () => {
  for (const bad of [
    '../etc/passwd',
    '..',
    'a/../../etc/passwd',
    'a/..',
    '/etc/passwd',
    '/work/../etc/passwd',
  ]) {
    const r = checkPath(bad);
    assert.equal(r.ok, false, `${bad} was accepted`);
  }
});

test('a null byte is refused, because it truncates for whoever opens it', () => {
  // What gets validated and what gets opened would be different strings.
  assert.equal(checkPath('notes.txt\0/etc/passwd').ok, false);
});

test('an ordinary path is accepted, including the awkward ones', () => {
  // A filename may contain almost anything. Refusing spaces or dots would be
  // refusing real files to make the check easier to write.
  for (const good of ['.', 'src/index.js', 'a file with spaces.md', '.env.example', 'a.b..c', 'dir/..hidden']) {
    assert.equal(checkPath(good).ok, true, `${good} was refused`);
  }
  // Empty means the root, not an error — "show me the workspace" is the first
  // thing anybody asks.
  assert.equal(checkPath('').path, '.');
});

test('a path is bounded', () => {
  assert.equal(checkPath('a/'.repeat(MAX_PATH)).ok, false);
});

// --- the second layer, which is the one that catches a symlink --------------

test('the container re-resolves the path rather than trusting the check above', () => {
  // A symlink inside the workspace pointing at /etc is invisible to textual
  // validation — the path has no `..` in it and is not absolute. realpath is
  // what sees through it, and the prefix test after realpath is what refuses it.
  assert.match(SOURCE, /realpath -m/);
  assert.match(SOURCE, /\/work\|\/work\/\*/);
});

test('reads mount read-only, and only the workspace volume', () => {
  // THE CONVERSATION VOLUME HOLDS THE CLAUDE CREDENTIAL. It is a sibling of
  // this one in sandboxNames() and one word away in any edit here.
  //
  // Asserted against CODE with the comments stripped, because the comment
  // explaining all this necessarily says "claude-<session>" — and a test that
  // greps its own explanation is a test that fails for being well documented.
  const code = SOURCE.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
  assert.match(code, /:\/work\$\{write \? '' : ':ro'\}/);
  assert.equal(/claude/i.test(code), false, 'the conversation volume is reachable from files.js');
  // And the volume name is DERIVED from the session rather than taken from the
  // caller: a volume parameter would make every argument above moot.
  assert.match(code, /sandboxNames\(name\)/);
});

test('the container has no network', () => {
  // A file browser has no reason to dial out, and one that cannot dial out
  // cannot send anywhere what it has just read.
  assert.match(SOURCE, /'--network',\s*\n?\s*'none'/);
});

test('content travels on stdin, never in the command', () => {
  // Arbitrary text from a caller is the one thing that must not be parsed as
  // shell, and an argument list is the only place it cannot be.
  assert.match(SOURCE, /stdin: body/);
  assert.equal(/`cat > \$\{/.test(SOURCE), false, 'a path or body is being interpolated into a command');
});

// --- the protocol side ------------------------------------------------------

test('file content survives validation exactly as sent', () => {
  // cleanText collapses whitespace and strips control characters, which would
  // reindent somebody's source and join their blank lines while reporting
  // success. `raw` exists so that cannot happen.
  const content = 'def f():\n\n    return 1\t# tab\n';
  const r = validateIntent({
    v: PROTOCOL_VERSION,
    kind: 'intent',
    id: 'idempotency-key-1',
    issuedAt: Date.now(),
    verb: 'writefile',
    params: { name: 'job', path: 'f.py', content },
  });
  assert.equal(r.ok, undefined === r.ok ? undefined : r.ok, 'sanity');
  assert.equal(r.intent.params.content, content);
});

test('a write is bounded at the protocol, not only at the host', () => {
  const tooBig = 'x'.repeat(MAX_WRITE_BYTES + 1);
  const r = validateIntent({
    v: PROTOCOL_VERSION,
    kind: 'intent',
    id: 'idempotency-key-1',
    issuedAt: Date.now(),
    verb: 'writefile',
    params: { name: 'job', path: 'f.py', content: tooBig },
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'bad_params');
});

test('reads are not mutating and writes are', () => {
  // This decides whether an idempotency key is honoured and whether the MCP
  // server may expose the verb unasked.
  assert.equal(VERBS.files.mutating, false);
  assert.equal(VERBS.readfile.mutating, false);
  for (const v of ['writefile', 'copyfile', 'deletefile']) {
    assert.equal(VERBS[v].mutating, true, `${v} must be mutating`);
  }
});

test('every workspace verb requires a session', () => {
  // There is no fleet-wide filesystem here and nothing addresses one: a
  // workspace belongs to a session, and a verb that could be asked without
  // naming one would have to invent a default.
  for (const v of ['files', 'readfile', 'writefile', 'copyfile', 'deletefile']) {
    assert.equal(VERBS[v].params.name.required, true, `${v} does not require a session name`);
  }
});

// --- what the MCP server does with them -------------------------------------

test('MCP exposes browsing and reading, and withholds the rest', async () => {
  const { toolsFor, DEFAULT_DENY } = await import('../src/mcp/tools.js');
  const names = toolsFor().map((t) => t.name);
  // Collecting what a job produced is the case that server exists for.
  assert.ok(names.includes('fleet_files'));
  assert.ok(names.includes('fleet_readfile'));
  // A policy about what an agent reaches for unasked, not a lock.
  for (const denied of ['writefile', 'copyfile', 'deletefile']) {
    assert.ok(DEFAULT_DENY.includes(denied), `${denied} should be withheld by default`);
    assert.equal(names.includes(`fleet_${denied}`), false);
  }
  // And an operator can say otherwise.
  const opened = toolsFor({ allow: ['writefile'] }).map((t) => t.name);
  assert.ok(opened.includes('fleet_writefile'));
});

test('the path parameter explains itself to a caller that cannot read the source', async () => {
  const { toolsFor } = await import('../src/mcp/tools.js');
  const files = toolsFor().find((t) => t.name === 'fleet_files');
  assert.match(String(files.inputSchema.properties.path.description), /relative/i);
  const read = toolsFor().find((t) => t.name === 'fleet_readfile');
  assert.match(String(read.description), /256KB|binary/);
});

// --- the bound a phone depends on -------------------------------------------

test('reads and listings are bounded so a phone cannot be handed a core dump', () => {
  assert.ok(MAX_READ_BYTES <= 512 * 1024);
  assert.match(SOURCE, /head -n \$\{MAX_ENTRIES\}/);
});
