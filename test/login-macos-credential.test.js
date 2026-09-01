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

test('the file is still the first answer, and the only one off darwin', () => {
  // The keychain path must not become the general one: on Linux a missing file
  // is a real failure and swallowing it into a `security` call that cannot
  // exist would turn a clear ENOENT into "command not found".
  assert.match(SRC, /if \(process\.platform !== 'darwin'\) throw fileError;/);
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
