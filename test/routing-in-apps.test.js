// The two phones say the same thing about routing (docs/routing.md), in the
// fleet's own words, offer a control only where the fleet would take it, and
// send what the fleet reads.
//
//   node --test test/routing-in-apps.test.js
//
// A read of the sources, not a run: the Swift and the Kotlin compile only in
// CI. What a build cannot check is what this holds:
//
//   1. THE SENTENCE IS THE FLEET'S. How a task was routed is written three
//      times: by the coordinator (`HOW_WORDS` and `routeWords`, which a
//      terminal and a notification print) and by each phone. This imports
//      the coordinator's and holds both phones to it.
//   2. THE OTHER PHONE USES THE SAME WORDS, for the mode's three choices and
//      the line under each, and for a task that waits on somebody.
//   3. A CONTROL IS DRAWN ONLY WHERE THE FLEET WOULD TAKE IT (C-2): the
//      setting's for an admin, a candidate's button while the task waits,
//      Route it on an open task nobody has.
//   4. WHAT IS SENT IS WHAT THE FLEET READS: the mode and every rule on a
//      save, `{ member }` or nothing to a task's route, and `routing` on a
//      new task as the choice says: off for Nobody, so the label is true on
//      a fleet whose routing is on, and none for "As your fleet is set".
//
// HOW A CONDITION IS READ. A control's condition is whatever opens the
// blocks it sits in, and both apps are indented four spaces a block, so
// `under` reads those headers off the indentation, and follows a view's
// function to where it is called. A test then asks whether the headers name
// the wire's own fields (`lock`, `state`, `how`), never what a local is
// called: a name the rule depends on is found first, from the words a
// person sees beside it, and matched as found. So renaming a function
// changes nothing here, and removing the rule does.
//
// What the coordinator decides and answers is its own tests' business
// (test/routing.test.js, test/routing-coordinator.test.js).

import test from 'node:test';
import assert from 'node:assert/strict';
import { iosSources } from './helpers/ios-sources.js';
import { androidSources } from './helpers/android-sources.js';
import { HOW_WORDS, ROUTE_HOWS, ROUTING_MODES, routeWords } from '../src/fleet/protocol/routing.js';

const IOS = iosSources();
const ANDROID = androidSources();
const BOTH = /** @type {const} */ ([['iOS', IOS], ['Android', ANDROID]]);

