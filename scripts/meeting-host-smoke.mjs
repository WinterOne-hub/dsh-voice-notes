import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const desktop = process.env.VOICE_NOTES_TEST_DESKTOP;
const packagePath = resolve(process.argv[2]);
const wavPath = process.argv[3];
const windows = process.platform === 'win32';
const binary = join(desktop, windows ? 'DeepSeek Harness.exe' : 'Contents/MacOS/DeepSeek Harness');
const resources = join(desktop, windows ? 'resources' : 'Contents/Resources');
const runtime = join(resources, 'app.asar', 'dsh');
const root = await mkdtemp(join(tmpdir(), 'voice-notes-meeting-'));
const profile = join(root, 'profiles', 'desktop');
const env = {
  ...process.env, DSH_HOME: root, XDG_CACHE_HOME: join(root, 'cache'), XDG_STATE_HOME: join(root, 'state'),
  DSH_TELEMETRY_DISABLED: '1', DSH_CLIENT_VERSION: '0.2.2-rc.3', ELECTRON_RUN_AS_NODE: '1',
};
const init = join(root, 'init.mjs');
let host, output = '';
const failSafe = (value) => String(value).replace(/https?:\/\/\S+/g, '[url]');

function pcmOf(wave) {
  for (let offset = 12; offset + 8 <= wave.length;) {
    const length = wave.readUInt32LE(offset + 4);
    if (wave.toString('ascii', offset, offset + 4) === 'data') return wave.subarray(offset + 8, offset + 8 + length);
    offset += 8 + length + length % 2;
  }
  throw new Error('Missing PCM data');
}
try {
  await writeFile(init, `import { pathToFileURL } from 'node:url';
const [entry, profile] = process.argv.slice(2);
const { initProfile } = await import(pathToFileURL(entry).href);
initProfile(profile, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);
`);
  const entry = join(runtime, 'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js');
  const setup = spawnSync(binary, ['--expose-internals', init, entry, profile], { env, encoding: 'utf8', timeout: 35_000 });
  assert.equal(setup.status, 0, failSafe(setup.stderr || setup.error?.message));
  const cli = join(resources, 'runtime/cli/bin', windows ? 'dsh.cmd' : 'dsh');
  const args = ['plugin', '--profile', 'desktop', 'add', packagePath, '--offline'];
  const installEnv = { ...env };
  delete installEnv.ELECTRON_RUN_AS_NODE;
  const install = windows
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', `\"\"${cli}\" plugin --profile desktop add \"${packagePath}\" --offline\"`],
      { env: installEnv, encoding: 'utf8', timeout: 45_000, windowsVerbatimArguments: true })
    : spawnSync(cli, args, { env: installEnv, encoding: 'utf8', timeout: 45_000, cwd: dirname(packagePath) });
  assert.equal(install.status, 0, failSafe(install.stderr || install.stdout || install.error?.message));

  if (process.env.VOICE_NOTES_TEST_CACHE) {
    const { cp } = await import('node:fs/promises');
    await cp(process.env.VOICE_NOTES_TEST_CACHE, join(root, 'speech-to-text', 'sensevoice'), { recursive: true });
  }
  const cachedMeeting = process.env.VOICE_NOTES_TEST_MEETING_MODEL;
  host = spawn(binary, ['--expose-internals', join(runtime,'node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js'),
    runtime, profile, join(resources, 'runtime/primary-runtime')], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  for (const stream of [host.stderr, host.stdout]) stream.on('data', (data) => { output = (output + data).slice(-20_000); });
  const start = await new Promise((ready, fail) => {
    const timer = setTimeout(() => fail(new Error('Desktop Host did not start')), 45_000);
    host.once('error', (error) => { clearTimeout(timer); fail(error); });
    host.once('exit', (code) => { clearTimeout(timer); fail(new Error(`Desktop Host exited: ${code}`)); });
    host.on('message', (message) => {
      if (message.type === 'ready') { clearTimeout(timer); ready(new URL(message.url)); }
      if (message.type === 'fatal') { clearTimeout(timer); fail(new Error(failSafe(message.message))); }
    });
  });
  const url = (path) => new URL('/api/voice-live' + path, start);
  assert.equal((await fetch(url('/meeting-models'))).status, 401);
  assert.equal((await fetch(url('/system-audio'))).status, 401);
  const response = await fetch(start, { redirect: 'manual' });
  const cookie = response.headers.getSetCookie().map((item) => item.split(';')[0]).join('; ');
  assert.ok(cookie);
  const raw = (path, init = {}) => fetch(url(path), { ...init, headers: { cookie, ...init.headers } });
  const json = async (path, init) => {
    const res = await raw(path, init);
    const data = await res.json();
    assert.ok(res.ok, `${res.status} ${data.error?.code ?? ''} ${data.error?.message ?? ''}`);
    return data;
  };
  const send = (path, method, body) => json(path, {
    method, ...(body !== undefined && { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const bytes = (path, method, body) => ({ method, headers: { 'content-type': 'application/octet-stream' }, body });

  const computerAudio = await send('/system-audio', 'GET');
  assert.equal(computerAudio.ready, true, 'Installed native audio component must pass integrity checks without capture');
  assert.equal(computerAudio.active, false);
  assert.equal((await raw('/system-audio', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmed: false, language: 'en' }) })).status, 400);
  const missingCapture = '/system-audio/00000000-0000-0000-0000-000000000000';
  for (const [path, method] of [[missingCapture, 'GET'], [missingCapture + '/stream', 'GET'], [missingCapture, 'DELETE']]) {
    const absent = await raw(path, { method });
    assert.equal(absent.status, 404);
    assert.equal((await absent.json()).error.code, 'missingSession', `${method} ${path} must reach the plugin`);
  }
  const models = await send('/meeting-models', 'GET');
  assert.equal(models.supported, true, 'The Host ships the correct native runtime');
  assert.equal(models.ready, false);
  if (cachedMeeting) {
    const model = await readFile(cachedMeeting);
    const wrong = Buffer.from(model);
    wrong[0] ^= 1;
    assert.equal((await raw('/meeting-models', bytes('/meeting-models', 'PUT', wrong))).status, 422);
    assert.equal((await send('/meeting-models', 'GET')).ready, false);
    await json('/meeting-models', bytes('/meeting-models', 'PUT', model));
  } else {
    await send('/meeting-models', 'POST');
  }
  assert.equal((await send('/meeting-models', 'GET')).ready, true);

  await send('/prepare', 'POST', { providerId: 'sensevoice-local' });
  const deadline = Date.now() + 240_000;
  for (;;) {
    const { providers } = await send('/status', 'GET');
    const { phase, message } = providers.find(({ id }) => id === 'sensevoice-local').preparation;
    if (['ready', 'standby'].includes(phase)) break;
    assert.notEqual(phase, 'failed', failSafe(message));
    assert.ok(Date.now() < deadline, 'SenseVoice model preparation timed out');
    await new Promise((ready) => setTimeout(ready, 1500));
  }
  const audio = await readFile(wavPath);
  const pcm = pcmOf(audio);
  const duration = pcm.length / 32000;
  const { recording } = await send('/recordings/live', 'POST', {
    language: 'zh', mimeType: 'audio/wav', title: 'Public four-speaker fixture', source: 'import',
  });
  const path = '/recordings/' + recording.id;
  const chunkPath = path + '/chunks/0?duration=' + duration;
  await json(chunkPath, bytes(chunkPath, 'PUT', audio));
  const segment = `${path}/segments/0?start=0&end=${duration}`;
  await json(segment, bytes(segment, 'PUT', audio));
  await send(path + '/segments/0/retry?live=1', 'POST');
  const original = await send(path, 'PATCH', { status: 'complete', duration });
  assert.ok(original.recording.text.length > 5);
  const meeting = path + '/meeting?frames=' + pcm.length / 2 + '&speakers=4';
  const started = performance.now();
  const finished = await json(meeting, bytes(meeting, 'POST', pcm));
  const result = finished.recording.meeting;
  assert.equal(result.speakers.length, 4);
  assert.equal(new Set(result.turns.map(({ speakerId }) => speakerId).filter(Boolean)).size, 4);
  assert.ok(result.turns.every(({ overlap, speakerId }) => !overlap || speakerId === null));
  assert.ok(result.turns.reduce((n, row) => n + row.text.length, 0) > 50);
  console.log(`${process.platform}: ${duration.toFixed(1)} s audio, ${result.turns.length} turns, 4 speaker labels, ${((performance.now()-started)/1000).toFixed(1)} s for diarization and ASR.`);
  const corrected = await send(path + '/meeting', 'PATCH', { revision: result.revision, kind: 'speaker', speakerId: 1, name: 'Speaker A' });
  assert.equal(corrected.recording.meeting.revision, 2);
  assert.equal(corrected.recording.text, original.recording.text);
  assert.equal((await fetch(url(path + '/check'))).status, 401);
  const checkPreview = await send(path + '/check', 'GET');
  assert.equal(checkPreview.check, null);
  assert.match(checkPreview.source.hash, /^[a-f0-9]{64}$/);
  assert.ok(checkPreview.source.chars > 0);
  assert.ok(checkPreview.source.units.every((unit) => typeof unit.text === 'string' && !Object.hasOwn(unit, 'speakerName')));
  assert.equal((await fetch(url(path + '/interpretation'))).status, 401);
  const interpretationPreview = await send(path + '/interpretation', 'GET');
  assert.equal(interpretationPreview.report, null);
  assert.match(interpretationPreview.source.hash, /^[a-f0-9]{64}$/);
  assert.equal(interpretationPreview.source.chars, checkPreview.source.chars);
  assert.ok(interpretationPreview.source.units.every((unit) => typeof unit.ambiguous === 'boolean'));
  assert.match(await (await raw(path + '/transcript?variant=meeting&locale=en')).text(), /Speaker A/);
  assert.equal((await send('/recordings?q=Speaker+A&limit=25', 'GET')).recordings[0].hasMeeting, true);
  assert.equal((await raw(path + '/audio', { headers: { range: 'bytes=0-8' } })).status, 206);
  await send(path, 'DELETE');
} catch (error) {
  console.error(failSafe(output.split('\n').filter((line) => /warn|error|voice-live/i.test(line)).slice(-12).join('\n')));
  throw error;
} finally {
  if (host && host.exitCode === null && host.signalCode === null) {
    const exited = once(host, 'exit');
    if (host.connected) host.send({ type: 'shutdown' }, () => {});
    const timer = setTimeout(() => host.kill(), 3500);
    await exited;
    clearTimeout(timer);
  }
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
}
