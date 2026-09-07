// What is out of date on this box, and — if you have said so explicitly — how
// to fix it.
//
// Two separate questions that get confused because they both say "update":
//
//   the APP    a git checkout that can be fast-forwarded (see update.js)
//   the BOX    distribution packages, security fixes, a pending reboot
//
// This file answers the second and reports on the first, so a phone or a chat
// message can say "3 security updates and a reboot pending" without anybody
// logging in to look.
//
// READING IS FREE, ACTING IS NOT. Everything in the check path runs as the
// service user with no privilege at all: `apt list --upgradable` needs none,
// and neither does reading /var/run/reboot-required. Actually applying updates
// needs root, which this service deliberately does not have — see runUpgrade.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { existsSync, statSync } from 'node:fs';

import { log } from '../log.js';

const CHECK_TIMEOUT_MS = 20_000;

/** @param {string[]} argv */
function run(argv, timeout = CHECK_TIMEOUT_MS) {
  // DEBIAN_FRONTEND for debconf, which reads it from the environment and has no
  // other way to be told. sudo's env_reset would drop it, so the sudoers rule
  // carries `Defaults!/usr/bin/apt-get env_keep += "DEBIAN_FRONTEND"` — scoped
  // to that one command, because what happens when a PERSON runs apt on this
  // box is their machine's business and not ours to change.
  //
  // Harmless on every other command run here: apt-get and dpkg-query read it,
  // nothing else looks.
  const r = spawnSync(argv[0], argv.slice(1), {
    encoding: 'utf8',
    timeout,
    env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' },
  });
  return { status: r.status ?? 1, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}

/**
 * The two forms of the upgrade command, and why there are two.
 *
 * `APT_SAFE` is what should run: noninteractive, and answering conffile prompts
 * conservatively so a package that ships a changed config cannot stall an
 * upgrade nobody is watching. `APT_PLAIN` is what a box installed before that
 * rule is permitted to run — sudo matches the whole command line, so the extra
 * options are a refusal on an old rule rather than an unknown flag.
 *
 * Kept beside each other because the fallback only makes sense as a pair: the
 * day nothing is left on the old rule, both go.
 */
const APT_PLAIN = Object.freeze(['/usr/bin/apt-get', '-y', 'upgrade']);
const APT_SAFE = Object.freeze([
  '/usr/bin/apt-get',
  '-y',
  '-o',
  'Dpkg::Options::=--force-confold',
  '-o',
  'Dpkg::Options::=--force-confdef',
  'upgrade',
]);

/**
 * The part of a failed apt run that says WHY.
 *
 * This was `(r.stderr || r.stdout).split('\n').slice(-4)`, and both halves of
 * that were wrong in the same direction — they discarded the answer.
 *
 * STDERR OR STDOUT, NOT EITHER. apt writes its progress and dpkg's own error
 * detail to stdout and debconf's complaints to stderr. Choosing stderr when it
 * is non-empty means the stream carrying the cause is never read, and debconf
 * makes stderr non-empty on virtually every unattended run:
 *
 *   debconf: unable to initialize frontend: Teletype
 *   debconf: (This frontend requires a controlling tty.)
 *   debconf: falling back to frontend: Noninteractive
 *   E: Sub-process /usr/bin/dpkg returned an error code (1)
 *
 * That is what reached somebody's phone. Every line of it is noise except the
 * last, which says only that dpkg failed — and the four-line window was
 * entirely filled by the noise, so the package that actually broke was never
 * shown. "Run it on the box to see the whole output" then sends them to a shell
 * for something the coordinator already had.
 *
 * THE DEBCONF LINES ARE DROPPED, not because warnings should be hidden, but
 * because these three are not about this run: debconf says it cannot use a
 * teletype, and then says it fell back successfully. Keeping them costs the
 * space the real error needs.
 *
 * @param {{ stdout: string, stderr: string }} r
 */
export function upgradeFailureDetail(r) {
  const noise = /^debconf: (unable to initialize frontend|\(This frontend requires|falling back to frontend)/;
  const lines = `${r.stdout}\n${r.stderr}`
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l && !noise.test(l));
  // Twelve rather than four. dpkg names the package on one line and explains on
  // the next few, and apt appends its own summary after that — a four-line tail
  // reliably catches the summary and misses the cause.
  const tail = lines.slice(-12);
  return tail.length ? tail.join('\n') : 'apt said nothing about why.';
}

/**
 * Packages this box could upgrade, and whether it is waiting for a reboot.
 *
 * apt only. A box running something else gets `supported: false` rather than a
 * wrong answer — guessing at a package manager is how you end up reporting
 * "0 updates" on a machine that has never checked.
 *
 * @returns {{ supported: boolean, count: number, security: number, rebootRequired: boolean, packages: string[], listsAgeHours?: number|null, reason?: string }}
 */
export function systemUpdates() {
  const none = { supported: false, count: 0, security: 0, rebootRequired: false, packages: [] };
  if (!existsSync('/usr/bin/apt')) return { ...none, reason: 'not an apt system' };

  const r = run(['apt', 'list', '--upgradable']);
  if (r.status !== 0) return { ...none, reason: r.stderr.split('\n')[0] || 'apt failed' };

  const lines = r.stdout
    .split('\n')
    .filter((l) => l.includes('/') && !l.startsWith('Listing'))
    .map((l) => l.trim());
  const security = lines.filter((l) => /-security/i.test(l)).length;

  return {
    supported: true,
    count: lines.length,
    security,
    rebootRequired: existsSync('/var/run/reboot-required'),
    listsAgeHours: packageListAgeHours(),
    // Names only. The full apt line is version noise that no notification has
    // room for.
    packages: lines.map((l) => l.split('/')[0]).slice(0, 20),
  };
}

/**
 * Roughly how long since the package lists were fetched.
 *
 * This matters more than it looks. A minimal Debian does not refresh them on
 * its own — apt-daily.timer only does so when unattended-upgrades has written
 * the periodic config, which a fresh install has not. So `apt list
 * --upgradable` on such a box answers against whatever was current the day it
 * was installed, and reports nothing forever while the machine falls months
 * behind. Reporting "0 updates" there is worse than reporting nothing.
 *
 * Approximate on purpose: the lists directory is touched when anything is
 * written, which is what "we asked recently" means here.
 *
 * @returns {number|null}
 */
function packageListAgeHours() {
  for (const p of ['/var/lib/apt/periodic/update-success-stamp', '/var/lib/apt/lists']) {
    try {
      return Math.round((Date.now() - statSync(p).mtimeMs) / 3_600_000);
    } catch {
      /* try the next one */
    }
  }
  return null;
}

/**
 * Refresh the package lists, if this box has been given permission to.
 *
 * `apt-get update` fetches metadata and changes nothing else, which is why it
 * shares the sudoers rule with the upgrade rather than needing a decision of
 * its own. Rate-limited hard: the lists do not change minute to minute, and
 * this runs off a health report.
 *
 * @param {{ systemUpgrade?: boolean }} cfg
 * @param {{ now?: () => number, minAgeHours?: number }} [opts]
 */
export function refreshPackageLists(cfg, { now = () => Date.now(), minAgeHours = 6 } = {}) {
  if (!cfg.systemUpgrade) return { ok: false, reason: 'not permitted' };
  const age = packageListAgeHours();
  if (age !== null && age < minAgeHours) return { ok: false, reason: 'recent enough' };
  if (now() - lastRefreshAttempt < minAgeHours * 3_600_000) return { ok: false, reason: 'tried recently' };

  lastRefreshAttempt = now();
  const r = run(['sudo', '-n', '/usr/bin/apt-get', 'update'], 120_000);
  if (r.status !== 0) {
    log.warn(`upgrade: could not refresh package lists: ${(r.stderr || r.stdout).split('\n')[0]}`);
    return { ok: false, reason: 'failed' };
  }
  log.info('upgrade: refreshed package lists');
  return { ok: true };
}

let lastRefreshAttempt = 0;

/**
 * A sentence, or null when there is nothing worth saying.
 *
 * Null rather than "0 updates available" on purpose: this goes into a health
 * report that something else decides whether to surface, and a box with
 * nothing to say should be silent rather than reassuring.
 *
 * @param {ReturnType<typeof systemUpdates>} s
 */
export function describeSystemUpdates(s) {
  const age = typeof s.listsAgeHours === 'number' ? s.listsAgeHours : null;
  const stale = age !== null && age > 48;
  if (!s.supported || (!s.count && !s.rebootRequired && !stale)) return null;
  const parts = [];
  if (s.count) parts.push(`${s.count} package${s.count === 1 ? '' : 's'} can be upgraded`);
  if (s.security) parts.push(`${s.security} security`);
  if (s.rebootRequired) parts.push('reboot pending');
  // Said out loud rather than folded into the count, because a stale list makes
  // the count a lie in the reassuring direction — and on a box that never
  // refreshes on its own, that is the normal state rather than the exception.
  if (stale && age !== null) parts.push(`package lists ${Math.round(age / 24)}d old`);
  return parts.join(' · ');
}

/**
 * Apply system updates.
 *
 * The installer offers to set this up, and the grant is narrow enough to be
 * worth taking: sudoers matches the FULL ARGV, so the rule permits
 * `apt-get -y upgrade` and nothing else — not install, not remove, not a
 * shell, not apt-get with other arguments. That is a very different thing from
 * putting the service user in the sudo group.
 *
 * It is still off unless somebody said yes, because a service that can change
 * the operating system should be a decision somebody made rather than a
 * default they inherited. The message below is what an operator sees if it is
 * off and they want it on.
 *
 * @param {import('../config.js').Config} cfg
 * @param {{ actor?: string|null }} [opts]
 */
export function runUpgrade(cfg, { actor = null } = {}) {
  if (!cfg.systemUpgrade) {
    return {
      ok: false,
      text:
        'System upgrades are off.\n\n' +
        'This service runs unprivileged on purpose, so applying packages needs a rule that says ' +
        'so out loud. On the box:\n\n' +
        // THE SAME RULE THE INSTALLER WRITES, and it has to be — somebody who
        // pastes this and somebody who re-runs the installer must end up with
        // the same permissions, or one of them gets an upgrade that stalls on
        // a conffile prompt and the other does not.
        //
        // The backslashes are not decoration: `:` and `=` are sudoers
        // metacharacters, separating the host, runas and command sections, and
        // visudo rejects the line without them.
        '  sudo tee /etc/sudoers.d/agent-hub-upgrade >/dev/null <<\'EOF\'\n' +
        '  Defaults!/usr/bin/apt-get env_keep += "DEBIAN_FRONTEND"\n' +
        `  ${cfg.runUser} ALL=(root) NOPASSWD: /usr/bin/apt-get update, /usr/bin/apt-get -y upgrade, ` +
        '/usr/bin/apt-get -y -o Dpkg\\:\\:Options\\:\\:\\=--force-confold -o Dpkg\\:\\:Options\\:\\:\\=--force-confdef upgrade\n' +
        '  EOF\n' +
        '  sudo chmod 0440 /etc/sudoers.d/agent-hub-upgrade\n\n' +
        'then set AGENT_HUB_SYSTEM_UPGRADE=1 in /etc/agent-hub.env and restart.\n' +
        'Scoped to those three commands: it cannot install, remove or run anything else.',
    };
  }

  const before = systemUpdates();
  if (before.supported && !before.count) {
    return { ok: true, text: 'Nothing to upgrade.' + (before.rebootRequired ? ' A reboot is still pending.' : '') };
  }

  log.warn(`upgrade: applying system updates${actor ? ` for ${actor}` : ''}`);
  // -n: never prompt for a password. If the sudoers rule is missing this fails
  // in a second with a clear message rather than hanging on a prompt nobody can
  // answer.
  //
  // NONINTERACTIVE, AND CONFFILE PROMPTS ANSWERED. Without these a package that
  // ships a changed config file stops to ask which version to keep, on a box
  // with no terminal — debconf falls back to Noninteractive, dpkg gets no
  // answer, and the upgrade fails. That is what the debconf lines in a failure
  // report are really telling you.
  //
  //   --force-confold  keep the config already on the box
  //   --force-confdef  take the maintainer's answer where there is no local change
  //
  // Both are the conservative choice: an upgrade run by a machine must not
  // replace a file somebody edited.
  //
  // TRIED, THEN FALLEN BACK, because sudo matches the WHOLE command line. A box
  // whose /etc/sudoers.d/agent-hub-upgrade predates this rule permits only the
  // bare form, so the safe one is refused — and refusing to upgrade at all
  // would be worse than upgrading the way it always has. Re-running the
  // installer is what moves a box onto the new rule.
  let r = run(['sudo', '-n', ...APT_SAFE], 15 * 60_000);
  if (r.status !== 0 && /not allowed to execute|sorry, user/i.test(`${r.stderr}${r.stdout}`)) {
    log.warn(
      "upgrade: this box's sudoers rule predates the noninteractive flags. " +
        'Fix it without a full reinstall: sudo /opt/agent-fleet/install/install.sh --repair',
    );
    r = run(['sudo', '-n', ...APT_PLAIN], 15 * 60_000);
  }
  if (r.status !== 0) {
    const detail = upgradeFailureDetail(r);
    return {
      ok: false,
      // cfg IS THREADED THROUGH, so the advice can ask systemd rather than
      // print the command that would. Without it the read-only branch falls
      // back to a plain `systemctl` on PATH, which is right on an ordinary box
      // and wrong on one that set AGENT_HUB_SYSTEMCTL_BIN — and being wrong
      // there is silent.
      text: `apt-get upgrade failed:\n${detail}\n\n${adviseOnFailure(detail, '/proc/self/mountinfo', cfg)}`,
    };
  }

  const after = systemUpdates();
  const applied = Math.max(0, before.count - after.count);
  return {
    ok: true,
    text:
      `Upgraded ${applied} package${applied === 1 ? '' : 's'}.` +
      (after.rebootRequired ? '\n\nA REBOOT IS PENDING. Nothing here will do that for you — sessions are running.' : ''),
  };
}

/**
 * The path dpkg could not write, out of what it said.
 *
 * dpkg names it twice and both are useful:
 *
 *   unable to create '/usr/bin/locale-check.dpkg-new' (while processing './usr/bin/locale-check')
 *
 * The first is the real target. `.dpkg-new` is dpkg's temporary name for the
 * file it is about to rename into place, and the DIRECTORY is what has to be
 * writable — so the suffix comes off and the parent is what gets measured.
 *
 * Returns null when nothing recognisable is there, and the caller falls back to
 * /etc, which is the path this failure has hit most often.
 *
 * @param {string} detail
 * @returns {string|null}
 */
export function pathFromDpkg(detail) {
  const m = /unable to (?:create|remove(?: newly-extracted version of)?) '([^']+)'/.exec(String(detail || ''));
  if (!m) return null;
  const file = m[1].replace(/\.dpkg-(?:new|tmp|dist)$/, '');
  if (!file.startsWith('/')) return null;
  // The DIRECTORY, because that is what a read-only mount makes unwritable —
  // and the file itself may not exist yet, which is the whole error.
  const at = file.lastIndexOf('/');
  return at > 0 ? file.slice(0, at) : '/';
}

