// The two phones and the signing page say the same thing about engines
// (docs/engines.md), in the fleet's own words, and send what the fleet takes.
//
//   node --test test/engines-in-apps.test.js
//
// A read of the sources, not a run: the Swift and the Kotlin compile only in
// CI. What a build cannot check is what this holds:
//
//   1. THE SENTENCE IS THE FLEET'S. How a turn ended is written three times:
//      by the coordinator (`turnWords`, which a terminal and a notification
//      print) and by each phone. This imports the coordinator's and holds
//      both phones to it, so "stopped at its account’s limit" cannot come to
//      mean three slightly different things.
//   2. THE OTHER PHONE USES THE SAME WORDS, and so does the signing page
//      where it shows the same two sign-ins.
//   3. WHAT IS SENT IS WHAT THE FLEET TAKES: a member's engines as a list in
//      its order, never empty and never an OpenCode with no model; a Codex
//      sign-in, a Copilot token and a provider's API key as a `put` under
//      the names the vault keeps them by, and under no other.
//   4. NOTHING IS SAID THAT NOBODY SENT (C-5): a session whose machine named
//      no engines gets no engine line, and a machine that reported nothing
//      is not called Claude Code.
//
// Identifiers are matched as `\w+` wherever the rule does not depend on one,
// so renaming a function changes nothing here and removing the rule does.
// What the coordinator, the vault and a machine do with any of it is their
// own tests' business (test/engines*.test.js, test/vault.test.js).

import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { iosSources } from './helpers/ios-sources.js';
import { androidSources } from './helpers/android-sources.js';
import { ENGINES, ENGINE_IDS, MAX_ENGINES, DEFAULT_ENGINE, TURN_REASONS, HANDS_ON, API_KEY_ITEMS, turnWords, enginesWords, enginesOn } from '../src/fleet/protocol/engines.js';
import { ENGINE_ITEM_KINDS } from '../src/fleet/minter/vault.js';
import { signerRoutes } from '../src/fleet/minter/sign-page.js';

const IOS = iosSources();
const ANDROID = androidSources();
const PAGE = readFileSync(new URL('../src/fleet/minter/sign-page.js', import.meta.url), 'utf8');
const BOTH = /** @type {const} */ ([['iOS', IOS], ['Android', ANDROID]]);

/** `assert.match`, saying which rule went and not the megabytes it went from. @param {string} src @param {RegExp} re @param {string} what */
const has = (src, re, what) => assert.ok(re.test(src), `${what}\n  looked for ${re}`);
/** How many times a source holds a string. @param {string} src @param {string} text */
const count = (src, text) => src.split(text).length - 1;
/** A string as a regex that matches it and nothing else. @param {string} s */
const lit = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The first capture, or a failure that says what was being looked for. @param {string} src @param {RegExp} re @param {string} what */
const found = (src, re, what) => {
  const m = re.exec(src);
  assert.ok(m, `${what}\n  looked for ${re}`);
  return m[1];
};

/** A turn that ended this way, with nothing else said. @param {string} reason @param {Record<string, unknown>} [more] */
const turn = (reason, more = {}) => /** @type {any} */ ({ engine: 'codex', reason, detail: null, model: null, usage: null, resetsAt: null, ...more });
/** The coordinator's sentence with the engine's name taken off the front: what a phone writes after the name. @param {any} t */
const after = (t) => {
  const said = turnWords(t);
  assert.ok(said.startsWith(ENGINES.codex.says), `turnWords no longer opens with the engine’s name: ${said}`);
  return said.slice(ENGINES.codex.says.length);
};

// The one name a phone gives the engine every machine runs, read off the
// source so the rules below do not depend on what it is called.
const IOS_DEFAULT = found(IOS, new RegExp(`let (\\w+) = "${DEFAULT_ENGINE}"`), 'iOS does not name the engine every machine runs');
const ANDROID_DEFAULT = found(ANDROID, new RegExp(`const val (\\w+) = "${DEFAULT_ENGINE}"`), 'Android does not name the engine every machine runs');

test('an engine is called what the fleet calls it, and runs on the vault item the fleet says', () => {
  for (const [id, engine] of Object.entries(ENGINES)) {
    assert.ok(IOS.includes(`case "${id}": return "${engine.says}"`), `iOS does not call ${id} ${engine.says}`);
    assert.ok(ANDROID.includes(`"${id}" -> "${engine.says}"`), `Android does not call ${id} ${engine.says}`);
    assert.ok(IOS.includes(`case "${id}": return "${engine.credential}"`), `iOS does not keep ${id}’s sign-in as ${engine.credential}`);
    assert.ok(ANDROID.includes(`"${id}" -> "${engine.credential}"`), `Android does not keep ${id}’s sign-in as ${engine.credential}`);
  }
  // The same engines, in the fleet's order, and as many as a member names.
  const ids = ENGINE_IDS.map((id) => `"${id}"`).join(', ');
  assert.ok(IOS.includes(`[${ids}]`), 'iOS offers engines the fleet does not have, or not all of them');
  assert.ok(ANDROID.includes(`listOf(${ids})`), 'Android offers engines the fleet does not have, or not all of them');
  assert.equal(Number(found(IOS, /let engineLimit = (\d+)/, 'iOS has no limit on engines')), MAX_ENGINES);
  assert.equal(Number(found(ANDROID, /const val ENGINE_LIMIT = (\d+)/, 'Android has no limit on engines')), MAX_ENGINES);
  // An engine this build never met is shown as the fleet sent it (C-5).
  has(IOS, /default: return id\.isEmpty \? "an engine" : id\n/, 'iOS does not show an engine it never met as itself');
  has(ANDROID, /else -> id\.ifEmpty \{ "an engine" \}\n/, 'Android does not show an engine it never met as itself');
});

