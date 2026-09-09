// The Android app's Kotlin, as one string.
//
// THE SAME LESSON AS ios-sources.js, arriving on the other phone. That helper
// exists because half a dozen tests broke the day a host's controls moved onto
// a page of their own: nothing was wrong with the app, the tests were reading
// the wrong file. A test that asserts where code LIVES while claiming to assert
// what it DOES fails as red lines about behaviour that did not change.
//
// Android had one screen file for a long time, so fifteen tests read
// MainActivity.kt by name and got away with it. Splitting the settings panel
// out — over half of that file, and the last screen in this app without one —
// is exactly the move that would have broken them, so they read the app
// instead of a file now.
//
// Assertions that a property holds ANYWHERE in the app belong here. An
// assertion genuinely about one file (that a particular screen does not import
// something, say) should still name that file, and should say why.
import { readFileSync, readdirSync } from 'node:fs';

const DIR = new URL('../../apps/android/app/src/main/java/network/thetech/fleetwright/', import.meta.url);

/** Every Kotlin file in the app, concatenated, newest read each call. */
export function androidSources() {
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.kt'))
    .sort()
    .map((f) => readFileSync(new URL(f, DIR), 'utf8'))
    .join('\n');
}
