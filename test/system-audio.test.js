import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createSystemAudio, verifiedHelper } from '../system-audio.js';
import { createRecordingStore } from '../storage.js';
import { pcmWaveHeader } from '../pcm.js';
import pkg from '../package.json' with { type: 'json' };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'voice-system-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const recordings = createRecordingStore(join(root, 'recordings'));
  await recordings.initialize();
  return { root, recordings };
}
function response() {
  const chunks = [];
  const stream = new Writable({ write(chunk, _, done) { chunks.push(Buffer.from(chunk)); done(); } });
  stream.writeHead = (status, headers) => { stream.status = status; stream.headers = headers; };
  return { stream, bytes: () => Buffer.concat(chunks) };
}
const generator = `
let n = 0;
const timer = setInterval(() => { process.stdout.write(Buffer.alloc(640, 1)); if (++n === 150) { clearInterval(timer); process.exit(0); } }, 10);
process.stdin.once('data', () => { clearInterval(timer); process.exit(0); });
`;
test('computer audio requires confirmation, archives PCM, and stops without model or microphone access', async (t) => {
  const { recordings } = await fixture(t);
  const capture = createSystemAudio({ recordings, getHelper: async () => process.execPath, args: ['-e', generator] });
  t.after(() => capture.dispose());
  await assert.rejects(capture.start({}), { code: 'confirmation' });
  const session = await capture.start({ confirmed: true, language: 'en' });
  assert.equal(session.sampleRate, 16000);
  await assert.rejects(capture.start({ confirmed: true }), { code: 'busy' });
  const out = response(); capture.stream(session.id, out.stream);
  await new Promise((resolve) => setTimeout(resolve, 65));
  const ended = once(out.stream, 'finish');
  const stopped = await capture.stop(session.id); await ended;
  assert.equal(stopped.active, false); assert.equal(stopped.code, null);
  const meta = await recordings.get(session.recordingId);
  assert.equal(meta.source, 'system'); assert.equal(meta.systemPcm, true);
  assert.ok(meta.size > 0); assert.equal(out.bytes().length, meta.size);
  assert.equal(out.stream.headers['cache-control'], 'private, no-store');
  const info = await recordings.audioStat(meta);
  const wave = Buffer.concat(await Array.fromAsync(recordings.audioStream(meta, { start: 0, end: info.size - 1 })));
  assert.deepEqual(wave.subarray(0, 44), pcmWaveHeader(meta.size));
  assert.deepEqual(wave.subarray(44), out.bytes());
  const range = Buffer.concat(await Array.fromAsync(recordings.audioStream(meta, { start: 39, end: 51 })));
  assert.deepEqual(range, wave.subarray(39, 52));
  const restarted = createRecordingStore(recordings.root); await restarted.initialize();
  assert.equal((await restarted.audioStat(await restarted.get(meta.id))).size, wave.length);
  assert.equal((await capture.stop(session.id)).active, false);
});
test('disconnect closes native input and preserves an interrupted archive', async (t) => {
  const { recordings } = await fixture(t);
  const capture = createSystemAudio({ recordings, getHelper: async () => process.execPath, args: ['-e', generator] });
  t.after(() => capture.dispose());
  const session = await capture.start({ confirmed: true });
  const out = response(); capture.stream(session.id, out.stream);
  out.stream.destroy();
  const stopped = await capture.stop(session.id);
  assert.equal(stopped.code, 'disconnected');
  assert.equal((await recordings.get(session.recordingId)).status, 'interrupted');
});
test('native verification rejects missing, changed, unexpected or linked components', async (t) => {
  const { root } = await fixture(t);
  await assert.rejects(verifiedHelper('linux', 'x64', root), { code: 'unsupported' });
  await assert.rejects(verifiedHelper('win32', 'x64', root), { code: 'missing' });
  await mkdir(join(root, 'win32-x64'));
  const relative = 'win32-x64/system-audio.exe';
  await writeFile(join(root, relative), 'synthetic native fixture');
  const hash = createHash('sha256').update(await readFile(join(root, relative))).digest('hex');
  const manifest = { version: pkg.version, files: { [relative]: hash } };
  await writeFile(join(root, 'win32-x64.json'), JSON.stringify(manifest));
  assert.equal(await verifiedHelper('win32', 'x64', root), join(root, relative));
  await writeFile(join(root, relative), 'changed');
  await assert.rejects(verifiedHelper('win32', 'x64', root), { code: 'unverified' });
  assert.throws(() => pcmWaveHeader(3)); assert.throws(() => pcmWaveHeader(3600 * 32000 + 2));
});