/** @param {string} text */
const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** How many times a phone's source holds a string. @param {string} src @param {string} text */
const count = (src, text) => src.split(text).length - 1;
/** Every place a pattern is found. @param {string} src @param {RegExp} re */
const places = (src, re) => [...src.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`))].map((m) => /** @type {number} */ (m.index));
/** The one place a string is, and a failure that says so when it is not one. @param {string} src @param {string} text @param {string} name */
function only(src, text, name) {
  assert.equal(count(src, text), 1, `${name} has ${JSON.stringify(text)} ${count(src, text)} times, and this reads the one`);
  return src.indexOf(text);
}
/** A name found in the source by what stands beside it. @param {string} src @param {RegExp} re @param {string} what */
function named(src, re, what) {
  const m = re.exec(src);
  assert.ok(m, `${what}\n  looked for ${re}`);
  return m.slice(1).find((g) => g !== undefined) ?? '';
}

const indent = (/** @type {string} */ line) => /^ */.exec(line)?.[0].length ?? 0;
const isComment = (/** @type {string} */ line) => /^\s*(?:\/\/|\/\*|\*)/.test(line);
const DECLARES = /\b(?:func|fun) (\w+)\(|\bvar (\w+): some View\b/;

/**
 * The headers of the blocks a place sits inside, innermost first: the line
 * that opens each, read off the indentation. An `else` also says what it is
 * the other side of, as `else of: if …`. A guard on the place's own line
 * (`if x { y }`) is first.
 *
 * @param {string} src @param {number} at
 * @returns {{ text: string, indent: number, at: number }[]}
 */
function under(src, at) {
  const lineStart = src.lastIndexOf('\n', at - 1) + 1;
  const before = src.slice(0, lineStart).split('\n');
  let depth = indent(src.slice(lineStart));
  /** @type {{ text: string, indent: number, at: number }[]} */
  const chain = [];
  const inline = src.slice(lineStart, at).trim();
  if (/^(?:\} else )?if\b/.test(inline)) chain.push({ text: inline, indent: depth, at: lineStart });
  let offset = lineStart;
  for (let i = before.length - 2; i >= 0 && depth > 0; i -= 1) {
    const line = before[i];
    offset -= line.length + 1;
    if (!line.trim() || isComment(line) || indent(line) >= depth) continue;
    depth = indent(line);
    chain.push({ text: line.trim(), indent: depth, at: offset });
    if (!/^\} else\b/.test(line.trim())) continue;
    // The ladder this `else` hangs off: every `if` above it at its depth.
    for (let j = i - 1; j >= 0; j -= 1) {
      const up = before[j];
      if (!up.trim() || indent(up) > depth) continue;
      if (indent(up) < depth) break;
      const head = up.trim();
      if (/^if\b/.test(head)) { chain.push({ text: `else of: ${head}`, indent: depth, at: offset }); break; }
      if (/^\} else if\b/.test(head)) { chain.push({ text: `else of: ${head.replace(/^\} else /, '')}`, indent: depth, at: offset }); continue; }
      break;
    }
  }
  return chain;
}

/**
 * Every way a place comes to be drawn: its own headers, and where they end
 * at a view's function, the headers of each place that function is called
 * from. A view's `body` is where a screen starts, so nothing is followed
 * past it. A function inside a type is looked for inside that type.
 *
 * @param {string} src @param {number} at @param {number} [hops]
 * @returns {string[][]}
 */
function paths(src, at, hops = 0) {
  const chain = under(src, at);
  const text = chain.map((h) => h.text);
  const i = chain.findIndex((h) => DECLARES.test(h.text));
  if (i < 0 || hops > 3) return [text];
  const name = named(chain[i].text, DECLARES, 'a declaration with no name');
  if (name === 'body') return [text];
  // Inside a type: from the type's own line to the line that closes it.
  let from = 0;
  let to = src.length;
  if (chain[i].indent > 0) {
    from = chain[chain.length - 1].at;
    const close = src.indexOf('\n}\n', from);
    if (close > 0) to = close;
  }
  // Every use of the name that is not its own declaration or a comment.
  const lineAt = (/** @type {number} */ p) => src.slice(src.lastIndexOf('\n', p - 1) + 1, src.indexOf('\n', p));
  const sites = places(src.slice(from, to), new RegExp(`(?<![.\\w])${name}\\b(?![:\\w])`))
    .map((p) => p + from)
    .filter((p) => !isComment(lineAt(p)) && !DECLARES.test(lineAt(p)));
  if (!sites.length) return [text];
  const own = text.slice(0, i + 1);
  return sites.flatMap((site) => paths(src, site, hops + 1).map((rest) => [...own, ...rest]));
}

/**
 * Whether every way to a place passes a header that matches.
 * @param {string} src @param {number} at @param {RegExp} re
 */
const alwaysUnder = (src, at, re) => paths(src, at).every((chain) => chain.some((head) => re.test(head)));

/**
 * A function's text, from its declaration to the line that ends it.
 * @param {string} src @param {string} name
 */
function bodyOf(src, name) {
  const m = new RegExp(`^( *)[^\\n]*\\b(?:func|fun) ${name}\\(`, 'm').exec(src);
  assert.ok(m, `there is no function ${name}`);
  const lines = src.slice(m.index).split('\n');
  const depth = m[1].length;
  const out = [lines[0]];
  for (const line of lines.slice(1)) {
    if (line.trim() && indent(line) <= depth) {
      if (line.trim().startsWith('}') || line.trim().startsWith(')')) out.push(line);
      if (!line.trim().startsWith(')')) break;
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/**
 * The screen that carries a title: the top-level declaration it is set in.
 * @param {string} src @param {string} title  the title as the source writes it
 */
function screen(src, title) {
  const at = only(src, title, 'the app');
  const chain = under(src, at);
  const from = chain[chain.length - 1].at;
  return { from, to: src.indexOf('\n}\n', at) };
}

// What draws something a person can press or type into, on each phone.
const IOS_CONTROL = /\b(?:Button|Picker|TextField|SecureField|Toggle|Stepper|NavigationLink)\s*[({]/;
const ANDROID_CONTROL = /\b(?:OutlinedButton|TextButton|Button|IconButton|OutlinedTextField|TextField|RadioButton|Switch|Checkbox|FilterChip|OpenRow)\(|\.(?:selectable|clickable|toggleable)\(/;

// Names the rules below depend on, each found from the words beside it.
/** The function that holds the seven heads. */
const I_HEAD = named(IOS, /func (\w+)\([^)]*\)[^\n]*\{\s*switch [^\n]*\{\s*case "pinned": return /, 'iOS has no table of how a task was routed');
const A_HEAD = named(ANDROID, /fun (\w+)\([^)]*\)[^\n]*= when \(\w+\) \{\s*"pinned" -> /, 'Android has no table of how a task was routed');
/** The function that posts to a task's route. */
const I_ROUTE = named(IOS, /func (\w+)\([^)]*\) async throws -> \w+ \{(?:(?!\n    \})[\s\S])*?\/route"/, 'iOS never posts to a task’s route');
const A_ROUTE = named(ANDROID, /fun (\w+)\([^)]*\)[^\n]*\{(?:(?!\n    \})[\s\S])*?\/route"/, 'Android never posts to a task’s route');
/** What a task's page calls to send one, with a member or with none. */
const I_SEND = named(IOS, new RegExp(`func (\\w+)\\(member: String\\?\\) \\{(?:(?!\\n    \\})[\\s\\S])*?\\.${I_ROUTE}\\(`), 'iOS’s task page never asks for a route');
const A_SEND = named(ANDROID, new RegExp(`fun (\\w+)\\(member: String\\?\\) \\{(?:(?!\\n    \\})[\\s\\S])*?\\.${A_ROUTE}\\(`), 'Android’s task page never asks for a route');
/** Whether a task waits for a member to be chosen, and whether it is asking anything. */
const I_WAITS = named(IOS, /func (\w+)\([^)]*\) -> Bool \{\s*[^\n]*\bhow == "waiting"/, 'iOS never asks whether a task waits for a member');
const A_WAITS = named(ANDROID, /fun (\w+)\([^)]*\): Boolean =\s*[^\n]*\bhow == "waiting"/, 'Android never asks whether a task waits for a member');
const I_ASKS = named(IOS, new RegExp(`func (\\w+)\\([^)]*\\) -> Bool \\{\\s*[^\\n]*state == "returned" \\|\\| ${I_WAITS}\\(`), 'iOS has no one test of whether a task is asking');
const A_ASKS = named(ANDROID, new RegExp(`fun (\\w+)\\([^)]*\\): Boolean = [^\\n]*state == "returned" \\|\\| ${A_WAITS}\\(`), 'Android has no one test of whether a task is asking');

test('how a task was routed is said with the fleet’s seven heads, each written once on each phone', () => {
  assert.deepEqual(Object.keys(HOW_WORDS).sort(), [...ROUTE_HOWS].sort(), 'the fleet has a way of deciding with no words for it');
  for (const [how, head] of Object.entries(HOW_WORDS)) {
    for (const [name, src] of BOTH) {
      // The wire's word and the fleet's head for it, on one line.
      assert.match(src, new RegExp(`"${how}"[^"\\n]{1,12}"${literal(head)}"`), `${name} does not say ${how} as “${head}”`);
      // Once, so the line on the task and the line in its history cannot
      // come to say the same decision two ways.
      assert.equal(count(src, `"${head}"`), 1, `${name} writes “${head}” somewhere else as well`);
    }
  }
  // A way of deciding from a newer fleet is shown as the fleet sent it.
  assert.match(bodyOf(IOS, I_HEAD), /default: return \w+ \?\? ""/, 'iOS makes up words for a way of deciding it never met');
  assert.match(bodyOf(ANDROID, A_HEAD), /else -> \w+\.orEmpty\(\)/, 'Android makes up words for a way of deciding it never met');
});

test('the Routing line is the fleet’s sentence: the head, the member after a colon, why, and whom to choose among', () => {
  // The fleet's own sentence for a task that waits, so the pieces below are
  // read off what it prints and not off a guess.
  const said = routeWords({ how: 'waiting', member: null, mode: 'manual', candidates: ['ada', 'bo'], more: 3, why: 'Two members take backend work.', at: 1, by: 'a@b.c' });
  assert.equal(said, 'Waiting for a person to choose. Two members take backend work. Choose among ada, bo and 3 more.');
  const chose = routeWords({ how: 'rule', member: 'ada', mode: 'manual', candidates: ['ada'], why: 'Why.', at: 1, by: 'a@b.c' }, () => 'Ada');
  assert.equal(chose, 'Routed by the fleet’s rule: Ada. Why.');
  for (const [name, src] of BOTH) {
    for (const piece of ['" Choose among "', '", "', ' more"', '": "']) {
      assert.ok(src.includes(piece), `${name} lost ${piece} from the sentence`);
    }
    // Whom to choose among is said only of a task that is waiting.
    const at = only(src, '" Choose among "', name);
    assert.ok(alwaysUnder(src, at, /\bhow == "waiting"/), `${name} says “Choose among” of a task that is not waiting`);
    assert.ok(src.includes('"Routing"'), `${name} has no Routing line on a task’s page`);
  }
  // The line is drawn only for a task the fleet wrote a decision on.
  assert.match(IOS, /if let (\w+) = \w+\.route \{\s*VStack[^\n]*\{\s*Text\("Routing"\)[\s\S]{0,200}?Text\(\w+\(\1, \w+\)\)/, 'iOS draws a Routing line for a task with no decision');
  assert.match(ANDROID, /\.route\?\.let \{ (\w+) -> \w+\("Routing", \w+\(\1, \w+\)\) \}/, 'Android draws a Routing line for a task with no decision');
});

test('a routing decision in a task’s history is a sentence from the same heads', () => {
  // The kind is `routed`, its note is how, and `to` is whom it chose.
  const iWords = named(IOS, /case "routed": return (\w+)\(how: \w+\.note, to: /, 'iOS does not say a routed handoff');
  const aWords = named(ANDROID, /"routed" -> (\w+)\(\w+\.note, /, 'Android does not say a routed handoff');
  assert.match(bodyOf(IOS, iWords), new RegExp(`${I_HEAD}\\(how\\)[\\s\\S]*\\\\\\(${I_HEAD}\\(how\\)\\): \\\\\\(to\\)`), 'iOS does not build the history’s sentence from the heads');
  assert.match(bodyOf(ANDROID, aWords), new RegExp(`${A_HEAD}\\(how\\) else "\\$\\{${A_HEAD}\\(how\\)\\}: \\$to"`), 'Android does not build the history’s sentence from the heads');
});

test('the mode is the same three choices on both phones, each with the same line under it', () => {
  const choices = { off: 'Off', manual: 'Ask me', auto: 'Choose for me' };
  const lines = {
    off: 'A task with no member stays with nobody.',
    manual: 'The rules below place a task. When several members could take it, whoever asked chooses.',
    auto: 'The same, and the fleet’s model picks among several.',
  };
  assert.deepEqual(Object.keys(choices), [...ROUTING_MODES], 'the fleet’s modes are not the three the phones offer, in that order');
  for (const [name, src] of BOTH) {
    for (const mode of ROUTING_MODES) {
      assert.match(src, new RegExp(`"${mode}"[^"\\n]{1,12}"${literal(choices[mode])}"`), `${name} does not offer ${mode} as “${choices[mode]}”`);
      assert.match(src, new RegExp(`"${mode}"[^"\\n]{1,12}"${literal(lines[mode])}"`), `${name} does not say what ${mode} does`);
    }
    // And they are offered in the fleet's order, off first.
    assert.match(src, /= (?:\[|listOf\()"off", "manual", "auto"[\])]/, `${name} does not offer the modes in the fleet’s order`);
    for (const words of [
      // With no model on, the third choice says so, and who turns it on.
      'This fleet has no model turned on, so a person is asked. Its operator turns the model on.',
      // What routing never does, on the setting whoever reads it.
      'A task somebody was given is never moved. Routing chooses only among members the person asking could have assigned by hand.',
      'An admin sets this. Anybody can read it.',
      // A task's own choice, on New task and on Edit.
      '"Let the fleet choose"',
      '"As your fleet is set"',
      'It stays with nobody until somebody assigns it or changes its routing.',
      // The page's ways of having nothing to draw.
      'Could not load the routing.',
      'Routing is not on this fleet yet. It may need an update.',
      '"No rules yet."',
      '"Add the rule"',
      '"Not saved yet."',
      // A task that waits, and the question on its page.
      '"Open, waiting for you to choose a member"',
      '"Open, waiting for a member to be chosen"',
      '"Choose a member"',
      '"Somebody else"',
      '"Route it"',
    ]) {
      assert.ok(src.includes(words), `${name} lost: ${words}`);
    }
    // The model is the fleet's model, in every sentence that names it.
    assert.doesNotMatch(src, /"[^"\n]*\b(?:an|the|by) AI\b[^"\n]*"/, `${name} calls the fleet’s model AI`);
  }
  // No model is said under the third choice and no other, and only when the
  // fleet said it has none. The choice itself stays a choice.
  assert.match(IOS, /if \w+ == "auto", !\w+ \{\s*Text\(\w+\)/, 'iOS does not say the fleet has no model under Choose for me');
  assert.match(ANDROID, /if \(\w+ == "auto" && !\w+\) \{\s*Text\(\w+,/, 'Android does not say the fleet has no model under Choose for me');
});

test('every routing route has a caller on both phones', () => {
  for (const [name, src] of BOTH) {
    assert.match(src, /get\("\/api\/routing"\)/, `${name} never reads the fleet’s routing`);
    assert.match(src, /send\("PUT", "\/api\/routing", /, `${name} cannot change the fleet’s routing`);
    assert.match(src, /post\("\/api\/tasks\/(?:\\\(id\)|\$id)\/route", /, `${name} cannot route a task or answer for one`);
  }
  // And each is asked for by a screen, not only declared.
  for (const [name, src, route] of /** @type {const} */ ([['iOS', IOS, I_ROUTE], ['Android', ANDROID, A_ROUTE]])) {
    assert.ok(count(src, `.${route}(`) >= 1, `${name} declares a task’s route and no screen calls it`);
    assert.match(src, /\)\.routing\(\)/, `${name} declares the fleet’s routing and no screen reads it`);
  }
});

test('Save sends the mode and every rule, and the fleet’s answer is the line under it', () => {
  // The body: a mode, and the rules as a list of a kind of work and a member.
  assert.match(IOS, /\["workType": \$0\.workType, "member": \$0\.member\] \}\s*let \w+: \[String: Any\] = \["mode": \w+, "rules": \w+\]\s*return [^\n]*send\("PUT", "\/api\/routing"/, 'iOS does not send the mode and each rule’s kind of work and member');
  assert.match(ANDROID, /\.forEach \{ \w+\.put\(JSONObject\(\)\.put\("workType", it\.workType\)\.put\("member", it\.member\)\) \}\s*\w+\(send\("PUT", "\/api\/routing", JSONObject\(\)\.put\("mode", \w+\)\.put\("rules", \w+\)\)\)/, 'Android does not send the mode and each rule’s kind of work and member');
  for (const [name, src, title] of /** @type {const} */ ([['iOS', IOS, '.navigationTitle("Routing")'], ['Android', ANDROID, 'FullScreen(title = "Routing"']])) {
    const page = screen(src, title);
    const text = src.slice(page.from, page.to);
    // The whole draft goes, the mode with the list, in one request: the
    // fleet replaces its list with the one it is given.
    const sends = [...text.matchAll(/\.(\w+)\((?:mode: )?(\w+), (?:rules: )?(\w+)\)/g)];
    assert.equal(sends.length, 1, `${name}’s Routing page saves from ${sends.length} places`);
    const [, , mode, rules] = sends[0];
    // What is sent is what is drawn: the same list the rows are made from,
    // and the same mode the mark is on.
    assert.match(text, new RegExp(`\\b${rules}\\b[^\\n]*(?:enumerated\\(\\)|forEachIndexed)`), `${name} draws one list of rules and sends another`);
    assert.match(text, new RegExp(`\\b${mode} == \\w+`), `${name} marks one mode and sends another`);
    // The fleet's sentence, whichever way it answered, and a sentence of
    // the phone's own only when the fleet sent none.
    assert.match(text, /= \w+\.text (?:\?\? \(\w+\.ok == true \? "Saved\." : |\?: if \(\w+\.ok == true\) "Saved\." else )"Your fleet refused that\."/, `${name} does not show what the fleet said of a save`);
    // A refusal keeps the draft: the page takes the fleet's record only
    // from an answer that carried one.
    assert.match(text, /(?:guard \w+\.ok == true, let \w+ = \w+\.routing else \{ return \}|if \(\w+\.ok == true && \w+ != null\) \{)/, `${name} replaces the draft with whatever a refusal carried`);
  }
});

test('the Routing page draws a control only for an admin, and the fleet says who is one (C-2)', () => {
  for (const [name, src, title, control, admin] of /** @type {const} */ ([
    ['iOS', IOS, '.navigationTitle("Routing")', IOS_CONTROL, /(\w+) = \w+\.you\?\.admin == true/],
    ['Android', ANDROID, 'FullScreen(title = "Routing"', ANDROID_CONTROL, /(\w+) = \w+\.admin == true/],
  ])) {
    const page = screen(src, title);
    const text = src.slice(page.from, page.to);
    // Whether this person is an admin is the fleet's answer and nothing else.
    const isAdmin = named(text, admin, `${name}’s Routing page does not take “admin” from the fleet’s answer`);
    assert.equal(places(text, new RegExp(`\\b${isAdmin} = (?!false\\b)`)).length, 1, `${name}’s Routing page decides who is an admin somewhere other than the fleet’s answer`);
    const gate = new RegExp(`^if \\(?${isAdmin}\\)? \\{$`);
    // On Android a control can be a composable of this file's own.
    const own = name === 'Android'
      ? [...src.matchAll(/^private fun (\w+)\(/gm)].map((m) => m[1]).filter((fn) => ANDROID_CONTROL.test(bodyOf(src, fn)))
      : [];
    const calls = own.length ? new RegExp(`${control.source}|\\b(?:${own.join('|')})\\(`) : control;
    const found = places(text, calls).map((p) => p + page.from).filter((p) => !isComment(src.slice(src.lastIndexOf('\n', p - 1) + 1, p + 1)));
    // Loading again is everybody's. Everything else is an admin's.
    const settings = found.filter((p) => !src.slice(p, p + 80).includes('"Try again"'));
    assert.ok(settings.length >= 5, `${name}’s Routing page has ${settings.length} controls; the search for them is broken`);
    for (const p of settings) {
      const line = src.slice(src.lastIndexOf('\n', p - 1) + 1, src.indexOf('\n', p)).trim();
      assert.ok(alwaysUnder(src, p, gate), `${name} draws a control on the Routing page for somebody who is not an admin: ${line}`);
    }
    // And the one who is not an admin is told who sets it.
    const told = only(src, 'An admin sets this. Anybody can read it.', name);
    assert.ok(alwaysUnder(src, told, new RegExp(`^if \\(?!${isAdmin}\\)? `)), `${name} tells an admin that an admin sets this`);
  }
  // `admin` is read off `you` in the answer on Android, where the reply is parsed by hand.
  assert.match(ANDROID, /admin = \w+\(\w+\.optJSONObject\("you"\), "admin"\)/, 'Android does not read you.admin off the answer');
});

test('loading, could not load and no routing on this fleet are three different screens, and none of them is “Off” (C-5)', () => {
  // An answer with no record: its sentence when it has one, and otherwise a
  // fleet from before routing. Neither is drawn as a mode nobody sent.
  assert.match(IOS, /guard \w+\.ok != false, let \w+ = \w+\.routing else \{(?:(?!\n            \})[\s\S])*?if let (\w+) = \w+\.text, !\1\.isBlank \{\s*\w+ = \.failed\(\1\)\s*\} else \{\s*\w+ = \.absent\s*\}\s*return\s*\}/, 'iOS draws an answer with no routing record as a setting');
  assert.match(ANDROID, /if \(\w+\.ok == false \|\| \w+ == null\) \{(?:(?!\n        \})[\s\S])*?if \((\w+) != null\) \w+ = \1 else \w+ = true\s*return@LaunchedEffect\s*\}/, 'Android draws an answer with no routing record as a setting');
  for (const [name, src] of BOTH) {
    // Not on this fleet is said calmly: it is not a failure.
    const at = only(src, 'Routing is not on this fleet yet. It may need an update.', name);
    assert.doesNotMatch(src.slice(at, at + 200).split('\n').slice(0, 3).join('\n'), /Palette\.bad/, `${name} says a fleet from before routing in the colour of a failure`);
    const failed = only(src, 'Could not load the routing.', name);
    assert.match(src.slice(failed, failed + 200), /Palette\.bad/, `${name} does not say a failure to load as one`);
  }
});

test('the members to choose among are buttons only while the task waits, and pressing one sends that member to the task’s route', () => {
  // What the route is sent: a member when there is one, and nothing at all
  // when there is not.
  assert.match(bodyOf(IOS, I_ROUTE), /var \w+: \[String: Any\] = \[:\]\s*if let member, !member\.isEmpty \{ \w+\["member"\] = member \}/, 'iOS does not send { member } and only { member }');
  assert.match(bodyOf(ANDROID, A_ROUTE), /val \w+ = JSONObject\(\)\s*if \(!member\.isNullOrBlank\(\)\) \w+\.put\("member", member\)/, 'Android does not send { member } and only { member }');

  for (const [name, src, send] of /** @type {const} */ ([['iOS', IOS, I_SEND], ['Android', ANDROID, A_SEND]])) {
    const at = only(src, '"Choose a member"', name);
    // While the fleet waits, and under the test Reassign uses on the same
    // page: an open task nobody holds. An answer is an assignment by hand.
    const reassign = paths(src, only(src, '("Reassign")', name))[0].find((head) => /^if\b/.test(head)) ?? '';
    assert.match(reassign, /lock == n(?:il|ull)\b.*state == "open"/, `${name}’s Reassign is no longer drawn for an open task nobody holds; this test reads its condition`);
    for (const need of [/\bhow == "waiting"/, /assignee\b[^,&]*(?:isEmpty|isNullOrBlank)/, /lock == n(?:il|ull)\b/, /state == "open"/]) {
      assert.ok(alwaysUnder(src, at, new RegExp(`^if\\b.*${need.source}`)), `${name} offers the members to choose among without ${need}`);
    }
    // Each candidate is a button that sends that candidate, and nothing else does.
    const loop = /candidates[^\n]*\{ (\w+) (?:in|->)\n/.exec(src.slice(at - 2600, at + 2600));
    assert.ok(loop, `${name} does not draw the candidates`);
    const candidate = loop[1];
    const around = src.slice(at - 2600, at + 2600);
    assert.match(around, new RegExp(`candidates[^\\n]*\\{ ${candidate} (?:in|->)\\n[\\s\\S]{0,420}?\\b${send}\\((?:member: )?${candidate}\\)`), `${name}’s candidate buttons do not send the candidate`);
    assert.equal(count(src, `${send}(`), 3, `${name} sends to a task’s route from somewhere other than a candidate and Route it`);
    // Somebody else opens the picker Reassign opens.
    const other = only(src, '"Somebody else"', name);
    assert.ok(alwaysUnder(src, other, /\bhow == "waiting"/), `${name} offers Somebody else on a task that is not waiting`);
  }
  assert.match(IOS, /NavigationLink\("Somebody else"\) \{\s*(\w+)\([\s\S]{0,12000}?NavigationLink\("Reassign"\) \{\s*\1\(/, 'iOS’s Somebody else does not open the Reassign picker');
  assert.match(ANDROID, /OpenRow\("Somebody else"\) \{ (\w+) = true \}[\s\S]{0,9000}?OpenRow\("Reassign"\) \{ \1 = true \}/, 'Android’s Somebody else does not open the Reassign picker');
  // A candidate is a target a thumb can hit, with its role under its name.
  assert.match(IOS, /candidates[^\n]*\{ \w+ in\n[\s\S]{0,900}?\.role[\s\S]{0,300}?minHeight: 44/, 'iOS’s candidate is not 44pt with its role');
  const aButton = named(ANDROID, /candidates\.forEach \{ \w+ ->\s*(\w+)\(/, 'Android does not draw the candidates');
  assert.match(bodyOf(ANDROID, aButton), /heightIn\(min = 48\.dp\)[\s\S]*role/, 'Android’s candidate is not 48dp with its role');
  assert.match(ANDROID, /candidates\.forEach \{ (\w+) ->\s*\w+\([\s\S]{0,200}?role = \w+\.firstOrNull \{ it\.id == \1 \}\?\.role/, 'Android does not say a candidate’s role');
});

test('Route it is drawn only for an open task nobody holds, with no member, that is not already waiting and whose own routing is not off (C-2)', () => {
  for (const [name, src, send] of /** @type {const} */ ([['iOS', IOS, I_SEND], ['Android', ANDROID, A_SEND]])) {
    const at = only(src, '"Route it"', name);
    // The last of these is the task's own mode: the fleet refuses to route
    // a task marked off whatever its own setting is, so the button for it
    // would only ever be refused.
    for (const need of [/lock == n(?:il|ull)\b/, /state == "open"/, /assignee\b[^,&]*(?:isEmpty|isNullOrBlank)/, /\bhow != "waiting"/, /\brouting != "off"/]) {
      assert.ok(alwaysUnder(src, at, new RegExp(`^if\\b.*${need.source}`)), `${name} offers Route it without ${need}`);
    }
    // It asks with no member: the fleet decides.
    assert.match(src.slice(at - 120, at + 120), new RegExp(`\\b${send}\\((?:member: )?n(?:il|ull)\\)`), `${name}’s Route it names a member`);
  }
});

test('what the fleet says of a route is the line on the task’s page, a refusal’s sentence included', () => {
  // The answer goes where Release, Accept and Cancel send theirs, which
  // test/tasks-in-apps.test.js holds to showing the fleet's sentence.
  const iShown = named(IOS, /(\w+)\(try await [^\n]*\.actOnTask\(id: id, action: action\)\)/, 'iOS’s task page no longer shows an action’s answer; this test reads where');
  const aShown = named(ANDROID, /\.actOnTask\(id, action\)\s*\.onSuccess \{ (\w+)\(it\) \}/, 'Android’s task page no longer shows an action’s answer; this test reads where');
  assert.match(bodyOf(IOS, I_SEND), new RegExp(`${iShown}\\(try await [^\\n]*\\.${I_ROUTE}\\(id: id, member: member\\)\\)`), 'iOS does not show what the fleet said of a route');
  assert.match(bodyOf(ANDROID, A_SEND), new RegExp(`\\.${A_ROUTE}\\(id, member\\)\\s*\\.onSuccess \\{ ${aShown}\\(it\\) \\}`), 'Android does not show what the fleet said of a route');
  // A request that got no answer at all says why, as a failure.
  assert.match(bodyOf(IOS, I_SEND), /catch \{\s*\w+ = true\s*\w+ = error\.localizedDescription/, 'iOS says nothing when a route could not be asked for');
  assert.match(bodyOf(ANDROID, A_SEND), /\.onFailure \{\s*\w+ = true\s*\w+ = it\.message \?: /, 'Android says nothing when a route could not be asked for');
});

test('New task sends `routing` as the choice says: off for Nobody, the mode named for the fleet, none for “As your fleet is set” or a member; Edit sends it either way', () => {
  for (const [name, src, chooses, whose, write, assignee, asFleet] of /** @type {const} */ ([
    ['iOS', IOS, /Text\("Let the fleet choose"\)\.tag\((\w+)\)/, /Picker\("Assignee", selection: \$(\w+)\) \{\s*Text\("Nobody"\)\.tag\(""\)/, /\["routing"\] = /, /\["assignee"\] = /, /Text\((\w+)\)\.tag\(""\)/],
    ['Android', ANDROID, /"Let the fleet choose"[^\n]*== (\w+)\) \{ \w+ = \1 \}/, /"Nobody", role = null, selected = (\w+)\.isEmpty\(\)\) \{ \1 = "" \}\s*(?:\/\/[^\n]*\s*)*if \(\1\.isEmpty\(\)\) Hint\(/, /\.put\("routing", /, /\.put\("assignee", /, /\w+\((\w+), role = null, selected = \w+\.isEmpty\(\)\) \{ \w+ = "" \}/],
  ])) {
    // The choice beside the members and Nobody, and what it sets. Nobody is
    // the empty choice of the same field.
    const fleet = named(src, chooses, `${name}’s New task has no “Let the fleet choose”`);
    const chosen = named(src, whose, `${name}’s New task does not offer Nobody as the empty choice`);
    const isFleet = new RegExp(`^if .*\\b${chosen} == ${fleet}\\b`);
    const notFleet = new RegExp(`^else of: if .*\\b${chosen} == ${fleet}\\b`);
    const isNobody = new RegExp(`^(?:\\} else )?if \\(?${chosen}\\.isEmpty\\b`);
    const writes = places(src, write);
    assert.equal(writes.length, 3, `${name} writes a task’s routing from ${writes.length} places; the fleet choosing, Nobody and Edit are the three`);
    const says = (/** @type {number} */ p) => src.slice(p, src.indexOf('\n', p));

    // The fleet choosing: under that choice, and under a mode having been named.
    const made = writes.filter((p) => alwaysUnder(src, p, isFleet));
    assert.equal(made.length, 1, `${name}’s New task sends a mode without the fleet being asked to choose`);
    assert.ok(alwaysUnder(src, made[0], /^if .*(?:!\w+\.isEmpty\b|\.isNotEmpty\(\))/), `${name}’s New task sends routing for “As your fleet is set”`);
    assert.doesNotMatch(says(made[0]), /"off"|"manual"|"auto"/, `${name}’s New task sends a mode of its own in place of the one that was picked`);

    // NOBODY MEANS NOBODY: off, with nothing else deciding whether it goes,
    // so a fleet whose routing is on leaves the task alone.
    const off = writes.filter((p) => /= "off"$|, "off"\)$/.test(says(p)));
    assert.equal(off.length, 1, `${name}’s New task does not send routing off for Nobody`);
    const offPath = paths(src, off[0])[0];
    assert.ok(isNobody.test(offPath[0]), `${name} sends routing off under something other than Nobody being chosen: ${offPath[0]}`);
    assert.ok(alwaysUnder(src, off[0], notFleet), `${name} sends routing off with the fleet asked to choose`);

    // A member: the member, and no mode. The assignee is the other side of
    // both choices, and no write of routing sits there with it.
    const given = places(src, assignee).filter((p) => alwaysUnder(src, p, notFleet));
    assert.equal(given.length, 1, `${name}’s New task can send a member with a task the fleet is to place`);
    assert.ok(alwaysUnder(src, given[0], new RegExp(`^else of: if \\(?${chosen}\\.isEmpty\\b`)), `${name}’s New task can send a member for Nobody`);
    const beside = writes.filter((p) => alwaysUnder(src, p, new RegExp(`^else of: if \\(?${chosen}\\.isEmpty\\b`)));
    assert.equal(beside.length, 0, `${name}’s New task sends a mode with a named member`);

    // "As your fleet is set" is the empty choice, which is what is not sent.
    const words = named(src, /(\w+) = "As your fleet is set"/, `${name} lost “As your fleet is set”`);
    const empties = [...src.matchAll(new RegExp(asFleet.source, 'g'))].filter((m) => m[1] === words);
    assert.equal(empties.length, 2, `${name} does not offer “As your fleet is set” as the empty choice on New task and on Edit`);

    // Edit: the third write, with no condition of its own, so empty goes
    // too. Empty is how a task follows the fleet's setting again, and Edit
    // is where a task made for Nobody is given back to routing.
    const edited = writes.filter((p) => !made.includes(p) && !off.includes(p));
    assert.equal(edited.length, 1, `${name}’s Edit does not send the task’s routing`);
    assert.ok(!paths(src, edited[0])[0].slice(0, 1).some((head) => /isEmpty|isNotEmpty/.test(head)), `${name}’s Edit cannot put a task back to following the fleet`);
    assert.ok(alwaysUnder(src, edited[0], /\bif (?:let \w+|\(\w+ != null\)) \{$/), `${name}’s Edit does not send the task’s routing`);

    // What Nobody means is said under the choice, while it is the choice.
    const told = only(src, 'It stays with nobody until somebody assigns it or changes its routing.', name);
    assert.ok(isNobody.test(paths(src, told)[0][0]), `${name} says a task stays with nobody when Nobody is not the choice`);
  }
  // Under "Let the fleet choose": as the fleet is set, Ask me, Choose for
  // me. Off is not there; Edit has all three modes.
  assert.match(IOS, /if \w+ == \w+ \{\s*Picker\("How", selection: \$\w+\) \{\s*Text\(\w+\)\.tag\(""\)\s*Text\(\w+\("manual"\)\)\.tag\("manual"\)\s*Text\(\w+\("auto"\)\)\.tag\("auto"\)\s*\}/, 'iOS does not ask how under Let the fleet choose');
  assert.match(ANDROID, /if \(\w+ == \w+\) \{\s*Text\("How",[^\n]*\n\s*\w+\(\w+, role = null, selected = \w+\.isEmpty\(\)\) \{ \w+ = "" \}\s*\w+\(\w+\("manual"\), role = null, selected = \w+ == "manual"\) \{ \w+ = "manual" \}\s*\w+\(\w+\("auto"\), role = null, selected = \w+ == "auto"\) \{ \w+ = "auto" \}\s*\}/, 'Android does not ask how under Let the fleet choose');
});

test('a task that waits for a member says so on its row, says “you” only to whoever was asked, and comes forward with the ones that came back', () => {
  for (const [name, src, waits, asks] of /** @type {const} */ ([['iOS', IOS, I_WAITS, I_ASKS], ['Android', ANDROID, A_WAITS, A_ASKS]])) {
    // Waiting is the fleet's last decision on an open task nobody has.
    const rule = bodyOf(src, waits);
    for (const need of [/state == "open"/, /\bhow == "waiting"/, /assignee\b[^&]*(?:isEmpty|isNullOrBlank)/]) assert.match(rule, need, `${name} calls a task waiting without ${need}`);
    // "You" is said only when the address the fleet asked is this person's.
    const you = only(src, '"Open, waiting for you to choose a member"', name);
    assert.ok(alwaysUnder(src, you, /^if\b.*\basked\b.*==/), `${name} says “you” to somebody the fleet did not ask`);
    assert.ok(alwaysUnder(src, you, new RegExp(`\\b${waits}\\(`)), `${name} says a task waits on you when it does not wait`);
    const somebody = only(src, '"Open, waiting for a member to be chosen"', name);
    assert.ok(alwaysUnder(src, somebody, new RegExp(`\\b${waits}\\(`)), `${name} says a task waits when it does not`);
    // It is said before "assigned to nobody", which is also true of it.
    assert.ok(you < src.indexOf('"Open, assigned to nobody"') && somebody < src.indexOf('"Open, assigned to nobody"'), `${name} says a waiting task is only assigned to nobody`);
    // The attention colour, on the row and on the page, for a task that is
    // asking and for no other; the words beside it say the same.
    const tinted = places(src, new RegExp(`\\(?${asks}\\(\\w+\\)\\)? (?:\\? )?Design\\.Palette\\.attention`));
    assert.equal(tinted.length, 2, `${name} does not bring a task that is asking forward on its row and on its page`);
    assert.doesNotMatch(src, /state == "returned"\)? (?:\? )?Design\.Palette\.attention/, `${name} still brings forward only the tasks that came back`);
  }
  // The address the fleet asked is compared with this person's, in one case.
  assert.match(IOS, /let (\w+) = \(\w+\.route\?\.asked \?\? ""\)\.lowercased\(\)\s*if !(\w+)\.isEmpty, \1 == \2 \{ return "Open, waiting for you/, 'iOS does not compare whom the fleet asked with this person');
  assert.match(IOS, /\.signedInAs\.trimmingCharacters\(in: \.whitespacesAndNewlines\)\.lowercased\(\)/, 'iOS does not know this person’s address');
  assert.match(ANDROID, /if \((\w+)\.isNotEmpty\(\) && \w+\.route\?\.asked\?\.lowercase\(\) == \1\) \{\s*"Open, waiting for you/, 'Android does not compare whom the fleet asked with this person');
  assert.match(ANDROID, /\.signedInAs\.trim\(\)\.lowercase\(\)/, 'Android does not know this person’s address');
  // The list: the ones asking first, the rest in the order they came.
  assert.match(IOS, new RegExp(`let (\\w+) = (\\w+)\\.filter \\{ ${I_ASKS}\\(\\$0\\) \\}\\s*let (\\w+) = \\2\\.filter \\{ !${I_ASKS}\\(\\$0\\) \\}[\\s\\S]{0,260}?\\{ \\w+ = \\1 \\+ \\3 \\}`), 'iOS does not bring the tasks that are asking to the top of the list');
  assert.match(ANDROID, new RegExp(`\\w+ = (\\w+)\\.filter \\{ ${A_ASKS}\\(it\\) \\} \\+ \\1\\.filterNot \\{ ${A_ASKS}\\(it\\) \\}`), 'Android does not bring the tasks that are asking to the top of the list');
});

test('the three new kinds of news have a label in Recent activity, the same on both phones', () => {
  for (const [kind, label] of [['task.routed', 'Task routed'], ['task.needs-member', 'Task needs a member'], ['routing.changed', 'Routing changed']]) {
    for (const [name, src] of BOTH) {
      assert.match(src, new RegExp(`"${literal(kind)}"[^"\\n]{1,6}"${label}"`), `${name} has no label for ${kind}`);
    }
  }
});

test('a notification about a task that needs a member opens that task’s page, by an id held to a task’s shape', () => {
  // `kind` is `task` and `taskId` names it (core.js, the push in #askPerson).
  assert.match(IOS, /if kind == "task", let (\w+) = \w+\["taskId"\] as\? String, (\w+)\(\w+ \+ \1\) != nil \{\s*return open\(task: \1\)/, 'iOS does not open the task a notification names');
  assert.match(ANDROID, /getStringExtra\("kind"\) != "task"\) return null\s*return (\w+)\(\w+ \+ \w+\.getStringExtra\("taskId"\)\.orEmpty\(\)\)/, 'Android does not open the task a notification names');
  // The id ends up in a request's path, and on Android any app can send the
  // extras, so it is letters and digits or it is nothing.
  const iId = named(IOS, /"task", let \w+ = \w+\["taskId"\] as\? String, (\w+)\(/, 'iOS does not check the id');
  const aId = named(ANDROID, /"task"\) return null\s*return (\w+)\(/, 'Android does not check the id');
  assert.match(bodyOf(IOS, iId), /allSatisfy\(\{ \$0\.isASCII && \(\$0\.isLetter \|\| \$0\.isNumber\) \}\)/, 'iOS lets any text through as a task’s id');
  assert.match(ANDROID, /private val (\w+) = Regex\("\[A-Za-z0-9\]\{1,24\}"\)/, 'Android lets any text through as a task’s id');
  assert.match(bodyOf(ANDROID, aId), /\.takeIf \{ \w+\.matches\(it\) \}/, 'Android lets any text through as a task’s id');
  // And the page it opens is the task's own, asked for by that id.
  assert.match(IOS, /if let (\w+) = \w+\(\w+\) \{\s*TaskView\(settings: settings, id: \1\)/, 'iOS opens something other than the task');
  assert.match(ANDROID, /\w+\(\w+\)\?\.let \{ (\w+) ->\s*TaskPage\(\s*settings = settings,\s*id = \1,/, 'Android opens something other than the task');
});

test('Routing is reached from Organization by everybody', () => {
  for (const [name, src, row, admin] of /** @type {const} */ ([
    ['iOS', IOS, 'NavigationLink("Routing")', /^if \(?isAdmin\b/],
    ['Android', ANDROID, 'OpenRow("Routing")', /^if \(?isAdmin\b/],
  ])) {
    const at = only(src, row, name);
    // The row is not an admin's alone: reading the setting is everybody's.
    assert.ok(!paths(src, at).some((chain) => chain.some((head) => admin.test(head))), `${name} offers Routing to an admin only`);
    // And it sits on the Organization, drawn once that has loaded.
    const org = name === 'iOS' ? screen(src, '.navigationTitle("Organization")') : screen(src, 'FullScreen(title = "Organization"');
    assert.ok(at > org.from && at < org.to, `${name}’s Routing is not reached from Organization`);
  }
});
