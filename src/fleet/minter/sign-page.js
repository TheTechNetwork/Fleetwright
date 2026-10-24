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
//  - OPENS THE PERSON'S VAULT, as the phone's Credentials screen does: with
//    that GitHub sign-in, held in this window's memory and nowhere else, it
//    lists what is kept, tests it, forgets it, keeps a named secret, keeps a
//    GitHub or Cloudflare sign-in it started with a verifier of its own, and
//    approves or removes the machines that are given it. Every request is
//    sealed to the minter and every answer sealed back to a key made here
//    for it, so what the vault holds is never readable on the way;
//  - keeps a Claude sign-in made on a machine (`setuptoken`, `kind: login`):
//    it signs both halves for that one machine, holds the key the sign-in
//    comes back sealed to, and puts it in the vault. A Claude sign-in is the
//    one credential a browser cannot make by itself, because Claude Code
//    makes it, and this page never shows it.
//
// It signs only `setuptoken`, and only intents it built itself from what the
// person did here. It signed what `/me` asked once, when `/me` linked
// accounts on machines; every machine refuses that now (the vault holds a
// person's credentials, src/fleet/host/sidecar.js, VAULT_ONLY), so the page
// that asked is gone and so is the asking.
//
// WHAT IT CANNOT STOP, said plainly. The coordinator serves `/me`, which
// carries this page's requests, so it can drop or delay them, and it lists
// the machines this page offers to approve, so it could offer a key of its
// own: which is why each shows the fingerprint this page works out from the
// key itself, to compare with what the machine prints. It could also serve a
// page of its own that looks like this one and phish a GitHub authorization,
// which is the same bound a phone's key has (docs/security.md, SEC-COORD-2):
// a vault is opened by whoever finishes a GitHub sign-in as the person.
//
// TALKING TO `/me`. The page is opened by `/me` as a popup and speaks to it
// with postMessage, to and from the fleet's origin only. The page has no
// fleet credential of its own: what it sends the coordinator goes through
// `/me`, which adds its credential, and only to the four routes `/me` will
// carry for it (member-page.js, RELAYS). What reaches the minter is sealed,
// so `/me` carries bytes it cannot read.
//
// HOW IT IS SERVED. Strings, like member-page.js, because a Worker has no
// filesystem and this has to be the same bytes in a test. A content security
// policy that allows exactly these scripts by hash and nothing else: no
// framing, no fetch beyond this origin, no form posts.
//
// NO EM DASH IN THE STRINGS ON THIS PAGE, for member-page.js's reason. The
// comments keep the house voice.

/** Where on the signing host each thing is: the page, and each provider's way back to it. */
const SIGNER_PATH = '/';
const SIGNER_CALLBACK_PATHS = ['/oauth/github/callback', '/oauth/cloudflare/callback'];

/**
 * The verbs this page will sign, and no others: the one a Claude sign-in
 * made on a machine takes. The page's script carries the same list
 * (SIGN_HELPERS, S.VERBS); the minter reads this one to serve the parameters
 * the fleet sets for each.
 */
