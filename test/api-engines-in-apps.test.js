// API keys and rented machines on the two phones and the signing page
// (docs/api-engines.md): what a person sees, and what each client sends.
//
//   node --test test/api-engines-in-apps.test.js
//
// A read of the sources, not a run: the Swift and the Kotlin compile only in
// CI. The signing page is plain JavaScript, so its rules are run, here in a
// VM and in a browser in test/sign-page.test.js. What a build cannot check
// is what this holds:
//
//   1. THE TABLES ARE THE FLEET'S. Which providers there are, what each is
//      called, how a model on one is written and which vault item its key is
//      kept under are written four times: by the fleet (`API_PROVIDERS`), by
//      each phone and by the page. This imports the fleet's and holds the
//      other three to it, and does the same for the sandbox providers.
//   2. WHAT IS SENT IS WHAT THE FLEET TAKES. A sandbox provider's record is
//      built on each client and read by the vault (`sandboxRecord`); the
//      paid-key switch is one field in a request of its own
//      (`checkBudgetSettings`). Each is built here as the client builds it
//      and handed to the code that reads it.
//   3. NOTHING IS OFFERED THAT IS REFUSED (C-2), and nothing is drawn that
//      nobody sent (C-5): a key's row only for a provider an engine is on,
//      a switch only for a fleet that sent it, no restart on a machine that
//      has none, no network for a machine that is on nobody's network.
//   4. THE THREE SAY IT IN THE SAME WORDS.
//
// Identifiers are matched as `\w+` wherever the rule does not depend on one,
// and a control is found by the words beside it and the block it sits in, so
// renaming a function changes nothing here and removing the rule does.
//
// What a vault, a machine and the coordinator do with any of it is their own
// tests' business (test/vault.test.js, test/api-engines*.test.js,
// test/sandbox-*.test.js). That an engine item is kept by `put` under a name
// the vault knows, emptied afterwards and never offered a Test is
// test/engines-in-apps.test.js, which this does not repeat.

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { iosSources } from './helpers/ios-sources.js';
import { androidSources } from './helpers/android-sources.js';
import { API_PROVIDERS, API_KEY_ITEMS, ENGINES, checkEngines, credentialOf, providerOf } from '../src/fleet/protocol/engines.js';
import { MAX_SANDBOX_TEMPLATES, SANDBOX_PROVIDER_NAMES, sandboxRecord } from '../src/fleet/protocol/sandboxes.js';
import { approvalNeeded, checkBudgetSettings } from '../src/fleet/protocol/budgets.js';
import { imageWhere, placeKind } from '../src/fleet/coordinator/core.js';
import { signerRoutes } from '../src/fleet/minter/sign-page.js';

const IOS = iosSources();
const ANDROID = androidSources();
const PAGE = readFileSync(new URL('../src/fleet/minter/sign-page.js', import.meta.url), 'utf8');
const BOTH = /** @type {const} */ ([['iOS', IOS], ['Android', ANDROID]]);

/** `assert.match`, saying which rule went and not the megabytes it went from. @param {string} src @param {RegExp} re @param {string} what */
const has = (src, re, what) => assert.ok(re.test(src), `${what}\n  looked for ${re}`);
/** A string as a regex that matches it and nothing else. @param {string} s */
const lit = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The captures of the first match, or a failure that says what was being looked for. @param {string} src @param {RegExp} re @param {string} what */
const caught = (src, re, what) => {
  const m = re.exec(src);
  assert.ok(m, `${what}\n  looked for ${re}`);
  return m.slice(1);
};
/** The first capture. @param {string} src @param {RegExp} re @param {string} what */
const found = (src, re, what) => caught(src, re, what)[0];
/** How many times a source holds a string. @param {string} src @param {string} text */
const count = (src, text) => src.split(text).length - 1;
/** The one place a string is. @param {string} src @param {string} text @param {string} name */
const only = (src, text, name) => {
  assert.equal(count(src, text), 1, `${name} has ${JSON.stringify(text)} ${count(src, text)} times, and this reads the one`);
  return src.indexOf(text);
};

const indent = (/** @type {string} */ line) => /^ */.exec(line)?.[0].length ?? 0;
const isComment = (/** @type {string} */ line) => /^\s*(?:\/\/|\/\*|\*)/.test(line);

/**
 * The lines that open the blocks a place sits inside, innermost first, read
 * off the indentation. The place's own line is first when it opens one.
 * @param {string} src @param {number} at
 */
function headers(src, at) {
  const lineStart = src.lastIndexOf('\n', at - 1) + 1;
  const before = src.slice(0, lineStart).split('\n');
  let depth = indent(src.slice(lineStart));
  /** @type {string[]} */
  const chain = [];
  for (let i = before.length - 2; i >= 0 && depth > 0; i -= 1) {
    const line = before[i];
    if (!line.trim() || isComment(line) || indent(line) >= depth) continue;
    depth = indent(line);
    chain.push(line.trim());
  }
  return chain;
}

/**
 * Whether a place is drawn only where a condition holds: one of the blocks
 * it sits in asks it, or it sits in a view of its type's own that is drawn
 * only from such a block, or on a line that asks it first.
 * @param {string} src @param {number} at @param {RegExp} gate
 */
function gated(src, at, gate) {
  const chain = headers(src, at);
  if (chain.some((h) => gate.test(h))) return true;
  const own = chain.map((h) => /\bvar (\w+): some View \{/.exec(h)?.[1]).find(Boolean);
  if (!own) return false;
  // Every use of that view inside the type it belongs to.
  const type = src.lastIndexOf(`\n${chain[chain.length - 1]}`, at) + 1;
  const end = src.indexOf('\n}\n', type);
  const uses = [...src.slice(type, end).matchAll(new RegExp(`(?<![.\\w])${own}\\b(?!:)`, 'g'))].map((m) => type + /** @type {number} */ (m.index));
  return uses.length > 0 && uses.every((use) => {
    const line = src.slice(src.lastIndexOf('\n', use - 1) + 1, use).trim();
    return gate.test(line) || headers(src, use).some((h) => gate.test(h));
  });
}

/**
 * A block's text: from the line a place is on to the line that closes it,
 * which is the next line indented no deeper that starts with a bracket.
 * @param {string} src @param {number} at
 */
function block(src, at) {
  const lineStart = src.lastIndexOf('\n', at - 1) + 1;
  const lines = src.slice(lineStart).split('\n');
  const depth = indent(lines[0]);
  const out = [lines[0]];
  for (const line of lines.slice(1)) {
    out.push(line);
    // A line that closes one bracket and opens another, as the end of a
    // parameter list does, is not the end.
    if (line.trim() && indent(line) <= depth && /^[})\]]/.test(line.trim()) && !/[{(]$/.test(line.trim())) break;
  }
  return out.filter((line) => !isComment(line)).join('\n');
}

/** A sentence with whatever a phone or the page puts into it marked the same way. @param {string} s */
const plain = (s) => s.replace(/\\\(\w+(?:\.\w+)?\)/g, '{}').replace(/\$\{\w+(?:\.\w+)?\}/g, '{}').replace(/\$\w+/g, '{}');
/** Every sentence in a piece of source: a string literal with a space in it. @param {string} src */
const sentences = (src) => [...src.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)].map((m) => m[1]).filter((s) => s.includes(' ')).map(plain);

/** The signing page's own helpers, as it serves them, run and not read. */
async function pageHelpers() {
  const page = await signerRoutes({ method: 'GET', path: '/' }, /** @type {any} */ ({ fleetOrigin: 'https://fleet.test', clientId: 'Iv23liTEST' }));
  const ctx = vm.createContext({ crypto: globalThis.crypto, TextEncoder, TextDecoder, btoa, atob });
  vm.runInContext(String(page?.body).split('<script>')[1].split('</script>')[0], ctx);
  return /** @type {any} */ (ctx).SIGNER;
}
/** Arrays and objects made in the page's VM, as this realm's own, so they compare. @param {unknown} v */
const here = (v) => JSON.parse(JSON.stringify(v));

const PROVIDERS = Object.entries(API_PROVIDERS).map(([id, p]) => ({ id, says: p.says, prefix: p.opencode, item: p.item }));
const KEY = 'e2b_0123456789abcdef0123';

// ---------------------------------------------------------------------------
// An engine on an API key
// ---------------------------------------------------------------------------

test('the providers, their names, how a model on one is written and where its key is kept are the fleet’s own table, on both phones and the page', async () => {
  // One row a provider on each phone: its id, what it is called, the prefix
  // of a model on it and its vault item, in the fleet's order.
  const row = (/** @type {{ id: string, says: string, prefix: string, item: string }} */ p, /** @type {string} */ sep) =>
    `\\(\\w+${sep}"${lit(p.id)}", \\w+${sep}"${lit(p.says)}", \\w+${sep}"${lit(p.prefix)}", \\w+${sep}"${lit(p.item)}"\\)`;
  for (const [name, src, sep] of /** @type {const} */ ([['iOS', IOS, ': '], ['Android', ANDROID, ' = ']])) {
    has(src, new RegExp(PROVIDERS.map((p) => `\\w+${row(p, sep)},\\s*`).join('')), `${name} does not hold the fleet’s API providers, each as the fleet has it and in its order`);
    const rows = src.match(new RegExp(`\\w+\\(\\w+${sep}"[\\w-]+", \\w+${sep}"[^"\\n]+", \\w+${sep}"\\w+", \\w+${sep}"apikey:[\\w-]+"\\)`, 'g')) ?? [];
    assert.equal(rows.length, PROVIDERS.length, `${name} offers ${rows.length} API providers and the fleet has ${PROVIDERS.length}`);
  }
  const S = await pageHelpers();
  assert.deepEqual(here(S.API_PROVIDERS), PROVIDERS, 'the signing page holds another table of API providers');
  // And the page's list of what an engine runs on is the vault's.
  assert.deepEqual(here(S.ENGINE_ITEMS), [ENGINES.codex.credential, ENGINES.opencode.credential, ...API_KEY_ITEMS]);
});