/**
 * Whether a path is read-only IN THIS PROCESS'S MOUNT NAMESPACE.
 *
 * The whole point is that this is asked by the process that will run dpkg,
 * rather than reasoned about from a unit file somewhere else. A mount namespace
 * is exactly the thing a unit file is one step removed from: the file says what
 * was asked for, and this says what the kernel did — and they disagree whenever
 * a drop-in, an older unit on disk, or a `systemctl edit` is in the way.
 *
 * /proc/self/mountinfo, per mount:
 *
 *   36 25 0:31 / /etc ro,relatime shared:16 - tmpfs tmpfs ro
 *   ^id ^parent ^dev ^root ^MOUNTPOINT ^OPTIONS
 *
 * THE LONGEST MATCHING MOUNTPOINT WINS, and the LAST such line wins after that.
 * /etc usually has no mount of its own and inherits `/`; when ProtectSystem is
 * in play it gets one stacked on top, and a stack is resolved by taking the
 * final entry rather than the first. Reading the first is how this would report
 * the underlying read-write disk and miss the read-only layer over it.
 *
 * @param {string} [target] the path to ask about. NOT hardcoded to /etc, and
 *   that was a real bug: `ProtectSystem=full` fails on /etc, and once that was
 *   loosened to `true` the very next dpkg run failed on /usr/bin/locale-check —
 *   whereupon this measured /etc, found it writable, and reported that
 *   ProtectSystem was not the cause while ProtectSystem was the cause. Measure
 *   the path that actually failed
 * @param {string} [path] the mountinfo to read, so a test can supply one
 * @returns {{ readOnly: boolean|null, where: string, evidence: string }}
 */
