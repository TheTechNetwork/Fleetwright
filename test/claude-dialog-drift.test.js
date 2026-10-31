// Which components of a Claude Code binary the drift check asks the model
// about (scripts/claude-dialog-drift.mjs dialogClusters): a question with a
// choice among its strings, and none DIALOGS already names. The model call is
// advisory and needs secrets; which components reach it is the part CI can
// hold steady.

import test from 'node:test';
import assert from 'node:assert/strict';
import { dialogClusters } from '../scripts/claude-dialog-drift.mjs';
import { DIALOGS } from '../src/fleet/host/claude-dialogs.js';

test('a question with choices is a candidate; one DIALOGS lists, or one with no choice, is not', () => {
  // Three components as a minifier writes them, spelled out: one unlisted
  // dialog, the workspace trust dialog (DIALOGS names it), and a question
  // with nothing to choose.
  assert.equal(DIALOGS[0].anchor, 'Accessing workspace:');
  const source = [
    'var x=1;',
    'function q(a){return h("box",null,"Switch to the new folder before continuing?","Yes, switch","No, stay here")}',
    'function q(a){return h("box",null,"Accessing workspace:","Is this a project you created or one you trust?","Yes, I trust this folder")}',
    'function q(a){return h("box",null,"Something went wrong while loading the file?","Retry later")}',
  ].join('\n');
  const found = dialogClusters(source);
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].strings, ['box', 'Switch to the new folder before continuing?', 'Yes, switch', 'No, stay here']);
});