test('how a turn ended is the fleet’s own sentence on both phones, and a turn that simply ended says nothing', () => {
  // The whole sentence where it has no moving part, bound to its reason.
  for (const reason of ['auth', 'refused', 'cut', 'cancelled']) {
    const rest = lit(after(turn(reason)));
    has(IOS, new RegExp(`case "${reason}":\\s*return "\\\\\\(\\w+\\)${rest}"`), `iOS says something else when a turn ends with ${reason}`);
    has(ANDROID, new RegExp(`"${reason}" -> "\\$\\{?\\w+\\}?${rest}"`), `Android says something else when a turn ends with ${reason}`);
  }
  // A limit: the sentence, then when it lifts, in the phone's own time
  // format, only when the engine said.
  const limit = lit(after(turn('limit')));
  const lifts = after(turn('limit', { resetsAt: 1_700_000_000_000 })).slice(after(turn('limit')).length);
  const liftsLead = found(lifts, /^( It says the limit lifts at )\d/, 'turnWords no longer says when a limit lifts');
  has(IOS, new RegExp(`case "limit":\\s*let \\w+ = \\w+\\(\\w+\\)\\.map \\{ "${lit(liftsLead)}\\\\\\(\\$0\\)\\." \\} \\?\\? ""\\s*return "\\\\\\(\\w+\\)${limit.replace(/\\\.$/, '')}\\.\\\\\\(\\w+\\)"`), 'iOS says something else at a limit');
  has(ANDROID, new RegExp(`"limit" -> \\{\\s*val \\w+ = \\w+\\(\\w+\\)\\?\\.let \\{ "${lit(liftsLead)}\\$it\\." \\}\\.orEmpty\\(\\)\\s*"\\$\\w+${limit.replace(/\\\.$/, '')}\\.\\$\\w+"`), 'Android says something else at a limit');
  // The model: what it said it was on, or that it did not say.
  const silent = after(turn('model'));
  const named = after(turn('model', { model: 'M0DEL' }));
  const [lead, tail] = [named.slice(0, named.indexOf(': it said ')), named.slice(named.indexOf('M0DEL') + 5)];
  assert.ok(silent.startsWith(lead) && silent.endsWith(tail), 'turnWords words a model that was said differently from one that was not');
  const unsaid = silent.slice(lead.length, silent.length - tail.length);
  for (const [name, src] of BOTH) {
    for (const piece of [lead, unsaid, ': it said ', tail]) assert.ok(src.includes(piece), `${name} lost “${piece}” from the sentence about the model`);
  }
  has(IOS, new RegExp(`case "model":[\\s\\S]{0,160}?\\? "${lit(unsaid)}" : ": it said \\\\\\(\\w+\\)"\\s*return "\\\\\\(\\w+\\)${lit(lead)}\\\\\\(\\w+\\)${lit(tail)}"`), 'iOS says something else when the model was not the one asked for');
  has(ANDROID, new RegExp(`"model" -> \\{[\\s\\S]{0,120}?"${lit(unsaid)}" else ": it said \\$\\w+"\\s*"\\$\\w+${lit(lead)}\\$\\w+${lit(tail)}"`), 'Android says something else when the model was not the one asked for');
  // An error: the engine's own first line after a colon, when it gave one.
  const bare = after(turn('error'));
  assert.equal(after(turn('error', { detail: 'D3TAIL' })), `${bare.slice(0, -1)}: D3TAIL.`);
  has(IOS, new RegExp(`case "error":[\\s\\S]{0,120}?\\? "" : ": \\\\\\(\\w+\\)"\\s*return "\\\\\\(\\w+\\)${lit(bare.slice(0, -1))}\\\\\\(\\w+\\)\\."`), 'iOS says something else when a turn ends on an error');
  has(ANDROID, new RegExp(`"error" -> \\{[\\s\\S]{0,120}?"" else ": \\$\\w+"\\s*"\\$\\w+${lit(bare.slice(0, -1))}\\$\\w+\\."`), 'Android says something else when a turn ends on an error');
  // Every reason the fleet has is one of the ones above, or `done`.
  assert.deepEqual([...TURN_REASONS].sort(), ['auth', 'cancelled', 'cut', 'done', 'error', 'limit', 'model', 'refused']);

  // DONE SAYS NOTHING: a turn that ended is the ordinary case.
  const done = after(turn('done'));
  for (const [name, src] of BOTH) assert.ok(!src.includes(done), `${name} announces a turn that simply ended`);
  has(IOS, /guard let reason, !reason\.isEmpty, reason != "done" else \{ return nil \}/, 'iOS says something for a turn that simply ended');
  has(ANDROID, /if \(reason\.isNullOrEmpty\(\) \|\| reason == "done"\) return null/, 'Android says something for a turn that simply ended');
  // A reason this build never met is shown as itself, not as an error.
  has(IOS, /default:\s*return "\\\(\w+\) stopped: \\\(reason\)\."/, 'iOS does not show a reason it never met as itself');
  has(ANDROID, /else -> "\$\w+ stopped: \$reason\."/, 'Android does not show a reason it never met as itself');
});

test('a move to the next engine is one sentence, and why is in the fleet’s words', () => {
  for (const reason of HANDS_ON) {
    const ios = found(IOS, new RegExp(`case "${reason}": return "([^"\\\\]+)"`), `iOS has no words for a move after ${reason}`);
    const android = found(ANDROID, new RegExp(`"${reason}" -> "([^"$]+)"`), `Android has no words for a move after ${reason}`);
    assert.equal(android, ios, `the phones give different reasons for a move after ${reason}`);
    assert.ok(turnWords(turn(reason)).includes(ios), `“${ios}” is not how the fleet says ${reason}: ${turnWords(turn(reason))}`);
  }
  // "Moved from Claude Code to Codex: stopped at its account’s limit", and
  // one place on each phone composes it.
  has(IOS, /let (\w+) = "Moved from \\\(\w+\(from \?\? ""\)\) to \\\(\w+\(to \?\? ""\)\)"[\s\S]{0,120}?\? \1 : "\\\(\1\): \\\(\w+\)"/, 'iOS does not say a move as a sentence');
  has(ANDROID, /val (\w+) = "Moved from \$\{\w+\(from\.orEmpty\(\)\)\} to \$\{\w+\(to\.orEmpty\(\)\)\}"[\s\S]{0,120}?\1 else "\$\1: \$\w+"/, 'Android does not say a move as a sentence');
  for (const [name, src] of BOTH) assert.equal(count(src, '"Moved from '), 1, `${name} words a move in more than one place`);
});

