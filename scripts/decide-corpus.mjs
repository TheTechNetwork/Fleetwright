// The labelled corpus scripts/decide-harness.mjs measures Clef-flash against
// (docs/decide-design.md, section F). Every item is labelled by hand.
//
// FOUR GROUPS, and the two that decide are the last two:
//   fixture     the committed captures in test/fixtures, as Claude Code drew them
//   historical  the rewording that has already blinded the matchers once, drawn
//               the way the pinned release draws it (unnumbered, "No, exit" first)
//   reworded    ten hand-written rewordings per dialog kind. They avoid every
//               phrase AWAITING_RE and readPrompt know, ON PURPOSE: they stand
//               for the next rewording, which is the case the model is for. The
//               harness measures the regexes on them anyway rather than
//               assuming the answer.
//   negative    panes that must never read as asked: a working pane printing a
//               numbered plan, a ready pane with a numbered list in scrollback,
//               a shell prompt, build output, and the assistant asking its own
//               question in prose above an empty prompt. The 2.1.284 bypass
//               capture and the 2.1.234 ready and working captures are here too.
//
// No item carries a real credential, path or name. Panes are drawn at 120
// columns like the captures.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const fixture = (name) => readFileSync(fileURLToPath(new URL(`../test/fixtures/${name}`, import.meta.url)), 'utf8');

const RULE = '─'.repeat(120);

/** A dialog as Claude Code lays one out: rule, title, body, options, footer. */
function dialog({ title, body, options, numbered = true, cursor = 0, footer = 'Enter to confirm · Esc to cancel' }) {
  const lines = ['', RULE];
  if (title) lines.push(` ${title}`, '');
  for (const b of body) lines.push(` ${b}`);
  lines.push('');
  options.forEach((o, i) => {
    const mark = i === cursor ? '❯' : ' ';
    lines.push(` ${mark} ${numbered ? `${i + 1}. ` : ''}${o}`);
  });
  if (footer) lines.push('', ` ${footer}`);
  return lines.join('\n') + '\n';
}

/** A ready Claude Code pane: whatever scrollback, then the empty prompt and the mode line. */
function ready(scrollback, mode = '⏵⏵ bypass permissions on (shift+tab to cycle)') {
  return `${scrollback.join('\n')}\n\n${RULE}\n❯ \n${RULE}\n  ${mode}\n`;
}

/** A working pane: scrollback, the spinner, and the mode line's working form. */
function working(scrollback, spinner = '✻ Thinking… (12s · ↓ 340 tokens)') {
  return `${scrollback.join('\n')}\n\n${spinner}\n\n${RULE}\n❯ \n${RULE}\n  ⏵⏵ bypass permissions on · esc to interrupt\n`;
}

