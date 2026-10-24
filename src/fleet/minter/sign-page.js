// The browser's signing page, served by the minting Worker on a hostname of
// its own (docs/signed-intents.md, "The browser").
//
// WHY A PAGE OF ITS OWN. A phone signs what its person does with a key the
// coordinator never sees, and a box checks that signature against the key
// list the minter signs (docs/signed-intents.md). The browser page `/me` had
// no such key, and could not be given one where it is: everything on the
// fleet's origin is served by the coordinator, which this project treats as
// compromised, and a key held by script the coordinator serves is a key the
// coordinator can use. So the key lives here, on an origin only the minter
// answers, and `/me` asks this page to sign, the way an app asks the phone's
// secure element. The coordinator relays the page's sealed sign-in and never
// serves a byte of it.
//
// WHAT THE PAGE DOES, and nothing else:
//
//  - keeps one P-256 signing key, made here, not extractable, in this
//    origin's IndexedDB, so no script can read it out, this page's included;
//  - lists it with the minter the way a phone lists its key: a GitHub sign-in
//    with a PKCE verifier only this page holds, finished by the minter, then
//    the vault's `devicekey` request, both sealed to the minter's deposit key,
//    which the page reads from its own origin rather than from anything
//    relayed;
//  - shows each request `/me` sends it and signs only what the person
//    approves here, one at a time: a signature over one intent to one box, or
//    a short delegation for one the fleet places;
//  - signs only the credential verbs `/me` uses (connect, link, unlink,
//    exchange, renew). A page that was tricked into a click still cannot sign
//    a start or a provision.
//
// WHAT IT CANNOT STOP, said plainly. The coordinator serves `/me`, so it can
// ask this page to sign anything on that list, and the person's reading of
// the request here is the whole of the check. It could also serve a page of
// its own that looks like this one and phish a GitHub authorization, which is
// the same bound a phone's key has (docs/security.md, SEC-COORD-2): a key is
// listed by whoever finishes a GitHub sign-in as the person.
//
// TALKING TO `/me`. The page is opened by `/me` as a popup and speaks to it
// with postMessage, to and from the fleet's origin only. The page has no
// fleet credential of its own: what it sends the coordinator (a sealed
// GitHub sign-in, a sealed vault request) goes through `/me`, which adds its
// credential, and only to the three routes `/me` will relay for it. Both are
// sealed, so `/me` carries bytes it cannot read.
//
// HOW IT IS SERVED. Strings, like member-page.js, because a Worker has no
// filesystem and this has to be the same bytes in a test. A content security
// policy that allows exactly these scripts by hash and nothing else: no
// framing, no fetch beyond this origin, no form posts.
//
// NO EM DASH IN THE STRINGS ON THIS PAGE, for member-page.js's reason. The
// comments keep the house voice.

/** Where on the signing host each thing is. */
const SIGNER_PATH = '/';
const SIGNER_CALLBACK_PATH = '/oauth/github/callback';

/**
 * The verbs this page will sign: the ones `/me` sends, and no others. The
 * page's script carries the same list (SIGN_HELPERS, S.VERBS); the minter
 * reads this one to serve the parameters the fleet sets for each.
 */
export const SIGNER_VERBS = Object.freeze(['connect', 'link', 'unlink', 'exchange', 'renew']);

/** @param {string} s */
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] || c);

/** JSON for inside a `<script>` element, as member-page.js does it. @param {unknown} value */
const scriptJson = (value) =>
  JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

/**
 * The pure half of the page's script: encoding, the bytes a signature covers,
 * sealing, and reading a request. Everything here has a twin in src/fleet
 * (crypto.js, seal.js, intent-signature.js) and test/sign-page.test.js runs
 * this script, as the page serves it, in a VM against those twins, so a
 * change on either side that the other misses fails there and not at a box.
 * Its own <script> element for that reason.
 *
 * NO BACKTICK AND NO DOLLAR-BRACE anywhere in it: this is a template literal,
 * and the page is one too. The test checks.
 */
