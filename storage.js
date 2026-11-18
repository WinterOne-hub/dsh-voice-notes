/**
 * Durable recording archive for the live voice plugin.
 *
 * One JSON sidecar and one compressed audio file per recording, both under the
 * plugin's data directory. Metadata is written atomically, and every id/path
 * coming from HTTP is validated before it reaches the filesystem.
 */

import { pcmWaveHeader } from './pcm.js';
import { constants } from 'node:fs';
import { checkSource, CheckError } from './meeting-check.js';
import { interpretationSource } from './meeting-interpretation.js';
import { lstat, mkdir, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { protectWindowsDirectory } from './windows-private-directory.js';

/** Audio container accepted for the archive; the value is the stored extension. */
const MIME_EXT = new Map([
  ['audio/webm', 'webm'],
  ['audio/ogg', 'ogg'],
  ['audio/mp4', 'm4a'],
  ['audio/wav', 'wav'],
  ['audio/x-wav', 'wav'],
  ['audio/mpeg', 'mp3'],
  ['audio/flac', 'flac'],
]);

/** Recording ids are generated locally and never contain path separators. */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{3,80}$/;

/** Archive failure carrying the HTTP status the route should answer with. */
export class StorageError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Normalize a browser MIME type to a container we can store and serve. */
export function normalizeMime(value) {
  const raw = String(value ?? '').split(';')[0].trim().toLowerCase();
  return MIME_EXT.has(raw) ? raw : 'audio/webm';
}

/** Extension for one normalized MIME type. */
export function extensionFor(mime) {
  return MIME_EXT.get(mime) ?? 'webm';
}

/** Keep a title to one line and a bounded length. */
function cleanTitle(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

/** First words of the transcript, used when the client sends no title. */
function defaultTitle(text) {
  const first = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (first) return first;
  const now = new Date();
  const stamp = now.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return `语音速记 ${stamp}`;
}

export const STALE_RECORDING_MS = 25_000;

export function recordingStatus(meta, now = Date.now()) {
  if (meta.status === 'recording' && now - meta.lastCaptureAt > STALE_RECORDING_MS) {
    return 'interrupted';
  }
  return meta.status ?? 'complete';
}

function validateSequence(sequence) {
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > 999_999_999) {
    throw new StorageError(400, '无效的分块编号');
  }
}

function textOf(segments, corrected = false) {
  return segments.reduce((text, segment) => {
    const next = corrected ? (segment.correction ?? segment.text) : segment.text;
    if (!next) return text;
    if (!text) return next;
    const boundary = /[\u3400-\u9fff。，、；：！？…—）》”’】]/.test(text.at(-1)) ||
      /^[。，、；：！？…—）》”’】]/.test(next);
    return text + (boundary ? '' : ' ') + next;
  }, '');
}

export function correctedTranscript(meta) {
  if (!meta.segments) return typeof meta.correction === 'string' ? meta.correction : undefined;
  if (!meta.segments.some((part) => typeof part.correction === 'string')) return undefined;
  return textOf(meta.segments, true);
}

const windows = process.platform === 'win32';
const PRIVATE_READ = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

async function requireDirectory(path) {
  const info = await lstat(path);
  if (!info.isDirectory()) throw new StorageError(404, '录音目录不可用');
}

async function archiveFileInfo(path) {
  const info = await lstat(path, { bigint: true });
  if (!info.isFile() || info.nlink !== 1n) throw new StorageError(404, '录音文件不存在');
  return info;
}

async function openArchiveFile(path) {
  // Windows lacks O_NOFOLLOW. Compare the opened handle with the direct directory entry.
  const before = windows ? await archiveFileInfo(path) : null;
  const file = await open(path, PRIVATE_READ);
  try {
    const info = await file.stat({ bigint: true });
    if (!info.isFile() || info.nlink !== 1n ||
        (before && (before.dev !== info.dev || before.ino !== info.ino))) {
      throw new StorageError(404, '录音文件不存在');
    }
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

async function readArchiveFile(path, encoding) {
  const file = await openArchiveFile(path);
  try {
    return await file.readFile(encoding);
  } finally {
    await file.close();
  }
}

async function* streamArchiveFile(path, start, end) {
  const file = await openArchiveFile(path);
  try {
    yield* file.createReadStream({ start, end, autoClose: false });
  } finally {
    await file.close();
  }
}

async function secureFile(path, kind, mode) {
  const file = await open(path, PRIVATE_READ);
  try {
    const info = await file.stat();
    if (kind === 'directory' ? !info.isDirectory() : !info.isFile() || info.nlink !== 1) {
      throw new StorageError(404, '录音文件类型无效');
    }
    if ((info.mode & 0o777) !== mode) await file.chmod(mode);
  } finally {
    await file.close();
  }
}

/** @param {string} directory absolute recordings directory */
export function createRecordingStore(directory) {
  const root = resolve(directory);
  const metaFile = (id) => join(root, `${id}.json`);
  const partDir = (id) => join(root, `${id}.parts`);
  const partFile = (id, sequence) => join(partDir(id), `audio-${String(sequence).padStart(9, '0')}`);
  const waveFile = (id, sequence) => join(partDir(id), `segment-${sequence}.wav`);
  let windowsProtection;
  const ensure = async () => {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await requireDirectory(root);
    if (windows) {
      windowsProtection ??= protectWindowsDirectory(root).catch((error) => {
        windowsProtection = undefined;
        throw error;
      });
      await windowsProtection;
    }
  };
  const updates = new Map();

  async function writeAtomic(file, value) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, value, { flag: 'wx', mode: 0o600 });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  const writeMeta = (meta) => writeAtomic(metaFile(meta.id), `${JSON.stringify(meta)}\n`);

  function checkId(id) {
    if (!ID_PATTERN.test(String(id ?? ''))) throw new StorageError(404, '录音不存在');
    return String(id);
  }

  async function readMeta(id) {
    const key = checkId(id);
    try {
      const meta = JSON.parse(await readArchiveFile(metaFile(key), 'utf8'));
      if (!meta || meta.id !== key) throw new StorageError(404, '录音不存在');
      return meta;
    } catch (error) {
      if (['ENOENT', 'ELOOP'].includes(error?.code) || error instanceof SyntaxError) {
        throw new StorageError(404, '录音不存在');
      }
      throw error;
    }
  }

  function serialize(id, work) {
    const task = (updates.get(id) ?? Promise.resolve()).catch(() => {}).then(work);
    updates.set(id, task);
    return task.finally(() => {
      if (updates.get(id) === task) updates.delete(id);
    });
  }

  async function change(id, work) {
    return serialize(checkId(id), async () => {
      const meta = await readMeta(id);
      await work(meta);
      await writeMeta(meta);
      return meta;
    });
  }

  function audioPath(meta) {
    const name = String(meta?.audioFile ?? '');
    if (!name.startsWith(`${meta.id}.`) || ![...MIME_EXT.values()].includes(name.slice(meta.id.length + 1))) {
      throw new StorageError(404, '录音没有音频文件');
    }
    return join(root, name);
  }

  async function initialize() {
    try {
      await requireDirectory(dirname(root));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await ensure();
    if (windows) return;
    await secureFile(root, 'directory', 0o700);
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const dot = entry.name.indexOf('.');
      if (dot < 0 || !ID_PATTERN.test(entry.name.slice(0, dot))) continue;
      const path = join(root, entry.name);
      if (entry.isFile()) {
        await secureFile(path, 'file', 0o600);
      } else if (entry.isDirectory() && entry.name.endsWith('.parts')) {
        await secureFile(path, 'directory', 0o700);
        for (const part of await readdir(path, { withFileTypes: true })) {
          if (part.isFile()) await secureFile(join(path, part.name), 'file', 0o600);
        }
      }
    }
  }

  async function save({ audio, mimeType, text, translation, duration, language, providerId,
    title, report, diagnostics, source, systemPcm = false, live = false }) {
    await ensure();
    const mime = normalizeMime(mimeType);
    const id = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const audioFile = audio?.length ? `${id}.${extensionFor(mime)}` : null;
    const createdAt = Date.now();
    const cleanText = String(text ?? '').trim();
    const meta = {
      id,
      createdAt,
      duration: Math.max(0, Math.round((Number(duration) || 0) * 10) / 10),
      text: cleanText.slice(0, 200_000),
      translation: String(translation ?? '').trim().slice(0, 200_000),
      report: String(report ?? '').trim().slice(0, 200_000),
      language: String(language ?? 'auto'),
      providerId: String(providerId ?? ''),
      mimeType: mime,
      audioFile,
      size: audioFile ? audio.length : 0,
      title: cleanTitle(title) || defaultTitle(cleanText),
      ...(source === 'import' || source === 'retranscription' || source === 'system' ? { source, customTitle: Boolean(cleanTitle(title)) } : {}),
    };
    if (source === 'system' && systemPcm === true) meta.systemPcm = true;
    if (diagnostics && typeof diagnostics === 'object') {
      meta.diagnostics = {
        pcmSamples: Number(diagnostics.pcmSamples) || 0,
        partialCount: Number(diagnostics.partialCount) || 0,
        partialAttempts: Number(diagnostics.partialAttempts) || 0,
        transcribeErrors: Number(diagnostics.transcribeErrors) || 0,
        captureMode: String(diagnostics.captureMode ?? '').slice(0, 20),
      };
    }
    if (live) {
      Object.assign(meta, {
        status: 'recording',
        lastCaptureAt: createdAt,
        chunkCount: 0,
        segments: [],
      });
      await mkdir(partDir(id), { mode: 0o700 });
    }
    if (audioFile) await writeAtomic(join(root, audioFile), audio);
    await writeMeta(meta);
    return meta;
  }

  return {
    root,
    initialize,
    save,
    get: readMeta,

    async list(query = '') {
      let entries;
      try {
        entries = await readdir(root, { withFileTypes: true });
      } catch (error) {
        if (error?.code === 'ENOENT') return [];
        throw error;
      }
      const items = [];
      const term = query.trim().toLowerCase();
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const id = entry.name.slice(0, -5);
        if (!ID_PATTERN.test(id)) continue;
        let meta;
        try {
          meta = await readMeta(id);
        } catch (error) {
          if (error instanceof StorageError && error.status === 404) continue;
          throw error;
        }
        if (meta.segments && !meta.size && !meta.segments.length && recordingStatus(meta) !== 'recording') continue;
        if (term && ![meta.title, meta.text, correctedTranscript(meta), meta.editedText, meta.translation, meta.report]
          .some((value) => String(value ?? '').toLowerCase().includes(term)) &&
          !meta.meeting?.speakers.some((speaker) => speaker.name?.toLowerCase().includes(term)) &&
          !meta.meeting?.turns.some((part) => (part.correction ?? part.text).toLowerCase().includes(term))) continue;
        items.push(meta);
      }
      return items.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
    },

    appendChunk(id, sequence, bytes, duration) {
      validateSequence(sequence);
      return change(id, async (meta) => {
        if (!meta.segments) throw new StorageError(409, '录音不支持分块写入');
        if (sequence < meta.chunkCount) return;
        if (meta.status !== 'recording' || sequence !== meta.chunkCount) {
          throw new StorageError(409, '录音分块顺序不正确或录音已结束');
        }
        await requireDirectory(partDir(id));
        await writeAtomic(partFile(id, sequence), bytes);
        meta.chunkCount += 1;
        meta.size += bytes.length;
        meta.lastCaptureAt = Date.now();
        meta.duration = Math.max(meta.duration, duration);
      });
    },

    saveSegment(id, sequence, bytes, { start, end, checkpoint }) {
      validateSequence(sequence);
      return change(id, async (meta) => {
        if (!meta.segments || meta.status !== 'recording') {
          throw new StorageError(409, '录音已结束');
        }
        const previous = meta.segments.find((part) => part.sequence === sequence);
        if (previous && (!previous.checkpoint || (checkpoint && previous.end >= end))) return;
        await requireDirectory(partDir(id));
        await writeAtomic(waveFile(id, sequence), bytes);
        const part = { sequence, start, end, checkpoint, state: 'pending' };
        if (previous) Object.assign(previous, part);
        else meta.segments.push(part);
        meta.segments.sort((a, b) => a.sequence - b.sequence);
        meta.lastCaptureAt = Date.now();
        meta.duration = Math.max(meta.duration, end);
      });
    },

    async segmentInput(id, sequence, live) {
      validateSequence(sequence);
      return serialize(checkId(id), async () => {
        const meta = await readMeta(id);
        const part = meta.segments?.find((item) => item.sequence === sequence);
        if (!part) throw new StorageError(404, '转写片段不存在');
        if (part.state === 'ready') return { meta, part };
        if (recordingStatus(meta) === 'recording' && (!live || part.checkpoint)) {
          throw new StorageError(409, '正在录制此片段');
        }
        await requireDirectory(partDir(id));
        return { meta, part, bytes: await readArchiveFile(waveFile(id, sequence)) };
      });
    },

    async resolveSegment(id, sequence, outcome, { recovery = false, snapshot } = {}) {
      return serialize(checkId(id), async () => {
        const meta = await readMeta(id);
        const part = meta.segments?.find((item) => item.sequence === sequence);
        if (!part || part.state === 'ready') return meta;
        if (snapshot && (snapshot.end !== part.end || snapshot.checkpoint !== part.checkpoint)) {
          return meta;
        }
        Object.assign(part, outcome);
        if (part.state === 'ready') {
          delete part.error;
          if (recovery && part.text && (meta.editedText || meta.translation || meta.report)) {
            meta.derivedStale = true;
          }
          if (recovery && meta.status === 'recording' && recordingStatus(meta) === 'interrupted') {
            meta.status = 'interrupted';
          }
          meta.text = textOf(meta.segments);
          if (!meta.customTitle) meta.title = cleanTitle(meta.text.slice(0, 40)) || meta.title;
        }
        await writeMeta(meta);
        if (part.state === 'ready') {
          await rm(waveFile(id, sequence), { force: true }).catch(() => {});
        }
        return meta;
      });
    },

    correctSegment(id, sequence, value) {
      validateSequence(sequence);
      return change(id, (meta) => {
        if (recordingStatus(meta) === 'recording') throw new StorageError(409, '正在录制，暂不能校对');
        const part = meta.segments?.find((item) => item.sequence === sequence);
        if (!part) throw new StorageError(404, '转写片段不存在');
        if (part.state !== 'ready') throw new StorageError(409, '片段尚未完成识别');
        if (value === null) delete part.correction;
        else part.correction = value.trim();
      });
    },

    saveCheck(id, check, previous, signal) {
      return change(id, (meta) => {
        signal?.throwIfAborted();
        const source = checkSource(meta);
        if (source.state !== 'ready' || source.hash !== check.sourceHash ||
            (meta.check?.id ?? null) !== previous.id || (meta.check?.revision ?? 0) !== previous.revision) throw new CheckError('changed', 409);
        meta.check = check;
      });
    },

    saveInterpretation(id, interpretation, previousId, signal) {
      return change(id, (meta) => {
        signal?.throwIfAborted();
        const source = interpretationSource(meta);
        if (source.state !== 'ready' || source.hash !== interpretation.sourceHash ||
            (meta.interpretation?.id ?? null) !== previousId) throw new CheckError('changed', 409);
        meta.interpretation = interpretation;
      });
    },

    retainCheckUnit(id, analysisId, unitId, retained) {
      return change(id, (meta) => {
        const source = checkSource(meta);
        if (!meta.check || meta.check.id !== analysisId ||
            meta.check.sourceHash !== source.hash || source.state !== 'ready') {
          throw new CheckError('changed', 409);
        }
        const label = meta.check.labels.find((row) => row.id === unitId);
        if (!label) throw new CheckError('invalid', 400);
        label.retained = retained;
        meta.check.revision += 1;
      });
    },

    saveMeeting(id, meeting, revision = 0) {
      return change(id, (meta) => {
        if ((meta.meeting?.revision ?? 0) !== revision) throw new StorageError(409, '多人转写已变更，请刷新');
        if (recordingStatus(meta) === 'recording') throw new StorageError(409, '录音仍在进行');
        meta.meeting = meeting;
        if (meta.report) meta.meetingReportStale = true;
      });
    },

    editMeeting(id, patch) {
      return change(id, (meta) => {
        const meeting = meta.meeting;
        if (!meeting) throw new StorageError(404, '多人转写不存在');
        if (meeting.revision !== patch.revision) throw new StorageError(409, '多人转写已变更，请刷新');
        if (patch.kind === 'speaker') {
          const speaker = meeting.speakers.find(({ id }) => id === patch.speakerId);
          if (!speaker) throw new StorageError(404, '说话人不存在');
          speaker.name = patch.name;
        } else {
          const turn = meeting.turns.find(({ id }) => id === patch.turnId);
          if (!turn) throw new StorageError(404, '发言段不存在');
          if (patch.speakerId !== undefined) {
            if (patch.speakerId !== null && !meeting.speakers.some(({ id }) => id === patch.speakerId)) {
              throw new StorageError(404, '说话人不存在');
            }
            turn.speakerId = patch.speakerId;
          }
          if (patch.correction === null) delete turn.correction;
          else if (patch.correction !== undefined) turn.correction = patch.correction;
        }
        meeting.revision += 1;
        if (meta.report) meta.meetingReportStale = true;
      });
    },

    update(id, patch) {
      return change(id, (meta) => {
        if (typeof patch.report === 'string' && meta.meeting) {
          if (patch.meetingRevision === meta.meeting.revision) delete meta.meetingReportStale;
          else meta.meetingReportStale = true;
        }
        for (const key of ['translation', 'editedText', 'report']) {
          if (typeof patch[key] === 'string') meta[key] = patch[key].slice(0, 200_000);
        }
        if (!meta.segments && patch.correction !== undefined) {
          if (patch.correction === null) delete meta.correction;
          else meta.correction = patch.correction.trim();
        }
        if (!meta.segments && typeof patch.text === 'string') meta.text = patch.text.slice(0, 200_000);
        if (typeof patch.title === 'string' && patch.title.trim()) {
          meta.title = cleanTitle(patch.title);
          meta.customTitle = true;
        }
        if (meta.segments && meta.status === 'recording' && ['complete', 'interrupted'].includes(patch.status)) {
          meta.status = patch.status;
          meta.duration = Math.max(meta.duration, Number(patch.duration) || 0);
        }
      });
    },

    remove(id) {
      return serialize(checkId(id), async () => {
        const meta = await readMeta(id);
        if (meta.audioFile) await rm(audioPath(meta), { force: true });
        if (meta.segments) await rm(partDir(id), { recursive: true, force: true });
        await rm(metaFile(id), { force: true });
        return meta;
      });
    },

    async audioStat(meta) {
      if (meta.segments) {
        if (!meta.size) throw new StorageError(404, '录音没有音频文件');
        await requireDirectory(partDir(meta.id));
        return { size: meta.size + (meta.systemPcm ? 44 : 0) };
      }
      try {
        const info = await archiveFileInfo(audioPath(meta));
        return { size: Number(info.size) };
      } catch (error) {
        if (error?.code === 'ENOENT') throw new StorageError(404, '录音音频不存在');
        throw error;
      }
    },

    audioStream(meta, { start, end }) {
      if (!meta.segments) return Readable.from(streamArchiveFile(audioPath(meta), start, end));
      return Readable.from((async function* () {
        await requireDirectory(partDir(meta.id));
        let offset = 0;
        if (meta.systemPcm) {
          if (start < 44) yield pcmWaveHeader(meta.size).subarray(start, Math.min(end + 1, 44));
          offset = 44;
        }
        for (let sequence = 0; sequence < meta.chunkCount && offset <= end; sequence += 1) {
          const file = partFile(meta.id, sequence);
          const size = Number((await archiveFileInfo(file)).size);
          const localStart = Math.max(0, start - offset);
          const localEnd = Math.min(size - 1, end - offset);
          if (localStart <= localEnd) {
            yield* streamArchiveFile(file, localStart, localEnd);
          }
          offset += size;
        }
      })());
    },
  };
}