export function mountFor(target = '/etc', path = '/proc/self/mountinfo') {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    return { readOnly: null, where: target, evidence: `could not read ${path}: ${/** @type {Error} */ (e).message}` };
  }
  /** @type {{ point: string, opts: string, fstype: string, source: string }|null} */
  let best = null;
  for (const line of raw.split('\n')) {
    // The optional fields between the mountpoint and the `-` separator vary in
    // number, which is why the separator exists and why this splits on it
    // rather than counting to a fixed index.
    const [before, after] = line.split(' - ');
    if (!after) continue;
    const f = before.split(' ');
    if (f.length < 6) continue;
    const point = f[4];
    const opts = f[5];
    if (point !== '/' && point !== target && !target.startsWith(`${point}/`)) continue;
    // `>=` and not `>`: a later line at the SAME depth is stacked on top of the
    // earlier one, and the top of the stack is what a write actually meets.
    if (best && best.point.length > point.length) continue;
    const a = after.split(' ');
    best = { point, opts, fstype: a[0] || '?', source: a[1] || '?' };
  }
  if (!best) return { readOnly: null, where: target, evidence: `no mount in this namespace covers ${target}` };
  // The option list is the authority, and `ro` is a whole word in it — a
  // substring test would match `errors=remount-ro` on a read-write mount.
  const readOnly = best.opts.split(',').includes('ro');
  return {
    readOnly,
    where: best.point === target ? target : `${target}, via ${best.point}`,
    evidence: `${best.source} on ${best.point}, ${best.fstype}, ${readOnly ? 'ro' : 'rw'}`,
  };
}

