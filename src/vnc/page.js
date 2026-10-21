// THE VM CONSOLE INSIDE THE APPS. Asked for: "we should be able to connect to
// vm console". Xen Orchestra serves a machine's screen as VNC over a
// WebSocket at /api/consoles/<vm id>, behind the same sign-in token the pool
// page uses. noVNC draws it.
//
// THE PAGE NEVER OPENS A SOCKET. A web view cannot pin the pool's certificate
// or send the token as a cookie without handing it to the page, so the phone
// opens the socket itself, the same pinned way it opens the pool page
// (XOLink.swift, XoLink.kt), and this page gets the bytes. NativeChannel is the
// WebSocket-shaped thing noVNC takes in place of a URL (Websock.attach checks
// for exactly these properties). The token never reaches this page.
//
// The phone talks to it through two calls each way:
//   page -> phone   { t: 'send', b: base64 } and { t: 'close' }, and what
//                   the console is doing: { t: 'state', s, why? }
//   phone -> page   window.fwConsole.opened(), .data(base64), .closed(why),
//                   .keyboard(), .type(text), .key(name), .ctrlAltDel()
// Built into one HTML file for both apps by scripts/build-vnc.mjs.

/// <reference lib="dom" />
/// <reference path="./novnc.d.ts" />
import RFB from '@novnc/novnc';

/** @param {object} m */
function post(m) {
  const w = /** @type {any} */ (window);
  if (w.webkit?.messageHandlers?.fw) w.webkit.messageHandlers.fw.postMessage(m);
  else if (w.FleetwrightBridge) w.FleetwrightBridge.post(JSON.stringify(m));
}

/** @param {ArrayBuffer|Uint8Array} buf */
function toBase64(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, /** @type {any} */ (bytes.subarray(i, i + 0x8000)));
  return btoa(s);
}

/** @param {string} b64 */
function fromBase64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out.buffer;
}

class NativeChannel {
  constructor() {
    /** @type {string} */ this.readyState = 'connecting';
    this.binaryType = 'arraybuffer';
    this.protocol = '';
    /** @type {((e: any) => void)|null} */ this.onopen = null;
    /** @type {((e: any) => void)|null} */ this.onmessage = null;
    /** @type {((e: any) => void)|null} */ this.onclose = null;
    /** @type {((e: any) => void)|null} */ this.onerror = null;
  }
  /** @param {ArrayBuffer|Uint8Array} data */
  send(data) {
    if (this.readyState === 'open') post({ t: 'send', b: toBase64(data) });
  }
  close() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    post({ t: 'close' });
    this.onclose?.({ code: 1000, reason: '', wasClean: true });
  }
}

const channel = new NativeChannel();
const screen = /** @type {HTMLElement} */ (document.getElementById('screen'));
const typing = /** @type {HTMLTextAreaElement} */ (document.getElementById('typing'));
/** @type {any} */
let rfb = null;

function start() {
  rfb = new RFB(screen, /** @type {any} */ (channel), { shared: true });
  rfb.scaleViewport = true;
  rfb.resizeSession = false;
  rfb.background = '#000';
  rfb.addEventListener('connect', () => post({ t: 'state', s: 'connected' }));
  rfb.addEventListener('disconnect', (/** @type {any} */ e) => post({ t: 'state', s: 'ended', clean: !!e.detail?.clean }));
  rfb.addEventListener('securityfailure', (/** @type {any} */ e) => post({ t: 'state', s: 'refused', why: String(e.detail?.reason ?? '') }));
  // Xen Orchestra's console asks for no VNC password: the token was its
  // sign-in. One that does is not one this page can answer.
  rfb.addEventListener('credentialsrequired', () => post({ t: 'state', s: 'refused', why: 'it asked for a VNC password' }));
}

// TYPING ON A PHONE. A touch screen has no keys to send until a text field
// has focus, so the phone's Keyboard button focuses this one, and what is
// typed into it goes to the machine as key presses.
/** @param {number} keysym */
function press(keysym) {
  rfb?.sendKey(keysym, null);
}
/** The keys a phone's keyboard has that are not text, as X keysyms. */
const SPECIAL = /** @type {Record<string, number>} */ ({ Backspace: 0xff08, Enter: 0xff0d, Tab: 0xff09, Escape: 0xff1b, ArrowLeft: 0xff51, ArrowUp: 0xff52, ArrowRight: 0xff53, ArrowDown: 0xff54 });
/** @param {string} text */
function typeText(text) {
  for (const ch of text) {
    const code = /** @type {number} */ (ch.codePointAt(0));
    if (code === 10) press(0xff0d);
    else press(code < 0x100 ? code : 0x01000000 + code);
  }
}
typing.addEventListener('keydown', (e) => {
  if (SPECIAL[e.key]) {
    press(SPECIAL[e.key]);
    e.preventDefault();
  }
});
typing.addEventListener('input', () => {
  typeText(typing.value);
  typing.value = '';
});

/** @type {any} */ (window).fwConsole = {
  opened() {
    channel.readyState = 'open';
    channel.onopen?.({});
  },
  /** @param {string} b64 */
  data(b64) {
    if (channel.readyState === 'open') channel.onmessage?.({ data: fromBase64(b64) });
  },
  /** @param {string} why */
  closed(why) {
    if (channel.readyState === 'closed') return;
    channel.readyState = 'closed';
    channel.onclose?.({ code: 1006, reason: why ?? '', wasClean: false });
  },
  keyboard() {
    typing.focus();
  },
  // iOS raises no keyboard for a field focused from code, so it catches keys
  // natively (VMConsoleView) and hands them over here.
  /** @param {string} text */
  type(text) {
    typeText(text);
  },
  /** @param {string} name */
  key(name) {
    if (SPECIAL[name]) press(SPECIAL[name]);
  },
  ctrlAltDel() {
    rfb?.sendCtrlAltDel();
  },
};

start();
post({ t: 'state', s: 'ready' });
