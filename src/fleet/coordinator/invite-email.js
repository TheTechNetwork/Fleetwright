// The email that says somebody has been invited.
//
// AN INVITATION IS STILL NOT A CREDENTIAL, and this message is the place that
// would most easily make it look like one. Every invitation email anybody has
// ever received contains a link that grants something; this one must not,
// because there is nothing here to grant. The person signs in as themselves
// with Apple or Google, and the coordinator checks the verified address against
// a list. So the message carries no token, no code, and no link that does
// anything except lead to the app.
//
// WHY IT IS WORTH SENDING AT ALL, given it grants nothing: it names WHICH
// ADDRESS to sign in with. That is the failure this actually prevents —
// somebody invited at one address signs in with whichever Google account their
// phone was already holding, is refused as "not on this fleet's list", and has
// no way to tell that they are on it under a different name.
//
// AND THE INVITATION DOES NOT DEPEND ON IT. The list is the authority; the mail
// is a courtesy. Sending is best-effort, its failure is reported rather than
// swallowed, and an invitation whose email bounced is still an invitation —
// which is why `add()` succeeds before this is ever attempted.

/**
 * Kept short deliberately: this is read on a phone, once.
 *
 * @param {{
 *   email: string,
 *   fleet: string,
 *   invitedBy?: string|null,
 *   note?: string|null,
 *   apps?: { ios?: string|null, android?: string|null },
 * }} about
 * @returns {{ subject: string, text: string }}
 */
export function composeInvite({ email, fleet, invitedBy = null, note = null, apps = {} }) {
  const who = invitedBy && invitedBy !== 'admin' ? invitedBy : 'The owner';
  const lines = [
    `${who} has given you access to ${fleet}, a small fleet of machines running Claude Code sessions.`,
    '',
    // THE ADDRESS, FIRST AND ALONE, because it is the one fact that stops the
    // most likely failure. A person with three Google accounts on their phone
    // will otherwise pick the wrong one and be told they are not on a list they
    // are on.
    `Sign in with this address: ${email}`,
    '',
    'There is nothing in this email to click for access and no code to enter — you sign in as yourself with',
    'Apple or Google, and the fleet recognises the address above.',
  ];
  if (note) lines.push('', `What this is for: ${note}`);
  lines.push(...appLines(apps));
  lines.push(
    '',
    'Once you are in, you connect your own Claude account (and GitHub or Cloudflare if you need them).',
    'They stay yours: nobody else can see them, and you see only the sessions you start.',
  );
  return {
    subject: `You have access to ${fleet}`,
    text: lines.join('\n'),
  };
}

/**
 * The download links, LABELLED BY PHONE.
 *
 * This was one `appUrl` field, which was fine while there was nothing to put in
 * it and wrong the moment there was. There are two stores, and the recipient's
 * phone decides which link is the real one — an invitation is the one message
 * where we cannot know that in advance, because the person receiving it has
 * never been near this fleet. An Android user sent a TestFlight link reaches a
 * page that cannot help them; an iPhone user sent a Play link reaches one that
 * looks plausible and is worse.
 *
 * So both are listed and each says whose it is, and a deployment that has only
 * published one sends only that one.
 *
 * THE TESTFLIGHT CAVEAT IS DETECTED, NOT CONFIGURED. A TestFlight link is not a
 * download — it enrols you in a beta, needs Apple's TestFlight app installed
 * first, and only opens on the device itself. Somebody who taps it on a laptop
 * concludes the link is broken. That step is invisible to anyone who has not
 * used TestFlight, which is most people being invited to something for the
 * first time, so it is named whenever the URL is one.
 *
 * @param {{ ios?: string|null, android?: string|null }} apps
 * @returns {string[]}
 */
function appLines({ ios = null, android = null } = {}) {
  if (!ios && !android) {
    // Said rather than left blank. A deployment that has published no link
    // would otherwise send an invitation with no way to act on it, and the
    // person receiving it cannot tell that something is missing.
    return ['', 'Ask whoever invited you for the app — this deployment has not published a link.'];
  }
  const lines = ['', 'Get the app:'];
  if (ios) {
    lines.push(`  iPhone or iPad — ${ios}`);
    if (/testflight\.apple\.com/i.test(ios)) {
      lines.push('    (a beta: install Apple\'s TestFlight app first, then open that link on the device itself)');
    }
  }
  if (android) lines.push(`  Android — ${android}`);
  return lines;
}

/**
 * Send it, and never let the attempt fail the invitation.
 *
 * @param {{
 *   send: ((message: { to: string, subject: string, text: string }) => Promise<void>)|null,
 *   from: string|null,
 * }|null} mailer
 * @param {{ email: string, fleet: string, invitedBy: string, note?: string|null,
 *   apps?: { ios?: string|null, android?: string|null } }} about
 * @returns {Promise<{ sent: boolean, why: string }>}
 */
export async function sendInvite(mailer, about) {
  // NOT CONFIGURED IS NOT A FAILURE. Most deployments will never set this up,
  // and an invitation that reports an error because a courtesy was unavailable
  // would send somebody looking for a problem they do not have.
  if (!mailer?.send) return { sent: false, why: 'no email is configured for this fleet' };
  if (!mailer.from) return { sent: false, why: 'no sender address is configured (AGENT_FLEET_INVITE_FROM)' };
  try {
    const { subject, text } = composeInvite(about);
    await mailer.send({ to: about.email, subject, text });
    return { sent: true, why: 'sent' };
  } catch (e) {
    // REPORTED, NOT SWALLOWED. Cloudflare refuses for reasons an operator can
    // act on and would otherwise never see — a sender address this account
    // cannot send as, a recipient that has bounced or complained before — and
    // the person doing the inviting is the person who can fix them.
    return { sent: false, why: `${/** @type {Error} */ (e).message}`.slice(0, 200) };
  }
}
