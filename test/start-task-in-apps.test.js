// New session hands a session its task in words, on both phones.
//
//   node --test test/start-task-in-apps.test.js
//
// A read of the sources, like the other *-in-apps tests: the Swift and the
// Kotlin compile only in CI. The protocol half (`start.task`, v7) is in
// runner-repo.test.js and the host's delivery in start-task.test.js.
//
// WHY IT EXISTS: a new machine is minutes old and has no profile, so every
// session the phone started on one came up idle with nothing able to give it
// work. The field is the way a person says what it is for.

import test from 'node:test';
import assert from 'node:assert/strict';

import { iosSources } from './helpers/ios-sources.js';
import { androidSources } from './helpers/android-sources.js';

const IOS = iosSources();
const ANDROID = androidSources();

test('iOS: New session asks what it should do, and sends the words', () => {
  assert.ok(IOS.includes('TextField("What should it do?", text: $task, axis: .vertical)'));
  assert.match(IOS, /params\["task"\] = task/);
  // A new machine takes its task with it, held until it joins.
  assert.match(IOS, /if let task = request\.task \{ start\["task"\] = task \}/);
  // Two first messages is one too many: a task means no profile is sent.
  assert.match(IOS, /profile: profile\.isEmpty \|\| platform != nil \|\| !trimmedTask\.isEmpty \? nil : profile/);
});

test('iOS: the sheet says what happens, and promises no link a runner cannot have', () => {
  assert.ok(IOS.includes('It starts with these words and gets to work.'));
  assert.ok(IOS.includes('Leave it empty and it starts idle, waiting for you.'));
  assert.ok(IOS.includes(' and works on your task. You get a notification when it is back at its prompt.'));
  assert.doesNotMatch(IOS, /notification with its link/);
  // "Started" said as idle only when it has neither.
  assert.match(IOS, /status = request\.profile == nil && request\.task == nil\s*\? "Starting a session\. It will come up idle/);
});

test('Android: New session asks what it should do, and sends the words', () => {
  assert.ok(ANDROID.includes('label = { Text("What should it do?") }'));
  assert.match(ANDROID, /if \(!task\.isNullOrBlank\(\)\) put\("task", task\)/);
  assert.match(ANDROID, /request\.task\?\.let \{ put\("task", it\) \}/);
  assert.match(ANDROID, /profile = profile\.ifBlank \{ null \}\.takeIf \{ platform\.isEmpty\(\) && task\.isBlank\(\) \}/);
});

test('Android: the sheet says the same as iOS, and promises no link a runner cannot have', () => {
  for (const words of [
    'It starts with these words and gets to work.',
    'Leave it empty and it starts idle, waiting for you.',
    ' and works on your task. You get a notification when it is back at its prompt.',
  ]) {
    assert.ok(ANDROID.includes(words), `Android does not say: ${words}`);
    assert.ok(IOS.includes(words), `iOS does not say: ${words}`);
  }
  assert.doesNotMatch(ANDROID, /notification with its link/);
  assert.match(ANDROID, /status = if \(request\.profile == null && request\.task == null\) \{/);
});
