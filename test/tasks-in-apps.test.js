// The two phones say the same thing about tasks (docs/tasks.md), offer an
// action only where the fleet would take it, and sign the fleet's words.
//
//   node --test test/tasks-in-apps.test.js
//
// A read of the sources, not a run: the Swift and the Kotlin compile only in
// CI. What a build cannot check is what this holds:
//
//   1. THE OTHER PHONE USES THE SAME WORDS, and here the words carry the
//      rules: that a branch is what sessions are told and not something that
//      exists, that a result is the session's own account, that a machine
//      which is not connected is cannot-tell.
//   2. EACH BUTTON SITS UNDER THE CONDITION THE FLEET CHECKS (C-2), so a
//      person is not offered a Release with nothing to release.
//   3. WHAT IS SIGNED IS WHAT WAS SHOWN. A start on a task sends the
//      parameters `GET /api/tasks/{id}` answered with, whole. A phone that
//      rebuilt them would sign words its own screen never showed.
//
// What the coordinator answers, and what a box does with a start, are their
// own tests' business (test/tasks-coordinator.test.js, test/vault.test.js).

import test from 'node:test';
import assert from 'node:assert/strict';
import { iosSources } from './helpers/ios-sources.js';
import { androidSources } from './helpers/android-sources.js';
import { MAX_TASK_TITLE, MAX_TASK_BRIEF, MAX_TASK_NOTE, MAX_RESULT, TASK_STATES, startFor } from '../src/fleet/protocol/tasks.js';

const IOS = iosSources();
const ANDROID = androidSources();
const BOTH = /** @type {const} */ ([['iOS', IOS], ['Android', ANDROID]]);

/**
 * `assert.match`, saying which rule went and not the two megabytes of source
 * it went from.
 *
 * @param {string} src @param {RegExp} re @param {string} what
 */
const has = (src, re, what) => assert.ok(re.test(src), `${what}\n  looked for ${re}`);
/** How many times a phone's source holds a string. @param {string} src @param {string} text */
const count = (src, text) => src.split(text).length - 1;

test('the words about tasks are the same on both phones', () => {
  for (const words of [
    // The list, and its ways of having nothing to draw.
    '"Tasks"',
    '"New task"',
    '"Finished"',
    'Could not load the tasks.',
    'No unfinished tasks. New task makes one.',
    'Could not load the finished tasks.',
    'No finished tasks.',
    // A task's page: the branch as an instruction, never as a fact.
    'Assigned to',
    '"Nobody"',
    'Sessions are told to work on ',
    '; nothing checks that it exists.',
    'Could not load this task.',
    'Could not reach your fleet. This is the task as the list last had it.',
    // The lock, and the two things it must not be mistaken for.
    ' is not connected, so whether the session is still working is unknown.',
    'The session is back at its prompt and wrote no result.',
    'The machine has not answered yet.',
    // The result is what a session wrote, and the page says so.
    'Outcome not stated',
    `Cut at ${MAX_RESULT} bytes. The rest is in RESULT.md in the session's workspace.`,
    "This is the session's own account. Nothing checked it.",
    'Why it was reopened',
    'The next session is told this.',
    // The actions.
    'Start a session',
    'What the session is told',
    'Your phone signs these words. The session gets them after ',
    'Sign and start',
    '"Wherever fits"',
    'Reassign',
    'Accept the result',
    'Say why. The note is what the next session is told.',
    'Ends the lock, so another session can be started on it. This does not stop the session that holds it.',
    'Cancel task',
    'Keep it',
    'Closes the task. A session still working on it is not stopped.',
    // New task.
    'One line that says what it is',
    'What to do, where, and what to bring back',
    'It is all the session gets.',
    'owner/repo',
    'Kind of work',
    'Make the task',
    // A change of hands, as a sentence.
    '"Made, assigned to ',
    '"Reassigned from ',
    ' started as ',
    '"Came back',
    '"Released',
    '"Accepted',
    '"Reopened',
    '"Cancelled',
    '"Delegated ',
    // What Recent activity calls the two new kinds.
    'Task came back',
    'Task released',
  ]) {
    assert.ok(IOS.includes(words), `iOS lost: ${words}`);
    assert.ok(ANDROID.includes(words), `Android lost: ${words}`);
  }
});