const SIGN_HELPERS = String.raw`
var SIGNER = {};
(function (S) {
  var enc = new TextEncoder();
  S.GITHUB_REQUEST_AAD = 'fleetwright-github-request/v1';
  S.GITHUB_REPLY_AAD = 'fleetwright-github-reply/v1';
  S.VAULT_REQUEST_AAD = 'fleetwright-vault-request/v1';
  S.VAULT_REPLY_AAD = 'fleetwright-vault-reply/v1';
  S.VERBS = ['connect', 'link', 'unlink', 'exchange', 'renew'];
  S.MAX_DELEGATION_MS = 24 * 60 * 60 * 1000;
  var ECDH = { name: 'ECDH', namedCurve: 'P-256' };
  var ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };
  var INFO = 'fleetwright-mint/v1';
  var ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;
  var HOST_RE = /^[A-Za-z0-9._:-]{1,128}$/;
  var EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

  S.b64u = function (bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  S.unb64u = function (s) {
    var p = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
    while (p.length % 4) p += '=';
    var bin = atob(p);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };
  S.random = function (n) { return S.b64u(crypto.getRandomValues(new Uint8Array(n))); };
  function hex(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    return s;
  }

  // crypto.js, canonical(): sorted keys, undefined left out, so two encoders
  // of the same object agree.
  S.canonical = function canonical(value) {
    if (value === null || value === undefined || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    var keys = Object.keys(value).filter(function (k) { return value[k] !== undefined; }).sort(function (a, b) { return a < b ? -1 : a > b ? 1 : 0; });
    return '{' + keys.map(function (k) { return JSON.stringify(k) + ':' + canonical(value[k]); }).join(',') + '}';
  };
  S.signingInput = function (context, payload) { return 'agent-fleet/v1/' + context + '\n' + S.canonical(payload); };

  // intent-signature.js, intentSigningInput(): the parameters the fleet sets
  // after the person asked are left out, by name, from the table the page is
  // served with.
  S.intentInput = function (intent, host, fleetParams) {
    var skip = (fleetParams && fleetParams[intent.verb]) || [];
    var params = {};
    Object.keys(intent.params || {}).forEach(function (k) { if (skip.indexOf(k) < 0) params[k] = intent.params[k]; });
    return S.signingInput('intent', {
      actor: String(intent.actor == null ? '' : intent.actor), host: String(host), id: intent.id,
      issuedAt: intent.issuedAt, params: params, verb: intent.verb,
    });
  };
  S.delegationInput = function (g) {
    return S.signingInput('delegation', {
      actor: g.actor, expires: g.expires, hosts: g.hosts, id: g.id, issuedAt: g.issuedAt, match: g.match, v: 1, verbs: g.verbs,
    });
  };

  // intent-signature.js, keyId(): the whole SHA-256 of the canonical JWK.
  S.keyId = async function (jwk) {
    var canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
    return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(canonical))));
  };
  S.newSigningKey = async function () {
    var pair = await crypto.subtle.generateKey(ECDSA, false, ['sign']);
    var jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    var pub = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
    return { privateKey: pair.privateKey, publicJwk: pub, kid: await S.keyId(pub) };
  };
  S.sign = async function (privateKey, message) {
    var sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, enc.encode(message));
    return S.b64u(new Uint8Array(sig));
  };

  // seal.js, seal() and open(): ECDH P-256, HKDF-SHA-256 salted with both
  // public keys, AES-256-GCM under the additional data.
  function concat(a, b) { var o = new Uint8Array(a.length + b.length); o.set(a, 0); o.set(b, a.length); return o; }
  async function aeadKey(privateKey, publicKey, salt) {
    var shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);
    var ikm = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: salt, info: enc.encode(INFO) }, ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  function importPublic(key) {
    if (!/^[A-Za-z0-9_-]{87}$/.test(String(key))) throw new Error('not a P-256 public key');
    return crypto.subtle.importKey('raw', S.unb64u(key), ECDH, false, []);
  }
  S.newSealKey = async function () {
    var pair = await crypto.subtle.generateKey(ECDH, false, ['deriveBits']);
    return { privateKey: pair.privateKey, publicKey: S.b64u(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))) };
  };
  S.seal = async function (to, aad, payload) {
    var recipient = await importPublic(to);
    var eph = await crypto.subtle.generateKey(ECDH, true, ['deriveBits']);
    var epk = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
    var key = await aeadKey(eph.privateKey, recipient, concat(epk, S.unb64u(to)));
    var iv = crypto.getRandomValues(new Uint8Array(12));
    var ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv, additionalData: enc.encode(aad) }, key, enc.encode(JSON.stringify(payload)));
    return { epk: S.b64u(epk), iv: S.b64u(iv), ct: S.b64u(new Uint8Array(ct)) };
  };
  S.open = async function (own, aad, sealed) {
    var epk = String((sealed && sealed.epk) || '');
    var iv = S.unb64u(String((sealed && sealed.iv) || ''));
    var ct = S.unb64u(String((sealed && sealed.ct) || ''));
    if (iv.length !== 12 || !ct.length) throw new Error('not a sealed answer');
    var key = await aeadKey(own.privateKey, await importPublic(epk), concat(S.unb64u(epk), S.unb64u(own.publicKey)));
    var plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv, additionalData: enc.encode(aad) }, key, ct);
    return JSON.parse(new TextDecoder().decode(plain));
  };

  // A GitHub sign-in this page finishes itself: S256 and never plain.
  S.pkce = async function () {
    var verifier = S.random(32);
    var challenge = S.b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(verifier))));
    return { verifier: verifier, challenge: challenge, state: 's.' + S.random(24) };
  };
  S.authorizeUrl = function (clientId, redirectUri, state, challenge) {
    return 'https://github.com/login/oauth/authorize?client_id=' + encodeURIComponent(clientId) +
      '&redirect_uri=' + encodeURIComponent(redirectUri) + '&state=' + encodeURIComponent(state) +
      '&code_challenge=' + encodeURIComponent(challenge) + '&code_challenge_method=S256';
  };

  function plainObject(v) { return Boolean(v) && typeof v === 'object' && !Array.isArray(v); }

  // WHAT A REQUEST MAY BE, checked before it is shown. A reason, or null.
  // The actor has to be the person this key is listed for: a page that was
  // asked to sign in somebody else's name says so rather than showing it.
  S.checkSign = function (m, email, now) {
    var i = m && m.intent;
    if (!plainObject(i)) return 'That is not a request to sign.';
    if (S.VERBS.indexOf(i.verb) < 0) return 'This page signs only changes to your accounts, and that was ' + String(i.verb) + '.';
    if (!ID_RE.test(String(i.id || ''))) return 'That request has no id a box would take.';
    if (typeof i.issuedAt !== 'number' || Math.abs(now - i.issuedAt) > 5 * 60 * 1000) return 'That request is not from the last few minutes.';
    if (String(i.actor || '').toLowerCase() !== email) return 'That request is in the name of ' + String(i.actor) + ', and this key is listed for ' + email + '.';
    if (!HOST_RE.test(String(m.host || ''))) return 'That request names no machine to sign it for.';
    if (i.params != null && !plainObject(i.params)) return 'That request has parameters a box would not take.';
    if (JSON.stringify(i.params || {}).length > 16384) return 'That request is too large to be a change to an account.';
    return null;
  };

  // A delegation, built here from what was asked, so the actor, the id and
  // the times are this page's and not the asker's.
  S.buildGrant = function (m, email, now) {
    var g = m && m.grant;
    if (!plainObject(g)) return { error: 'That is not a request for a delegation.' };
    var verbs = Array.isArray(g.verbs) ? g.verbs : [];
    if (!verbs.length || verbs.some(function (v) { return S.VERBS.indexOf(v) < 0; })) return { error: 'This page delegates only changes to your accounts.' };
    var hosts = Array.isArray(g.hosts) ? g.hosts : [];
    var any = hosts.length === 1 && hosts[0] === '*';
    if (!hosts.length || hosts.length > 32 || (!any && hosts.some(function (h) { return !HOST_RE.test(String(h)); }))) return { error: 'That delegation names no machines a box would take.' };
    var match = g.match == null ? {} : g.match;
    if (!plainObject(match) || Object.keys(match).length > 16) return { error: 'That delegation is limited in a way a box would not take.' };
    for (var k in match) {
      var v = match[k];
      if (typeof v === 'number' ? !isFinite(v) : typeof v !== 'string' || v.length > 8192) return { error: 'That delegation is limited in a way a box would not take.' };
    }
    var life = Number(g.lifetimeMs);
    if (!(life >= 60 * 1000) || life > S.MAX_DELEGATION_MS) return { error: 'A delegation from this page lasts between a minute and a day.' };
    if (!EMAIL_RE.test(email)) return { error: 'This key is not listed for anybody yet.' };
    return { grant: { v: 1, id: S.random(18), actor: email, verbs: verbs.slice(), hosts: hosts.slice(), match: Object.assign({}, match), issuedAt: now, expires: now + Math.floor(life) } };
  };

  // WHAT THE PERSON READS. A value whose name says it is a secret is shown
  // by its length: it is theirs, and on this screen it only has to be
  // recognisable, not readable over a shoulder.
  var SECRET = /secret|token|password|code|key|verifier/i;
  S.shown = function (params) {
    return Object.keys(params || {}).sort().map(function (k) {
      var v = params[k];
      var s = typeof v === 'string' ? v : JSON.stringify(v);
      return [k, SECRET.test(k) ? 'hidden, ' + String(s).length + ' characters' : String(s)];
    });
  };
  var WORDS = {
    connect: 'read or start connecting your accounts',
    link: 'add or replace an account',
    unlink: 'remove an account',
    exchange: 'finish a sign-in',
    renew: 'renew a sign-in',
  };
  S.verbWords = function (v) { return WORDS[v] || v; };
  S.minutes = function (ms) {
    var m = Math.round(ms / 60000);
    if (m < 120) return m + (m === 1 ? ' minute' : ' minutes');
    return Math.round(m / 60) + ' hours';
  };
})(SIGNER);
`;

