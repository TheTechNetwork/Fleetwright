// Make the minting Worker's deposit key: the key people seal their Claude
// logins to on the way in (docs/runner-central.md, "Your Claude login on a
// runner").
//
//   node scripts/minter-deposit-key.mjs
//
// Prints two things, once, and writes neither anywhere:
//
//   secret   the private key, as a JWK. It becomes FLEETWRIGHT_MINTER_DEPOSIT_KEY:
//            the environment secret in `github-app-key`, synced to the minting
//            Worker the same way the App key is. Nobody else ever needs it.
//   pin      the public key. Hand it to every person who will deposit a login,
//            by some route that is not the fleet — a message, in person. It is
//            what their computer checks before sealing, so a coordinator that
//            offered its own key instead would be caught.
//
// Making a new one forgets every deposited login, because none of them opens
// with it: people deposit again. That is the whole rotation procedure.

import { newDepositKey } from '../src/fleet/seal.js';

const { secret, publicKey } = await newDepositKey();
process.stdout.write(
  `FLEETWRIGHT_MINTER_DEPOSIT_KEY (secret — for the minting Worker only):\n${secret}\n\n` +
    `FLEETWRIGHT_MINTER_KEY (public — the pin to give each person who deposits):\n${publicKey}\n`,
);