test('a task’s state is a sentence on its row, and one this build never met is shown as itself (C-5)', () => {
  for (const [name, src] of BOTH) {
    for (const words of [
      '"Came back: done"',
      '"Came back: blocked"',
      '"Came back: failed"',
      '"Came back, outcome not stated"',
      '"Open"',
      '"Open, assigned to nobody"',
      '"Done"',
      '"Cancelled"',
    ]) {
      assert.ok(src.includes(words), `${name} lost the state ${words}`);
    }
    // Which session, on which machine: "Working, cc-x on deb132".
    has(src, /"Working, [^" ]+ on [^" ]+"/, `${name} does not say which session is working, and where`);
  }
  // Came back with no result attached says only that. "Outcome not stated"
  // is a claim about what the session wrote, and nobody sent what it wrote.
  has(IOS, /case \.none: return "Came back"\n/, 'iOS puts an outcome on a task that came back with none sent');
  has(ANDROID, /null -> "Came back"\n/, 'Android puts an outcome on a task that came back with none sent');
  // A state or an outcome from a newer fleet is drawn as the fleet sent it.
  has(IOS, /case \.some\(let other\): return "Came back: \\\(other\)"/, 'iOS does not show an outcome it never met as itself');
  has(IOS, /default: return task\.state\n/, 'iOS does not show a state it never met as itself');
  has(ANDROID, /else -> "Came back: \$outcome"/, 'Android does not show an outcome it never met as itself');
  has(ANDROID, /else -> task\.state\n/, 'Android does not show a state it never met as itself');
  // The row says whose it is by name, and by id where no name is known:
  // never a name made up for an id the organization did not list.
  has(IOS, /return roster\.first \{ \$0\.id == id \}\?\.name \?\? id/, 'iOS does not fall back to the assignee’s id');
  has(ANDROID, /return roster\.firstOrNull \{ it\.id == id \}\?\.name \?: id/, 'Android does not fall back to the assignee’s id');
});

