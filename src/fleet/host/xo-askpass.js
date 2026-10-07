// The SSH_ASKPASS ssh runs when the pool master asks for root's password,
// while xo-deploy.js opens its one master connection.
//
// WHY A PROGRAM AND A SOCKET, and not the password in an environment variable
// for ssh to read back: an environment is copied into every process the
// master starts and can be read from /proc for as long as it runs, which for
// an install is half an hour. This asks the sidecar over a unix socket in the
// job's own 0700 directory, which answers once, to a prompt that asks for a
// password, and then closes. ssh passes the prompt as the first argument.

import net from 'node:net';

const socketPath = process.env.FLEETWRIGHT_ASKPASS_SOCKET;
if (!socketPath) process.exit(1);
let answer = '';
const c = net.connect(socketPath, () => c.write(`${String(process.argv[2] ?? '').replace(/\n/g, ' ')}\n`));
c.on('data', (d) => {
  answer += d;
});
c.on('end', () => {
  if (!answer) process.exit(1);
  process.stdout.write(answer);
});
c.on('error', () => process.exit(1));
