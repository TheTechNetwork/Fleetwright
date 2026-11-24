// The two phones say the same thing about budgets and approvals
// (docs/budgets.md), in the fleet's own sentences, offer a control only
// where the fleet would take it, and send what the fleet reads.
//
//   node --test test/budgets-in-apps.test.js
//
// A read of the sources, not a run: the Swift and the Kotlin compile only in
// CI. What a build cannot check is what this holds:
//
//   1. THE SENTENCE IS THE FLEET'S. What a member has spent is `words`, and
//      it can be a floor ("At least …"), told only to whoever may see it. A
//      phone that rebuilt the line from a number would say a floor as a
//      total, so neither phone keeps a number it could rebuild one from.
//   2. A CONTROL IS DRAWN ONLY WHERE THE FLEET WOULD TAKE IT (C-2): Approve
//      and Decline for an approval that is waiting and that the fleet says
//      is this person's to answer; the rules' controls for an admin; Approve
//      and start where the fleet says the approval is theirs to give.
//   3. WHAT IS SENT IS WHAT THE FLEET READS: `approve` or `decline` to an
//      approval's route, a note only when there is one, the three settings
//      on a save, and after Approve and start one approval and one start.
//   4. THE OTHER PHONE USES THE SAME WORDS, for the three choices at a
//      budget and the line under each, for where an approval stands, and
//      for every way a page has nothing to draw.
//
// HOW A CONDITION IS READ. As test/routing-in-apps.test.js reads one: a
// control's condition is whatever opens the blocks it sits in, and both apps
// are indented four spaces a block, so `under` reads those headers off the
// indentation and follows a view's function to where it is called. A name a
// rule depends on is found first, from the words a person sees beside it or
// the wire's own field, and matched as found. So renaming a function changes
// nothing here, and removing the rule does.
//
// What the coordinator counts, gates and answers is its own tests' business
// (test/budgets.test.js, test/budgets-coordinator.test.js).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { iosSources } from './helpers/ios-sources.js';
import { androidSources } from './helpers/android-sources.js';
import {
  APPROVAL_STATES, APPROVAL_USE_MS, BUDGET_MODES, MAX_APPROVAL_NOTE, MAX_RISKY_WORK_TYPES, approvalNeeded, spendWords,
} from '../src/fleet/protocol/budgets.js';

const IOS = iosSources();
const ANDROID = androidSources();
const BOTH = /** @type {const} */ ([['iOS', IOS], ['Android', ANDROID]]);
const CORE = readFileSync(new URL('../src/fleet/coordinator/core.js', import.meta.url), 'utf8');

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
/** A source with its comment lines taken out, so a word in a comment is not read as code. @param {string} text */
const code = (text) => text.split('\n').filter((line) => !isComment(line)).join('\n');
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
 * A function's text, from its declaration to the line that ends it, without
 * its comment lines.
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
  return code(out.join('\n'));
}

/**
 * The top-level declaration a place is set in, from its own line to the line
 * that closes it.
 * @param {string} src @param {number} at
 */
function declarationAt(src, at) {
  const chain = under(src, at);
  const from = chain.length ? chain[chain.length - 1].at : src.lastIndexOf('\n', at - 1) + 1;
  const close = src.indexOf('\n}\n', at);
  return { from, to: close < 0 ? src.length : close };
}

/**
 * The screen that carries a title: the top-level declaration it is set in.
 * @param {string} src @param {string} title  the title as the source writes it
 */
function screen(src, title) {
  const page = declarationAt(src, only(src, title, 'the app'));
  return { ...page, text: src.slice(page.from, page.to) };
}

