// Does the Containerfile parse as one?
//
// WHY THIS EXISTS. verify.sh said `sandbox ... parses` and meant entrypoint.sh
// and tool-shim.sh — the two shell scripts. Nothing looked at the Containerfile
// beside them, so a comment block converted from // to # left three bare `//`
// lines and the file shipped:
//
//   Containerfile:141
//   >>> //
//   ERROR: dockerfile parse error on line 141: unknown instruction: //
//
// found by a registry push, four minutes into a build matrix, on main.
//
// The check is deliberately small. It is not a linter and it is not trying to
// be hadolint; it answers the one question the build asks first — does every
// line that starts an instruction start a REAL one — which is the whole of what
// went wrong and is answerable without docker installed.
import { readFileSync } from 'node:fs';

/** Every instruction buildkit accepts. */
const INSTRUCTIONS = new Set([
  'ADD', 'ARG', 'CMD', 'COPY', 'ENTRYPOINT', 'ENV', 'EXPOSE', 'FROM', 'HEALTHCHECK',
  'LABEL', 'MAINTAINER', 'ONBUILD', 'RUN', 'SHELL', 'STOPSIGNAL', 'USER', 'VOLUME', 'WORKDIR',
]);

const files = process.argv.slice(2);
let bad = 0;

for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n');
  // A LINE INSIDE A CONTINUATION IS NOT AN INSTRUCTION. `RUN a \` followed by
  // `&& b` is one logical line, and checking the second half for a verb would
  // fail every multi-line RUN in the file.
  let continued = false;
  lines.forEach((raw, i) => {
    const line = raw.trim();
    const wasContinued = continued;
    // A trailing backslash continues, and a comment line cannot continue —
    // buildkit treats `# …\` as a comment, not as a continued instruction.
    continued = !line.startsWith('#') && line.endsWith('\\');
    if (wasContinued || !line || line.startsWith('#')) return;

    const first = line.split(/\s+/)[0].toUpperCase();
    // A parser directive, only above the first instruction. Cheap to allow.
    if (first.startsWith('#')) return;
    if (!INSTRUCTIONS.has(first)) {
      console.error(`${file}:${i + 1}: unknown instruction: ${line.split(/\s+/)[0]}`);
      bad += 1;
    }
  });
}

if (bad) {
  console.error(`\n${bad} line${bad === 1 ? '' : 's'} the container build would refuse.`);
  process.exit(1);
}
console.log(`${files.length} containerfile${files.length === 1 ? '' : 's'} parse`);
