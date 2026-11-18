import { createHash, randomUUID } from 'node:crypto';
import { CheckError, checkSource } from './meeting-check.js';

const fields = ['unitIds', 'status', 'literal', 'possible', 'alternatives', 'uncertainty', 'question'];
const text = (value) => typeof value === 'string' && value.trim().length > 0 && value.length <= 500;

export function interpretationSource(meta) {
  const source = checkSource(meta);
  if (!meta.meeting) return source;
  const attribution = meta.meeting.turns.map((turn) => [turn.speakerId ?? null, Boolean(turn.overlap)]);
  return {
    ...source,
    hash: createHash('sha256').update(JSON.stringify([source.hash, attribution])).digest('hex'),
    units: source.units.map((unit) => ({ ...unit,
      ambiguous: !meta.meeting.turns[unit.group].speakerId || Boolean(meta.meeting.turns[unit.group].overlap),
    })),
  };
}

/** The model selects existing units; quotes and timestamps always come from storage. */
export function parseInterpretation(raw, source) {
  let body;
  try { body = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')); }
  catch { throw new CheckError('invalidResult', 502); }
  if (!body || Object.keys(body).length !== 1 || !Array.isArray(body.items) || body.items.length > 8) {
    throw new CheckError('invalidResult', 502);
  }
  const seen = new Set();
  return body.items.map((row) => {
    if (!row || Object.keys(row).length !== fields.length || !fields.every((field) => Object.hasOwn(row, field)) ||
        !Array.isArray(row.unitIds) || row.unitIds.length < 1 || row.unitIds.length > 3 ||
        !['possible', 'uncertain'].includes(row.status) || !text(row.literal) || !text(row.uncertainty) || !text(row.question) ||
        !Array.isArray(row.alternatives) || row.alternatives.length < 1 || row.alternatives.length > 3 ||
        !row.alternatives.every(text) ||
        (row.status === 'possible' ? !text(row.possible) : row.possible !== null)) {
      throw new CheckError('invalidResult', 502);
    }
    const units = row.unitIds.map((id, i) => {
      const unit = source.units[id - 1];
      if (!Number.isSafeInteger(id) || !unit || unit.id !== id || seen.has(id) ||
          (i && (id !== row.unitIds[i - 1] + 1 || unit.group !== source.units[row.unitIds[0] - 1].group))) {
        throw new CheckError('invalidResult', 502);
      }
      seen.add(id);
      return unit;
    });
    const first = units[0], last = units.at(-1);
    const attributionUncertain = units.some((unit) => unit.ambiguous);
    return {
      unitIds: row.unitIds, status: attributionUncertain ? 'uncertain' : row.status, attributionUncertain,
      quote: units.map((unit) => unit.text).join(''), start: first.start,
      before: source.units[first.id - 2]?.text ?? '', after: source.units[last.id]?.text ?? '',
      literal: row.literal.trim(), possible: attributionUncertain ? null : row.possible?.trim() ?? null,
      alternatives: row.alternatives.map((value) => value.trim()), uncertainty: row.uncertainty.trim(), question: row.question.trim(),
    };
  }).sort((a, b) => a.unitIds[0] - b.unitIds[0]);
}

export function newInterpretation(source, items, topic, model, language) {
  return { id: randomUUID(), sourceHash: source.hash, items, topic, model, language, createdAt: new Date().toISOString() };
}

export function interpretationView(meta) {
  if (!meta.interpretation) return null;
  const source = interpretationSource(meta);
  return { ...meta.interpretation, stale: meta.interpretation.sourceHash !== source.hash || source.state !== 'ready' };
}

export function interpretationText(report, language) {
  const zh = language === 'zh';
  const labels = zh
    ? ['表达解读（潜台词）', '实验功能。以下为可能解释，不代表真实意图或事实。', '原话', '字面信息', '可能含义（推测）', '其他解释', '不确定之处', '澄清问法', '无法判断', '未发现需要解读的表达。']
    : ['Expression interpretation (subtext)', 'Experimental. Possible readings, not verified intent or facts.', 'Original words', 'Literal reading', 'Possible meaning (inference)', 'Other explanations', 'Uncertainty', 'Clarifying question', 'Cannot determine', 'No expressions requiring interpretation were found.'];
  const [title, notice, quote, literal, possible, alternatives, uncertainty, question, unknown, empty] = labels;
  const heading = `${title}\n${notice}\n${report.model.provider} / ${report.model.model}\n${report.createdAt}\n${report.topic}\n`;
  return heading + (report.items.length ? report.items.map((item, i) => {
    const time = item.start === null ? '' : ` [${Math.floor(item.start / 60)}:${String(Math.floor(item.start % 60)).padStart(2, '0')}]`;
    const context = (item.before ? `\n${zh ? '前文' : 'Before'}: ${item.before}` : '') +
      (item.after ? `\n${zh ? '后文' : 'After'}: ${item.after}` : '');
    const attribution = item.attributionUncertain ? (zh ? '该段有重叠发言或说话人归属不明，暂不推测含义。' : 'Overlapping speech or uncertain attribution: interpretation withheld.') + ' ' : '';
    return `\n${i + 1}.${time}\n${quote}: ${item.quote}${context}\n${literal}: ${item.literal}\n${possible}: ${item.status === 'uncertain' ? unknown : item.possible}\n${alternatives}:\n${item.alternatives.map((value) => '- ' + value).join('\n')}\n${uncertainty}: ${attribution}${item.uncertainty}\n${question}: ${item.question}\n`;
  }).join('') : `\n${empty}\n`);
}
