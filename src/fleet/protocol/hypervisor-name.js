// The name a hypervisor's token is kept under in a person's vault.
//
// `hypervisor:<address>` is the one limited user every approved box was given
// at setup (xo-setup.js, hand-off). `hypervisor:<address>+<box>` is that
// box's own user (xo-box-users.js), which reaches the machines it made and
// not another box's. The address is the grammar onboarding takes; the box is
// the host id the fleet already uses, which is why a host id outside that
// grammar cannot be given a user of its own: the name would not file.
//
// Here, under protocol/, because three parties read the same name: the
// minter files and hands it out (minter/vault.js), the box that holds it
// makes machines with it (host/xo-pools.js), and the phone writes it
// (PhoneVault on both). A `+` cannot occur in an address — a host name
// cannot carry one, and a bracketed IPv6 address is hex, dots and colons —
// so the last `+` splits a name without ambiguity.

export const HYPERVISOR_PREFIX = 'hypervisor:';

/** A Xen Orchestra address as onboarding takes one: a host name or address, and a port. */
export const HYPERVISOR_ADDRESS_RE = /^(?:\[[0-9A-Fa-f:.]{2,45}\]|[A-Za-z0-9][A-Za-z0-9.-]{0,252})(?::\d{1,5})?$/;

/** A box, as a host id this fleet can put in a user name and a vault item. */
export const HYPERVISOR_BOX_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * The address, and the box when the item is one box's; null for a name that
 * is not a hypervisor item at all.
 *
 * @param {unknown} name
 * @returns {{ address: string, box: string|null }|null}
 */
export function splitHypervisorItem(name) {
  if (typeof name !== 'string' || !name.startsWith(HYPERVISOR_PREFIX)) return null;
  const rest = name.slice(HYPERVISOR_PREFIX.length);
  const plus = rest.lastIndexOf('+');
  if (plus === -1) return HYPERVISOR_ADDRESS_RE.test(rest) ? { address: rest, box: null } : null;
  const address = rest.slice(0, plus);
  const box = rest.slice(plus + 1);
  if (!HYPERVISOR_ADDRESS_RE.test(address) || !HYPERVISOR_BOX_RE.test(box)) return null;
  return { address, box };
}

/**
 * The name for a pool's record: the shared one, or one box's.
 *
 * @param {string} address @param {string|null} [box]
 */
export function hypervisorItemName(address, box = null) {
  return box ? `${HYPERVISOR_PREFIX}${address}+${box}` : `${HYPERVISOR_PREFIX}${address}`;
}
