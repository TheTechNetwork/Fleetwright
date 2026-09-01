import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Read rather than run: the branch only executes on darwin, and the failure it
// fixes was never reproducible on the machine anybody develops on — which is
// exactly why it survived until a Mac joined the fleet.
const SRC = readFileSync(new URL('../src/core/login.js', import.meta.url), 'utf8');

test('a linked credential is looked for in both places', () => {
  // On Linux the CLI writes <CLAUDE_CONFIG_DIR>/.credentials.json. On macOS it
  // writes the login keychain and only falls back to the file if the keychain
  // refuses — so the file read alone reports ENOENT after a login that the CLI
  // itself considers successful.
  assert.match(SRC, /readLinkedCredential\(link\.dir\)/);
  assert.match(SRC, /Claude Code-credentials/);
  assert.match(SRC, /find-generic-password/);
});

test('the config dir is looked at first, and the keychain only on darwin', () => {
  // Order matters: the isolated CLAUDE_CONFIG_DIR is where the credential
  // belongs, and the others are places it escapes to. And `security` must stay
  // behind a platform check — on Linux it does not exist, and calling it would
  // turn a clear "no credential" into "command not found".
  const configFirst = SRC.indexOf("path.join(dir, '.credentials.json')");
  const homeSecond = SRC.indexOf("path.join(home, '.claude'");
  assert.ok(configFirst > 0 && configFirst < homeSecond, 'the isolated dir must be tried first');
  assert.match(SRC, /if \(process\.platform === 'darwin'\) \{\s*places\.push/);
});

test('the home fallback is searched too', () => {
  // The CLI's documented fallback is "~/.claude/.credentials.json", which is
  // NOT the same sentence as "<CLAUDE_CONFIG_DIR>/.credentials.json" — and on a
  // machine whose keychain refuses the write, that difference is the whole bug.
  // Two rounds were spent asserting which location it would be, on a platform
  // that cannot be reproduced where the code is written. Looking in all of them
  // costs three stats and removes the question.
  assert.match(SRC, /path\.join\(home, '\.claude', '\.credentials\.json'\)/);
});

test('a failure names every place it looked', () => {
  // A failure listing one path sends somebody to check that path. One listing
  // all of them is a report that can be acted on without another round trip.
  assert.match(SRC, /looked in \$\{p\.what\}/);
  assert.match(SRC, /ANTHROPIC_API_KEY/);
});

test('the keychain item is cleared once it has been taken', () => {
  // CLAUDE_CONFIG_DIR isolates a directory and not the keychain, so on macOS
  // every login shares one item. Leaving the credential there means an account
  // stays live in a slot the next login will overwrite — taking it out and
  // emptying the slot is the closest this platform gets to the isolation the
  // config dir provides elsewhere.
  assert.match(SRC, /delete-generic-password/);
});

test('a keychain that answers nothing says so, and says what to check', () => {
  // The failure this replaces was a bare ENOENT naming a path, which sent
  // somebody looking for a missing directory that was in fact created.
  assert.match(SRC, /wrote no credential this process can read/);
  assert.match(SRC, /keychain must be unlocked/);
});