test('the list opens on the unfinished tasks, the ones that came back first, and asks for the finished ones only under Finished', () => {
  // The order drawn is the order asked: returned, working, open.
  has(IOS, /let taskUnfinishedStates = \["returned", "working", "open"\]/, 'iOS does not ask for returned, then working, then open');
  has(ANDROID, /val TASK_UNFINISHED_STATES = listOf\("returned", "working", "open"\)/, 'Android does not ask for returned, then working, then open');
  has(IOS, /let taskFinishedStates = \["done", "cancelled"\]/, 'iOS does not keep done and cancelled apart');
  has(ANDROID, /val TASK_FINISHED_STATES = listOf\("done", "cancelled"\)/, 'Android does not keep done and cancelled apart');
  // Between them the two lists are every state the fleet has, so no task is
  // in neither.
  const asked = [...IOS.matchAll(/let task(?:Unfinished|Finished)States = \[([^\]]*)\]/g)].flatMap((m) => [...m[1].matchAll(/"([a-z]+)"/g)].map((s) => s[1]));
  assert.deepEqual([...asked].sort(), [...TASK_STATES].sort(), 'a state the fleet has is in neither list');
  // Done and cancelled are fetched when Finished is opened, not before.
  has(IOS, /\.onChange\(of: finishedOpen\) \{ _, now in\s*if now \{ Task \{ await loadFinished\(\) \} \}/, 'iOS does not wait for Finished to be opened');
  has(IOS, /if finishedOpen \{ await loadFinished\(\) \}/, 'iOS loads the finished tasks with the list');
  has(ANDROID, /LaunchedEffect\(finishedOpen, asked\) \{\s*if \(!finishedOpen\) return@LaunchedEffect/, 'Android does not wait for Finished to be opened');
});

test('loading, failed and empty are three states, and a list that did not come is never drawn as an empty one (C-5)', () => {
  // An answer without the list is a failure with the fleet's sentence, on
  // both phones: null is cannot-tell.
  has(IOS, /guard got\.ok != false, let list = got\.tasks else \{\s*load = \.failed\(got\.text \?\? /, 'iOS draws an answer with no list as a list');
  has(ANDROID, /val list = got\.tasks\s*if \(got\.ok == false \|\| list == null\) \{\s*failed = got\.text \?: /, 'Android draws an answer with no list as a list');
  // Empty is said only once the fleet answered.
  has(IOS, /case \.answered:\s*listSection/, 'iOS draws the list before the fleet answered');
  has(IOS, /if tasks\.isEmpty \{\s*Text\("No unfinished tasks\. New task makes one\."\)/, 'iOS does not say the list is empty');
  has(ANDROID, /!answered -> Hint\("Loading…"\)\s*else -> \{\s*if \(tasks\.isEmpty\(\)\) Hint\("No unfinished tasks\. New task makes one\."\)/, 'Android says empty before the fleet answered');
  // A lock whose machine did not say whether it is connected claims nothing:
  // only an explicit false is "not connected".
  has(IOS, /if lock\.connected == false \{/, 'iOS calls a machine not connected without being told');
  has(ANDROID, /if \(lock\.connected == false\) \{/, 'Android calls a machine not connected without being told');
  has(ANDROID, /connected = if \(l\.has\("connected"\) && !l\.isNull\("connected"\)\) l\.optBoolean\("connected"\) else null/, 'Android reads a missing `connected` as false');
  // The Tasks row under You is drawn only from an answer that carried a list.
  has(IOS, /if let tasksBack \{\s*NavigationLink \{\s*TasksView/, 'iOS draws the Tasks row before the fleet answered');
  has(ANDROID, /tasksBack\?\.let \{ back ->\s*OpenRow\("Tasks"/, 'Android draws the Tasks row before the fleet answered');
});

test('every /api/tasks route has a caller on both phones', () => {
  for (const [name, src] of BOTH) {
    has(src, /get\("\/api\/tasks\?state=(?:\\\(state\)|\$state)"\)/, `${name} never lists tasks`);
    has(src, /post\("\/api\/tasks", /, `${name} cannot make a task`);
    has(src, /get\("\/api\/tasks\/(?:\\\(id\)|\$id)"\)/, `${name} never reads one task`);
    has(src, /send\("PUT", "\/api\/tasks\/(?:\\\(id\)|\$id)"/, `${name} cannot change a task`);
    has(src, /post\("\/api\/tasks\/(?:\\\(id\)|\$id)\/act", /, `${name} cannot release, accept, reopen or cancel`);
    // And each of the four actions is asked for by a screen.
    for (const action of ['release', 'accept', 'cancel']) assert.equal(count(src, `act("${action}")`), 1, `${name} never asks to ${action}, or asks twice`);
    assert.equal(count(src, '"reopen"'), 1, `${name} never asks to reopen, or asks twice`);
  }
});

test('each action is drawn only where the fleet would take it (C-2)', () => {
  // Start: only with something to sign.
  has(IOS, /if let start \{\s*NavigationLink\("Start a session"\)/, 'iOS offers Start with nothing to sign');
  has(ANDROID, /start\?\.let \{\s*OutlinedButton\(onClick = \{ starting = true \}[^\n]*\{\s*Text\("Start a session"\)/, 'Android offers Start with nothing to sign');
  // Reassign: an open task no session holds.
  has(IOS, /if task\.lock == nil, task\.state == "open" \{\s*NavigationLink\("Reassign"\)/, 'iOS offers Reassign on a task that is held or not open');
  has(ANDROID, /if \(shown\.lock == null && shown\.state == "open"\) \{\s*OpenRow\("Reassign"\)/, 'Android offers Reassign on a task that is held or not open');
  // Release: a lock to end.
  has(IOS, /if task\.lock != nil \{\s*Button\("Release"\)/, 'iOS offers Release with no lock');
  has(ANDROID, /if \(shown\.lock != null\) \{\s*OutlinedButton\(onClick = \{ confirmingRelease = true \}[^\n]*\{\s*Text\("Release"\)/, 'Android offers Release with no lock');
  // Accept: a result waiting.
  has(IOS, /if task\.state == "returned" \{\s*Button\("Accept the result"\)/, 'iOS offers Accept on a task that has not come back');
  has(ANDROID, /if \(shown\.state == "returned"\) \{\s*OutlinedButton\(onClick = \{ act\("accept"\) \}[^\n]*\{\s*Text\("Accept the result"\)/, 'Android offers Accept on a task that has not come back');
  // Reopen: came back, or done.
  has(IOS, /if task\.state == "returned" \|\| task\.state == "done" \{\s*NavigationLink\("Reopen"\)/, 'iOS offers Reopen on a task that neither came back nor is done');
  has(ANDROID, /if \(shown\.state == "returned" \|\| shown\.state == "done"\) \{\s*OpenRow\("Reopen"\)/, 'Android offers Reopen on a task that neither came back nor is done');
  // Edit and Cancel: until it is finished.
  has(IOS, /if task\.state != "done", task\.state != "cancelled" \{\s*NavigationLink\("Edit"\)[\s\S]{0,700}?Button\("Cancel task", role: \.destructive\) \{ confirmingCancel = true \}/, 'iOS offers Edit or Cancel on a finished task');
  has(ANDROID, /if \(shown\.state != "done" && shown\.state != "cancelled"\) \{\s*OpenRow\("Edit"\)[^\n]*\n\s*TextButton\(onClick = \{ confirmingCancel = true \}[^\n]*\{\s*Text\("Cancel task"/, 'Android offers Edit or Cancel on a finished task');
  // And the three whose names are theirs alone are drawn once, under that
  // condition and nowhere else. (Edit is also a member's, and Start a
  // session a Shortcut's.)
  for (const [name, src] of BOTH) {
    for (const label of ['"Accept the result"', '("Reassign")', '("Reopen")']) {
      assert.equal(count(src, label), 1, `${name} draws ${label} somewhere its condition does not cover`);
    }
  }
  // Whom a task may be handed to is whom the fleet will take from this
  // person: the members they manage and the ones they may start as.
  has(IOS, /let allowed = Set\(\(you\?\.manages \?\? \[\]\) \+ \(you\?\.startAs \?\? \[\]\)\)\s*return members\.filter \{ allowed\.contains\(\$0\.id\) \}/, 'iOS offers an assignee the fleet would refuse');
  has(ANDROID, /val allowed = \(you\?\.manages\.orEmpty\(\) \+ you\?\.startAs\.orEmpty\(\)\)\.toSet\(\)\s*return members\.filter \{ it\.id in allowed \}/, 'Android offers an assignee the fleet would refuse');
});

test('Release and Cancel ask first, and the button that asks is not the one that acts', () => {
  has(IOS, /Button\("Release"\) \{ confirmingRelease = true \}[\s\S]{0,200}?\.confirmationDialog\("Release \\\(task\.id\)\?", isPresented: \$confirmingRelease[\s\S]{0,120}?Button\("Release"\) \{ act\("release"\) \}/, 'iOS releases without asking');
  has(IOS, /\.confirmationDialog\("Cancel \\\(task\.id\)\?", isPresented: \$confirmingCancel[\s\S]{0,120}?Button\("Cancel task", role: \.destructive\) \{ act\("cancel"\) \}\s*Button\("Keep it", role: \.cancel\)/, 'iOS cancels without asking');
  has(ANDROID, /if \(confirmingRelease\) \{\s*AlertDialog\([\s\S]{0,420}?confirmingRelease = false\s*act\("release"\)/, 'Android releases without asking');
  has(ANDROID, /if \(confirmingCancel\) \{\s*AlertDialog\([\s\S]{0,420}?confirmingCancel = false\s*act\("cancel"\)/, 'Android cancels without asking');
  // Nothing but those two dialogs releases or cancels.
  for (const [name, src] of BOTH) {
    assert.equal(count(src, 'act("release")'), 1, `${name} releases from somewhere that did not ask`);
    assert.equal(count(src, 'act("cancel")'), 1, `${name} cancels from somewhere that did not ask`);
  }
});

test('Reopen cannot be sent without a note', () => {
  // The button waits for one.
  has(IOS, /Button\(busy \? "Reopening…" : "Reopen"\) \{ Task \{ await send\(\) \} \}\s*\.disabled\(busy \|\| note\.isBlank \|\| /, 'iOS lets Reopen be pressed with no note');
  has(ANDROID, /OutlinedButton\(\s*enabled = !busy && note\.isNotBlank\(\) && [^\n]*\n[\s\S]{0,1200}?Text\(if \(busy\) "Reopening…" else "Reopen"\)/, 'Android lets Reopen be pressed with no note');
  // And the request is not made without one, whatever pressed it.
  has(IOS, /guard !said\.isEmpty else \{ return \}[\s\S]{0,200}?actOnTask\(id: taskId, action: "reopen", note: said\)/, 'iOS can send a reopen with no note');
  has(ANDROID, /if \(said\.isNotEmpty\(\)\) \{[\s\S]{0,200}?actOnTask\(taskId, "reopen", said\)/, 'Android can send a reopen with no note');
  // Reopen is asked from that one place on each phone.
  for (const [name, src] of BOTH) {
    assert.equal(count(src, '"reopen"'), 1, `${name} reopens from somewhere that does not require the note`);
  }
});

test('Start shows the words, then signs and sends the fleet’s own parameters and not a rebuilt brief', () => {
  // What the fleet sends, so the keys below are the contract and not a guess.
  const sent = startFor(/** @type {any} */ ({ id: 't12', title: 'Fix it', brief: 'Do it.', assignee: 'debbie', state: 'open', branch: 'task/t12-fix-it', repo: 'acme/app', lock: null }));
  assert.deepEqual(Object.keys(sent ?? {}).sort(), ['member', 'task', 'taskBranch', 'taskId', 'taskRepo']);

  // The words are on the screen before the button that signs them.
  has(IOS, /Text\(start\["task"\] \?\? ""\)[\s\S]{0,2200}?Button\("Sign and start"\)/, 'iOS signs words it did not show');
  has(ANDROID, /start\["task"\]\.orEmpty\(\),[\s\S]{0,1800}?Text\("Sign and start"\)/, 'Android signs words it did not show');

  // What is sent is the `start` the task's own route answered with, whole:
  // read off the reply, kept as it came, handed to the intent as it is.
  has(IOS, /let start: \[String: String\]\?/, 'iOS does not read `start` off the reply');
  has(IOS, /withAnimation\(Design\.Motion\.change\) \{ task = now \}\s*start = got\.start\n/, 'iOS does not keep the `start` the task’s route sent');
  has(IOS, /func startOnTask\(_ params: \[String: String\], host: String\? = nil\) async throws -> Reply \{\s*try await intent\("start", params: params, host: host\)\s*\}/, 'iOS does not send the parameters as given');
  has(IOS, /if let start \{[\s\S]{0,400}?startSession\(start, host: host\)/, 'iOS starts with something other than the fleet’s `start`');
  has(IOS, /let reply = try await Fleet\(settings: settings\)\.startOnTask\(params, host: host\)/, 'iOS does not send the start it confirmed');
  has(ANDROID, /start = json\.optJSONObject\("start"\)\?\.let \{ s ->\s*val keys = s\.keys\(\)\.asSequence\(\)\.toList\(\)\s*if \(keys\.all \{ s\.opt\(it\) is String \}\) keys\.associateWith \{ s\.optString\(it\) \} else null/, 'Android does not read `start` whole off the reply');
  has(ANDROID, /task = now\s*start = got\.start\n/, 'Android does not keep the `start` the task’s route sent');
  has(ANDROID, /suspend fun startOnTask\(params: Map<String, String>, host: String\? = null\): Reply =\s*intent\("start", params, host = host\)/, 'Android does not send the parameters as given');
  has(ANDROID, /onStart\(StartRequest\(title = null, brief = null, mode = null, host = host, task = signable\["task"\], onTask = signable\)\)/, 'Android puts something of its own beside the fleet’s `start`');
  has(ANDROID, /val onTask = request\.onTask\s*val reply = if \(onTask != null\) \{\s*fleet\.startOnTask\(onTask, host = request\.host\)/, 'Android does not send the start it confirmed');

  // Neither phone writes a start's task parameters itself, or composes the
  // words the fleet composes (the title, the brief and why it was reopened).
  for (const [name, src] of BOTH) {
    for (const key of ['taskId', 'taskBranch', 'taskRepo']) {
      assert.doesNotMatch(src, new RegExp(`(?:\\["${key}"\\]\\s*=[^=]|put\\("${key}",|"${key}" to |"${key}":)`), `${name} builds ${key} itself`);
    }
    assert.ok(!src.includes('Reopened: '), `${name} composes the reopen line the fleet composes`);
  }
});

test('a refusal’s text is what is shown, with a sentence of the phone’s own only when the fleet sent none', () => {
  // On the task's page, for release, accept and cancel and for what the
  // pages under it send back.
  has(IOS, /failed = reply\.ok != true\s*result = reply\.text \?\? \(reply\.ok == true \? "Saved\." : "Your fleet refused that\."\)/, 'iOS does not show the fleet’s sentence on the task’s page');
  has(ANDROID, /failed = r\.ok != true\s*result = r\.text \?: if \(r\.ok == true\) "Saved\." else "Your fleet refused that\."/, 'Android does not show the fleet’s sentence on the task’s page');
  // Under Reassign, Reopen and Save, where the refused form stays open.
  const iosForms = [...IOS.matchAll(/if reply\.ok == true(?:, reply\.task != nil)? \{\s*on(?:Done|Saved)\(reply\)[\s\S]{0,260}?\} else \{\s*result = reply\.text \?\? "Your fleet refused that\."/g)];
  assert.equal(iosForms.length, 3, 'iOS does not show the fleet’s sentence under each of Reassign, Reopen and Save');
  const androidForms = [...ANDROID.matchAll(/if \(r\.ok == true(?: && r\.task != null)?\) \{\s*on(?:Done|Saved)\(r\)\s*\} else \{\s*result = r\.text \?: "Your fleet refused that\."/g)];
  assert.equal(androidForms.length, 3, 'Android does not show the fleet’s sentence under each of Reassign, Reopen and Save');
  // A start the fleet refused: its sentence is the line and the notification.
  has(IOS, /startOnTask\(params, host: host\)\s*let text = reply\.text \?\? "Started\."/, 'iOS does not show what the fleet said of a start');
  // A task the fleet says this person may not see is dropped from the page
  // with its sentence in its place, not kept from what the list had.
  has(IOS, /guard got\.ok != false, let now = got\.task else \{\s*task = nil\s*start = nil\s*loadFailed = got\.text \?\? /, 'iOS keeps a task the fleet refused to show');
  has(ANDROID, /if \(got\.ok == false \|\| now == null\) \{\s*task = null\s*start = null\s*loadFailed = got\.text \?: /, 'Android keeps a task the fleet refused to show');
});

test('the form holds a title, a brief and a note to what the fleet takes, and says the count as it is approached', () => {
  const ios = (/** @type {string} */ name) => Number(new RegExp(`let ${name} = (\\d+)`).exec(IOS)?.[1]);
  const android = (/** @type {string} */ name) => Number(new RegExp(`const val ${name} = (\\d+)`).exec(ANDROID)?.[1]);
  assert.equal(ios('taskTitleLimit'), MAX_TASK_TITLE);
  assert.equal(ios('taskBriefLimit'), MAX_TASK_BRIEF);
  assert.equal(ios('taskNoteLimit'), MAX_TASK_NOTE);
  assert.equal(android('TASK_TITLE_LIMIT'), MAX_TASK_TITLE);
  assert.equal(android('TASK_BRIEF_LIMIT'), MAX_TASK_BRIEF);
  assert.equal(android('TASK_NOTE_LIMIT'), MAX_TASK_NOTE);
  // A brief and a note are measured in bytes of UTF-8, as the fleet does.
  has(IOS, /func taskBytes\(_ text: String\) -> Int \{ text\.utf8\.count \}/, 'iOS does not count bytes of UTF-8');
  has(ANDROID, /fun taskBytes\(text: String\): Int = text\.toByteArray\(Charsets\.UTF_8\)\.size/, 'Android does not count bytes of UTF-8');
  // Said from four fifths of the limit, and past it, by how much.
  has(IOS, /guard count \* 5 >= limit \* 4 else \{ return nil \}\s*if count > limit \{ return "\\\(count\) of \\\(limit\) \\\(unit\), \\\(count - limit\) too many" \}\s*return "\\\(count\) of \\\(limit\) \\\(unit\)"/, 'iOS does not say the count as the limit is approached');
  has(ANDROID, /count \* 5 < limit \* 4 -> null\s*count > limit -> "\$count of \$limit \$unit, \$\{count - limit\} too many"\s*else -> "\$count of \$limit \$unit"/, 'Android does not say the count as the limit is approached');
  for (const [name, src] of BOTH) {
    for (const unit of ['"characters"', '"bytes"']) assert.ok(src.includes(unit), `${name} never counts in ${unit}`);
  }
  // A field over its limit is not sent to be refused.
  has(IOS, /\.disabled\(busy \|\| title\.isBlank \|\| brief\.isBlank \|\| titleCount > taskTitleLimit \|\| briefBytes > taskBriefLimit\)/, 'iOS sends a title or a brief over its limit');
  has(ANDROID, /enabled = !busy && title\.isNotBlank\(\) && brief\.isNotBlank\(\) && titleCount <= TASK_TITLE_LIMIT && briefBytes <= TASK_BRIEF_LIMIT/, 'Android sends a title or a brief over its limit');
});

test('a session started on a task says so on its page, and that opens the task', () => {
  has(IOS, /if let taskId = session\.taskId, !taskId\.isEmpty \{\s*NavigationLink\("Task \\\(taskId\)"\) \{\s*TaskView\(settings: fleet\.settings, id: taskId\)/, 'iOS does not open the task from its session');
  has(ANDROID, /val taskId = session\.taskId\s*if \(taskId != null && onTask != null\) \{\s*OutlinedButton\(\s*onClick = \{ onTask\(taskId\) \},[\s\S]{0,120}?\{ Text\("Task \$taskId"\) \}/, 'Android does not say which task a session is on');
  has(ANDROID, /onTask = \{ id -> taskFor = id \}/, 'Android’s Task button opens nothing');
  has(ANDROID, /taskFor\?\.let \{ id ->\s*TaskPage\(/, 'Android does not open the task from its session');
  // The id is read off the session only when its box sent one.
  has(IOS, /let taskId: String\?/, 'iOS does not read a session’s task');
  has(ANDROID, /taskId = o\.optString\("taskId"\)\.takeIf \{ it\.isNotBlank\(\) && it != "null" \}/, 'Android does not read a session’s task');
  // And from a task to the session that holds it, only when this phone's own
  // list has that session on that machine.
  has(IOS, /lockSession = listed\.first \{ \$0\.name == name && \$0\.hostId == lock\.hostId \}/, 'iOS opens a session its own list does not have');
  has(ANDROID, /sessions\?\.firstOrNull \{ it\.name == name && it\.hostId == lock\.hostId \}/, 'Android opens a session its own list does not have');
});
