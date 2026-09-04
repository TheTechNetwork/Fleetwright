// `--upgrade`: an already-enrolled box brought onto new code, unattended.
//
// THE GAP IT FILLS IS THAT THE OLD UNATTENDED MODE DID NOT APPLY THE CODE.
// `AGENT_HUB_NONINTERACTIVE=1` has existed all along and skips the wizard —
// and the wizard is also where the services get restarted. So an unattended
// run put new code on disk and left the OLD CODE RUNNING while reporting
// success, which is the failure src/core/update.js is written around ("the new
// code is on disk but this process is still the old one") happening in the one
// place nobody was looking.
//
// It matters most right now because protocol v3 is a flag day: a host one
// version behind stays CONNECTED AND GREEN — the coordinator checks the
// version per intent and not on connect or health — while every command
// against it is refused. The fleet looks up and nothing works.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const SH = readFileSync(new URL('../install/install.sh', import.meta.url), 'utf8');

test('the installer still parses, which is the floor for a root-executed script', () => {
  execFileSync('bash', ['-n', new URL('../install/install.sh', import.meta.url).pathname]);
});

test('--upgrade exists, is documented, and turns the wizard off', () => {
  assert.match(SH, /^\s*--upgrade\)/m, 'there is no --upgrade flag');
  assert.match(SH, /--upgrade\s+an already-enrolled box onto new code/, '--help does not mention it');
  // Both spellings, because a flag is what somebody types and an environment
  // variable is what a configuration-management tool sets.
  assert.match(SH, /AGENT_HUB_UPGRADE/);
  // It must not ask anything: the wizard with no stdin takes every default
  // silently, on a machine nobody is watching.
  assert.match(SH, /UPGRADE=1; WIZARD=no/);
});

test('it refuses a box that is not already in a fleet, and names what is missing', () => {
  // Enrolling needs a six-digit pin minted by a person in the app — short-lived,
  // single-use, and deliberately not something a script can obtain. So this
  // refuses rather than half-installing. That refusal is the boundary between
  // "unattended upgrade", which is this, and "unattended first enrolment",
  // which is a credential design decision and is not built.
  const block = /if \[ "\$UPGRADE" = 1 \][\s\S]*?\n  fi\n/.exec(SH);
  assert.ok(block, 'the upgrade section is gone');
  assert.match(block[0], /host-key\.json/, 'it does not check that the box is enrolled');
  assert.match(block[0], /\$SIDECAR_ENV/);
  assert.match(block[0], /agent-fleet-sidecar enrol <pin>/, 'the refusal does not say how to fix it');
});

test('it restarts the services, which is the whole point', () => {
  const section = SH.slice(SH.indexOf('# --- 9.'));
  for (const unit of ['agent-hub', 'agent-fleet-coordinator', 'agent-fleet-sidecar']) {
    assert.ok(section.includes(unit), `${unit} is never restarted`);
  }
  // Only units that exist. A box with no local coordinator has nothing to
  // restart, and trying prints a failure about something absent on purpose.
  assert.match(section, /list-unit-files/);
  // And macOS, which uses launchd and needs bootout before bootstrap —
  // bootstrap on a loaded label fails rather than replacing it, which is an
  // upgrade that leaves the old code running while reporting success.
  assert.match(section, /launchctl bootout/);
  assert.match(section, /launchctl bootstrap/);
});

test('it compares this box against the coordinator and says so plainly', () => {
  const section = SH.slice(SH.indexOf('# --- 9.'));
  // /healthz, which needs no credential — the point is to be readable from a
  // box that is being repaired.
  assert.match(section, /healthz/);
  assert.match(section, /PROTOCOL MISMATCH/);
  // The sentence has to say what the symptom LOOKS like, because the symptom
  // is the fleet looking healthy.
  assert.match(section, /look healthy/);
  assert.match(section, /unsupported_version/);
});

test('the version it reports is read from the protocol, not written down twice', async () => {
  // A number duplicated into a shell script is a number that is wrong one
  // release later, and this one's whole job is to be trusted during an upgrade.
  const section = SH.slice(SH.indexOf('# --- 9.'));
  assert.match(section, /src\/fleet\/protocol\/intents\.js/);
  assert.match(section, /PROTOCOL_VERSION/);

  const { PROTOCOL_VERSION } = await import('../src/fleet/protocol/intents.js');
  assert.equal(typeof PROTOCOL_VERSION, 'number');
  // No literal version number anywhere in the section — the failure mode is a
  // hardcoded 3 that keeps saying 3 after the next bump.
  assert.equal(/v[0-9]+\b/.test(section.replace(/\$UPGRADE_(MINE|THEIRS)/g, '')), false,
    'the upgrade section hardcodes a protocol number');
});

