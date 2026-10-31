// Take the minting Worker's own keys out, once, to keep them in Cloudflare
// Secrets Store, sealed on the way so nothing in between can read them.
//
//   node scripts/minter-key-export.mjs new  <dir>
//   node scripts/minter-key-export.mjs open <fleet-url> <dir>
//
// WHY. The minter makes its deposit key and its signing key itself and keeps
// them in its Durable Object, beside every vault they protect (docs/vault.md,
// "The minter's key"). An object lost is every vault lost with them. Kept in
// Secrets Store too, the object brings them back when it finds itself empty,
// and with the deposit key it can open its copy in R2 (src/fleet/minter/backup.js).
//
// A Worker cannot write Secrets Store, and nobody can read a value back out of
// it, so the keys have to come out through somebody. This is that somebody:
//
//   1. `new <dir>` makes a key of yours, writes its private half to
//      <dir>/export-key.json (readable by you alone), and prints the public
//      half and the command that tells the minter to seal to it.
//   2. Set it, and deploy or wait for the next deploy.
//   3. `open <fleet-url> <dir>` asks the fleet's public address for the keys,
//      sealed to yours (the `x-fleetwright-export: keys` header), opens them,
//      writes them to <dir>, and prints the Secrets Store commands.
//   4. Delete FLEETWRIGHT_MINTER_EXPORT_TO, and the files in <dir> once the
//      secrets are in the store.
//
// What travels is sealed to a key that never leaves <dir>, so the address can
// be public: anyone else who asks gets a box they cannot open.

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { newDepositKey, importDepositKey, open, MINTER_EXPORT_AAD } from '../src/fleet/seal.js';

const KEY_PATH = '/.well-known/fleetwright-minter';
const [cmd, ...args] = process.argv.slice(2);

/** @param {string} path @param {string} body */
const secretFile = (path, body) => writeFileSync(path, body, { mode: 0o600, flag: 'wx' });

if (cmd === 'new' && args.length === 1) {
  const [dir] = args;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const { secret, publicKey } = await newDepositKey();
  secretFile(join(dir, 'export-key.json'), `${secret}\n`);
  process.stdout.write(
    `Kept your export key's private half in ${join(dir, 'export-key.json')}.\n\n` +
      `Tell the minter to seal its keys to it:\n\n` +
      `  cd worker && echo '${publicKey}' | npx wrangler secret put FLEETWRIGHT_MINTER_EXPORT_TO --config wrangler.minter.toml\n\n` +
      `Then: node scripts/minter-key-export.mjs open https://<your fleet> ${dir}\n`,
  );
} else if (cmd === 'open' && args.length === 2) {
  const [fleet, dir] = args;
  const key = await importDepositKey(readFileSync(join(dir, 'export-key.json'), 'utf8'));
  const res = await fetch(new URL(KEY_PATH, fleet), { headers: { 'x-fleetwright-export': 'keys' } });
  /** @type {any} */
  const said = await res.json().catch(() => null);
  if (!said?.ok) {
    process.stderr.write(`The minter did not export its keys: ${said?.text || `it answered ${res.status}`}\n`);
    process.exit(1);
  }
  const keys = await open({ privateKey: key.privateKey, publicKey: key.publicKey, aad: MINTER_EXPORT_AAD, sealed: said.sealed });
  secretFile(join(dir, 'deposit-key.json'), `${keys.depositKey}\n`);
  secretFile(join(dir, 'signing-key.json'), `${JSON.stringify(keys.signingKey)}\n`);
  process.stdout.write(
    `Wrote the deposit key and the signing key to ${dir}, readable by you alone.\n\n` +
      `Put each in your account's Secrets Store, pasting the file's one line when asked:\n\n` +
      `  cd worker\n` +
      `  npx wrangler secrets-store secret create <store-id> --name fleetwright-minter-deposit-key --scopes workers --remote\n` +
      `  npx wrangler secrets-store secret create <store-id> --name fleetwright-minter-signing-key --scopes workers --remote\n\n` +
      `Set the repository variable FLEETWRIGHT_MINTER_SECRETS_STORE to <store-id>, so the deploy binds them.\n` +
      `Then delete FLEETWRIGHT_MINTER_EXPORT_TO:\n\n` +
      `  npx wrangler secret delete FLEETWRIGHT_MINTER_EXPORT_TO --config wrangler.minter.toml\n\n` +
      `and the three files in ${dir}.\n`,
  );
} else {
  process.stderr.write('usage: minter-key-export.mjs new <dir> | open <fleet-url> <dir>\n');
  process.exit(2);
}