/**
 * What systemd actually loaded for this service, asked of systemd.
 *
 * THE LAST STEP THAT STILL NEEDED A SHELL. `etcMount` above proves /etc is
 * read-only in this namespace and therefore that it is ours; it cannot say
 * WHICH of the three reasons, so the message ended with two `systemctl show`
 * lines and a trip to the box. On a product whose premise is that nothing
 * should need SSH, "here is the command, go and type it" is the answer being
 * dodged — and it was asked for twice before this was written.
 *
 * `systemctl show` needs no privileges: it reads what the manager already has
 * loaded. So the process that noticed the problem is the process that can ask.
 *
 * `NeedDaemonReload` IS ONE OF THE THREE ANSWERS and is easy to leave out. It
 * is systemd comparing the unit on disk with the one it is running, so `yes`
 * means the file was fixed and the running service is still the old one — an
 * installer that wrote the unit and a service that never picked it up look
 * identical from every other angle.
 *
 * @param {import('../config.js').Config|{systemctlBin: string}} cfg
 * @param {string} [unit]
 * @returns {{ ok: boolean, protectSystem: string, readWritePaths: string, dropIns: string, fragment: string, needsReload: string, why: string }}
 */
export function unitProtection(cfg, unit = 'agent-hub') {
  const blank = { ok: false, protectSystem: '', readWritePaths: '', dropIns: '', fragment: '', needsReload: '', why: '' };
  const props = ['ProtectSystem', 'ReadWritePaths', 'DropInPaths', 'FragmentPath', 'NeedDaemonReload'];
  let r;
  try {
    r = spawnSync(cfg.systemctlBin, ['show', unit, ...props.map((p) => `--property=${p}`)], {
      encoding: 'utf8',
      timeout: 10_000,
    });
  } catch (e) {
    return { ...blank, why: `could not run ${cfg.systemctlBin}: ${/** @type {Error} */ (e).message}` };
  }
  if (r.status !== 0) {
    // A box with no systemd at all is an ordinary answer here, not an error —
    // and `full`/`ReadWritePaths` mean nothing on one, so the caller has to be
    // able to tell that from "systemd said no".
    return { ...blank, why: String(r.stderr || r.stdout || `${cfg.systemctlBin} exited ${r.status}`).trim().slice(0, 200) };
  }
  /** @type {Record<string, string>} */
  const seen = {};
  for (const line of String(r.stdout || '').split('\n')) {
    // `split('=')` would cut a path containing one. The first `=` is the
    // separator and everything after it is the value, including nothing at all
    // — an unset property prints `ReadWritePaths=` and that empty string is the
    // answer, not a missing line.
    const at = line.indexOf('=');
    if (at > 0) seen[line.slice(0, at)] = line.slice(at + 1);
  }
  return {
    ok: true,
    protectSystem: seen.ProtectSystem ?? '',
    readWritePaths: seen.ReadWritePaths ?? '',
    dropIns: seen.DropInPaths ?? '',
    fragment: seen.FragmentPath ?? '',
    needsReload: seen.NeedDaemonReload ?? '',
    why: '',
  };
}

