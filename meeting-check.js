import { createHash, randomUUID } from 'node:crypto';

export class CheckError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export const categories = ['keep', 'repeat', 'filler', 'offtopic', 'uncertain'];
export const countCharacters = (text) => [...text.matchAll(/[\p{L}\p{N}]/gu)].length;
const joinUnits = (units) => units.map((unit, i) =>
  (i && unit.group !== units[i - 1].group ? '\n' : '') + unit.text).join('');

/** Sentence fragments retain their exact source text and parent turn timestamp. */
export function checkSource(meta) {
  let parts;
  if (meta.meeting) parts = meta.meeting.turns;
  else if (meta.segments?.length) parts = meta.segments;
  else parts = [{ text: meta.correction ?? meta.text ?? '' }];
  const units = [];
  for (const [group, part] of parts.entries()) {
    const text = part.correction ?? part.text ?? '';
    const sentences = text.match(/[^。！？!?\n]+[。！？!?\n]*|[。！？!?\n]+/gu) ?? [];
    for (const sentence of sentences) {
      // Bound model output size without dropping long or unpunctuated passages.
      const characters = [...sentence];
      for (let i = 0; i < characters.length; i += 400) {
        const text = characters.slice(i, i + 400).join('');
        if (!countCharacters(text)) {
          if (units.length) units.at(-1).text += text;
          continue;
        }
        units.push({ id: units.length + 1, group, text, start: Number.isFinite(part.start) ? part.start : null });
      }
    }
  }
  const chars = units.reduce((n, unit) => n + countCharacters(unit.text), 0);
  const hash = createHash('sha256').update(JSON.stringify(units)).digest('hex');
  const pending = meta.meeting
    ? meta.meeting.turns.some((part) => !countCharacters(part.correction ?? part.text ?? ''))
    : meta.segments?.some((part) => part.state !== 'ready');
  const textLength = units.reduce((n, unit) => n + unit.text.length, 0);
  const state = meta.status === 'recording' || pending ? 'pending' : chars < 200 ? 'short'
    : chars > 40_000 || textLength > 80_000 || units.length > 1000 ? 'tooLong' : 'ready';
  return { hash, chars, units, state, text: joinUnits(units) };
}

export function checkBatches(units) {
  const batches = [];
  let batch = [], size = 0;
  for (const unit of units) {
    if (batch.length && (batch.length >= 40 || size + unit.text.length > 6000)) {
      batches.push(batch);
      batch = []; size = 0;
    }
    batch.push(unit);
    size += unit.text.length;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export function parseLabels(raw, units, topic) {
  let result;
  try { result = JSON.parse(raw.trim().replace(/^\x60\x60\x60(?:json)?\s*/i, '').replace(/\x60\x60\x60\s*$/, '')); }
  catch { throw new CheckError('invalidResult', 502); }
  if (!Array.isArray(result) || result.length !== units.length) throw new CheckError('invalidResult', 502);
  const ids = new Set(units.map(({ id }) => id)), seen = new Set();
  return result.map((row) => {
    if (!row || !ids.has(row.id) || seen.has(row.id) || !categories.includes(row.category) ||
        (!topic && row.category === 'offtopic') ||
        typeof row.reason !== 'string' || !row.reason.trim() || row.reason.length > 500) {
      throw new CheckError('invalidResult', 502);
    }
    seen.add(row.id);
    return { id: row.id, category: row.category, reason: row.reason.trim(), retained: false };
  });
}

export function checkView(meta) {
  const check = meta.check;
  if (!check) return null;
  const source = checkSource(meta);
  const stale = source.hash !== check.sourceHash || source.state !== 'ready';
  const counts = Object.fromEntries(categories.map((key) => [key, 0]));
  const byId = new Map(check.labels.map((row) => [row.id, row]));
  const units = check.units.map((unit) => {
    const label = byId.get(unit.id);
    const category = label.retained ? 'keep' : label.category;
    counts[category] += countCharacters(unit.text);
    return { ...unit, ...label };
  });
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const removed = counts.repeat + counts.filler + counts.offtopic;
  const uncertain = total ? Math.round(counts.uncertain * 100 / total) : 100;
  const assessable = !stale && uncertain < 40 && total >= 200;
  return {
    ...check, labels: undefined, units, stale, counts, total, removed, uncertain,
    percent: assessable ? Math.round(removed * 100 / total) : null,
    compact: stale ? '' : joinUnits(units.filter((unit) => unit.retained || ['keep', 'uncertain'].includes(unit.category))),
  };
}

export function newCheck(source, labels, topic, model, language = 'zh') {
  return {
    id: randomUUID(), revision: 0, sourceHash: source.hash, units: source.units, labels,
    topic, model, language, createdAt: new Date().toISOString(),
  };
}
