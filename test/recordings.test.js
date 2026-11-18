import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmod, link, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { apply } from '../index.js';
import { planTurns, PCM_RATE } from '../meeting.js';
import { checkSource } from '../meeting-check.js';
import { createRecordingStore, recordingStatus, STALE_RECORDING_MS } from '../storage.js';

const API = '/api/voice-live';

function wave(seconds = 1) {
  const bytes = Buffer.alloc(44 + 32_000 * seconds);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16_000, 24);
  bytes.writeUInt32LE(32_000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(bytes.length - 44, 40);
  return bytes;
}

async function fixture(t) {
  const dataRoot = await mkdtemp(join(tmpdir(), 'voice-notes-test-'));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const routes = [];
  const model = { provider: 'test-provider', model: 'test-model' };
  const host = '127.0.0.1:38123';
  const browserPeer = {};
  const connection = {
    browserPeer,
    admit({ headers }) {
      if (headers.origin && headers.origin !== `http://${host}`) return { rejection: 403 };
      if (headers.cookie === 'fixture=session') return { peer: browserPeer };
      if (headers.authorization === 'fixture-api') return { peer: {} };
      return { rejection: 401 };
    },
  };
  const state = { fail: false, modelCalls: 0, speechCalls: [] };
  const speech = {
    snapshot: () => ({
      providers: [{ id: 'sensevoice-local', preparation: { phase: 'ready' } }],
      selection: { providerId: 'sensevoice-local' },
    }),
    resolve: (input) => input,
    async transcribe({ language }) {
      state.speechCalls.push(language);
      if (state.wait) await state.wait;
      if (state.fail) throw new Error('test ASR failure');
      return { text: state.speechText ?? 'Raw model output' };
    },
  };
  async function registerHost(profile = 'desktop') {
    routes.length = 0;
    await apply({
      get: (name) => ({
        speechToText: speech,
        connection,
        profileContext: { name: profile },
        agentDefaultModel: { currentSelection: () => model },
        llm: { prepareCall: async (spec, signal) => {
          state.modelCalls += 1;
          state.modelSignal = signal;
          if (state.waitModel) await state.waitModel;
          return { async *stream(options) {
            state.lastModelInput = options.messages[0].content[0].text;
            yield { type: 'text-delta', text: state.checkResult ? state.checkResult(options) : 'Edited output' };
          } };
        } },
      })[name],
      effect: (effect) => effect(),
      webServer: { getOrigin: () => `http://${host}`, register: (route) => routes.push(route) },
    }, { dataRoot });
  }
  await registerHost();

  async function call(path, method = 'GET', body, headers = {}, address = '127.0.0.1') {
    const pathname = path.split('?')[0];
    const route = routes.find((r) => r.kind === 'exact' ? r.path === pathname : pathname.startsWith(r.path));
    assert.ok(route, path);
    const bytes = body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))];
    const req = Object.assign(Readable.from(bytes), {
      url: path, socket: { remoteAddress: address }, method,
      headers: {
        host,
        cookie: 'fixture=session',
        ...(body !== undefined ? { 'content-type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json' } : {}),
        ...headers,
      },
    });
    const output = [];
    const res = new Writable({
      write(chunk, encoding, done) { output.push(chunk); done(); },
    });
    res.writeHead = (status, headers) => {
      Object.assign(res, { status, headers, headersSent: true });
    };
    if (path.endsWith('/check') && method === 'POST') state.checkResponse = res;
    const finished = once(res, 'finish');
    await route.handler(req, res);
    await finished;
    const raw = Buffer.concat(output);
    const data = res.headers['content-type']?.includes('application/json') ? JSON.parse(raw) : raw;
    return { status: res.status, data, headers: res.headers };
  }

  return { call, state, model, dataRoot, registerHost, routes };
}

test('checkpoints and byte ranges survive a Host restart; recovery keeps old entries readable', async (t) => {
  const { call, dataRoot, registerHost } = await fixture(t);
  const archive = `${API}/recordings`;
  const store = createRecordingStore(join(dataRoot, 'recordings'));
  const legacy = await store.save({ text: 'Legacy transcript', audio: Buffer.alloc(64), mimeType: 'audio/webm' });
  const { data: { recording } } = await call(`${archive}/live`, 'POST', { language: 'en', mimeType: 'audio/webm' });
  const path = `${archive}/${recording.id}`;
  const chunks = [Buffer.from('header'), Buffer.from('body'), Buffer.from('tail')];
  for (const [sequence, bytes] of chunks.entries()) {
    assert.equal((await call(`${path}/chunks/${sequence}?duration=${sequence + 1}`, 'PUT', bytes)).status, 200);
  }
  assert.equal((await call(`${path}/chunks/1?duration=9`, 'PUT', chunks[1])).status, 200);
  assert.equal((await call(`${path}/chunks/5?duration=9`, 'PUT', chunks[2])).status, 409);
  assert.equal((await call(`${path}/segments/0?start=0&end=1&checkpoint=1`, 'PUT', wave())).status, 200);
  assert.equal((await call(`${path}/segments/0/retry`, 'POST')).status, 409);
  const meta = await store.get(recording.id);
  assert.equal(recordingStatus(meta, meta.lastCaptureAt + STALE_RECORDING_MS + 1), 'interrupted');
  await registerHost();
  const recovered = await call(path);
  assert.equal(recovered.data.recording.pendingCount, 1);
  const full = await call(`${path}/audio`);
  assert.deepEqual(full.data, Buffer.concat(chunks));
  const range = await call(`${path}/audio`, 'GET', undefined, { range: 'bytes=4-11' });
  assert.equal(range.status, 206);
  assert.equal(range.headers['content-range'], 'bytes 4-11/14');
  assert.equal(range.data.toString(), 'erbodyta');
  const old = await call(`${archive}/${legacy.id}/audio`);
  assert.equal(old.data.length, 64);
});

