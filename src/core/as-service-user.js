// What root may run of the service user's, which is nothing: it asks them to.
//
// `sudo fleetwright doctor --repair` is advice this product prints, and doctor
// asks claude two questions — `--version` and `auth status`. The claude it asks
// is FLEETWRIGHT_CLAUDE_BIN, which the installer records as found, and the first
// place it looks is the service user's own ~/.local/bin. So the advice ran a
// file the service user can replace, as root: the same hole as `sudo fleetwright`
// running `current` (install.sh, "ROOT'S COMMAND IS ROOT'S CODE"), one binary
// over. It was also the wrong answer as well as a dangerous one: claude's
// credentials are in the service user's home, so root asking `auth status`
// read root's and called a signed-in box signed out.
//
// Root asks as the service user instead. Anybody else asks as themselves, which
// is what happened before. A service that runs AS root has no other account to
// protect, and nothing to ask on its behalf.

/**
 * The argv that runs `bin args…` as the service user when the caller is root.
 *
 * `-n` because doctor is not the place for a password prompt, and root never
 * gets one; `-H` so claude finds the service user's home and credentials.
 *
 * @param {string} bin
 * @param {string[]} args
 * @param {{ uid?: number, runUser?: string }} who  `uid` undefined where there is no getuid (Windows)
 * @returns {[string, string[]]}
 */
export function asServiceUser(bin, args, { uid, runUser }) {
  if (uid !== 0 || !runUser || runUser === 'root') return [bin, args];
  return ['sudo', ['-n', '-H', '-u', runUser, '--', bin, ...args]];
}