// --- the one-liner, which is the whole point of the two changes above -------

test('a piped install can still ask, because it asks the terminal', () => {
  // A piped install has no stdin of its own, so `read` sees EOF and every
  // question takes its default.
  //
  // bootstrap.sh ALREADY handles that for the documented one-liner — it opens
  // /dev/tty and re-execs install.sh with stdin attached — so `curl | sudo sh`
  // has always reached the wizard. Verified with a pty rather than assumed.
  //
  // What this removes is the DEPENDENCE on being invoked that way. Every other
  // route — `sh -c "$(curl …)"`, piping straight into install.sh, a wrapper —
  // got a silent wizard that took defaults on somebody's box.
  assert.match(SH, /elif \[ -r \/dev\/tty \]; then ASK_IN=\/dev\/tty/);
  assert.match(SH, /read -r __reply <"\$ASK_IN"/);

  // The auto-detection has to agree, or the questions exist and are never
  // reached. It was `[ -t 0 ] && [ -t 1 ]`, and the first half was the bug.
  assert.match(SH, /if \[ -n "\$ASK_IN" \] && \[ -t 1 \]; then WIZARD=yes/);
  assert.equal(/\[ -t 0 \] && \[ -t 1 \]; then WIZARD=yes/.test(SH), false, 'the old stdin-only test is back');

  // AND NOBODY AT ALL IS STILL A CASE. cron, a CI job, a container build: no
  // stdin and no tty, so `ask` returns the default without printing a prompt
  // into a log nobody reads.
  assert.match(SH, /else ASK_IN=""; fi/);
  assert.match(SH, /if \[ -z "\$ASK_IN" \]; then printf -v "\$__var"/);
});

test('curling a coordinator means joining that coordinator, without being asked twice', () => {
  // The address is in what somebody typed. Asking for it again is asking them
  // to repeat themselves, and offering to run a second coordinator on the box
  // is offering the opposite of what they asked for.
  assert.match(SH, /JOINING="\$\{AGENT_FLEET_COORDINATOR_URL:-\}"/);
  assert.match(SH, /if \[ -n "\$JOINING" \]; then/);
  assert.match(SH, /ok "joining \$JOINING"/);

  // Telegram is not asked either: somebody joining a fleet drives it from the
  // app, and a question about a chat bot mid-flow is a question about
  // something else. The env keys stay for anyone who wants them.
  assert.match(SH, /if \[ -z "\$JOINING" \] && \[ -z "\$\(get_env "\$ENV_FILE" AGENT_HUB_TELEGRAM_TOKEN\)" \]/);

  // Local and stdio are NOT a fleet being joined — they are what the wizard
  // offers to set up — so they must not suppress the questions.
  assert.match(SH, /stdio:\*\|http:\/\/127\.0\.0\.1\*/);
});

