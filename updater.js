import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import pkg from './package.json' with { type: 'json' };

const repository = 'WinterOne-hub/dsh-voice-notes';
const releaseApi = `https://api.github.com/repos/${repository}/releases/latest`;
const releaseDownloads = `https://github.com/${repository}/releases/download/`;
const assetHosts = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
const versionPattern = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const stableTagPattern = /^v([0-9.]+)(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;
const cacheMs = 6 * 60 * 60_000;
const retryMs = 60_000;
const maxReleaseBytes = 256 * 1024;
const maxPackageBytes = 4 * 1024 * 1024;

export class UpdateError extends Error {
  constructor(code, status = 502) {
    super('Voice Notes update could not be completed');
    this.code = code;
    this.status = status;
  }
}

function isNewer(version, installed) {
  const current = versionPattern.exec(installed);
  const candidate = versionPattern.exec(version);
  if (!current || !candidate) return false;
  for (let i = 1; i <= 3; i++) {
    const delta = Number(candidate[i]) - Number(current[i]);
    if (delta !== 0) return delta > 0;
  }
  return false;
}

async function fetchBytes(fetcher, url, limit, redirectHosts = new Set()) {
  const signal = AbortSignal.timeout(18_000);
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await fetcher(url, { signal, redirect: 'manual', credentials: 'omit' });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) break;
      const target = new URL(location, url);
      if (target.protocol !== 'https:' || target.port || target.username || target.password ||
          !redirectHosts.has(target.hostname)) break;
      url = target;
      continue;
    }
    if (!response.ok || !response.body || Number(response.headers.get('content-length')) > limit) {
      await response.body?.cancel();
      break;
    }
    const parts = [];
    let size = 0;
    for await (const part of response.body) {
      size += part.byteLength;
      if (size > limit) throw new Error('Download too large');
      parts.push(part);
    }
    return Buffer.concat(parts, size);
  }
  throw new Error('Download failed');
}

async function latestRelease(fetcher) {
  let release;
  try {
    release = JSON.parse(await fetchBytes(fetcher, releaseApi, maxReleaseBytes));
  } catch {
    throw new UpdateError('checkFailed');
  }
  const tag = release?.tag_name;
  const version = typeof tag === 'string' && tag.length <= 80 ? stableTagPattern.exec(tag)?.[1] : undefined;
  if (!version || !versionPattern.test(version) || release.draft !== false || release.prerelease !== false) {
    throw new UpdateError('checkFailed');
  }
  if (!isNewer(version, pkg.version)) return null;
  const name = `${pkg.name}-${version}.tgz`;
  const url = `${releaseDownloads}${encodeURIComponent(tag)}/${name}`;
  const assets = Array.isArray(release.assets) ? release.assets.filter((asset) => asset?.name === name) : [];
  const asset = assets[0];
  if (assets.length !== 1 || asset.state !== 'uploaded' ||
      ![url, `${releaseDownloads}${tag}/${name}`].includes(asset.browser_download_url) ||
      !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > maxPackageBytes ||
      !/^sha256:[a-f0-9]{64}$/.test(asset.digest)) throw new UpdateError('unverified');
  return { version, url, name, size: asset.size, digest: asset.digest.slice(7) };
}

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function cachePackage(dataRoot, release, bytes) {
  const dir = join(dataRoot, 'updates');
  await mkdir(dir, { mode: 0o700 }).catch((error) => {
    if (error.code !== 'EEXIST') throw error;
  });
  const info = await lstat(dir);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0) throw new Error('Unsafe update directory');
  // Harness saves this path as the install source. Keep the verified tarball available for later profile operations.
  const path = join(dir, `${release.digest}-${release.name}`);
  const temporary = join(dir, `${randomUUID()}.partial`);
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return path;
}

export function createUpdater({ dataRoot, getManager, isBusy, fetcher = fetch }) {
  let checked;
  let checking;
  let installing = false;
  let installed;

  async function check(force) {
    if (checking) return checking;
    if (checked && Date.now() - checked.at < (force || checked.error ? retryMs : cacheMs)) {
      if (checked.error) throw checked.error;
      return checked.release;
    }
    checking = latestRelease(fetcher).then((release) => {
      checked = { at: Date.now(), release };
      return release;
    }, (error) => {
      checked = { at: Date.now(), error };
      throw error;
    }).finally(() => { checking = null; });
    return checking;
  }

  return {
    async status(force) {
      const base = { current: pkg.version };
      if (installed) return { ...base, state: installed.state, version: installed.version };
      if (installing) return { ...base, state: 'installing' };
      const release = await check(force);
      return release
        ? { ...base, state: 'available', version: release.version, canInstall: Boolean(getManager()) }
        : { ...base, state: 'current' };
    },
    async install(version) {
      const manager = getManager();
      if (!manager) throw new UpdateError('unsupported', 409);
      if (installing || isBusy()) throw new UpdateError('busy', 409);
      if (installed) return installed;
      if (!isNewer(version, pkg.version)) throw new UpdateError('changed', 409);
      installing = true;
      try {
        const release = await check(true);
        if (release?.version !== version) throw new UpdateError('changed', 409);
        let bytes;
        try {
          bytes = await fetchBytes(fetcher, release.url, release.size, assetHosts);
        } catch {
          throw new UpdateError('downloadFailed');
        }
        if (bytes.length !== release.size || hash(bytes) !== release.digest) throw new UpdateError('unverified');
        if (isBusy()) throw new UpdateError('busy', 409);
        let result;
        try {
          const path = await cachePackage(dataRoot, release, bytes);
          if (isBusy()) throw new UpdateError('busy', 409);
          result = await manager.installBundle(path, { expected: { name: pkg.name, version }, enabled: true });
        } catch (error) {
          if (error instanceof UpdateError) throw error;
          throw new UpdateError('installFailed');
        }
        if (result?.error?.code === 'incompatible-version') throw new UpdateError('incompatible', 409);
        if (result?.bundle !== pkg.name || result.version !== version ||
            !['restart-required', 'applied'].includes(result.application)) throw new UpdateError('installFailed');
        installed = { state: result.application === 'applied' ? 'installed' : 'restart', version };
        return installed;
      } finally {
        installing = false;
      }
    },
  };
}