test('a member’s engines are said in order on its page, as the fleet says a list', () => {
  // "Claude Code, then Codex (gpt-5.1-codex)".
  assert.equal(enginesWords([{ engine: 'claude-code' }, { engine: 'codex', model: 'M0DEL' }]), 'Claude Code, then Codex (M0DEL)');
  has(IOS, /\? \w+\((\w+)\.engine\) : "\\\(\w+\(\1\.engine\)\) \(\\\(\w+\)\)"\s*\}\.joined\(separator: ", then "\)/, 'iOS does not say a list of engines the fleet’s way');
  has(ANDROID, /\.joinToString\(", then "\) \{ (\w+) ->[\s\S]{0,120}?\w+\(\1\.engine\) else "\$\{\w+\(\1\.engine\)\} \(\$\w+\)"/, 'Android does not say a list of engines the fleet’s way');
  // Drawn only for a record that has engines: an older fleet's member is
  // not given a list nobody sent.
  has(IOS, /if !shown\.(\w+)\.isEmpty \{[\s\S]{0,260}?Text\("Engines"\)[\s\S]{0,200}?Text\(\w+\(shown\.\1\)\)/, 'iOS does not show a member’s engines on its page');
  has(ANDROID, /if \(member\.engines\.isNotEmpty\(\)\) MemberFact\("Engines", \w+\(member\.engines\)\)/, 'Android does not show a member’s engines on its page');
});

test('the member form sends engines as a list in its order, and cannot send an empty one or an OpenCode with no model', () => {
  for (const words of [
    'A member has at least one engine.',
    'OpenCode needs a model.',
    'github-copilot/<model>',
    'A session starts on the first of these its machine runs, and moves to the next when one stops at its limit.',
  ]) {
    for (const [name, src] of BOTH) assert.ok(src.includes(words), `${name} lost: ${words}`);
  }
  // What is sent: each engine in the list's order, with its model only
  // when one is named, and nothing at all for a list that may not be sent.
  has(IOS, /guard !(\w+)\.isEmpty else \{ return \(nil, "A member has at least one engine\."\) \}[\s\S]{0,200}?for (\w+) in \1 \{[\s\S]{0,200}?if \2\.engine == "opencode", (\w+)\.isEmpty \{\s*return \(nil, "OpenCode needs a model\."\)\s*\}\s*(\w+)\.append\(\3\.isEmpty \? \["engine": \2\.engine\] : \["engine": \2\.engine, "model": \3\]\)/, 'iOS can send no engines, an OpenCode with no model, or a list out of order');
  has(ANDROID, /if \((\w+)\.isEmpty\(\)\) return \w+\(null, "A member has at least one engine\."\)[\s\S]{0,120}?for \((\w+) in \1\) \{[\s\S]{0,200}?if \(\2\.engine == "opencode" && (\w+)\.isEmpty\(\)\) \{\s*return \w+\(null, "OpenCode needs a model\."\)\s*\}\s*val (\w+) = JSONObject\(\)\.put\("engine", \2\.engine\)\s*if \(\3\.isNotEmpty\(\)\) \4\.put\("model", \3\)\s*\w+\.put\(\4\)/, 'Android can send no engines, an OpenCode with no model, or a list out of order');
  // Save sends that list or nothing, whatever pressed it, and says why.
  has(IOS, /guard let (\w+) = (\w+)\.list else \{\s*result = \2\.problem \?\? "A member has at least one engine\."\s*return\s*\}\s*fields\["engines"\] = \1\n/, 'iOS saves a member without checking its engines');
  has(ANDROID, /val (\w+) = (\w+)\.list\s*when \{[\s\S]{0,900}?\1 == null -> result = \2\.problem \?: "A member has at least one engine\."\s*else -> \{[\s\S]{0,1400}?fields\.put\("engines", \1\)/, 'Android saves a member without checking its engines');
  assert.equal(count(IOS, 'fields["engines"] ='), 1, 'iOS writes a member’s engines from more than one place');
  assert.equal(count(ANDROID, 'fields.put("engines",'), 1, 'Android writes a member’s engines from more than one place');
  // And the button is not offered a list that would be refused here.
  has(IOS, /\.disabled\(busy \|\| name\.isBlank \|\| role\.isBlank \|\| \w+\(engines\)\.list == nil\)/, 'iOS offers Save with an engine list it will not send');
  has(ANDROID, /enabled = !busy && name\.isNotBlank\(\) && role\.isNotBlank\(\) && \w+\(engines\)\.list != null,/, 'Android offers Save with an engine list it will not send');
  // The one model field that could only name Claude Code's model is gone.
  for (const [name, src] of BOTH) {
    assert.doesNotMatch(src, /\["engine": "claude-code"\]|put\("engine", "claude-code"\)/, `${name} still sends Claude Code alone, whatever the member names`);
  }
});

test('the list is reordered with buttons that say what they move, and Add and Remove are drawn only where they do something (C-2)', () => {
  // Up and Down are buttons, each named for the engine it moves, so a
  // keyboard and a switch control can reorder the list.
  has(IOS, /Button\("Up"\) \{ \w+\(\w+, by: -1\) \}\s*\.accessibilityLabel\("Move \\\(\w+\) up"\)\s*\.disabled\(\w+ == 0\)/, 'iOS has no button that moves an engine up, or it does not say which');
  has(IOS, /Button\("Down"\) \{ \w+\(\w+, by: 1\) \}\s*\.accessibilityLabel\("Move \\\(\w+\) down"\)\s*\.disabled\(\w+ == \w+\.count - 1\)/, 'iOS has no button that moves an engine down, or it does not say which');
  has(ANDROID, /enabled = \w+ > 0,\s*onClick = \{ \w+\(\w+\(\w+, (\w+), \1 - 1\)\) \},\s*modifier = [^\n]*contentDescription = "Move \$\w+ up" \},\s*\) \{ Text\("Up"\) \}/, 'Android has no button that moves an engine up, or it does not say which');
  has(ANDROID, /enabled = \w+ < \w+\.size - 1,\s*onClick = \{ \w+\(\w+\(\w+, (\w+), \1 \+ 1\)\) \},\s*modifier = [^\n]*contentDescription = "Move \$\w+ down" \},\s*\) \{ Text\("Down"\) \}/, 'Android has no button that moves an engine down, or it does not say which');
  // Remove is never drawn for the last engine: a member has at least one.
  has(IOS, /if (\w+)\.count > 1 \{[\s\S]{0,900}?Button\("Remove", role: \.destructive\) \{[\s\S]{0,120}?\1\.removeAll \{ \$0\.engine == \w+ \}[\s\S]{0,60}?\}\s*\.accessibilityLabel\("Remove \\\(\w+\)"\)/, 'iOS offers to remove a member’s last engine, or does not say which it removes');
  has(ANDROID, /if \((\w+)\.size > 1\) \{[\s\S]{0,1300}?onClick = \{ \w+\(\1\.filter \{ it\.engine != \w+\.engine \}\) \},\s*modifier = [^\n]*contentDescription = "Remove \$\w+" \},\s*\) \{ Text\("Remove"/, 'Android offers to remove a member’s last engine, or does not say which it removes');
  // Add offers only an engine the list does not name, and none at three.
  has(IOS, /(\w+)\.count >= engineLimit \? \[\] : \w+\.filter \{ (\w+) in !\1\.contains \{ \$0\.engine == \2 \} \}/, 'iOS offers to add an engine the list already has, or a fourth');
  has(IOS, /Button\("Add \\\(\w+\(\w+\)\)"\)/, 'iOS has no way to add an engine');
  has(ANDROID, /if \((\w+)\.size >= ENGINE_LIMIT\) emptyList\(\) else \w+\.filter \{ (\w+) -> \1\.none \{ it\.engine == \2 \} \}/, 'Android offers to add an engine the list already has, or a fourth');
  has(ANDROID, /Text\("Add \$\{\w+\(\w+\)\}"\)/, 'Android has no way to add an engine');
});

test('what an engine runs on is kept by `put` under the vault’s own names and no other, in the vault the screen is pointed at', () => {
  // THE VAULT'S LIST IS THE SCREENS' LIST, name for name and in its order:
  // the two sign-ins, then an API key for each provider (docs/api-engines.md).
  // An item the vault keeps and no screen offers could be kept from nowhere,
  // and one a screen offers that the vault does not keep is refused when it
  // is pasted.
  assert.deepEqual([...ENGINE_ITEM_KINDS], ['codex', 'copilot', ...API_KEY_ITEMS], 'the vault keeps engine items this test has never read about');
  const names = ENGINE_ITEM_KINDS.map((n) => `"${n}"`).join(', ');
  // Those names, and a put that carries one of them and nothing else.
  const iosNames = found(IOS, new RegExp(`let (\\w+) = \\[${names}\\]`), 'iOS does not hold what an engine runs on by the vault’s names');
  const androidNames = found(ANDROID, new RegExp(`val (\\w+) = listOf\\(${names}\\)`), 'Android does not hold what an engine runs on by the vault’s names');
  has(IOS, new RegExp(`guard ${iosNames}\\.contains\\(name\\) else \\{ throw [^\\n]*\\n\\s*guard !value\\.isBlank else \\{ throw [^\\n]*\\n\\s*return try await ask\\(fleet, op: "put", extra: Self\\.aimed\\(\\["name": name, "value": value\\], at: member\\)\\)\\.text`), 'iOS does not keep an engine’s sign-in with put, under its own name, for the vault it was asked for');
  has(ANDROID, new RegExp(`require\\(name in ${androidNames}\\) [^\\n]*\\n\\s*require\\(value\\.isNotBlank\\(\\)\\) [^\\n]*\\n\\s*ask\\(fleet, "put", aimed\\(JSONObject\\(\\)\\.put\\("name", name\\)\\.put\\("value", value\\), member\\)\\)\\.first`), 'Android does not keep an engine’s sign-in with put, under its own name, for the vault it was asked for');
  // The row sends what was pasted for the vault on screen: a member's, when
  // the screen is pointed at one.
  has(IOS, /result = try await vault\.\w+\(fleet, name: name, value: \w+, for: whose\)/, 'iOS keeps an engine’s sign-in in a vault other than the one on screen');
  has(ANDROID, /val r = vault\.\w+\(Fleet\(settings\), name, \w+, whose\)/, 'Android keeps an engine’s sign-in in a vault other than the one on screen');
  // The signing page: the same put, from the row's own name.
  has(PAGE, /change\(r, 'Keeping it\.', function \(\) \{ return vaultAsk\('put', \{ name: name, value: v \}\)/, 'the signing page does not keep an engine’s sign-in with put');
  // Forget is the vault's own forget, behind the question every item has.
  has(IOS, /forget: \{ forgetting = name \}/, 'iOS forgets an engine’s sign-in without asking');
  has(ANDROID, /forget = \{ forgetting = name \},/, 'Android forgets an engine’s sign-in without asking');
});

test('the two rows are offered only where an engine runs on them, or one is already kept and can be forgotten (C-2)', async () => {
  // Asked of the engine and its model together, since an OpenCode's model
  // says which item it runs on (test/api-engines-in-apps.test.js).
  has(IOS, /\w+\.filter \{ (\w+) in\s*kept\.contains\(\1\) \|\| engines\.contains \{ \w+\(for: \$0\) == \1 \}\s*\}/, 'iOS offers an engine’s sign-in to a member with no such engine, or hides a kept one');
  has(ANDROID, /\w+\.filter \{ (\w+) -> \1 in kept \|\| engines\.any \{ \w+\(it\) == \1 \} \}/, 'Android offers an engine’s sign-in to a member with no such engine, or hides a kept one');
  // The rows are drawn from that answer and from nowhere else, and the two
  // items are not also drawn in the list of everything kept.
  has(IOS, /ForEach\(\w+\(engines: \w+, kept: kept\.items\.map\(\\\.name\)\), id: \\\.self\) \{ name in\s*(\w+)\(\s*name: name,/, 'iOS draws an engine’s row without asking whether it is offered');
  has(ANDROID, /\w+\(\w+, kept\.items\.map \{ it\.name \}\)\.forEach \{ name ->\s*(\w+)\(\s*name = name,/, 'Android draws an engine’s row without asking whether it is offered');
  has(IOS, /ForEach\(kept\.items\.filter \{ !\w+\.contains\(\$0\.name\) \}, id: \\\.name\)/, 'iOS draws an engine’s sign-in twice');
  has(ANDROID, /kept\.items\.filter \{ it\.name !in \w+ \}\.forEach \{ item ->/, 'Android draws an engine’s sign-in twice');
  // Whose engines: the member the screen is pointed at, or the person's own.
  has(IOS, /member\?\.\w+ \?\? ownEngines/, 'iOS does not read the engines of the member whose vault this is');
  has(ANDROID, /member\?\.engines \?: ownEngines/, 'Android does not read the engines of the member whose vault this is');

  // THE SIGNING PAGE'S OWN RULE, run and not read: it is plain JavaScript.
  const page = await signerRoutes({ method: 'GET', path: '/' }, /** @type {any} */ ({ fleetOrigin: 'https://fleet.test', clientId: 'Iv23liTEST' }));
  const ctx = vm.createContext({ crypto: globalThis.crypto, TextEncoder, TextDecoder, btoa, atob });
  vm.runInContext(String(page?.body).split('<script>')[1].split('</script>')[0], ctx);
  const S = /** @type {any} */ (ctx).SIGNER;
  for (const [id, engine] of Object.entries(ENGINES)) {
    if (id !== DEFAULT_ENGINE) assert.equal(S.ENGINE_ITEM_OF[id], engine.credential, `the signing page keeps ${id}’s sign-in under another name`);
  }
  const offered = (/** @type {string[]} */ engines, /** @type {string[]} */ kept) => [...S.engineItems(engines, kept)];
  assert.deepEqual(offered(['claude-code'], ['claude', 'github']), [], 'a member on Claude Code alone is offered neither');
  assert.deepEqual(offered(['claude-code', 'codex'], []), ['codex']);
  assert.deepEqual(offered(['opencode'], []), ['copilot']);
  assert.deepEqual(offered(['claude-code'], ['copilot']), ['copilot'], 'a kept one can be forgotten whatever the member runs on now');
  assert.deepEqual(offered(['constructor', 'toString'], []), [], 'an engine the page never met offers nothing');
  assert.deepEqual(offered(/** @type {any} */ (undefined), /** @type {any} */ (null)), []);
  // And it draws its rows from that answer, for the vault it is showing.
  has(PAGE, /S\.engineItems\(enginesShown\(\), \(\(vault && vault\.items\) \|\| \[\]\)\.map\(function \(x\) \{ return x\.name; \}\)\)\.forEach\(function \(name\) \{\s*box\.appendChild\(engineRow\(name\)\);/, 'the signing page draws an engine’s row without asking whether it is offered');
  has(PAGE, /var id = view \? view\.id : ownMember\(\);\s*return \(id && runsOn && runsOn\[id\]\) \|\| \[\];/, 'the signing page does not read the engines of the member whose vault it shows');
});

test('the rows say the same on both phones and the signing page: kept or not, which machine holds a Codex sign-in, and that a paste is a copy', async () => {
  for (const words of [
    'Codex sign-in',
    'GitHub Copilot token',
    'Not handed to a machine yet',
    'Goes to one machine. Pasting it again moves it.',
    'Paste the whole of ~/.codex/auth.json, the file codex login leaves.',
    'What you paste is a copy. Whichever of the two renews first ends the other.',
    'Paste one GitHub Copilot token. OpenCode runs on it.',
    'Replace it',
  ]) {
    for (const [name, src] of [...BOTH, /** @type {const} */ (['the signing page', PAGE])]) assert.ok(src.includes(words), `${name} lost: ${words}`);
  }
  // Kept, and Keep or Replace by which it is.
  has(IOS, /Text\((\w+) == nil \? "Not kept" : "Kept"\)[\s\S]{0,160}?Button\(\1 == nil \? "Keep" : "Replace"\)/, 'iOS does not say whether an engine’s sign-in is kept');
  has(ANDROID, /Text\(if \((\w+) == null\) "Not kept" else "Kept",[\s\S]{0,420}?\{ Text\(if \(\1 == null\) "Keep" else "Replace"\) \}/, 'Android does not say whether an engine’s sign-in is kept');
  has(PAGE, /var state = !x \? 'Not kept\.' : 'Kept'[^\n]*\n[\s\S]{0,400}?button\(r\.actions, x \? 'Replace' : 'Keep',/, 'the signing page does not say whether an engine’s sign-in is kept');
  // Since when, on the same line as where a Codex sign-in is held.
  has(IOS, /\w+\(item\.at\)\.map \{ "Since \\\(\$0\)" \}/, 'iOS does not say since when an engine’s sign-in has been kept');
  has(ANDROID, /\w+\(item\.at\)\?\.let \{ "Since \$it" \}/, 'Android does not say since when an engine’s sign-in has been kept');
  has(PAGE, /'Kept' \+ \(when \? ' since ' \+ when\.toLocaleString/, 'the signing page does not say since when an engine’s sign-in has been kept');

  // HELD BY: read off the vault's answer and said, and a kept one no
  // machine has asked for says that and never names one.
  has(IOS, /heldBy: \$0\["heldBy"\] as\? String/, 'iOS does not read which machine holds a Codex sign-in');
  has(ANDROID, /\w+\(it, "heldBy"\)/, 'Android does not read which machine holds a Codex sign-in');
  has(IOS, /guard let (\w+), !\1\.isEmpty else \{ return "Not handed to a machine yet" \}\s*return "Held by \\\(\1\)"/, 'iOS does not say which machine holds a Codex sign-in');
  has(ANDROID, /if \((\w+)\.isNullOrEmpty\(\)\) "Not handed to a machine yet" else "Held by \$\1"/, 'Android does not say which machine holds a Codex sign-in');
  has(IOS, /name == "codex" \? \w+\(item\.heldBy\) : nil/, 'iOS says a Copilot token is held by a machine, or not that a Codex sign-in is');
  has(ANDROID, /if \(name == "codex"\) \w+\(item\.heldBy\) else null/, 'Android says a Copilot token is held by a machine, or not that a Codex sign-in is');
  const page = await signerRoutes({ method: 'GET', path: '/' }, /** @type {any} */ ({ fleetOrigin: 'https://fleet.test', clientId: 'Iv23liTEST' }));
  const ctx = vm.createContext({ crypto: globalThis.crypto, TextEncoder, TextDecoder, btoa, atob });
  vm.runInContext(String(page?.body).split('<script>')[1].split('</script>')[0], ctx);
  const S = /** @type {any} */ (ctx).SIGNER;
  assert.equal(S.heldLine('deb132'), 'Held by deb132');
  assert.equal(S.heldLine(undefined), 'Not handed to a machine yet');
  assert.equal(S.itemLabel('codex'), 'Codex sign-in');
  assert.equal(S.itemLabel('copilot'), 'GitHub Copilot token');
  has(PAGE, /if \(x && codex\) state \+= ' ' \+ S\.heldLine\(x\.heldBy\) \+ '\.';/, 'the signing page does not say which machine holds a Codex sign-in');
});

test('what is pasted is never shown again, and a kept sign-in is never said to work', () => {
  // The field is emptied once the vault took it, and when the row leaves
  // the screen. On Android it is also kept out of the screen's saved state.
  // (Whatever the field's text is called: its name is read off the one
  // place that sends it, and the other two rules are about that name.)
  const iosField = found(IOS, /if await \w+\((\w+)\) \{\s*\1 = ""/, 'iOS leaves a pasted sign-in in the field after it was kept');
  has(IOS, new RegExp(`\\.onDisappear \\{ ${iosField} = "" \\}`), 'iOS leaves a pasted sign-in in the field when the screen is left');
  const androidField = found(ANDROID, /if \(\w+\((\w+)\)\) \{\s*\1 = ""/, 'Android leaves a pasted sign-in in the field after it was kept');
  has(ANDROID, new RegExp(`DisposableEffect\\(Unit\\) \\{ onDispose \\{ ${androidField} = "" \\} \\}`), 'Android leaves a pasted sign-in in the field when the screen is left');
  has(ANDROID, new RegExp(`var ${androidField} by remember \\{ mutableStateOf\\(""\\) \\}`), 'Android may write a pasted sign-in into the screen’s saved state');
  has(PAGE, /var v = value\.value;\s*value\.value = '';\s*if \(!v\.trim\(\)\) \{ note\(r, 'Nothing to keep yet\.', true\); return; \}\s*change\(r, 'Keeping it\.'/, 'the signing page leaves a pasted sign-in in the field');
  // A Copilot token is typed into a field that hides it.
  has(IOS, /SecureField\("GitHub Copilot token", text: \$\w+\)/, 'iOS shows a Copilot token as it is typed');
  has(ANDROID, /label = \{ Text\("GitHub Copilot token"\) \},\s*singleLine = true,\s*visualTransformation = PasswordVisualTransformation\(\),/, 'Android shows a Copilot token as it is typed');
  has(PAGE, /codex \? area\('The auth\.json file'\) : field\('The GitHub Copilot token', 'password'\)/, 'the signing page shows a Copilot token as it is typed');

  // NO TEST, SO NO "WORKS". The vault does not try these, and both phones
  // draw anything short of accepted as a failure: so the button is not
  // offered, and a kept sign-in is said to be kept and nothing more.
  has(IOS, /static func isTestable\(_ name: String\) -> Bool \{\s*\["claude", "github", "cloudflare"\]\.contains\(name\)\s*\}/, 'iOS offers Test for something the vault does not try');
  has(ANDROID, /fun isTestable\(name: String\): Boolean = name in setOf\("claude", "github", "cloudflare"\)/, 'Android offers Test for something the vault does not try');
  const row = found(PAGE, /function engineRow\(name\) \{([\s\S]*?)\n {2}\}\n/, 'the signing page has no row for an engine’s sign-in');
  assert.ok(!row.includes('testButton('), 'the signing page offers Test for something the vault does not try');
});

test('a session whose machine named no engines shows no engine line, and one that did says which it is on', () => {
  // Read as absent when it is absent: no list is not a list of one.
  has(IOS, /let engines: \[Engine\]\?\n\s*let engineAt: Int\?\n\s*let engineLog: \[EngineMove\]\?\n\s*let turn: Turn\?/, 'iOS does not read a session’s engines as optional');
  has(IOS, /let (\w+) = \(engines \?\? \[\]\)\.compactMap \{[\s\S]{0,260}?\}\s*return \1\.isEmpty \? nil : \1\n/, 'iOS reads a session that named no engines as having some');
  has(ANDROID, /engines = \w+\(o\.optJSONArray\("engines"\)\)\.takeIf \{ it\.isNotEmpty\(\) \},/, 'Android reads a session that named no engines as having some');
  has(ANDROID, /engineAt = if \(o\.has\("engineAt"\) && !o\.isNull\("engineAt"\)\) o\.optInt\("engineAt", -1\)\.takeIf \{ it >= 0 \} else null,/, 'Android reads a missing `engineAt` as the first engine');
  // The section is drawn under that condition and nowhere else.
  has(IOS, /if session\.\w+ != nil \{\s*Section \{\s*\w+\(session: session\)\s*\} header: \{\s*sectionHead\("Engine"\)/, 'iOS draws the Engine section for a session that named no engines');
  has(IOS, /var body: some View \{\s*if let (\w+) = session\.\w+ \{\s*if let \w+ = \w+\(\1, at: session\.engineAt\)/, 'iOS draws an engine line for a session that named no engines');
  has(ANDROID, /val (\w+) = session\.engines\?\.takeIf \{ it\.isNotEmpty\(\) \} \?: return\s*Text\("Engine", style = Design\.Style\.section,[^\n]*\n\s*\w+\(\1, session\.engineAt\)\?\.let/, 'Android draws an engine line for a session that named no engines');
  for (const [name, src] of BOTH) assert.equal(count(src, '("Engine"'), 1, `${name} draws the Engine heading somewhere its condition does not cover`);

  // "On Codex (2 of 3)", and nothing when the machine named an engine that
  // is not in the list.
  has(IOS, /guard let (\w+), (\w+)\.indices\.contains\(\1\) else \{ return nil \}[\s\S]{0,80}?\2\.count > 1 \? "On \\\((\w+)\) \(\\\(\1 \+ 1\) of \\\(\2\.count\)\)" : "On \\\(\3\)"/, 'iOS does not say which of its engines a session is on');
  has(ANDROID, /if \((\w+) == null\) return null\s*val \w+ = (\w+)\.getOrNull\(\1\) \?: return null[\s\S]{0,80}?if \(\2\.size > 1\) "On \$(\w+) \(\$\{\1 \+ 1\} of \$\{\2\.size\}\)" else "On \$\3"/, 'Android does not say which of its engines a session is on');
  // Each move with its time, and how the last turn ended, from what the
  // machine sent and nothing else.
  has(IOS, /Text\(\w+\(from: (\w+)\[(\w+)\]\.from, to: \1\[\2\]\.to, reason: \1\[\2\]\.reason\)\)[\s\S]{0,260}?if let \w+ = \w+\(\1\[\2\]\.at\)/, 'iOS does not say each move with its time');
  has(ANDROID, /session\.engineLog\.forEach \{ (\w+) ->\s*Column \{\s*Text\(\w+\(\1\.from, \1\.to, \1\.reason\),[^\n]*\n\s*\w+\(\1\.at\)\?\.let/, 'Android does not say each move with its time');
  has(IOS, /if let (\w+) = session\.turn,\s*let \w+ = \w+\(engine: \1\.engine, reason: \1\.reason, detail: \1\.detail, model: \1\.model, resetsAt: \1\.resetsAt\)/, 'iOS does not say how a session’s last turn ended');
  has(ANDROID, /session\.turn\?\.let \{ (\w+) ->\s*\w+\(\1\.engine, \1\.reason, \1\.detail, \1\.model, \1\.resetsAt\)\?\.let/, 'Android does not say how a session’s last turn ended');

  // ON ITS ROW, the engine's name only when it is not Claude Code: every
  // row would otherwise say the same thing and mean nothing.
  has(IOS, new RegExp(`return (\\w+) == ${IOS_DEFAULT} \\? nil : \\w+\\(\\1\\)\\n`), 'iOS puts Claude Code on every session’s row');
  has(ANDROID, new RegExp(`return if \\((\\w+) == ${ANDROID_DEFAULT}\\) null else \\w+\\(\\1\\)\\n`), 'Android puts Claude Code on every session’s row');
  has(IOS, /if let (\w+) = session\.\w+ \{ Text\("· \\\(\1\)"\) \}\n\s*\/\/ How full its window is/, 'iOS does not say a session’s engine on its row');
  has(ANDROID, /session\.asMember \?: session\.account\?\.takeIf \{ it != "shared" \},[\s\S]{0,220}?session\.\w+,\s*session\.contextLine,/, 'Android does not say a session’s engine on its row');
});

test('a move to another engine has a label in Recent activity, the same on both phones', () => {
  // `session.engine` comes from a machine, not from the coordinator's own
  // `record({`, so test/reasons-in-apps.test.js does not see it missing.
  const ios = found(IOS, /static let activity: \[String: String\] = \[[\s\S]*?"session\.engine": "([^"]+)",[\s\S]*?\n {4}\]/, 'iOS has no label for a move to another engine');
  const android = found(ANDROID, /val ACTIVITY: Map<String, String> = mapOf\([\s\S]*?"session\.engine" to "([^"]+)",[\s\S]*?\n {4}\)/, 'Android has no label for a move to another engine');
  assert.equal(ios, 'Moved to another engine');
  assert.equal(android, ios);
});

test('a task’s page says an engine handoff as a sentence, and why its session stopped, under the lock', () => {
  // The handoff: `from` and `to` are engines here and the note is why.
  has(IOS, /case "engine": return \w+\(from: handoff\.from, to: handoff\.to, reason: handoff\.note\)/, 'iOS shows an engine handoff as the bare word “engine”');
  has(ANDROID, /"engine" -> \w+\(handoff\.from, handoff\.to, handoff\.note\)/, 'Android shows an engine handoff as the bare word “engine”');
  // Why it stopped: read off the lock, absent when the fleet sent none, and
  // said in the sentences a turn's ending is said in.
  has(IOS, /let stopped: Stopped\?\n/, 'iOS does not read why a task’s session stopped');
  has(ANDROID, /stopped = l\.optJSONObject\("stopped"\)\?\.let \{/, 'Android does not read why a task’s session stopped');
  const iosTurn = found(IOS, /func (\w+)\(engine: String\?, reason: String\?, detail: String\? = nil, model: String\? = nil, resetsAt: Double\? = nil\) -> String\? \{/, 'iOS has no one place that says how a turn ended');
  const androidTurn = found(ANDROID, /fun (\w+)\(engine: String\?, reason: String\?, detail: String\? = null, model: String\? = null, resetsAt: Long\? = null\): String\? \{/, 'Android has no one place that says how a turn ended');
  has(IOS, new RegExp(`if let (\\w+) = lock\\.stopped,\\s*let \\w+ = ${iosTurn}\\(engine: \\1\\.engine, reason: \\1\\.reason, resetsAt: \\1\\.resetsAt\\) \\{`), 'iOS does not say why a task’s session stopped');
  has(ANDROID, new RegExp(`lock\\.stopped\\?\\.let \\{ (\\w+) ->\\s*${androidTurn}\\(\\1\\.engine, \\1\\.reason, resetsAt = \\1\\.resetsAt\\)\\?\\.let`), 'Android does not say why a task’s session stopped');
});

test('a machine’s page says what it runs, and a machine that reported nothing is not called Claude Code (C-5)', () => {
  // A machine that sends no engines is from before them and runs the
  // default alone, as the fleet reads it too.
  assert.deepEqual(enginesOn([{ engine: 'codex' }], undefined).runs, [DEFAULT_ENGINE]);
  has(IOS, new RegExp(`var (\\w+) = \\[${IOS_DEFAULT}\\]\\s*for (\\w+) in \\w+ \\?\\? \\[\\] where !\\2\\.isEmpty && !\\1\\.contains\\(\\2\\) \\{ \\1\\.append\\(\\2\\) \\}`), 'iOS does not put Claude Code first among what a machine runs');
  has(ANDROID, new RegExp(`val (\\w+) = mutableListOf\\(${ANDROID_DEFAULT}\\)\\s*for \\((\\w+) in \\w+\\.orEmpty\\(\\)\\) \\{\\s*if \\(\\2\\.isNotEmpty\\(\\) && \\2 !in \\1\\) \\1\\.add\\(\\2\\)`), 'Android does not put Claude Code first among what a machine runs');
  // "Runs: Claude Code, Codex", and no line at all with no report.
  has(IOS, /guard let (\w+) else \{ return nil \}\s*return "Runs: " \+ \w+\(\1\.engines\)\.map\(\w+\)\.joined\(separator: ", "\)/, 'iOS says what a machine runs without a report from it');
  has(ANDROID, /val (\w+) = host\.engines \?: return null\s*return "Runs: " \+ \w+\(\1\)\.joinToString\(", "\) \{ \w+\(it\) \}/, 'Android says what a machine runs without a report from it');
  // On Android the list is null only when the machine reported nothing: a
  // report with no list in it is the empty list, which is Claude Code alone.
  has(ANDROID, /engines = health\?\.let \{ (\w+) ->\s*\1\.optJSONArray\("engines"\)\?\.let \{[\s\S]{0,200}?\} \?: emptyList\(\)\s*\},/, 'Android cannot tell a machine from before engines from one that reported nothing');
  has(IOS, /var engines: \[String\]\? = nil\n/, 'iOS does not read what a machine runs');
  // And the page draws it.
  has(IOS, /if let (\w+) = \w+\(health\) \{\s*Text\(\1\)\.fleetType\(\.label\)/, 'iOS never draws what a machine runs');
  has(ANDROID, /h\?\.let \{ \w+\(it\) \}\?\.let \{ Hint\(it\) \}/, 'Android never draws what a machine runs');
});

test('New session says which engines a member will have on the chosen machine, before it is sent', () => {
  // The two sentences, whole: the engines it will have there, or that it
  // will have none.
  has(IOS, /return "\\\(\w+\.hostId\) does not run \\\(\w+\(\w+\.engine\)\)\. A session as \\\(\w+\.name\) there runs on \\\(\w+\(\w+\)\)\."/, 'iOS does not say which engines a session as the member will have on that machine');
  has(ANDROID, /return "\$\{\w+\.hostId\} does not run \$\{\w+\(\w+\.engine\)\}\. A session as \$\{\w+\.name\} there runs on \$\{\w+\(\w+\)\}\."/, 'Android does not say which engines a session as the member will have on that machine');
  has(IOS, /return "\\\(\w+\.hostId\) runs \\\(\w+\)\. \\\(\w+\.name\) has \\\(\w+\(\w+\)\), so a session there has no engine to run on\."/, 'iOS does not say that a session as the member has no engine on that machine');
  has(ANDROID, /return "\$\{\w+\.hostId\} runs \$\w+\. \$\{\w+\.name\} has \$\{\w+\(\w+\)\}, so a session there has no engine to run on\."/, 'Android does not say that a session as the member has no engine on that machine');
  // Nothing is said when the member's first engine runs there, and nothing
  // about a machine that has reported nothing.
  has(IOS, /guard let \w+ = host\.health else \{ return nil \}[\s\S]{0,200}?guard !(\w+)\.contains\((\w+)\.engine\) else \{ return nil \}\s*let (\w+) = \w+\.filter \{ \1\.contains\(\$0\.engine\) \}\s*if \3\.isEmpty \{/, 'iOS warns about a machine that runs the member’s first engine, or judges one that reported nothing');
  has(ANDROID, /val \w+ = host\.engines \?: return null[\s\S]{0,200}?if \((\w+)\.engine in (\w+)\) return null\s*val (\w+) = \w+\.filter \{ it\.engine in \2 \}\s*if \(\3\.isEmpty\(\)\) \{/, 'Android warns about a machine that runs the member’s first engine, or judges one that reported nothing');
  // Said under As, for the machine chosen under Where.
  has(IOS, /if let (\w+) = offeredHosts\.first\(where: \{ \$0\.hostId == host \}\),\s*let (\w+) = \w+\(member: \w+, host: \1\) \{\s*Text\(\2\)/, 'iOS does not say it under As for the machine that was chosen');
  has(ANDROID, /offeredHosts\.firstOrNull \{ it\.hostId == host \}\?\.let \{ (\w+) -> \w+\(\w+, \1\) \}\?\.let \{ (\w+) ->\s*Text\(\2,/, 'Android does not say it under As for the machine that was chosen');
});

test('a pasted auth.json is hidden on both phones until Show is pressed, and says how much arrived', () => {
  // THE FILE HOLDS A REFRESH TOKEN, and its field showed all of it in plain
  // letters for as long as the page was open, beside a key and a token that
  // were always hidden. What stands in its place is the same on both phones.
  for (const words of ['Pasted and hidden: ', ' characters.', 'Show the pasted file', 'Hide the pasted file', 'Clear the pasted file']) {
    for (const [name, src] of BOTH) assert.ok(src.includes(words), `${name} lost: ${words}`);
  }
  // The field is drawn while there is nothing in it, or once Show said so.
  // Otherwise the count is, and never the text.
  has(IOS, /if \w+\.isEmpty \|\| (\w+) \{\s*TextField\("auth\.json", text: \$(\w+), axis: \.vertical\)[\s\S]{0,360}?\} else \{\s*Text\(\w+\(\2\.count\)\)/, 'iOS shows a pasted auth.json without being asked');
  has(ANDROID, /if \((\w+)\.isEmpty\(\) \|\| (\w+)\) \{\s*OutlinedTextField\(\s*value = \1,[\s\S]{0,600}?\} else \{\s*Text\(\w+\(\1\.length\),/, 'Android shows a pasted auth.json without being asked');
  // Hidden is where it starts, and where it goes back to when the field is
  // emptied: Clear, the vault taking it, and leaving the page.
  const iosShown = /if \w+\.isEmpty \|\| (\w+) \{\s*TextField\("auth\.json"/.exec(IOS)?.[1];
  const androidShown = /if \(\w+\.isEmpty\(\) \|\| (\w+)\) \{\s*OutlinedTextField\(\s*value = /.exec(ANDROID)?.[1];
  has(IOS, new RegExp(`@State private var ${iosShown} = false`), 'iOS starts with a pasted file shown');
  has(ANDROID, new RegExp(`var ${androidShown} by remember \\{ mutableStateOf\\(false\\) \\}`), 'Android starts with a pasted file shown');
  has(IOS, new RegExp(`Button\\("Clear"\\) \\{\\s*\\w+ = ""\\s*${iosShown} = false\\s*\\}`), 'iOS leaves the next paste shown after Clear');
  has(ANDROID, new RegExp(`onClick = \\{\\s*\\w+ = ""\\s*${androidShown} = false\\s*\\},[\\s\\S]{0,200}?\\{ Text\\("Clear"\\) \\}`), 'Android leaves the next paste shown after Clear');
});
