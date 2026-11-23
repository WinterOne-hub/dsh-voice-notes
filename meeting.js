import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';
import { protectWindowsDirectory } from './windows-private-directory.js';

export const MEETING_SECONDS = 3600;
export const PCM_RATE = 16_000;
export const MAX_SPEAKERS = 12;
const MAX_TURNS = 4000;
const ASSETS = [
  {
    file: 'segmentation.onnx', bytes: 1540506,
    sha256: 'd582f4b4c6b48205de7e0643c57df0df5615a3c176189be3fc461e9d18827b5d',
    bundled: fileURLToPath(new URL('./meeting-models/segmentation.onnx', import.meta.url)),
  },
  {
    file: 'embedding.onnx', bytes: 39593761,
    sha256: '1a331345f04805badbb495c775a6ddffcdd1a732567d5ec8b3d5749e3c7a5e4b',
    url: 'https://huggingface.co/Maxkuo/eres2net-base-sv-zh-cn-onnx/resolve/533e660fabc9553c0dc0cb5b395b24eac1ece0ad/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx',
  },
];

export class MeetingError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

function nativePath() {
  const platform = process.platform === 'win32' ? `win-${process.arch}` : `${process.platform}-${process.arch}`;
  if (!process.versions.electron || !['darwin-arm64', 'win-x64'].includes(platform)) return null;
  const resources = process.resourcesPath ||
    join(dirname(process.execPath), process.platform === 'darwin' ? '../Resources' : 'resources');
  return join(resources, 'app.asar.unpacked', 'dsh', 'node_modules', `sherpa-onnx-${platform}`, 'sherpa-onnx.node');
}

async function matches(path, asset, signal) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size !== asset.bytes) return false;
    if (!signal) return true;
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
    return hash.digest('hex') === asset.sha256;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function persistModel(path, input, asset, signal, status) {
  const partial = `${path}.${randomUUID()}.part`;
  try {
    const hash = createHash('sha256');
    let bytes = 0;
    const check = new Transform({
      transform(chunk, _encoding, done) {
        bytes += chunk.length;
        if (bytes > asset.bytes) return done(new MeetingError('integrity', status));
        hash.update(chunk);
        done(null, chunk);
      },
    });
    await pipeline(input, check, createWriteStream(partial, { flags: 'wx', mode: 0o600 }), { signal });
    if (bytes !== asset.bytes || hash.digest('hex') !== asset.sha256) throw new MeetingError('integrity', status);
    await rename(partial, path);
  } finally {
    await rm(partial, { force: true });
  }
}

async function download(path, asset, signal) {
  const hosts = ['huggingface.co', 'cas-bridge.xethub.hf.co', 'cdn-lfs.huggingface.co', 'cdn-lfs.hf.co', 'cdn-lfs-us-1.hf.co'];
  let url = new URL(asset.url);
  let response;
  for (let i = 0; i <= 3; i++) {
    response = await fetch(url, { signal, credentials: 'omit', redirect: 'manual', referrerPolicy: 'no-referrer' });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location || i === 3) throw new MeetingError('downloadFailed', 502);
    url = new URL(location, url);
    if (url.protocol !== 'https:' || url.port || url.username || url.password || !hosts.includes(url.hostname)) {
      throw new MeetingError('downloadFailed', 502);
    }
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new MeetingError('downloadFailed', 502);
  }
  await persistModel(path, response.body, asset, signal, 502);
}

async function downloadWithRetry(path, asset, signal) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const request = AbortSignal.any([signal, AbortSignal.timeout(180_000)]);
    try {
      await download(path, asset, request);
      return;
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof MeetingError && error.code === 'integrity') throw error;
      if (attempt === 2) throw new MeetingError('downloadFailed', 502);
      await delay(750 * (attempt + 1), undefined, { signal });
    }
  }
}

export async function runDiarizer({ addonPath, models, pcm, count, signal }) {
  signal.throwIfAborted();
  const worker = new Worker(new URL('./meeting-worker.js', import.meta.url), {
    workerData: { addonPath, models, pcm, count }, transferList: [pcm], execArgv: [],
  });
  let abort;
  try {
    return await new Promise((resolve, reject) => {
      const failed = () => reject(new MeetingError('analysisFailed', 500));
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      worker.once('error', failed);
      worker.once('exit', failed);
      worker.once('message', (result) => result.failed ? failed() : resolve(result));
      if (signal.aborted) abort();
    });
  } finally {
    signal.removeEventListener('abort', abort);
    await worker.terminate();
  }
}