/**
 * The read-only-/etc case, once systemd has been asked which of the three it is.
 *
 * @param {{ ok: boolean, protectSystem: string, readWritePaths: string, dropIns: string, fragment: string, needsReload: string, why: string }} u
 */
function adviseOnProtectedEtc(u) {
  if (!u.ok) {
    return (
      `This service could not ask systemd why (${u.why || 'no reason given'}), so the two possibilities are:\n` +
      '  systemctl show agent-hub -p ProtectSystem -p ReadWritePaths -p DropInPaths -p NeedDaemonReload\n' +
      '    ReadWritePaths empty  → the unit predates the fix; re-running the installer writes it.\n' +
      '    ReadWritePaths=/etc   → a drop-in is overriding it, and DropInPaths names the file.'
    );
  }
  // SYSTEMD ANSWERS 0 FOR A UNIT IT HAS NEVER HEARD OF, with every property at
  // its default — so `ProtectSystem=no, ReadWritePaths=` comes back for a box
  // that has no such unit, and reading that as "the unit predates the fix"
  // would send somebody to re-run an installer over a service that is not what
  // is confining them. An empty FragmentPath is how systemd says "no such unit".
  if (!u.fragment) {
    return (
      'systemd has no unit called agent-hub loaded, so this service was not started by the unit\n' +
      'this advice is about — something else made /etc read-only for it. Worth checking what\n' +
      'actually launched it, and whether that carries ProtectSystem= or ReadOnlyPaths=.'
    );
  }
  // FIRST, BECAUSE IT INVALIDATES EVERYTHING BELOW IT. NeedDaemonReload is
  // systemd comparing the unit on disk with the one it is running, so `yes`
  // means every property above describes the OLD file — and a conclusion drawn
  // from ProtectSystem or ReadWritePaths would be a conclusion about a unit
  // that is no longer on disk. Checked after the `full` branch, a box whose
  // file had just been fixed would be told to re-run the installer it had
  // already run.
  if (u.needsReload === 'yes') {
    // THE ONE THAT LOOKS LIKE EVERY OTHER ONE. The file on disk is right and
    // the running service is the old one, so reading the unit would say the fix
    // is applied while the namespace says it is not.
    return (
      `systemd says the unit on disk has changed since this service started (NeedDaemonReload=yes),\n` +
      `so it is still running the OLD one — which is why the file looks correct and /etc is not.\n\n` +
      'On the box:\n' +
      '  sudo systemctl daemon-reload && sudo systemctl restart agent-hub'
    );
  }

  // ANY ProtectSystem AT ALL IS THE ANSWER, and narrowing this to `full` was
  // the third wrong version of it.
  //
  // The walk went: `full` blocked /etc; `full` + ReadWritePaths=/etc was loaded
  // by systemd and left /etc read-only anyway, measured on the box; `true`
  // blocked /usr/bin. Each fix addressed the path in the last error and
  // uncovered the next, because the sudoers grant is `apt-get -y upgrade` and
  // rewriting /usr, /etc and /boot is what that command IS.
  //
  // So the unit says `no`, and anything else is a unit that predates that.
  if (u.protectSystem && u.protectSystem !== 'no') {
    return (
      `systemd loaded this unit with ProtectSystem=${u.protectSystem}${u.readWritePaths ? ` and ReadWritePaths=${u.readWritePaths}` : ''}.\n` +
      'Every setting of that makes some of /usr, /boot and /etc read-only for this service and every\n' +
      'command it runs — and `apt-get -y upgrade`, which is the one thing this service is allowed to do\n' +
      'as root, rewrites exactly those. There is no setting of it that lets an upgrade work.\n\n' +
      `The unit uses ProtectSystem=no now. This box is on an older one${u.fragment ? ` (${u.fragment})` : ''}.\n` +
      'Re-running the installer writes it:\n' +
      '  curl -fsSL <your coordinator>/install | sudo sh'
    );
  }
  // EVERYTHING BELOW IS A CURRENT UNIT, and this branch had an older meaning
  // baked into it twice over.
  //
  // It used to conclude "predates the fix" from ReadWritePaths being ABSENT,
  // because the fixed unit was `full` + `ReadWritePaths=/etc`. #452 removed
  // that pair, so an absent ReadWritePaths is now what a CORRECT unit looks
  // like — and this branch went on reading it as the broken one. A box on the
  // current unit with a read-only /etc for any other reason was told to re-run
  // the installer, which is the exact wrong answer this whole function was
  // rewritten to stop giving, shipped inside the fix for it.
  //
  // So the conclusion is keyed on ProtectSystem, which is the thing that
  // actually decides it. `full` is handled above; anything else — `yes`,
  // `true`, `strict`, `no` — is a unit that is not making /etc read-only, so
  // something else did.
  if (u.dropIns) {
    return (
      `This unit is current (ProtectSystem=${u.protectSystem || 'unset'}), so it is not what made /etc\n` +
      'read-only — but systemd loaded drop-ins on top of it:\n' +
      `${u.dropIns.split(/\s+/).filter(Boolean).map((f) => `  ${f}`).join('\n')}\n` +
      'Look for ProtectSystem=, ReadOnlyPaths= or InaccessiblePaths= in those.'
    );
  }
  return (
    `This unit is current (ProtectSystem=${u.protectSystem || 'unset'}) with no drop-ins, so neither the\n` +
    'unit nor this service is what made /etc read-only. Somewhere else did:\n' +
    '  systemctl show agent-hub -p ReadOnlyPaths -p InaccessiblePaths -p TemporaryFileSystem\n' +
    '  findmnt -o TARGET,SOURCE,OPTIONS /etc      # a read-only mount over /etc\n' +
    '  dmesg | tail                               # a filesystem remounted read-only after an error\n\n' +
    'That last one is the case that matters: a disk that hit an I/O error goes read-only by itself, ' +
    'and it will keep failing until it is checked.'
  );
}

