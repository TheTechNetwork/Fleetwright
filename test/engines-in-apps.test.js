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
//   5. AN ENGINE IS SIGNED IN ON A MACHINE, AND ITS CODE IS SHOWN ONLY ONCE
//      IT IS CHECKED (docs/engines.md, "Signing in on the machine"). The
//      answer comes through the fleet, sealed to this phone and signed by
//      the machine. A phone that showed the code before checking whose key
//      signed it would show whatever the fleet put there, so the order of
//      the checks is held here, and so is where the button is offered and
//      every sentence a person reads on the way.
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
  // (Between the question and the row is the sign-in on a machine, for the
  // two items an engine signs in itself: the test further down.)
  has(IOS, /ForEach\(\w+\(engines: \w+, kept: kept\.items\.map\(\\\.name\)\), id: \\\.self\) \{ name in\s[\s\S]{0,1200}?\b(\w+)\(\s*name: name,/, 'iOS draws an engine’s row without asking whether it is offered');
  has(ANDROID, /\w+\(\w+, kept\.items\.map \{ it\.name \}\)\.forEach \{ name ->\s[\s\S]{0,2400}?\b(\w+)\(\s*name = name,/, 'Android draws an engine’s row without asking whether it is offered');
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
  // Kept, and Keep or Replace by which it is: an API key's row, which is
  // pasted and nothing else. A sign-in's says whether one was pasted, and
  // its paste field is behind the fallback's own button (further down).
  has(IOS, /Text\((\w+) == nil \? "Not kept" : "Kept"\)[\s\S]{0,160}?Button\(\1 == nil \? "Keep" : "Replace"\)/, 'iOS does not say whether an engine’s key is kept');
  has(ANDROID, /Text\(if \((\w+) == null\) "Not kept" else "Kept",[\s\S]{0,420}?\{ Text\(if \(\1 == null\) "Keep" else "Replace"\) \}/, 'Android does not say whether an engine’s key is kept');
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
  has(IOS, /if \w+\.isEmpty \|\| (\w+) \{\s*(?:\/\/[^\n]*\n\s*)*TextField\("auth\.json", text: Binding\(get: \{ (\w+) \},[\s\S]{0,700}?\} else \{\s*Text\(\w+\(\2\.count\)\)/, 'iOS shows a pasted auth.json without being asked');
  has(ANDROID, /if \((\w+)\.isEmpty\(\) \|\| (\w+)\) \{\s*OutlinedTextField\(\s*value = \1,[\s\S]{0,1200}?\} else \{\s*Text\(\w+\(\1\.length\),/, 'Android shows a pasted auth.json without being asked');
  // Hidden is where it starts, and where it goes back to when the field is
  // emptied: Clear, the vault taking it, and leaving the page.
  const iosShown = /if \w+\.isEmpty \|\| (\w+) \{\s*(?:\/\/[^\n]*\n\s*)*TextField\("auth\.json"/.exec(IOS)?.[1];
  const androidShown = /if \(\w+\.isEmpty\(\) \|\| (\w+)\) \{\s*OutlinedTextField\(\s*value = /.exec(ANDROID)?.[1];
  has(IOS, new RegExp(`@State private var ${iosShown} = false`), 'iOS starts with a pasted file shown');
  has(ANDROID, new RegExp(`var ${androidShown} by remember \\{ mutableStateOf\\(false\\) \\}`), 'Android starts with a pasted file shown');
  has(IOS, new RegExp(`Button\\("Clear"\\) \\{\\s*\\w+ = ""\\s*${iosShown} = false\\s*\\}`), 'iOS leaves the next paste shown after Clear');
  has(ANDROID, new RegExp(`onClick = \\{\\s*\\w+ = ""\\s*${androidShown} = false\\s*\\},[\\s\\S]{0,200}?\\{ Text\\("Clear"\\) \\}`), 'Android leaves the next paste shown after Clear');
});

test('a pasted key or token is kept without the space a paste brings, on both phones, and the auth.json file whole', () => {
  // Android's two fields drop it as it is typed. iOS sent what was in the
  // field, so a key pasted with a newline after it was kept as that.
  has(IOS, /if name != "codex" \{ (\w+) = \1\.trimmingCharacters\(in: \.whitespacesAndNewlines\) \}\s*if await keep\(\1\)/, 'iOS keeps a pasted key or token with the space around it');
  has(ANDROID, /onValueChange = \{ \w+ = it\.trim\(\) \},\s*label = \{ Text\("GitHub Copilot token"\) \}/, 'Android keeps a pasted Copilot token with the space around it');
  has(ANDROID, /onValueChange = \{ \w+ = it\.trim\(\) \},\s*label = \{ Text\("\$\{\w+\.\w+\} API key"\) \},\s*singleLine = true,\s*visualTransformation/, 'Android keeps a pasted API key with the space around it');
  // The file is JSON, and is sent as it was pasted.
  has(ANDROID, /onValueChange = \{ typed ->\s*if \(\w+\.isEmpty\(\) && typed\.length == 1\) \w+ = true\s*(\w+) = typed\s*\},\s*label = \{ Text\("auth\.json"\) \}/, 'Android changes a pasted auth.json before it is kept');
  // TYPING IS NOT PASTING: one character typed into an empty field is shown,
  // so the field does not vanish under a thumb, and one character is said
  // as one.
  has(IOS, /set: \{ typed in\s*if \w+\.isEmpty, typed\.count == 1 \{ \w+ = true \}\s*\w+ = typed\s*\}/, 'iOS hides the auth.json field at the first character typed');
  for (const [name, src] of BOTH) assert.ok(src.includes('"Pasted and hidden: 1 character."'), `${name} says “1 characters”`);
});

// ---- signing an engine in on a machine --------------------------------------

test('approving a machine from a member’s Credentials is known to the page when the person is back on it', () => {
  // THE PAGE SAYS "Approve it below, then sign in." On Android the approval
  // is a sheet over the page, which never leaves the screen, and closing it
  // asked the vault nothing: the page went on saying "not approved" and
  // never drew Sign in on a machine. On iOS the page under a pushed one is
  // a list whose rows need not appear again. Both now ask the vault again
  // as the approval is left.
  has(ANDROID, /FullScreen\(\s*title = opened\.hostId,\s*onDismiss = \{\s*approving = null\s*scope\.launch \{ reload\(\) \}\s*\},\s*\) \{\s*VaultApproval\(/, 'Android closes a member’s machine approval without asking the vault again');
  has(IOS, /VaultApproval\(settings: settings, host: box, member: member\)[\s\S]{0,900}?\.onDisappear \{ Task \{ await reload\(\) \} \}/, 'iOS comes back from a member’s machine approval without asking the vault again');
});

test('on Android each engine item’s rows are keyed by its name, so what one remembers never moves to another', () => {
  // WHAT A ROW REMEMBERS FOLLOWS ITS PLACE IN A LOOP unless it is keyed. A
  // person's own list grows from the front when their engines arrive after
  // what is kept, and the block headed Codex then showed what OpenCode's
  // had been told. iOS's ForEach has always named each row by its item.
  has(ANDROID, /\.forEach \{ name ->\s*(?:\/\/[^\n]*\n\s*)*key\(name\) \{[\s\S]{0,1600}?EngineMachineSignIn\([\s\S]{0,900}?EngineSignInRow\(/, 'Android draws an engine item’s rows without a key of their own');
  has(IOS, /ForEach\(\w+\(engines: \w+, kept: kept\.items\.map\(\\\.name\)\), id: \\\.self\) \{ name in/, 'iOS draws an engine item’s rows without naming each by its item');
});

/** What a machine's answer to a sign-in is sealed under, signed over and named by: made by the machine's own code, and checked against it by test/engine-signin-answer.test.js where that code is. */
const ANSWER = JSON.parse(readFileSync(new URL('./fixtures/parity/engine-signin-answer.json', import.meta.url), 'utf8'));

/**
 * A sentence with its moving parts as `{}`, as a regex for one phone: Swift
 * writes a moving part `\(name)`, Kotlin `$name` or `${name}`. What is held
 * is every word around them. @param {string} template @param {'iOS'|'Android'} phone
 */
const sentence = (template, phone) =>
  new RegExp(`"${template.split('{}').map(lit).join(phone === 'iOS' ? '\\\\\\(\\w+\\)' : '\\$\\{?\\w+\\}?')}"`);
/** That both phones say a sentence, word for word. @param {string} template */
const bothSay = (template) => {
  for (const [name, src] of BOTH) has(src, sentence(template, name), `${name} does not say: ${template}`);
};
/** One function's source: from its opening to the brace that closes it at its own indent. @param {string} src @param {string} opens @param {string} what */
const fn = (src, opens, what) => {
  const at = src.indexOf(opens);
  assert.ok(at >= 0, `${what}\n  looked for ${opens}`);
  const indent = /[ \t]*$/.exec(src.slice(0, at))?.[0] ?? '';
  const end = src.indexOf(`\n${indent}}\n`, at);
  assert.ok(end > at, `${what}: its end was not found`);
  return src.slice(at, end);
};
/** Where a step is in a function, or a failure naming the step. @param {string} body @param {RegExp} re @param {string} what */
const step = (body, re, what) => {
  const m = re.exec(body);
  assert.ok(m, `${what}\n  looked for ${re}`);
  return m.index;
};

test('the code, its page and who is signed in are read out of an answer only after it is opened, its key is held to the member’s approved machines, and its signature checks', () => {
  // THE ONE WAY IN. Each phone has one function that turns a sealed answer
  // into something a screen may show, and the order inside it is the whole
  // of the protection: a phone that read the code first and checked after
  // would draw whatever the fleet between sealed to it.
  const ios = fn(IOS, 'static func verified(', 'iOS has no one place a sign-in’s answer is checked');
  const android = fn(ANDROID, 'fun verified(', 'Android has no one place a sign-in’s answer is checked');
  for (const [name, body, opened, approved, signed] of /** @type {const} */ ([
    ['iOS', ios, /Seal\.open\(\w+, aad: Seal\.(\w+), sealed: \w+\)/, /PhoneVault\.approval\(\w+, hostId: host, key: \w+\) == \.approved/, /XOSetupKey\.holds\(IntentSigning\.signingInput\("([a-z-]+)", \w+\), sig: \w+, hostKey: \w+\)/],
    ['Android', android, /Seal\.open\(\w+, Seal\.(\w+), \w+\)/, /PhoneVault\.approval\(\w+, host, \w+\) != PhoneVault\.Approval\.APPROVED\) return/, /IntentSigning\.signingInput\("([a-z-]+)", \w+\)[\s\S]{0,80}?XoSetup\.verifyKeySig\(\w+, \w+, \w+\)\) return/],
  ])) {
    const at = {
      open: step(body, opened, `${name} does not open the answer with the key made for the request`),
      hash: step(body, /PhoneVault\.keyHash\(\w+\)/, `${name} does not work the key’s id out from the key itself`),
      approval: step(body, approved, `${name} does not hold the key to the member’s approved machines, under the machine that was asked`),
      signature: step(body, signed, `${name} does not check the machine’s signature`),
    };
    assert.ok(at.open < at.hash && at.hash < at.approval && at.approval < at.signature, `${name} checks a sign-in’s answer out of order`);
    // Nothing a person would be shown is read before the last check.
    for (const key of ['"code"', '"url"', '"signedIn"']) {
      assert.ok(body.indexOf(key) > at.signature, `${name} reads ${key} out of an answer before it has checked it`);
    }
    // And nothing but a failure leaves before it.
    const before = body.slice(0, at.signature);
    assert.ok(!/\.verified\(|Verified\(/.test(before), `${name} passes an answer before its signature is checked`);
    // The name it is opened under and the context it is signed in are the
    // machine's own, from the vector its code made.
    const aad = found(name === 'iOS' ? IOS : ANDROID, new RegExp(`${opened.exec(body)?.[1]} = "([^"]+)"`), `${name} has no name for what a sign-in’s answer is sealed under`);
    assert.equal(aad, ANSWER.sealed.aad, `${name} opens a sign-in’s answer under another name than the machine seals it under`);
    assert.equal(signed.exec(body)?.[1], ANSWER.context, `${name} checks the signature in another context than the machine signs in`);
  }
  // WHAT IS SIGNED IS THIS PHONE'S OWN REQUEST: the id, member and engine it
  // sent replace whatever the answer says they were, between the key check
  // and the signature check. Without that, an answer to somebody else's
  // request, or to an older one, would pass.
  for (const mine of ['id', 'member', 'engine']) {
    has(ios, new RegExp(`\\w+\\["${mine}"\\] = ${mine}\\n`), `iOS checks the signature over the answer’s own ${mine}, not the request’s`);
    has(android, new RegExp(`\\w+\\.put\\("${mine}", ${mine}\\)\\n`), `Android checks the signature over the answer’s own ${mine}, not the request’s`);
  }
  // Neither the key nor the signature is in what is signed.
  for (const out of ['hostKey', 'signature']) {
    has(ios, new RegExp(`\\w+\\.removeValue\\(forKey: "${out}"\\)`), `iOS leaves ${out} in the bytes it checks`);
    has(android, new RegExp(`\\w+\\.remove\\("${out}"\\)`), `Android leaves ${out} in the bytes it checks`);
  }
  // A CODE AND ITS PAGE COME TOGETHER OR NOT AT ALL, and what was checked
  // is made in that one function and nowhere else, so no other path can
  // hand a screen a code.
  for (const [name, src, made] of /** @type {const} */ ([['iOS', IOS, 'EngineSigninSaid(code:'], ['Android', ANDROID, 'EngineSigninSaid(if']])) {
    assert.equal(count(src, made), 1, `${name} makes a checked answer in more than one place, or none`);
  }
  assert.ok(ios.includes('EngineSigninSaid(code:') && android.includes('EngineSigninSaid(if'), 'a checked answer is made outside the function that checks it');

  // THE KEY'S ID is the hash of the key written one way, the way the
  // machine's vector writes it: these four fields, in this order.
  const fields = Object.keys(JSON.parse(ANSWER.sealed.keyHashInput));
  assert.deepEqual(fields, ['crv', 'kty', 'x', 'y']);
  has(IOS, new RegExp(`"\\{${fields.map((k) => `\\\\"${k}\\\\":\\\\"\\\\\\(\\w+\\.${k}\\)\\\\"`).join(',')}\\}"`), 'iOS hashes a machine’s key in another form than the machine does');
  has(ANDROID, new RegExp(fields.map((k) => `\\\\"${k}\\\\":\\$\\{JSONObject\\.quote\\(\\w+\\.optString\\("${k}"\\)\\)\\}`).join('[\\s\\S]{0,40}?')), 'Android hashes a machine’s key in another form than the machine does');
});

/** The words of the sign-in block on one phone: the source of its `EngineSigninWords`, with the comments taken out. @param {string} src */
const signinWords = (src) => {
  const at = src.search(/(?:enum|internal object) EngineSigninWords \{/);
  const end = src.search(/\n(?:enum|internal object) EngineSignin \{/);
  assert.ok(at > 0 && end > at, 'the sign-in block’s words were not found');
  return src.slice(at, end).split('\n').filter((line) => !/^\s*(?:\/\/|\/\*|\*)/.test(line)).join('\n');
};
/** Every sentence in it, with each moving part written `{}` whichever way that phone writes one. @param {string} src @param {'iOS'|'Android'} phone */
const signinSentences = (src, phone) =>
  [...signinWords(src).matchAll(/"((?:[^"\\]|\\.)*)"/g)]
    .map((m) => (phone === 'iOS' ? m[1].replace(/\\\((?:[^()]|\([^()]*\))*\)/g, '{}') : m[1].replace(/\$\{[^}]*\}|\$\w+/g, '{}')))
    .filter((words) => words.length >= 12 && words.includes(' '))
    .sort();

test('every sentence of the sign-in block is the same on both phones, word for word', () => {
  // THE SENTENCES ARE READ, NOT LISTED. Each phone keeps the block's words in
  // one place, and every sentence there is held to the other phone's, with
  // each moving part as `{}`. A sentence added, dropped or reworded on one
  // phone alone fails here, without this file knowing what it says.
  const ios = signinSentences(IOS, 'iOS');
  const android = signinSentences(ANDROID, 'Android');
  assert.ok(ios.length >= 50, 'the sign-in block lost its words');
  assert.deepEqual(android, ios);
  // And the ones a person meets on the way, by name, so that none is lost
  // from both phones at once.
  for (const words of [
    'Waiting for this code to be approved at {}.',
    ' A code lasts 15 minutes.',
    ' It lasts {} more minutes.',
    'Signing in on a machine that is signed in replaces that sign-in.',
    'The code ran out before it was approved. Start again for a new one.',
    '{} did not sign in: {}',
    'A newer attempt did not sign in. The sign-in above stands.',
    '{} gave a sign-in page that is not {}’s, so the code is not shown. {}',
    'Cancel it, and tell whoever runs this fleet.',
    'Your fleet did not answer. Check the connection, then try again.',
    '{} refused that ({}).',
    '{} forgets this sign-in, and new sessions as {} there cannot use {} until it is signed in again. Signing in again takes a new code.',
    '{} forgets this sign-in. A pasted sign-in is still kept, and the next session there runs on that.',
  ]) assert.ok(ios.includes(words), `neither phone says: ${words}`);
  // The short ones, which are buttons.
  for (const words of ['"Sign in on a machine"', '"Which machine?"', '"Open the sign-in page"', '"Copy code"', '"Copied"', '"Cancel"', '"Sign out"']) {
    for (const [name, src] of BOTH) assert.ok(signinWords(src).includes(words), `${name} lost the button ${words}`);
  }
});

test('nothing the fleet wrote is drawn in the sign-in block: a refusal is the phone’s own sentence for its code', () => {
  // A REFUSAL'S SENTENCE AND AN ENGINE'S REASON ARRIVE OUTSIDE THE SEAL, and
  // a fleet that lies can put a code of its own in either, to be read beside
  // the real one. So neither phone reads them there at all. What they say is
  // run by the phones' own tests (EngineSignInTests.swift, EngineSignInTest.kt).
  for (const [name, body] of /** @type {const} */ ([
    ['iOS', fn(IOS, 'static func shown(after', 'iOS has no one place an answer becomes what is shown')],
    ['iOS', fn(IOS, 'private func ask(_ action: String, of host: String', 'iOS has no one place a sign-in is asked for')],
    ['Android', fn(ANDROID, 'fun shown(', 'Android has no one place an answer becomes what is shown')],
    ['Android', fn(ANDROID, 'suspend fun ask(action: String, host: String', 'Android has no one place a sign-in is asked for')],
  ])) {
    assert.doesNotMatch(body, /reply\.(?:text|detail|expiresInMinutes)\b/, `${name} draws something the fleet wrote beside a sign-in`);
  }
  // THE SAME CODES ON BOTH PHONES, and every code the machine's own sign-in
  // code refuses with is one of them, so a real refusal is never the
  // sentence for a code nobody has met.
  /** @param {string} body */
  const codes = (body) => [...body.matchAll(/^\s*(?:case )?((?:"[a-z_]+",? ?)+)(?::| ->)/gm)].flatMap((m) => [...m[1].matchAll(/"([a-z_]+)"/g)].map((c) => c[1])).sort();
  const ios = codes(fn(IOS, 'static func refusal(_ code: String', 'iOS has no sentence of its own for a refusal'));
  const android = codes(fn(ANDROID, 'fun refusal(code: String', 'Android has no sentence of its own for a refusal'));
  assert.ok(ios.length >= 24, 'the refusals lost their codes');
  assert.deepEqual(android, ios);
  const box = readFileSync(new URL('../src/core/engine-signin.js', import.meta.url), 'utf8');
  const refusedWith = new Set([...box.matchAll(/(?:refus(?:e|al)\(|error: \{ code: )'([a-z_]+)'/g)].map((m) => m[1]));
  assert.ok(refusedWith.size >= 8, 'the machine’s refusals were not found');
  for (const code of refusedWith) assert.ok(ios.includes(code), `a machine refuses a sign-in with ${code}, and the phones have no sentence for it`);
  // The ones the fleet and the machine's own check add on the way.
  for (const code of ['not_approved', 'approval_unknown', 'custody_unknown', 'not_custodian', 'not_signed_in', 'no_member', 'member_unchecked', 'signature_required', 'host_outdated', 'no_engine', 'host_unavailable', 'host_timeout', 'answer_unsigned', 'bad_params', 'hub_outdated', 'hub_unreachable', 'hub_timeout']) {
    assert.ok(ios.includes(code), `the phones have no sentence for ${code}`);
  }
});

test('a code is drawn only beside the page that engine’s code is entered on, the same two pages on both phones', () => {
  // THE CHECKS SAY THE MACHINE SIGNED THE ANSWER, not that the page is the
  // provider's. So after them the page is held to the one each engine uses.
  for (const [engine, page] of [['codex', 'https://auth.openai.com/codex/device'], ['opencode', 'https://github.com/login/device']]) {
    // The exact text, not a pattern: a page's address is not something to
    // match loosely, here least of all.
    assert.ok(IOS.includes(`case "${engine}": return "${page}"`), `iOS does not hold ${engine}’s code to its own page`);
    assert.ok(ANDROID.includes(`"${engine}" -> "${page}"`), `Android does not hold ${engine}’s code to its own page`);
  }
});

test('a failed check carries nothing over, and Cancel is offered wherever a code is or may be out', () => {
  // What is shown after a failed check is the sentence and nothing carried
  // over: no code, no page, no account, old or new. Cancel is offered when
  // a code is out, so the machine does not ask the provider for 15 minutes.
  const ios = fn(IOS, 'static func shown(after', 'iOS has no one place an answer becomes what is shown');
  const android = fn(ANDROID, 'fun shown(', 'Android has no one place an answer becomes what is shown');
  for (const failed of ['unopened', 'unapproved', 'unsigned']) {
    has(ios, new RegExp(`case \\.${failed}:\\s*return \\w+\\(says: \\w+\\.${failed}\\(\\w+, codeOut: \\w+\\), bad: true, cancel: \\w+\\)`), `iOS carries something over a failed check (${failed})`);
    const Failed = failed[0].toUpperCase() + failed.slice(1);
    has(android, new RegExp(`\\w+\\.${Failed} ->\\s*\\w+\\(says = \\w+\\.${failed}\\(\\w+, \\w+\\), bad = true, cancel = \\w+\\)`), `Android carries something over a failed check (${failed})`);
  }
  // Cancel is drawn while a code is shown, and after a check failed on one.
  has(IOS, /if \w+\.code != nil \|\| \w+\.cancel \{\s*Button\(\w+\.cancel, role: \.cancel\) \{/, 'iOS does not offer Cancel where a code is out');
  has(ANDROID, /if \(\w+\.code != null \|\| \w+\.cancel\) \{\s*TextButton\(/, 'Android does not offer Cancel where a code is out');
});

test('Sign in on a machine is offered only on a machine that runs the engine and is approved for the whole of the member’s vault, and what is missing is said where none is (C-2)', () => {
  const ios = fn(IOS, 'static func places(', 'iOS does not work out where an engine can be signed in');
  const android = fn(ANDROID, 'fun places(', 'Android does not work out where an engine can be signed in');
  // A machine that takes a session now (only a connected one does), is not
  // temporary, and says it runs this engine.
  has(ios, /\w+\.takesSessions == true && \w+\.ephemeral != true && \(\w+\.health\?\.engines \?\? \[\]\)\.contains\(engine\)/, 'iOS offers a sign-in on a machine that does not run the engine, or cannot take it');
  has(android, /\w+\.takesSessions == true && !\w+\.ephemeral && \w+\.engines\.orEmpty\(\)\.contains\(engine\)/, 'Android offers a sign-in on a machine that does not run the engine, or cannot take it');
  // New enough to know the verb, by the protocol it says it speaks.
  assert.equal(Number(found(IOS, /static let protocolNeeded = (\d+)/, 'iOS does not know which protocol signs an engine in')), 22);
  assert.equal(Number(found(ANDROID, /const val PROTOCOL_NEEDED = (\d+)/, 'Android does not know which protocol signs an engine in')), 22);
  // APPROVED FOR THE WHOLE VAULT, under its own name, by its own key: the
  // rule the answer is held to afterwards, made first, and the only way
  // onto the list of machines offered.
  has(ios, /if PhoneVault\.approval\(grants, hostId: (\w+)\.hostId, key: \w+\) == \.approved \{\s*(\w+)\.append\(\1\.hostId\)/, 'iOS offers a sign-in on a machine not approved for the member’s vault');
  has(android, /if \(PhoneVault\.approval\(grants, (\w+)\.hostId, \w+\) == PhoneVault\.Approval\.APPROVED\) \{\s*(\w+)\.add\(\1\.hostId\)/, 'Android offers a sign-in on a machine not approved for the member’s vault');
  const iosList = found(ios, /== \.approved \{\s*(\w+)\.append\(/, 'iOS has no list of machines to offer');
  const androidList = found(android, /APPROVED\) \{\s*(\w+)\.add\(/, 'Android has no list of machines to offer');
  assert.equal(count(ios, `${iosList}.append(`), 1, 'iOS puts a machine on the list some other way');
  assert.equal(count(android, `${androidList}.add(`), 1, 'Android puts a machine on the list some other way');
  // "Whole vault, under that name, by that key" is the vault's own rule on
  // both phones: a grant for some of a vault does not count.
  has(IOS, /let (\w+) = grants\.filter \{ \$0\.only\.isEmpty && \$0\.label == hostId \}\s*if \1\.contains\(where: \{ \$0\.key == keyHash\(key\) \}\) \{ return \.approved \}/, 'iOS counts a grant for part of a vault, or under another name');
  has(ANDROID, /val (\w+) = grants\.filter \{ it\.only\.isEmpty\(\) && it\.label == hostId \}\s*if \(\1\.any \{ it\.key == keyHash\(jwk\) \}\) return Approval\.APPROVED/, 'Android counts a grant for part of a vault, or under another name');

  // THE BUTTON IS DRAWN FROM THAT LIST, and a start is sent to nothing else.
  has(IOS, /if !(\w+)\.offered\.isEmpty \{\s*\w+\(\1\.offered\)[\s\S]{0,700}?\} else if !\1\.missing\.isEmpty \{\s*Text\(\1\.missing\)/, 'iOS draws Sign in on a machine without asking where it can be done');
  has(ANDROID, /if \((\w+)\.offered\.isNotEmpty\(\)\) \{\s*OutlinedButton\([\s\S]{0,1800}?\} else if \(\1\.missing\.isNotEmpty\(\)\) \{\s*Hint\(\1\.missing\)/, 'Android draws Sign in on a machine without asking where it can be done');
  has(IOS, /if action == "start", !\w+\.offered\.contains\(host\) \{ return \}/, 'iOS can send a start to a machine it does not offer');
  has(ANDROID, /if \(action == "start" && host !in \w+\.offered\) return/, 'Android can send a start to a machine it does not offer');
  // More than one: it asks which, and each choice names its machine.
  bothSay('Sign in on a machine');
  bothSay('Which machine?');
  bothSay('Sign in on {}');
  has(IOS, /if (\w+)\.count == 1, let (\w+) = \1\.first \{\s*(?:\w+ = )?Task \{ await \w+\("start", of: \2\) \}\s*\} else \{\s*\w+\.toggle\(\)/, 'iOS does not ask which machine when more than one could');
  has(ANDROID, /if \((\w+)\.offered\.size == 1\) \{\s*scope\.launch \{ \w+\("start", \1\.offered\.first\(\)\) \}\s*\} else \{\s*(\w+) = !\2/, 'Android does not ask which machine when more than one could');

  // WITH NOWHERE TO OFFER, ONE SENTENCE, never a dead button: no machine
  // runs it, the one that does is not approved (and where to approve it),
  // or the one that does is too old. With no machine heard from, nothing:
  // that is not known to be none (C-5).
  bothSay('No machine that can take a session now runs {}.');
  bothSay('{} runs {} and is not approved for {}’s credentials. Approve it below, then sign in.');
  bothSay('{} runs {} and is not approved for your credentials. Approve it from its page, then sign in.');
  bothSay('{} runs {} and is too old to sign it in. Update fleetwright on {}.');
  has(ios, /guard !hosts\.isEmpty else \{ return \w+\(\) \}/, 'iOS says no machine runs an engine before any machine was heard from');
  has(android, /if \(hosts\.isEmpty\(\)\) return \w+\(\)/, 'Android says no machine runs an engine before any machine was heard from');
  // And the block is drawn at all only for the two an engine signs in
  // itself, for a member there is an id to ask as.
  has(IOS, /if let (\w+) = \w+\.engine\(ofItem: name\), let (\w+) = signsInAs \{\s*(\w+)\(\s*settings: settings,\s*engine: \1,\s*member: \2,/, 'iOS draws a sign-in on a machine for an item no engine signs in, or with nobody to sign in as');
  has(ANDROID, /val (\w+) = \w+\.engineOfItem\(name\)\s*if \(\1 != null && signsInAs != null\) \{\s*(\w+)\(\s*settings = settings,\s*engine = \1,\s*member = signsInAs,/, 'Android draws a sign-in on a machine for an item no engine signs in, or with nobody to sign in as');
  for (const [name, src] of BOTH) {
    has(src, /"codex" *(?:->|: return) *"codex"[\s\S]{0,40}?"copilot" *(?:->|: return) *"opencode"/, `${name} signs the wrong engine in for a vault item`);
  }
});

test('every request for a sign-in carries a key of its own for the answer, under an id of its own, and the answer is checked against both', () => {
  // `reply` IS WHAT MAKES THE MACHINE SEAL ITS ANSWER: a request without it
  // is answered in the clear, through the fleet. It is a parameter, so the
  // phone's signature covers it, and the request is never held for later.
  has(IOS, /intent\("enginesignin", params: \["member": member, "engine": engine, "action": action, "reply": reply\],\s*host: host, idempotencyKey: id\)/, 'iOS asks for a sign-in without a key for the answer, without naming the machine, or under an id it does not know');
  has(ANDROID, /intent\(\s*"enginesignin",\s*mapOf\("member" to member, "engine" to engine, "action" to action, "reply" to reply\),\s*host = host,\s*idempotencyKey = id,\s*\)/, 'Android asks for a sign-in without a key for the answer, without naming the machine, or under an id it does not know');
  // A NEW KEY AND A NEW ID FOR EACH ASK, a poll included, and the same two
  // are what the answer is opened with and checked over.
  const ios = fn(IOS, 'private func ask(_ action: String, of host: String', 'iOS has no one place a sign-in is asked for');
  const android = fn(ANDROID, 'suspend fun ask(action: String, host: String', 'Android has no one place a sign-in is asked for');
  const [, iosId, iosKey] = /let (\w+) = "app-\\\(UUID\(\)\.uuidString\)"\s*let (\w+) = Seal\.newKey\(\)/.exec(ios) ?? [];
  assert.ok(iosId && iosKey, 'iOS does not make an id and a key for each ask');
  has(ios, new RegExp(`\\.engineSignIn\\(\\s*member: member, engine: engine, action: action, host: host, reply: ${iosKey}\\.publicKey, id: ${iosId}\\s*\\)`), 'iOS sends another key or id than the ones it made');
  has(ios, new RegExp(`\\.shown\\(after: \\w+, before: \\w+, poll: \\w+, key: ${iosKey}, grants: grants, host: host, id: ${iosId},\\s*member: member, engine: engine,`), 'iOS checks the answer against another key or id than the ones it sent');
  const [, androidId, androidKey] = /val (\w+) = "app-" \+ java\.util\.UUID\.randomUUID\(\)\.toString\(\)\s*val (\w+) = Seal\.newKey\(\)/.exec(android) ?? [];
  assert.ok(androidId && androidKey, 'Android does not make an id and a key for each ask');
  has(android, new RegExp(`\\.engineSignIn\\(member, engine, action, host, ${androidKey}\\.publicKey, ${androidId}\\)`), 'Android sends another key or id than the ones it made');
  has(android, new RegExp(`\\.shown\\(\\w+, \\w+, \\w+, ${androidKey}, grants, host, ${androidId}, member, engine,`), 'Android checks the answer against another key or id than the ones it sent');
  // The code and its page are never written into the screen's saved state.
  has(ANDROID, /var \w+ by remember \{ mutableStateOf\(mapOf<String, EngineSigninShown>\(\)\) \}/, 'Android may write a sign-in code into the screen’s saved state');
});

test('Sign out asks first, the code is large, selectable and spoken as characters, and its arrival is said aloud', () => {
  // The button only opens the question; the request goes from its answer.
  has(IOS, /Button\(\w+\.signOut, role: \.destructive\) \{ (\w+) = host \}/, 'iOS signs an engine out without asking');
  has(IOS, /\.confirmationDialog\(\w+\.signOutAsk\([^\n]*\n[\s\S]{0,260}?Button\(\w+\.signOut, role: \.destructive\) \{\s*if let (\w+) = \w+ \{\s*(?:\w+ = )?Task \{ await \w+\("signout", of: \1\) \}/, 'iOS signs an engine out without asking');
  has(ANDROID, /onClick = \{ (\w+) = host \},[\s\S]{0,700}?\{ Text\(\w+\.SIGN_OUT, /, 'Android signs an engine out without asking');
  has(ANDROID, /AlertDialog\(\s*onDismissRequest = \{ \w+ = null \},\s*title = \{ Text\(\w+\.signOutAsk\([\s\S]{0,400}?scope\.launch \{ \w+\("signout", \w+\) \}/, 'Android signs an engine out without asking');

  // THE CODE: the scale's title size in the monospaced face, selectable,
  // with no line limit, and read to a screen reader one character at a time.
  has(IOS, /Design\.Role\(size: Design\.Text\.title, [^\n]*\n\s*design: \.monospaced, relativeTo: \.title2\)/, 'iOS does not set a sign-in code large and monospaced, scaled by the reader’s setting');
  has(IOS, /Text\(code\)\s*\.fleetType\(\w+\)\s*\.foregroundStyle\([^\n]*\)\s*\.fixedSize\(horizontal: false, vertical: true\)\s*\.textSelection\(\.enabled\)\s*\.accessibilityLabel\(\w+\.spoken\(code\)\)/, 'iOS’s sign-in code is clipped, not selectable, or read as a word');
  has(ANDROID, /SelectionContainer \{\s*Text\(\s*code,\s*style = Design\.Style\.title\.copy\(fontFamily = FontFamily\.Monospace, letterSpacing = 0\.sp\),\s*color = [^\n]*\n\s*modifier = Modifier\.semantics \{ contentDescription = \w+\.spoken\(code\) \},\s*\)/, 'Android’s sign-in code is clipped, not selectable, or read as a word');
  has(IOS, /code\.map \{ \$0 == "-" \? "dash" : String\(\$0\) \}\.joined\(separator: " "\)/, 'iOS reads a code as a word');
  has(ANDROID, /code\.map \{ if \(it == '-'\) "dash" else it\.toString\(\) \}\.joinToString\(" "\)/, 'Android reads a code as a word');

  // ITS ARRIVAL IS SAID ALOUD. The button a screen reader's user pressed is
  // gone when the code comes, up to most of a minute later, and nothing
  // said so: an announcement on iOS, a live region on Android, each with
  // which machine and then the code a character at a time.
  has(IOS, /UIAccessibility\.post\(notification: \.announcement, argument: \w+\.codeArrived\(\w+, \w+\)\)/, 'iOS does not say aloud that a code arrived');
  has(ANDROID, /liveRegion = LiveRegionMode\.Polite\s*contentDescription = \w+\.codeArrived\(\w+, \w+\)/, 'Android does not say aloud that a code arrived');

  // A CHANGE OF STATE MOVES, as a crossfade, and a minute passing is not
  // one: on Android the block was made again each minute, and TalkBack's
  // place in it went with it.
  has(IOS, /\.animation\(Design\.Motion\.change, value: \w+\)/, 'iOS’s sign-in changes state without the crossfade');
  has(ANDROID, /AnimatedContent\(\s*targetState = \w+\.copy\(minutes = null\),\s*transitionSpec = \{ fadeIn\(Design\.Motion\.change\(\)\) togetherWith fadeOut\(Design\.Motion\.change\(\)\) \},/, 'Android makes the sign-in block again when a minute passes');
  // A Sign out that cannot be pressed does not stay red.
  has(ANDROID, /Text\(\w+\.SIGN_OUT, color = if \(\w+\.isEmpty\(\)\) Design\.Palette\.bad\.now else Color\.Unspecified\)/, 'Android’s Sign out looks live while it cannot be pressed');
  // The page opens only an https address, in the browser.
  has(IOS, /url\.scheme\?\.lowercased\(\) == "https"/, 'iOS opens a sign-in page that is not https');
  has(ANDROID, /it\.startsWith\("https:\/\/", ignoreCase = true\)/, 'Android opens a sign-in page that is not https');
});

test('pasting a sign-in is the fallback, behind a button that says so, with when to use it and which Copilot token works', () => {
  // A sign-in's row says whether one was pasted, and its paste field is
  // behind the fallback's button. An API key's row keeps Keep and Replace.
  for (const words of ['"Paste a sign-in instead"', '"Paste a token instead"', '"None pasted"', '"Pasted"']) {
    for (const [name, src] of BOTH) assert.ok(src.includes(words), `${name} lost: ${words}`);
  }
  has(IOS, /if (\w+) \{\s*Text\(item == nil \? "None pasted" : "Pasted"\)[\s\S]{0,160}?\} else \{\s*Text\(item == nil \? "Not kept" : "Kept"\)/, 'iOS offers Keep on the row of a sign-in that is made on a machine');
  has(ANDROID, /if \((\w+)\) \{\s*Text\(if \(item == null\) "None pasted" else "Pasted",[^\n]*\n\s*\} else \{\s*Text\(if \(item == null\) "Not kept" else "Kept",/, 'Android offers Keep on the row of a sign-in that is made on a machine');
  has(IOS, /if \w+ \{[^{}]*Button\(\w+\(name\)\) \{ (\w+)\.toggle\(\) \}\s*\.frame\(minHeight: 44\)[\s\S]{0,120}?\}\s*if \1 \{ \w+ \}/, 'iOS shows a sign-in’s paste field without the fallback being asked for');
  has(ANDROID, /if \(\w+\) \{[^{}]*TextButton\(\s*enabled = !busy,\s*onClick = \{ (\w+) = !\1 \},\s*modifier = Modifier\.heightIn\(min = 48\.dp\),\s*\) \{ Text\(\w+\(name\)\) \}\s*\}\s*if \(\1\) \{/, 'Android shows a sign-in’s paste field without the fallback being asked for');
  // One sentence each for when to use it, the same on both phones, and
  // none for a key, which has no other way in.
  for (const [item, words] of [
    ['codex', 'Use this when the account cannot sign in on a machine: OpenAI lets an account or its workspace switch device codes off.'],
    ['copilot', 'Use this when the account cannot sign in on a machine.'],
  ]) {
    has(IOS, new RegExp(`case "${item}": return "${lit(words)}"`), `iOS does not say when to paste a ${item} sign-in`);
    has(ANDROID, new RegExp(`"${item}" -> "${lit(words)}"`), `Android does not say when to paste a ${item} sign-in`);
  }
  // WHICH COPILOT TOKEN: the one OpenCode's own login makes, by where it is
  // found, and that no other works. The same sentence on both phones.
  const ios = found(IOS, /let copilotTokenLine = "([^"]+)"/, 'iOS does not say which Copilot token works');
  const android = found(ANDROID, /const val COPILOT_TOKEN_LINE = "([^"]+)"/, 'Android does not say which Copilot token works');
  assert.equal(android, ios, 'the phones say different things about which Copilot token works');
  for (const fact of ['refresh', 'github-copilot', '~/.local/share/opencode/auth.json', 'opencode auth login', 'No other GitHub token works.']) {
    assert.ok(ios.includes(fact), `the sentence about a Copilot token no longer says: ${fact}`);
  }
  has(IOS, /Text\("Paste one GitHub Copilot token\. OpenCode runs on it\."\)[\s\S]{0,700}?Text\(copilotTokenLine\)[\s\S]{0,300}?SecureField\("GitHub Copilot token"/, 'iOS does not say which token above the field it is pasted into');
  has(ANDROID, /"Paste one GitHub Copilot token\. OpenCode runs on it\.",[\s\S]{0,700}?Text\(COPILOT_TOKEN_LINE,[\s\S]{0,200}?OutlinedTextField\(/, 'Android does not say which token above the field it is pasted into');
});
