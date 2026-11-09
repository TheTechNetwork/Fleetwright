// Both phones show what the Proxmox VE machines a box made printed as they
// booted (docs/proxmox.md, "A machine that does not join"), in the same words,
// from the same reply, and only where the box says it keeps them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (/** @type {string} */ p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const A = 'apps/android/app/src/main/java/network/thetech/fleetwright';
const IOS = read('apps/ios/Fleetwright/BootLogsView.swift');
const ANDROID = read(`${A}/BootLogs.kt`);

test('both phones word the page the same, within a line', () => {
  for (const [s, k] of [['title', 'TITLE'], ['none', 'NONE'], ['reading', 'READING'], ['couldNot', 'COULD_NOT'], ['footer', 'FOOTER'], ['joined', 'JOINED'], ['stillReading', 'STILL_READING'], ['notJoined', 'NOT_JOINED']]) {
    const ios = new RegExp(`static let ${s} = "([^"]*)"`).exec(IOS)?.[1];
    assert.ok(ios, `iOS has no ${s}`);
    assert.equal(new RegExp(`const val ${k} = "([^"]*)"`).exec(ANDROID)?.[1], ios, `${s} differs`);
    assert.ok(ios.length <= 100, `${s} is longer than a line`);
  }
});

test('both ask the box for boot, then for the one machine, and read the list from the reply’s boot', () => {
  assert.match(IOS, /fleet\.logs\(host: hostId, service: "boot"\)/);
  assert.match(IOS, /fleet\.logs\(host: hostId, service: "boot", machine: machine, lines: 200\)/);
  assert.match(ANDROID, /logs\(hostId, service = "boot"\)/);
  assert.match(ANDROID, /logs\(hostId, service = "boot", machine = machine, lines = 200\)/);
  assert.match(read('apps/ios/Fleetwright/Fleet.swift'), /if let machine, !machine\.isEmpty \{ params\["machine"\] = machine \}/);
  assert.match(read(`${A}/Fleet.kt`), /if \(!machine\.isNullOrBlank\(\)\) put\("machine", machine\)/);
  assert.match(read(`${A}/Fleet.kt`), /json\.optJSONObject\("boot"\)\?\.optJSONArray\("machines"\)/);
});

test('the page is offered where the box lists boot among its logs, and not as a journal button', () => {
  const host = read('apps/ios/Fleetwright/HostView.swift');
  assert.match(host, /ForEach\(logs\.filter \{ \$0 != "boot" \}/);
  assert.match(host, /if logs\.contains\("boot"\) \{\s*NavigationLink\(BootWords\.title\)/);
  const machines = read(`${A}/MachinesScreen.kt`);
  assert.match(machines, /logs\.filter \{ it != "boot" \}/);
  assert.match(machines, /if \("boot" in logs\) OutlinedButton\(onClick = \{ bootPage = true \}\) \{ Text\(BootWords\.TITLE\) \}/);
});