export const SIGNER_VERBS = Object.freeze(['setuptoken']);

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
  S.SETUP_TOKEN_AAD = 'fleetwright-setup-token/v1';
  S.VERBS = ['setuptoken'];
  var ECDH = { name: 'ECDH', namedCurve: 'P-256' };
  var ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };
  var INFO = 'fleetwright-mint/v1';
  var HOST_RE = /^[A-Za-z0-9._:-]{1,128}$/;

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
  // AN INTENT THIS PAGE BUILT, for one machine, and only for a verb on its
  // list: a slip elsewhere in the page cannot make it sign a start.
  S.intent = function (verb, params, actor, host, now) {
    if (S.VERBS.indexOf(verb) < 0) throw new Error('This page signs only a Claude sign-in made on a machine.');
    if (!HOST_RE.test(String(host || ''))) throw new Error('That names no machine to sign it for.');
    return { verb: verb, params: params, actor: actor, id: crypto.randomUUID(), issuedAt: now };
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
  // Cloudflare's, the way the phone opens it (PhoneVault.connect): the
  // scopes are the client's registered list, which the minter is given.
  S.cloudflareUrl = function (clientId, redirectUri, state, challenge, scopes) {
    return 'https://dash.cloudflare.com/oauth2/auth?response_type=code&client_id=' + encodeURIComponent(clientId) +
      '&redirect_uri=' + encodeURIComponent(redirectUri) + '&scope=' + encodeURIComponent(scopes) +
      '&state=' + encodeURIComponent(state) + '&code_challenge=' + encodeURIComponent(challenge) + '&code_challenge_method=S256';
  };

  // WHAT THE PERSON COMPARES with what the machine prints: the first sixteen
  // characters of the key's hash (crypto.js, fingerprint), in fours.
  S.fingerprint = function (hash) { return String(hash || '').slice(0, 16).replace(/(.{4})(?=.)/g, '$1 '); };

  // WHAT A VAULT ITEM IS CALLED where a person reads it.
  S.itemLabel = function (name) {
    if (name === 'claude') return 'Claude';
    if (name === 'github') return 'GitHub';
    if (name === 'cloudflare') return 'Cloudflare';
    if (name.indexOf('secret:') === 0) return name.slice(7);
    if (name.indexOf('hypervisor:') === 0) return 'Hypervisor at ' + name.slice(11);
    return name;
  };
  S.SECRET_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
})(SIGNER);
`;

/**
 * The page's behaviour: the key, the list, the vault.
 *
 * The same rule as SIGN_HELPERS: no backtick, no dollar-brace.
 */
const SIGN_MAIN = String.raw`
(function () {
  var S = SIGNER;
  var CFG = JSON.parse(document.getElementById('cfg').textContent);
  var FLEET = CFG.fleetOrigin;
  var REDIRECT = { github: FLEET + '/oauth/github/callback', cloudflare: FLEET + '/oauth/cloudflare/callback' };
  var $ = function (id) { return document.getElementById(id); };
  var say = $('say');
  var device = null;      // { privateKey, publicJwk, kid, email, label, login, at }
  var wanted = '';        // the address /me says it is signed in as
  var prepared = null;    // a sign-in ready to open on a click
  var gh = null;          // { accessToken, login }: this window's GitHub sign-in, in memory only
  var vault = null;       // what the vault last said it holds
  var hosts = null;       // the fleet's machines, as /me relayed them; null is not read yet
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

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function render() {
    $('fleet-link').href = FLEET + '/me';
    $('alone').hidden = Boolean(opener);
    $('listed').hidden = !device;
    $('setup').hidden = Boolean(device) || !opener || !wanted;
    if (device) $('listed-who').textContent = 'Signing as ' + device.email + ' with this browser’s key ' + device.kid.slice(0, 16) + '.';
    if (!device && wanted) $('setup-who').textContent = wanted;
    $('list').disabled = !prepared;
    $('vault').hidden = !device || !opener;
    $('vault-closed').hidden = Boolean(gh);
    $('vault-body').hidden = !gh;
    $('vault-open').disabled = !prepared;
    // THE CARD THAT ASKS: a vault with no Claude sign-in, which is what will
    // refuse a session an hour from now. Only once the vault has said so.
    $('vault').className = 'card' + (vault && !kept('claude') ? ' asking' : '');
    $('machines-card').hidden = !gh || !vault;
  }

  function ready() { post({ type: 'ready', v: 1, kid: device ? device.kid : null, email: device ? device.email : null }); }

  // ---- carrying through /me ----------------------------------------------------

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

  // ---- a sign-in this page starts ----------------------------------------------

  async function prepare() {
    prepared = null;
    render();
    try { prepared = await S.pkce(); } catch (e) { tell('This browser cannot make a sign-in: ' + e.message, true); }
    render();
  }

  // THE PROVIDER'S WINDOW IS OPENED IN THE CLICK ITSELF, or the browser
  // blocks it; everything that is not synchronous was made beforehand
  // (prepare). Null when there is nothing ready, or the window was refused.
  function begin(provider) {
    if (!prepared) return null;
    var p = prepared;
    prepared = null;
    var url = provider === 'cloudflare'
      ? S.cloudflareUrl(CFG.cloudflare.clientId, REDIRECT.cloudflare, p.state, p.challenge, CFG.cloudflare.scopes)
      : S.authorizeUrl(CFG.clientId, REDIRECT.github, p.state, p.challenge);
    var win = window.open(url, 'fleetwright-' + provider, 'popup,width=520,height=760');
    if (!win) { tell('The browser did not open the sign-in window. Allow pop-ups for this page and try again.', true); prepare(); return null; }
    return p;
  }

  function codeFor(provider, state) {
    return new Promise(function (resolve, reject) {
      var ch = new BroadcastChannel('fleetwright-signer');
      var timer = setTimeout(function () { ch.close(); reject(new Error('The sign-in did not come back within ten minutes. Start again.')); }, 10 * 60 * 1000);
      ch.onmessage = function (e) {
        var m = e.data || {};
        if (m.type !== provider || m.state !== state) return;
        clearTimeout(timer);
        ch.close();
        resolve(String(m.code || ''));
      };
    });
  }

  // A GITHUB SIGN-IN FOR THIS PAGE, finished by the minter, which is what
  // lists a key and opens a vault. Kept in this window's memory, so it is
  // gone when the window is.
  async function signInWithGithub(p) {
    tell('Waiting for GitHub. Sign in there, and this page carries on when you come back.');
    var code = await codeFor('github', p.state);
    var reply = await S.newSealKey();
    var sealed = await S.seal(await minterKey(), S.GITHUB_REQUEST_AAD, { v: 1, grant: 'code', code: code, verifier: p.verifier, redirectUri: REDIRECT.github, reply: reply.publicKey, at: Date.now() });
    var r = await relay('POST', '/api/github/device', { sealed: sealed });
    if (!r.body || !r.body.ok) throw new Error((r.body && r.body.text) || 'The GitHub sign-in was not finished.');
    var got = await S.open(reply, S.GITHUB_REPLY_AAD, r.body.sealed);
    gh = { accessToken: String(got.accessToken || ''), login: String(got.login || '') };
    return gh;
  }

  // ---- listing this browser ----------------------------------------------------

  $('list').addEventListener('click', function () {
    if (!wanted) return;
    var p = begin('github');
    if (p) list(p).catch(function (e) { tell(e.message, true); }).then(prepare);
  });

  async function list(p) {
    var email = wanted;
    await signInWithGithub(p);
    tell('Listing this browser’s key for ' + email + '.');
    var made = await S.newSigningKey();
    var label = 'A browser, listed ' + new Date().toISOString().slice(0, 10);
    var r = await vaultAsk('devicekey', { key: made.publicJwk, label: label }, email);
    if (r.answer.kid !== made.kid) throw new Error('The minter listed a different key than this one, so this browser keeps nothing.');
    device = { privateKey: made.privateKey, publicJwk: made.publicJwk, kid: made.kid, email: email, label: label, login: gh.login, at: Date.now() };
    await store('put', device);
    render();
    ready();
    await load();
    tell('Listed. Machines take what this browser signs once they next read the key list, within a few minutes.');
  }

  $('forget').addEventListener('click', async function () {
    try { await store('delete'); } catch (e) {}
    device = null;
    gh = null;
    vault = null;
    tell('This browser’s key is gone from here. It stays on the minter’s list until it is removed from the app under You, Devices, and nothing can sign with it, because its private half was only ever here.');
    render();
    ready();
  });

  // ---- the vault -----------------------------------------------------------------

  /**
   * One request to the vault, sealed to the minter, the answer sealed back to
   * a key made for it. A refusal throws its sentence; a GitHub sign-in the
   * minter no longer takes closes the vault, so the next click opens it again.
   */
  async function vaultAsk(op, extra, email) {
    if (!gh) throw new Error('Open your vault first.');
    var reply = await S.newSealKey();
    var payload = { v: 1, github: gh.accessToken, email: email || device.email, op: op, at: Date.now(), reply: reply.publicKey };
    Object.keys(extra || {}).forEach(function (k) { payload[k] = extra[k]; });
    var r = await relay('POST', '/api/vault', { sealed: await S.seal(await minterKey(), S.VAULT_REQUEST_AAD, payload) });
    var b = r.body || {};
    if (!b.ok) {
      var code = b.error && b.error.code;
      if (code === 'not_github' || code === 'not_a_device') { gh = null; vault = null; render(); }
      throw new Error(b.text || 'The vault did not answer.');
    }
    return { answer: await S.open(reply, S.VAULT_REPLY_AAD, b.sealed), text: String(b.text || '') };
  }

  $('vault-open').addEventListener('click', function () {
    var p = begin('github');
    if (p) signInWithGithub(p).then(load).then(function () { tell(''); }, function (e) { tell(e.message, true); }).then(prepare);
  });

  /** What the vault holds and which machines there are, read again. */
  async function load() {
    var r = await vaultAsk('list', {});
    vault = r.answer || { items: [], grants: [] };
    hosts = null;
    try {
      var h = await relay('GET', '/api/hosts/enrolled');
      if (h.body && h.body.ok && Array.isArray(h.body.hosts)) hosts = h.body.hosts;
    } catch (e) { hosts = null; }
    $('vault-who').textContent = 'Opened as ' + (vault.login || gh.login) + ' on GitHub. This window holds that sign-in until you close it.';
    await draw();
    render();
  }

  function item(name) { return ((vault && vault.items) || []).filter(function (x) { return x.name === name; })[0] || null; }
  function kept(name) { return Boolean(item(name)); }

  /** Each thing the vault keeps or could, one row each, the same shape every time. */
  async function draw() {
    var box = $('items');
    box.textContent = '';
    box.appendChild(claudeRow());
    box.appendChild(providerRow('github'));
    if (CFG.cloudflare || kept('cloudflare')) box.appendChild(providerRow('cloudflare'));
    ((vault && vault.items) || []).forEach(function (x) {
      if (x.name.indexOf('secret:') === 0) box.appendChild(secretRow(x));
      if (x.name.indexOf('hypervisor:') === 0) box.appendChild(hypervisorRow(x));
    });
    box.appendChild(newSecretRow());
    await drawMachines();
  }

  // EVERY ROW THE SAME SHAPE: a name, what is kept, then what can be done
  // about it, on its own line whether that is one button or three.
  function row(title, state, on) {
    var r = el('div', 'item');
    r.appendChild(el('h3', null, title));
    r.appendChild(el('p', 'state' + (on ? ' on' : ''), state));
    var actions = el('div', 'actions');
    r.appendChild(actions);
    var step = el('div', 'step');
    step.hidden = true;
    r.appendChild(step);
    var said = el('p', 'say');
    said.setAttribute('role', 'status');
    r.appendChild(said);
    var made = { el: r, title: title, actions: actions, step: step, said: said };
    // What the last change on this row came to, said where it was asked for:
    // the rows are drawn again from the vault's answer, and this is that row.
    if (lastSaid && lastSaid.title === title) note(made, lastSaid.text);
    return made;
  }
  function button(parent, text, cls, onClick) {
    var b = el('button', cls || null, text);
    b.type = 'button';
    b.addEventListener('click', onClick);
    parent.appendChild(b);
    return b;
  }
  function note(r, text, bad) { r.said.textContent = text || ''; r.said.className = 'say' + (bad ? ' bad' : ''); }

  /** Run one change, read the vault again, and say how it went on its row. */
  var lastSaid = null;
  async function change(r, busy, work) {
    tell('');
    note(r, busy);
    try {
      var text = await work();
      lastSaid = { title: r.title, text: text || '' };
      await load();
    } catch (e) {
      note(r, e.message, true);
    } finally {
      lastSaid = null;
    }
  }

  function testButton(r, name) {
    button(r.actions, 'Test', null, function () {
      note(r, 'Asking ' + S.itemLabel(name) + '.');
      vaultAsk('test', { name: name }).then(function (t) { note(r, t.text, t.answer && t.answer.state === 'rejected'); }, function (e) { note(r, e.message, true); });
    });
  }
  // FORGET ASKS ONCE MORE, on the row, because it reaches every machine.
  function forgetButton(r, name) {
    button(r.actions, 'Forget', null, function () {
      r.step.hidden = false;
      r.step.textContent = '';
      r.step.appendChild(el('p', null, 'Forget ' + S.itemLabel(name) + '? Machines you approved stop being given it when they next ask.'));
      var a = el('div', 'actions');
      button(a, 'Forget it', 'primary', function () {
        r.step.hidden = true;
        change(r, 'Forgetting it.', function () { return vaultAsk('forget', { name: name }).then(function (t) { return t.text; }); });
      });
      button(a, 'Keep it', null, function () { r.step.hidden = true; });
      r.step.appendChild(a);
    });
  }

  function claudeRow() {
    var x = item('claude');
    var state = !x ? 'Not kept. A session you start is refused until it is.'
      : x.kind === 'login' ? 'Kept: a whole sign-in, which Remote Control needs.'
        : 'Kept: a setup-token. Sessions run on it; Remote Control does not.';
    var r = row('Claude', state, Boolean(x));
    if (x) { testButton(r, 'claude'); forgetButton(r, 'claude'); }
    button(r.actions, x && x.kind === 'login' ? 'Sign in again' : 'Sign in on a machine', x ? null : 'primary', function () { pickMachine(r); });
    if (!x) button(r.actions, 'Paste a setup-token', 'link', function () { pasteToken(r); });
    return r.el;
  }

  function providerRow(name) {
    var x = item(name);
    var r = row(S.itemLabel(name), x ? 'Kept, for the machines you approve.' : 'Not kept.', Boolean(x));
    if (x) { testButton(r, name); forgetButton(r, name); }
    var offered = name === 'github' || Boolean(CFG.cloudflare);
    if (offered) {
      button(r.actions, x ? 'Sign in again' : 'Sign in with ' + S.itemLabel(name), x ? null : 'primary', function () {
        var p = begin(name);
        if (!p) return;
        change(r, 'Waiting for ' + S.itemLabel(name) + '. Sign in there, and this page keeps it when you come back.', async function () {
          try {
            var code = await codeFor(name, p.state);
            note(r, 'Keeping it.');
            var t = await vaultAsk('connect', { provider: name, code: code, verifier: p.verifier, redirectUri: REDIRECT[name] });
            return t.text;
          } finally { prepare(); }
        });
      });
    }
    return r.el;
  }

  function secretRow(x) {
    var r = row(S.itemLabel(x.name), 'Kept. A session you start on a machine you approved can be given it by name.', true);
    forgetButton(r, x.name);
    return r.el;
  }
  function hypervisorRow(x) {
    return row(S.itemLabel(x.name), 'Kept from the app, for the machines that make machines on that pool.', true).el;
  }

  // A SECRET IS TYPED HERE AND NOWHERE ELSE. The field is a password field,
  // and cleared whatever the vault answers.
  function newSecretRow() {
    var r = row('A named secret', 'A key or token a session asks for by name.', false);
    button(r.actions, 'Keep one', null, function () {
      r.step.hidden = !r.step.hidden;
      if (r.step.hidden) return;
      r.step.textContent = '';
      var form = el('form', 'step');
      var name = field('Its name, such as NPM_TOKEN', 'text');
      var value = field('The secret', 'password');
      form.appendChild(name);
      form.appendChild(value);
      var go = el('button', 'primary', 'Keep it');
      go.type = 'submit';
      form.appendChild(go);
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var n = name.value.trim();
        var v = value.value;
        value.value = '';
        if (!S.SECRET_NAME_RE.test(n)) { note(r, 'A name is letters, digits, dots, dashes and underscores, up to 64.', true); return; }
        if (!v) { note(r, 'Nothing to keep yet.', true); return; }
        change(r, 'Keeping ' + n + '.', function () { return vaultAsk('put', { name: 'secret:' + n, value: v }).then(function (t) { return t.text; }); });
      });
      r.step.appendChild(form);
      name.focus();
    });
    return r.el;
  }
  function field(label, type) {
    var f = el('input');
    f.type = type;
    f.autocomplete = 'off';
    f.spellcheck = false;
    f.setAttribute('autocapitalize', 'off');
    f.setAttribute('aria-label', label);
    f.placeholder = label;
    return f;
  }

  function pasteToken(r) {
    r.step.hidden = false;
    r.step.textContent = '';
    r.step.appendChild(el('p', 'lede', 'A token claude setup-token printed. Sessions run on it, and Remote Control does not: for that, sign in on a machine instead.'));
    var form = el('form', 'step');
    var value = field('The setup-token', 'password');
    form.appendChild(value);
    var go = el('button', 'primary', 'Keep it');
    go.type = 'submit';
    form.appendChild(go);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var v = value.value.trim();
      value.value = '';
      if (!v) { note(r, 'Nothing to keep yet.', true); return; }
      change(r, 'Checking it with Claude, then keeping it.', function () { return vaultAsk('put', { name: 'claude', value: v }).then(function (t) { return t.text; }); });
    });
    r.step.appendChild(form);
    value.focus();
  }

  // ---- a Claude sign-in made on a machine ----------------------------------------
  //
  // Claude Code makes it, so a machine runs claude auth login in a pane and
  // this page carries both halves to that same machine, each signed for it:
  // start it, and the sign-in page's address comes back; send the code that
  // page shows with a key made here, and the sign-in comes back sealed to it.

  function permanent() {
    return (hosts || []).filter(function (h) { return h && !h.revokedAt && !h.ephemeral && typeof h.hostId === 'string'; });
  }

  function pickMachine(r) {
    r.step.hidden = false;
    r.step.textContent = '';
    var list = permanent();
    if (hosts === null) { r.step.appendChild(el('p', 'say bad', 'The list of machines could not be read, so there is nowhere to make the sign-in. Try again in a moment.')); return; }
    if (!list.length) { r.step.appendChild(el('p', 'say', 'This fleet has no permanent machine to make a sign-in on.')); return; }
    r.step.appendChild(el('p', 'lede', 'Claude Code makes the sign-in, so one of your machines runs it and sends it back sealed to this page. Which one?'));
    var chips = el('div', 'actions');
    list.forEach(function (h) { button(chips, h.hostId, 'chip', function () { startOn(r, h.hostId); }); });
    r.step.appendChild(chips);
  }

  async function sendSigned(host, params) {
    var it = S.intent('setuptoken', params, device.email, host, Date.now());
    var sig = await S.sign(device.privateKey, S.intentInput(it, host, CFG.fleetParams));
    var res = await relay('POST', '/api/intent', { verb: it.verb, params: it.params, host: host, id: it.id, issuedAt: it.issuedAt, sig: sig, kid: device.kid });
    var b = res.body || {};
    if (!b.ok) throw new Error(b.text || 'That machine refused it.');
    return b;
  }

  async function startOn(r, host) {
    r.step.textContent = '';
    r.step.appendChild(el('p', 'lede', 'Starting a Claude sign-in on ' + host + '.'));
    var b;
    try {
      b = await sendSigned(host, { kind: 'login' });
    } catch (e) {
      r.step.textContent = '';
      note(r, e.message, true);
      return;
    }
    r.step.textContent = '';
    if (typeof b.url !== 'string' || !/^https:\/\//.test(b.url)) {
      note(r, b.text || host + ' started the sign-in and has not given its address yet. Choose it again in a moment.');
      return;
    }
    note(r, '');
    var open = el('a', 'btn', 'Open the Claude sign-in');
    open.href = b.url;
    open.target = '_blank';
    open.rel = 'noopener noreferrer';
    r.step.appendChild(open);
    var form = el('form', 'step');
    var code = field('Paste the code it shows you', 'password');
    form.appendChild(code);
    var go = el('button', 'primary', 'Keep it');
    go.type = 'submit';
    form.appendChild(go);
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var c = code.value.trim();
      code.value = '';
      if (!c) { note(r, 'Nothing to send yet.', true); return; }
      go.disabled = true;
      change(r, host + ' is finishing the sign-in.', async function () {
        try {
          var reply = await S.newSealKey();
          var done = await sendSigned(host, { kind: 'login', code: c, reply: reply.publicKey });
          var made = await S.open(reply, S.SETUP_TOKEN_AAD, done.sealed);
          note(r, 'Keeping it in your vault.');
          // A HOST FROM BEFORE IT makes a setup-token where it was asked for
          // a sign-in; that is kept as what it is, and the row says which.
          var t = made && made.signIn ? await vaultAsk('put', { name: 'claude', signIn: made.signIn }) : await vaultAsk('put', { name: 'claude', value: String((made && made.token) || '') });
          r.step.hidden = true;
          return t.text;
        } finally { go.disabled = false; }
      });
    });
    r.step.appendChild(form);
  }

  // ---- machines ------------------------------------------------------------------

  async function drawMachines() {
    var box = $('machines');
    box.textContent = '';
    var grants = {};
    ((vault && vault.grants) || []).forEach(function (g) { grants[g.key] = g; });
    if (hosts === null) box.appendChild(el('p', 'say bad', 'The list of machines could not be read just now, so only the ones already approved are shown.'));
    var seen = {};
    for (var i = 0; i < permanent().length; i++) {
      var h = permanent()[i];
      var jwk = h.publicJwk;
      if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256') continue;
      var key = { kty: 'EC', crv: 'P-256', x: String(jwk.x), y: String(jwk.y) };
      var hash = await S.keyId(key);
      seen[hash] = true;
      box.appendChild(machineRow(h.hostId, hash, key, grants[hash] || null));
    }
    Object.keys(grants).forEach(function (hash) {
      if (!seen[hash]) box.appendChild(machineRow(grants[hash].label || 'A machine', hash, null, grants[hash]));
    });
    if (!box.children.length) box.appendChild(el('p', 'state', 'No machine has enrolled in this fleet yet.'));
  }

  function machineRow(name, hash, key, grant) {
    var state = !grant ? 'Not approved. Fingerprint ' + S.fingerprint(hash) + '.'
      : (grant.only && grant.only.length ? 'Approved for ' + grant.only.map(S.itemLabel).join(', ') + ' only.' : 'Approved to hold your credentials.') + ' Fingerprint ' + S.fingerprint(hash) + '.' + (key ? '' : ' Not enrolled in this fleet any more.');
    var r = row(name, state, Boolean(grant));
    if (grant) {
      button(r.actions, 'Remove', null, function () {
        change(r, 'Removing ' + name + '.', function () { return vaultAsk('revoke', { key: hash }).then(function (t) { return t.text; }); });
      });
    } else if (key) {
      button(r.actions, 'Approve', 'primary', function () {
        change(r, 'Approving ' + name + '.', function () { return vaultAsk('grant', { hostKey: key, label: name }).then(function (t) { return t.text; }); });
      });
    }
    return r.el;
  }

  // ---- the credentials page, and nobody else ----------------------------------

  window.addEventListener('message', function (e) {
    if (e.origin !== FLEET || !opener || e.source !== opener) return;
    var m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'relayed') { var done = relays[m.id]; if (done) { delete relays[m.id]; done(m); } return; }
    if (m.type === 'setup') {
      wanted = String(m.email || '').trim().toLowerCase();
      render();
      return;
    }
    // A CREDENTIALS PAGE FROM BEFORE THE VAULT still asks this page to sign
    // links to machines, which every machine now refuses. It is told so,
    // rather than left waiting for an answer that never comes.
    if ((m.type === 'sign' || m.type === 'delegate') && typeof m.id === 'string') {
      post({ type: 'declined', id: m.id, text: 'Your credentials are kept in your vault now, not on a machine. Keep them on the signing page.' });
    }
  });

  store('get').then(function (d) {
    device = d && d.privateKey && d.kid ? d : null;
  }, function () {
    tell('This browser will not keep a key for this page (a private window, or storage turned off), so it cannot sign.', true);
  }).then(function () { render(); ready(); });
  if (opener) prepare();
})();
`;

/** The callback pages' script: hand the provider's code to the signing window, and nothing else. Same rule as above. */
const SIGN_CALLBACK = String.raw`
(function () {
  var q = new URLSearchParams(location.search);
  var provider = location.pathname.indexOf('/oauth/cloudflare/') === 0 ? 'cloudflare' : 'github';
  var code = q.get('code') || '';
  var state = q.get('state') || '';
  try { history.replaceState(null, '', location.pathname); } catch (e) {}
  var say = document.getElementById('say');
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(code) || !/^s\.[A-Za-z0-9_-]{22,128}$/.test(state)) {
    say.textContent = 'The sign-in did not come back with anything to finish. Start again from the signing page.';
    return;
  }
  try {
    var ch = new BroadcastChannel('fleetwright-signer');
    ch.postMessage({ type: provider, code: code, state: state });
    ch.close();
  } catch (e) {
    say.textContent = 'This browser could not pass the sign-in to the signing page. Start again from there.';
    return;
  }
  say.textContent = 'Signed in. Back to the signing page, which carries on from here.';
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
  --ok: #4ade80; --attention: #fbbf24; --bad: #f87171;
  --ring: rgba(255, 255, 255, 0.07);
}
@media (prefers-color-scheme: light) {
  :root {
    --bg: #f7f8fa; --card: #ffffff; --inner: #f1f3f7;
    --ink: #12151a; --ink-dim: #5b6474;
    --accent: #3866d6;
    --ok: #0f7a52; --attention: #a15c00; --bad: #c02b2b;
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
.actions { display: flex; gap: var(--s-inside-tight); flex-wrap: wrap; align-items: center; }
.item .actions { margin-top: var(--s-inside-tight); }
/* One row per thing the vault keeps, every row the same shape. */
.item { padding: var(--s-inside) 0; border-top: 1px solid var(--ring); }
.item:first-child { border-top: none; padding-top: 0; }
h3 { font-size: var(--t-body); margin: 0; overflow-wrap: anywhere; }
.state { color: var(--ink-dim); font-size: var(--t-body-small); margin: var(--s-hair) 0 0; }
.state.on { color: var(--ok); }
.step { display: grid; gap: var(--s-inside-tight); margin-top: var(--s-inside); }
.step p { margin: 0; }
input {
  font: var(--t-body)/1 var(--font); min-height: 44px; width: 100%; padding: 0 var(--s-inside);
  border-radius: var(--r-row); border: 1px solid var(--ink-dim); background: var(--inner); color: var(--ink);
}
button.chip { font-weight: 400; font-size: var(--t-body-small); }
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
@media (forced-colors: active) { .card, button, .btn, input { border: 1px solid; } }
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
 * @property {string} fleetOrigin  the coordinator's origin, `https://…`: who may open the page, and where a sign-in comes back
 * @property {string} clientId     the GitHub App's client id, public
 * @property {string} [fleet]      the fleet's name, for the heading
 * @property {Record<string, string[]>} [fleetParams]  per verb, the parameters the fleet sets (intent-signature.js)
 * @property {{ clientId: string, scopes: string }|null} [cloudflare]  the Cloudflare client a vault keeps a sign-in
 *   with, and its registered scopes; absent, the page offers no Cloudflare sign-in, because there is none to make
 */

/**
 * Serve the signing host: the page, each provider's way back to it, and
 * nothing else. Null for any other path, which the Worker answers 404.
 *
 * @param {{ method: string, path: string }} req
 * @param {SignerDeps} deps
 * @returns {Promise<{ status: number, body: string, headers: Record<string, string> }|null>}
 */
export async function signerRoutes(req, deps) {
  if (req.path !== SIGNER_PATH && !SIGNER_CALLBACK_PATHS.includes(req.path)) return null;
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
  if (SIGNER_CALLBACK_PATHS.includes(req.path)) {
    const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Back to signing</title><style>${CALLBACK_STYLE}</style></head><body>
<h1>Signing in</h1><p id="say" role="status">Passing the sign-in back to the signing page.</p>
<script>${SIGN_CALLBACK}</script></body></html>`;
    return { status: 200, body, headers: { 'content-type': 'text/html; charset=utf-8', ...(await headersFor([SIGN_CALLBACK], [CALLBACK_STYLE])) } };
  }
  const fleet = esc(deps.fleet || 'this fleet');
  const cf = deps.cloudflare?.clientId && deps.cloudflare?.scopes ? { clientId: String(deps.cloudflare.clientId), scopes: String(deps.cloudflare.scopes) } : null;
  const cfg = scriptJson({ fleetOrigin: origin, clientId: String(deps.clientId), fleetParams: deps.fleetParams || {}, cloudflare: cf });
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Your vault: ${fleet}</title><style>${SIGN_STYLE}</style></head><body><main>
<h1>Your vault on ${fleet}</h1>
<p class="lede">Your credentials are kept here once, for the machines you approve. This page is served by the minter, not by the fleet&#39;s coordinator, which is why it is on an address of its own and why the coordinator never sees what is in it.</p>

<section id="alone" class="card" hidden>
  <h2>Opened on its own</h2>
  <p>This page works through your credentials page, which opens it and passes on what it sends. Go to <a id="fleet-link" class="btn" href="#">your credentials page</a> and choose Open your vault there.</p>
</section>

<section id="setup" class="card" hidden>
  <h2>List this browser</h2>
  <p>This browser needs a key of its own, listed for <strong id="setup-who"></strong>, before it can open your vault or ask a machine to make a Claude sign-in. Listing it takes a GitHub sign-in as you, which this page finishes with the minter.</p>
  <button class="primary" id="list">Sign in with GitHub and list it</button>
</section>

<section id="vault" class="card" hidden>
  <h2>Your vault</h2>
  <div id="vault-closed">
    <p>Your Claude sign-in, GitHub, Cloudflare and named secrets, kept once and given to the machines you approve. Opening it takes a GitHub sign-in as you, which this window holds until it is closed.</p>
    <button class="primary" id="vault-open">Sign in with GitHub and open it</button>
  </div>
  <div id="vault-body" hidden>
    <p class="lede" id="vault-who"></p>
    <div id="items"></div>
  </div>
</section>

<section id="machines-card" class="card" hidden>
  <h2>Machines</h2>
  <p class="lede">A machine is given what your vault keeps only once you approve it here. Before you approve one, check that its fingerprint matches what fleetwright-sidecar identity prints on that machine.</p>
  <div id="machines"></div>
</section>

<section id="listed" class="card" hidden>
  <h2>This browser</h2>
  <p id="listed-who"></p>
  <button class="link" id="forget">Forget this browser&#39;s key</button>
</section>

<p class="say" id="say" role="status" aria-live="polite"></p>
<footer><p>Nothing here starts, stops or reads a session. What you keep is sealed to the minter on this page, and only the machines you approve are given it.</p></footer>
</main>
<script type="application/json" id="cfg">${cfg}</script>
<script>${SIGN_HELPERS}</script>
<script>${SIGN_MAIN}</script>
</body></html>`;
  return { status: 200, body, headers: { 'content-type': 'text/html; charset=utf-8', ...(await headersFor([SIGN_HELPERS, SIGN_MAIN], [SIGN_STYLE])) } };
}
