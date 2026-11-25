import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { release } from 'node:os';
import pkg from './package.json' with { type: 'json' };
import { PCM_BYTES_PER_SECOND, SYSTEM_AUDIO_SECONDS } from './pcm.js';

export class SystemAudioError extends Error {
  constructor(code, status = 409) { super('Computer audio capture could not be completed'); this.code = code; this.status = status; }
}
const codes = new Set(['unsupported', 'captureFailed', 'noDevice', 'deviceChanged', 'limit', 'slowConsumer']);
const root = fileURLToPath(new URL('./native/bin/', import.meta.url));
const bundles = {
  'darwin-arm64': ['darwin-arm64/VoiceNotesAudio.app/Contents/MacOS/VoiceNotesAudio', 'darwin-arm64/VoiceNotesAudio.app/Contents/Info.plist', 'darwin-arm64/VoiceNotesAudio.app/Contents/_CodeSignature/CodeResources'],
  'win32-x64': ['win32-x64/system-audio.exe'],
};

export async function verifiedHelper(platform = process.platform, arch = process.arch, directory = root) {
  const key = `${platform}-${arch}`, files = bundles[key];
  if (platform === 'darwin' && process.platform === 'darwin' && Number(release().split('.').slice(0, 2).join('.')) < 23.2) throw new SystemAudioError('unsupported', 503);
  if (!files) throw new SystemAudioError('unsupported', 503);
  try {
    const base = await lstat(directory);
    if (base.isSymbolicLink() || !base.isDirectory()) throw new Error('Unsafe native root');
    const paths = [...files, `${key}.json`];
    for (const path of paths) {
      const components = path.split('/');
      for (let n = 1; n <= components.length; n++) {
        const info = await lstat(join(directory, ...components.slice(0, n)));
        if (info.isSymbolicLink() || (n < components.length ? !info.isDirectory() : !info.isFile())) throw new Error('Unsafe native bundle');
      }
    }
    const manifest = JSON.parse(await readFile(join(directory, `${key}.json`), 'utf8'));
    if (manifest.version !== pkg.version || Object.keys(manifest.files ?? {}).length !== files.length) throw new Error('Invalid manifest');
    for (const path of files) {
      const hash = createHash('sha256').update(await readFile(join(directory, path))).digest('hex');
      if (manifest.files[path] !== hash) throw new Error('Native bundle mismatch');
    }
    return join(directory, files[0]);
  } catch (error) { throw new SystemAudioError(error.code === 'ENOENT' ? 'missing' : 'unverified', 503); }
}