test('which item an engine runs on is the fleet’s rule: the key of the provider its model names, and otherwise the engine’s own sign-in', async () => {
  // THE RULE, read off the fleet: a provider only for OpenCode, by what its
  // model starts with, whatever comes after the first slash.
  const choices = [
    { engine: 'codex' },
    { engine: 'codex', model: 'openrouter/gpt-5' },
    { engine: 'opencode', model: 'github-copilot/gpt-5' },
    ...PROVIDERS.flatMap((p) => [{ engine: 'opencode', model: `${p.prefix}/m0del` }, { engine: 'opencode', model: `${p.prefix}/vendor/m0del` }]),
    { engine: 'opencode', model: 'elsewhere/m0del' },
    { engine: 'opencode' },
  ];
  const S = await pageHelpers();
  for (const choice of choices) {
    assert.equal(S.engineItemOf(choice), credentialOf(choice), `the signing page keeps ${JSON.stringify(choice)} on another item than the fleet hands it`);
  }
  // SO A KEY'S ROW IS OFFERED FOR THE PROVIDER AN ENGINE IS ON, and no
  // other; a Copilot row is not offered for an OpenCode that runs on a key;
  // and a kept key can be forgotten whatever the member runs on now.
  const offered = (/** @type {unknown[]} */ engines, /** @type {string[]} */ kept) => here(S.engineItems(engines, kept));
  for (const p of PROVIDERS) {
    assert.deepEqual(offered([{ engine: 'claude-code' }, { engine: 'opencode', model: `${p.prefix}/vendor/m0del` }], []), [p.item]);
    assert.deepEqual(offered([{ engine: 'claude-code' }], [p.item]), [p.item], 'a kept key has no row to forget it from');
  }
  assert.deepEqual(offered([{ engine: 'opencode', model: 'github-copilot/gpt-5' }], []), [ENGINES.opencode.credential], 'a key’s row is offered to a member with no engine on that provider');
  assert.deepEqual(offered([{ engine: 'codex' }, { engine: 'claude-code' }], ['claude']), [ENGINES.codex.credential]);
  // The page reads each engine with its model, which is what says the provider.
  has(PAGE, /\{ engine: (\w+)\.engine, model: typeof \1\.model === 'string' \? \1\.model : '' \}/, 'the signing page reads a member’s engines without their models, so it cannot tell which provider one is on');

  // THE PHONES, the same rule read as text: OpenCode only, the model up to
  // its first slash, matched against a provider's prefix.
  const iosProvider = found(IOS, /func (\w+)\(of \w+: \w+\) -> \w+\? \{\s*guard (?:\w+)\.engine == "opencode", let (?:\w+) = \w+\.model else \{ return nil \}\s*let (?:\w+) = \w+\.components\(separatedBy: "\/"\)\.first \?\? ""\s*return \w+\.first \{ \$0\.\w+ == \w+ \}\s*\}/, 'iOS does not find an engine’s provider by what its model starts with, for OpenCode alone');
  const androidProvider = found(ANDROID, /fun (\w+)\(\w+: \w+\): \w+\? \{\s*if \(\w+\.engine != "opencode"\) return null\s*val (?:\w+) = \w+\.model \?: return null\s*val (?:\w+) = \w+\.substringBefore\("\/"\)\s*return \w+\.firstOrNull \{ it\.\w+ == \w+ \}\s*\}/, 'Android does not find an engine’s provider by what its model starts with, for OpenCode alone');
  // The item: the provider's, and the engine's own sign-in when it has none.
  const iosItem = found(IOS, new RegExp(`func (\\w+)\\(for (\\w+): \\w+\\) -> String\\? \\{\\s*${iosProvider}\\(of: \\2\\)\\?\\.\\w+ \\?\\? \\w+\\(\\2\\.engine\\)\\s*\\}`), 'iOS does not keep an engine on its provider’s key, or forgets the engine’s own sign-in');
  const androidItem = found(ANDROID, new RegExp(`fun (\\w+)\\((\\w+): \\w+\\): String\\? = ${androidProvider}\\(\\2\\)\\?\\.\\w+ \\?: \\w+\\(\\2\\.engine\\)\\n`), 'Android does not keep an engine on its provider’s key, or forgets the engine’s own sign-in');
  // And that is what decides which rows a vault's screen offers.
  has(IOS, new RegExp(`kept\\.contains\\((\\w+)\\) \\|\\| engines\\.contains \\{ ${iosItem}\\(for: \\$0\\) == \\1 \\}`), 'iOS offers a key’s row by some other rule than which item an engine runs on');
  has(ANDROID, new RegExp(`(\\w+) in kept \\|\\| engines\\.any \\{ ${androidItem}\\(it\\) == \\1 \\}`), 'Android offers a key’s row by some other rule than which item an engine runs on');
  // The fleet's own rule, so this test reads what it is checking against.
  assert.equal(providerOf({ engine: 'opencode', model: 'openrouter/a/b' }), 'openrouter');
  assert.equal(providerOf({ engine: 'codex', model: 'openrouter/a' }), null);
});

test('a key’s row is named for its provider, pasted into a field that hides it, with who bills it said under the field, the same on all three', async () => {
  const S = await pageHelpers();
  // THE ROW'S TITLE: the provider, then "API key".
  has(IOS, /if let (\w+) = \w+\(item: name\) \{ return "\\\(\1\.\w+\) API key" \}/, 'iOS does not name a key’s row for its provider');
  has(ANDROID, /(\w+\(name\)) != null -> "\$\{\1\?\.\w+\} API key"/, 'Android does not name a key’s row for its provider');
  for (const p of PROVIDERS) assert.equal(S.itemLabel(p.item), `${p.says} API key`);

  // THE LINE UNDER THE FIELD: one sentence, the same on all three, naming
  // the provider as where its limit is set.
  const iosLine = caught(IOS, /func (\w+)\(_ \w+: \w+\) -> String \{\s*"(Billed by the token\.[^"\n]+)"\s*\}/, 'iOS has no line saying who bills an API key');
  const androidLine = caught(ANDROID, /fun (\w+)\(\w+: \w+\): String =\s*"(Billed by the token\.[^"\n]+)"/, 'Android has no line saying who bills an API key');
  assert.equal(plain(androidLine[1]), plain(iosLine[1]), 'the phones say who bills an API key differently');
  for (const p of PROVIDERS) assert.equal(S.apiKeyBillingLine(p.says), plain(iosLine[1]).replace('{}', p.says), 'the signing page says who bills an API key differently');
  for (const words of [/\bbudget\b/, /\bset at \{\}/]) assert.match(plain(iosLine[1]), words, 'the line no longer says where a key’s limit is set, or that no budget counts it');

  // PASTED INTO A FIELD THAT HIDES IT, with that line straight under it, in
  // the branch a provider's key has.
  has(IOS, new RegExp(`\\} else if let (\\w+) = \\w+\\(item: name\\) \\{[\\s\\S]{0,260}?SecureField\\("\\\\\\(\\1\\.\\w+\\) API key", text: \\$\\w+\\)[\\s\\S]{0,160}?Text\\(${iosLine[0]}\\(\\1\\)\\)`), 'iOS shows an API key as it is typed, or does not say who bills it under the field');
  has(ANDROID, new RegExp(`\\} else if \\((\\w+) != null\\) \\{[\\s\\S]{0,400}?label = \\{ Text\\("\\$\\{\\1\\.\\w+\\} API key"\\) \\},\\s*singleLine = true,\\s*visualTransformation = PasswordVisualTransformation\\(\\),[\\s\\S]{0,160}?Hint\\(${androidLine[0]}\\(\\1\\)\\)`), 'Android shows an API key as it is typed, or does not say who bills it under the field');
  has(PAGE, /var value = (\w+) \? field\('The ' \+ \1\.says \+ ' API key', 'password'\) : /, 'the signing page shows an API key as it is typed');
  has(PAGE, /form\.appendChild\(value\);\s*(?:\/\/[^\n]*\n\s*)*if \((\w+)\) form\.appendChild\(el\('p', 'lede', S\.apiKeyBillingLine\(\1\.says\)\)\);/, 'the signing page does not say who bills an API key under its field');

  // NO TEST, as for the two sign-ins: the vault does not try a key, so
  // neither phone lists one among what it can ask a service about.
  const iosTestable = found(IOS, /static func isTestable\(_ name: String\) -> Bool \{\s*\[([^\]\n]*)\]\.contains\(name\)/, 'iOS no longer says which kept items can be tested');
  const androidTestable = found(ANDROID, /fun isTestable\(name: String\): Boolean = name in setOf\(([^)\n]*)\)/, 'Android no longer says which kept items can be tested');
  for (const [name, list] of [['iOS', iosTestable], ['Android', androidTestable]]) {
    for (const item of [...API_KEY_ITEMS, 'sandbox:e2b']) assert.ok(!list.includes(`"${item}"`), `${name} offers Test for ${item}, which the vault does not try`);
  }
});

