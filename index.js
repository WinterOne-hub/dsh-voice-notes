/**
 * Host half of the live voice input bundle.
 *
 * The Web UI records 16 kHz mono PCM in short slices and posts them here. This
 * plugin forwards each slice to the shipped `speechToText` service (SenseVoice
 * on the Host CPU), so the browser never needs a cloud key and the audio never
 * leaves the machine. A small LLM route translates finished slices on demand.
 *
 * Routes require a signed Harness Desktop browser session and loopback access:
 *   GET  /api/voice-live/status
 *   POST /api/voice-live/prepare   { providerId, downloadSource? }
 *   POST /api/voice-live/cancel    { providerId }
 *   POST /api/voice-live/transcribe{ audioBase64, language }
 *   POST /api/voice-live/translate { text, target }
 *   GET/POST/DELETE/PATCH /api/voice-live/recordings…  (durable archive)
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRecordingStore, correctedTranscript, extensionFor, normalizeMime, recordingStatus, StorageError } from './storage.js';

/** Prefix shared by every route this plugin owns. */
const API = '/api/voice-live';

/** Largest JSON request we accept; base64 inflates a 4 MB WAV to about 5.4 MB. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** Hard limit of the bundled SenseVoice provider. */
const MAX_AUDIO_BYTES = 4 * 1024 * 1024;
/** The provider exposes 120 s as its public ceiling. */
const MAX_AUDIO_SECONDS = 120;
/** Dedicated timeout so a stuck model call cannot hold a request forever. */
const TRANSCRIBE_TIMEOUT_MS = 90_000;
const TRANSLATE_TIMEOUT_MS = 30_000;
/** Compressed recordings are small; this leaves room for a 48 MB audio payload. */
const MAX_RECORDING_BODY = 80 * 1024 * 1024;
const MAX_RECORDING_AUDIO = 48 * 1024 * 1024;
const MAX_ARCHIVE_CHUNK = 2 * 1024 * 1024;
const PROXY_HEADERS = [
  'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto',
  'x-forwarded-port', 'x-forwarded-prefix', 'x-real-ip', 'via',
];

/** Services this plugin needs before it can serve requests. */
export const inject = ['webServer', 'speechToText', 'connection', 'profileContext'];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const writeJson = (res, status, payload, method) => {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  if (method === 'HEAD') {
    res.end();
    return;
  }
  res.end(JSON.stringify(payload));
};

async function readBytes(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, '请求体过大');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Read and parse one bounded JSON request body. */
function requireContentType(req, expected) {
  const actual = req.headers?.['content-type']?.split(';')[0]?.trim().toLowerCase();
  if (actual !== expected) throw new HttpError(415, `请求必须使用 ${expected}`);
}

async function readJson(req, limit = MAX_BODY_BYTES) {
  requireContentType(req, 'application/json');
  const raw = (await readBytes(req, limit)).toString('utf8').trim();
  if (raw === '') return {};
  try {
    const value = JSON.parse(raw);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('not an object');
    }
    return value;
  } catch {
    throw new HttpError(400, '请求体不是合法的 JSON 对象');
  }
}

/** Decode a data-URL or bare base64 payload into bytes. */
function decodeAudio(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new HttpError(400, '缺少 audioBase64');
  }
  const comma = value.startsWith('data:') ? value.indexOf(',') : -1;
  const body = comma >= 0 ? value.slice(comma + 1) : value;
  if (body.length > Math.ceil((MAX_AUDIO_BYTES * 4) / 3) + 16) {
    throw new HttpError(413, '录音超过 4 MB 上限');
  }
  let bytes;
  try {
    bytes = Buffer.from(body, 'base64');
  } catch {
    throw new HttpError(400, 'audioBase64 不是合法的 base64');
  }
  if (bytes.length < 44) throw new HttpError(400, '录音太短');
  return bytes;
}

/**
 * Validate the canonical 16 kHz mono PCM16 WAV the client encodes. Walking the
 * chunk table (instead of assuming a 44-byte header) keeps us compatible with
 * encoders that add LIST/fact chunks.
 *
 * @returns duration in seconds
 */
