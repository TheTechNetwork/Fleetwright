// A uniform integer, portably.
//
// node:crypto has randomInt and a Worker does not, so this is the one thing
// that cannot be shared by importing it. Rejection sampling rather than a
// modulo: `bytes % n` is biased toward the low values whenever n does not
// divide the range, and for a six digit code that bias is a measurable
// preference for some codes over others.

/** @param {number} min @param {number} maxExclusive */
export function randomInt(min, maxExclusive) {
  const range = maxExclusive - min;
  if (range <= 0) throw new Error('empty range');
  const bytes = Math.ceil(Math.log2(range) / 8);
  const limit = Math.floor(256 ** bytes / range) * range;
  const buf = new Uint8Array(bytes);
  for (;;) {
    crypto.getRandomValues(buf);
    let value = 0;
    for (const b of buf) value = value * 256 + b;
    if (value < limit) return min + (value % range);
  }
}