test('the OpenCode model field says the three ways a model is written and what each runs on, the same on both phones, and each is one the fleet takes', () => {
  const ios = caught(IOS, /let (\w+) = "(OpenCode needs a model\. [^"\n]+)"/, 'iOS has no line under OpenCode’s model');
  const android = caught(ANDROID, /const val (\w+) = "(OpenCode needs a model\. [^"\n]+)"/, 'Android has no line under OpenCode’s model');
  assert.equal(android[1], ios[1], 'the phones say how an OpenCode model is written differently');
  // Every form the fleet takes is named, and nothing it would refuse.
  const forms = ios[1].match(/[\w-]+\/<model>/g) ?? [];
  assert.deepEqual([...forms].sort(), ['github-copilot/<model>', ...PROVIDERS.map((p) => `${p.prefix}/<model>`)].sort(), 'the line names other ways to write a model than the fleet takes');
  for (const form of forms) {
    const checked = checkEngines([{ engine: 'opencode', model: form.replace('<model>', 'm0del') }]);
    assert.equal(checked.ok, true, `the line offers ${form}, which the fleet refuses`);
  }
  // And what each runs on: the member's Copilot token, or a key billed by the token.
  assert.match(ios[1], /github-copilot\/<model>, it runs on the member’s Copilot token\./);
  assert.match(ios[1], /it runs on an API key and is billed by the token\./);
  // Drawn under OpenCode's model field, and under no other engine's.
  has(IOS, new RegExp(`if \\w+ == "opencode" \\{\\s*Text\\(${ios[0]}\\)`), 'iOS does not say how an OpenCode model is written under its field');
  has(ANDROID, new RegExp(`if \\(\\w+\\.engine == "opencode"\\) Hint\\(${android[0]}\\)`), 'Android does not say how an OpenCode model is written under its field');
  // THE PHONE CHECKS ONLY THAT THERE IS ONE. Which prefix it has is the
  // fleet's to refuse, in its own sentence, so a provider added to the
  // fleet's table needs no new build to be typed.
  for (const [name, src] of BOTH) {
    for (const p of PROVIDERS) assert.ok(!new RegExp(`hasPrefix\\("${p.prefix}|startsWith\\("${p.prefix}`).test(src), `${name} decides for itself which model prefixes are allowed`);
  }
  const refused = checkEngines([{ engine: 'opencode', model: 'elsewhere/m0del' }]);
  assert.equal(refused.ok, false);
  assert.ok(!refused.ok && PROVIDERS.every((p) => refused.text.includes(`${p.prefix}/<model>`)), 'the fleet no longer says which prefixes it takes when it refuses one; the phones rely on that sentence');
});