function validateWave(bytes) {
  if (bytes.length > MAX_AUDIO_BYTES) throw new HttpError(413, '录音超过 4 MB 上限');
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
    throw new HttpError(400, '录音不是 RIFF/WAVE 格式');
  }
  let offset = 12;
  let format;
  let data;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString('ascii', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > bytes.length) throw new HttpError(400, 'WAV 数据块被截断');
    if (id === 'fmt ' && size >= 16) {
      format = {
        audio: bytes.readUInt16LE(start),
        channels: bytes.readUInt16LE(start + 2),
        rate: bytes.readUInt32LE(start + 4),
        bits: bytes.readUInt16LE(start + 14),
      };
    } else if (id === 'data') {
      data = { start, size };
    }
    offset = start + size + (size % 2);
  }
  if (!format || !data) throw new HttpError(400, 'WAV 缺少 fmt 或 data 块');
  if (format.audio !== 1) throw new HttpError(400, '只支持未压缩 PCM 录音');
  if (format.channels !== 1) throw new HttpError(400, '只支持单声道录音');
  if (format.rate !== 16_000) throw new HttpError(400, '只支持 16 kHz 录音');
  if (format.bits !== 16) throw new HttpError(400, '只支持 16 bit 录音');
  if (data.size % 2 !== 0) throw new HttpError(400, 'PCM 数据长度不是偶数');
  const duration = data.size / (16_000 * 2);
  if (duration > MAX_AUDIO_SECONDS + 0.5) {
    throw new HttpError(413, `单段录音不能超过 ${MAX_AUDIO_SECONDS} 秒`);
  }
  if (duration < 0.05) throw new HttpError(400, '录音太短');
  return { duration, start: data.start, size: data.size };
}

/** Rebuild a canonical 44-byte-header WAV around the PCM data chunk. */
function canonicalWave(bytes, start, size) {
  const out = Buffer.allocUnsafe(44 + size);
  out.write('RIFF', 0, 'ascii');
  out.writeUInt32LE(36 + size, 4);
  out.write('WAVE', 8, 'ascii');
  out.write('fmt ', 12, 'ascii');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(16_000, 24);
  out.writeUInt32LE(32_000, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36, 'ascii');
  out.writeUInt32LE(size, 40);
  bytes.copy(out, 44, start, start + size);
  return out;
}

/** Public provider facts; preparation snapshots are already serializable. */
function providerView(provider) {
  return {
    id: provider.id,
    name: provider.name,
    location: provider.location,
    languages: Array.isArray(provider.languages) ? provider.languages : ['auto'],
    preparation: provider.preparation,
    setupEstimate: provider.setupEstimate,
    downloadSources: provider.downloadSources ?? [],
  };
}

/** Resolve the configured default model for translation. */
function translationModel(ctx, expected) {
  const service = ctx.get('agentDefaultModel');
  if (!service || typeof service.currentSelection !== 'function') return undefined;
  const selection = service.currentSelection();
  if (!selection?.model) return undefined;
  if (expected !== undefined && (expected?.provider !== selection.provider || expected?.model !== selection.model)) {
    throw new HttpError(409, '默认模型已更换，请刷新模型信息后重试');
  }
  return { provider: selection.provider, model: selection.model };
}

/** Join text deltas from one model call. */
async function streamText(llm, selection, prompt, signal, settings = {}) {
  const prepared = await llm.prepareCall(
    { provider: selection.provider, model: selection.model, maxTokens: settings.maxTokens ?? 3000 },
    signal,
    (controls, model) => {
      const efforts = Array.isArray(model?.reasoning?.efforts) ? model.reasoning.efforts : [];
      const has = (id) => efforts.some((effort) => effort.id === id);
      const chosen = has('off') ? 'off' : has('low') ? 'low' : undefined;
      return chosen ? { ...controls, reasoningEffort: chosen } : controls;
    },
  );
  const options = {
    ...prepared.config,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    system:
      settings.system ??
      '你是一名专业口译员。把用户提供的语音转写翻译成目标语言，' +
        '保持原意、语气、专有名词、数字和段落；只输出译文，不要解释，不要加引号或“译文：”前缀。',
    signal,
  };
  let text = '';
  for await (const chunk of prepared.stream(options)) {
    if (chunk.type === 'text-delta') text += chunk.text;
  }
  return text;
}