test('joining a fleet still costs a pin, and the one-liner changes nothing about that', () => {
  // The shim carries an ADDRESS. It is not a secret — it is the URL somebody
  // typed, and it is in their shell history. Enrolment is unchanged: a
  // six-digit pin, minted by a person in the app, short-lived and single-use.
  //
  // The only path that mints a pin without being asked is a box running its own
  // coordinator, using the admin token generated on that same machine seconds
  // earlier. That is not a shared credential; it is a box authorising itself.
  const enrol = /enrol_host\(\) \{[\s\S]*?\n  \}/.exec(SH);
  assert.ok(enrol, 'enrol_host is gone');

  // A remote fleet always asks.
  assert.match(enrol[0], /ask pin "Enrolment pin"/);
  assert.match(enrol[0], /not enrolled — this host will be refused until it is/);
  // Six digits or nothing — a pin is not free text.
  assert.match(enrol[0], /\$\{#pin\} -ne 6/);
  // The self-mint is gated on running the coordinator here, and on nothing else.
  assert.match(enrol[0], /if \[ "\$FLEET_LOCAL" = 1 \]/);

  // NOTHING JOINS A FLEET FROM AN ENVIRONMENT VARIABLE. The shim exports one,
  // and it is an address; if enrolment ever grew a credential it could read
  // instead of asking, this is where it would appear.
  //
  // Matched on EXPANSION rather than on the name, because the name appears
  // twice for good reasons — see below — and a fuzzy absence test that fires on
  // the cleanup code is a test somebody deletes.
  assert.equal(/enrol[^\n]*\$\{?AGENT_FLEET_[A-Z_]*(TOKEN|SECRET|KEY)/i.test(SH), false,
    'enrolment reads a credential out of the environment');

  // AND THE DEAD ONE IS REMOVED RATHER THAN HONOURED. A box installed before
  // per-host keypairs has AGENT_FLEET_HOST_TOKEN in its env file — one string
  // every machine presented, indistinguishable hosts, no way to revoke one.
  // The installer strips it on upgrade, which is the migrate-and-clean-up half
  // of what a re-install is for.
  assert.match(SH, /replace\(\/\^AGENT_FLEET_HOST_TOKEN=\.\*/);
});

test('an existing install is offered a clean, even from the one-liner', () => {
  // The offer already existed. Its gate was `! [ -t 0 ]`, which is correct for
  // the documented one-liner — bootstrap.sh attaches /dev/tty first — and wrong
  // for every other way of piping the script in, where it silently took
  // "update" on a box that may have been a clone. That is the case the prompt
  // itself calls out as the one where keeping is the broken choice.
  assert.match(SH, /elif \[ "\$WIZARD" = no \] \|\| \[ -z "\$ASK_IN" \]; then/);
  assert.match(SH, /1\) Update/);
  assert.match(SH, /2\) Clean/);

  // The second gate too — typing YES, which cannot be done by leaning on the
  // return key. It was behind `[ -t 0 ]` as well, so a piped install that chose
  // Clean would have skipped the confirmation for the one irreversible action
  // in the script.
  assert.match(SH, /if \[ -n "\$ASK_IN" \]; then\n        if \[ -f \/var\/lib\/agent-fleet\/host-key\.json \]/);
  assert.match(SH, /Are you sure you want to delete\? Type YES/);

  // And genuinely nobody still means update, never destroy.
  assert.match(SH, /Nobody to ask — updating/);
});

test('--repair puts back what the installer generates, and nothing it was told', () => {
  // The sections that write units, the hook and the directories already rewrite
  // what they own on every run, so an unattended run repairs most of a drifted
  // box. The two sudoers rules are the exception: they live behind questions in
  // the wizard, and the wizard does not run when nobody is there to answer.
  assert.match(SH, /^\s*--repair\)/m, 'there is no --repair flag');
  assert.match(SH, /REPAIR=1; UPGRADE=1; WIZARD=no/, 'repair should imply upgrade and ask nothing');
  assert.match(SH, /AGENT_HUB_REPAIR/, 'no environment form for configuration management');
  assert.match(SH, /--repair      --upgrade, and put back/, '--help does not mention it');
});

test('a repair reads the recorded answers and never writes one', () => {
  // A box that said no to system upgrades keeps its no. Re-applying a rule the
  // box already agreed to is acting on somebody's decision; turning one on
  // because a repair happened to run would be making it for them.
  const section = SH.slice(SH.indexOf('# --- 8b.'), SH.indexOf('# --- 9.'));

  assert.match(section, /get_env "\$ENV_FILE" AGENT_HUB_SYSTEM_UPGRADE\)" = 1/);
  assert.match(section, /get_env "\$ENV_FILE" AGENT_HUB_SYSTEM_REBOOT\)" = 1/);
  assert.equal(/set_env/.test(section), false, 'the repair writes a setting — it must only read them');

  // And says so when it leaves one alone, or a repair that silently did less
  // than expected looks like one that did nothing.
  assert.match(section, /leaving that alone/);
});

test('the sudoers rules have one implementation, called twice', () => {
  // The wizard writes them when somebody says yes; --repair writes them when
  // the env file says they already did. Two copies of a rule that must match is
  // how a box ends up permitted to run a command the code no longer issues —
  // which is the drift --repair exists to undo.
  assert.match(SH, /^write_upgrade_sudoers\(\) \{/m);
  assert.match(SH, /^write_reboot_sudoers\(\) \{/m);
  assert.equal((SH.match(/if write_upgrade_sudoers; then/g) || []).length, 2, 'not called from both places');
  assert.equal((SH.match(/if write_reboot_sudoers; then/g) || []).length, 2, 'not called from both places');

  // Both validate before installing. A malformed file in /etc/sudoers.d does
  // not break one rule, it breaks sudo.
  const writers = SH.slice(SH.indexOf('write_upgrade_sudoers() {'), SH.indexOf('# --- 1. prerequisites'));
  assert.equal((writers.match(/visudo -cf/g) || []).length, 2, 'a rule is installed without being validated');
});