// No model credentials, preload flags or arbitrary executable options reach the helper.
function helperEnvironment() {
  return Object.fromEntries(['HOME', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'WINDIR', 'LANG', 'LC_ALL']
    .filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
}

export function createSystemAudio({ recordings, getHelper = verifiedHelper, launch = spawn, args = ['--capture'], platform = process.platform, arch = process.arch }) {
  let current, starting = false;
  const busy = () => starting || Boolean(current?.active);
  const status = async () => {
    try {
      await getHelper(platform, arch);
      return { supported: true, ready: true, active: busy(), maxSeconds: SYSTEM_AUDIO_SECONDS };
    } catch (error) {
      return { supported: error.code !== 'unsupported', ready: false, active: busy(), maxSeconds: SYSTEM_AUDIO_SECONDS, code: error.code ?? 'unverified' };
    }
  };
  const get = (id) => {
    if (!current || current.id !== id) throw new SystemAudioError('missingSession', 404);
    return current;
  };
  const endProcess = (session, code) => {
    if (code && !session.code) session.code = code;
    if (session.stopping) return;
    session.stopping = true;
    session.child.stdin.end('stop\n');
    session.killTimer = setTimeout(() => session.child.kill('SIGKILL'), 2000);
    session.killTimer.unref?.();
  };
  async function deliver(session, chunk) {
    if (session.response && !session.response.destroyed) {
      if (!session.response.write(chunk)) {
        const response = session.response;
        await new Promise((resolve, reject) => {
          const cleanup = () => { clearTimeout(timer); response.off('drain', drained); response.off('close', closed); };
          const drained = () => { cleanup(); resolve(); };
          const closed = () => { cleanup(); reject(new SystemAudioError('disconnected')); };
          const timer = setTimeout(() => { cleanup(); reject(new SystemAudioError('slowConsumer')); }, 5000);
          response.once('drain', drained); response.once('close', closed);
        });
      }
    } else {
      session.pending.push(chunk); session.pendingBytes += chunk.length;
      if (session.pendingBytes > PCM_BYTES_PER_SECOND * 10) throw new SystemAudioError('disconnected');
    }
  }
  const snapshot = (session) => ({ id: session.id, recordingId: session.recording.id, active: session.active,
    code: session.code ?? null, seconds: session.bytes / PCM_BYTES_PER_SECOND });

  async function start({ language = 'auto', confirmed, reportKind }, signal) {
    if (confirmed !== true) throw new SystemAudioError('confirmation', 400);
    if (busy()) throw new SystemAudioError('busy');
    starting = true;
    let session;
    try {
      signal?.throwIfAborted();
      const executable = await getHelper(platform, arch);
      signal?.throwIfAborted();
      const recording = await recordings.save({ text: '', live: true, mimeType: 'audio/wav', source: 'system', systemPcm: true, language, reportKind });
      const child = launch(executable, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: helperEnvironment() });
      let resolveReady, rejectReady;
      const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
      session = { id: randomUUID(), recording, child, active: true, code: null, bytes: 0, sequence: 0,
        pending: [], pendingBytes: 0, lastData: Date.now(), attached: false };
      current = session;
      const exited = new Promise((resolve) => { child.once('close', (code) => resolve(code)); child.once('error', () => { session.code = 'captureFailed'; rejectReady(new SystemAudioError('captureFailed', 503)); resolve(1); }); });
      child.stdin.on('error', () => {});
      let stderr = '';
      child.stderr.on('data', (data) => {
        stderr += data.toString('utf8');
        if (stderr.length > 4096) { endProcess(session, 'captureFailed'); stderr = ''; return; }
        let newline;
        while ((newline = stderr.indexOf('\n')) >= 0) {
          const line = stderr.slice(0, newline); stderr = stderr.slice(newline + 1);
          try { const event = JSON.parse(line); if (event.event === 'error') session.code = codes.has(event.code) ? event.code : 'captureFailed'; }
          catch { endProcess(session, 'captureFailed'); }
        }
      });
      const abort = () => endProcess(session, 'disconnected');
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const startup = setTimeout(() => { endProcess(session, 'noSamples'); rejectReady(new SystemAudioError('noSamples', 503)); }, 45_000);
      session.watchdog = setInterval(() => {
        if (session.receivedSamples && Date.now() - session.lastData > 6000) endProcess(session, 'noSamples');
        if (session.receivedSamples && !session.attached && Date.now() - session.firstSampleAt > 10_000) endProcess(session, 'disconnected');
      }, 1000);
      session.watchdog.unref?.();
      session.deadline = setTimeout(() => endProcess(session, 'limit'), SYSTEM_AUDIO_SECONDS * 1000);
      session.deadline.unref?.();
      session.done = (async () => {
        let remainder = Buffer.alloc(0), pieces = [], length = 0;
        const commit = async () => {
          if (!length) return;
          const chunk = Buffer.concat(pieces, length); pieces = []; length = 0;
          await recordings.appendChunk(recording.id, session.sequence++, chunk, (session.bytes + chunk.length) / PCM_BYTES_PER_SECOND);
          session.bytes += chunk.length;
          await deliver(session, chunk);
        };
        try {
          for await (const data of child.stdout) {
            session.lastData = Date.now();
            if (session.bytes + length + data.length > SYSTEM_AUDIO_SECONDS * PCM_BYTES_PER_SECOND) { endProcess(session, 'limit'); break; }
            const bytes = remainder.length ? Buffer.concat([remainder, data]) : data;
            const aligned = bytes.length - bytes.length % 2;
            remainder = bytes.subarray(aligned);
            if (aligned) {
              pieces.push(Buffer.from(bytes.subarray(0, aligned)));
              length += aligned;
              if (!session.receivedSamples) {
                session.receivedSamples = true;
                session.firstSampleAt = Date.now();
                clearTimeout(startup);
                resolveReady();
              }
            }
            if (length >= PCM_BYTES_PER_SECOND) await commit();
          }
          if (remainder.length) throw new SystemAudioError('captureFailed');
          await commit();
          const code = await exited;
          if (code !== 0 && !session.code) session.code = 'captureFailed';
        } catch (error) { endProcess(session, error.code ?? 'captureFailed'); }
        finally {
          await exited;
          clearTimeout(startup); clearTimeout(session.killTimer); clearTimeout(session.deadline); clearInterval(session.watchdog);
          signal?.removeEventListener('abort', abort);
          session.active = false;
          rejectReady(new SystemAudioError(session.code ?? 'noSamples', 503));
          if (session.response && !session.response.destroyed) session.response.end();
          if (!session.bytes || session.code === 'disconnected' || (session.code && !session.attached)) await recordings.update(recording.id, { status: 'interrupted' }).catch(() => {});
        }
      })();
      await ready;
      return { ...snapshot(session), recording: await recordings.get(recording.id), sampleRate: 16000 };
    } catch (error) {
      if (session) endProcess(session, error.code ?? 'captureFailed');
      throw error instanceof SystemAudioError ? error : new SystemAudioError('captureFailed', 503);
    } finally { starting = false; }
  }
  function stream(id, response) {
    const session = get(id);
    if (session.attached) throw new SystemAudioError('busy');
    session.attached = true; session.response = response;
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'private, no-store, no-transform',
      'x-content-type-options': 'nosniff', 'cross-origin-resource-policy': 'same-origin' });
    response.flushHeaders?.();
    response.once('close', () => {
      session.response = null;
      if (!response.writableEnded && session.active) endProcess(session, 'disconnected');
    });
    for (const chunk of session.pending) response.write(chunk);
    session.pending = []; session.pendingBytes = 0;
    if (!session.active) response.end();
  }
  async function stop(id) {
    const session = get(id);
    if (!session.active) return snapshot(session);
    endProcess(session);
    await session.done;
    return snapshot(session);
  }
  async function dispose() {
    if (!current?.active) return;
    endProcess(current, 'disconnected');
    await current.done;
  }
  return { status, busy, start, stream, stop, snapshot: (id) => snapshot(get(id)), dispose };
}