/**
 * The page's behaviour: the key, the list, the requests.
 *
 * The same rule as SIGN_HELPERS: no backtick, no dollar-brace.
 */
const SIGN_MAIN = String.raw`
(function () {
  var S = SIGNER;
  var CFG = JSON.parse(document.getElementById('cfg').textContent);
  var FLEET = CFG.fleetOrigin;
  var REDIRECT = FLEET + '/oauth/github/callback';
  var $ = function (id) { return document.getElementById(id); };
  var say = $('say');
  var device = null;      // { privateKey, publicJwk, kid, email, label, login, at }
  var wanted = '';        // the address /me says it is signed in as
  var prepared = null;    // a sign-in ready to open on a click
  var queue = [];
  var current = null;
  var relays = {};
  var opener = window.opener;

  function tell(text, bad) { say.textContent = text || ''; say.className = 'say' + (bad ? ' bad' : ''); }
  function post(m) { if (opener) opener.postMessage(m, FLEET); }

  // THE KEY'S ONE HOME. IndexedDB, because it keeps a CryptoKey as it is:
  // not extractable, so nothing on this origin can read the private half out,
  // and it survives the window closing. A browser that will not keep it (a
  // private window, storage turned off) is told so, and nothing is signed.
  function db() {
    return new Promise(function (resolve, reject) {
      var r = indexedDB.open('fleetwright-signer', 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('keys'); };
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
    });
  }
  async function store(op, value) {
    var d = await db();
    return new Promise(function (resolve, reject) {
      var t = d.transaction('keys', op === 'get' ? 'readonly' : 'readwrite');
      var s = t.objectStore('keys');
      var r = op === 'get' ? s.get('device') : op === 'put' ? s.put(value, 'device') : s.delete('device');
      r.onsuccess = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
    });
  }

  function render() {
    $('fleet-link').href = FLEET + '/me';
    $('alone').hidden = Boolean(opener);
    $('listed').hidden = !device;
    $('setup').hidden = Boolean(device) || !opener || !wanted;
    if (device) {
      $('listed-who').textContent = 'Signing as ' + device.email + ' with this browser’s key ' + device.kid.slice(0, 16) + '.';
    }
    if (!device && wanted) $('setup-who').textContent = wanted;
    $('list').disabled = !prepared;
    var a = $('ask');
    a.hidden = !current;
    if (current) a.querySelector('button.primary').focus();
  }

  function ready() { post({ type: 'ready', v: 1, kid: device ? device.kid : null, email: device ? device.email : null }); }

  // ---- relaying through /me -------------------------------------------------

  function relay(method, path, body) {
    var id = S.random(12);
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { delete relays[id]; reject(new Error('The credentials page did not pass that on. Keep it open and try again.')); }, 60000);
      relays[id] = function (m) { clearTimeout(timer); resolve(m); };
      post({ type: 'relay', id: id, method: method, path: path, body: body });
    });
  }
  async function minterKey() {
    var res = await fetch('/.well-known/fleetwright-minter', { cache: 'no-store' });
    var body = await res.json().catch(function () { return null; });
    if (!body || !body.ok || typeof body.key !== 'string') throw new Error('The minter did not give its key, so nothing could be sealed to it.');
    return body.key;
  }

  // ---- listing this browser ----------------------------------------------------

  async function prepare() {
    prepared = null;
    render();
    try { prepared = await S.pkce(); } catch (e) { tell('This browser cannot make a sign-in: ' + e.message, true); }
    render();
  }

  // The GitHub window is opened in the click itself, or the browser blocks
  // it; everything that is not synchronous was made beforehand (prepare).
  $('list').addEventListener('click', function () {
    if (!prepared || !wanted) return;
    var p = prepared;
    prepared = null;
    var win = window.open(S.authorizeUrl(CFG.clientId, REDIRECT, p.state, p.challenge), 'fleetwright-github', 'popup,width=520,height=760');
    if (!win) { tell('The browser did not open the GitHub window. Allow pop-ups for this page and try again.', true); prepare(); return; }
    list(p).catch(function (e) { tell(e.message, true); }).then(prepare);
  });

  function githubCode(state) {
    return new Promise(function (resolve, reject) {
      var ch = new BroadcastChannel('fleetwright-signer');
      var timer = setTimeout(function () { ch.close(); reject(new Error('GitHub did not come back within ten minutes. Start again.')); }, 10 * 60 * 1000);
      ch.onmessage = function (e) {
        var m = e.data || {};
        if (m.type !== 'github' || m.state !== state) return;
        clearTimeout(timer);
        ch.close();
        resolve(String(m.code || ''));
      };
    });
  }

  async function list(p) {
    var email = wanted;
    tell('Waiting for GitHub. Sign in there, and this page lists its key when you come back.');
    var code = await githubCode(p.state);
    tell('Listing this browser’s key for ' + email + '.');
    var made = await S.newSigningKey();
    var to = await minterKey();
    var reply = await S.newSealKey();
    var sealed = await S.seal(to, S.GITHUB_REQUEST_AAD, { v: 1, grant: 'code', code: code, verifier: p.verifier, redirectUri: REDIRECT, reply: reply.publicKey, at: Date.now() });
    var r = await relay('POST', '/api/github/device', { sealed: sealed });
    if (!r.body || !r.body.ok) throw new Error((r.body && r.body.text) || 'The GitHub sign-in was not finished.');
    var gh = await S.open(reply, S.GITHUB_REPLY_AAD, r.body.sealed);
    var label = 'A browser, listed ' + new Date().toISOString().slice(0, 10);
    var reply2 = await S.newSealKey();
    var sealed2 = await S.seal(to, S.VAULT_REQUEST_AAD, { v: 1, github: gh.accessToken, email: email, op: 'devicekey', key: made.publicJwk, label: label, at: Date.now(), reply: reply2.publicKey });
    gh = { login: gh.login };
    var r2 = await relay('POST', '/api/vault', { sealed: sealed2 });
    if (!r2.body || !r2.body.ok) throw new Error((r2.body && r2.body.text) || 'The key was not listed.');
    var answer = await S.open(reply2, S.VAULT_REPLY_AAD, r2.body.sealed);
    if (answer.kid !== made.kid) throw new Error('The minter listed a different key than this one, so this browser keeps nothing.');
    device = { privateKey: made.privateKey, publicJwk: made.publicJwk, kid: made.kid, email: email, label: label, login: gh.login, at: Date.now() };
    await store('put', device);
    tell('Listed. Machines take what this browser signs once they next read the key list, within a few minutes.');
    render();
    ready();
  }

  $('forget').addEventListener('click', async function () {
    try { await store('delete'); } catch (e) {}
    device = null;
    tell('This browser’s key is gone from here. It stays on the minter’s list until it is removed from the app under You, Devices, and nothing can sign with it, because its private half was only ever here.');
    render();
    ready();
  });

  // ---- one request at a time ---------------------------------------------------

  function next() {
    if (current || !queue.length) return;
    var m = queue.shift();
    var now = Date.now();
    var problem = !device ? 'This browser has no key listed, so it cannot sign.' : null;
    var grant = null;
    if (!problem && m.type === 'sign') problem = S.checkSign(m, device.email, now);
    if (!problem && m.type === 'delegate') {
      var built = S.buildGrant(m, device.email, now);
      problem = built.error || null;
      grant = built.grant || null;
    }
    if (problem) { post({ type: 'declined', id: m.id, text: problem }); tell(problem, true); next(); return; }
    current = { m: m, grant: grant };
    var lines = $('ask-lines');
    lines.textContent = '';
    var head;
    if (m.type === 'sign') {
      head = 'Sign this for ' + m.host + '?';
      addLine(lines, 'What', S.verbWords(m.intent.verb) + ' (' + m.intent.verb + ')');
      addLine(lines, 'Machine', m.host);
      S.shown(m.intent.params).forEach(function (kv) { addLine(lines, kv[0], kv[1]); });
    } else {
      head = 'Let the fleet do this in your name?';
      addLine(lines, 'What', grant.verbs.map(S.verbWords).join(', '));
      addLine(lines, 'Where', grant.hosts[0] === '*' ? 'whichever machine the fleet picks' : grant.hosts.join(', '));
      addLine(lines, 'For', 'the next ' + S.minutes(grant.expires - grant.issuedAt));
      var limits = S.shown(grant.match);
      if (limits.length) limits.forEach(function (kv) { addLine(lines, 'Only with ' + kv[0], kv[1]); });
      else addLine(lines, 'Limited to', 'nothing more than the above');
    }
    $('ask-head').textContent = head;
    $('ask-as').textContent = 'As ' + device.email + '. ' + (m.why ? String(m.why).slice(0, 300) : '');
    tell('');
    render();
    try { window.focus(); } catch (e) {}
  }
  function addLine(parent, k, v) {
    var row = document.createElement('div');
    row.className = 'line';
    var a = document.createElement('dt'); a.textContent = k;
    var b = document.createElement('dd'); b.textContent = v;
    row.appendChild(a); row.appendChild(b);
    parent.appendChild(row);
  }

  $('approve').addEventListener('click', async function () {
    if (!current) return;
    var c = current;
    current = null;
    render();
    try {
      if (c.m.type === 'sign') {
        var sig = await S.sign(device.privateKey, S.intentInput(c.m.intent, c.m.host, CFG.fleetParams));
        post({ type: 'signed', id: c.m.id, sig: sig, kid: device.kid });
        tell('Signed. The credentials page sends it now.');
      } else {
        var dsig = await S.sign(device.privateKey, S.delegationInput(c.grant));
        post({ type: 'delegated', id: c.m.id, delegation: { grant: c.grant, sig: dsig, kid: device.kid } });
        tell('Signed for the next ' + S.minutes(c.grant.expires - c.grant.issuedAt) + '.');
      }
    } catch (e) {
      post({ type: 'declined', id: c.m.id, text: 'This browser could not sign: ' + e.message });
      tell('This browser could not sign: ' + e.message, true);
    }
    next();
  });
  $('decline').addEventListener('click', function () {
    if (!current) return;
    post({ type: 'declined', id: current.m.id, text: 'You declined it on the signing page, so nothing was sent.' });
    current = null;
    tell('Declined. Nothing was signed.');
    render();
    next();
  });

  // ---- the credentials page, and nobody else ----------------------------------

  window.addEventListener('message', function (e) {
    if (e.origin !== FLEET || !opener || e.source !== opener) return;
    var m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'relayed') { var done = relays[m.id]; if (done) { delete relays[m.id]; done(m); } return; }
    if (m.type === 'setup') {
      wanted = String(m.email || '').trim().toLowerCase();
      if (!prepared) prepare();
      render();
      return;
    }
    if ((m.type === 'sign' || m.type === 'delegate') && typeof m.id === 'string' && queue.length < 8) { queue.push(m); next(); }
  });

  store('get').then(function (d) {
    device = d && d.privateKey && d.kid ? d : null;
  }, function () {
    tell('This browser will not keep a key for this page (a private window, or storage turned off), so it cannot sign.', true);
  }).then(function () { render(); ready(); });
})();
`;