/**
 * What to do about it, for the failures apt actually has.
 *
 * THIS USED TO SAY ONE THING FOR EVERYTHING:
 *
 *   On the box: sudo apt-get -y upgrade
 *   A package whose service failed to start usually explains itself in:
 *   systemctl status <name>
 *
 * which is good advice for exactly one failure and wrong for the rest. It was
 * reported against a box whose root filesystem is mounted read-only:
 *
 *   unable to create '/etc/debian_version.dpkg-new': Read-only file system
 *
 * Running the suggested command there fails identically, and `systemctl status`
 * has nothing to do with it — so a person is sent to a machine to type two
 * things that cannot help. A confident remedy for a diagnosis nobody made costs
 * more than no remedy: it spends somebody's trip to the box, and it teaches
 * them that the advice is decoration.
 *
 * Each of these has a different fix, which is the whole reason to tell them
 * apart. The generic sentence stays as the last case, where it is honest —
 * "here is the command, go and look" is a fine answer when nothing recognises
 * the failure.
 *
 * @param {string} detail what apt and dpkg said
 * @param {import('../config.js').Config|{systemctlBin: string}|null} [cfg] so the
 *   advice can ask systemd which of the three reasons it is, rather than print
 *   the command that would
 * @param {string} [mountInfo] where to measure the mounts, so a test can supply
 *   a fixture rather than asserting against whatever the machine running it
 *   happens to have mounted — which is how this test would silently change its
 *   mind depending on the box, and this file is about exactly that mistake
 */