test('a machine’s page says the API providers its operator turned on, by the fleet’s names, and draws nothing when it names none', () => {
  // The names are the table's (the first test); one this build never met is
  // shown as the fleet sent it (C-5).
  const iosName = found(IOS, /func (\w+)\(_ (\w+): String\) -> String \{\s*\w+\.first \{ \$0\.\w+ == \2 \}\?\.\w+ \?\? \2\s*\}/, 'iOS makes up a name for a provider it never met');
  const androidName = found(ANDROID, /fun (\w+)\((\w+): String\): String = \w+\.firstOrNull \{ it\.\w+ == \2 \}\?\.\w+ \?: \2\n/, 'Android makes up a name for a provider it never met');
  // The line, and no line at all for a machine that names none.
  const iosLine = found(IOS, new RegExp(`func (\\w+)\\(_ \\w+: \\[String\\]\\?\\) -> String\\? \\{[\\s\\S]{0,120}?guard !(\\w+)\\.isEmpty else \\{ return nil \\}\\s*return "API keys turned on for: " \\+ \\2\\.map\\(${iosName}\\)\\.joined\\(separator: ", "\\)`), 'iOS says a machine’s API providers by other names, or says something for a machine with none');
  const androidLine = found(ANDROID, new RegExp(`fun (\\w+)\\(\\w+: List<String>\\?\\): String\\? \\{[\\s\\S]{0,120}?if \\((\\w+)\\.isEmpty\\(\\)\\) return null\\s*return "API keys turned on for: " \\+ \\2\\.joinToString\\(", "\\) \\{ ${androidName}\\(it\\) \\}`), 'Android says a machine’s API providers by other names, or says something for a machine with none');
  // Read off the machine's own report, and drawn on its page.
  has(IOS, /var apiProviders: \[String\]\? = nil\n/, 'iOS does not read a machine’s API providers');
  has(ANDROID, /apiProviders = health\?\.optJSONArray\("apiProviders"\)\?\.let \{/, 'Android does not read a machine’s API providers off its report');
  has(IOS, new RegExp(`if let (\\w+) = ${iosLine}\\(health\\?\\.apiProviders\\) \\{\\s*Text\\(\\1\\)`), 'iOS never draws a machine’s API providers');
  has(ANDROID, new RegExp(`${androidLine}\\(h\\?\\.apiProviders\\)\\?\\.let \\{ Hint\\(it\\) \\}`), 'Android never draws a machine’s API providers');
});

// ---------------------------------------------------------------------------
// Asking before a session on a paid key
// ---------------------------------------------------------------------------

// What each phone keeps the fleet's `paidApi` in, found from where it is read
// off the wire: on iOS the property the answer is decoded into by its name,
// which nothing may default; on Android the one a reader fills by hand, which
// answers null for a field that is not there.
has(IOS, /var paidApi: Bool\? = nil\n/, 'iOS reads a switch the fleet did not send as something');
const PAID = /** @type {const} */ ({
  iOS: 'paidApi',
  Android: found(ANDROID, /\b(\w+) = \w+\(\w+, "paidApi"\),/, 'Android does not read the paid-key switch off the setting'),
});

test('the paid-key switch is drawn only for a fleet that sent it, never from a default of the phone’s (C-5)', () => {
  const label = /(?:let|const val) (\w+) = "Ask before a session on a paid API key"\n/;
  const line = /(?:let|const val) (\w+) = "A key is billed by the token and no budget here counts it, so this is on until an admin turns it off\."\n/;
  for (const [name, src] of BOTH) {
    const ios = name === 'iOS';
    // THE DRAFT IS WHATEVER THE FLEET SENT, nothing included: it starts as
    // nothing, and no line of the app turns nothing into on or off.
    const draft = found(src, new RegExp(`\\n\\s*(\\w+) = \\w+\\.${PAID[name]}\\n`), `${name} does not take the paid-key switch from the fleet’s answer`);
    has(src, ios ? new RegExp(`@State private var ${draft}: Bool\\?\\n`) : new RegExp(`var ${draft} by remember \\{ mutableStateOf<Boolean\\?>\\(null\\) \\}`), `${name} starts the paid-key switch at a value nobody sent`);
    assert.ok(!new RegExp(`\\b${draft} \\?[?:] (?:true|false)\\b`).test(src), `${name} reads a switch the fleet did not send as on or off`);
    // THE BLOCK THAT ASKS WHETHER IT WAS SENT. In it the switch has a name
    // of its own: on iOS the unwrapped draft, on Android a copy of it.
    const [sent, gate] = ios
      ? [found(src, new RegExp(`if let (\\w+) = ${draft} \\{\\n`), 'iOS does not ask whether the fleet sent the switch before drawing it'), new RegExp(`^if let \\w+ = ${draft} \\{$`)]
      : (() => {
        const copy = found(src, new RegExp(`val (\\w+) = ${draft}\\n\\s*if \\(\\1 != null\\) \\{`), 'Android does not ask whether the fleet sent the switch before drawing it');
        return [copy, new RegExp(`^if \\(${copy} != null\\) \\{$`)];
      })();
    // The label is drawn twice, as a switch and as a word, and both times
    // inside that block.
    const said = found(src, label, `${name} has no label for the paid-key switch`);
    const uses = [...src.matchAll(new RegExp(`\\(${said}[,)]`, 'g'))].map((m) => /** @type {number} */ (m.index));
    assert.equal(uses.length, 2, `${name} draws the paid-key switch’s label ${uses.length} times; this reads a switch and a word`);
    for (const at of uses) assert.ok(headers(src, at).some((h) => gate.test(h)), `${name} draws the paid-key switch for a fleet that did not send one`);
    // The switch shows what was sent, and somebody who is not an admin reads
    // the same thing as a word.
    has(src, ios ? new RegExp(`Toggle\\(${said}, isOn: Binding\\(get: \\{ ${sent} \\}, set: \\{ ${draft} = \\$0 \\}\\)\\)`) : new RegExp(`\\.toggleable\\(value = ${sent}, enabled = !busy, role = Role\\.Switch, onValueChange = \\{ ${draft} = it \\}\\)`), `${name}’s paid-key switch shows something other than what the fleet sent, or changes something other than the draft`);
    has(src, ios ? new RegExp(`Text\\(${sent} \\? "On" : "Off"\\)`) : new RegExp(`Text\\(if \\(${sent}\\) "On" else "Off",`), `${name} shows somebody who is not an admin nothing about the paid-key switch`);
    // And the one line under it is in the same block.
    const why = found(src, line, `${name} lost the line under the paid-key switch`);
    const drawn = [...src.matchAll(new RegExp(`(?:Text|Hint)\\(${why}\\)`, 'g'))].map((m) => /** @type {number} */ (m.index));
    assert.equal(drawn.length, 1, `${name} does not draw the line under the paid-key switch once`);
    assert.ok(headers(src, drawn[0]).some((h) => gate.test(h)), `${name} explains a switch it did not draw`);
  }
  // Android reads the field by hand: absent is null, and never false.
  const flag = found(ANDROID, new RegExp(`\\b${PAID.Android} = (\\w+)\\(\\w+, "paidApi"\\),`), 'Android does not read the paid-key switch off the setting');
  has(ANDROID, new RegExp(`fun ${flag}\\(\\w+: JSONObject\\?, (\\w+): String\\): Boolean\\? =\\s*if \\(\\w+ != null && \\w+\\.has\\(\\1\\) && !\\w+\\.isNull\\(\\1\\)\\) \\w+\\.optBoolean\\(\\1\\) else null`), 'Android reads a switch the fleet did not send as off');
});

test('Save sends the paid-key switch alone in its own request, only when the fleet sent it and the draft moved it', () => {
  // THE BODY, one field, to the setting's route.
  const iosSend = found(IOS, /func (\w+)\(_ (\w+): Bool\) async throws -> \w+ \{\s*let (?:\w+): \[String: Any\] = \["paidApi": \2\]\s*return [^\n]*send\("PUT", "\/api\/budgets\/settings", body: \w+\)/, 'iOS does not send the paid-key switch as `{ paidApi }`');
  const androidSend = found(ANDROID, /fun (\w+)\((\w+): Boolean\)[^\n]*\{\s*runCatching \{\s*val (?:\w+) = JSONObject\(\)\.put\("paidApi", \2\)\s*\w+\(send\("PUT", "\/api\/budgets\/settings", \w+\)\)/, 'Android does not send the paid-key switch as `{ paidApi }`');
  // The fleet takes exactly that, and keeps everything it was not sent.
  const was = { budgets: 'ask', dangerous: true, paidApi: true, workTypes: ['deploy'] };
  assert.deepEqual(checkBudgetSettings({ paidApi: false }, was), { ok: true, budgets: 'ask', dangerous: true, paidApi: false, workTypes: ['deploy'] }, 'the fleet no longer takes `{ paidApi }` alone and keeps the rest');

  // WHEN: after the three were taken, the fleet's answer carried a setting,
  // there is a draft of the switch at all, and it differs from the fleet's.
  const iosDraft = found(IOS, new RegExp(`\\n\\s*(\\w+) = \\w+\\.${PAID.iOS}\\n`), 'iOS has no draft of the paid-key switch');
  has(IOS, new RegExp(`if (\\w+)\\.ok == true, let (\\w+) = \\1\\.settings, let (\\w+) = ${iosDraft}, \\3 != \\2\\.${PAID.iOS} \\{[\\s\\S]{0,120}?\\1 = try await [^\\n]*\\.${iosSend}\\(\\3\\)`), 'iOS sends the paid-key switch to a fleet that never sent one, or when nothing about it changed');
  const androidDraft = found(ANDROID, new RegExp(`\\n\\s*(\\w+) = \\w+\\.${PAID.Android}\\n`), 'Android has no draft of the paid-key switch');
  has(ANDROID, new RegExp(`val (\\w+) = ${androidDraft}\\n\\s*if \\(\\w+\\?\\.ok == true && (\\w+) != null && \\1 != null && \\1 != \\2\\.${PAID.Android}\\) \\{[\\s\\S]{0,120}?\\.${androidSend}\\(\\1\\)`), 'Android sends the paid-key switch to a fleet that never sent one, or when nothing about it changed');
  // And a draft that moved only the switch still counts as something to save.
  has(IOS, new RegExp(`\\|\\| ${iosDraft} != \\w+\\?\\.${PAID.iOS}\\n`), 'iOS does not offer Save when only the paid-key switch changed');
  has(ANDROID, new RegExp(`\\|\\| ${androidDraft} != \\w+\\.${PAID.Android}\\)\\n`), 'Android does not offer Save when only the paid-key switch changed');
});

test('a start that waits because of a paid key says the fleet’s sentence, and neither phone has words of its own for that reason', () => {
  // The fleet's reason, so this reads what the phones are sent: on unless
  // somebody turned it off, a kind and a sentence.
  const need = approvalNeeded({ settings: { budgets: 'off', dangerous: false, workTypes: [] }, member: { id: 'debbie', name: 'Debbie' }, spend: null, start: { dangerous: false, paid: true } });
  assert.ok('reasons' in need && need.reasons.length === 1 && need.reasons[0].kind === 'paid-api' && need.reasons[0].text.includes('API key'), 'the fleet no longer asks about a paid key by default; this test reads its reason');
  // Drawn by its sentence, as every reason is (test/budgets-in-apps.test.js):
  // a phone that named the kinds would show this one as nothing.
  for (const [name, src] of BOTH) assert.ok(!src.includes('"paid-api"'), `${name} has words of its own for a paid-key reason, where the fleet’s sentence is the reason`);
});

// ---------------------------------------------------------------------------
// A sandbox provider in a person's own vault
// ---------------------------------------------------------------------------

test('the sandbox providers are the fleet’s, by id and by name, on both phones and the page', async () => {
  const fleet = Object.entries(SANDBOX_PROVIDER_NAMES).map(([id, says]) => ({ id, says }));
  for (const [name, src, sep] of /** @type {const} */ ([['iOS', IOS, ': '], ['Android', ANDROID, ' = ']])) {
    has(src, new RegExp(`\\[?\\(?${fleet.map((p) => `\\w+\\(\\w+${sep}"${lit(p.id)}", \\w+${sep}"${lit(p.says)}"\\)`).join(',\\s*')}[\\])]`), `${name} does not hold the fleet’s sandbox providers`);
  }
  const S = await pageHelpers();
  assert.deepEqual(here(S.SANDBOX_PROVIDERS), fleet);
  // The kept one is named for its provider, the same on all three.
  has(IOS, /if let (\w+) = \w+\(item: name\) \{ return "\\\(\1\), sandbox provider" \}/, 'iOS does not name a kept sandbox provider');
  has(ANDROID, /(\w+\(name\)) != null -> "\$\{\1\}, sandbox provider"/, 'Android does not name a kept sandbox provider');
  for (const p of fleet) assert.equal(S.itemLabel(`sandbox:${p.id}`), `${p.says}, sandbox provider`);
});

test('the sandbox form sends `put sandbox:<provider>` with a record the vault reads, and nothing at all with no template', async () => {
  const sample = [{ id: 'base', name: 'Base image' }, { id: 'node.22-ci_x', name: 'node.22-ci_x' }];
  const reads = (/** @type {string|null} */ value) => sandboxRecord('sandbox:e2b', value);

  // THE PAGE, run: the record it builds is one the vault reads back whole.
  const S = await pageHelpers();
  assert.deepEqual(reads(S.sandboxValue(`  ${KEY}\n`, sample)), { provider: 'e2b', key: KEY, templates: sample }, 'the vault does not read the record the signing page builds');
  assert.equal(S.sandboxValue(KEY, []), null, 'the signing page builds a record with no template');
  assert.equal(S.sandboxValue('   ', sample), null, 'the signing page builds a record with no key');
  // It refuses to send with no template before it reads the key, sends to
  // the person's own vault whatever is showing, and empties the field.
  has(PAGE, /if \(!templates\.length\) \{ note\(r, 'Add at least one template\. A machine is made from one\.', true\); return; \}\s*var (\w+) = (\w+)\.value;\s*\2\.value = '';\s*var (\w+) = S\.sandboxValue\(\1, templates\);\s*if \(!\3\) \{[^\n]*return; \}\s*(?:\/\/[^\n]*\n\s*)*change\(r, 'Keeping it\.', function \(\) \{ return vaultAsk\('put', \{ name: (\w+), value: \3, 'for': null \}\)/, 'the signing page sends a sandbox provider with no template, to a member’s vault, or leaves its key in the field');
  has(PAGE, /function sandboxForm\(r, (\w+), \w+\) \{[\s\S]{0,200}?var name = 'sandbox:' \+ \1\.id;/, 'the signing page keeps a sandbox provider under some other name');
  has(PAGE, /if \(!view\) box\.appendChild\(sandboxRow\(\)\);/, 'the signing page offers a sandbox provider in a member’s vault');

  // THE PHONES: the record as each writes it, built here from the field
  // names in its source and handed to the vault's own reader.
  const ios = caught(IOS, /\["(\w+)": (?:\w+), "(\w+)": \w+\.map \{ \["(\w+)": \$0\.(\w+), "(\w+)": \$0\.(\w+)\] \}\]/, 'iOS does not build a sandbox provider’s record');
  // No record, so nothing to send, with no key or no template; and the key
  // is sent without the space a paste leaves around it, which the vault
  // would refuse.
  const built = caught(ANDROID, /val (\w+) = \w+\.trim\(\)\s*if \(\1\.isEmpty\(\) \|\| \w+\.isEmpty\(\)\) return null\s*val (\w+) = JSONArray\(\)\s*for \((\w+) in \w+\) \2\.put\(JSONObject\(\)\.put\("(\w+)", \3\.(\w+)\)\.put\("(\w+)", \3\.(\w+)\)\)\s*return JSONObject\(\)\.put\("(\w+)", \1\)\.put\("(\w+)", \2\)\.toString\(\)/, 'Android builds a record with no key or no template, sends the key as it was pasted, or builds none');
  const android = [built[7], built[8], built[3], built[4], built[5], built[6]];
  for (const [name, [key, templates, a, aOf, b, bOf]] of /** @type {const} */ ([['iOS', ios], ['Android', android]])) {
    const record = { [key]: KEY, [templates]: sample.map((/** @type {Record<string, string>} */ t) => ({ [a]: t[aOf], [b]: t[bOf] })) };
    assert.deepEqual(reads(JSON.stringify(record)), { provider: 'e2b', key: KEY, templates: sample }, `the vault does not read the record ${name} builds`);
  }
  has(IOS, /let (\w+) = \w+\.trimmingCharacters\(in: \.whitespacesAndNewlines\)\s*guard !\1\.isEmpty, !\w+\.isEmpty else \{ return nil \}\s*let \w+: \[String: Any\] = \["\w+": \1,/, 'iOS builds a record with no key or no template, or sends the key as it was pasted');
  // The put: under the provider's name, in the person's own vault and no member's.
  const iosKeep = caught(IOS, /func (\w+)\(_ fleet: Fleet, (?:\w+): String, (?:\w+): String, (?:\w+): \[\w+\]\) async throws -> String \{\s*guard !(?:\w+)\.isEmpty else \{ throw [^\n]*\n\s*guard let (\w+) = \w+\(\w+: \w+, \w+: \w+\) else \{ throw [^\n]*\n\s*return try await ask\(fleet, op: "put", extra: \["name": "sandbox:\\\(\w+\)", "value": \2\]\)\.text/, 'iOS does not keep a sandbox provider with put, under its own name, in the person’s own vault');
  const androidKeep = caught(ANDROID, /fun (\w+)\(fleet: Fleet, (?:\w+): String, (?:\w+): String, (?:\w+): List<\w+>\): Result<String> = runCatching \{\s*require\((?:\w+)\.isNotEmpty\(\)\) [^\n]*\n\s*val (\w+) = requireNotNull\(\w+\(\w+, \w+\)\) [^\n]*\n\s*ask\(fleet, "put", JSONObject\(\)\.put\("name", "sandbox:\$\w+"\)\.put\("value", \2\)\)\.first/, 'Android does not keep a sandbox provider with put, under its own name, in the person’s own vault');

  // KEEP IS NOT OFFERED WITHOUT A KEY OR WITHOUT A TEMPLATE, it sends the
  // key in the field and the list on the screen, and the key is typed into
  // a field that hides it and is emptied once it was taken and when the
  // screen is left.
  const [iosKey, iosList] = caught(IOS, new RegExp(`\\.${iosKeep[0]}\\(fleet, \\w+: \\w+\\.\\w+, \\w+: (\\w+), \\w+: (\\w+)\\)`), 'iOS does not keep the key and the templates on the screen');
  has(IOS, new RegExp(`Button\\(\\w+ \\? "Keeping…" : "Keep in your vault"\\) \\{[^\\n]*\\}\\s*\\.disabled\\(\\w+ \\|\\| ${iosKey}\\.isBlank \\|\\| ${iosList}\\.isEmpty\\)`), 'iOS offers Keep for a sandbox provider with no key or no template');
  has(IOS, new RegExp(`SecureField\\("[^"\\n]*", text: \\$${iosKey}\\)`), 'iOS shows a sandbox provider’s key as it is typed');
  has(IOS, new RegExp(`\\.${iosKeep[0]}\\([^\\n]*\\n\\s*\\w+ = false\\n\\s*${iosKey} = ""\\n`), 'iOS leaves a sandbox provider’s key in the field after it was kept');
  has(IOS, new RegExp(`\\.onDisappear \\{ ${iosKey} = "" \\}`), 'iOS leaves a sandbox provider’s key in the field when the screen is left');
  has(IOS, new RegExp(`ForEach\\(${iosList}\\) \\{`), 'iOS draws one list of templates and sends another');
  const [androidKey, androidList] = caught(ANDROID, new RegExp(`\\.${androidKeep[0]}\\(Fleet\\(settings\\), \\w+\\.\\w+, (\\w+), (\\w+)\\)`), 'Android does not keep the key and the templates on the screen');
  has(ANDROID, new RegExp(`enabled = !busy && ${androidKey}\\.isNotBlank\\(\\) && ${androidList}\\.isNotEmpty\\(\\),[\\s\\S]{0,1200}?\\) \\{ Text\\(if \\(busy\\) "Keeping…" else "Keep in your vault"\\) \\}`), 'Android offers Keep for a sandbox provider with no key or no template');
  has(ANDROID, new RegExp(`value = ${androidKey},\\s*onValueChange = \\{ ${androidKey} = it\\.trim\\(\\) \\},[\\s\\S]{0,160}?visualTransformation = PasswordVisualTransformation\\(\\),`), 'Android shows a sandbox provider’s key as it is typed');
  has(ANDROID, new RegExp(`var ${androidKey} by remember \\{ mutableStateOf\\(""\\) \\}`), 'Android may write a sandbox provider’s key into the screen’s saved state');
  has(ANDROID, new RegExp(`if \\(\\w+\\.isSuccess\\) \\{\\s*${androidKey} = ""\\n`), 'Android leaves a sandbox provider’s key in the field after it was kept');
  has(ANDROID, new RegExp(`DisposableEffect\\(Unit\\) \\{ onDispose \\{ ${androidKey} = "" \\} \\}`), 'Android leaves a sandbox provider’s key in the field when the screen is left');
  has(ANDROID, new RegExp(`\\b${androidList}\\.forEach \\{ \\w+ ->`), 'Android draws one list of templates and sends another');

  // WHAT THE VAULT SAID IS THE LINE, a refusal's sentence included.
  has(IOS, new RegExp(`(\\w+) = try await \\w+\\.${iosKeep[0]}\\([\\s\\S]{0,200}?\\} catch \\{\\s*\\1 = error\\.localizedDescription`), 'iOS does not show what the vault said of a sandbox provider it refused');
  has(ANDROID, new RegExp(`val (\\w+) = \\w+\\.${androidKeep[0]}\\([^\\n]*\\n\\s*\\w+ = \\1\\.isFailure\\n\\s*\\w+ = \\1\\.getOrElse \\{ it\\.message \\?: `), 'Android does not show what the vault said of a sandbox provider it refused');
});

test('a template’s id is checked as the vault reads one, since the vault drops one it cannot read without a word, and the limits are the vault’s', async () => {
  // What the vault keeps of one template: the template, or nothing.
  const keeps = (/** @type {string} */ id, name = '') => sandboxRecord('sandbox:e2b', JSON.stringify({ key: KEY, templates: [{ id, name }] }))?.templates ?? [];
  const ids = ['base', 'A', '0', 'node.22-ci_x', 'a'.repeat(64), 'a'.repeat(65), '', '.hidden', '-dash', '_under', 'two words', 'tab\tbed', 'slash/id', 'ünï', 'semi;colon', 'a b'];
  // THE DROP THIS GUARDS AGAINST: a list of two with one bad id is kept as one.
  assert.equal(sandboxRecord('sandbox:e2b', JSON.stringify({ key: KEY, templates: [{ id: 'base' }, { id: 'two words' }] }))?.templates.length, 1, 'the vault now refuses a template it cannot read; the phones’ own check may no longer be needed');

  const S = await pageHelpers();
  for (const id of ids) {
    assert.equal(S.sandboxTemplate(id, '', []).ok, keeps(id).length === 1, `the signing page and the vault disagree about the template id ${JSON.stringify(id)}`);
  }
  // A name is the vault's: the id when there is none, cut where the vault cuts.
  for (const name of ['', '  Base  ', 'n'.repeat(61)]) {
    assert.deepEqual(here(S.sandboxTemplate('base', name, []).template), keeps('base', name)[0], 'the signing page lists a template under another name than the vault keeps');
  }
  assert.equal(S.sandboxTemplate('base', '', [{ id: 'base', name: 'base' }]).ok, false, 'the signing page lists one template twice');
  assert.equal(S.SANDBOX_TEMPLATE_LIMIT, MAX_SANDBOX_TEMPLATES);

  // What a refused id is answered with, the same on all three.
  const refusal = S.sandboxTemplate('two words', '', []).text;
  for (const [name, src, add, check, cut] of /** @type {const} */ ([
    ['iOS', IOS, (/** @type {string} */ b) => new RegExp(`guard (\\w+)\\((\\w+)\\) else \\{\\s*\\w+ = \\w+\\.${b}\\s*return\\s*\\}[\\s\\S]{0,700}?\\.append\\(\\w+\\(\\w+: \\2,`), (/** @type {string} */ f) => new RegExp(`func ${f}\\(_ (\\w+): String\\) -> Bool \\{\\s*\\1\\.range\\(of: (\\w+), options: \\.regularExpression\\) != nil\\s*\\}`), /String\(\w+\.trimmingCharacters\(in: \.whitespacesAndNewlines\)\.prefix\(([A-Za-z]\w*)\)\)\n/],
    ['Android', ANDROID, (/** @type {string} */ b) => new RegExp(`!(\\w+)\\((\\w+)\\) -> \\w+ = \\w+\\.${b}\\n[\\s\\S]{0,700}?\\+ \\w+\\(\\2,`), (/** @type {string} */ f) => new RegExp(`fun ${f}\\((\\w+): String\\): Boolean = Regex\\((\\w+)\\)\\.matches\\(\\1\\)\\n`), /= \w+\.trim\(\)\.take\(([A-Za-z]\w*)\)\n/],
  ])) {
    // Adding one asks the rule first, and a refused id is answered with the
    // sentence and not put on the list.
    const bad = found(src, new RegExp(`(?:static let|const val) (\\w+) = "${lit(refusal)}"\\n`), `${name} lost: ${refusal}`);
    const fn = found(src, add(bad), `${name} lists a template whose id the vault would drop`);
    // The phone's own pattern, run here against the vault's reader.
    const pattern = caught(src, check(fn), `${name} does not check a template’s id with a rule`)[1];
    const re = new RegExp(found(src, new RegExp(`(?:let|const val) ${pattern} = "([^"\\n]+)"\\n`), `${name} has no rule for a template’s id`));
    for (const id of ids) assert.equal(re.test(id), keeps(id).length === 1, `${name} and the vault disagree about the template id ${JSON.stringify(id)}`);
    // At most as many as the vault keeps, and no way to add one past that.
    const named = caught(src, /The name is what New session calls it\. At most (?:\\\((\w+)\)|\$(\w+))\."/, `${name} does not say how many templates there may be`).find(Boolean) ?? '';
    assert.equal(Number(found(src, new RegExp(`(?:let|const val) ${named} = (\\d+)\\n`), `${name} has no limit on templates`)), MAX_SANDBOX_TEMPLATES);
    const adding = only(src, '"Add the template"', name);
    assert.ok(headers(src, adding).some((h) => new RegExp(`^if \\(?\\w+\\.(?:count|size) < ${named}\\)? \\{$`).test(h)), `${name} offers to add a template past the vault’s limit`);
    // A name is cut where the vault cuts it, where it can be seen.
    const most = Number(found(src, new RegExp(`(?:let|const val) ${found(src, cut, `${name} does not cut a template’s name`)} = (\\d+)\\n`), `${name} has no limit on a template’s name`));
    assert.equal(keeps('base', 'n'.repeat(most + 1))[0].name.length, most, `${name} cuts a template’s name at ${most} characters and the vault somewhere else`);
  }
});

test('what a sandbox provider costs is said before Keep, in the same five lines on both phones and the page', async () => {
  const S = await pageHelpers();
  const page = here(S.sandboxBefore('{}'));
  // Each phone's list, read whole from where it is written.
  const iosAt = /static func (\w+)\(_ \w+: String\) -> \[String\] \{\n/.exec(IOS);
  const androidAt = /fun (\w+)\(\w+: String\): List<String> = listOf\(\n/.exec(ANDROID);
  assert.ok(iosAt && androidAt, 'a phone has no list of what to know before a sandbox provider is kept');
  const ios = [iosAt[1], block(IOS, iosAt.index)];
  const android = [androidAt[1], block(ANDROID, androidAt.index)];
  assert.deepEqual(sentences(ios[1]), page, 'iOS and the signing page say different things before a sandbox provider is kept');
  assert.deepEqual(sentences(android[1]), page, 'Android and the signing page say different things before a sandbox provider is kept');
  // The five things: the key is the whole account, whose cloud and who can
  // read it, that it ends, what a template must do, and whose switch it is.
  for (const [n, words] of /** @type {const} */ ([[0, /whole \{\} account/], [1, /\{\} can read what runs on it/], [2, /ends on a timer/], [3, /template has to be built to join your fleet/], [4, /operator turned \{\} on/]])) {
    assert.match(page[n], words, 'the lines before Keep no longer say what a sandbox provider costs');
  }
  assert.equal(page.length, 5);
  // BEFORE THE BUTTON, not in a footer under it.
  has(IOS, new RegExp(`ForEach\\(\\w+\\.${ios[0]}\\(\\w+\\.\\w+\\), id: \\\\\\.self\\) \\{ (\\w+) in\\s*Text\\(\\1\\)[\\s\\S]{0,300}?\\}\\s*Button\\(\\w+ \\? "Keeping…" : "Keep in your vault"\\)`), 'iOS says what a sandbox provider costs somewhere other than before Keep');
  has(ANDROID, new RegExp(`\\w+\\.${android[0]}\\(\\w+\\.\\w+\\)\\.forEach \\{ (\\w+) ->\\s*Text\\(\\1,[^\\n]*\\n\\s*\\}\\s*OutlinedButton\\(\\s*enabled = !busy && \\w+\\.isNotBlank\\(\\) && \\w+\\.isNotEmpty\\(\\),`), 'Android says what a sandbox provider costs somewhere other than before Keep');
  const form = found(PAGE, /function sandboxForm\(r, \w+, \w+\) \{([\s\S]*?)\n {2}\}\n/, 'the signing page has no form for a sandbox provider');
  assert.ok(form.indexOf('S.sandboxBefore(') > 0 && form.indexOf('S.sandboxBefore(') < form.indexOf("go.type = 'submit'"), 'the signing page says what a sandbox provider costs somewhere other than before Keep');
});

test('a kept sandbox provider is a row with Replace and Forget, and Replace says nothing kept is shown', async () => {
  const words = 'Nothing kept is shown. Enter the key and every template again.';
  for (const [name, src, kept, gate] of /** @type {const} */ ([
    ['iOS', IOS, /\n\s*(\w+) = \w+ != nil\n\s*\w+ = \w+\?\.at\n/, (/** @type {string} */ k) => new RegExp(`^if ${k} \\{(?: \\w+ \\})?$`)],
    ['Android', ANDROID, /\n\s*(\w+) = \w+ != null\n\s*\w+ = \w+\?\.at\n/, (/** @type {string} */ k) => new RegExp(`^if \\(${k}\\)(?: \\{)?$`)],
  ])) {
    // Whether one is kept is the vault's own list, and nothing else.
    const k = found(src, kept, `${name} does not learn whether a sandbox provider is kept from the vault’s list`);
    // Replace and Forget are drawn for a kept one only, each said with what
    // it does it to.
    for (const verb of ['Replace', 'Forget']) {
      const said = name === 'iOS' ? new RegExp(`\\.accessibilityLabel\\("${verb} \\\\\\(\\w+\\)"\\)`, 'g') : new RegExp(`contentDescription = "${verb} \\$\\w+" \\},`, 'g');
      const at = [...src.matchAll(said)].map((m) => /** @type {number} */ (m.index)).filter((p) => gated(src, p, gate(k)));
      assert.equal(at.length, 1, `${name} does not offer ${verb} on a kept sandbox provider, and on that alone`);
    }
    // Replace is the form again, empty, and says so, only then.
    const line = found(src, new RegExp(`(?:static let|const val) (\\w+) = "${lit(words)}"\\n`), `${name} lost: ${words}`);
    const drawn = [...src.matchAll(new RegExp(`(?:Text|Hint)\\(\\w+\\.${line}\\)`, 'g'))].map((m) => /** @type {number} */ (m.index));
    assert.equal(drawn.length, 1, `${name} does not say once that nothing kept is shown`);
    const first = src.slice(src.lastIndexOf('\n', drawn[0]) + 1, drawn[0]).trim();
    assert.ok(gate(k).test(first) || headers(src, drawn[0]).some((h) => gate(k).test(h)), `${name} says nothing kept is shown when nothing is kept`);
    // The form is drawn when none is kept, or after Replace.
    has(src, name === 'iOS' ? new RegExp(`if !${k} \\|\\| \\w+ \\{`) : new RegExp(`if \\(!${k} \\|\\| \\w+\\) \\{`), `${name} draws the form over a kept sandbox provider, or never draws it`);
  }
  // Forget asks first, with what it costs, as every item's does.
  const asks = found(IOS, /Button\("Forget", role: \.destructive\) \{ (\w+) = true \}/, 'iOS forgets a sandbox provider without asking');
  has(IOS, new RegExp(`\\.confirmationDialog\\("Forget \\\\\\(\\w+\\)\\?", isPresented: \\$${asks},`), 'iOS forgets a sandbox provider without asking');
  has(ANDROID, /if \((\w+)\) \{\s*AlertDialog\(\s*onDismissRequest = \{ \1 = false \},\s*title = \{ Text\("Forget \$\w+\?"\) \},/, 'Android forgets a sandbox provider without asking');
  // The page: the same row, the same words, from its own source.
  assert.ok(PAGE.includes(`'${words}'`), `the signing page lost: ${words}`);
  has(PAGE, /button\(r\.actions, x \? 'Replace' : 'Add a sandbox provider', null, function \(\) \{ sandboxForm\(r, \w+, Boolean\(x\)\); \}\);\s*if \(x\) forgetButton\(r, name\);/, 'the signing page does not offer Replace and Forget on a kept sandbox provider, and on that alone');
  has(PAGE, /if \(replacing\) form\.appendChild\(el\('p', null, 'Nothing kept is shown\./, 'the signing page says nothing kept is shown when nothing is kept');
});

test('Add a sandbox provider is on the page that lists hypervisors, and opens the form', () => {
  // iOS: a row under the list, to the screen that holds the form.
  const iosView = found(IOS, /NavigationLink \{\s*(\w+)\(settings: settings\)\s*\} label: \{\s*Label\("Add a sandbox provider", systemImage: "plus"\)/, 'iOS has no way to add a sandbox provider');
  const iosForm = block(IOS, IOS.indexOf(`struct ${iosView}: View {`));
  assert.ok(iosForm.includes('"Keep in your vault"') && iosForm.includes('"Add the template"'), 'iOS’s Add a sandbox provider opens something other than the form');
  const iosPage = block(IOS, IOS.lastIndexOf('\nstruct ', only(IOS, '.navigationTitle("Hypervisors")', 'iOS')) + 1);
  assert.ok(iosPage.includes('Label("Add a sandbox provider"'), 'iOS offers Add a sandbox provider somewhere other than the page that lists hypervisors');
  // Android: the same row, opening the same form over the list.
  const flag = found(ANDROID, /OpenRow\("Add a sandbox provider"\) \{ (\w+) = true \}/, 'Android has no way to add a sandbox provider');
  const screen = found(ANDROID, new RegExp(`if \\(${flag}\\) \\{\\s*(\\w+)\\(settings, onDismiss = \\{ ${flag} = false \\}\\)\\s*return\\s*\\}`), 'Android’s Add a sandbox provider opens nothing');
  const androidForm = block(ANDROID, ANDROID.indexOf(`internal fun ${screen}(`));
  assert.ok(androidForm.includes('"Keep in your vault"') && androidForm.includes('"Add the template"'), 'Android’s Add a sandbox provider opens something other than the form');
  const androidPage = block(ANDROID, ANDROID.lastIndexOf('\ninternal fun ', only(ANDROID, 'FullScreen(title = "Hypervisors"', 'Android')) + 1);
  assert.ok(androidPage.includes('OpenRow("Add a sandbox provider")'), 'Android offers Add a sandbox provider somewhere other than the page that lists hypervisors');
});

// ---------------------------------------------------------------------------
// A sandbox provider among the places a machine is made
// ---------------------------------------------------------------------------

test('both phones say where a sandbox template goes as the fleet does, and the other two kinds as before', () => {
  // The fleet's own words, so this reads what it holds the phones to.
  assert.equal(imageWhere('sandbox', 'E2B'), 'E2B');
  assert.equal(placeKind({ kind: 'sandbox' }), 'sandbox');
  for (const [name, src, flag, where] of /** @type {const} */ ([
    ['iOS', IOS, /var (\w+): Bool \{ kind == "sandbox" \}/, (/** @type {string} */ f) => new RegExp(`var (\\w+): String \\{\\s*if ${f} \\{ return (\\w+) \\?\\? "([^"\\n]+)" \\}\\s*return \\w+ \\? "([^"\\n]+)" : "([^"\\n]+)"\\s*\\}`)],
    ['Android', ANDROID, /val (\w+): Boolean get\(\) = kind == "sandbox"/, (/** @type {string} */ f) => new RegExp(`val (\\w+): String\\s*get\\(\\) = if \\(${f}\\) (\\w+) \\?: "([^"\\n]+)" else if \\(\\w+\\) "([^"\\n]+)" else "([^"\\n]+)"`)],
  ])) {
    // A sandbox template is known by the fleet's own word for its kind.
    const f = found(src, flag, `${name} does not know a sandbox template by the fleet’s word for it`);
    const [word, provider, unnamed, proxmox, xo] = caught(src, where(f), `${name} does not say where a machine from an image goes`);
    // The provider as the fleet sent it, which is the wire's `provider`: on
    // iOS the property the answer is decoded into by its name, on Android
    // the one read off the image by hand. And the fleet's own words otherwise.
    if (name === 'iOS') assert.equal(provider, 'provider', 'iOS says a sandbox template is on something other than the provider the fleet named');
    else has(src, new RegExp(`\\b${provider} = \\w+\\.optString\\("provider"\\)\\.takeIf \\{ it\\.isNotBlank\\(\\) && it != "null" \\},`), 'Android says a sandbox template is on something other than the provider the fleet named');
    assert.equal(unnamed, imageWhere('sandbox', null), `${name} says a sandbox template with no provider named differently from the fleet`);
    assert.equal(proxmox, imageWhere('proxmox'));
    assert.equal(xo, imageWhere('xo'));
    // And the picker says it: "New machine from base on E2B".
    const label = found(src, name === 'iOS' ? new RegExp(`var (\\w+): String\\? \\{\\s*${f} \\? "New machine from \\\\\\(name\\) on \\\\\\(${word}\\)" : nil\\s*\\}`) : new RegExp(`val (\\w+): String\\? get\\(\\) = if \\(${f}\\) "New machine from \\$name on \\$${word}" else null`), `${name} does not say a sandbox template as a machine on its provider`);
    has(src, name === 'iOS' ? new RegExp(`\\? "\\\\\\(image\\.label\\), ready now" : image\\.${label} \\?\\? image\\.label\\)`) : new RegExp(`else image\\.${label} \\?: image\\.label\\n`), `${name} offers a sandbox template as a machine on a hypervisor`);
  }
});

test('a sandbox template is offered as a rented machine that ends on a timer, with no network, group or lab to choose', () => {
  // THE ONE LINE, the same on both phones, drawn for a sandbox template only.
  const iosWords = caught(IOS, /static func (\w+)\(_ \w+: String\) -> String \{\s*"(A rented machine on [^"\n]+)"\s*\}/, 'iOS has no line for a rented machine');
  const androidWords = caught(ANDROID, /fun (\w+)\(\w+: String\): String =\s*"(A rented machine on [^"\n]+)"/, 'Android has no line for a rented machine');
  assert.equal(plain(androidWords[1]), plain(iosWords[1]), 'the phones say a rented machine differently');
  assert.match(plain(iosWords[1]), /^A rented machine on \{\}’s cloud\. It ends when its time runs out/, 'the line no longer says a sandbox template is a rented machine that ends');
  has(IOS, new RegExp(`\\} else if let (\\w+) = chosenImage, \\1\\.\\w+ \\{\\s*(?:\\/\\/[^\\n]*\\n\\s*)*Text\\(\\w+\\.${iosWords[0]}\\(\\1\\.\\w+\\)\\)`), 'iOS does not say a chosen sandbox template is a rented machine');
  const rented = found(ANDROID, /val (\w+) = images\.firstOrNull \{ it\.template == template \}\?\.takeIf \{ platform == "vm" && it\.\w+ \}/, 'Android does not know when the image chosen is a sandbox template');
  has(ANDROID, new RegExp(`\\} else if \\(${rented} != null\\) \\{\\s*(?:\\/\\/[^\\n]*\\n\\s*)*Text\\(\\w+\\.${androidWords[0]}\\(${rented}\\.\\w+\\),`), 'Android does not say a chosen sandbox template is a rented machine');

  // NO NETWORK, GROUP OR LAB, whatever was sent: New session draws each of
  // those pickers from the image's own lists, and a sandbox template is
  // handed to it with none.
  const iosFlag = found(IOS, /var (\w+): Bool \{ kind == "sandbox" \}/, 'iOS does not know a sandbox template');
  const offered = found(IOS, new RegExp(`var (\\w+): \\w+ \\{\\s*guard ${iosFlag} else \\{ return self \\}\\s*var (\\w+) = self\\s*\\2\\.networks = nil\\s*\\2\\.groups = nil\\s*\\2\\.labs = nil\\s*return \\2\\s*\\}`), 'iOS offers a network, a group or a lab for a sandbox template');
  has(IOS, new RegExp(`\\.vmImages \\?\\? \\[\\]\\)\\.map\\(\\\\\\.${offered}\\)`), 'iOS hands New session a sandbox template with whatever networks were sent');
  const androidRented = found(ANDROID, /val (\w+) = \w+ == "sandbox"\n/, 'Android does not know a sandbox template as it reads one');
  has(ANDROID, new RegExp(`networks = if \\(${androidRented}\\) null else \\w+\\([^\\n]*\\n\\s*groups = if \\(${androidRented}\\) null else \\w+\\([^\\n]*\\n\\s*labs = if \\(${androidRented}\\) null else \\w+\\(`), 'Android offers a network, a group or a lab for a sandbox template');
  // Which is what those pickers are drawn from.
  has(IOS, /if vmLab\.isEmpty, let networks = chosenImage\?\.networks, !networks\.isEmpty \{/, 'iOS draws the network picker from something other than the image’s own list');
  has(ANDROID, /val networks = images\.firstOrNull \{ it\.template == template \}\?\.networks\.takeIf \{/, 'Android draws the network picker from something other than the image’s own list');
});

test('the Hypervisors page draws a sandbox provider as what it is: its name, “Sandbox provider”, its templates, and nothing a hypervisor has', () => {
  const kind = 'Sandbox provider';
  for (const [name, src, flag, title, kindName, elsewhere, edges, facts] of /** @type {const} */ ([
    ['iOS', IOS,
      /var (\w+): Bool \{ fleet\?\.\w+ == true \}/,
      (/** @type {string} */ f) => new RegExp(`var (\\w+): String \\{ ${f} \\? \\(fleet\\?\\.provider \\?\\? address\\) : address \\}`),
      (/** @type {string} */ f) => new RegExp(`var (\\w+): String \\{ ${f} \\? \\w+\\.(\\w+) : proxmox \\? "Proxmox VE" : "Xen Orchestra" \\}`),
      (/** @type {string} */ f) => new RegExp(`if !row\\.proxmox && !row\\.${f} && !row\\.onPhone \\{\\s*Text\\(HypervisorWords\\.xoElsewhere\\)`),
      (/** @type {string} */ f) => new RegExp(`if row\\.${f} \\{ return false \\}`),
      /if let (\w+) = \w+\.images \{ \w+\.append\(\w+\.\w+ \? \w+\.(\w+)\(\1\) : \1 == 1 \? "1 image" : /],
    ['Android', ANDROID,
      /val (\w+): Boolean get\(\) = fleet\?\.\w+ == true/,
      (/** @type {string} */ f) => new RegExp(`val (\\w+): String get\\(\\) = if \\(${f}\\) fleet\\?\\.provider \\?: address else address`),
      (/** @type {string} */ f) => new RegExp(`val (\\w+): String get\\(\\) = if \\(${f}\\) \\w+\\.(\\w+) else if \\(proxmox\\) "Proxmox VE" else "Xen Orchestra"`),
      (/** @type {string} */ f) => new RegExp(`if \\(!row\\.proxmox && !row\\.${f} && !row\\.onPhone\\) Text\\(HypervisorWords\\.XO_ELSEWHERE,`),
      (/** @type {string} */ f) => new RegExp(`val \\w+ = !row\\.${f} && !\\(row\\.proxmox && `),
      /\w+\.images\?\.let \{ \w+\.add\(if \(\w+\.\w+\) \w+\.(\w+)\(it\) else if \(it == 1\) "1 image" else /],
  ])) {
    const f = found(src, flag, `${name}’s Hypervisors page does not know a sandbox provider`);
    // Its row: the provider's name where a hypervisor has its address, and
    // what it is where a hypervisor says its kind.
    const t = found(src, title(f), `${name} calls a sandbox provider by its address, which is nobody’s address`);
    const [k, word] = caught(src, kindName(f), `${name} does not say a sandbox provider is one`);
    has(src, new RegExp(`(?:static let|const val) ${word} = "${kind}"\\n`), `${name} calls a sandbox provider something other than “${kind}”`);
    has(src, new RegExp(`Text\\(row\\.${t}[,)]`), `${name}’s row is not titled with the provider’s name`);
    has(src, new RegExp(`Text\\(row\\.${k}[,)]`), `${name}’s row does not say what kind of place it is`);
    // Nothing a hypervisor has: not "its page opens on the phone that set it
    // up", and no edge router asked after. Its own machine and every setup
    // action are drawn for a Proxmox VE cluster alone, as they were.
    has(src, elsewhere(f), `${name} says a sandbox provider’s page opens on another phone`);
    has(src, edges(f), `${name} asks after a sandbox provider’s edge router`);
    // Templates, where a hypervisor has images, in the same words on both.
    const many = caught(src, facts, `${name} counts a sandbox provider’s templates as images`).at(-1);
    has(src, name === 'iOS' ? new RegExp(`static func ${many}\\(_ (\\w+): Int\\) -> String \\{\\s*\\1 == 1 \\? "1 template" : "\\\\\\(\\1\\) templates"\\s*\\}`) : new RegExp(`fun ${many}\\((\\w+): Int\\): String = if \\(\\1 == 1\\) "1 template" else "\\$\\1 templates"`), `${name} does not say how many templates a provider has`);
  }
  // A phone holds no pool of one, so its page is what the fleet saw: it is
  // put on the list apart from the pools, never matched against them.
  has(IOS, /\.filter\(\\\.\w+\)\.map \{ (\w+) in \w+\(address: \1\.address, proxmox: false, fleet: \1, onPhone: false\) \}/, 'iOS can take a sandbox provider for a pool this phone holds');
  has(ANDROID, /if \((\w+)\.\w+\) \w+\.add\(\w+\(\1\.address, false, \1, false\)\)/, 'Android can take a sandbox provider for a pool this phone holds');
  // Android reads the kind by hand, and keeps the fleet's third word for it.
  has(ANDROID, /kind = when \(\w+\.optString\("kind"\)\) \{\s*"proxmox" -> "proxmox"\s*"sandbox" -> "sandbox"\s*else -> "xo"\s*\},\s*provider = \w+\(\w+, "provider"\),/, 'Android reads a sandbox provider as a Xen Orchestra pool');
});

test('a rented machine’s page says whose cloud it is on, its state and when it ends, and offers More time and End and nothing a rented machine has not got', () => {
  for (const [name, src, page] of /** @type {const} */ ([
    ['iOS', IOS, (/** @type {string} */ s) => {
      // The two parts of the page a rented machine gets, by where the page
      // chooses between it and a machine of yours.
      const [facts, work] = caught(s, /if (?:\w+)\.\w+ \{\s*(\w+)\(\w+\)\s*(\w+)\(\w+\)\s*\} else \{\s*facts\(\w+\)\s*traffic\(\w+\)\s*reach\(\w+\)\s*work\(\w+\)\s*\}/, 'iOS draws a rented machine as one on your hypervisor');
      return { facts: block(s, s.indexOf(`private func ${facts}(`)), work: block(s, s.indexOf(`private func ${work}(`)) };
    }],
    ['Android', ANDROID, (/** @type {string} */ s) => {
      // The branch of the page a rented machine gets, which opens by saying
      // whose cloud it is on, cut where what can be done to it begins.
      const at = s.search(/\n\s*\w+\.\w+ -> \{\n\s*SectionHead\("This machine"\)\n[^\n]*\n\s*Fact\("On", \w+\.\w+\)/);
      assert.ok(at > 0, 'Android draws a rented machine as one on your hypervisor');
      const whole = block(s, at + 1);
      const cut = whole.indexOf('SectionHead("Work it")');
      assert.ok(cut > 0, 'Android’s rented machine has nothing that can be done to it');
      return { facts: whole.slice(0, cut), work: whole.slice(cut) };
    }],
  ])) {
    const { facts, work } = page(src);
    // WHAT IT IS: on whose cloud, its state, when it ends.
    for (const fact of ['"On"', '"State"', '"Ends"']) assert.ok(facts.includes(`(${fact},`), `${name}’s rented machine does not say ${fact}`);
    for (const [what, re] of /** @type {const} */ ([['an SSH address', /ssh/i], ['a console', /console/i], ['a network', /"Network"|\.network\b/], ['a size', /"Size"|cpus|memory/], ['an address of its own', /\.address\b|\.ip\b/]])) {
      assert.ok(!re.test(facts), `${name}’s rented machine shows ${what}, which a rented machine has not got`);
    }
    // WHAT CAN BE DONE: more time, and ending it, which asks first.
    assert.ok(work.includes('"More time"'), `${name}’s rented machine has no More time`);
    has(work, /act\("extend", (?:minutes: )?\w+\)/, `${name}’s More time does not ask for more time`);
    assert.ok(work.includes('"End it now"'), `${name}’s rented machine cannot be ended`);
    has(work, name === 'iOS' ? /Button\("End it now", role: \.destructive\) \{ asking = \.end \}/ : /onClick = \{ asking = "stop" \},[^\n]*\n\s*Text\("End it now"/, `${name} ends a rented machine without asking`);
    // AND NOTHING THE MACHINE THAT MADE IT REFUSES (C-2): no restart, no
    // new size, no console, no terminal, no sign-in handed to it.
    for (const [what, re] of /** @type {const} */ ([
      ['Restart', /"Restart|"reboot"|\.restart\b/],
      ['a new size', /"resize"|\.resize\b|Stepper\(|Counter\(|vCPU|GiB/],
      ['a console', /console/i],
      ['a terminal or SSH', /ssh|terminal/i],
      ['a Claude sign-in to hand it', /Claude|sign-in|login/i],
      ['a way to another page', /NavigationLink|OpenRow\(|Link\(/],
    ])) {
      assert.ok(!re.test(work) && !re.test(facts), `${name}’s rented machine offers ${what}, which the machine that made it refuses`);
    }
  }
  // The times are counted from now, and the choices and the line say so,
  // the same on both phones.
  for (const words of ['"30 minutes from now"', '"1 hour from now"', '"2 hours from now"']) {
    for (const [name, src] of BOTH) assert.ok(src.includes(words), `${name} lost: ${words}`);
  }
  const iosFooter = found(IOS, /static func \w+\(_ \w+: String\) -> String \{\s*"(The time is counted from now, [^"\n]+)"\s*\}/, 'iOS does not say a rented machine’s time is counted from now');
  const androidFooter = found(ANDROID, /fun \w+\(\w+: String\): String = "(The time is counted from now, [^"\n]+)"/, 'Android does not say a rented machine’s time is counted from now');
  assert.equal(plain(androidFooter), plain(iosFooter));
});

test('a rented machine is listed under its own heading, and its own page does not promise a console, SSH or a size', () => {
  for (const [name, src, heading, link] of /** @type {const} */ ([
    ['iOS', IOS, /static let (\w+) = "At a sandbox provider"\n/, /Text\((\w+)\.map\(\w+\.(\w+)\) \?\? "On your hypervisor: console, SSH, size and end"\)/],
    ['Android', ANDROID, /const val (\w+) = "At a sandbox provider"\n/, /OpenRow\((\w+)\?\.let \{ \w+\.(\w+)\(it\) \} \?: "On your hypervisor: console, SSH, size and end"\)/],
  ])) {
    // Under their own heading in the list, only when there are any.
    const h = found(src, heading, `${name} has no heading for rented machines`);
    const at = [...src.matchAll(new RegExp(`\\(\\w+\\.${h}\\)`, 'g'))].map((m) => /** @type {number} */ (m.index));
    assert.equal(at.length, 1, `${name} does not draw the heading for rented machines once`);
    assert.ok(headers(src, at[0]).some((line) => /^if \(?!?\w+\.(?:isEmpty|isNotEmpty\(\))\)? \{$/.test(line)), `${name} draws the heading for rented machines over none`);
    // "On your hypervisor" is over the others only.
    has(src, name === 'iOS' ? /let (\w+) = \w+\.filter \{ !\$0\.\w+ \}\s*if !\1\.isEmpty \{\s*\w+\("On your hypervisor"\)/ : /val (\w+) = \w+\.filter \{ !it\.\w+ \}[\s\S]{0,200}?if \(\1\.isNotEmpty\(\)\) \{\s*SectionHead\("On your hypervisor"\)/, `${name} lists a rented machine as on your hypervisor`);
    // On the machine's own page, the row to its page says what a rented
    // machine has, once the fleet has said it is one.
    const [from, words] = caught(src, link, `${name} promises a console, SSH and a size on a rented machine’s page`);
    has(src, name === 'iOS' ? new RegExp(`static func ${words}\\(_ \\w+: String\\) -> String \\{\\s*"At \\\\\\(\\w+\\): more time and end"\\s*\\}`) : new RegExp(`fun ${words}\\(\\w+: String\\): String = "At \\$\\w+: more time and end"`), `${name} does not say what a rented machine’s page offers`);
    has(src, name === 'iOS' ? new RegExp(`${from} = \\(try\\? await \\w+\\.vmMachines\\(\\)\\)\\?\\.first \\{ \\$0\\.name == hostId && \\$0\\.\\w+ \\}\\?\\.\\w+`) : new RegExp(`${from} = Fleet\\(settings\\)\\.vmMachines\\(\\)\\.getOrNull\\(\\)\\?\\.firstOrNull \\{ it\\.name == hostId && it\\.\\w+ \\}\\?\\.\\w+`), `${name} decides a machine is rented from something other than the fleet’s word`);
  }
});

test('the words about a sandbox provider are the same on both phones', () => {
  // Every sentence in the one place each phone keeps them, found by a
  // sentence that is in it and compared as a set: what is put into a
  // sentence is written differently in Swift and in Kotlin, and marked the
  // same here.
  const anchor = 'Nothing kept is shown. Enter the key and every template again.';
  const ios = block(IOS, IOS.lastIndexOf('\nenum ', only(IOS, `"${anchor}"`, 'iOS')) + 1);
  const android = block(ANDROID, ANDROID.lastIndexOf('\nobject ', only(ANDROID, `"${anchor}"`, 'Android')) + 1);
  const said = (/** @type {string} */ src) => [...new Set(sentences(src))].sort();
  assert.ok(said(ios).length >= 16, `this found ${said(ios).length} sentences about a sandbox provider on iOS; the search for them is broken`);
  assert.deepEqual(said(android), said(ios));
  // And the words on the form itself.
  for (const words of ['"Add a sandbox provider"', '"Replace it"', '"Templates"', '"No templates yet."', '"Add the template"', '"Before you keep it"', '"Keep in your vault"', '"Asking your vault…"', '"Could not load your saved credentials."', '"Provider"', '"Template id"']) {
    for (const [name, src] of BOTH) assert.ok(src.includes(words), `${name} lost: ${words}`);
  }
});