export function createMeetingEngine(dataRoot) {
  const root = join(dataRoot, 'meeting-models');
  const models = ASSETS.map(({ file, bundled }) => bundled ?? join(root, file));
  const addonPath = nativePath();

  async function supported() {
    return !!addonPath && (await lstat(addonPath).catch(() => null))?.isFile() === true;
  }

  async function secureCache(create) {
    if (create) await mkdir(root, { recursive: true, mode: 0o700 });
    const info = await lstat(root).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!info) return false;
    if (!info.isDirectory() || (process.platform !== 'win32' && (info.mode & 0o077))) {
      throw new MeetingError('cachePermissions', 409);
    }
    if (process.platform === 'win32') await protectWindowsDirectory(root);
    return true;
  }

  return {
    async status() {
      const available = await supported();
      const ready = available && await Promise.all(models.map((path, i) => matches(path, ASSETS[i], AbortSignal.timeout(15_000))))
        .then((results) => results.every(Boolean)).catch(() => false);
      return { supported: available, ready, bytes: ASSETS.reduce((sum, asset) => sum + (asset.bundled ? 0 : asset.bytes), 0) };
    },
    async prepare(signal) {
      if (!await supported()) throw new MeetingError('unsupported', 503);
      await secureCache(true);
      for (let i = 0; i < models.length; i++) {
        if (!await matches(models[i], ASSETS[i], signal)) {
          if (ASSETS[i].bundled) throw new MeetingError('integrity', 502);
          await downloadWithRetry(models[i], ASSETS[i], signal);
        }
      }
    },
    async install(input, length, signal) {
      if (!await supported()) throw new MeetingError('unsupported', 503);
      const asset = ASSETS[1];
      if (length !== undefined && Number(length) !== asset.bytes) throw new MeetingError('integrity', 422);
      await secureCache(true);
      await persistModel(models[1], input, asset, signal, 422);
    },
    async process(pcm, count, signal) {
      if (!await supported()) throw new MeetingError('unsupported', 503);
      if (!await secureCache(false)) throw new MeetingError('prepare', 409);
      for (let i = 0; i < models.length; i++) {
        if (!await matches(models[i], ASSETS[i], signal)) throw new MeetingError('prepare', 409);
      }
      return runDiarizer({ addonPath, models, pcm, count, signal });
    },
  };
}

/** Convert overlapping native turns into a nonoverlapping transcript timeline. */
export function planTurns(raw, frames) {
  if (!Array.isArray(raw) || raw.length > MAX_TURNS) throw new MeetingError('analysisFailed', 422);
  const byTime = new Map();
  const speakers = new Map();
  const frame = (seconds) => Math.max(0, Math.min(frames, Math.round(seconds * PCM_RATE)));
  const events = (at) => {
    if (!byTime.has(at)) byTime.set(at, []);
    return byTime.get(at);
  };
  for (const row of raw.slice().sort((a, b) => a.start - b.start || a.speaker - b.speaker)) {
    if (!Number.isFinite(row.start) || !Number.isFinite(row.end) ||
        !Number.isSafeInteger(row.speaker) || row.speaker < 0) continue;
    const start = frame(row.start), end = frame(row.end);
    if (end <= start) continue;
    if (!speakers.has(row.speaker)) {
      if (speakers.size >= MAX_SPEAKERS) throw new MeetingError('tooMany', 422);
      speakers.set(row.speaker, speakers.size + 1);
    }
    const id = speakers.get(row.speaker);
    events(start).push([id, 1]);
    events(end).push([id, -1]);
  }
  const active = new Map();
  const timeline = [];
  let previous = 0;
  for (const [at, changes] of [...byTime.entries()].sort((a, b) => a[0] - b[0])) {
    if (at > previous && active.size > 0) {
      const overlap = active.size > 1;
      const speakerId = overlap ? null : active.keys().next().value;
      const last = timeline.at(-1);
      const bridge = overlap ? 0 : PCM_RATE * 0.12;
      if (last && last.speakerId === speakerId && previous - last.endFrame <= bridge) last.endFrame = at;
      else timeline.push({ startFrame: previous, endFrame: at, speakerId, overlap });
    }
    for (const [id, delta] of changes) {
      const count = (active.get(id) ?? 0) + delta;
      if (count) active.set(id, count);
      else active.delete(id);
    }
    previous = at;
  }
  const turns = [];
  for (const span of timeline) {
    const frames = span.endFrame - span.startFrame;
    const slices = Math.ceil(frames / (PCM_RATE * 28));
    for (let i = 0; i < slices; i++) {
      const startFrame = span.startFrame + Math.floor(frames * i / slices);
      const endFrame = span.startFrame + Math.floor(frames * (i + 1) / slices);
      if (!span.overlap && endFrame - startFrame < PCM_RATE * 0.16) continue;
      turns.push({ ...span, startFrame, endFrame });
    }
  }
  if (turns.length > MAX_TURNS) throw new MeetingError('analysisFailed', 422);
  return { speakers: [...speakers.values()].map((id) => ({ id })), turns };
}

export function speakerLabel(meeting, row, locale = 'zh') {
  const en = locale === 'en';
  if (!row.speakerId) return row.overlap ? (en ? 'Overlap — review' : '重叠发言，待确认') : (en ? 'Unknown speaker' : '说话人待确认');
  return meeting.speakers.find((speaker) => speaker.id === row.speakerId)?.name ||
    (en ? `Speaker ${row.speakerId}` : `说话人 ${row.speakerId}`);
}

export function formatMeeting(meeting, locale) {
  return meeting.turns.map((row) => {
    const time = new Date(Math.floor(row.start) * 1000).toISOString().slice(11, 19);
    return `[${time}] ${speakerLabel(meeting, row, locale)}: ${row.correction ?? row.text}`;
  }).join('\n');
}
