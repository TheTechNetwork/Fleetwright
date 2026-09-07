// What a machine can say about itself without being told.
//
// LABELS ARE HOW WORK IS AIMED — `tag: macos` on a start, and the scheduler
// filters before it ranks. They came only from AGENT_FLEET_LABELS, which means
// every one of them is somebody having remembered to type it into an env file
// at install time. The facts that never change and are never wrong — what
// operating system this is, what architecture, whether its sandbox image has a
// browser in it — were the ones most likely to be missing, because they are the
// ones nobody thinks to write down.
//
// A fleet where `tag: arm64` finds nothing, on a fleet of arm64 boxes, teaches
// people that tags do not work.
//
// DERIVED, NEVER STORED. These are read at each health frame from the machine
// itself, so a box that is re-imaged or whose sandbox image changes says
// something different on its next report without anybody editing anything. A
// label written into a file is a claim that was true once.
//
// AND THEY ARE ADDITIVE. AGENT_FLEET_LABELS still says whatever it says: an
// operator's own labels are decisions ("gpu", "prod", "noisy-neighbour") and no
// amount of introspection produces those. The two sets are unioned, and an
// operator naming something this file also derives is not a conflict.
import { readFileSync } from 'node:fs';
import os from 'node:os';

/**
 * The operating system, in the words somebody would type.
 *
 * `darwin` is what node calls it and `macos` is what a person reaching for a
 * Mac would tag, so both are reported — a tag that requires knowing node's
 * platform strings is a tag for people who have read this file.
 *
 * @param {string} p the platform, as node names it
 */
function osLabels(p) {
  if (p === 'darwin') return ['darwin', 'macos'];
  if (p === 'win32') return ['windows'];
  return [p];
}

/**
 * The distribution, when the box will say.
 *
 * ID from os-release, which is a plain lowercase token — `debian`, `ubuntu`,
 * `alpine` — and exactly the shape a tag wants. Absent on a Mac and on
 * anything that does not ship the file, which is not a fault: this is the set
 * of things a machine will VOLUNTEER, and silence is one of the answers.
 *
 * @param {(p: string, enc: string) => string} readFile
 */
function distroLabels(readFile) {
  try {
    const text = readFile('/etc/os-release', 'utf8');
    const id = /^ID=(.*)$/m.exec(text)?.[1]?.trim().replace(/^"(.*)"$/, '$1');
    return id && /^[a-z0-9._-]+$/.test(id) ? [id] : [];
  } catch {
    return [];
  }
}

/**
 * Everything this machine can say about itself.
 *
 * @param {{ sandboxImage?: string }} [cfg]
 * @param {{ platform?: () => string, arch?: () => string, readFile?: (p: string, enc: string) => string }} [io]
 */
export function autoLabels(cfg = {}, io = {}) {
  const arch = (io.arch ?? os.arch)();
  const platform = osLabels((io.platform ?? os.platform)());
  // Wrapped rather than passed: readFileSync's overloads do not narrow to this
  // shape, and the narrow shape is the point — this reads one text file.
  const readFile = io.readFile ?? ((p, enc) => String(readFileSync(p, { encoding: /** @type {BufferEncoding} */ (enc) })));

  const out = new Set([...platform, arch]);
  // x64 is node's word and amd64 is everybody else's, including the container
  // tags this fleet publishes. Somebody tagging a start has seen the second one.
  if (arch === 'x64') out.add('amd64');
  if (arch === 'arm64') out.add('aarch64');
  for (const d of distroLabels(readFile)) out.add(d);

  // WHETHER A SESSION HERE CAN OPEN A BROWSER, which is the label this was
  // built for. It is a property of the IMAGE this box runs sessions in, and
  // nothing else on the machine can answer it — so a box pointed at the `:web`
  // tag says so, and `tag: browser` finds it without anybody maintaining a
  // list of which hosts were configured how.
  if (/(^|[:/-])web($|[:@-])/.test(String(cfg.sandboxImage || ''))) out.add('browser');

  return [...out].sort();
}
