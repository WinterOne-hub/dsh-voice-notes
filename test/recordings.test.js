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
            state.lastModelSystem = options.system;
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
    const route = routes.find((r) => r.kind === 'exact' && r.path === pathname)
      ?? routes.filter((r) => r.kind === 'prefix' && (r.path === pathname || pathname.startsWith(r.path + '/')))
        .sort((a, b) => b.path.length - a.path.length)[0];
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
    if (path.endsWith('/interpretation') && method === 'POST') state.interpretationResponse = res;
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
    '    globalThis.voice = { store, engine, begin, finish, finalizeSegment, ingestSamples, sendPartial, handleDictationShortcut, mountRecordingIndicator, mountDesktopCaptions, segmentAtTime, importAudio, importedMime, openTranscriptDraft, readTranscriptSelection, CheckGauge, MeetingCheck, MeetingInterpretation, translate };\n' + registration);
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
      return runtime.decodedAudio ?? {
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
    AbortController, AbortSignal, Blob, DataView, Range: { START_TO_START: 0, END_TO_END: 2 }, MediaRecorder, OfflineAudioContext, URLSearchParams, btoa, crypto,
    setInterval: runtime.setInterval ?? setInterval, clearInterval: runtime.clearInterval ?? clearInterval,
    setTimeout, clearTimeout, queueMicrotask, Date: runtime.Date ?? Date, performance: runtime.performance ?? performance,
    document: { body, createElement: () => new Element() },
    navigator: { mediaDevices: { getUserMedia: async () => { if (runtime.forbidMicrophone) throw new Error('Microphone must remain off'); return runtime.microphone ?? stream; } } },
    window: {
      AudioContext: runtime.AudioContext ?? AudioContext,
      confirm: runtime.confirm,
      localStorage: { getItem: () => JSON.stringify({ sourceLanguage: 'en', ...preferences }) },
      __ModuleLoader__: { load: ({ factory }) => factory(() => runtime.React ?? {}) },
    },
    async fetch(path, options = {}) {
      const custom = await runtime.fetch?.(path, options);
      if (custom) return custom;
      const body = typeof options.body === 'string' ? JSON.parse(options.body)
        : options.body instanceof Blob ? Buffer.from(await options.body.arrayBuffer())
        : options.body ? Buffer.from(options.body) : undefined;
      const { status, data } = await call(path, options.method, body);
      return { status, ok: status < 400, json: async () => data };
    },
  };
  runInNewContext(source, sandbox);
  t.after(() => {
    sandbox.voice.engine.timers.forEach(sandbox.clearInterval);
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

test('desktop captions show finished sentences in order and close when recording ends', { timeout: 5500 }, async (t) => {
  const { call } = await fixture(t);
  const opened = Promise.withResolvers();
  const closed = Promise.withResolvers();
  const replies = [];
  const displayed = Array.from({ length: 3 }, () => Promise.withResolvers());
  const { store, mountDesktopCaptions } = await bootClient(t, call, {}, {
    fetch(path, options) {
      assert.equal(path, API + '/desktop-captions');
      const input = JSON.parse(options.body);
      if (options.method === 'POST') {
        opened.resolve(input);
        return { ok: true, body: new ReadableStream({
          start(stream) { options.signal.addEventListener('abort', () => { stream.close(); closed.resolve(); }); },
        }) };
      }
      assert.equal(options.method, 'PATCH');
      replies.push({ ...input, at: performance.now() });
      displayed[replies.length - 1]?.resolve();
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });
  t.after(mountDesktopCaptions());
  assert.equal(store.get().captionMode, 'off');
  store.set({ phase: 'recording', captionMode: 'original', partialText: '临时字幕。' });
  const first = await opened.promise;
  assert.match(first.text, /等待完整字幕/);
  store.set({ captionOriginal: { text: '第一句。第二句！最后', paused: false } });
  await displayed[0].promise;
  assert.equal(replies[0].text, '第一句。');
  store.set({ partialText: '正在改写的字幕！', captionOriginal: { text: '一句', paused: true } });
  await displayed[1].promise;
  await displayed[2].promise;
  assert.deepEqual(replies.map(({ text }) => text), ['第一句。', '第二句！', '最后一句']);
  assert.ok(replies.every(({ id }) => id === first.id));
  assert.ok(replies[1].at - replies[0].at >= 1100);
  store.set({ phase: 'finishing' });
  await closed.promise;
  assert.equal(store.get().captionError, '');
});

test('quiet audio keeps recording while missing frames stop and preserve the archive', { timeout: 3000 }, async (t) => {
  const { call, dataRoot } = await fixture(t);
  let now = 0, tick;
  const { engine, store, begin, ingestSamples } = await bootClient(t, call, {}, {
    performance: { now: () => now },
    setInterval(fn) { tick = fn; return 1; },
    clearInterval() { tick = undefined; },
  });
  await begin(null, undefined, false, 'studio');
  const { id } = engine.run;
  const input = (signal) => ingestSamples(new Float32Array(3200).fill(signal), engine.generation);
  tick();
  assert.equal(store.get().captureSignal, 'waiting');
  input(0.1);
  tick();
  assert.equal(store.get().captureSignal, 'active');
  for (now = 2000; now <= 14_000; now += 2000) {
    input(0);
    tick();
    assert.equal(store.get().captureSignal, 'quiet');
    assert.equal(store.get().phase, 'recording');
  }
  now = 24_000;
  tick();
  await waitFor(store, (s) => s.phase === 'result');
  assert.match(store.get().captureWarning, /音频输入中断/);
  assert.equal(store.get().latency, null);
  const archive = createRecordingStore(join(dataRoot, 'recordings'));
  const saved = await archive.get(id);
  assert.equal(saved.status, 'interrupted');
  assert.ok(saved.size > 0);
  assert.equal(saved.text, 'Raw model output');
});

test('latency diagnostics summarize visible captions, final text and translation independently', { timeout: 3000 }, async (t) => {
  const { call, model, state, dataRoot } = await fixture(t);
  let now = 1000;
  const prefs = { targetLanguage: 'zh', modelPermission: JSON.stringify([model.provider, model.model]) };
  const { engine, store, begin, finish, ingestSamples, sendPartial, finalizeSegment } = await bootClient(t, call, prefs, {
    performance: { now: () => now },
  });
  assert.equal(store.get().measureLatency, false);
  store.set({ measureLatency: true });
  await begin(null, undefined, false, 'studio');
  const { run, generation } = engine;
  const input = new Float32Array(8000).fill(0.1);
  ingestSamples(input, generation);
  now = 1250;
  await sendPartial(generation);
  now = 1400;
  await sendPartial(generation);

  for (const [lastSound, final, translation] of [[1500, 2000, 2650], [3000, 3900, 4300]]) {
    now = lastSound;
    ingestSamples(input, generation);
    const speech = Promise.withResolvers();
    const modelReply = Promise.withResolvers();
    const modelCalls = state.modelCalls;
    state.wait = speech.promise;
    state.waitModel = modelReply.promise;
    t.after(() => { speech.resolve(); modelReply.resolve(); });
    finalizeSegment(generation, run);
    now = final;
    speech.resolve();
    await engine.finalChain;
    while (state.modelCalls === modelCalls) await new Promise((resolve) => setImmediate(resolve));
    now = translation;
    modelReply.resolve();
    await run.translateChain;
  }
  await finish('stop');
  assert.equal(JSON.stringify(store.get().latency), JSON.stringify({
    partial: { n: 1, p50: 250, p95: 250 },
    final: { n: 2, p50: 700, p95: 900 },
    translation: { n: 2, p50: 1225, p95: 1300 },
  }));
  const archive = createRecordingStore(join(dataRoot, 'recordings'));
  assert.equal((await archive.get(run.id)).latency, undefined);
  await begin(null, undefined, false, 'studio');
  assert.equal(store.get().latency, null);
  await finish('stop');
});

test('client archives the audio and raw text without model editing when a later segment fails', async (t) => {
  const { call, state, dataRoot } = await fixture(t);
  const { engine, store, begin, finish, ingestSamples, finalizeSegment } = await bootClient(t, call);
  store.set({ reportMode: true });
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
  assert.match(store.get().reportError, /补转/);
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
    ['/system-audio', 'GET'],
    ['/system-audio', 'POST', { confirmed: true, language: 'en' }],
    ['/system-audio/00000000-0000-0000-0000-000000000000', 'DELETE'],
    ['/system-audio/00000000-0000-0000-0000-000000000000/stream', 'GET'],
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
    [`/recordings/${recording.id}/interpretation`, 'GET'],
    [`/recordings/${recording.id}/interpretation?format=txt`, 'GET'],
    [`/recordings/${recording.id}/interpretation`, 'POST', {}],
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

test('the guide uses the selected interface language independently of audio language', async (t) => {
  const { call } = await fixture(t);
  const { store, translate } = await bootClient(t, call, { uiLanguage: 'en', sourceLanguage: 'zh' });
  assert.equal(translate('help.title'), 'How to use Voice Notes');
  assert.equal(store.get().sourceLanguage, 'zh');
  store.set({ uiLanguage: 'zh' });
  assert.equal(translate('help.title'), '使用说明');
  assert.equal(store.get().sourceLanguage, 'zh');
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
    title: 'Imported test (new transcription)', mimeType, language: 'zh', source: 'retranscription', reportKind: 'learning',
  });
  assert.notEqual(newId, id);
  const archives = await createRecordingStore(join(dataRoot, 'recordings')).list();
  assert.equal(archives.length, 2);
  const earlier = archives.find((item) => item.id === id);
  const newer = archives.find((item) => item.id === newId);
  assert.equal(earlier.segments[0].correction, 'Earlier corrected text');
  assert.equal(newer.segments[0].text, 'New transcript');
  assert.equal(newer.reportKind, 'learning');
  assert.deepEqual(state.speechCalls, ['en', 'en', 'zh', 'zh']);
  assert.equal(state.modelCalls, 0);
  assert.equal(store.get().importError, '');
});

test('lecture uses longer pauses and keeps the snapshot and report template from the start of recording', async (t) => {
  const { call } = await fixture(t);
  let now = 10_000, tick;
  const { store, engine, begin, ingestSamples, finish } = await bootClient(t, call, { recordingScene: 'lecture' }, {
    Date: class extends Date { static now() { return now; } },
    setInterval(fn) { tick = fn; return 1; },
    clearInterval() { tick = undefined; },
  });
  await begin(null, undefined, false, 'studio');
  const id = engine.run.id;
  assert.equal(engine.run.meetingSpeakers, undefined);
  const input = new Float32Array(8000).fill(0.1);
  ingestSamples(input, engine.generation);
  store.set({ recordingScene: 'meeting' });
  now += 1500;
  tick();
  assert.equal(engine.segment.id, 0);
  now += 750;
  tick();
  assert.equal(engine.segment.id, 1);
  await finish('stop');
  const { data } = await call(`${API}/recordings/${id}`);
  assert.equal(data.recording.recordingScene, 'lecture');
  assert.equal(data.recording.reportKind, 'lecture');
});

test('self-study skips digitally silent blocks while preserving audio and recording timestamps', async (t) => {
  const { call, state } = await fixture(t);
  const samples = new Float32Array(30 * PCM_RATE);
  samples.fill(0.1, 28 * PCM_RATE);
  const { importAudio } = await bootClient(t, call, {}, {
    decodedAudio: { duration: 30, sampleRate: PCM_RATE, length: samples.length,
      numberOfChannels: 1, getChannelData: () => samples },
  });
  const audio = new Blob(['study fixture'], { type: 'audio/wav' });
  const id = await importAudio(() => audio, { mimeType: audio.type, language: 'en',
    source: 'import', recordingScene: 'self-study', reportKind: 'learning' });
  const { data: { recording } } = await call(`${API}/recordings/${id}`);
  assert.equal(recording.recordingScene, 'self-study');
  assert.equal(recording.duration, 30);
  assert.deepEqual(recording.segments.map(({ start, end }) => [start, end]), [[28, 30]]);
  assert.equal((await call(`${API}/recordings/${id}/audio`)).data.toString(), 'study fixture');
  assert.deepEqual(state.speechCalls, ['en']);
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

test('analysis panels require consent; the dial and uncertain interpretations render correctly', async (t) => {
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
  for (const Component of [voice.MeetingCheck, voice.MeetingInterpretation]) {
    slots.length = 0; effects.length = 0;
    const render = () => {
      index = 0;
      return Component({ id: saved.id, t: tLabel, seek() {}, onChanged() {} });
    };
    render();
    const cleanup = effects.shift()();
    const deadline = Date.now() + 2000;
    while (!slots[0] && Date.now() < deadline) await new Promise((resolve) => setImmediate(resolve));
    let tree = render();
    let generate = nodes(tree).find((node) => node.type === 'button' && node.children.includes('开始分析'));
    assert.equal(generate.props.disabled, false);
    await generate.props.onClick();
    assert.equal(state.modelCalls, 0);
    assert.equal(voice.store.get().checkJobs, 0);
    if (Component === voice.MeetingInterpretation) {
      assert.ok(nodes(tree).some((node) => node.children.includes('表达解读（潜台词）')));
      approved = true;
      state.checkResult = () => interpretationFixture('uncertain');
      nodes(tree).find((node) => node.type === 'select').props.onChange({ target: { value: 'en' } });
      tree = render();
      generate = nodes(tree).find((node) => node.type === 'button' && node.children.includes('开始分析'));
      await generate.props.onClick();
      tree = render();
      assert.equal(state.modelCalls, 1);
      assert.match(state.lastModelSystem, /English/);
      assert.ok(nodes(tree).some((node) => node.children.includes('无法判断')));
      assert.ok(nodes(tree).some((node) => node.type === 'a' && node.props.href.includes('format=txt')));
      assert.equal(voice.store.get().checkJobs, 0);
    }
    cleanup();
  }
});

const interpretationFixture = (status = 'possible') => JSON.stringify({ items: [{
  unitIds: [1], status, literal: '明确提出了测试安排。',
  possible: status === 'uncertain' ? null : '可能希望先核实范围，再确定时间。',
  alternatives: ['也可能只是按字面说明测试安排。'], uncertainty: '缺少后续确认内容。', question: '需要先确认哪些测试事项？',
}] });

test('interpretation requires consent, preserves quotes and other reports, and exports locally', async (t) => {
  const { call, dataRoot, model, state } = await fixture(t);
  const store = createRecordingStore(join(dataRoot, 'recordings'));
  const meta = await store.save({ text: '本次会议确认接口的部署时间和联调安排，测试负责人需要准备相应的案例。'.repeat(12), report: 'Existing factual notes' });
  const path = `${API}/recordings/${meta.id}/interpretation`;
  const preview = await call(path);
  assert.equal(preview.data.report, null);
  assert.equal(state.modelCalls, 0);
  const input = { sourceHash: preview.data.source.hash, topic: '', language: 'en' };
  assert.equal((await call(path, 'POST', input)).status, 400);
  assert.equal((await call(path, 'POST', { ...input, model: { provider: 'other', model: model.model } })).status, 409);
  assert.equal(state.modelCalls, 0);
  state.checkResult = () => interpretationFixture();
  const generated = await call(path, 'POST', { ...input, model });
  assert.equal(generated.status, 201);
  const report = generated.data.report;
  assert.equal(report.items[0].quote, preview.data.source.units[0].text);
  assert.equal(report.language, 'en');
  assert.match(state.lastModelSystem, /English/);
  const exported = await call(path + '?format=txt&locale=en');
  assert.equal(exported.status, 200);
  assert.match(exported.data.toString(), /Possible meaning \(inference\)/);
  assert.match(exported.data.toString(), /not verified intent or facts/);
  assert.equal(exported.headers['cache-control'], 'private, no-store');
  assert.equal(state.modelCalls, 1, 'reading or exporting a report does not call a model');
  assert.equal((await call(`${API}/recordings?limit=10`)).data.recordings[0].interpretation, undefined);
  assert.equal((await call(`${API}/recordings/${meta.id}`)).data.recording.interpretation, undefined);
  assert.equal((await store.get(meta.id)).report, 'Existing factual notes');
  assert.equal((await store.get(meta.id)).text, meta.text);
  state.checkResult = () => '{"items": [{"unitIds": [9999]}]}';
  assert.equal((await call(path, 'POST', { ...input, model, analysisId: report.id })).status, 502);
  assert.equal((await call(path)).data.report.id, report.id);
  state.checkResult = () => '{"items":[]}';
  const empty = await call(path, 'POST', { ...input, model, analysisId: report.id });
  assert.equal(empty.status, 201);
  assert.deepEqual(empty.data.report.items, []);
  await call(`${API}/recordings/${meta.id}`, 'PATCH', { correction: meta.text + '新增结论。' });
  assert.equal((await call(path)).data.report.stale, true);
  assert.equal((await call(path + '?format=txt')).status, 409);
  assert.equal((await call(path, 'POST', { ...input, model, analysisId: empty.data.report.id })).status, 409);
  await call(`${API}/recordings/${meta.id}`, 'DELETE');
  assert.equal((await call(path)).status, 404);
});

test('interpretation rejects short, incomplete and oversized text before any model call', async (t) => {
  const { call, dataRoot, model, state } = await fixture(t);
  const store = createRecordingStore(join(dataRoot, 'recordings'));
  for (const [text, code] of [['太短。', 'short'], ['字'.repeat(40_001), 'tooLong']]) {
    const saved = await store.save({ text });
    const result = await call(`${API}/recordings/${saved.id}/interpretation`, 'POST', { sourceHash: checkSource(saved).hash, model, topic: '', language: 'zh' });
    assert.equal(result.status, 422);
    assert.equal(result.data.error.code, code);
  }
  const { data: { recording } } = await call(`${API}/recordings/live`, 'POST', { language: 'en', mimeType: 'audio/webm' });
  const pending = await call(`${API}/recordings/${recording.id}/interpretation`, 'POST', { model });
  assert.equal(pending.data.error.code, 'pending');
  assert.equal(state.modelCalls, 0);
});

test('interpretation cancellation and competing replacements preserve the last saved report', { timeout: 3000 }, async (t) => {
  const { call, dataRoot, model, state } = await fixture(t);
  const saved = await createRecordingStore(join(dataRoot, 'recordings')).save({ text: '会议安排与测试确认。'.repeat(30) });
  const path = `${API}/recordings/${saved.id}/interpretation`;
  const input = { sourceHash: checkSource(saved).hash, model, topic: '', language: 'zh' };
  state.checkResult = () => interpretationFixture();
  const first = (await call(path, 'POST', input)).data.report;
  const gate = Promise.withResolvers();
  state.waitModel = gate.promise;
  t.after(gate.resolve);
  const canceled = call(path, 'POST', { ...input, analysisId: first.id });
  while (state.modelCalls !== 2) await new Promise((resolve) => setImmediate(resolve));
  state.interpretationResponse.emit('close');
  assert.equal(state.modelSignal.aborted, true);
  gate.resolve();
  assert.ok((await canceled).status >= 400);
  assert.equal((await call(path)).data.report.id, first.id);
  const concurrentGate = Promise.withResolvers();
  state.waitModel = concurrentGate.promise;
  t.after(concurrentGate.resolve);
  const pendingReplacements = [1, 2].map(() => call(path, 'POST', { ...input, analysisId: first.id }));
  while (state.modelCalls !== 4) await new Promise((resolve) => setImmediate(resolve));
  concurrentGate.resolve();
  const replacements = await Promise.all(pendingReplacements);
  assert.deepEqual(replacements.map((result) => result.status).sort(), [201, 409]);
  const current = (await call(path)).data.report;
  const changedGate = Promise.withResolvers();
  state.waitModel = changedGate.promise;
  t.after(changedGate.resolve);
  const changed = call(path, 'POST', { ...input, analysisId: current.id });
  while (state.modelCalls !== 5) await new Promise((resolve) => setImmediate(resolve));
  await call(`${API}/recordings/${saved.id}`, 'PATCH', { correction: saved.text + '修改的原话。' });
  changedGate.resolve();
  assert.equal((await changed).status, 409);
  assert.equal((await call(path)).data.report.id, current.id);
});

async function checkComputerAudio(t, deviceChanged, empty = false) {
  const { call, dataRoot, state } = await fixture(t);
  const archive = createRecordingStore(join(dataRoot, 'recordings'));
  const pcm = Buffer.alloc(32000);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(4096, i);
  let controller, id, confirmations = 0;
  const json = (data) => ({ ok: true, status: 200, json: async () => ({ ok: true, ...data }) });
  const { store, begin, finish, engine } = await bootClient(t, call, {}, {
    forbidMicrophone: true,
    confirm: () => { confirmations++; return true; },
    async fetch(path, options) {
      if (!path.startsWith(`${API}/system-audio`)) return;
      if (path.endsWith('/system-audio') && options.method === 'GET') return json({ ready: true });
      if (options.method === 'POST') {
        assert.equal(JSON.parse(options.body).confirmed, true);
        const recording = await archive.save({ live: true, source: 'system', systemPcm: true, mimeType: 'audio/wav', language: 'en' });
        id = recording.id;
        if (!empty) await archive.appendChunk(id, 0, pcm, 1);
        return json({ id: 'test-capture', recording, sampleRate: 16000 });
      }
      if (path.endsWith('/stream')) return { ok: true, body: new ReadableStream({
        start(value) {
          controller = value;
          if (!empty) { value.enqueue(pcm.subarray(0, 3)); value.enqueue(pcm.subarray(3)); }
        },
      }) };
      if (options.method === 'DELETE' && !deviceChanged && !empty) controller.close();
      return json({ active: false, code: empty ? 'noSamples' : deviceChanged ? 'deviceChanged' : null });
    },
  });
  assert.equal(store.get().captureSource, 'microphone');
  store.set({ captureSource: 'system' });
  await begin(null, null, false, 'studio');
  const expectedSamples = empty ? 0 : 16000;
  while (!controller || engine.pcmSamples < expectedSamples) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(engine.pcmSamples, expectedSamples); assert.equal(engine.capture.recorder, undefined);
  if (empty || deviceChanged) {
    controller.close();
    await waitFor(store, (s) => s.phase === 'result');
    assert.match(store.get().captureWarning, empty ? /未收到电脑声音/ : /输出设备已变化/);
  } else {
    await finish('stop');
    assert.equal(store.get().captureWarning, '');
  }
  assert.equal(confirmations, 1);
  assert.equal(store.get().phase, 'result');
  const recording = await archive.get(id);
  assert.equal(recording.status, empty || deviceChanged ? 'interrupted' : 'complete');
  assert.equal(recording.text, empty ? '' : 'Raw model output');
  if (empty) {
    assert.equal(store.get().archiveStage, 'empty');
    assert.equal(store.get().savedNotice, '');
  }
  assert.equal(state.modelCalls, 0);
}

test('computer audio streams odd byte boundaries without opening a microphone', { timeout: 4000 },
  (t) => checkComputerAudio(t, false));
test('computer audio device changes stop capture and preserve audio and transcription', { timeout: 4000 },
  (t) => checkComputerAudio(t, true));
test('computer audio with no samples reports an empty recording', { timeout: 4000 },
  (t) => checkComputerAudio(t, false, true));

test('computer audio session URLs reach the plugin under Harness prefix matching', async (t) => {
  const { call } = await fixture(t);
  const session = `${API}/system-audio/00000000-0000-0000-0000-000000000000`;
  for (const [path, method] of [[session, 'GET'], [session + '/stream', 'GET'], [session, 'DELETE']]) {
    const { status, data } = await call(path, method);
    assert.equal(status, 404);
    assert.equal(data.error.code, 'missingSession');
  }
});

test('learning notes honor language and require selected-model confirmation for both partial and merged reports', async (t) => {
  const { call, model, state } = await fixture(t);
  assert.equal((await call(`${API}/report`, 'POST', { kind: 'learning', text: 'Quote', language: 'en' })).status, 400);
  assert.equal(state.modelCalls, 0);
  for (const mode of ['part', 'merge']) {
    assert.equal((await call(`${API}/report`, 'POST', { kind: 'learning', text: 'Source only', language: 'en', model, mode })).status, 200);
    assert.match(state.lastModelInput, /learning notes in English/);
    assert.match(state.lastModelInput, /Review Questions/);
    assert.match(state.lastModelInput, /Only use supplied facts/);
    assert.equal((await call(`${API}/report`, 'POST', { kind: 'lecture', text: '[00:28] Sample', language: 'en', model, mode })).status, 200);
    assert.match(state.lastModelInput, /chronological lecture notes in English/);
    assert.match(state.lastModelInput, /\[00:28\] Sample/);
  }
  assert.equal((await call(`${API}/system-audio`, 'POST', { confirmed: false, language: 'en' })).status, 400);
  assert.equal((await call(`${API}/system-audio/not-a-session`, 'DELETE')).status, 404);
});

test('computer audio confirmation discloses enabled model processing and cancel does not start capture', async (t) => {
  const { call, model, state } = await fixture(t);
  let confirmation = '', nativeRequests = 0;
  const { store, begin, engine } = await bootClient(t, call, {
    modelPermission: JSON.stringify([model.provider, model.model]), reportMode: true,
  }, {
    forbidMicrophone: true,
    confirm: (message) => { confirmation = message; return false; },
    fetch(path) { if (path.includes('/system-audio')) nativeRequests++; },
  });
  store.set({ captureSource: 'system' });
  await begin(null, null, false, 'studio');
  assert.match(confirmation, /test-provider/); assert.match(confirmation, /test-model/);
  assert.match(confirmation, /转写文字发送/);
  assert.equal(store.get().phase, 'idle'); assert.equal(engine.capture, null);
  assert.equal(nativeRequests, 0); assert.equal(state.modelCalls, 0);
});

test('cross-segment sharing excludes folded original wording but includes it when opened', async (t) => {
  const { call } = await fixture(t);
  const { readTranscriptSelection } = await bootClient(t, call);
  let closed = true;
  const details = { children: [] };
  const block = (text, folded = false) => ({
    text, closest: (selector) => folded && closed && selector.startsWith('details') ? details : null,
  });
  const first = block('Blue apples'), original = block('Red apples', true), last = block('Green pears');
  const blocks = [first, original, last];
  const bounds = { left: 10, right: 50, top: 20, bottom: 40 };
  const root = {
    contains: () => true, querySelectorAll: () => blocks, getBoundingClientRect: () => bounds,
  };
  const selection = {
    anchorNode: { nodeType: 3, parentElement: { closest: () => first } },
    focusNode: { nodeType: 3, parentElement: { closest: () => last } },
    rangeCount: 1, isCollapsed: false,
    getRangeAt: () => ({
      intersectsNode: () => true, getBoundingClientRect: () => bounds,
      cloneRange: () => {
        let selected;
        return { selectNodeContents: (node) => { selected = node; }, compareBoundaryPoints: () => 0, toString: () => selected.text };
      },
    }),
  };
  assert.equal(readTranscriptSelection(root, selection).text, 'Blue apples\nGreen pears');
  closed = false;
  assert.equal(readTranscriptSelection(root, selection).text, 'Blue apples\nRed apples\nGreen pears');
});

test('microphone initialization failure releases the acquired track', async (t) => {
  const { call } = await fixture(t);
  let stopped = 0;
  const { begin, store } = await bootClient(t, call, {}, {
    microphone: { getTracks: () => [{ stop: () => { stopped++; } }] },
    AudioContext: class { state = 'suspended'; async resume() { throw new Error('Initialization failed'); } },
  });
  await begin(null, undefined, false, 'studio');
  assert.equal(store.get().phase, 'error');
  assert.equal(stopped, 1);
});

test('a custom recording title survives transcription updates and is searchable', async (t) => {
  const { call } = await fixture(t);
  const { data: { recording } } = await call(API + '/recordings/live', 'POST', { mimeType: 'audio/webm' });
  const path = API + '/recordings/' + recording.id;
  const renamed = await call(path, 'PATCH', { title: '  Lecture title  ' });
  assert.equal(renamed.data.recording.customTitle, true);
  assert.equal((await call(path + '/segments/0?start=0&end=1', 'PUT', wave())).status, 200);
  assert.equal((await call(path + '/segments/0/retry?live=1', 'POST')).data.segment.state, 'ready');
  const results = await call(API + '/recordings?q=Lecture%20title');
  assert.equal(results.data.recordings.length, 1);
  assert.equal(results.data.recordings[0].title, 'Lecture title');
  assert.equal(results.data.recordings[0].customTitle, true);
});

test('reports become stale after correction and stale work cannot overwrite them', async (t) => {
  const { call } = await fixture(t);
  const { data: { recording: { id } } } = await call(API + '/recordings', 'POST', { text: 'Friday', report: 'Deliver Friday' });
  const path = API + '/recordings/' + id;
  const before = (await call(path)).data.recording;
  const corrected = (await call(path, 'PATCH', { correction: 'Monday' })).data.recording;
  assert.equal(corrected.reportStale, true);
  await call(path, 'PATCH', { reportKind: 'learning' });
  assert.equal((await call(path)).data.recording.reportKind, 'learning');
  assert.notEqual(corrected.reportSource, before.reportSource);
  assert.equal((await call(path, 'PATCH', { report: 'Late Friday result', reportSource: before.reportSource })).status, 409);
  assert.equal((await call(path)).data.recording.report, 'Deliver Friday');
  const updated = (await call(path, 'PATCH', {
    report: 'Deliver Monday', reportKind: 'learning', reportSource: corrected.reportSource,
  })).data.recording;
  assert.equal(updated.reportStale, false);
  assert.equal(updated.reportKind, 'learning');
  assert.equal((await call(path, 'PATCH', { correction: 'Tuesday' })).data.recording.reportStale, true);
});
