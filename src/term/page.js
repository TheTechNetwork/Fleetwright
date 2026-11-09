// THE TERMINAL INSIDE THE APPS, for SSH to a machine made on your hypervisor.
// Asked for: "should be able to reach it somehow as well as ssh", from away
// as well as on the pool's own network. xterm.js draws it.
//
// THE PAGE NEVER OPENS A SOCKET, as the console page never does
// (src/vnc/page.js): the phone holds the SSH connection, with its own key, and
// this page is handed the bytes the shell wrote and hands back what was typed.
// The key never reaches this page.
//
// The phone talks to it through two calls each way:
//   page -> phone   { t: 'state', s: 'ready' }, { t: 'input', d: base64 },
//                   { t: 'size', cols, rows }
//   phone -> page   window.fwTerm.opened(), .data(base64), .closed(why)
// Built into one HTML file for both apps by scripts/build-term.mjs.

/// <reference lib="dom" />
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

/** @param {object} m */
function post(m) {
  const w = /** @type {any} */ (window);
  if (w.webkit?.messageHandlers?.fw) w.webkit.messageHandlers.fw.postMessage(m);
  else if (w.FleetwrightBridge) w.FleetwrightBridge.post(JSON.stringify(m));
}

/** @param {Uint8Array} bytes */
function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, /** @type {any} */ (bytes.subarray(i, i + 0x8000)));
  return btoa(s);
}

/** @param {string} b64 */
function fromBase64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const term = new Terminal({
  cursorBlink: false,
  convertEol: false,
  scrollback: 2000,
  fontSize: 14,
  fontFamily: 'ui-monospace, Menlo, monospace',
  theme: { background: '#000000' },
});
const fit = new FitAddon();
term.loadAddon(fit);
const screen = /** @type {HTMLElement} */ (document.getElementById('screen'));
term.open(screen);

let open = false;
let cols = 0;
let rows = 0;
const encoder = new TextEncoder();

/** The size, said to the phone whenever it changes, for the shell's pty. */
function sized() {
  try {
    fit.fit();
  } catch { /* not laid out yet */ }
  if (term.cols !== cols || term.rows !== rows) {
    cols = term.cols;
    rows = term.rows;
    post({ t: 'size', cols, rows });
  }
}
new ResizeObserver(sized).observe(screen);

term.onData((text) => {
  if (open) post({ t: 'input', d: toBase64(encoder.encode(text)) });
});

/** @type {any} */ (window).fwTerm = {
  opened() {
    open = true;
    sized();
    term.focus();
  },
  /** @param {string} b64 */
  data(b64) {
    term.write(fromBase64(b64));
  },
  /** @param {string} why */
  closed(why) {
    open = false;
    term.write(`\r\n\x1b[2m${String(why ?? '').replace(/[\x00-\x1f]/g, ' ')}\x1b[0m\r\n`);
  },
  focus() {
    term.focus();
  },
};

sized();
post({ t: 'state', s: 'ready' });