/** Remove fences and the conversational wrapping models sometimes add. */
function cleanTranslation(value) {
  return String(value ?? '')
    .replace(/^```[a-z]*\s*/i, '')
    .replace(/```\s*$/i, '')
    .replace(/^\s*译文[:：]\s*/, '')
    .replace(/^["“'‘]+|["”'’]+$/g, '')
    .trim();
}

/** True when the text is mostly CJK, which flips the automatic target. */
function looksChinese(text) {
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  return cjk > 0 && cjk >= latin * 0.4;
}

/** Languages offered by the translation selector. */
const TARGET_LANGUAGES = {
  en: 'English',
  zh: '简体中文',
  yue: '粤语',
  ja: '日本語',
  ko: '한국어',
  fr: 'Français',
  de: 'Deutsch',
  es: 'Español',
  pt: 'Português',
  ru: 'Русский',
  it: 'Italiano',
  ar: 'العربية',
  th: 'ไทย',
  vi: 'Tiếng Việt',
};

/** Pick a translation direction when the client asks for automatic. */
function resolveTarget(text, requested) {
  const code = String(requested ?? '').toLowerCase();
  if (TARGET_LANGUAGES[code]) return code;
  return looksChinese(text) ? 'en' : 'zh';
}

/** The archive contains private audio; refuse it to non-loopback clients. */
function isLoopback(address) {
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1'
  );
}

/** Public recording shape with the two same-origin media URLs. */
function publicRecording(meta, summary = false, query = '') {
  const { chunkCount, lastCaptureAt, customTitle, segments, correction, ...recording } = meta;
  const pcmSeconds = Number(meta.diagnostics?.pcmSamples) > 0
    ? Number(meta.diagnostics.pcmSamples) / 16_000
    : 0;
  const duration = Math.max(Number(meta.duration) || 0, pcmSeconds);
  const rawText = String(recording.text ?? '');
  const correctedText = correctedTranscript(meta);
  const term = query.trim().toLowerCase();
  const audio = meta.audioFile || (segments && meta.size > 0);
  return {
    ...recording,
    duration: Math.round(duration * 10) / 10,
    status: recordingStatus(meta),
    hasCorrections: correctedText !== undefined,
    ...(summary && term && segments ? {
      matchingSegments: segments.filter((part) => [part.text, part.correction].some(
        (value) => typeof value === 'string' && value.toLowerCase().includes(term),
      )).length,
    } : {}),
    ...(!summary && correctedText !== undefined ? { correctedText } : {}),
    ...(segments ? {
      segmentCount: segments.length,
      pendingCount: segments.filter((part) => part.state !== 'ready').length,
      ...(!summary ? { segments } : {}),
    } : {}),
    audioUrl: audio ? `${API}/recordings/${meta.id}/audio` : null,
    downloadUrl: audio ? `${API}/recordings/${meta.id}/audio?download=1` : null,
    ...(summary ? {
      text: rawText.slice(0, 500),
      hasMore: rawText.length > 500 || Boolean(recording.editedText || recording.translation || recording.report),
      editedText: undefined,
      translation: undefined,
      report: undefined,
    } : {}),
  };
}

async function within(capacity, work) {
  if (!capacity) return work();
  if (capacity.active >= capacity.max) throw new HttpError(429, '请求较多，请稍后重试');
  capacity.active += 1;
  try {
    return await work();
  } finally {
    capacity.active -= 1;
  }
}

export async function apply(ctx, config) {
  const profile = ctx.get('profileContext');
  const connection = ctx.get('connection');
  if (profile?.name !== 'desktop' || typeof connection?.admit !== 'function' || !connection.browserPeer) {
    ctx.logger?.warn?.('voice-live requires an authenticated Harness Desktop profile');
    return;
  }
  const speech = ctx.get('speechToText');
  if (!speech) throw new Error('voice-live requires the speechToText service');
  const dataRoot = config?.dataRoot
    ? resolve(String(config.dataRoot))
    : join(homedir(), '.dsh', 'voice-live');
  const recordings = createRecordingStore(join(dataRoot, 'recordings'));
  await recordings.initialize();
  const archiveWrites = { active: 0, max: 6 };
  const speechWork = { active: 0, max: 3 };
  const modelWork = { active: 0, max: 3 };
  const setupWork = { active: 0, max: 1 };
  let openNonce = 0;

  function authorize(req) {
    if (!isLoopback(req.socket?.remoteAddress) || PROXY_HEADERS.some((name) => req.headers?.[name] !== undefined)) {
      throw new HttpError(403, '语音速记仅供本机 Harness 桌面窗口访问');
    }
    const listener = new URL(ctx.webServer.getOrigin());
    const site = req.headers?.['sec-fetch-site'];
    if (!isLoopback(listener.hostname.replace(/^\[|\]$/g, '')) ||
        req.headers?.host !== listener.host ||
        (site !== undefined && site !== 'same-origin' && site !== 'none')) {
      throw new HttpError(403, '请求来源不受信任');
    }
    const admission = connection.admit(req);
    if (admission.rejection) throw new HttpError(admission.rejection, '请在 Harness 桌面窗口中访问语音速记');
    if (admission.peer !== connection.browserPeer) throw new HttpError(403, '此请求需要 Harness 桌面会话');
  }

  const handler = (run, capacity) => async (req, res) => {
    const method = req.method ?? 'GET';
    try {
      authorize(req);
      await within(capacity, () => run(req, res, method));
    } catch (error) {
      const known = error instanceof HttpError || error instanceof StorageError;
      const status = known ? error.status : 500;
      if (!known) ctx.logger?.warn?.('voice-live request failed');
      writeJson(res, status, { ok: false, error: { message: known ? error.message : '语音速记请求处理失败' } }, method);
    }
  };

  const status = handler(async (req, res, method) => {
    if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, '只支持 GET');
    const snapshot = speech.snapshot();
    writeJson(
      res,
      200,
      {
        ok: true,
        providers: snapshot.providers.map(providerView),
        selection: snapshot.selection,
        model: translationModel(ctx) ?? null,
        limits: {
          maxAudioBytes: MAX_AUDIO_BYTES,
          maxDurationSeconds: MAX_AUDIO_SECONDS,
          maxSessionSeconds: null,
        },
      },
      method,
    );
  });

  const prepare = handler(async (req, res, method) => {
    if (method !== 'POST') throw new HttpError(405, '只支持 POST');
    const body = await readJson(req);
    const providerId = typeof body.providerId === 'string' ? body.providerId.trim() : '';
    if (!providerId) throw new HttpError(400, '缺少 providerId');
    const known = speech.snapshot().providers.some((provider) => provider.id === providerId);
    if (!known) throw new HttpError(404, `没有名为 ${providerId} 的语音模型`);
    const downloadSource =
      typeof body.downloadSource === 'string' && body.downloadSource.trim() !== ''
        ? body.downloadSource.trim()
        : undefined;
    speech.prepare(providerId, downloadSource ? { downloadSource } : undefined);
    writeJson(res, 202, { ok: true }, method);
  }, setupWork);

  const cancel = handler(async (req, res, method) => {
    if (method !== 'POST') throw new HttpError(405, '只支持 POST');
    const body = await readJson(req);
    const providerId = typeof body.providerId === 'string' ? body.providerId.trim() : '';
    if (!providerId) throw new HttpError(400, '缺少 providerId');
    await speech.cancelPreparation(providerId);
    writeJson(res, 200, { ok: true }, method);
  });

  const transcribe = handler(async (req, res, method) => {
    if (method !== 'POST') throw new HttpError(405, '只支持 POST');
    const body = await readJson(req);
    const bytes = decodeAudio(body.audioBase64);
    const wave = validateWave(bytes);
    const canonical = canonicalWave(bytes, wave.start, wave.size);
    const language =
      typeof body.language === 'string' && body.language.trim() !== ''
        ? body.language.trim()
        : 'auto';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('识别超时')), TRANSCRIBE_TIMEOUT_MS);
    res.on('close', () => {
      if (!res.writableEnded) controller.abort(new Error('客户端已断开'));
    });
    try {
      const spec = speech.resolve({ audio: new Uint8Array(canonical), language });
      const result = await speech.transcribe(spec, controller.signal);
      writeJson(
        res,
        200,
        {
          ok: true,
          text: String(result?.text ?? '').trim(),
          audioSeconds: result?.audioSeconds ?? wave.duration,
          inferenceSeconds: result?.inferenceSeconds ?? null,
        },
        method,
      );
    } finally {
      clearTimeout(timer);
    }
  }, speechWork);

  const translate = handler(async (req, res, method) => {
    if (method !== 'POST') throw new HttpError(405, '只支持 POST');
    const body = await readJson(req);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) throw new HttpError(400, '缺少待翻译文本');
    if (text.length > 12_000) throw new HttpError(413, '待翻译文本过长');
    const target = resolveTarget(text, body.target);

    const llm = ctx.get('llm');
    if (!body.model) throw new HttpError(400, '请先确认本次使用的模型');
    const selection = translationModel(ctx, body.model);
    if (!llm || !selection) throw new HttpError(503, '当前没有可用的默认模型，无法翻译');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('翻译超时')), TRANSLATE_TIMEOUT_MS);
    res.on('close', () => {
      if (!res.writableEnded) controller.abort(new Error('客户端已断开'));
    });
    try {
      const languageName = TARGET_LANGUAGES[target] ?? 'English';
      const prompt =
        `把下面这段语音转写翻译成${languageName}。\n` +
        '只输出译文，不要解释，不要重复原文，不要加引号。\n\n' +
        text;
      const raw = await streamText(llm, selection, prompt, controller.signal);
      const translated = cleanTranslation(raw);
      if (!translated) throw new Error('模型没有返回译文');
      writeJson(res, 200, { ok: true, text: translated, target }, method);
    } finally {
      clearTimeout(timer);
    }
  }, modelWork);

  const activeTranscriptions = new Map();

  function retrySegment(id, sequence, live) {
    const key = `${id}/${sequence}`;
    const existing = activeTranscriptions.get(key);
    if (existing) return existing;
    const task = within(speechWork, async () => {
      const { meta, part, bytes } = await recordings.segmentInput(id, sequence, live);
      if (part.state === 'ready') return { part, recording: meta };
      const wave = validateWave(bytes);
      const canonical = canonicalWave(bytes, wave.start, wave.size);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('识别超时')), TRANSCRIBE_TIMEOUT_MS);
      let outcome;
      try {
        const spec = speech.resolve({ audio: new Uint8Array(canonical), language: meta.language });
        const result = await speech.transcribe(spec, controller.signal);
        outcome = { state: 'ready', text: String(result?.text ?? '').trim() };
      } catch (error) {
        outcome = { state: 'failed', error: '本机语音识别失败，可重试此段' };
      } finally {
        clearTimeout(timer);
      }
      const recording = await recordings.resolveSegment(id, sequence, outcome, { recovery: !live, snapshot: part });
      return { part: recording.segments.find((item) => item.sequence === sequence), recording };
    }).finally(() => activeTranscriptions.delete(key));
    activeTranscriptions.set(key, task);
    return task;
  }

  const recordingsHandler = handler(async (req, res, method) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const base = `${API}/recordings`;
    if (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) {
      throw new HttpError(404, '未知的录音接口');
    }
    const rest = url.pathname
      .slice(base.length)
      .split('/')
      .filter(Boolean)
      .map((part) => decodeURIComponent(part));

    // Collection: list or save.
    if (rest.length === 0) {
      if (method === 'GET' || method === 'HEAD') {
        const paged = url.searchParams.has('limit');
        const limit = Math.max(1, Math.min(200, Math.trunc(Number(url.searchParams.get('limit'))) || 200));
        const offset = Math.max(0, Math.trunc(Number(url.searchParams.get('offset')) || 0));
        const query = (url.searchParams.get('q') ?? '').slice(0, 200);
        const items = await recordings.list(query);
        writeJson(
          res,
          200,
          {
            ok: true,
            recordings: items.slice(offset, offset + limit).map((item) => publicRecording(item, paged, query)),
            total: items.length,
            nextOffset: offset + limit < items.length ? offset + limit : null,
            root: recordings.root,
          },
          method,
        );
        return;
      }
      if (method !== 'POST') throw new HttpError(405, '只支持 GET 或 POST');
      const body = await within(archiveWrites, () => readJson(req, MAX_RECORDING_BODY));
      let audio = null;
      if (typeof body.audioBase64 === 'string' && body.audioBase64 !== '') {
        if (body.audioBase64.length > Math.ceil((MAX_RECORDING_AUDIO * 4) / 3) + 16) {
          throw new HttpError(413, '录音音频超过 48 MB 上限');
        }
        audio = Buffer.from(body.audioBase64, 'base64');
        if (audio.length > MAX_RECORDING_AUDIO) {
          throw new HttpError(413, '录音音频超过 48 MB 上限');
        }
        if (audio.length < 32) throw new HttpError(400, '录音音频为空');
      }
      const text = typeof body.text === 'string' ? body.text.slice(0, 200_000) : '';
      if (!audio && text.trim() === '') throw new HttpError(400, '没有可保存的录音');
      const meta = await recordings.save({
        audio,
        mimeType: typeof body.mimeType === 'string' ? body.mimeType : 'audio/webm',
        text,
        translation: typeof body.translation === 'string' ? body.translation : '',
        duration: Number(body.duration) || 0,
        language: typeof body.language === 'string' ? body.language : 'auto',
        providerId: typeof body.providerId === 'string' ? body.providerId : '',
        title: typeof body.title === 'string' ? body.title : '',
        report: typeof body.report === 'string' ? body.report.slice(0, 200_000) : '',
        diagnostics: body.diagnostics,
      });
      writeJson(res, 201, { ok: true, recording: publicRecording(meta) }, method);
      return;
    }

    if (rest.length === 1 && rest[0] === 'live') {
      if (method !== 'POST') throw new HttpError(405, '只支持 POST');
      const body = await readJson(req, 16 * 1024);
      const meta = await recordings.save({
        live: true,
        mimeType: body.mimeType,
        language: String(body.language ?? 'auto').slice(0, 20),
        providerId: String(body.providerId ?? '').slice(0, 200),
      });
      writeJson(res, 201, { ok: true, recording: publicRecording(meta) }, method);
      return;
    }

    const id = rest[0];
    if (rest.length === 3 && rest[1] === 'chunks') {
      if (method !== 'PUT') throw new HttpError(405, '只支持 PUT');
      const sequence = Number(rest[2]);
      requireContentType(req, 'application/octet-stream');
      const bytes = await within(archiveWrites, () => readBytes(req, MAX_ARCHIVE_CHUNK));
      if (!bytes.length) throw new HttpError(400, '录音分块为空');
      const duration = Number(url.searchParams.get('duration'));
      if (!Number.isFinite(duration) || duration < 0) throw new HttpError(400, '无效的录音时长');
      await recordings.appendChunk(id, sequence, bytes, duration);
      writeJson(res, 200, { ok: true }, method);
      return;
    }

    if (rest.length === 2 && rest[1] === 'transcript') {
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, '只支持 GET');
      const meta = await recordings.get(id);
      const corrected = url.searchParams.get('variant') === 'corrected';
      const text = corrected ? correctedTranscript(meta) : meta.text;
      if (text === undefined) throw new HttpError(404, '还没有校对稿');
      const suffix = corrected ? 'corrected' : 'original';
      const title = String(meta.title || 'voice-notes').replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '-');
      const filename = encodeURIComponent(`${title}-${suffix}.txt`.toWellFormed()).replace(/['()]/g,
        (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
      res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'content-disposition': `attachment; filename="${id}-${suffix}.txt"; filename*=UTF-8''${filename}`,
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
        'cross-origin-resource-policy': 'same-origin',
      });
      res.end(method === 'HEAD' ? undefined : text);
      return;
    }

    if (rest.length >= 3 && rest[1] === 'segments') {
      const sequence = Number(rest[2]);
      if (rest.length === 3 && method === 'PUT') {
        const start = Number(url.searchParams.get('start'));
        const end = Number(url.searchParams.get('end'));
        const checkpoint = url.searchParams.get('checkpoint') === '1';
        if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
          throw new HttpError(400, '无效的片段时间');
        }
        requireContentType(req, 'application/octet-stream');
        const bytes = await within(archiveWrites, () => readBytes(req, MAX_AUDIO_BYTES));
        validateWave(bytes);
        await recordings.saveSegment(id, sequence, bytes, { start, end, checkpoint });
        writeJson(res, 200, { ok: true }, method);
        return;
      }
      if (rest.length === 3 && method === 'PATCH') {
        const { correction } = await readJson(req, 128 * 1024);
        if (correction !== null && (typeof correction !== 'string' || correction.length > 20_000)) {
          throw new HttpError(400, '片段校对文字无效或过长');
        }
        const meta = await recordings.correctSegment(id, sequence, correction);
        writeJson(res, 200, { ok: true, recording: publicRecording(meta) }, method);
        return;
      }
      if (rest.length === 4 && rest[3] === 'retry' && method === 'POST') {
        const live = url.searchParams.get('live') === '1';
        const { part, recording } = await retrySegment(id, sequence, live);
        writeJson(res, 200, { ok: true, segment: part, ...(live ? {} : { recording: publicRecording(recording) }) }, method);
        return;
      }
      throw new HttpError(405, '不支持的方法');
    }

    if (rest.length === 1) {
      if (method === 'GET' || method === 'HEAD') {
        const meta = await recordings.get(id);
        writeJson(res, 200, { ok: true, recording: publicRecording(meta) }, method);
        return;
      }
      if (method === 'PATCH') {
        const body = await readJson(req);
        const meta = await recordings.update(id, {
          translation: typeof body.translation === 'string' ? body.translation : undefined,
          text: typeof body.text === 'string' ? body.text : undefined,
          title: typeof body.title === 'string' ? body.title : undefined,
          correction: body.correction === null ? null
            : typeof body.correction === 'string' ? body.correction.slice(0, 200_000) : undefined,
          editedText: typeof body.editedText === 'string' ? body.editedText : undefined,
          status: body.status,
          duration: Number.isFinite(body.duration) ? body.duration : undefined,
          report: typeof body.report === 'string' ? body.report : undefined,
        });
        writeJson(res, 200, { ok: true, recording: publicRecording(meta) }, method);
        return;
      }
      if (method === 'DELETE') {
        await recordings.remove(id);
        writeJson(res, 200, { ok: true }, method);
        return;
      }
      throw new HttpError(405, '不支持的方法');
    }

    if (rest.length === 2 && rest[1] === 'audio') {
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, '只支持 GET');
      const meta = await recordings.get(id);
      const info = await recordings.audioStat(meta);
      const download = url.searchParams.get('download') === '1';
      const range = typeof req.headers.range === 'string' ? req.headers.range : '';
      let start = 0;
      let end = info.size - 1;
      let status = 200;
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
        if (match) {
          if (match[1] === '' && match[2] !== '') {
            const suffix = Math.max(0, Number(match[2]));
            start = Math.max(0, info.size - suffix);
          } else {
            start = Math.max(0, Number(match[1] || 0));
            end = match[2] === '' ? info.size - 1 : Math.min(info.size - 1, Number(match[2]));
          }
          if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= info.size) {
            res.writeHead(416, { 'content-range': `bytes */${info.size}` });
            res.end();
            return;
          }
          status = 206;
        }
      }
      const filename = `${meta.id}.${extensionFor(meta.mimeType)}`;
      const headers = {
        'content-type': normalizeMime(meta.mimeType),
        'content-length': String(end - start + 1),
        'accept-ranges': 'bytes',
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
        'cross-origin-resource-policy': 'same-origin',
        'content-disposition': `${download ? 'attachment' : 'inline'}; filename="${filename}"`,
      };
      if (status === 206) headers['content-range'] = `bytes ${start}-${end}/${info.size}`;
      res.writeHead(status, headers);
      if (method === 'HEAD') {
        res.end();
        return;
      }
      recordings
        .audioStream(meta, { start, end })
        .on('error', () => res.destroy())
        .pipe(res);
      return;
    }

    throw new HttpError(404, '未知的录音接口');
  });

  const normalize = handler(async (req, res, method) => {
    if (method !== 'POST') throw new HttpError(405, '只支持 POST');
    const body = await readJson(req);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    const language = String(body.language ?? 'auto').toLowerCase();
    if (!text) {
      writeJson(res, 200, { ok: true, text: '', language }, method);
      return;
    }
    if (language !== 'auto' && !TARGET_LANGUAGES[language]) {
      writeJson(res, 200, { ok: true, text, language: 'auto' }, method);
      return;
    }
    if (text.length > 20_000) throw new HttpError(413, '转写文本过长');
    const llm = ctx.get('llm');
    if (!body.model) throw new HttpError(400, '请先确认本次使用的模型');
    const selection = translationModel(ctx, body.model);
    if (!llm || !selection) throw new HttpError(503, '当前没有可用的默认模型，无法整理语言');
    const languageName = TARGET_LANGUAGES[language];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('语言整理超时')), 25_000);
    res.on('close', () => {
      if (!res.writableEnded) controller.abort(new Error('客户端已断开'));
    });
    try {
      const prompt =
        (languageName ? `Rewrite the speech transcript below in ${languageName} only. ` +
          `If any phrase is in another language, translate it into ${languageName}; ` :
          'Clean up the speech transcript below. Preserve its original language(s). ') +
        'keep proper nouns, numbers, and meaning; fix punctuation, casing, and obvious ASR slips; ' +
        'do not add or remove facts. Output only the edited transcript, no notes.\n\n' +
        text;
      const raw = await streamText(llm, selection, prompt, controller.signal, {
        maxTokens: 3000,
        system:
          'You are a strict speech transcript editor. You preserve every fact and name, ' +
          'and follow the language instructions for this transcript.',
      });
      const cleaned = String(raw ?? '')
        .replace(/^```[a-z]*\s*/i, '')
        .replace(/```\s*$/i, '')
        .replace(/^\s*(?:transcript|转写|文本)[:：]\s*/i, '')
        .trim();
      writeJson(res, 200, { ok: true, text: cleaned || text, language }, method);
    } finally {
      clearTimeout(timer);
    }
  }, modelWork);

  const report = handler(async (req, res, method) => {
    if (method !== 'POST') throw new HttpError(405, '只支持 POST');
    const body = await readJson(req);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) throw new HttpError(400, '缺少转写文本');
    if (text.length > 40_000) throw new HttpError(413, '转写文本过长');
    const llm = ctx.get('llm');
    if (!body.model) throw new HttpError(400, '请先确认本次使用的模型');
    const selection = translationModel(ctx, body.model);
    if (!llm || !selection) throw new HttpError(503, '当前没有可用的默认模型，无法生成会议报告');
    const language = body.language === 'Chinese' || body.language === 'English'
      ? body.language : (looksChinese(text) ? 'Chinese' : 'English');
    const merging = body.mode === 'merge';
    const prompt = [
      merging
        ? `Combine the partial meeting reports below into one concise report in ${language}. Deduplicate repeated items.`
        : `Read the meeting transcript below and write a concise, well-structured meeting report in ${language}.`,
      'Return Markdown only, with exactly these sections:',
      '# Meeting Report',
      '## Summary (2-4 sentences)',
      '## Key Points (bullet list)',
      '## Decisions (bullet list, or "None recorded")',
      '## Action Items (checkbox list with owner/deadline when stated, or "None recorded")',
      'Rules: use only facts from the transcript; do not invent names, numbers, dates or decisions;',
      'mark uncertain items as "unclear"; keep the report tight; do not add a preamble or code fence.',
      '',
      merging ? 'Partial reports:' : 'Transcript:',
      text,
    ].join('\n');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('报告生成超时')), 60_000);
    res.on('close', () => {
      if (!res.writableEnded) controller.abort(new Error('客户端已断开'));
    });
    try {
      const raw = await streamText(llm, selection, prompt, controller.signal, {
        maxTokens: body.mode === 'part' ? 900 : 4000,
        system:
          'You are a meticulous meeting scribe. You produce factual, compact meeting reports from raw speech transcripts. ' +
          'You never invent details and you follow the requested output language.',
      });
      const cleaned = String(raw ?? '')
        .replace(/^```(?:markdown)?\s*/i, '')
        .replace(/```\s*$/i, '')
        .trim();
      if (!cleaned) throw new Error('模型没有返回会议报告');
      writeJson(res, 200, { ok: true, report: cleaned, language }, method);
    } finally {
      clearTimeout(timer);
    }
  }, modelWork);

  const open = handler(async (req, res, method) => {
    if (method !== 'POST') throw new HttpError(405, '只支持 POST');
    openNonce = Date.now();
    writeJson(res, 200, { ok: true, nonce: openNonce }, method);
  });

  const openState = handler(async (req, res, method) => {
    if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, '只支持 GET');
    const url = new URL(req.url ?? '/', 'http://localhost');
    const since = Number(url.searchParams.get('since') ?? 0) || 0;
    writeJson(res, 200, { ok: true, nonce: openNonce, open: openNonce > since }, method);
  });

  const routes = [
    ['/status', status],
    ['/normalize', normalize],
    ['/report', report],
    ['/open', open],
    ['/open-state', openState],
    ['/prepare', prepare],
    ['/cancel', cancel],
    ['/transcribe', transcribe],
    ['/translate', translate],
  ];
  for (const [path, run] of routes) {
    ctx.effect(
      () => ctx.webServer.register({ kind: 'exact', path: `${API}${path}`, handler: run }),
      `voice-live: ${path}`,
    );
  }
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: `${API}/recordings`,
        handler: recordingsHandler,
      }),
    'voice-live: recordings',
  );
}
