import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import pkg from '../package.json' with { type: 'json' };
import { createUpdater } from '../updater.js';

const installedVersion = pkg.version;
const [major, minor, patch] = installedVersion.split('.');
const nextVersion = `${major}.${minor}.${Number(patch) + 1}`;
const bytes = Buffer.from('Synthetic Voice Notes package fixture');
const digest = createHash('sha256').update(bytes).digest('hex');
const asset = {
  name: `dsh-voice-notes-${nextVersion}.tgz`, size: bytes.length, digest: `sha256:${digest}`, state: 'uploaded',
  browser_download_url: `https://github.com/WinterOne-hub/dsh-voice-notes/releases/download/v${nextVersion}/dsh-voice-notes-${nextVersion}.tgz`,
};
const release = { tag_name: `v${nextVersion}`, draft: false, prerelease: false, assets: [asset] };

test('the updater checks once, verifies the bytes, and hands the private package to Harness', async (t) => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'voice-notes-updater-'));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const finalUrl = 'https://release-assets.githubusercontent.com/fixture';
  const requests = [];
  let installs = 0;
  const updater = createUpdater({
    dataRoot,
    isBusy: () => false,
    getManager: () => ({ async installBundle(path, options) {
      installs++;
      assert.deepEqual(options, { enabled: true, expected: { name: pkg.name, version: nextVersion } });
      assert.deepEqual(await readFile(path), bytes);
      if (process.platform !== 'win32') {
        assert.equal((await stat(path)).mode & 0o777, 0o600);
        assert.equal((await stat(join(dataRoot, 'updates'))).mode & 0o777, 0o700);
      }
      return { bundle: pkg.name, version: nextVersion, application: 'restart-required' };
    } }),
    async fetcher(url, options) {
      requests.push(String(url));
      assert.equal(options.credentials, 'omit');
      assert.equal(options.redirect, 'manual');
      if (url === 'https://api.github.com/repos/WinterOne-hub/dsh-voice-notes/releases/latest') {
        assert.equal(url, 'https://api.github.com/repos/WinterOne-hub/dsh-voice-notes/releases/latest');
        return Response.json(release);
      }
      if (String(url) === asset.browser_download_url) return Response.redirect(finalUrl);
      assert.equal(String(url), finalUrl);
      return new Response(bytes);
    },
  });

  const expected = { current: installedVersion, state: 'available', version: nextVersion, canInstall: true };
  assert.deepEqual(await Promise.all([updater.status(), updater.status(true)]), [expected, expected]);
  assert.equal(requests.length, 1);
  assert.deepEqual(await updater.install(nextVersion), { state: 'restart', version: nextVersion });
  assert.deepEqual(await updater.status(), { current: installedVersion, state: 'restart', version: nextVersion });
  await updater.install(nextVersion);
  assert.equal(installs, 1);
  assert.equal(requests.length, 4);
});

test('the updater blocks outdated, unverified or out-of-scope downloads before installation', async () => {
  let installs = 0;
  const make = (metadata, download, busy = false) => createUpdater({
    getManager: () => ({ installBundle() { installs++; } }),
    isBusy: () => busy,
    fetcher: async (url) => String(url).startsWith('https://api.github.com/') ? Response.json(metadata) : download(url),
  });
  const noDownload = () => assert.fail('There must be no download');
  const obsolete = make({ ...release, tag_name: `v${installedVersion}` }, noDownload);
  assert.equal((await obsolete.status()).state, 'current');
  await assert.rejects(obsolete.install(installedVersion), { code: 'changed' });
  await assert.rejects(make({ ...release, prerelease: true }, noDownload).status(), { code: 'checkFailed' });
  await assert.rejects(make({ ...release, assets: [{ ...asset, digest: null }] }, noDownload).install(nextVersion), { code: 'unverified' });
  await assert.rejects(make({ ...release, assets: [{ ...asset, browser_download_url: 'https://example.invalid/asset.tgz' }] }, noDownload)
    .install(nextVersion), { code: 'unverified' });
  await assert.rejects(make(release, (url) => {
    assert.equal(String(url), asset.browser_download_url);
    return Response.redirect('https://example.invalid/asset.tgz');
  }).install(nextVersion), { code: 'downloadFailed' });
  await assert.rejects(make(release, () => new Response(Buffer.alloc(bytes.length))).install(nextVersion), { code: 'unverified' });
  await assert.rejects(make(release, noDownload, true).install(nextVersion), { code: 'busy' });
  assert.equal(installs, 0);
});

test('release build tags preserve the package version and constrain the matching asset path', async () => {
  const withTag = (tag, assets) => createUpdater({
    getManager: () => null,
    fetcher: async () => Response.json({ ...release, tag_name: tag, assets }),
  });
  assert.equal((await withTag(`v${installedVersion}+updater.1`, []).status()).state, 'current');

  const tagged = `v${nextVersion}+updater.1`;
  for (const pathTag of [tagged, encodeURIComponent(tagged)]) {
    const matching = { ...asset, browser_download_url: asset.browser_download_url.replace(`v${nextVersion}/`, `${pathTag}/`) };
    const status = await withTag(tagged, [matching]).status();
    assert.equal(status.state, 'available');
    assert.equal(status.version, nextVersion);
  }
  await assert.rejects(withTag(tagged, [asset]).status(), { code: 'unverified' });
  await assert.rejects(withTag(`v${nextVersion}-rc.1`, []).status(), { code: 'checkFailed' });
});

test('a manual check makes a fresh request immediately after a failed check', async () => {
  let checks = 0;
  const updater = createUpdater({
    getManager: () => null,
    fetcher: async () => {
      if (checks++ === 0) throw new Error('Offline');
      return Response.json(release);
    },
  });
  await assert.rejects(updater.status(), { code: 'checkFailed' });
  await assert.rejects(updater.status(), { code: 'checkFailed' });
  assert.equal(checks, 1);
  assert.equal((await updater.status(true)).state, 'available');
  assert.equal(checks, 2);
});