export function adviseOnFailure(detail, mountInfo = '/proc/self/mountinfo', cfg = /** @type {any} */ (null)) {
  const said = String(detail || '');

  if (/password is required|not allowed/i.test(said)) {
    return 'That is the sudoers rule missing — see /upgrade with AGENT_HUB_SYSTEM_UPGRADE unset for the exact line.';
  }
  if (/read-only file system/i.test(said)) {
    // ALMOST ALWAYS OURS, AND I GOT THIS WRONG ONCE ALREADY. The first version
    // of this blamed the image and said nothing typed on the box would help —
    // told to somebody whose filesystem was perfectly writable.
    //
    // agent-hub.service sets `ProtectSystem=full`, which makes /usr, /boot AND
    // /etc read-only for the service and every child of it. A mount namespace
    // is not something `sudo` escapes, so the sanctioned `sudo -n apt-get`
    // inherited it and dpkg could not write /etc/debian_version.
    //
    // The unit ships with ReadWritePaths=/etc now, so a box that still shows
    // this is running an older one — which is a re-run of the installer, not a
    // new image. Naming the unit is what makes that findable; "your filesystem
    // is read-only" sent somebody to look at a filesystem that was fine.
    //
    // AND THEN THAT WAS WRONG TOO, WHICH IS WHY THIS NOW MEASURES.
    //
    // The advice above shipped in #441, which is also the release that added
    // ReadWritePaths=/etc. So a box running #441 or later already had the fix
    // the message told it to go and get — and one of them re-ran the installer,
    // as instructed, and failed identically. Twice now this function has
    // produced a confident remedy for a diagnosis nobody made.
    //
    // The process reading this IS the process whose namespace dpkg inherited.
    // It does not have to reason about the unit file: it can look at its own
    // mounts. So it does, and what it says depends on what it found rather than
    // on what is usually true.
    // THE PATH THAT ACTUALLY FAILED, not the one this bug first appeared at.
    const failed = pathFromDpkg(said) || '/etc';
    const mount = mountFor(failed, mountInfo);
    if (mount.readOnly === true) {
      // AND THEN ASK SYSTEMD WHICH OF THE THREE, rather than printing the
      // command that would. The first version of this branch ended with two
      // `systemctl show` lines and a trip to the box, on a product whose whole
      // premise is that nothing should need one — and it was asked for twice
      // before anybody thought to have the service ask for itself.
      return (
        `Measured from this service just now: ${mount.where} is mounted READ-ONLY in this process's\n` +
        `mount namespace (${mount.evidence}). dpkg inherited that namespace, and sudo does not\n` +
        'escape one, so this is ours and not the disk.\n\n' +
        adviseOnProtectedEtc(unitProtection(cfg || /** @type {any} */ ({ systemctlBin: 'systemctl' })))
      );
    }
    if (mount.readOnly === false) {
      // THE CASE THE OLD MESSAGE COULD NOT EXPRESS, and the one a person is
      // standing in when they say "it still fails". Sending them to re-run the
      // installer again would spend a second trip to the box on a fix that has
      // already been applied.
      return (
        `Measured from this service just now: ${mount.where} is mounted READ-WRITE in this process's\n` +
        `mount namespace (${mount.evidence}), so ProtectSystem is NOT what stopped dpkg — and\n` +
        're-running the installer will not change anything.\n\n' +
        'Something else made that one path read-only. Worth looking at, in this order:\n' +
        '  findmnt -o TARGET,SOURCE,OPTIONS /etc      # a separate read-only mount over /etc\n' +
        '  systemctl show agent-hub -p ReadOnlyPaths -p DropInPaths\n' +
        '  dmesg | tail                               # a filesystem remounted read-only after an error\n\n' +
        'That last one is the case that matters: a disk that hit an I/O error goes read-only by itself, ' +
        'and it will keep failing until it is checked.'
      );
    }
    // COULD NOT TELL, said as itself. /proc/self/mountinfo is how this is
    // measured and a kernel that does not offer it leaves the question open —
    // which is a different answer from either of the two above, and rounding it
    // to the likely one is how the first two versions of this went wrong.
    return (
      'dpkg could not write to /etc. This service could not read its own mounts to say whether that\n' +
      `is ours (${mount.evidence}), so both are still open:\n\n` +
      '  systemctl show agent-hub -p ProtectSystem -p ReadWritePaths -p DropInPaths\n' +
      '    ProtectSystem=full with no ReadWritePaths=/etc is ours, and re-running the installer fixes it.\n' +
      '  findmnt -o TARGET,SOURCE,OPTIONS /etc\n' +
      '    a read-only mount there is the box, and re-running the installer will not help.'
    );
  }
  if (/dpkg was interrupted|dpkg --configure -a/i.test(said)) {
    return 'dpkg was interrupted and has to be finished before anything else installs:\n  sudo dpkg --configure -a';
  }
  if (/could not get lock|unable to (?:acquire|lock)/i.test(said)) {
    return (
      'Something else is holding apt — usually unattended-upgrades on a timer. ' +
      'It finishes on its own; try again in a few minutes rather than killing it, ' +
      'because a half-finished dpkg run is the failure above this one.'
    );
  }
  if (/no space left on device/i.test(said)) {
    return 'The disk is full. `sudo apt-get clean` frees the package cache, which is often enough to get moving again.';
  }
  if (/temporary failure resolving|could not resolve|failed to fetch|connection timed out/i.test(said)) {
    return 'This box could not reach its package mirror. That is a network or DNS fault rather than an apt one, and apt will work once it can.';
  }
  // NOTHING RECOGNISED IT, and this is the honest answer for that: the detail
  // above is the whole of what apt said, and this names the command rather than
  // sending somebody to "the box" to work out what to type.
  return (
    'On the box: sudo apt-get -y upgrade\n' +
    'A package whose service failed to start usually explains itself in: systemctl status <name>'
  );
}
