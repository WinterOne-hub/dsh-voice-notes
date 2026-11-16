import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = process.env.VOICE_NOTES_TEST_DESKTOP;
const binary = join(desktop, 'DeepSeek Harness.exe');
const resources = join(desktop, 'resources');
const runtime = join(resources, 'app.asar', 'dsh');
const dshRoot = await mkdtemp(join(tmpdir(), 'voice-notes-host-'));
const profile = join(dshRoot, 'profiles', 'desktop');
const env = { ...process.env, DSH_HOME: dshRoot, DSH_TELEMETRY_DISABLED: '1', DSH_CLIENT_VERSION: '0.2.2-rc.3', ELECTRON_RUN_AS_NODE: '1' };
const init = join(dshRoot, 'init.mjs');
let host;
let output = '';
try {
  await writeFile(init, `import { pathToFileURL } from 'node:url';
const [entry, profile] = process.argv.slice(2);
const { initProfile } = await import(pathToFileURL(entry).href);
initProfile(profile, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']);
`);
  const result = spawnSync(binary, ['--expose-internals', init,
    join(runtime,'node_modules','@deepseek-ai','dsh-app-boot','lib','index.js'), profile], { env, encoding: 'utf8', timeout: 25000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const cli = join(resources, 'runtime', 'cli', 'bin', 'dsh.cmd');
  const packagePath = resolve('dsh-voice-notes-0.0.2.tgz');
  const installation = spawnSync('cmd.exe', ['/d', '/s', '/c', `""${cli}" plugin --profile desktop add "${packagePath}" --offline"`],
    { env, encoding: 'utf8', timeout: 35000, windowsVerbatimArguments: true });
  assert.equal(installation.status, 0, installation.stderr || installation.stdout || installation.error?.message);
  const installed = JSON.parse(await readFile(join(profile, 'node_modules', 'dsh-voice-notes', 'package.json'), 'utf8'));
  assert.ok(installed.dsh.bundle.platforms.includes('win32'));
  host = spawn(binary, ['--expose-internals', join(runtime,'node_modules','@deepseek-ai','dsh-desktop-host','lib','index.js'),
    runtime, profile, join(resources, 'runtime', 'primary-runtime')], { env, stdio: ['ignore','pipe','pipe','ipc'] });
  for (const stream of [host.stderr, host.stdout]) stream.on('data', (chunk) => { output = (output + chunk.toString()).slice(-12000); });
  const start = await new Promise((ready, fail) => {
    const timer = setTimeout(() => fail(new Error('Desktop Host did not start')), 45000);
    host.once('error', (fault) => { clearTimeout(timer); fail(fault); });
    host.once('exit', (code) => { clearTimeout(timer); fail(new Error('Desktop Host exited: ' + code)); });
    host.on('message', (message) => {
      if (message.type === 'ready') { clearTimeout(timer); ready(new URL(message.url)); }
      if (message.type === 'fatal') { clearTimeout(timer); fail(new Error(String(message.message).replace(/https?:\/\/\S+/g, '[url]'))); }
    });
  });
  const api = (path) => new URL('/api/voice-live' + path, start);
  assert.equal((await fetch(api('/status'))).status, 401);
  const response = await fetch(start, { redirect: 'manual' });
  const cookie = response.headers.getSetCookie().map((item) => item.split(';')[0]).join('; ');
  assert.ok(cookie, 'The Desktop Host issues a signed browser session');
  const send = (route, init={}) => fetch(api(route), { ...init, headers: { cookie, ...init.headers } });
  const status = await send('/status');
  assert.equal(status.status, 200);
  assert.ok((await status.json()).providers.some((p) => p.id === 'sensevoice-local'));
  const audio = Buffer.from('synthetic archive byte-range fixture');
  const individual = await send('/recordings', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'Windows Host integration fixture', mimeType: 'audio/webm', audioBase64: audio.toString('base64') }),
  });
  assert.equal(individual.status, 201);
  const id = (await individual.json()).recording.id;
  const playback = await send('/recordings/' + id + '/audio', { headers: { Range: 'bytes=0-8' } });
  assert.equal(playback.status, 206);
  assert.deepEqual(Buffer.from(await playback.arrayBuffer()), audio.subarray(0, 9));
  const update = await send('/update');
  assert.equal(update.status, 200);
  assert.equal((await update.json()).current, '0.0.2');
  assert.equal((await send('/recordings/' + id, { method: 'DELETE' })).status, 200);
  console.log('Installed in official Windows Desktop Host; verified signed session, SenseVoice registration, recording archive, Range playback and updater endpoint.');
  const providerId = 'sensevoice-local';
  const post = (path, json) => send(path, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(json),
  });
  const setup = await post('/prepare', { providerId });
  assert.equal(setup.status, 202);
  console.log('Preparing the official native SenseVoice model on Windows.');
  const deadline = Date.now() + 240_000;
  let modelReady = false;
  for (;;) {
    const snapshot = await (await send('/status')).json();
    const state = snapshot.providers.find((p) => p.id === providerId).preparation;
    assert.notEqual(state.phase, 'failed', state.error ?? 'SenseVoice preparation failed');
    if (state.phase === 'ready' || state.phase === 'standby') { modelReady = true; break; }
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  assert.ok(modelReady, 'SenseVoice preparation did not finish before the test deadline');
  const wave = await readFile(process.env.VOICE_NOTES_TEST_WAV);
  const started = performance.now();
  const recognition = await post('/transcribe', { audioBase64: wave.toString('base64'), language: 'en' });
  const recognized = await recognition.json();
  assert.equal(recognition.status, 200, recognized.error?.message);
  assert.match(recognized.text.toLowerCase(), /blue/);
  assert.match(recognized.text.toLowerCase(), /folder/);
  console.log('Windows SenseVoice recognized locally synthesized speech through the plugin in ' + Math.round(performance.now()-started) + ' ms.');

} catch (error) {
  console.error(output.split('\n').filter(line => /warn|error|voice-live/i.test(line)).slice(-16).join('\n').replace(/https?:\/\/\S+/g, '[url]'));
  throw error;
} finally {
  if (host && host.exitCode === null && host.signalCode === null) {
    const exited = once(host, 'exit');
    if (host.connected) host.send({type:'shutdown'}, () => {});
    const timer = setTimeout(() => host.kill(), 3500);
    await exited;
    clearTimeout(timer);
  }
  await rm(dshRoot, { recursive: true, force: true, maxRetries: 3 });
}