/** The callback page's script: hand GitHub's code to the signing window, and nothing else. Same rule as above. */
const SIGN_CALLBACK = String.raw`
(function () {
  var q = new URLSearchParams(location.search);
  var code = q.get('code') || '';
  var state = q.get('state') || '';
  try { history.replaceState(null, '', location.pathname); } catch (e) {}
  var say = document.getElementById('say');
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(code) || !/^s\.[A-Za-z0-9_-]{22,128}$/.test(state)) {
    say.textContent = 'GitHub did not send back a sign-in to finish. Start again from the signing page.';
    return;
  }
  try {
    var ch = new BroadcastChannel('fleetwright-signer');
    ch.postMessage({ type: 'github', code: code, state: state });
    ch.close();
  } catch (e) {
    say.textContent = 'This browser could not pass the sign-in to the signing page. Start again from there.';
    return;
  }
  say.textContent = 'Signed in to GitHub. Back to the signing page, which lists its key now.';
  setTimeout(function () { window.close(); }, 400);
})();
`;

/**
 * The palette from docs/design-system.md, as member-page.js carries it, cut
 * to what this page uses.
 */
const SIGN_STYLE = `
:root {
  color-scheme: dark light;
  --font: 'Inter Tight', ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  --t-greeting: 1.625rem; --t-section: 1.1875rem; --t-body: 1rem; --t-body-small: 0.875rem;
  --s-page: 26px; --s-group: 22px; --s-group-tight: 16px; --s-inside: 12px; --s-inside-tight: 8px; --s-hair: 4px;
  --r-card-small: 18px; --r-row: 14px;
  --bg: #0b0d10; --card: #12151a; --inner: #171b22;
  --ink: #e6e9ef; --ink-dim: #8b93a3;
  --accent: #5b8bef; --accent-deep: #3866d6;
  --attention: #fbbf24; --bad: #f87171;
  --ring: rgba(255, 255, 255, 0.07);
}
@media (prefers-color-scheme: light) {
  :root {
    --bg: #f7f8fa; --card: #ffffff; --inner: #f1f3f7;
    --ink: #12151a; --ink-dim: #5b6474;
    --accent: #3866d6;
    --attention: #a15c00; --bad: #c02b2b;
    --ring: rgba(16, 20, 28, 0.09);
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: var(--t-body)/1.5 var(--font); padding: var(--s-page) var(--s-group-tight) 64px; }
main { max-width: 30rem; margin: 0 auto; }
h1 { font-size: var(--t-greeting); letter-spacing: -0.9px; margin: 0 0 var(--s-inside); }
h2 { font-size: var(--t-section); letter-spacing: -0.7px; margin: 0 0 var(--s-inside-tight); }
p { margin: 0 0 var(--s-inside); }
.lede { color: var(--ink-dim); font-size: var(--t-body-small); }
.card { background: var(--card); border: 1px solid var(--ring); border-radius: var(--r-card-small); padding: var(--s-group-tight); margin-bottom: var(--s-group-tight); }
/* The card asking a question is the one that breaks the stack: amber means waiting for you. */
.card.asking { border-color: color-mix(in srgb, var(--attention) 55%, transparent); }
dl { margin: 0 0 var(--s-inside); }
.line { display: grid; grid-template-columns: minmax(6rem, 34%) 1fr; gap: var(--s-inside-tight); padding: var(--s-hair) 0; }
dt { color: var(--ink-dim); font-size: var(--t-body-small); }
dd { margin: 0; overflow-wrap: anywhere; }
.actions { display: flex; gap: var(--s-inside); flex-wrap: wrap; }
button, .btn {
  font: 600 var(--t-body)/1 var(--font); min-height: 44px; padding: 0 var(--s-group-tight);
  border-radius: var(--r-row); border: 1px solid var(--ink-dim); background: var(--inner); color: var(--ink); cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center; text-decoration: none;
}
button.primary { background: var(--accent-deep); border-color: var(--accent-deep); color: #ffffff; }
button:hover, .btn:hover { border-color: var(--accent); }
button:disabled { opacity: 0.6; cursor: default; }
button.link { background: none; border: none; color: var(--accent); padding: 0 var(--s-inside-tight); font-weight: 400; font-size: var(--t-body-small); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.say { font-size: var(--t-body-small); margin: var(--s-inside) 0 0; white-space: pre-wrap; }
.say.bad { color: var(--bad); }
footer { color: var(--ink-dim); font-size: var(--t-body-small); margin-top: var(--s-group); }
[hidden] { display: none !important; }
@media (forced-colors: active) { .card, button, .btn { border: 1px solid; } }
`;