test('failed segment can be retried and concurrent derived updates preserve the raw transcript', async (t) => {
  const { call, state, model } = await fixture(t);
  const archive = `${API}/recordings`;
  const { data: { recording } } = await call(`${archive}/live`, 'POST', { language: 'en' });
  const path = `${archive}/${recording.id}`;
  await call(`${path}/chunks/0?duration=2`, 'PUT', Buffer.from('synthetic audio'));
  await call(`${path}/segments/0?start=0&end=1&checkpoint=1`, 'PUT', wave());
  await call(`${path}/segments/0?start=0&end=2&checkpoint=0`, 'PUT', wave(2));
  await call(`${path}/segments/0?start=0&end=1&checkpoint=1`, 'PUT', wave());
  state.fail = true;
  const failed = await call(`${path}/segments/0/retry?live=1`, 'POST');
  assert.equal(failed.data.segment.state, 'failed');
  assert.equal(failed.data.segment.end, 2);
  await Promise.all([
    call(path, 'PATCH', { status: 'complete', duration: 2 }),
    call(path, 'PATCH', { title: 'My recording', report: 'Meeting notes' }),
    call(path, 'PATCH', { translation: 'Translation' }),
    call(path, 'PATCH', { editedText: 'Edited text' }),
  ]);
  state.fail = false;
  const retried = await call(`${path}/segments/0/retry`, 'POST');
  const saved = retried.data.recording;
  assert.equal(saved.status, 'complete');
  assert.equal(saved.pendingCount, 0);
  assert.equal(saved.title, 'My recording');
  assert.equal(saved.text, 'Raw model output');
  assert.equal(saved.editedText, 'Edited text');
  assert.equal(saved.translation, 'Translation');
  assert.equal(saved.report, 'Meeting notes');
  assert.equal(saved.derivedStale, true);
  assert.deepEqual(state.speechCalls, ['en', 'en']);
  assert.equal(state.modelCalls, 0);
  const search = await call(`${archive}?q=meeting+notes&limit=25`);
  assert.equal(search.data.total, 1);
  assert.equal(search.data.recordings[0].id, saved.id);
  assert.equal(search.data.recordings[0].segments, undefined);
  const wrongModel = await call(`${API}/normalize`, 'POST', { text: saved.text, language: 'en', model: { provider: 'other', model: model.model } });
  assert.equal(wrongModel.status, 409);
  assert.equal(state.modelCalls, 0);
});

async function bootClient(t, call, preferences = {}, runtime = {}) {
  const rawSource = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  const source = rawSource.replace(/^    return \{\r?\n      inject: \['slots',/m, (registration) =>
    '    globalThis.voice = { store, engine, begin, finish, finalizeSegment, ingestSamples, handleDictationShortcut, mountRecordingIndicator, segmentAtTime, importAudio, importedMime, openTranscriptDraft, readTranscriptSelection, CheckGauge, MeetingCheck, translate };\n' + registration);
  assert.ok(source !== rawSource, 'The test harness must expose the client factory helpers');
  const methods = { connect() {}, disconnect() {} };
  const stream = { getTracks: () => [] };
  class AudioContext {
    sampleRate = 16000;
    state = 'running';
    createMediaStreamSource() { return methods; }
    createGain() { return { ...methods, gain: {} }; }
    createScriptProcessor() { return { ...methods }; }
  }
  class OfflineAudioContext {
    async decodeAudioData() {
      return {
        sampleRate: 16000, numberOfChannels: 2, length: 480000, duration: 30,
        getChannelData: () => new Float32Array(480000),
      };
    }
  }
  class MediaRecorder extends EventTarget {
    mimeType = 'audio/webm';
    state = 'inactive';
    static isTypeSupported() { return true; }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      this.ondataavailable({ data: new Blob(['tail']) });
      this.dispatchEvent(new Event('stop'));
    }
  }
  class Element extends EventTarget {
    children = [];
    append(...children) { this.children.push(...children); }
    setAttribute() {}
    remove() { this.removed = true; }
  }
  const body = new Element();
  const sandbox = {
    AbortController, AbortSignal, Blob, DataView, MediaRecorder, OfflineAudioContext, URLSearchParams, btoa,
    setInterval, clearInterval, setTimeout, clearTimeout,
    document: { body, createElement: () => new Element() },
    navigator: { mediaDevices: { getUserMedia: async () => stream } },
    window: {
      AudioContext,
      confirm: runtime.confirm,
      localStorage: { getItem: () => JSON.stringify({ sourceLanguage: 'en', ...preferences }) },
      __ModuleLoader__: { load: ({ factory }) => factory(() => runtime.React ?? {}) },
    },
    async fetch(path, options) {
      const body = typeof options.body === 'string' ? JSON.parse(options.body)
        : options.body instanceof Blob ? Buffer.from(await options.body.arrayBuffer())
        : options.body ? Buffer.from(options.body) : undefined;
      const { status, data } = await call(path, options.method, body);
      return { status, ok: status < 400, json: async () => data };
    },
  };
  runInNewContext(source, sandbox);
  t.after(() => {
    sandbox.voice.engine.timers.forEach(clearInterval);
    clearTimeout(sandbox.voice.engine.noticeTimer);
  });
  return { ...sandbox.voice, body };
}

function waitFor(store, predicate) {
  if (predicate(store.get())) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = store.subscribe(() => {
      if (!predicate(store.get())) return;
      unsubscribe();
      resolve();
    });
  });
}