const reworded = {
  trust: [
    dialog({ title: 'Opening a workspace:', body: ['/work/app', '', 'Before we start: did you make this project yourself, or does it come from somewhere you rely on?', 'Files here can be read, changed and run.'], options: ['Yes, continue in this folder', 'No, quit'] }),
    dialog({ title: 'Workspace check', body: ['Claude Code can read, edit and run anything in this folder.', 'Are you confident the contents of this folder are safe?'], options: ['No, exit', 'Yes, I am confident'], numbered: false }),
    dialog({ title: 'New folder', body: ['This folder has not been opened before.', 'Only continue if you know where its code came from.'], options: ['Continue', 'Exit'] }),
    dialog({ title: 'Safety first', body: ['Is the code in this folder yours, or from a source you rely on?', 'If you are not sure, look through it before going on.'], options: ['It is mine or from a source I rely on', 'Not sure, exit'] }),
    dialog({ title: 'Accessing project:', body: ['/srv/repo', '', 'Do you vouch for this project? It will be able to run commands on this machine.'], options: ['I vouch for it', 'Leave'], numbered: false, cursor: 1 }),
    dialog({ title: null, body: ['Quick check before we begin', 'Does this folder hold code you wrote or code from people you know?'], options: ['Yes, start here', 'No, close Claude Code'] }),
    dialog({ title: 'Folder permission', body: ['Allow Claude Code to work with the files in this folder?', 'It may read, edit and execute them.'], options: ['Allow', 'Deny and exit'] }),
    dialog({ title: 'Untrusted folder', body: ['This location is not on your list of known projects.', 'Mark it as known and continue?'], options: ['Mark as known', 'Exit'], footer: '↑↓ to select · Enter to choose' }),
    dialog({ title: 'Workspace:', body: ['/home/dev/scratch', '', 'Should Claude Code treat this folder as safe to work in?'], options: ['Treat as safe', 'Do not, exit'], numbered: false }),
    dialog({ title: 'First time here', body: ['You are opening a project for the first time.', 'Proceed only if you know what is in it.'], options: ['Proceed', 'Go back'] }),
  ],
  permission: [
    dialog({ title: 'Bash command', body: ['  npm run build', '  Build the web bundle', '', 'May I run this command?'], options: ['Yes', "Yes, and don't ask again for npm run build", 'No, and tell Claude what to do differently (esc)'] }),
    dialog({ title: 'Edit file', body: ['  src/index.js', '', 'Shall I make this edit to index.js?'], options: ['Yes', 'Yes, allow all edits during this session', 'No'] }),
    dialog({ title: 'Tool use', body: ['  WebFetch(https://example.com/docs)', '', 'Allow this fetch?'], options: ['Allow once', 'Always allow for this domain', 'Deny'] }),
    dialog({ title: 'Bash command', body: ['  rm -rf build', '  Clean the build directory', '', 'Okay to go ahead?'], options: ['Go ahead', 'Stop'] }),
    dialog({ title: 'Write file', body: ['  notes/todo.md', '', 'Create this file?'], options: ['Create it', 'Create it and stop asking', 'Cancel'], numbered: false }),
    dialog({ title: 'Approve command', body: ['  git push origin main', '', 'This will publish your commits. Continue?'], options: ['Continue', 'Abort'] }),
    dialog({ title: 'MCP tool', body: ['  github.create_issue', '', 'Claude wants to use this tool. Permit it?'], options: ['Permit', 'Permit for the rest of the session', 'Refuse'] }),
    dialog({ title: 'Bash command', body: ['  docker compose up -d', '', 'Run it?'], options: ['Run', 'Skip'], footer: 'Esc to cancel · Tab to amend' }),
    dialog({ title: 'Read file', body: ['  ../secrets.env', '  Outside the working directory', '', 'Allow reading a file outside this project?'], options: ['Allow', 'Deny'] }),
    dialog({ title: 'Network access', body: ['  curl https://api.example.com/health', '', 'This command reaches the network. Permit?'], options: ['Yes, once', 'No'] }),
  ],
  resume: [
    dialog({ title: 'Continue earlier session', body: ['This conversation is long: about 180k tokens.', 'Pick up from a condensed version, or load all of it?'], options: ['Condensed version (recommended)', 'Load everything', "Don't ask again"] }),
    dialog({ title: 'Resuming', body: ['Loading the whole history will use most of your context.', 'How would you like to continue?'], options: ['Start from a recap', 'Load the whole history'] }),
    dialog({ title: null, body: ['Picking up where you left off', 'A short recap is ready. Use it, or bring back every message?'], options: ['Use the recap', 'Bring back every message'] }),
    dialog({ title: 'Session restore', body: ['The saved session has 412 messages.', 'Restore all of them or a summary?'], options: ['A summary', 'All of them'], numbered: false }),
    dialog({ title: 'Continue session', body: ['Restoring in full costs about 150k tokens of context.'], options: ['Restore a digest', 'Restore in full', 'Never ask'] }),
    dialog({ title: 'Back again', body: ['Last time ended mid-task. Continue from a brief or from the full log?'], options: ['From a brief', 'From the full log'] }),
    dialog({ title: 'Resume', body: ['This will reload a large conversation.', 'Reload it compacted, or as it was?'], options: ['Compacted', 'As it was'], cursor: 1 }),
    dialog({ title: 'Reopening chat', body: ['How much of the old chat should come back?'], options: ['Just the gist', 'Everything'] }),
    dialog({ title: 'Restore context', body: ['The previous context was large (91%).', 'Continue with a shortened version?'], options: ['Yes, shortened', 'No, the original'], numbered: false }),
    dialog({ title: 'Continuing', body: ['Rebuild the session from a condensed summary or replay it?'], options: ['Condensed summary', 'Replay'] }),
  ],
  directory: [
    dialog({ title: 'Changing directory:', body: ['/work/other', '', 'Move this session into that folder?'], options: ['Move', 'Stay here'], numbered: false }),
    dialog({ title: 'Switch folder', body: ['Claude Code will continue in /srv/api. Is that folder one you know?'], options: ['Yes, switch', 'No, stay'] }),
    dialog({ title: 'Now working in:', body: ['/home/dev/site', '', 'This folder has its own settings. Apply them?'], options: ['Apply its settings', 'Ignore them'], numbered: false }),
    dialog({ title: 'Relocate session', body: ['Continue this conversation from /tmp/build?'], options: ['Relocate', 'Cancel'] }),
    dialog({ title: 'Change working folder', body: ['You asked to work in ../client. That is outside the current project.', 'Go there?'], options: ['Go there', 'Stay put'] }),
    dialog({ title: 'Entered a new folder:', body: ['/work/infra', '', 'Load the project rules found here?'], options: ['Load them', 'Keep current rules'] }),
    dialog({ title: 'Directory change', body: ['Switch to /opt/tools and keep going there?'], options: ['Switch', 'Do not switch'], numbered: false, cursor: 1 }),
    dialog({ title: 'Folder move', body: ['The session will follow you to /work/docs.', 'Is that what you want?'], options: ['Yes, follow', 'No'] }),
    dialog({ title: 'Different project', body: ['/work/mobile looks like a separate project.', 'Continue there with its configuration?'], options: ['Continue there', 'Remain here'] }),
    dialog({ title: 'Moving on:', body: ['/data/etl', '', 'Should this session now run from that directory?'], options: ['Run from there', 'Cancel'], numbered: false }),
  ],
  'api-key': [
    dialog({ title: 'API key detected', body: ['An ANTHROPIC_API_KEY is set in this environment: sk-ant-api03-…xQ', 'Use it instead of your subscription?'], options: ['Use the key', 'Keep my subscription'] }),
    dialog({ title: 'Custom key', body: ['Claude Code found an API key in your shell.', 'Should requests be billed to that key?'], options: ['Yes, bill the key', 'No, use my plan'], numbered: false, cursor: 1 }),
    dialog({ title: 'Billing', body: ['A key is available from ANTHROPIC_API_KEY.', 'Which should pay for this session?'], options: ['The API key', 'My Claude subscription'] }),
    dialog({ title: 'Environment key', body: ['Found a key ending in …7f2a.', 'Switch to API usage billing?'], options: ['Switch', 'Stay on the plan'] }),
    dialog({ title: null, body: ['You have an API key configured.', 'Sign in with it for this session?'], options: ['Sign in with the key', 'Ignore it'] }),
    dialog({ title: 'Key found', body: ['Using a key means usage is charged per token.', 'Accept the key?'], options: ['Accept', 'Decline'], numbered: false }),
    dialog({ title: 'Authentication', body: ['ANTHROPIC_API_KEY is present.', 'Prefer it over the logged-in account?'], options: ['Prefer the key', 'Prefer the account'] }),
    dialog({ title: 'Detected credential', body: ['A console key was found in your environment.', 'Should Claude Code use it from now on?'], options: ['Use it from now on', 'Not now'] }),
    dialog({ title: 'API usage', body: ['This key will be charged for every request.', 'Go ahead with the key?'], options: ['Go ahead', 'Cancel'] }),
    dialog({ title: 'Choose how to pay', body: ['An API key and a subscription are both available.'], options: ['API key', 'Subscription'], footer: '↑↓ to select · Enter to choose' }),
  ],
  other: [
    dialog({ title: 'Select model', body: ['Switch between models. Applies to this and future sessions.'], options: ['Default (recommended)', 'Opus', 'Haiku'], footer: 'Enter to confirm · Esc to exit' }),
    dialog({ title: 'Choose the text style that looks best with your terminal', body: [], options: ['Dark mode', 'Light mode', 'Dark mode (colorblind-friendly)'] }),
    dialog({ title: 'Select login method:', body: [], options: ['Claude account with subscription', 'Anthropic Console account'] }),
    dialog({ title: 'Plan ready', body: ['Here is the plan for the refactor. Would you like to go ahead?'], options: ['Yes, and auto-accept edits', 'Yes, and manually approve edits', 'No, keep planning'] }),
    dialog({ title: 'How is Claude doing this session?', body: ['(optional)'], options: ['Bad', 'Fine', 'Good', 'Dismiss'], footer: null }),
    dialog({ title: 'Terminal setup', body: ['Install the Shift+Enter key binding for newlines?'], options: ['Yes, install it', 'No, not now'] }),
    dialog({ title: 'Output style', body: ['Pick how responses are written.'], options: ['Default', 'Explanatory', 'Learning'] }),
    dialog({ title: 'Update available', body: ['A new version is ready. Restart now to apply it?'], options: ['Restart now', 'Later'], numbered: false }),
    dialog({ title: 'Exit plan mode?', body: ['Claude has finished planning.'], options: ['Start implementing', 'Keep planning'] }),
    dialog({ title: 'Rewind', body: ['Restore the code and conversation to this point?'], options: ['Restore code and conversation', 'Restore conversation only', 'Never mind'] }),
  ],
};

