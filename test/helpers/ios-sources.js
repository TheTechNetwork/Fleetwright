// The iOS app's Swift, as one string.
//
// WHY NOT A NAMED FILE. Tests here assert PROPERTIES of the app — that it
// applies the reply it was given, that it offers a verb only when the state
// calls for it, that it never claims a box is current on the strength of a
// missing answer. Those are true of the app, not of FleetView.swift, and half a
// dozen of them broke the day a host's controls moved onto a page of their own.
//
// Nothing was wrong with the app that day. The tests were reading the wrong
// file, which is a test asserting where code LIVES while claiming to assert
// what it DOES — and the failure arrives as six red lines about behaviour that
// did not change.
import { readFileSync, readdirSync } from 'node:fs';

const DIR = new URL('../../apps/ios/Fleetwright/', import.meta.url);

/** Every Swift file in the app, concatenated, newest read each call. */
export function iosSources() {
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.swift'))
    .sort()
    .map((f) => readFileSync(new URL(f, DIR), 'utf8'))
    .join('\n');
}