const CALLBACK_STYLE = 'body{font:16px/1.5 -apple-system,system-ui,sans-serif;margin:3rem auto;max-width:32rem;padding:0 1rem}';

/** SHA-256, base64, as a CSP hash source is written. @param {string} s */
async function cspHash(s) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  let binary = '';
  for (const b of digest) binary += String.fromCharCode(b);
  return `'sha256-${btoa(binary)}'`;
}

/**
 * The headers both pages go out with: their own scripts and styles by hash
 * and nothing else, never framed, nothing cached, no referrer (the callback's
 * address carries a code).
 *
 * @param {string[]} scripts @param {string[]} styles
 */
async function headersFor(scripts, styles) {
  const s = (await Promise.all(scripts.map(cspHash))).join(' ');
  const st = (await Promise.all(styles.map(cspHash))).join(' ');
  return {
    'content-security-policy': `default-src 'none'; script-src ${s}; style-src ${st}; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  };
}

/**
 * @typedef {object} SignerDeps
 * @property {string} fleetOrigin  the coordinator's origin, `https://…`: who may ask, and where GitHub comes back
 * @property {string} clientId     the GitHub App's client id, public
 * @property {string} [fleet]      the fleet's name, for the heading
 * @property {Record<string, string[]>} [fleetParams]  per verb, the parameters the fleet sets (intent-signature.js)
 */

/**
 * Serve the signing host: the page, GitHub's way back to it, and nothing
 * else. Null for any other path, which the Worker answers 404.
 *
 * @param {{ method: string, path: string }} req
 * @param {SignerDeps} deps
 * @returns {Promise<{ status: number, body: string, headers: Record<string, string> }|null>}
 */
export async function signerRoutes(req, deps) {
  if (req.path !== SIGNER_PATH && req.path !== SIGNER_CALLBACK_PATH) return null;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return { status: 405, body: 'This page is a GET.', headers: { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' } };
  }
  const origin = String(deps.fleetOrigin || '');
  if (!/^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(origin) || !deps.clientId) {
    return {
      status: 503,
      body: 'This signing page is not set up: the minting Worker needs FLEETWRIGHT_FLEET_ORIGIN and FLEETWRIGHT_GITHUB_CLIENT_ID.',
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    };
  }
  if (req.path === SIGNER_CALLBACK_PATH) {
    const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Back to signing</title><style>${CALLBACK_STYLE}</style></head><body>
<h1>Signing in to GitHub</h1><p id="say" role="status">Passing the sign-in back to the signing page.</p>
<script>${SIGN_CALLBACK}</script></body></html>`;
    return { status: 200, body, headers: { 'content-type': 'text/html; charset=utf-8', ...(await headersFor([SIGN_CALLBACK], [CALLBACK_STYLE])) } };
  }
  const fleet = esc(deps.fleet || 'this fleet');
  const cfg = scriptJson({ fleetOrigin: origin, clientId: String(deps.clientId), fleetParams: deps.fleetParams || {} });
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Signing: ${fleet}</title><style>${SIGN_STYLE}</style></head><body><main>
<h1>Signing for ${fleet}</h1>
<p class="lede">This page holds a key that signs what you send from your credentials page, after you read it here. It is served by the minter, not by the fleet&#39;s coordinator, which is why it is on an address of its own.</p>

<section id="alone" class="card" hidden>
  <h2>Opened on its own</h2>
  <p>This page signs only what your credentials page asks, and that page opens it. Go to <a id="fleet-link" class="btn" href="#">your credentials page</a> and choose Open the signing page there.</p>
</section>

<section id="ask" class="card asking" hidden aria-live="assertive">
  <h2 id="ask-head"></h2>
  <dl id="ask-lines"></dl>
  <p class="lede" id="ask-as"></p>
  <div class="actions"><button class="primary" id="approve">Sign it</button><button id="decline">Decline</button></div>
</section>

<section id="listed" class="card" hidden>
  <h2>This browser signs</h2>
  <p id="listed-who"></p>
  <button class="link" id="forget">Forget this browser&#39;s key</button>
</section>

<section id="setup" class="card" hidden>
  <h2>List this browser</h2>
  <p>Machines that take only what a person signed refuse what your credentials page sends until this browser has a key listed for <strong id="setup-who"></strong>. Listing it takes a GitHub sign-in as you, which this page finishes with the minter.</p>
  <button class="primary" id="list">Sign in with GitHub and list it</button>
</section>

<p class="say" id="say" role="status"></p>
<footer><p>Nothing here starts, stops or reads a session. Each request is shown before it is signed, and declining sends nothing.</p></footer>
</main>
<script type="application/json" id="cfg">${cfg}</script>
<script>${SIGN_HELPERS}</script>
<script>${SIGN_MAIN}</script>
</body></html>`;
  return { status: 200, body, headers: { 'content-type': 'text/html; charset=utf-8', ...(await headersFor([SIGN_HELPERS, SIGN_MAIN], [SIGN_STYLE])) } };
}