// What draws something a person can press or type into, on each phone.
const IOS_CONTROL = /\b(?:Button|Picker|TextField|SecureField|Toggle|Stepper|NavigationLink)\s*[({]/;
const ANDROID_CONTROL = /\b(?:OutlinedButton|TextButton|Button|IconButton|OutlinedTextField|TextField|RadioButton|Switch|Checkbox|FilterChip|OpenRow)\(|\.(?:selectable|clickable|toggleable)\(/;

// The two pages, by the titles a person reads.
const I_APPROVALS = screen(IOS, '.navigationTitle("Approvals")');
const A_APPROVALS = screen(ANDROID, 'FullScreen(title = "Approvals"');
const I_RULES = screen(IOS, '.navigationTitle("What needs approval")');
const A_RULES = screen(ANDROID, 'FullScreen(title = "What needs approval"');

// Names the rules below depend on, each found from the wire's field or the
// words beside it.
/** Whether an approval is asking this person: waiting, and the fleet says it is theirs to answer. */
const I_ASKS = named(IOS, /func (\w+)\(_ \w+: Fleet\.Approval\) -> Bool \{\s*\w+\.state == "waiting" && \w+\.mayAnswer == true\s*\}/, 'iOS has no one test of whether an approval is waiting on this person');
const A_ASKS = named(ANDROID, /fun (\w+)\(\w+: Fleet\.Approval\): Boolean = \w+\.state == "waiting" && \w+\.mayAnswer\n/, 'Android has no one test of whether an approval is waiting on this person');
/** The function that posts an answer to an approval's route. */
const I_ANSWER = named(IOS, /func (\w+)\([^)]*\) async throws -> \w+ \{(?:(?!\n    \})[\s\S])*?"\/api\/approvals\/\\\(id\)"/, 'iOS never answers an approval');
const A_ANSWER = named(ANDROID, /fun (\w+)\([^)]*\)[^\n]*\{(?:(?!\n    \})[\s\S])*?"\/api\/approvals\/\$id"/, 'Android never answers an approval');
/** The function that lists the approvals. */
const I_LIST = named(IOS, /func (\w+)\(\) async throws -> \w+ \{\s*try [^\n]*get\("\/api\/approvals"\)/, 'iOS never lists the approvals');
const A_LIST = named(ANDROID, /fun (\w+)\(\)[^\n]*\{\s*runCatching \{\s*val \w+ = get\("\/api\/approvals"\)/, 'Android never lists the approvals');
/** What reads a task's id from outside the app as a task's id or not at all, found where a notification's `taskId` is read. */
const I_TASK_ID = named(IOS, /let \w+ = info\["taskId"\] as\? String, (\w+)\(/, 'iOS no longer checks a task’s id from a notification; this test reads which function does');
const A_TASK_ID = named(ANDROID, /return (\w+)\(\w+ \+ intent\.getStringExtra\("taskId"\)\.orEmpty\(\)\)/, 'Android no longer checks a task’s id from a notification; this test reads which function does');
/** What a start's refusal for approval is kept as: the type iOS makes from a reply, the function Android calls with one. */
const I_REFUSED = named(IOS, /struct (\w+)[^\n]*\{(?:(?!\n\})[\s\S])*?init\?\(_ \w+: Fleet\.Reply\) \{/, 'iOS keeps no start that was refused for approval');
const A_REFUSED = named(ANDROID, /fun (\w+)\(\w+: StartRequest, \w+: Fleet\.Reply, \w+: String\): \w+\? \{/, 'Android keeps no start that was refused for approval');

test('a member’s spend is the fleet’s sentence, and neither phone keeps a figure it could rebuild one from', () => {
  // The sentence the phones are sent, so what follows is read off what the
  // fleet prints: a session that reported no cost makes it a floor.
  const floor = spendWords({ usd: 3, unknown: ['a', 'b'] }, 50);
  assert.match(floor, /^At least \$3\.00 of \$50\.00 this month, /, 'the fleet no longer says a floor as “At least”; this test reads its sentence');

  // What a phone keeps of one member's spending: who, whether it is over,
  // and the sentence. No number, so no line can be built from one.
  const iKept = named(IOS, /struct \w+: Codable, Hashable \{\s*let member: String\?\n((?:(?!\n    \})[\s\S])*?let words: String\?)\n    \}/, 'iOS keeps no sentence for what a member has spent');
  assert.doesNotMatch(code(iKept), /\b(?:Double|Int|Decimal|Float)\b|\busd\b|unknownSessions|budgetUsdMonth/, 'iOS keeps a figure beside a member’s spend, which a screen could rebuild the sentence from');
  const aKept = named(ANDROID, /data class \w+\(\s*val member: String,\n((?:(?!\n    \))[\s\S])*?val words: String\?,)\n    \)/, 'Android keeps no sentence for what a member has spent');
  assert.doesNotMatch(code(aKept), /\b(?:Double|Long|Int|Float)\b|\busd\b|unknownSessions|budgetUsdMonth/, 'Android keeps a figure beside a member’s spend, which a screen could rebuild the sentence from');
  // And Android, which reads the answer by hand, reads no figure out of it.
  const aParse = named(ANDROID, /\{ (\w+)\(get\("\/api\/budgets"\)\) \}/, 'Android never reads the budgets');
  assert.doesNotMatch(bodyOf(ANDROID, aParse), /"usd"|"unknownSessions"|"budgetUsdMonth"|optDouble/, 'Android reads a figure out of the budgets answer');
  assert.match(bodyOf(ANDROID, aParse), /optString\("words"\)/, 'Android does not read the fleet’s sentence');

  for (const [name, src, line] of /** @type {const} */ ([
    ['iOS', IOS, /Text\("This month"\)(?:(?!\n {8}\})[\s\S])*?Text\((\w+)\(over: \w+\.over == true, words: (\w+)\)\)/],
    ['Android', ANDROID, /Text\("This month",[^\n]*\n\s*(?:\/\/[^\n]*\n\s*)*Text\(\s*(\w+)\(\w+\.over, (\w+)\),/],
  ])) {
    // The line under This month is the sentence, passed whole.
    const m = line.exec(src);
    assert.ok(m, `${name} does not draw the fleet’s sentence under This month`);
    const [, wording, words] = m;
    assert.match(src, new RegExp(`\\b${words} = \\w+\\??\\.words\\b`), `${name} draws something other than the fleet’s \`words\` under This month`);
    // What stands in front of it is words, never a figure.
    const said = bodyOf(src, wording);
    assert.match(said, /"Over budget\. (?:\\\(words\)|\$words)" (?::|else) words/, `${name} changes the fleet’s sentence on the way to the screen`);
    assert.doesNotMatch(said, /format|\d/, `${name} puts a figure of its own into a member’s spend`);
  }
});

test('“Over budget” is said in words before the sentence, and the attention colour is only on a member the fleet says is over', () => {
  for (const [name, src, tint] of /** @type {const} */ ([
    ['iOS', IOS, /\.over == true \? Design\.Palette\.attention : Design\.Palette\.inkDim/],
    ['Android', ANDROID, /if \(\w+\.over\) Design\.Palette\.attention\.now else Design\.Palette\.ink\.now/],
  ])) {
    // The words, once, in front of the sentence and only when the fleet says so.
    const at = only(src, '"Over budget. ', name);
    assert.match(src.slice(at - 40, at), /(?:\bover \? |if \(over\) )$/, `${name} says Over budget of a member the fleet does not say is over`);
    // The colour follows the same answer, and is never all there is.
    const page = only(src, 'Text("This month"', name);
    assert.match(src.slice(page, page + 700), tint, `${name} does not bring a member that is over budget forward, or does it for one that is not`);
  }
});

test('a member the fleet does not list gets no line, loading draws nothing, and a failed load says so', () => {
  // Only the member the fleet listed for this person, found by id. A member
  // who is not in the answer has no line: nothing is put in its place.
  assert.match(IOS, /return \.answered\(\w+\.first \{ \$0\.member == \w+ \}\)/, 'iOS draws spending for a member the fleet did not list');
  assert.match(ANDROID, /= \w+\.firstOrNull \{ it\.member == \w+ \}/, 'Android draws spending for a member the fleet did not list');
  for (const [name, src] of BOTH) {
    assert.doesNotMatch(code(src), /"\$0\.00"|"\$0"/, `${name} writes a zero of its own for a member’s spend`);
    const failed = only(src, '"Spending could not be loaded."', name);
    // Said calmly, as the page says a vault it could not ask: not a broken page.
    assert.doesNotMatch(src.slice(failed, failed + 160), /Palette\.bad/, `${name} says a spend it could not load in the colour of a failure`);
  }
  // While the answer is on its way, nothing: iOS draws an empty view, and
  // Android draws only once one of its two answers is in.
  assert.match(IOS, /case \.asking:\s*EmptyView\(\)\s*case \.failed\(let \w+\):\s*Section \{\s*Text\("Spending could not be loaded\."\)/, 'iOS draws something for a member’s spend before the fleet answered');
  assert.match(ANDROID, /if \((\w+) != null\) \{\s*Text\("Spending could not be loaded\.",[^\n]*\n\s*SelectionContainer \{ Hint\(\1\) \}\s*\} else if \(\w+ != null && \w+ != null\) \{/, 'Android draws something for a member’s spend before the fleet answered');
  // A refusal has a sentence, which is the failure's reason. An answer with
  // no list and no sentence is a fleet from before budgets: no line.
  assert.match(IOS, /guard \w+\.ok != false, let \w+ = \w+\.members else \{(?:(?!\n {8}\})[\s\S])*?if let (\w+) = \w+\.text, !\1\.isBlank \{ return \.failed\(\1\) \}\s*return \.answered\(nil\)/, 'iOS says a fleet from before budgets failed to load a member’s spend');
  assert.match(ANDROID, /if \(\w+\.ok == false \|\| \w+ == null\) \{(?:(?!\n {8}\})[\s\S])*?(\w+) = \w+\.text\s*return@LaunchedEffect\s*\}\s*\w+ = \w+\.firstOrNull/, 'Android says a fleet from before budgets failed to load a member’s spend');
});

test('Approve and Decline are drawn only for an approval that is waiting and that the fleet says is this person’s (C-2)', () => {
  // Whether it may be answered is the fleet's word, read off the wire and
  // set nowhere else.
  assert.match(IOS, /mayAnswer = \(try\? \w+\?\.decodeIfPresent\(Bool\.self, forKey: \.mayAnswer\)\) \?\? nil/, 'iOS does not read mayAnswer off the fleet’s answer');
  assert.match(ANDROID, /mayAnswer = \w+\.optBoolean\("mayAnswer", false\)/, 'Android does not read mayAnswer off the fleet’s answer');
  assert.equal(places(code(IOS), /\bmayAnswer = /).length, 1, 'iOS decides who may answer somewhere other than the fleet’s answer');
  assert.equal(places(code(ANDROID), /\bmayAnswer = /).length, 1, 'Android decides who may answer somewhere other than the fleet’s answer');

  for (const [name, src, page, asks, approve, decline] of /** @type {const} */ ([
    ['iOS', IOS, I_APPROVALS, I_ASKS, /Button\("Approve"\) \{ (\w+) = \w+ \}/, /NavigationLink\("Decline"\) \{/],
    ['Android', ANDROID, A_APPROVALS, A_ASKS, /onClick = \{ (\w+) = \w+ \},\s*modifier = [^\n]*\n\s*\) \{ Text\("Approve"\) \}/, /onClick = \{ (\w+) = \w+ \},\s*modifier = [^\n]*\n\s*\) \{ Text\("Decline"\) \}/],
  ])) {
    const gate = new RegExp(`^if \\(?${asks}\\(\\w+\\)\\)? \\{$`);
    // Approve opens its question, and Decline its page, only under that test.
    const approving = approve.exec(page.text);
    assert.ok(approving, `${name}’s Approvals has no Approve`);
    assert.ok(alwaysUnder(src, page.from + approving.index, gate), `${name} offers Approve on an approval that is not waiting on this person`);
    const declining = decline.exec(page.text);
    assert.ok(declining, `${name}’s Approvals has no Decline`);
    assert.ok(alwaysUnder(src, page.from + declining.index, gate), `${name} offers Decline on an approval that is not waiting on this person`);
    // And the approval the question is about is set from that button alone,
    // so the question is never opened for one that may not be answered.
    const opened = approving[1];
    assert.equal(places(page.text, new RegExp(`\\b${opened} = (?!nil\\b|null\\b)`)).length, 1, `${name} opens Approve’s question from somewhere other than its button`);
  }
  // On Android the Decline page opens the same way, from its button alone.
  const aDeclining = named(A_APPROVALS.text, /onClick = \{ (\w+) = \w+ \},\s*modifier = [^\n]*\n\s*\) \{ Text\("Decline"\) \}/, 'Android’s Approvals has no Decline');
  assert.equal(places(A_APPROVALS.text, new RegExp(`\\b${aDeclining} = (?!null\\b)`)).length, 1, 'Android opens Decline’s page from somewhere other than its button');
});

test('an answer goes to the approval’s own route as approve or decline, with a note only when there is one', () => {
  // The body: the answer, and a note only when one was written.
  assert.match(bodyOf(IOS, I_ANSWER), /var (\w+): \[String: Any\] = \["answer": answer\]\s*if let note, !note\.isBlank \{ \1\["note"\] = note \}\s*return [^\n]*post\("\/api\/approvals\/\\\(id\)", body: \1\)/, 'iOS does not send { answer } and a note only when there is one');
  assert.match(bodyOf(ANDROID, A_ANSWER), /val (\w+) = JSONObject\(\)\.put\("answer", answer\)\s*if \(!note\.isNullOrBlank\(\)\) \1\.put\("note", note\)\s*val \w+ = post\("\/api\/approvals\/\$id", \1\)/, 'Android does not send { answer } and a note only when there is one');
  for (const [name, src, answer] of /** @type {const} */ ([['iOS', IOS, I_ANSWER], ['Android', ANDROID, A_ANSWER]])) {
    // Every place that answers one says approve or decline, in so many
    // words: the question's Approve, Approve and start, and Decline's page.
    const sends = [...src.matchAll(new RegExp(`\\.${answer}\\((?:id: )?\\w+\\.id, (?:answer: )?("\\w+"|\\w+)`, 'g'))].map((m) => m[1]);
    assert.deepEqual([...sends].sort(), ['"approve"', '"approve"', '"decline"'], `${name} answers an approval from ${sends.length} places, or with something other than approve and decline`);
    assert.equal(count(code(src), `.${answer}(`), 3, `${name} answers an approval from somewhere this test does not read`);
  }
  // Decline is the one that carries the note.
  assert.match(IOS, new RegExp(`\\.${I_ANSWER}\\(id: \\w+\\.id, answer: "decline", note: \\w+\\)`), 'iOS’s Decline does not send its note');
  assert.match(ANDROID, new RegExp(`\\.${A_ANSWER}\\(\\w+\\.id, "decline", note\\.trim\\(\\)\\)`), 'Android’s Decline does not send its note');
});

test('Approve asks once, restating the reasons, and says it is for one start within the hour', () => {
  assert.equal(APPROVAL_USE_MS, 60 * 60_000, 'the fleet no longer keeps a given approval for an hour, and both phones say “within the hour”');
  for (const [name, src, page, answer, words, shown] of /** @type {const} */ ([
    ['iOS', IOS, I_APPROVALS, I_ANSWER, /func (\w+)\(_ \w+: Fleet\.Approval\) -> String \{(?:(?!\n\})[\s\S])*?"Approving is for this one start, within the hour\."/, (/** @type {string} */ fn) => new RegExp(`\\.confirmationDialog\\((?:(?!\\n    \\})[\\s\\S])*?Button\\("Approve"\\) \\{ (\\w+)\\(\\w+\\) \\}(?:(?!\\n    \\})[\\s\\S])*?Text\\(${fn}\\(\\w+\\)\\)`)],
    ['Android', ANDROID, A_APPROVALS, A_ANSWER, /fun (\w+)\(\w+: Fleet\.Approval\): String =\s*[^\n]*"Approving is for this one start, within the hour\."/, (/** @type {string} */ fn) => new RegExp(`AlertDialog\\((?:(?!\\n    \\})[\\s\\S])*?text = \\{ Text\\(${fn}\\(\\w+\\)\\) \\},(?:(?!\\n    \\})[\\s\\S])*?\\.(${A_ANSWER})\\(\\w+\\.id, "approve"\\)(?:(?!\\n    \\})[\\s\\S])*?Text\\("Approve"\\)`)],
  ])) {
    // What the question says: each reason as the fleet wrote it, then what
    // an approval is good for.
    const fn = named(src, words, `${name} does not say what approving is for`);
    assert.match(bodyOf(src, fn), /reasons\b[^\n]*(?:compactMap\(\\\.text\)|map \{ it\.text \})/, `${name}’s question does not restate the reasons as the fleet sent them`);
    // The question carries those words, and its Approve is what sends.
    const asked = shown(fn).exec(page.text);
    assert.ok(asked, `${name}’s Approve sends without asking, or asks without the reasons`);
    const sender = asked[1];
    if (sender !== answer) {
      assert.match(bodyOf(src, sender), new RegExp(`\\.${answer}\\(id: \\w+\\.id, answer: "approve"\\)`), `${name}’s question does not send the approval when Approve is pressed`);
      assert.equal(count(code(page.text), `${sender}(`), 2, `${name} approves from somewhere other than the question`);
    }
  }
});

test('Decline takes an optional note, counted in bytes against the fleet’s limit, and says who is told', () => {
  for (const [name, src, counted, waits] of /** @type {const} */ ([
    ['iOS', IOS, /"\\\((\w+)\) of \\\((\w+)\) bytes"\)/, (/** @type {string} */ bytes, /** @type {string} */ limit) => new RegExp(`Button\\([^\\n]*"Decline"\\) \\{[^\\n]*\\}\\s*\\.disabled\\(\\w+ \\|\\| ${bytes} > ${limit}\\)`)],
    ['Android', ANDROID, /"\$(\w+) of \$(\w+) bytes"/, (/** @type {string} */ bytes, /** @type {string} */ limit) => new RegExp(`val (\\w+) = ${bytes} > ${limit}\\n(?:(?!\\n\\}\\n)[\\s\\S])*?enabled = !\\w+ && !\\1,(?:(?!\\n\\}\\n)[\\s\\S])*?"Decline"\\)`)],
  ])) {
    const m = counted.exec(src);
    assert.ok(m, `${name} does not count a decline’s note`);
    const [, bytes, limit] = m;
    // The limit is the fleet's, and the count is in the fleet's unit.
    const max = named(src, new RegExp(`(?:let|const val) ${limit} = (\\d+)\\b`), `${name} has no limit for a decline’s note`);
    assert.equal(Number(max), MAX_APPROVAL_NOTE, `${name} lets a note run to ${max} bytes and the fleet takes ${MAX_APPROVAL_NOTE}`);
    const measure = named(src, new RegExp(`(?:var|val) ${bytes}(?:: Int \\{| =) (\\w+)\\(`), `${name} does not measure the note`);
    assert.match(bodyOf(src, measure), /utf8\.count|toByteArray\(Charsets\.UTF_8\)\.size/, `${name} counts a note in something other than bytes of UTF-8`);
    // Decline waits while the note is over, and never for a note to be written.
    const gate = waits(bytes, limit).exec(src);
    assert.ok(gate, `${name} sends a note the fleet would refuse, or makes the note required`);
    // Past the limit the line says by how much, in the same words on both.
    assert.match(src, /bytes, (?:\\\(\w+ - \w+\)|\$\{\w+ - \w+\}) too many"/, `${name} does not say how far over a note is`);
    const told = only(src, 'Optional. The note is told to the person who asked.', name);
    assert.ok(told > 0, `${name} does not say who reads the note`);
  }
});

test('the list is the ones waiting on you, then your own asks, then the rest behind Finished, and each says where it stands in words', () => {
  // The three groups, by the fleet's own fields. Nothing is in two of them.
  for (const [name, page, asks, mine] of /** @type {const} */ ([
    ['iOS', I_APPROVALS, I_ASKS, /\.filter \{ \$0\.state == "waiting" && \$0\.mayAnswer != true \}/],
    ['Android', A_APPROVALS, A_ASKS, /\.filter \{ it\.state == "waiting" && !it\.mayAnswer \}/],
  ])) {
    assert.match(page.text, new RegExp(`\\.filter \\{ ${asks}\\((?:\\$0|it)\\) \\}`), `${name} does not put the approvals waiting on this person in a group of their own`);
    assert.match(page.text, mine, `${name} does not keep this person’s own waiting asks apart from the ones they may answer`);
    assert.match(page.text, /\.filter \{ (?:\$0|it)\.state != "waiting" \}/, `${name} does not keep the finished ones apart`);
  }
  // Drawn in that order. iOS names each group's sections and lists them;
  // Android draws them down one column.
  const iGroup = (/** @type {string} */ words) => named(I_APPROVALS.text, new RegExp(`private var (\\w+): some View \\{(?:(?!\\n    \\})[\\s\\S])*?${literal(words)}`), `iOS’s Approvals has no ${words}`);
  const [iWaiting, iAsked, iFinished] = [iGroup('("Waiting on you")'), iGroup('("Your asks")'), iGroup('DisclosureGroup("Finished"')];
  assert.match(I_APPROVALS.text, new RegExp(`\\n\\s*${iWaiting}\\n\\s*${iAsked}\\n\\s*if !\\w+\\.isEmpty \\{ ${iFinished} \\}`), 'iOS does not draw waiting on you, then your asks, then Finished');
  const aOrder = ['SectionHead("Waiting on you")', 'SectionHead("Your asks")', 'Text("Finished",'].map((words) => only(A_APPROVALS.text, words, 'Android’s Approvals'));
  assert.deepEqual([...aOrder].sort((a, b) => a - b), aOrder, 'Android does not draw waiting on you, then your asks, then Finished');
  // Finished is closed until somebody opens it.
  assert.match(I_APPROVALS.text, /DisclosureGroup\("Finished", isExpanded: \$(\w+)\)/, 'iOS draws the finished approvals open');
  assert.match(A_APPROVALS.text, /if \((\w+)\) \w+\.forEach \{ \w+ -> \w+\(\w+\) \{ \w+ = it \} \}/, 'Android draws the finished approvals without their row being opened');

  // Where one stands, for each of the fleet's five states, in the same words
  // on both phones; a state from a newer fleet is shown as it was sent.
  const iState = named(IOS, /func (\w+)\([^)]*\) -> String \{(?:(?!\n\})[\s\S])*?case "waiting": return /, 'iOS has no words for where an approval stands');
  const aState = named(ANDROID, /fun (\w+)\([^)]*\): String \{(?:(?!\n\})[\s\S])*?"waiting" -> /, 'Android has no words for where an approval stands');
  for (const [name, said, unknown] of /** @type {const} */ ([['iOS', bodyOf(IOS, iState), /default: return \w+ \?\? ""/], ['Android', bodyOf(ANDROID, aState), /else -> \w+\.orEmpty\(\)/]])) {
    for (const state of APPROVAL_STATES) assert.match(said, new RegExp(`"${state}"(?:: return| ->) `), `${name} has no words for an approval that is ${state}`);
    for (const words of ['"Waiting on you"', '"Waiting for an answer"', ', for one start within the hour"', '"Declined', ' and used"', '"Ran out before it was answered"', ', and ran out before it was used"']) {
      assert.ok(said.includes(words), `${name} lost ${words} from where an approval stands`);
    }
    assert.match(said, unknown, `${name} makes up words for a state it never met`);
    // “You” is said only to somebody the fleet says may answer.
    assert.match(said, /"waiting"(?:: return| ->) (?:if \()?mayAnswer\)? (?:\? )?"Waiting on you" (?::|else) "Waiting for an answer"/, `${name} says an approval waits on somebody the fleet did not say may answer it`);
  }
  // The attention colour is on the ones asking this person, and the words say so too.
  assert.match(I_APPROVALS.text, new RegExp(`let (\\w+) = ${I_ASKS}\\(\\w+\\)(?:(?!\\n    \\})[\\s\\S])*?\\.foregroundStyle\\(\\1 \\? Design\\.Palette\\.attention : Design\\.Palette\\.inkDim\\)`), 'iOS does not bring forward the approvals waiting on this person, or brings others');
  assert.match(ANDROID, new RegExp(`val (\\w+) = ${A_ASKS}\\(\\w+\\)(?:(?!\\n\\}\\n)[\\s\\S])*?color = if \\(\\1\\) Design\\.Palette\\.attention\\.now else Design\\.Palette\\.inkDim\\.now`), 'Android does not bring forward the approvals waiting on this person, or brings others');
});

test('each approval says who asked, every reason as the fleet sent it, and opens its task when it has one', () => {
  // The fleet's own reason for a start past a budget, so the test knows what
  // a reason's sentence is: words with the figures in them, or without, as
  // the fleet chose for whoever is reading.
  const need = approvalNeeded({ settings: { budgets: 'ask', dangerous: false, workTypes: [] }, member: { id: 'debbie', name: 'Debbie', budgetUsdMonth: 50 }, spend: { usd: 51, unknown: [] }, start: { dangerous: false } });
  assert.ok('reasons' in need && need.reasons[0].text.includes('$51.00'), 'the fleet no longer writes a reason as a sentence; this test reads one');

  // Each reason is that sentence and nothing of the phone's own.
  assert.match(I_APPROVALS.text, /ForEach\(\w+\.reasons \?\? \[\], id: \\\.self\) \{ (\w+) in\s*if let (\w+) = \1\.text, !\2\.isEmpty \{\s*Text\(\2\)/, 'iOS does not draw each reason as the fleet sent it');
  assert.match(ANDROID, /\w+\.reasons\.forEach \{ (\w+) ->\s*Text\(\1\.text, /, 'Android does not draw each reason as the fleet sent it');
  for (const [name, src] of BOTH) {
    // Nothing on either phone words a reason by its kind.
    assert.doesNotMatch(code(src), /"over-budget"|"risky-work"/, `${name} writes a reason of its own from its kind`);
    // Who asked is the fleet's `askedBy`, and nobody is named when it is not.
    assert.match(src, /"Asked by (?:\\\(by \?\? ""\)|\$by)"/, `${name} does not say who asked`);
    assert.match(src, /\w+\((?:by: )?\w+\.askedBy, /, `${name} says somebody other than the fleet’s askedBy asked`);
  }
  // The task, only when there is one, by an id read as a task's or not at all.
  const iTask = /NavigationLink\("Task \\\((\w+)\)"\) \{\s*TaskView\(settings: settings, id: \1\)/.exec(I_APPROVALS.text);
  assert.ok(iTask, 'iOS’s approval does not open its task');
  assert.ok(alwaysUnder(IOS, I_APPROVALS.from + iTask.index, new RegExp(`^if let \\w+ = \\w+\\.task, let \\w+ = ${I_TASK_ID}\\(`)), 'iOS offers a task on an approval that has none, or opens one by an id it did not check');
  assert.match(ANDROID, new RegExp(`${A_TASK_ID}\\(\\w+ \\+ \\w+\\.task\\.orEmpty\\(\\)\\)\\?\\.let \\{ (\\w+) ->\\s*OpenRow\\("Task \\$\\1"\\) \\{ (\\w+)\\(\\1\\) \\}`), 'Android offers a task on an approval that has none, or opens one by an id it did not check');
  assert.match(A_APPROVALS.text, /(\w+)\?\.let \{ (\w+) ->\s*TaskPage\(settings = settings, id = \2, onDismiss = \{ \1 = null \}/, 'Android’s approval does not open its task');
});

test('the Approvals page has four different things to say when it has no approvals to draw (C-5)', () => {
  for (const [name, src, page, absent, empty] of /** @type {const} */ ([
    ['iOS', IOS, I_APPROVALS, /guard \w+\.ok != false, let \w+ = \w+\.approvals else \{(?:(?!\n {12}\})[\s\S])*?if let (\w+) = \w+\.text, !\1\.isBlank \{\s*\w+ = \.failed\(\1\)\s*\} else \{\s*\w+ = \.absent\s*\}\s*return\s*\}/, /^if \w+\.isEmpty \{$/],
    ['Android', ANDROID, A_APPROVALS, /if \(\w+\.ok == false \|\| \w+ == null\) \{(?:(?!\n {8}\})[\s\S])*?if \((\w+) != null\) \w+ = \1 else \w+ = true\s*return@LaunchedEffect\s*\}/, /^if \(\w+\.isEmpty\(\)\) \{$/],
  ])) {
    // An answer with no list: its sentence when it has one, and otherwise a
    // fleet from before approvals. Neither is drawn as an empty list.
    assert.match(page.text, absent, `${name} draws an answer with no list of approvals as “none”`);
    const gone = only(src, 'Approvals are not on this fleet yet. It may need an update.', name);
    assert.doesNotMatch(src.slice(gone, gone + 200).split('\n').slice(0, 3).join('\n'), /Palette\.bad/, `${name} says a fleet from before approvals in the colour of a failure`);
    const failed = only(src, 'Could not load the approvals.', name);
    assert.match(src.slice(failed, failed + 200), /Palette\.bad/, `${name} does not say a failure to load as one`);
    // Empty is said of a list the fleet sent, and says what fills it.
    const none = only(src, 'No approvals yet. A start that needs one is listed here.', name);
    assert.ok(alwaysUnder(src, none, empty), `${name} says there are no approvals without having an empty list`);
    assert.ok(page.text.includes('"Loading…"'), `${name}’s Approvals says nothing while it loads`);
    // And with a list but nothing asking this person, it says that.
    const calm = only(src, '"Nothing is waiting on you."', name);
    assert.ok(alwaysUnder(src, calm, /^if \(?\w+\.isEmpty(?:\(\))?\)? /), `${name} says nothing is waiting on this person when something is`);
  }
  // Empty is never said before the fleet answered: on iOS only once loaded,
  // on Android only after the list is in hand.
  const iNone = only(IOS, 'No approvals yet. A start that needs one is listed here.', 'iOS');
  assert.ok(alwaysUnder(IOS, iNone, /^case \.answered:$/), 'iOS says there are no approvals before the fleet answered');
  assert.match(A_APPROVALS.text, /(\w+) == null -> Hint\("Loading…"\)\s*else -> \{/, 'Android says there are no approvals before the fleet answered');
});

test('what happens at a budget is the same three choices on both phones, each with the same line under it', () => {
  const choices = { off: 'Count only', ask: 'Ask first', refuse: 'Refuse' };
  const lines = {
    off: 'Budgets are shown and stop nothing.',
    ask: 'A start past a member’s budget waits for approval.',
    refuse: 'A start past a member’s budget is refused until the month turns or the budget is raised.',
  };
  assert.deepEqual(Object.keys(choices), [...BUDGET_MODES], 'the fleet’s modes are not the three the phones offer, in that order');
  for (const [name, src] of BOTH) {
    for (const mode of BUDGET_MODES) {
      assert.match(src, new RegExp(`"${mode}"[^"\\n]{1,12}"${literal(choices[mode])}"`), `${name} does not offer ${mode} as “${choices[mode]}”`);
      assert.match(src, new RegExp(`"${mode}"[^"\\n]{1,12}"${literal(lines[mode])}"`), `${name} does not say what ${mode} does`);
    }
    // And they are offered in the fleet's order, off first.
    assert.match(src, /= (?:\[|listOf\()"off", "ask", "refuse"[\])]/, `${name} does not offer the choices in the fleet’s order`);
    for (const words of [
      // The other two rules, and what counting is and never does.
      '"Ask before a session that skips permission prompts"',
      'Counting is at API prices, as each session counts its own cost. Sessions already running are not stopped.',
      '"Kinds of work that need approval"',
      'A start on a task of one of these kinds waits for approval.',
      '"No kinds of work yet."',
      '"Add the kind"',
      'A fleet admin sets these. Anybody can read them.',
      '"Not saved yet."',
      // The page's ways of having nothing to draw.
      'Could not load what needs approval.',
      'Budgets are not on this fleet yet. It may need an update.',
      // The row that opens it, and Approvals' own.
      '"What needs approval"',
      '"Waiting on you"',
      '"Your asks"',
      // A start that waits, where the start's answer is.
      '"Approve and start"',
      'Approves this one start and sends it again.',
    ]) {
      assert.ok(src.includes(words), `${name} lost: ${words}`);
    }
  }
  // A choice from a newer fleet is shown as the fleet sent it.
  const iName = named(IOS, /func (\w+)\([^)]*\)[^\n]*\{\s*switch [^\n]*\{\s*case "off": return "Count only"/, 'iOS has no names for the three choices');
  const aName = named(ANDROID, /fun (\w+)\([^)]*\)[^\n]*= when \(\w+\) \{\s*"off" -> "Count only"/, 'Android has no names for the three choices');
  assert.match(bodyOf(IOS, iName), /func \w+\(_ (\w+): String\)(?:(?!\n\})[\s\S])*?default: return \1\n/, 'iOS makes up a name for a choice it never met');
  assert.match(bodyOf(ANDROID, aName), /fun \w+\((\w+): String\)(?:(?!\n\})[\s\S])*?else -> \1\n/, 'Android makes up a name for a choice it never met');
});

test('the rules draw a control only for an admin, and the fleet says who is one (C-2)', () => {
  for (const [name, src, page, control, admin] of /** @type {const} */ ([
    ['iOS', IOS, I_RULES, IOS_CONTROL, /(\w+) = \w+\.you\?\.admin == true/],
    ['Android', ANDROID, A_RULES, ANDROID_CONTROL, /(\w+) = \w+\.admin == true/],
  ])) {
    // Whether this person is an admin is the fleet's answer and nothing else.
    const isAdmin = named(page.text, admin, `${name}’s rules do not take “admin” from the fleet’s answer`);
    assert.equal(places(page.text, new RegExp(`\\b${isAdmin} = (?!false\\b)`)).length, 1, `${name}’s rules decide who is an admin somewhere other than the fleet’s answer`);
    const gate = new RegExp(`^if \\(?${isAdmin}\\)? \\{$`);
    // On Android a control can be a composable of this file's own.
    const own = name === 'Android'
      ? [...src.matchAll(/^private fun (\w+)\(/gm)].map((m) => m[1]).filter((fn) => ANDROID_CONTROL.test(bodyOf(src, fn)))
      : [];
    const calls = own.length ? new RegExp(`${control.source}|\\b(?:${own.join('|')})\\(`) : control;
    const found = places(page.text, calls).map((p) => p + page.from).filter((p) => !isComment(src.slice(src.lastIndexOf('\n', p - 1) + 1, p + 1)));
    // Loading again is everybody's. Everything else is an admin's.
    const settings = found.filter((p) => !src.slice(p, p + 80).includes('"Try again"'));
    assert.ok(settings.length >= 6, `${name}’s rules have ${settings.length} controls; the search for them is broken`);
    for (const p of settings) {
      const line = src.slice(src.lastIndexOf('\n', p - 1) + 1, src.indexOf('\n', p)).trim();
      assert.ok(alwaysUnder(src, p, gate), `${name} draws a control on the rules for somebody who is not an admin: ${line}`);
    }
    // And the one who is not an admin is told who sets them.
    const told = only(src, 'A fleet admin sets these. Anybody can read them.', name);
    assert.ok(alwaysUnder(src, told, new RegExp(`^if \\(?!${isAdmin}\\)? `)), `${name} tells an admin that an admin sets these`);
    // Somebody who is not one still reads the switch, as a word.
    assert.match(page.text, /Text\((?:\w+ \? "On" : "Off"\)|if \(\w+\) "On" else "Off",)/, `${name} shows somebody who is not an admin nothing about the switch`);
  }
  // `admin` is read off `you` in the answer on Android, where the reply is parsed by hand.
  const aParse = named(ANDROID, /\{ (\w+)\(get\("\/api\/budgets"\)\) \}/, 'Android never reads the budgets');
  assert.match(bodyOf(ANDROID, aParse), /admin = \w+\(\w+\.optJSONObject\("you"\), "admin"\)/, 'Android does not read you.admin off the budgets answer');
});

test('Save sends what happens at a budget, the switch and every kind of work, and the fleet’s answer is the line under it', () => {
  // The body, all three in one request.
  assert.match(IOS, /let \w+: \[String: Any\] = \["budgets": budgets, "dangerous": dangerous, "workTypes": workTypes\]\s*return [^\n]*send\("PUT", "\/api\/budgets\/settings"/, 'iOS does not send the choice, the switch and the kinds of work');
  assert.match(ANDROID, /val (\w+) = JSONObject\(\)\.put\("budgets", budgets\)\.put\("dangerous", dangerous\)\.put\("workTypes", JSONArray\(workTypes\)\)\s*\w+\(send\("PUT", "\/api\/budgets\/settings", \1\)\)/, 'Android does not send the choice, the switch and the kinds of work');
  for (const [name, src, page] of /** @type {const} */ ([['iOS', IOS, I_RULES], ['Android', ANDROID, A_RULES]])) {
    const sends = [...page.text.matchAll(/\.(\w+)\((?:budgets: )?(\w+), (?:dangerous: )?(\w+), (?:workTypes: )?(\w+)\)/g)];
    assert.equal(sends.length, 1, `${name}’s rules save from ${sends.length} places`);
    const [, , mode, , kinds] = sends[0];
    // What is sent is what is drawn: the mode the mark is on, and the list
    // the rows are made from.
    assert.match(page.text, new RegExp(`\\b${mode} == \\w+`), `${name} marks one choice and sends another`);
    assert.match(page.text, new RegExp(`(?:ForEach\\(${kinds}, |\\b${kinds}\\.forEach \\{)`), `${name} draws one list of kinds of work and sends another`);
    // The fleet's sentence, whichever way it answered, and a sentence of
    // the phone's own only when the fleet sent none.
    assert.match(page.text, /= \w+\.text (?:\?\? \(\w+\.ok == true \? "Saved\." : |\?: if \(\w+\.ok == true\) "Saved\." else )"Your fleet refused that\."/, `${name} does not show what the fleet said of a save`);
    // A refusal keeps the draft: the page takes the fleet's setting only
    // from an answer that carried one.
    assert.match(page.text, /(?:guard \w+\.ok == true, let \w+ = \w+\.settings else \{ return \}|if \(\w+\.ok == true && \w+ != null\) \w+\(\w+\))/, `${name} replaces the draft with whatever a refusal carried`);
    // At most as many kinds of work as the fleet takes, and no way to add
    // one past that.
    const limit = named(src, /A kind of work is a short word, like deploy or billing\. At most (?:\\\((\w+)\)|\$(\w+))\./, `${name} does not say how many kinds of work there may be`);
    const max = named(src, new RegExp(`(?:let|const val) ${limit} = (\\d+)\\b`), `${name} has no limit for the kinds of work`);
    assert.equal(Number(max), MAX_RISKY_WORK_TYPES, `${name} lets an admin name ${max} kinds of work and the fleet takes ${MAX_RISKY_WORK_TYPES}`);
    const add = only(src, '"Add the kind"', name);
    assert.ok(alwaysUnder(src, add, new RegExp(`^if \\(?\\w+\\.(?:count|size) < ${limit}\\)? \\{$`)), `${name} offers to add a kind of work past the fleet’s limit`);
  }
});

test('the rules have three different things to say when they have no setting to draw, and none of them is “Count only” (C-5)', () => {
  for (const [name, src, page, absent] of /** @type {const} */ ([
    ['iOS', IOS, I_RULES, /guard \w+\.ok != false, let \w+ = \w+\.settings else \{(?:(?!\n {12}\})[\s\S])*?if let (\w+) = \w+\.text, !\1\.isBlank \{\s*\w+ = \.failed\(\1\)\s*\} else \{\s*\w+ = \.absent\s*\}\s*return\s*\}/],
    ['Android', ANDROID, A_RULES, /if \(\w+\.ok == false \|\| \w+ == null\) \{(?:(?!\n {8}\})[\s\S])*?if \((\w+) != null\) \w+ = \1 else \w+ = true\s*return@LaunchedEffect\s*\}/],
  ])) {
    assert.match(page.text, absent, `${name} draws an answer with no setting as a setting`);
    const gone = only(src, 'Budgets are not on this fleet yet. It may need an update.', name);
    assert.doesNotMatch(src.slice(gone, gone + 200).split('\n').slice(0, 3).join('\n'), /Palette\.bad/, `${name} says a fleet from before budgets in the colour of a failure`);
    const failed = only(src, 'Could not load what needs approval.', name);
    assert.match(src.slice(failed, failed + 200), /Palette\.bad/, `${name} does not say a failure to load as one`);
    assert.ok(page.text.includes('"Loading…"'), `${name}’s rules say nothing while they load`);
  }
});

test('a start refused for approval is known by the fleet’s code, and its sentence is what the card shows', () => {
  // By code, never by wording: the two refusals this is about, and no other.
  assert.match(IOS, new RegExp(`struct ${I_REFUSED}[^\\n]*\\{(?:(?!\\n\\})[\\s\\S])*?guard \\w+\\.ok == false, let (\\w+) = \\w+\\.error\\?\\.code, \\1 == "needs_approval" \\|\\| \\1 == "over_budget" else \\{ return nil \\}`), 'iOS takes some other refusal for one about approval');
  assert.match(bodyOf(ANDROID, A_REFUSED), /val (\w+) = \w+\.code \?: return null\s*if \(\w+\.ok \|\| \(\1 != "needs_approval" && \1 != "over_budget"\)\) return null/, 'Android takes some other refusal for one about approval');
  // The approval rides only on the one that waits for it. A start refused at
  // a budget outright has none, and so nothing to press.
  assert.match(IOS, /approval = \w+ == "needs_approval" \? \w+\.approval : nil/, 'iOS keeps an approval for a start the fleet refused outright');
  assert.match(bodyOf(ANDROID, A_REFUSED), /if \(\w+ == "needs_approval"\) \w+\.approval else null/, 'Android keeps an approval for a start the fleet refused outright');
  // The sentence kept is the fleet's `text`, and it is what the card draws.
  assert.match(IOS, /text = \w+\.text \?\? ""\n/, 'iOS keeps something other than the fleet’s text for a refused start');
  assert.match(ANDROID, new RegExp(`= ${A_REFUSED}\\(\\w+, (\\w+), \\1\\.text\\.ifBlank \\{ "Started\\." \\}\\)`), 'Android keeps something other than the fleet’s text for a refused start');
  for (const [name, src, drawn] of /** @type {const} */ ([
    ['iOS', IOS, /Text\(\w+\.text\)\n(?:(?!\n {8}\})[\s\S])*?"Approve and start"/],
    ['Android', ANDROID, /Text\(\w+\.text, style = [^\n]*\n(?:(?!\n {4}\}\n)[\s\S])*?"Approve and start"/],
  ])) {
    assert.match(src, drawn, `${name}’s card does not show the fleet’s sentence above what can be done about it`);
  }
});

test('“Approve and start” is offered only where the fleet says the approval is this person’s, approves once and sends the same start once', () => {
  for (const [name, src, answer, press, mine, retry] of /** @type {const} */ ([
    ['iOS', IOS, I_ANSWER, /"Approve and start"\) \{ (\w+)\(\w+\) \}/, /^if let \w+ = \w+\.(\w+) \{$/, /Button\("Try again"\) \{ (\w+)\(\) \}/],
    ['Android', ANDROID, A_ANSWER, /\w+ = (\w+)\(\w+, \w+, \w+\)\n(?:(?!\n {8}\})[\s\S])*?"Approve and start"/, /^if \((\w+) != null\) \{$/, /onClick = (\w+),\n[^\n]*\n\s*\) \{ Text\("Try again"\) \}/],
  ])) {
    const at = only(src, '"Approve and start"', name);
    const card = declarationAt(src, at);
    const text = src.slice(card.from, card.to);
    // Drawn only where the fleet said this person may give the approval.
    const head = paths(src, at)[0].find((h) => mine.test(h));
    assert.ok(head, `${name} offers Approve and start with no condition this test can read`);
    const given = named(head, mine, `${name} offers Approve and start with no condition this test can read`);
    const whose = name === 'iOS'
      ? named(src, new RegExp(`var ${given}: Fleet\\.Approval\\? \\{\\s*([^\\n]*)\\n`), 'iOS does not say which approval is this person’s to give')
      : named(src, new RegExp(`val ${named(text, new RegExp(`val ${given} = \\w+\\.(\\w+)\\n`), 'Android does not say which approval is this person’s to give')}: Fleet\\.Approval\\? get\\(\\) = ([^\\n]*)\\n`), 'Android does not say which approval is this person’s to give');
    assert.match(whose, /\bmayAnswer\b/, `${name} offers Approve and start to somebody the fleet did not say may approve`);

    // What pressing it does: one approval, and when the fleet took it, the
    // same start again, once. The screen that sent the first start owns the
    // second, and shows its answer like any other.
    const again = named(text, retry, `${name}’s card has no Try again`);
    const does = bodyOf(src, named(text, press, `${name}’s Approve and start does nothing`));
    assert.equal(count(does, `.${answer}(`), 1, `${name}’s Approve and start does not approve exactly once`);
    assert.match(does, new RegExp(`\\.${answer}\\((?:id: )?\\w+\\.id, (?:answer: )?"approve"\\)`), `${name}’s Approve and start sends something other than approve`);
    assert.equal(count(does, `${again}()`), 1, `${name}’s Approve and start does not send the start again exactly once`);
    assert.doesNotMatch(does, /\b(?:while|for|repeat)\b/, `${name}’s Approve and start loops`);
    // A refusal to approve stops there: no start is sent on an approval the
    // fleet did not take.
    assert.match(does, new RegExp(`(?:guard \\w+\\.ok == true else \\{(?:(?!\\n {16}\\})[\\s\\S])*?return\\s*\\}|if \\(\\w+\\.ok != true\\) return [^\\n]*)\\s*${again}\\(\\)`), `${name} sends the start again after an approval the fleet refused`);

    // Try again, for somebody who cannot approve it themselves, sends the
    // same start and nothing else, and only for a start that waits.
    const other = card.from + text.indexOf('"Try again"');
    assert.ok(alwaysUnder(src, other, /^\} else if \(?\w+\.code == "needs_approval"\)? \{$/), `${name} offers Try again on a start that is not waiting for approval`);
    // Two things to press at most, and nothing for a start the fleet refuses outright.
    const control = name === 'iOS' ? IOS_CONTROL : ANDROID_CONTROL;
    assert.equal(places(code(text), control).length, 2, `${name}’s card has a control other than Approve and start and Try again`);
  }
});

test('the card is drawn wherever a member start is sent, and sends the start that was sent', () => {
  // The two ways either phone sends a start: with the parameters a person
  // chose, a member among them, and with a task's own. Found by the verb
  // they send, so this reads the calls and not what they are named.
  const iStart = named(IOS, /func (\w+)\(\s*name: String\?,(?:(?!\n {4}\})[\s\S])*?member: String\? = nil\s*\) async throws -> Reply \{(?:(?!\n {4}\})[\s\S])*?intent\("start", /, 'iOS has no start that takes a member');
  const iOnTask = named(IOS, /func (\w+)\(_ \w+: \[String: String\], host: String\? = nil\) async throws -> Reply \{\s*try await intent\("start", /, 'iOS has no start on a task');
  const aStart = named(ANDROID, /suspend fun (\w+)\(\s*name: String\? = null,(?:(?!\n {4}\))[\s\S])*?member: String\? = null,\s*\): Reply = intent\(\s*"start",/, 'Android has no start that takes a member');
  const aOnTask = named(ANDROID, /suspend fun (\w+)\(\w+: Map<String, String>, host: String\? = null\): Reply =\s*intent\("start", /, 'Android has no start on a task');

  // iOS sends a member start from three places: New session, a member's
  // page, and a task's page. Each keeps the refusal and the start it sent.
  const iSends = [
    ...places(IOS, new RegExp(`\\.${iStart}\\(\\s*name: nil,(?:(?!\\n {16}\\))[\\s\\S])*?member: \\w+\\.member\\s*\\)`)),
    ...places(IOS, new RegExp(`\\.${iOnTask}\\(\\w+, host: \\w+\\)`)),
  ];
  assert.equal(iSends.length, 3, `iOS sends a member start from ${iSends.length} places; this test reads New session, a member’s page and a task’s`);
  for (const at of iSends) {
    assert.match(IOS.slice(at, at + 900), new RegExp(`= ${I_REFUSED}\\(\\w+\\)`), `iOS sends a member start and does not keep its refusal for approval: ${IOS.slice(at, at + 60).split('\n')[0]}`);
  }
  // And each draws the card with a retry that sends what was kept.
  const iView = named(IOS, /struct (\w+): View \{(?:(?!\n\})[\s\S])*?"Approve and start"/, 'iOS has no card for a refused start');
  const iCards = [...IOS.matchAll(new RegExp(`${iView}\\(settings: settings, \\w+: \\w+\\) \\{\\s*(\\w+)\\((\\w+)(?:\\.\\w+, \\w+: \\2\\.\\w+)?\\)\\s*\\}`, 'g'))];
  assert.equal(iCards.length, 3, `iOS draws the card for a refused start in ${iCards.length} places`);
  for (const [, send, kept] of iCards) {
    // The function the retry calls is the one that sends, and what it is
    // given is what that function kept when it first sent: its own
    // parameters, set down before anything is sent.
    const sender = bodyOf(IOS, send);
    assert.match(sender, new RegExp(`\\.(?:${iStart}|${iOnTask})\\(`), `iOS’s retry calls ${send}, which sends no start`);
    const given = [...named(sender, /func \w+\(([^)]*)\)/, `iOS’s ${send} takes nothing to send`).matchAll(/(?:^|, )(?:_ )?(\w+)(?: \w+)?: /g)].map((m) => m[1]);
    const keeps = named(sender, new RegExp(`\\b${kept} = ([^\\n]+)\\n`), `iOS’s ${send} does not keep the start it sends, so Try again could send another`);
    for (const one of given) assert.match(keeps, new RegExp(`\\b${one}\\b`), `iOS’s ${send} keeps a start without its ${one}`);
    assert.ok(sender.indexOf(`${kept} = `) < sender.search(new RegExp(`\\.(?:${iStart}|${iOnTask})\\(`)), `iOS’s ${send} keeps the start only after it is sent`);
  }

  // Android sends every start from one place, so one card.
  const aSend = named(ANDROID, new RegExp(`= ${A_REFUSED}\\((\\w+), \\w+, `), 'Android does not keep a refused start');
  const aCard = /(\w+)\(settings, (\w+)\) \{ (\w+)\(\2\.(\w+)\) \}/.exec(ANDROID);
  assert.ok(aCard, 'Android does not draw the card for a refused start');
  const [, aView, , aSender, aKept] = aCard;
  assert.match(bodyOf(ANDROID, aView), /"Approve and start"/, 'Android draws something other than the card for a refused start');
  const sender = bodyOf(ANDROID, aSender);
  assert.match(sender, new RegExp(`\\.${aOnTask}\\(\\w+, host = \\w+\\.host\\)(?:(?!\\n {8}\\})[\\s\\S])*?\\.${aStart}\\(`), 'Android’s retry calls something that sends no start');
  assert.match(sender, new RegExp(`fun ${aSender}\\(${aSend}: StartRequest\\)`), 'Android keeps a start other than the one it sent');
  assert.match(ANDROID, new RegExp(`data class \\w+\\(val ${aKept}: StartRequest, `), 'Android’s card does not hold the start that was sent');
});

test('Approvals is a row under Organization, with how many wait on this person when any do and nothing when that is not known', () => {
  for (const [name, src, asks, words, counted, unknown] of /** @type {const} */ ([
    ['iOS', IOS, I_ASKS, /func (\w+)\([^)]*\) -> String\? \{\s*\w+ == 0 \? nil : "\\\(\w+\) waiting on you"\s*\}/, (/** @type {string} */ fn, /** @type {string} */ a) => new RegExp(`LabeledContent\\("Approvals"\\) \\{\\s*if let \\w+ = (\\w+), let (\\w+) = ${fn}\\([^)]*\\) \\{\\s*Text\\(\\2\\)[\\s\\S]{0,9000}?\\1 = \\w+\\.filter \\{ ${a}\\(\\$0\\) \\}\\.count`), new RegExp(`guard let \\w+ = try\\? await [^\\n]*\\.${I_LIST}\\(\\), \\w+\\.ok != false, let \\w+ = \\w+\\.approvals else \\{\\s*(\\w+) = nil\\s*return\\s*\\}`)],
    ['Android', ANDROID, A_ASKS, /fun (\w+)\(\w+: Int\): String\? = if \(\w+ == 0\) null else "\$\w+ waiting on you"/, (/** @type {string} */ fn, /** @type {string} */ a) => new RegExp(`(\\w+) = Fleet\\(settings\\)\\.${A_LIST}\\(\\)\\.getOrNull\\(\\)\\s*\\?\\.takeIf \\{ it\\.ok != false \\}\\?\\.approvals\\?\\.count \\{ ${a}\\(it\\) \\}[\\s\\S]{0,9000}?OpenRow\\("Approvals", value = \\1\\?\\.let \\{ ${fn}\\(it\\) \\}\\)`), new RegExp(`\\.${A_LIST}\\(\\)\\.getOrNull\\(\\)\\s*\\?\\.takeIf \\{ it\\.ok != false \\}\\?\\.approvals\\?\\.count \\{`)],
  ])) {
    // None is said as nothing beside the name.
    const fn = named(src, words, `${name} has no words for how many approvals wait on this person`);
    // The count is of the ones the fleet says this person may answer, and
    // it is what the row draws.
    assert.match(src, counted(fn, asks), `${name}’s Approvals row counts something other than the approvals waiting on this person`);
    // No answer, a refusal, or a fleet from before approvals: no count, which
    // the row draws as nothing. Unknown is never drawn as none.
    assert.match(src, unknown, `${name} takes an answer with no list of approvals for none waiting`);
  }
});

test('the member form says what a budget is and that Approvals decides, and neither phone still says a budget is not enforced', () => {
  for (const [name, src] of BOTH) {
    const at = only(src, 'Dollars a month, at API prices. Approvals decides what happens when it is passed.', name);
    // Under the budget's own field.
    assert.match(src.slice(at - 400, at), /"Monthly budget \(USD\)"/, `${name} says what a budget is somewhere other than under its field`);
    // Comments and all: the sentence it replaced is gone from the app.
    assert.doesNotMatch(src, /enforces? it yet|[Nn]othing enforces|enforced by nothing/, `${name} still says a budget is not enforced`);
  }
});

test('every budgets and approvals route has a caller on both phones, and a screen that calls it', () => {
  for (const [name, src, id] of /** @type {const} */ ([['iOS', IOS, '\\\\\\(id\\)'], ['Android', ANDROID, '\\$id']])) {
    const routes = /** @type {const} */ ([
      ['reads the budgets', /(?:func|fun) (\w+)\(\)[^\n]*\{\s*(?:try|runCatching)[^\n]*get\("\/api\/budgets"\)/],
      ['changes what a budget does', /(?:func|fun) (\w+)\([^)]*\)[^\n]*\{(?:(?!\n {4}\})[\s\S])*?send\("PUT", "\/api\/budgets\/settings", /],
      ['lists the approvals', /(?:func|fun) (\w+)\(\)[^\n]*\{(?:(?!\n {4}\})[\s\S])*?get\("\/api\/approvals"\)/],
      ['answers an approval', new RegExp(`(?:func|fun) (\\w+)\\([^)]*\\)[^\\n]*\\{(?:(?!\\n {4}\\})[\\s\\S])*?post\\("\\/api\\/approvals\\/${id}", `)],
    ]);
    for (const [what, re] of routes) {
      const fn = named(src, re, `${name} never ${what}`);
      // And each is asked for by a screen, not only declared.
      assert.ok(count(code(src), `.${fn}(`) >= 1, `${name} declares what ${what} and no screen calls it`);
    }
  }
});

test('the six kinds of event have the same label on both phones, and the two refusals a title', () => {
  const labels = {
    'budget.warn': 'Budget nearly spent',
    'budget.over': 'Over budget',
    'approval.asked': 'Approval asked',
    'approval.answered': 'Approval answered',
    'approval.used': 'Approval used',
    'budgets.changed': 'Budget rules changed',
  };
  for (const [kind, label] of Object.entries(labels)) {
    // The fleet records it, so a row in Recent activity can be one.
    assert.ok(CORE.includes(`'${kind}'`), `the fleet no longer records ${kind}; this test reads its label`);
    for (const [name, src] of BOTH) {
      assert.match(src, new RegExp(`"${literal(kind)}"(?:: | to )"${literal(label)}",`), `${name} does not call ${kind} “${label}”`);
    }
  }
  // A refused start is titled by its code where a notification says it.
  for (const [code_, title] of /** @type {const} */ ([['needs_approval', 'Needs approval'], ['over_budget', 'Over budget']])) {
    assert.ok(CORE.includes(`code: '${code_}'`), `the fleet no longer refuses a start as ${code_}; this test reads its title`);
    for (const [name, src] of BOTH) {
      assert.match(src, new RegExp(`"${code_}"(?:: | to )"${title}",`), `${name} has no title for a start refused as ${code_}`);
    }
  }
});

test('a notification about an approval opens Approvals, and one about a budget opens that member’s page', () => {
  // The fleet's two kinds, so the test reads what is sent.
  assert.match(CORE, /kind: 'approval', [^\n]*approval: \w+\.id, member: /, 'the fleet no longer sends an approval’s notification as kind approval');
  assert.match(CORE, /kind: 'budget', [^\n]*member: \w+\.id \}/, 'the fleet no longer sends a budget’s notification as kind budget with its member');

  // iOS: each kind names a page under You, and You opens that page.
  const iApprovals = named(IOS, /if kind == "approval" \{ return (\w+)\(\) \}/, 'iOS does not open anything for an approval’s notification');
  const iPage = named(bodyOf(IOS, iApprovals), /userInfo: \["you": (\w+)\]/, 'iOS’s approval notification does not open a page under You');
  assert.match(IOS, new RegExp(`\\} else if \\w+ == ${iPage} \\{\\s*(\\w+)\\(settings: settings\\)`), 'iOS’s You does not open Approvals for it');
  assert.match(IOS, /if kind == "budget", let (\w+) = info\["member"\] as\? String, (\w+)\((\w+) \+ \1\) != nil \{\s*return \w+\((?:\w+: )?\1\)/, 'iOS does not open a member’s page for a budget’s notification, or opens one by an id it did not check');
  const iMember = named(IOS, /if kind == "budget", let \w+ = info\["member"\] as\? String, (\w+)\(/, 'iOS does not check a member’s id from a notification');
  assert.match(IOS, new RegExp(`\\} else if let (\\w+) = ${iMember}\\(\\w+\\) \\{\\s*\\w+\\(settings: settings, id: \\1\\)`), 'iOS’s You does not open the member’s page for it');
  // The id is held to what a member's id is made of, and to its length.
  assert.match(bodyOf(IOS, iMember), /Set\("abcdefghijklmnopqrstuvwxyz0123456789-"\)(?:(?!\n\})[\s\S])*?\.count <= 40/, 'iOS takes a member’s id from a notification that is not shaped like one');

  // Android: the same two kinds, the same two pages, and the extra that
  // names the member is one a notification the app drew itself carries.
  assert.match(ANDROID, /"approval" -> (\w+)\n\s*"budget" -> (\w+)\((\w+) \+ intent\?\.getStringExtra\("member"\)\.orEmpty\(\)\)\?\.let \{ \3 \+ it \}/, 'Android does not open Approvals, or a member’s page by an id it checked, for these notifications');
  const aPage = named(ANDROID, /"approval" -> (\w+)\n/, 'Android does not open anything for an approval’s notification');
  assert.match(ANDROID, new RegExp(`\\n\\s*${aPage} -> (\\w+)\\(settings, onDismiss = \\{ \\w+ = null \\}`), 'Android’s You does not open Approvals for it');
  const aMember = named(ANDROID, /"budget" -> (\w+)\(/, 'Android does not check a member’s id from a notification');
  assert.match(ANDROID, new RegExp(`${aMember}\\(\\w+\\)\\?\\.let \\{ (\\w+) ->\\s*\\w+\\(settings, onDismiss = \\{ \\w+ = null \\}, onStart = \\w+, opening = \\1\\)`), 'Android’s You does not open the member’s page for it');
  assert.match(ANDROID, /Regex\("\[a-z0-9-\]\{1,40\}"\)/, 'Android takes a member’s id from a notification that is not shaped like one');
  const carried = named(ANDROID, /= listOf\(("event", [^)]*)\)/, 'Android no longer lists what a tap on a notification it drew carries; this test reads the list');
  assert.ok(carried.includes('"kind"') && carried.includes('"member"'), 'a budget notification Android drew itself does not carry its member');
});
