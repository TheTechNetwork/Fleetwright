// One line, between one and five in the morning.
//
// CLAUDE.md: a fleet console is read "often at night, often because something
// is wrong". docs/psychology.md: the job is turning unbounded anxiety into
// bounded knowledge. The person reading this page at three in the morning is
// who the product is for, and the one fact the page can add that the fleet
// cannot is the time where they sit, and that the fleet is not watching back.
//
// Pure, so it is tested without a clock: app.jsx hands it the time, and only
// while the headline is settled. When something is wrong the page has work to
// do, and this line is not it.

/**
 * @param {Date} date  the reader's local time
 * @returns {string|null}
 */
export function lateLine(date) {
  const h = date.getHours();
  if (h < 1 || h >= 5) return null;
  const m = String(date.getMinutes()).padStart(2, '0');
  return `It is ${h}:${m} where you are. The fleet does not know that, and it does not report any faster for being watched.`;
}