test('client archives the audio and raw text without model editing when a later segment fails', async (t) => {
  const { call, state, dataRoot } = await fixture(t);
  const { engine, store, begin, finish, ingestSamples, finalizeSegment } = await bootClient(t, call);
  await begin(null, undefined, false, 'studio');
  engine.capture.recorder.ondataavailable({ data: new Blob(['head']) });
  ingestSamples(new Float32Array(16000), engine.generation);
  finalizeSegment(engine.generation, engine.run);
  await engine.finalChain;
  state.fail = true;
  ingestSamples(new Float32Array(16000), engine.generation);
  await finish('stop');
  assert.equal(store.get().phase, 'result');
  assert.equal(store.get().pendingSegments, 1);
  assert.equal(state.modelCalls, 0);
  const archive = createRecordingStore(join(dataRoot, 'recordings'));
  const [saved] = await archive.list();
  assert.equal(saved.status, 'complete');
  assert.equal(saved.text, 'Raw model output');
  assert.equal(saved.segments[1].state, 'failed');
  assert.equal(saved.size, 8);
});

test('the recorder confirms a durable archive while transcription is still in flight', { timeout: 3000 }, async (t) => {
  const { call, state } = await fixture(t);
  const { engine, store, body, begin, ingestSamples, mountRecordingIndicator } = await bootClient(t, call);
  t.after(mountRecordingIndicator(() => {}));
  await begin(null, undefined, false, 'studio');
  const [banner] = body.children;
  const [, label, , stop] = banner.children;
  assert.equal(banner.hidden, false);
  assert.equal(label.textContent, '录音中');
  const speech = Promise.withResolvers();
  state.wait = speech.promise;
  t.after(speech.resolve);
  ingestSamples(new Float32Array(16000), engine.generation);
  stop.dispatchEvent(new Event('click'));
  await waitFor(store, (s) => s.archiveStage === 'saved');
  assert.equal(store.get().phase, 'finishing');
  assert.equal(store.get().transcribingSegments, 1);
  assert.equal(stop.hidden, true);
  assert.equal(label.textContent, '录音已保存 · 1 段正在转写');
  speech.resolve();
  await waitFor(store, (s) => s.phase === 'result');
  assert.equal(label.textContent, '录音已保存');
});

test('the dictation shortcut starts local-only capture and can stop after switching conversations', { timeout: 3000 }, async (t) => {
  const { call, dataRoot, state } = await fixture(t);
  const { engine, store, ingestSamples, handleDictationShortcut, segmentAtTime } =
    await bootClient(t, call, { dictationHistory: false, shortcut: 'KeyY' });
  const inserted = [];
  const composer = (sessionId) => ({
    sessionId,
    inputActions: {
      captureInsertion: () => ({ caret: 0 }),
      insertText: (text) => { inserted.push([sessionId, text]); return true; },
    },
  });
  let consumed = 0;
  const shortcut = { code: 'KeyY', ctrlKey: true, shiftKey: true, preventDefault: () => { consumed += 1; } };
  engine.activeComposer = composer('original');
  handleDictationShortcut(shortcut);
  await waitFor(store, (s) => s.phase === 'recording');
  assert.equal(engine.capture.recorder, undefined);
  ingestSamples(new Float32Array(16000), engine.generation);
  engine.activeComposer = composer('other');
  handleDictationShortcut(shortcut);
  await waitFor(store, (s) => s.phase === 'result');
  assert.equal(consumed, 2);
  assert.deepEqual(inserted, []);
  assert.equal(store.get().result.text, 'Raw model output');
  assert.equal(state.modelCalls, 0);
  const archive = createRecordingStore(join(dataRoot, 'recordings'));
  assert.deepEqual(await archive.list(), []);
  const parts = [{ start: 0, end: 1, sequence: 0 }, { start: 1, end: 2, sequence: 1 }];
  assert.equal(segmentAtTime(parts, 0.5), 0);
  assert.equal(segmentAtTime(parts, 1), 1);
  assert.equal(segmentAtTime(parts, 2), null);

  engine.activeComposer = composer('original');
  handleDictationShortcut(shortcut);
  await waitFor(store, (s) => s.phase === 'recording');
  ingestSamples(new Float32Array(16000), engine.generation);
  handleDictationShortcut(shortcut);
  await waitFor(store, (s) => s.phase === 'idle');
  assert.deepEqual(inserted, [['original', 'Raw model output']]);
  assert.equal(store.get().savedNotice, '已插入草稿');
});

