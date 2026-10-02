// Make the minting Worker's deposit key by hand: the key people seal their
// Claude logins and vaults to on the way in.
//
//   node scripts/minter-deposit-key.mjs
//
// NOT NEEDED TO RUN A FLEET. The minter makes its own the first time it is
// asked and answers for it at the fleet's address (docs/vault.md, "The
// minter's key"). This is for a fleet that wants to choose its key, or one
// whose deploy cannot give the minter that route and so hands out the pin.
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
