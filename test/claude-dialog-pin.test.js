// The Claude Code release this repository pins, and the check that reads its
// dialogs.
//
//   node --test test/claude-dialog-pin.test.js
//
// The binary itself is read by scripts/claude-dialog-check.mjs in CI, which
// downloads it. What is tested here is which release that is, and the
// decisions src/fleet/host/claude-dialogs.js makes about what it finds.
//
// THE COMPONENTS BELOW ARE WRITTEN BY HAND, in the shape the minified source
// of Claude Code 2.1.310 has them: the same titles, sentences, labels and
// props, around a body cut down to what the check reads. Claude Code's source
// is not ours to commit, and the real binary is what CI runs against.

import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { dialogProblems, DIALOGS } from '../src/fleet/host/claude-dialogs.js';
import { claudeCodeVersion, PINNED_IN } from '../scripts/claude-dialog-check.mjs';

test('the release checked is the one the macOS hosts and the session image pin, read as Renovate reads it', () => {
  // One Renovate pull request bumps all three files, so a version that is
  // read the way Renovate reads it is current for as long as they are.
  assert.match(claudeCodeVersion(), /^\d+\.\d+\.\d+$/);
});

test('a pin that disagrees with the others is refused, by name', (t) => {
  // "The pinned release" stops meaning one thing when somebody bumps the
  // image by hand and not the hosts. Checking either would be checking
  // something one of them does not run.
  const root = mkdtempSync(path.join(tmpdir(), 'claude-pin-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const here = new URL('..', import.meta.url).pathname;
  for (const file of ['renovate.json', ...PINNED_IN]) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    copyFileSync(path.join(here, file), path.join(root, file));
  }
  const image = path.join(root, 'sandbox/Containerfile');
  writeFileSync(image, readFileSync(image, 'utf8').replace(/ARG CLAUDE_VERSION=\S+/, 'ARG CLAUDE_VERSION=0.0.1'));
  assert.throws(() => claudeCodeVersion(root), /sandbox\/Containerfile 0\.0\.1/);
});

const WORKSPACE_TRUST = String.raw`function Kt(h){let o=w(66);const Me=Na,dr="Accessing workspace:";let W=r(n,{children:["Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what","'","s in this folder first."]}),N=r(n,{children:["Claude Code","'","ll be able to read, edit, and execute files here."]});let Y=e(ir,{refuseInput:O,hideIndexes:!0,cancelFirst:!0,focus:"cancel",confirmLabel:"Yes, I trust this folder",cancelLabel:u?"No, continue without these permissions":"No, exit",onConfirm:U,onCancel:X});return e(Me,{color:"warning",title:dr,children:[W,N,Y]})}`;

const RC_TRUST = String.raw`async function pe({dir:r,asker:e=N}){let i=` +
  '`Error: Workspace not trusted. Please run \\`claude\\` in ${a} first to review and accept the workspace trust dialog.`' +
  String.raw`,w=["",e.opening,` + '`Quick safety check: is this a project you created or one you trust? ${e.grant}`' + String.raw`],_=` +
  '`Trust ${S}?`' + String.raw`;return await N6e(_,T)}`;

const CD = String.raw`function H(h){let o=w(36),{directory:i,backstop:u}=h,c=u===void 0?!1:u;const D=c?"Now in a new directory:":"Moving to a new directory:";let x=c?e(n,{children:"Its settings declare project permission rules and/or additional directories. They apply only if you trust this directory explicitly (it is trusted through a parent directory so far)."}):r(Q,{children:[r(n,{children:["This session hasn","'","t worked here before. Is this a directory you created or one you trust?"]})]});const Z=c?"Yes, trust it and apply them":"Yes, move here",le=c?"No, keep them off":"No, stay put";let W=e(ir,{hideIndexes:!0,cancelFirst:!0,focus:"cancel",confirmLabel:Z,cancelLabel:le,onConfirm:z,onCancel:K});return e(Na,{color:"warning",title:D,children:[x,W]})}`;

const BASH = String.raw`function Bk(h){let je=h.fitted,rr=h.where;return e(TI,{fitted:je,children:r(Ba,{title:je.isFitted?"Run command":rr===void 0?"Bash command":` +
  '`Bash command (${rr})`' + String.raw`,children:[!je.isFitted&&e(n,{children:"Do you want to proceed?"}),e(Je,{options:kn,onChange:Hn,onCancel:er})]})})}`;

const RESUME = String.raw`function m_e(h){let Z=w(22);const je=` + '`This session is ${Ce} old and ${Fe} tokens.`' +
  String.raw`;let Ge=e(s,{children:e(n,{children:"Resuming the full session will consume a substantial portion of your usage limits. We recommend resuming from a summary."})});const et=H?"Resume from summary (instant, recommended)":"Resume from summary (recommended)";let yt={value:"continue",label:"Resume full session as-is"},Ct={value:"never",label:"Don't ask me again"};return r(we,{title:je,children:[Ge,e(Je,{options:[{value:"compact",label:et},yt,Ct]})]})}`;

/** @param {string[]} parts */
const binary = (...parts) => parts.join(';import"/$bunfs/root/chunk.js";\n');
const PINNED = binary(WORKSPACE_TRUST, RC_TRUST, CD, BASH, RESUME);

test('every dialog the pinned CLI draws is one the fleet notices and reads as what it is', () => {
  const { problems, notes } = dialogProblems(PINNED);
  assert.deepEqual(problems, []);
  // And the ones it cannot answer are said out loud rather than passed over.
  assert.equal(notes.filter((n) => /cannot be answered/.test(n)).length, DIALOGS.filter((d) => !d.answered).length, notes.join('\n'));
});

test('a reworded trust question fails, even while another dialog still asks the old one', () => {
  // The miss the phrase list had: the Remote Control and /cd components both
  // still say "…or one you trust?", so a check counting phrases found one and
  // passed while the dialog every new session opens on had changed.
  const reworded = WORKSPACE_TRUST.replace(
    'Quick safety check: Is this a project you created or one you trust?',
    'Before you start: do you know and trust what is in this folder?',
  );
  const { problems } = dialogProblems(binary(reworded, RC_TRUST, CD, BASH, RESUME));
  assert.ok(problems.some((p) => /^The workspace trust dialog is not read as a trust question/.test(p)), problems.join('\n'));
});

test('a retitled /cd dialog fails rather than going unnoticed', () => {
  const retitled = CD.replace('"Moving to a new directory:"', '"Change directory?"');
  const { problems } = dialogProblems(binary(WORKSPACE_TRUST, RC_TRUST, retitled, BASH, RESUME));
  assert.ok(problems.some((p) => /Cannot find \/cd's move-directory dialog/.test(p)), problems.join('\n'));
});

test('a trust question from a component nobody listed fails', () => {
  const stranger = String.raw`function Zq(h){return e(Na,{title:"Opening a worktree:",children:e(n,{children:"Is this a worktree you created or one you trust?"})})}`;
  const { problems } = dialogProblems(binary(PINNED, stranger));
  assert.ok(problems.some((p) => /does not know asks “Is this a worktree you created or one you trust\?”/.test(p)), problems.join('\n'));
});

test('a dialog the fleet answers with a digit, drawn without digits, fails', () => {
  const hidden = BASH.replace('e(Je,{options:kn', 'e(Je,{hideIndexes:!0,options:kn');
  const { problems } = dialogProblems(binary(WORKSPACE_TRUST, RC_TRUST, CD, hidden, RESUME));
  assert.ok(problems.some((p) => /Bash permission dialog draws its options without numbers/.test(p)), problems.join('\n'));
});

test('a binary this cannot read fails closed', () => {
  // Stripped, compressed, or bytecode only: no dialog found is not a pass.
  const { problems } = dialogProblems('nothing about a dialog in here');
  assert.equal(problems.filter((p) => /^Cannot find /.test(p)).length, DIALOGS.length, problems.join('\n'));
});
