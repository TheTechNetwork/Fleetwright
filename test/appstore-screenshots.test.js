// Screenshots, uploaded from the repository instead of dragged into a browser.
//
// THE LAST FULLY MANUAL STAGE, and the worst one to leave manual: they are per
// device size AND per locale, Apple refuses a version missing any required
// size, and it refuses them all at once in the longest message it sends.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { uploadScreenshots, unacceptable, ACCEPTED, DEFAULT_DIR } from '../tools/appstore-screenshots.mjs';

/** A directory of screenshots, laid out one folder per Apple display type. */
function shots(types) {
  const dir = mkdtempSync(path.join(tmpdir(), 'shots-'));
  for (const [type, files] of Object.entries(types)) {
    mkdirSync(path.join(dir, type), { recursive: true });
    for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, type, name), body);
  }
  return dir;
}

/**
 * A fake App Store Connect, recording every call.
 *
 * `existing` is what the version already has, which is the whole of the
 * "if needed" behaviour: `true` for a set with one picture Apple has not
 * described, or an array of appScreenshots resources as Apple would answer.
 */
function fakeApi({ existing = {} } = {}) {
  const calls = [];
  const puts = [];
  globalThis.fetch = async (url, init) => {
    puts.push({ url, method: init?.method, body: init?.body });
    return { ok: true, status: 200, text: async () => '' };
  };
  const api = async (p, init = {}) => {
    calls.push({ p, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    if (p.includes('/appScreenshotSets?')) {
      return { data: Object.keys(existing).map((t, i) => ({ id: `set-${i}`, attributes: { screenshotDisplayType: t } })) };
    }
    if (/\/appScreenshotSets\/(.+)\/appScreenshots\?/.test(p)) {
      const id = p.match(/\/appScreenshotSets\/([^/]+)\//)[1];
      const type = Object.keys(existing)[Number(id.split('-')[1])];
      const have = existing[type];
      return { data: Array.isArray(have) ? have : have ? [{ id: 'already' }] : [] };
    }
    if (p === '/v1/appScreenshotSets') return { data: { id: 'set-new' } };
    if (p === '/v1/appScreenshots') {
      return {
        data: {
          id: 'shot-1',
          attributes: {
            uploadOperations: [
              { url: 'https://upload.example/part1', method: 'PUT', offset: 0, length: 3, requestHeaders: [{ name: 'x', value: 'y' }] },
              { url: 'https://upload.example/part2', method: 'PUT', offset: 3, length: 2, requestHeaders: [] },
            ],
          },
        },
      };
    }
    return { data: null };
  };
  return { api, calls, puts };
}

test('a display type that already has screenshots is left alone', async (t) => {
  // "IF NEEDED". Re-uploading identical bytes on every release is minutes of
  // nothing, and worse: a window where the store has FEWER screenshots than it
  // did a moment ago, on a version about to be submitted.
  const dir = shots({ APP_IPHONE_67: { 'phone-01.png': 'abcde' } });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { api, calls } = fakeApi({ existing: { APP_IPHONE_67: true } });

  assert.equal(await uploadScreenshots({ api, localizationId: 'loc', dir }), 0);
  assert.equal(calls.some((c) => c.p === '/v1/appScreenshots'), false, 'it uploaded anyway');
});

test('and is replaced when explicitly forced', async (t) => {
  const dir = shots({ APP_IPHONE_67: { 'phone-01.png': 'abcde' } });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { api, calls } = fakeApi({ existing: { APP_IPHONE_67: true } });

  assert.equal(await uploadScreenshots({ api, localizationId: 'loc', dir, force: true }), 1);
  assert.ok(calls.some((c) => c.p === '/v1/appScreenshots'));
});

test('a set Apple would refuse is deleted and taken again', async (t) => {
  // "Asset spec is incompatible with the placement", six times, was 0.4.14:
  // the phone sets held pictures from the wrong simulator, the uploader saw
  // the sets were full and left them, and every later release would have been
  // refused for the same six files until somebody deleted them in a browser.
  const dir = shots({ APP_IPHONE_67: { 'phone-01.png': 'abcde' } });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { api, calls } = fakeApi({
    existing: {
      APP_IPHONE_67: [
        { id: 'old-1', attributes: { imageAsset: { width: 1242, height: 2688 }, assetDeliveryState: { state: 'COMPLETE' } } },
        { id: 'old-2', attributes: { imageAsset: { width: 1290, height: 2796 }, assetDeliveryState: { state: 'COMPLETE' } } },
      ],
    },
  });

  assert.equal(await uploadScreenshots({ api, localizationId: 'loc', dir }), 1);
  // THE WHOLE SET, not the one wrong picture: Apple refuses the version for
  // any one of them, and the new pictures are a matched set.
  const deleted = calls.filter((c) => c.method === 'DELETE').map((c) => c.p);
  assert.deepEqual(deleted, ['/v1/appScreenshots/old-1', '/v1/appScreenshots/old-2']);
  const first = calls.findIndex((c) => c.method === 'DELETE');
  const upload = calls.findIndex((c) => c.p === '/v1/appScreenshots' && c.method === 'POST');
  assert.ok(first < upload, 'the old pictures must go before the new ones arrive');
});

test('a set whose sizes Apple has not reported yet is not thrown away', async (t) => {
  // null is CANNOT TELL. The dimensions arrive once Apple has processed the
  // asset, and a picture is not deleted on a guess about one it has not.
  const dir = shots({ APP_IPHONE_61: { 'phone-01.png': 'abcde' } });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { api, calls } = fakeApi({
    existing: { APP_IPHONE_61: [{ id: 'fresh', attributes: { imageAsset: null, assetDeliveryState: { state: 'UPLOAD_COMPLETE' } } }] },
  });

  assert.equal(await uploadScreenshots({ api, localizationId: 'loc', dir }), 0);
  assert.equal(calls.some((c) => c.method === 'DELETE'), false, 'it deleted on a guess');
});

test('what Apple accepts per display type is the same table the runner checks against', () => {
  // scripts/ios-screenshots.sh refuses a wrong-sized picture as it is taken;
  // this refuses one the store already holds. They must agree, or a picture
  // the runner accepted is replaced on every release, for ever.
  const sh = readFileSync('scripts/ios-screenshots.sh', 'utf8');
  for (const [type, sizes] of Object.entries(ACCEPTED)) {
    const line = sh.match(new RegExp(`${type}\\) echo "([^"]+)"`));
    assert.ok(line, `${type} is not in the runner's accepts()`);
    assert.deepEqual(line[1].split(' ').sort(), [...sizes].sort(), `${type}: the two tables differ`);
  }
  assert.equal(unacceptable('APP_IPHONE_67', { attributes: { imageAsset: { width: 2796, height: 1290 } } }), null, 'landscape is the same picture turned');
  assert.match(unacceptable('APP_IPHONE_67', { attributes: { imageAsset: { width: 1242, height: 2688 } } }), /1242x2688/);
  assert.equal(unacceptable('APP_IPHONE_67', { attributes: { assetDeliveryState: { state: 'FAILED' } } }), 'delivery failed');
  assert.equal(unacceptable('APP_WATCH_ULTRA', { attributes: { imageAsset: { width: 1, height: 1 } } }), null, 'an unlisted type is cannot tell, not wrong');
});

test('the upload is reserve, send the ranges, then commit with a checksum', async (t) => {
  // Step three is what makes it real. Without the checksum Apple accepts the
  // bytes and leaves the asset in a state that never becomes usable, and the
  // version is refused later for a screenshot that LOOKS present.
  const body = 'abcde';
  const dir = shots({ APP_IPHONE_67: { 'phone-01.png': body } });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { api, calls, puts } = fakeApi();

  assert.equal(await uploadScreenshots({ api, localizationId: 'loc', dir }), 1);

  const reserve = calls.find((c) => c.p === '/v1/appScreenshots' && c.method === 'POST');
  assert.equal(reserve.body.data.attributes.fileSize, body.length, 'the reservation lied about the size');
  assert.equal(reserve.body.data.attributes.fileName, 'phone-01.png');

  // THE RANGES ARE APPLE'S, NOT OURS. uploadOperations may split a file into
  // parts with their own offsets, and honouring that is the difference between
  // an asset that becomes usable and one that sits in UPLOAD_COMPLETE for ever.
  assert.equal(puts.length, 2, 'the upload ignored the operation list');
  assert.equal(String(puts[0].body), 'abc');
  assert.equal(String(puts[1].body), 'de');

  const commit = calls.find((c) => c.p === '/v1/appScreenshots/shot-1' && c.method === 'PATCH');
  assert.equal(commit.body.data.attributes.uploaded, true);
  assert.equal(
    commit.body.data.attributes.sourceFileChecksum,
    createHash('md5').update(body).digest('hex'),
    'the checksum is not of the file that was sent',
  );
});

test('files go up in name order, because that is the order on the page', async (t) => {
  // readdir's order is the filesystem's. The names carry the sequence —
  // phone-01, phone-02 — for exactly this reason.
  const dir = shots({ APP_IPHONE_67: { 'phone-03.png': 'c', 'phone-01.png': 'a', 'phone-02.png': 'b' } });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { api, calls } = fakeApi();

  await uploadScreenshots({ api, localizationId: 'loc', dir });
  const names = calls.filter((c) => c.p === '/v1/appScreenshots' && c.method === 'POST')
    .map((c) => c.body.data.attributes.fileName);
  assert.deepEqual(names, ['phone-01.png', 'phone-02.png', 'phone-03.png']);
});

test('no directory is not a failure', async () => {
  // There are no iOS screenshots in the repository yet, and a release must not
  // stop for want of a directory that is somebody else's next piece of work.
  const { api, calls } = fakeApi();
  assert.equal(await uploadScreenshots({ api, localizationId: 'loc', dir: '/nope/not/here' }), 0);
  assert.equal(calls.length, 0);
});

test('a non-image is not uploaded', async (t) => {
  const dir = shots({ APP_IPHONE_67: { 'phone-01.png': 'a', 'README.md': 'why these five' } });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { api, calls } = fakeApi();
  await uploadScreenshots({ api, localizationId: 'loc', dir });
  const names = calls.filter((c) => c.p === '/v1/appScreenshots' && c.method === 'POST')
    .map((c) => c.body.data.attributes.fileName);
  assert.deepEqual(names, ['phone-01.png']);
});

test('screenshots are attached BEFORE the version is submitted', () => {
  // The ordering is the feature. A version missing a required display size is
  // refused AT submission, so this is the last thing that can still change the
  // version — and it is why the uploader is imported rather than being a second
  // workflow step, which could not be placed between two calls inside one run.
  const src = readFileSync(new URL('../tools/appstore-release.mjs', import.meta.url), 'utf8');
  const shots = src.indexOf('await uploadScreenshots(');
  const submit = src.indexOf("'/v1/reviewSubmissionItems'");
  assert.ok(shots > 0, 'the release never uploads screenshots');
  assert.ok(submit > 0 && shots < submit, 'screenshots are attached after submission, which is too late');

  // And a failure here warns rather than throwing: whatever is on the store
  // stays, and a submission with the previous version's screenshots is a
  // submission. A release that stopped here is not.
  assert.match(src, /::warning::screenshots not uploaded/);
});

test('it runs on a full release only, where the App Store job runs', () => {
  // Nothing about a TestFlight build wants a store page, and uploading images
  // on every merge to main would be minutes of nothing per commit.
  const yml = readFileSync(new URL('../.github/workflows/ios.yml', import.meta.url), 'utf8');
  const job = yml.slice(yml.indexOf('  release-app-store:'));
  assert.match(job, /!github\.event\.release\.prerelease/);
  // The uploader lives inside appstore-release.mjs, so it inherits that
  // condition rather than carrying a second copy of it that could drift.
  assert.doesNotMatch(yml, /appstore-screenshots\.mjs/, 'a second job would need the condition repeated');
});

test('a macOS runner takes the screenshots on a full release, and the submission waits for them', () => {
  // The script needs Xcode and a simulator — a laptop's tools — and no laptop
  // ever ran it, so the first submission was refused for want of a picture.
  // Now a macOS job takes them where the submission is, as a run artifact
  // the submit job downloads; committed ones still win.
  const yml = readFileSync(new URL('../.github/workflows/ios.yml', import.meta.url), 'utf8');
  const shots = yml.slice(yml.indexOf('  screenshots:'), yml.indexOf('  release-app-store:'));
  // ON THE IMAGE THE SHIPPING BUILD COMES FROM, not on a named label: the
  // pictures are of the app TestFlight uploads, so a screenshots job left on
  // an older Xcode would show the store an app that is not the one it gets.
  // This said `macos-latest` until the iPhone Duo round moved both jobs to the
  // xcode-27 image (docs/watch-and-duo.md).
  const runsOn = (job) => job.match(/^ {4}runs-on: (\S+)$/m)?.[1];
  const testflight = yml.slice(yml.indexOf('  testflight:'), yml.indexOf('  distribute:'));
  assert.match(runsOn(shots) ?? '', /^(macos-|xcode-)/, 'the screenshots need a macOS runner');
  assert.equal(runsOn(shots), runsOn(testflight), 'screenshots and the TestFlight build run on different images');
  assert.match(shots, /!github\.event\.release\.prerelease/, 'screenshots would be taken on a prerelease, which has no store page');
  assert.match(shots, /\.\/scripts\/ios-screenshots\.sh/);
  assert.match(shots, /upload-artifact@/);
  assert.match(shots, /name: ios-screenshots/);
  const submit = yml.slice(yml.indexOf('  release-app-store:'));
  assert.match(submit, /needs: \[testflight, screenshots\]/);
  // always(): a failed screenshot job must not cancel the submission, whose
  // own refusal from Apple is the message worth seeing.
  assert.match(submit, /always\(\)/);
  assert.match(submit, /download-artifact@/);
  assert.match(submit, /continue-on-error: true/);
  assert.match(submit, /if \[ ! -d apps\/ios\/store\/screenshots \]/, 'committed screenshots no longer win over the runner\'s');
});

test('the default directory is named per Apple display type', () => {
  // The directory name IS the display type — APP_IPHONE_67, APP_IPHONE_65 — so
  // adding a size is a folder rather than a code change.
  assert.equal(DEFAULT_DIR, 'apps/ios/store/screenshots');
});
