// The one page in this flow a person actually sees.
//
// It runs Apple's and Google's own sign-in, in the browser, and posts the
// resulting ID token back. NOTHING HERE ASKS FOR A PASSWORD, and that is the
// property worth protecting: a page of ours collecting credentials for somebody
// else is the shape of every phishing screen ever built, and the reason the
// connect flow uses ASWebAuthenticationSession rather than a WKWebView is the
// same reason this uses their buttons rather than a form.
//
// No framework, no bundler, no external CSS. Two script tags, both from the
// providers whose sign-in they implement — anything else here would be a third
// party in the middle of somebody's authentication.

/**
 * JSON for embedding inside a <script> element.
 *
 * `JSON.stringify` alone is NOT safe here, and this is not a theoretical
 * objection: `client_id` and `state` arrive in the query string, and a value
 * containing `</script>` closes the element and everything after it is markup.
 * Escaping `<` (and the two line terminators JSON leaves raw, which break a
 * JavaScript string literal) removes the whole class.
 *
 * @param {unknown} value
 */
const scriptJson = (value) =>
  JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

/** @param {string} s */
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c);

const STYLE = `
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, -apple-system, sans-serif; margin: 0; display: grid;
         place-items: center; min-height: 100vh; background: Canvas; color: CanvasText; }
  main { max-width: 26rem; padding: 2rem; }
  h1 { font-size: 1.25rem; margin: 0 0 .25rem; }
  p { color: color-mix(in srgb, CanvasText 65%, Canvas); margin: .5rem 0 1.5rem; }
  .who { font-weight: 600; color: CanvasText; }
  .buttons { display: grid; gap: .75rem; }
  .err { color: #b3261e; }
  footer { margin-top: 2rem; font-size: .8rem; color: color-mix(in srgb, CanvasText 55%, Canvas); }
  .origin { display: block; margin-top: .5rem; }
  code { font-size: .95em; word-break: break-all; }
`;

export const authorizePage = {
  /** @param {string} message */
  error(message) {
    return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cannot sign in</title><style>${STYLE}</style>
<main><h1>Cannot sign in</h1><p class="err">${esc(message)}</p>
<footer>Nothing was sent anywhere, and nothing was signed in to.</footer></main>`;
  },

  /**
   * @param {{ clientId: string, redirectUri: string, challenge: string, state: string, origin: string,
   *           signIn: { google?: string|null, apple?: string|null } }} spec
   */
  render({ clientId, redirectUri, challenge, state, origin, signIn }) {
    const host = (() => {
      try {
        return new URL(redirectUri).host || redirectUri;
      } catch {
        return redirectUri;
      }
    })();
    return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in to the fleet</title><style>${STYLE}</style>
${signIn.google ? '<script src="https://accounts.google.com/gsi/client" async></script>' : ''}
${signIn.apple ? '<script src="https://appleid.cdn-apple.com/appleauth/static/jsapi/appleid/1/en_US/appleid.auth.js" async></script>' : ''}
<main>
  <h1>Sign in to the fleet</h1>
  <!-- NAMES WHO IS ASKING AND WHERE THIS GOES. A consent screen that does not
       say what it is consenting to is one nobody can refuse meaningfully. -->
  <p>An MCP client at <span class="who">${esc(host)}</span> is asking to reach this fleet
     as you. It will see and do exactly what you can, and nothing more.</p>
  <div class="buttons">
    ${signIn.google ? '<div id="g"></div>' : ''}
    ${signIn.apple ? '<div id="appleid-signin" data-color="black" data-border="true" data-type="sign in" style="height:40px"></div>' : ''}
    ${!signIn.google && !signIn.apple ? '<p class="err">This fleet has no sign-in configured.</p>' : ''}
  </div>
  <p id="msg"></p>
  <footer>Apple and Google do the signing in. This page never sees a password.
    <!-- THE ORIGIN, WRITTEN DOWN WHERE THE FAILURE HAPPENS.
         Error 400 origin_mismatch is the first thing a new deployment hits, and
         it happens inside Google's own popup, where this page cannot see it or
         explain it. What it CAN do is state the exact string that has to go in
         the OAuth client's Authorized JavaScript origins, on the screen the
         person is already looking at when they get it wrong.
         (No backticks in here: this whole document is a template literal, and
         one closes it. That is how this comment broke the build.) -->
    <span class="origin">This fleet is <code>${esc(origin)}</code>.</span>
  </footer>
</main>
<script>
const ctx = ${scriptJson({ clientId, redirectUri, challenge, state, origin })};
const msg = document.getElementById('msg');

// The one thing this page does with an ID token: hand it to the fleet, and go
// where the fleet says. If the address is refused, the person is told here
// rather than being redirected into a client that cannot explain it.
async function finish(idToken) {
  msg.textContent = 'Signing in…';
  const res = await fetch(ctx.origin + '/oauth/authorize', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idToken, clientId: ctx.clientId, redirectUri: ctx.redirectUri, challenge: ctx.challenge }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.code) {
    msg.className = 'err';
    msg.textContent = body.error_description || body.error || 'That sign-in was refused.';
    return;
  }
  const back = new URL(ctx.redirectUri);
  back.searchParams.set('code', body.code);
  if (ctx.state) back.searchParams.set('state', ctx.state);
  location.href = back.toString();
}

${
  signIn.google
    ? `window.addEventListener('load', () => {
  // A SILENT RETURN HERE WAS A BLANK PAGE. If Google's script does not load —
  // blocked, offline, a CSP somewhere upstream — the button area is simply
  // empty and nothing says why, which reads as a broken fleet rather than a
  // blocked script.
  if (!window.google) {
    msg.className = 'err';
    msg.textContent = "Google's sign-in script did not load, so there is no button to press. Check that accounts.google.com is reachable from this browser.";
    return;
  }
  google.accounts.id.initialize({ client_id: ${scriptJson(signIn.google)}, callback: (r) => finish(r.credential) });
  google.accounts.id.renderButton(document.getElementById('g'), { theme: 'outline', size: 'large', width: 320 });
});`
    : ''
}
${
  signIn.apple
    ? `window.addEventListener('load', () => {
  if (!window.AppleID) return;
  AppleID.auth.init({ clientId: ${scriptJson(signIn.apple)}, scope: 'email', redirectURI: ctx.origin + '/oauth/authorize', usePopup: true });
});
document.addEventListener('AppleIDSignInOnSuccess', (e) => finish(e.detail.authorization.id_token));
document.addEventListener('AppleIDSignInOnFailure', () => { msg.className = 'err'; msg.textContent = 'Apple sign-in was cancelled.'; });`
    : ''
}
</script>`;
  },
};
