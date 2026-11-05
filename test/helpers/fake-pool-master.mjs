// A pool master at the far end of SSH, for test/xo-deploy.test.js: `ssh`,
// `ssh-keyscan` and `xe`, each a shell wrapper the test writes onto PATH
// that runs this file with its role first.
//
// WHAT IT HOLDS TO, because those are the things xo-deploy.js depends on and
// a fake that shrugged at them would prove nothing:
//
//   - the host key: a master connection is refused, as real ssh refuses it,
//     unless StrictHostKeyChecking=yes and the job's known_hosts file holds
//     this key;
//   - the password: asked of SSH_ASKPASS, once, and compared; or asked with
//     a prompt of the test's choosing, or not asked at all, as a real master
//     may;
//   - the master: with -f it backgrounds a process holding the ControlPath
//     and exits 0, so the caller's "signed in" is ssh's own exit code;
//   - every other ssh rides the master: one without a live ControlPath and
//     with BatchMode=yes is refused, exactly where a real client would have
//     had to ask for a password it cannot;
//   - first value wins for each -o, as OpenSSH's own option parsing does,
//     which is the whole of how the installer's ssh is made to ride the
//     master.
//
// A remote command is run here with bash, with the pool's own `xe` first on
// PATH. Every invocation is written to the log, with its environment's
// names, so a test can say what was asked and that no password was in it.

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

const [role, ...argv] = process.argv.slice(2);
const config = JSON.parse(readFileSync(String(process.env.FAKE_POOL_CONFIG), 'utf8'));
const log = (/** @type {any} */ entry) => appendFileSync(config.log, `${JSON.stringify({ role, ...entry })}\n`);

if (role === 'hold') {
  // The master, backgrounded: holds its ControlPath until told to exit.
  writeFileSync(argv[0], String(process.pid));
  setInterval(() => {}, 60_000);
} else if (role === 'ssh-keyscan') {
  log({ argv });
  const host = argv.at(-1);
  if (config.unreachable) process.exit(1);
  // A pool master that turns the connection away, `keyscan.times` times and
  // then answers: ssh-keyscan says why on stderr, in its own words, and
  // writes no key. The count lives beside the log, since each scan is a
  // process of its own.
  if (config.keyscan) {
    const counter = `${config.log}.keyscan`;
    const turned = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0;
    if (turned < config.keyscan.times) {
      writeFileSync(counter, String(turned + 1));
      process.stderr.write(`# ${host}:22 SSH-2.0-OpenSSH_9.9\n${config.keyscan.say}\n`);
      process.exit(1);
    }
  }
  for (const k of config.keys) process.stdout.write(`${host} ${k.type} ${k.blob}\n`);
} else if (role === 'xe') {
  log({ argv });
  const answer = config.xe?.[argv[0]];
  if (answer === undefined) {
    process.stderr.write(`fake xe: nothing for ${argv[0]}\n`);
    process.exit(1);
  }
  process.stdout.write(`${answer}\n`);
} else if (role === 'ssh') {
  ssh();
}

function ssh() {
  /** @type {Record<string, string>} */
  const o = {};
  /** @type {Record<string, string|boolean>} */
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o') {
      const [k, ...v] = argv[++i].split('=');
      if (!(k.toLowerCase() in o)) o[k.toLowerCase()] = v.join('=');
    } else if (['-F', '-E', '-p', '-l', '-O'].includes(a)) {
      if (!(a in flags)) flags[a] = argv[i + 1];
      i++;
    } else if (['-f', '-N', '-M'].includes(a)) {
      flags[a] = true;
    } else {
      rest.push(a, ...argv.slice(i + 1));
      break;
    }
  }
  log({ argv, env: Object.keys(process.env).sort(), password: Object.values(process.env).some((v) => v === config.password) });
  const control = o.controlpath;
  const fail = (/** @type {string} */ why) => {
    if (typeof flags['-E'] === 'string') appendFileSync(flags['-E'], `${why}\r\n`);
    else process.stderr.write(`${why}\n`);
    process.exit(255);
  };
  if (flags['-O']) {
    if (flags['-O'] === 'check') process.exit(control && existsSync(control) ? 0 : 255);
    if (flags['-O'] === 'exit' && control && existsSync(control)) {
      try {
        process.kill(Number(readFileSync(control, 'utf8')));
      } catch {
        /* already gone */
      }
      unlinkSync(control);
      process.exit(0);
    }
    process.exit(255);
  }
  if (o.controlmaster === 'yes') {
    const known = o.userknownhostsfile && existsSync(o.userknownhostsfile) ? readFileSync(o.userknownhostsfile, 'utf8') : '';
    const key = config.keys[0];
    if (o.stricthostkeychecking !== 'yes' || !known.includes(`${key.type} ${key.blob}`)) fail('Host key verification failed.');
    // WHAT THE MASTER ASKS, as a real one may: for a password, by default
    // the way OpenSSH's password method words it; with another prompt
    // (`prompt`), as a PAM module may; or nothing at all (`asks: false`), as a
    // master with password logins off, which turns the client away naming
    // the methods it does take.
    if (config.asks === false) fail(`${rest[0]}: Permission denied (publickey,gssapi-keyex,gssapi-with-mic).`);
    const asked = spawnSync(String(process.env.SSH_ASKPASS), [config.prompt ?? `root@${rest[0]}'s password: `], { encoding: 'utf8', env: process.env });
    if (asked.status !== 0 || asked.stdout.replace(/\n$/, '') !== config.password) fail(`Permission denied, please try again.\r\n${rest[0]}: Permission denied (publickey,password).`);
    if (!flags['-f']) fail('the fake only backgrounds');
    const held = spawn(process.execPath, [process.argv[1], 'hold', control], { detached: true, stdio: 'ignore', env: { FAKE_POOL_CONFIG: process.env.FAKE_POOL_CONFIG } });
    held.unref();
    // Signed in once the master holds its path, as ssh -f returns.
    for (let i = 0; i < 200 && !existsSync(control); i++) spawnSync('sleep', ['0.01']);
    process.exit(0);
  }
  if (!control || !existsSync(control)) {
    if (o.batchmode === 'yes') fail('Permission denied (publickey,password).');
    fail('this fake has no way to ask for a password outside a master');
  }
  const command = rest.slice(1).join(' ');
  // ITS OWN /root, somewhere a test may write (`root`): the script it is sent
  // on stdin is read and run with /root/ meaning that directory, as a node's
  // root-only files are its own and not the test machine's.
  if (config.root) {
    const script = readFileSync(0, 'utf8').replaceAll('/root/', `${config.root}/`);
    log({ script });
    const ran = spawnSync('bash', ['-c', command], { input: script, encoding: 'utf8', env: { ...process.env, PATH: `${config.poolPath}:${process.env.PATH}` } });
    process.stdout.write(ran.stdout ?? '');
    process.stderr.write(ran.stderr ?? '');
    process.exit(ran.status ?? 1);
  }
  const child = spawn('bash', ['-c', command], {
    stdio: 'inherit',
    env: { ...process.env, PATH: `${config.poolPath}:${process.env.PATH}` },
  });
  child.on('close', (code) => process.exit(code ?? 1));
}