test('segment corrections remain separate from original text and are searchable and exportable', async (t) => {
  const { call, dataRoot } = await fixture(t);
  const archive = `${API}/recordings`;
  const { data: { recording } } = await call(`${archive}/live`, 'POST', { language: 'en' });
  const path = `${archive}/${recording.id}`;
  assert.equal((await call(`${path}/segments/0?start=0&end=1`, 'PUT', wave())).status, 200);
  assert.equal((await call(`${path}/segments/0/retry?live=1`, 'POST')).status, 200);
  assert.equal((await call(`${path}/segments/0`, 'PATCH', { correction: 'Mariana Trench' })).status, 409);
  await call(path, 'PATCH', { status: 'complete' });
  const { data } = await call(`${path}/segments/0`, 'PATCH', { correction: 'Mariana Trench' });
  assert.equal(data.recording.text, 'Raw model output');
  assert.equal(data.recording.segments[0].text, 'Raw model output');
  assert.equal(data.recording.correctedText, 'Mariana Trench');
  const matches = await call(`${archive}?q=Mariana&limit=25`);
  assert.equal(matches.data.recordings[0].matchingSegments, 1);
  const original = await call(`${path}/transcript?variant=original`);
  assert.equal(original.data.toString(), 'Raw model output');
  assert.match(original.headers['content-disposition'], /attachment.*original\.txt/);
  const corrected = await call(`${path}/transcript?variant=corrected`);
  assert.equal(corrected.data.toString(), 'Mariana Trench');
  assert.equal((await call(`${path}/segments/0`, 'PATCH', { correction: null })).data.recording.hasCorrections, false);

  const store = createRecordingStore(join(dataRoot, 'recordings'));
  const legacy = await store.save({ text: 'Legacy transcript' });
  const legacyPath = `${archive}/${legacy.id}`;
  const edited = await call(legacyPath, 'PATCH', { correction: 'Legacy correction' });
  assert.equal(edited.data.recording.text, 'Legacy transcript');
  assert.equal(edited.data.recording.correctedText, 'Legacy correction');
});