const negatives = [
  ['working-numbered-plan', working(['● Here is the plan:', '', '  1. Read the existing watcher tests', '  2. Add a case for the still pane', '  3. Run the suite', '', '● Starting with step 1.', '', '● Read(test/watcher.test.js)', '  ⎿  Read 412 lines'])],
  ['working-numbered-options-in-text', working(['● There are two ways to fix this:', '', '  1. Yes, change the regex to accept both spellings', '  2. No, keep it strict and update the fixture', '', '  I will go with option 1 since it covers older releases.', '', '● Update(src/prompt.js)', '  ⎿  Updated src/prompt.js with 2 additions'])],
  ['ready-numbered-list-scrollback', ready(['● Done. Summary of changes:', '', '  1. Added the mask module', '  2. Added the gate', '  3. Wrote tests for both', '', '  All 48 tests pass.'])],
  ['ready-assistant-asks-in-prose', ready(['● I found two candidate fixes. Which would you prefer?', '', '  1. Widen the regex', '  2. Read the dialog by its title instead', '', '  Tell me which, or describe another approach.'])],
  ['ready-yes-no-in-prose', ready(['● The migration is written but not applied. Do you want me to run it against staging? (yes / no)'])],
  ['shell-prompt', 'Last login: Sat Oct 31 09:12:44 on ttys003\ndev@build-01 ~/work/app (main) $ ls\nREADME.md  package.json  src  test\ndev@build-01 ~/work/app (main) $ \n'],
  ['shell-prompt-root', 'root@runner:/srv# systemctl status fleetwright --no-pager | head -3\n● fleetwright.service - Fleetwright host\n     Loaded: loaded (/etc/systemd/system/fleetwright.service; enabled)\n     Active: active (running) since Sat 2026-10-31 08:00:01 UTC; 1h ago\nroot@runner:/srv# \n'],
  ['build-output', '> fleetwright@0.4.15 test\n> node --test test/*.test.js\n\n✔ mask keeps dialog prose (2.1ms)\n✔ mask removes planted tokens (0.8ms)\n✔ gate refuses a long run (0.3ms)\nℹ tests 1204\nℹ suites 0\nℹ pass 1204\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ duration_ms 48211\n'],
  ['build-output-xcode', '▸ Compiling Naming.swift\n▸ Compiling FleetView.swift\n▸ Linking Fleetwright\n▸ Processing Info.plist\n▸ Signing Fleetwright.app\n** BUILD SUCCEEDED ** [41.2 sec]\n'],
  ['working-tool-output-menu-text', working(['● Bash(npx create-thing --help)', '  ⎿  Usage: create-thing [options]', '     Options:', '       1. --template   choose a template', '       2. --yes        accept all defaults', '       3. --dry-run    print and exit'], '✻ Reading… (31s · ↓ 1.2k tokens)')],
  ['ready-finished-result', ready(['● Pushed to claude/decide-harness and opened the pull request.', '', '  CI is running; I will report back if it fails.'])],
  ['fixture-2.1.284-working-bypass', fixture('claude-2.1.284-working-bypass.txt')],
  ['fixture-2.1.234-ready', fixture('claude-2.1.234-ready.txt')],
  ['fixture-2.1.234-working', fixture('claude-2.1.234-working.txt')],
];

/** @typedef {{ id: string, group: 'fixture'|'historical'|'reworded'|'negative', asked: boolean, kind: string|null, text: string }} CorpusItem */

/** @returns {CorpusItem[]} */
export function corpus() {
  /** @type {CorpusItem[]} */
  const items = [
    { id: 'fixture-2.1.234-trust', group: 'fixture', asked: true, kind: 'trust', text: fixture('claude-2.1.234-trust.txt') },
    {
      id: 'historical-quick-safety-check',
      group: 'historical',
      asked: true,
      kind: 'trust',
      text: dialog({
        title: 'Accessing workspace:',
        body: ['/work/app', '', 'Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source', "project, or work from your team). If not, take a moment to review what's in this folder first."],
        options: ['No, exit', 'Yes, I trust this folder'],
        numbered: false,
      }),
    },
  ];
  for (const [kind, panes] of Object.entries(reworded)) {
    panes.forEach((text, i) => items.push({ id: `reworded-${kind}-${i + 1}`, group: 'reworded', asked: true, kind, text }));
  }
  for (const [id, text] of negatives) items.push({ id: `negative-${id}`, group: 'negative', asked: false, kind: null, text });
  return items;
}
