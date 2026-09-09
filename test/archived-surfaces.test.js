// A remedy may not name a surface this product no longer has.
//
// Telegram was archived — `src/adapters/telegram.js` is gone and config.js
// warns that AGENT_HUB_TELEGRAM_TOKEN is read by nothing. Three user-facing
// strings went on telling people to use it, and all three were REMEDIES: the
// sentence printed when a host has no linked account (twice, in two renderers)
// and the one printed when a host is too old to know a verb.
//
// That is the worst place for it. A refusal naming a reason is this protocol's
// central promise, and a reason with a remedy attached is the whole of it — so
// a remedy pointing at something that does not exist costs somebody a search
// before it costs them a shell, having first told them the product could help.
//
// This test is a tripwire rather than a rule about Telegram. The next adapter
// to be archived will leave the same debris, and the failure mode is that
// nobody greps for it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Surfaces that have been archived, and what should be offered instead. */
const ARCHIVED = [{ name: 'Telegram', instead: 'the app, or `agent-hub` on the box' }];

/** Every .js under a root, recursively. */
function sources(root) {
  /** @type {string[]} */
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.js')) out.push(full);
    }
  };
  walk(root);
  return out;
}

/**
 * Code with comments stripped — line comments and block comments alike.
 *
 * Because the explanation of WHY something was removed says the word, and three
 * tests in this repository have now fired on exactly that prose.
 */
const code = (s) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');

/**
 * The installer and the example configuration, which are not .js and were not
 * scanned. That hole held five remedies for a year: install.sh told a fresh
 * box to "send /login in Telegram" and the example env file called Telegram
 * "the recommended control surface" while config.js said nothing read it.
 * Shell comments are stripped like JS ones; the env example is all comments,
 * so there every line counts and only a line that says "archived" is allowed
 * to name it.
 */
function installerSources() {
  const root = fileURLToPath(new URL('../install/', import.meta.url));
  /** @type {Array<{ file: string, body: string }>} */
  const out = [];
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (!e.isFile()) continue;
    const file = path.join(root, e.name);
    const text = readFileSync(file, 'utf8');
    if (e.name.endsWith('.sh')) {
      out.push({ file, body: text.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n') });
    } else if (e.name.endsWith('.env.example')) {
      out.push({ file, body: text });
    }
  }
  return out;
}

test('no remedy points at a surface that was archived', () => {
  const root = fileURLToPath(new URL('../src/', import.meta.url));
  /** @type {string[]} */
  const offenders = [];
  const scanned = [
    ...sources(root).map((file) => ({ file, body: code(readFileSync(file, 'utf8')) })),
    ...installerSources(),
  ];
  for (const { file, body } of scanned) {
    for (const { name } of ARCHIVED) {
      for (const line of body.split('\n')) {
        if (!line.includes(name)) continue;
        // THE ONE THING IT MAY STILL SAY is that the surface is archived. Both
        // config.js and index.js warn when AGENT_HUB_TELEGRAM_TOKEN is set,
        // which is the opposite of the bug — it tells somebody their
        // configuration is now inert, which they need to know.
        if (/archived/i.test(line)) continue;
        offenders.push(`${path.relative(path.dirname(root), file)}: ${line.trim().slice(0, 90)}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `these name an archived surface:\n${offenders.join('\n')}`);
});

/**
 * The documentation, where the settings of an archived surface outlived it by
 * longer than anywhere else.
 *
 * The installer stopped telling a fresh box to configure Telegram; the prose
 * that tells an OPERATOR to did not. `deployment.md` still listed a Telegram id
 * as one of two things "worth planning for before you start", still explained
 * how to put one in `AGENT_HUB_TELEGRAM_ALLOWED_USERS`, still said
 * `/etc/agent-hub.env` holds a Telegram token, and still filed "Telegram on the
 * Worker" under not-done with the words "Telegram works against a box today".
 * `security.md` carried the bot token as a live row in the credential
 * inventory, which is the one table where a dead secret is worst.
 *
 * SO THE RULE IS ABOUT THE VARIABLES, not the word. A document may discuss
 * Telegram all it likes — telegram.md IS the archive record, and beta-findings
 * and agent-hub.md describe corrections that have to name what was corrected.
 * What it may not do is put `AGENT_HUB_TELEGRAM_*` in front of a reader
 * without saying it is archived, because that is the form the reader acts on.
 */
function docs() {
  const root = fileURLToPath(new URL('../docs/', import.meta.url));
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => ({ file: path.join(root, e.name), body: readFileSync(path.join(root, e.name), 'utf8') }));
}

test('no document names an archived surface\'s settings without saying so', () => {
  /** @type {string[]} */
  const offenders = [];
  for (const { file, body } of docs()) {
    if (!/AGENT_HUB_TELEGRAM/.test(body)) continue;
    // Said ANYWHERE in the file, not on the line: these are paragraphs, and the
    // sentence that marks the surface dead is usually the one before or after
    // rather than the one carrying the variable.
    if (/archived/i.test(body)) continue;
    offenders.push(path.basename(file));
  }
  assert.deepEqual(
    offenders,
    [],
    `these name AGENT_HUB_TELEGRAM_* and never say it is archived:\n${offenders.join('\n')}`,
  );
});

test('the account remedy still names two live ways to do it', () => {
  // DELETING THE DEAD ROUTE IS HALF THE JOB. A remedy trimmed to nothing is the
  // "reason without a remedy" this message was rewritten to stop being, so the
  // two surfaces that DO exist have to survive the edit.
  const registry = readFileSync(new URL('../src/fleet/coordinator/registry.js', import.meta.url), 'utf8');
  const mcp = readFileSync(new URL('../src/mcp/server.js', import.meta.url), 'utf8');
  for (const [name, src] of [['the registry', code(registry)], ['the MCP renderer', code(mcp)]]) {
    assert.match(src, /Link one from the app/, `${name} no longer offers the app`);
    assert.match(src, /agent-hub login for/, `${name} no longer offers the box`);
  }
});