test('every voice endpoint requires the signed desktop browser session and rejects forwarded or cross-site requests', async (t) => {
  const { call, model, state, registerHost, routes } = await fixture(t);
  const records = `${API}/recordings`;
  const { data: { recording } } = await call(`${records}/live`, 'POST', {});
  const path = `${records}/${recording.id}`;
  await call(`${path}/chunks/0?duration=1`, 'PUT', Buffer.from('fixture audio'));
  const targets = [
    ['/status', 'GET'],
    ['/open-state', 'GET'],
    ['/open', 'POST'],
    ['/update', 'GET'],
    ['/meeting-models', 'GET'],
    ['/meeting-models', 'POST'],
    ['/meeting-models', 'PUT', wave()],
    [`/recordings/${recording.id}/meeting`, 'POST', wave()],
    [`/recordings/${recording.id}/meeting`, 'PATCH', {}],
    ['/update', 'POST', { version: '0.0.3' }],
    ['/prepare', 'POST', {}],
    ['/cancel', 'POST', {}],
    ['/translate', 'POST', { text: 'fixture', target: 'zh', model }],
    ['/normalize', 'POST', {}],
    ['/report', 'POST', {}],
    [`/recordings/${recording.id}/check`, 'GET'],
    [`/recordings/${recording.id}/check`, 'POST', {}],
    [`/recordings/${recording.id}/check`, 'PATCH', {}],
    ['/transcribe', 'POST', {}],
    ['/recordings', 'GET'],
    ['/recordings', 'POST', { text: 'fixture' }],
    ['/recordings/live', 'POST', {}],
    [`/recordings/${recording.id}`, 'PATCH', { title: 'fixture' }],
    [`/recordings/${recording.id}`, 'DELETE'],
    [`/recordings/${recording.id}/audio`, 'GET'],
    [`/recordings/${recording.id}/transcript`, 'GET'],
    [`/recordings/${recording.id}/segments/0/retry`, 'POST'],
  ];
  for (const [route, method, body] of targets) {
    assert.equal((await call(API + route, method, body, { cookie: undefined })).status, 401, route);
    assert.equal((await call(API + route, method, body, { 'x-forwarded-for': '192.0.2.5' })).status, 403, route);
    assert.equal((await call(API + route, method, body, { origin: 'https://example.invalid' })).status, 403, route);
    assert.equal((await call(API + route, method, body, {}, '192.0.2.5')).status, 403, route);
  }
  assert.equal((await call(records, 'GET', undefined, { host: 'example.invalid' })).status, 403);
  assert.equal((await call(records, 'GET', undefined, { 'sec-fetch-site': 'same-site' })).status, 403);
  assert.equal((await call(records, 'GET', undefined, { cookie: undefined, authorization: 'fixture-api' })).status, 403);
  assert.equal((await call(records, 'POST', { text: 'fixture' }, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await call(`${path}/chunks/1`, 'PUT', Buffer.from('fixture'), { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await call(`${path}/audio`)).headers['cache-control'], 'private, no-store');
  assert.equal((await call(`${path}/audio`)).data.toString(), 'fixture audio');
  assert.equal(state.modelCalls, 0);
  await registerHost('web');
  assert.equal(routes.length, 0);
});

test('model work requires a confirmed model and rejects a fourth concurrent request', { timeout: 3000 }, async (t) => {
  const { call, model, state } = await fixture(t);
  const url = `${API}/translate`;
  const source = { text: 'fixture text', target: 'zh' };
  assert.equal((await call(url, 'POST', source)).status, 400);
  const gate = Promise.withResolvers();
  state.waitModel = gate.promise;
  t.after(gate.resolve);
  const running = Array.from({ length: 3 }, () => call(url, 'POST', { ...source, model }));
  while (state.modelCalls !== 3) await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await call(url, 'POST', { ...source, model })).status, 429);
  gate.resolve();
  assert.deepEqual((await Promise.all(running)).map((response) => response.status), [200, 200, 200]);
});

test('private defaults do not carry legacy model consent into new dictation', async (t) => {
  const { call } = await fixture(t);
  const { store } = await bootClient(t, call, { targetLanguage: 'zh', editMode: true, reportMode: true });
  assert.equal(store.get().dictationHistory, false);
  assert.equal(store.get().translate, false);
  assert.equal(store.get().editMode, false);
  assert.equal(store.get().reportMode, false);
});

test('startup migrates POSIX file permissions and refuses symbolic links', { skip: process.platform === 'win32' }, async (t) => {
  const { call, dataRoot, registerHost } = await fixture(t);
  const root = join(dataRoot, 'recordings');
  const store = createRecordingStore(root);
  const original = await store.save({ text: 'fixture', audio: Buffer.alloc(64), mimeType: 'audio/webm' });
  const metadata = join(root, original.id + '.json');
  const audio = join(root, original.audioFile);
  await chmod(root, 0o755);
  await chmod(metadata, 0o644);
  await chmod(audio, 0o644);
  await registerHost();
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  for (const path of [metadata, audio]) assert.equal((await stat(path)).mode & 0o777, 0o600);
  const outside = join(dataRoot, 'not-recorded.txt');
  await writeFile(outside, 'fixture outside recording directory', { mode: 0o644 });
  await rm(audio);
  await symlink(outside, audio);
  await registerHost();
  assert.equal((await call(`${API}/recordings/${original.id}/audio`)).status, 404);
  assert.equal((await stat(outside)).mode & 0o777, 0o644);
});

test('archive playback refuses a file linked to data outside the archive', async (t) => {
  const { call, dataRoot } = await fixture(t);
  const store = createRecordingStore(join(dataRoot, 'recordings'));
  const original = await store.save({ audio: Buffer.alloc(64), mimeType: 'audio/webm' });
  const saved = join(dataRoot, 'recordings', original.audioFile);
  const outside = join(dataRoot, 'outside.txt');
  await writeFile(outside, 'outside the archive');
  await rm(saved);
  await link(outside, saved);
  assert.equal((await call(`${API}/recordings/${original.id}/audio`)).status, 404);
  assert.equal(await readFile(outside, 'utf8'), 'outside the archive');
});

test('file import persists audio and timestamps and re-transcription keeps the earlier corrected entry', async (t) => {
  const { call, dataRoot, state } = await fixture(t);
  const { store, importAudio, importedMime } = await bootClient(t, call);
  const audio = new Blob(['fixture audio bytes'], { type: 'audio/flac' });
  const mimeType = importedMime({ name: 'Sample.FLAC' });
  assert.equal(mimeType, 'audio/flac');
  assert.equal(importedMime({ name: 'Sample.exe' }), null);
  const id = await importAudio(() => audio, { title: 'Imported test', mimeType, language: 'en', source: 'import' });
  const path = `${API}/recordings/${id}`;
  const { data } = await call(path);
  assert.equal(data.recording.status, 'complete');
  assert.equal(data.recording.title, 'Imported test');
  assert.deepEqual(data.recording.segments.map(({ start, end }) => [start, end]), [[0, 28], [28, 30]]);
  assert.equal((await call(`${path}/audio`)).data.toString(), 'fixture audio bytes');
  assert.equal((await call(`${path}/audio`)).headers['content-type'], 'audio/flac');
  await call(`${path}/segments/0`, 'PATCH', { correction: 'Earlier corrected text' });
  state.speechText = 'New transcript';
  const newId = await importAudio(() => audio, {
    title: 'Imported test (new transcription)', mimeType, language: 'zh', source: 'retranscription',
  });
  assert.notEqual(newId, id);
  const archives = await createRecordingStore(join(dataRoot, 'recordings')).list();
  assert.equal(archives.length, 2);
  const earlier = archives.find((item) => item.id === id);
  const newer = archives.find((item) => item.id === newId);
  assert.equal(earlier.segments[0].correction, 'Earlier corrected text');
  assert.equal(newer.segments[0].text, 'New transcript');
  assert.deepEqual(state.speechCalls, ['en', 'en', 'zh', 'zh']);
  assert.equal(state.modelCalls, 0);
  assert.equal(store.get().importError, '');
});

test('reports honor the selected output language without a standalone model question route', async (t) => {
  const { call, model, state } = await fixture(t);
  const report = await call(`${API}/report`, 'POST', { text: 'Fixture', language: 'ja', model });
  assert.equal(report.status, 200);
  assert.equal(report.data.language, '日本語');
  assert.match(state.lastModelInput, /日本語/);
  const { data: { recording } } = await call(`${API}/recordings/live`, 'POST', {});
  assert.equal((await call(`${API}/recordings/${recording.id}/ask`, 'POST', {
    question: 'Fixture question', model,
  })).status, 404);
  assert.equal(state.modelCalls, 1);
});

test('transcript sharing creates a separate unsent draft and never overwrites an existing draft', async (t) => {
  const { call, state } = await fixture(t);
  const { openTranscriptDraft } = await bootClient(t, call);
  const events = [];
  const binding = {};
  let draft = 'Earlier draft';
  const services = {
    sessions: {
      list: { getSnapshot: () => ({ byId: { active: { updatedAt: 400 } } }) },
      async create(options) {
        assert.equal(options.workspaceId, 'recent-workspace');
        assert.equal(options.sessionId, undefined);
        events.push('create');
        return 'fresh-session';
      },
      async using(id, options, work) {
        assert.equal(id, 'fresh-session');
        assert.equal(options.source, 'controllerOperation');
        await work({ binding });
      },
    },
    conversation: { input: { requestDraftInitialization(target, options) {
      assert.equal(target, binding);
      assert.equal(options.whenDraftExists, 'keep');
      if (draft) return 'preserved';
      draft = options.prompt;
      events.push('draft');
      return 'applied';
    } } },
    workspace: { openSession(id) {
      assert.equal(id, 'fresh-session');
      events.push('open');
    } },
    workspaces: { list: { getSnapshot: () => ({ phase: 'ready', items: [
      { workspaceId: 'older-workspace', createdAt: new Date(200).toISOString(), sessionIds: [] },
      { workspaceId: 'recent-workspace', createdAt: new Date(100).toISOString(), sessionIds: ['active'] },
    ] }) } },
  };
  const tKey = (key, vars) => vars?.title ? `${key} ${vars.title}` : key;
  const noWorkspace = { ...services, workspaces: { list: { getSnapshot: () => ({ phase: 'ready', items: [] }) } } };
  await assert.rejects(openTranscriptDraft(noWorkspace, { text: 'Selected line' }, tKey), /share.workspaceRequired/);
  assert.deepEqual(events, []);
  await assert.rejects(openTranscriptDraft(services, { text: 'Selected line', title: 'Fixture title', excerpt: true }, tKey));
  assert.equal(draft, 'Earlier draft');
  assert.deepEqual(events, ['create']);
  draft = '';
  await openTranscriptDraft(services, { text: 'Selected line', title: 'Fixture title', excerpt: true }, tKey);
  assert.deepEqual(events, ['create', 'create', 'draft', 'open']);
  assert.match(draft, /Selected line/);
  assert.match(draft, /share.selectedIntro/);
  assert.equal(state.modelCalls, 0);
  draft = '';
  await openTranscriptDraft(services, { text: 'Full transcript', title: 'Fixture title' }, tKey);
  assert.match(draft, /Full transcript/);
  assert.match(draft, /share.intro/);
});

test('the selection toolbar reads only selected transcript text inside the expanded card', async (t) => {
  const { call } = await fixture(t);
  const { readTranscriptSelection } = await bootClient(t, call);
  const region = {};
  const inside = { nodeType: 3, parentElement: { closest: () => region } };
  const outside = { nodeType: 3 };
  const root = {
    contains: (node) => node === inside || node === region,
    getBoundingClientRect: () => ({ top: 10, bottom: 100 }),
  };
  const selection = {
    anchorNode: inside, focusNode: inside, rangeCount: 1, isCollapsed: false,
    getRangeAt: () => ({ getBoundingClientRect: () => ({ left: 10, right: 20, top: 40, bottom: 50 }) }),
    toString: () => '  Partial transcript  ',
  };
  assert.equal(readTranscriptSelection(root, selection).text, 'Partial transcript');
  region.dataset = { meetingPrefix: '[0:23] Speaker 2: ' };
  assert.equal(readTranscriptSelection(root, selection).text, '[0:23] Speaker 2: Partial transcript');
  assert.equal(readTranscriptSelection(root, { ...selection, focusNode: outside }), null);
  assert.equal(readTranscriptSelection(root, { ...selection, isCollapsed: true }), null);
});


test('speaker boundaries preserve crosstalk, separate silence, and bound transcription input', () => {
  const plan = planTurns([
    { start: 39, end: 60, speaker: 8 },
    { start: 0, end: 3, speaker: 9 },
    { start: 2, end: 8, speaker: 8 },
    { start: 9, end: 69, speaker: 8 },
  ], 68 * PCM_RATE);
  assert.deepEqual(plan.speakers, [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(plan.turns.slice(0, 3).map((part) => [
    part.startFrame / PCM_RATE, part.endFrame / PCM_RATE, part.speakerId, part.overlap,
  ]), [[0, 2, 1, false], [2, 3, null, true], [3, 8, 2, false]]);
  assert.equal(plan.turns[3].startFrame, 9 * PCM_RATE);
  assert.equal(plan.turns.at(-1).endFrame, 68 * PCM_RATE);
  assert.ok(plan.turns.every((part) => part.endFrame - part.startFrame <= 28 * PCM_RATE));
});

test('speaker edits and failed replacements preserve the original recording and invalidate stale reports', async (t) => {
  const { call, dataRoot } = await fixture(t);
  const store = createRecordingStore(join(dataRoot, 'recordings'));
  const original = await store.save({ text: 'Original transcript', audio: wave(), duration: 1, mimeType: 'audio/wav' });
  const path = `${API}/recordings/${original.id}`;
  const meeting = `${path}/meeting`;
  await store.saveMeeting(original.id, {
    revision: 1, speakers: [{ id: 1 }, { id: 2 }],
    turns: [{ id: 1, start: 0.15, end: 0.95, speakerId: null, overlap: true, text: 'Raw speaker text' }],
  });
  assert.equal((await call(meeting, 'PATCH', { revision: 1, kind: 'turn', turnId: 1, speakerId: 3 })).status, 404);
  const rename = await call(meeting, 'PATCH', { revision: 1, kind: 'speaker', speakerId: 2, name: 'Reviewer' });
  assert.equal(rename.data.recording.meeting.revision, 2);
  assert.equal((await call(meeting, 'PATCH', { revision: 1, kind: 'turn', turnId: 1, speakerId: 2 })).status, 409);
  await call(path, 'PATCH', { report: 'Report at revision 2', meetingRevision: 2 });
  const edited = await call(meeting, 'PATCH', {
    revision: 2, kind: 'turn', turnId: 1, speakerId: 2, correction: 'Reviewed content',
  });
  assert.equal(edited.data.recording.meetingReportStale, true);
  assert.equal(edited.data.recording.meeting.turns[0].text, 'Raw speaker text');
  assert.equal(edited.data.recording.text, 'Original transcript');
  assert.equal((await call(`${path}/transcript?variant=meeting&locale=en`)).data.toString(),
    '[00:00:00] Reviewer: Reviewed content');
  const list = await call(`${API}/recordings?limit=10&q=Reviewed+content`);
  assert.equal(list.data.recordings[0].hasMeeting, true);
  assert.equal(list.data.recordings[0].meeting, undefined);
  const failed = await call(meeting + '?frames=16000&speakers=2&revision=3', 'POST', Buffer.alloc(8));
  assert.equal(failed.status, 400);
  assert.equal((await call(path)).data.recording.meeting.revision, 3);
  assert.equal((await call(`${path}/transcript`)).data.toString(), 'Original transcript');
  assert.equal((await call(path + '/audio')).data.length, wave().length);
});


test('multispeaker import sends bounded PCM only after the original audio is saved', async (t) => {
  const { call } = await fixture(t);
  const processing = [];
  const { store, importAudio } = await bootClient(t, async (url, method, body) => {
    if (url === `${API}/meeting-models`) {
      assert.equal(method ?? 'GET', 'GET');
      return { status: 200, data: { supported: true, ready: true } };
    }
    if (url.includes('/meeting?')) {
      assert.equal(method, 'POST');
      const endpoint = new URL(url, 'http://localhost');
      assert.equal(endpoint.searchParams.get('speakers'), '2');
      assert.equal(endpoint.searchParams.get('frames'), '480000');
      assert.equal(body.length, 960000);
      const path = endpoint.pathname.slice(0, -'/meeting'.length);
      const { data } = await call(path);
      assert.equal(data.recording.status, 'complete');
      assert.equal((await call(path + '/audio')).data.toString(), 'original bytes');
      processing.push(data.recording.id);
      return { status: 201, data };
    }
    return call(url, method, body);
  });

  const id = await importAudio(() => new Blob(['original bytes']), {
    title: 'Meeting fixture', mimeType: 'audio/wav', language: 'en', source: 'import', meetingSpeakers: 2,
  });
  await waitFor(store, ({ meetingJob }) => !!meetingJob && !meetingJob.active);
  assert.equal(store.get().meetingJob.phase, 'ready');
  assert.deepEqual(processing, [id]);
});


test('meeting check requires model confirmation, validates coverage and recomputes retained text', async (t) => {
  const { call, state, dataRoot, model } = await fixture(t);
  const store = createRecordingStore(join(dataRoot, 'recordings'));
  const text = '本次会议确认接口的部署时间和联调安排，测试负责人需要准备相应的案例。'.repeat(12);
  const meta = await store.save({ text, mimeType: 'audio/wav', audio: wave(), duration: 1 });
  const path = `${API}/recordings/${meta.id}/check`;
  const preview = await call(path);
  const { hash, units } = preview.data.source;
  assert.equal(preview.data.check, null);
  assert.equal(state.modelCalls, 0);
  const input = { sourceHash: hash, topic: '', language: 'zh' };
  assert.equal((await call(path, 'POST', input)).status, 400);
  assert.equal(state.modelCalls, 0);
  state.checkResult = () => '[]';
  assert.equal((await call(path, 'POST', { ...input, model })).status, 502);
  assert.equal((await call(path)).data.check, null);
  state.checkResult = (options) => JSON.stringify(JSON.parse(options.messages[0].content[0].text).classify
    .map((id) => ({ id, category: id === 1 ? 'repeat' : 'keep', reason: 'Synthetic explanation' })));
  const generated = await call(path, 'POST', { ...input, model });
  assert.equal(generated.status, 201);
  const result = generated.data.check;
  assert.equal(result.units[0].text, units[0].text);
  assert.ok(result.percent > 0);
  assert.equal(result.total, preview.data.source.chars);
  const patched = await call(path, 'PATCH', { analysisId: result.id, unitId: 1, retained: true });
  assert.equal(patched.data.check.percent, 0);
  assert.equal(patched.data.check.compact, text);
  assert.equal(state.modelCalls, 2, 'retaining a unit is local');
  state.checkResult = () => '[]';
  assert.equal((await call(path, 'POST', { ...input, model, analysisId: result.id, revision: patched.data.check.revision })).status, 502);
  assert.equal((await call(path)).data.check.id, result.id);
  assert.equal((await call(path)).data.check.units[0].retained, true);
  assert.equal((await call(`${API}/recordings?limit=10`)).data.recordings[0].check, undefined);
  await call(`${API}/recordings/${meta.id}`, 'PATCH', { correction: text + '更新后的结论。' });
  assert.equal((await call(path)).data.check.stale, true);
  assert.equal((await call(path)).data.check.percent, null);
  assert.equal((await call(path, 'PATCH', { analysisId: result.id, unitId: 1, retained: false })).status, 409);
  assert.equal((await call(path, 'POST', { ...input, model })).status, 409);
  assert.equal((await store.get(meta.id)).text, text);
});

test('meeting check never calls a model for short or pending transcripts', async (t) => {
  const { call, dataRoot, state, model } = await fixture(t);
  const store = createRecordingStore(join(dataRoot, 'recordings'));
  const short = await store.save({ text: 'Too short.' });
  const body = { sourceHash: checkSource(short).hash, topic: '', language: 'en', model };
  const result = await call(`${API}/recordings/${short.id}/check`, 'POST', body);
  assert.equal(result.status, 422);
  assert.equal(result.data.error.code, 'short');
  const { data: { recording } } = await call(`${API}/recordings/live`, 'POST', { language: 'en', mimeType: 'audio/webm' });
  const pending = await call(`${API}/recordings/${recording.id}/check`, 'POST', body);
  assert.equal(pending.status, 422);
  assert.equal(pending.data.error.code, 'pending');
  assert.equal(state.modelCalls, 0);
});

test('an in-flight analysis cannot overwrite changed source text or manual decisions', { timeout: 3000 }, async (t) => {
  const { call, dataRoot, state, model } = await fixture(t);
  const store = createRecordingStore(join(dataRoot, 'recordings'));
  const meta = await store.save({ text: '会议安排与测试确认。'.repeat(30) });
  const source = checkSource(meta);
  const path = `${API}/recordings/${meta.id}/check`;
  const input = { sourceHash: source.hash, topic: '', language: 'zh', model };
  state.checkResult = (options) => JSON.stringify(JSON.parse(options.messages[0].content[0].text).classify
    .map((id) => ({ id, category: 'repeat', reason: '合成测试：相同内容重复。' })));
  const original = (await call(path, 'POST', input)).data.check;
  const gate = Promise.withResolvers();
  state.waitModel = gate.promise;
  t.after(gate.resolve);
  const running = call(path, 'POST', { ...input, analysisId: original.id, revision: 0 });
  while (state.modelCalls !== 2) await new Promise((resolve) => setImmediate(resolve));
  await call(path, 'PATCH', { analysisId: original.id, unitId: 1, retained: true });
  gate.resolve();
  assert.equal((await running).status, 409);
  let saved = (await call(path)).data.check;
  assert.equal(saved.id, original.id);
  assert.equal(saved.units[0].retained, true);
  const sourceGate = Promise.withResolvers();
  state.waitModel = sourceGate.promise;
  t.after(sourceGate.resolve);
  const stale = call(path, 'POST', { ...input, analysisId: saved.id, revision: saved.revision });
  while (state.modelCalls !== 3) await new Promise((resolve) => setImmediate(resolve));
  await call(`${API}/recordings/${meta.id}`, 'PATCH', { correction: meta.text + '新增结论。' });
  sourceGate.resolve();
  assert.equal((await stale).status, 409);
  saved = (await call(path)).data.check;
  assert.equal(saved.id, original.id);
  assert.equal(saved.stale, true);
  assert.equal(saved.percent, null);
});


test('closing an active analysis aborts its model signal and preserves the saved result', { timeout: 3000 }, async (t) => {
  const { call, state, dataRoot, model } = await fixture(t);
  const meta = await createRecordingStore(join(dataRoot, 'recordings')).save({ text: '会议安排与测试确认。'.repeat(30) });
  const input = { sourceHash: checkSource(meta).hash, topic: '', language: 'zh', model };
  const path = `${API}/recordings/${meta.id}/check`;
  state.checkResult = (options) => JSON.stringify(JSON.parse(options.messages[0].content[0].text).classify
    .map((id) => ({ id, category: 'keep', reason: '合成测试。' })));
  const saved = (await call(path, 'POST', input)).data.check;
  const gate = Promise.withResolvers();
  state.waitModel = gate.promise;
  t.after(gate.resolve);
  const running = call(path, 'POST', { ...input, analysisId: saved.id, revision: saved.revision });
  while (state.modelCalls !== 2) await new Promise((resolve) => setImmediate(resolve));
  state.checkResponse.emit('close');
  assert.equal(state.modelSignal.aborted, true);
  gate.resolve();
  assert.ok((await running).status >= 400);
  assert.equal((await call(path)).data.check.id, saved.id);
});

test('the dial handles zero, maximum and unavailable scores, and consent cancellation sends no transcript', async (t) => {
  const { call, state, dataRoot } = await fixture(t);
  const saved = await createRecordingStore(join(dataRoot, 'recordings')).save({ text: '会议安排与测试确认。'.repeat(80) });
  const slots = [], effects = [];
  let index = 0, approved = false;
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }),
    useState(initial) {
      const slot = index++;
      if (!(slot in slots)) slots[slot] = initial;
      return [slots[slot], (value) => { slots[slot] = typeof value === 'function' ? value(slots[slot]) : value; }];
    },
    useRef: (value) => ({ current: value }),
    useEffect: (effect) => effects.push(effect),
  };
  const voice = await bootClient(t, call, {}, { React, confirm: () => approved });
  const tLabel = voice.translate;
  const nodes = (node) => !node || typeof node !== 'object' ? []
    : [node, ...node.children.flatMap(nodes)];
  for (const percent of [0, 100, null]) {
    const tree = voice.CheckGauge({ percent, t: tLabel, state: 'waiting' });
    const needle = nodes(tree).find((node) => node.type === 'line');
    assert.equal(Boolean(needle), percent !== null);
    if (needle) assert.ok(Number.isFinite(needle.props.x2) && Number.isFinite(needle.props.y2));
  }
  const render = () => {
    index = 0;
    return voice.MeetingCheck({ id: saved.id, t: tLabel, seek() {}, onChanged() {} });
  };
  render();
  const cleanup = effects.shift()();
  await new Promise((resolve) => setTimeout(resolve, 20));
  let tree = render();
  const generate = nodes(tree).find((node) => node.type === 'button' && node.children.includes('开始分析'));
  assert.equal(generate.props.disabled, false);
  await generate.props.onClick();
  assert.equal(state.modelCalls, 0);
  assert.equal(voice.store.get().checkJobs, 0);
  cleanup();
});
