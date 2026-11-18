import assert from 'node:assert/strict';
import { test } from 'node:test';
import { interpretationSource, parseInterpretation, newInterpretation, interpretationView, interpretationText } from '../meeting-interpretation.js';

const row = { unitIds: [2], status: 'possible', literal: '稍后再确认。', possible: '可能还没有最终决定。',
  alternatives: ['只是安排在稍后确认。'], uncertainty: '缺少后续讨论。', question: '请问稍后需要确认哪些事项？' };
const meta = () => ({ meeting: { turns: [
  { start: 1, speakerId: 1, text: '先确认本次会议的验收范围。稍后再确认。请保留必要的测试步骤。' },
  { start: 20, speakerId: 2, text: '会议安排与测试确认。'.repeat(30) },
] } });

test('interpretation quotes, adjacent context and timestamps are resolved from original units', () => {
  const source = interpretationSource(meta());
  const [item] = parseInterpretation(JSON.stringify({ items: [row] }), source);
  assert.equal(item.quote, '稍后再确认。');
  assert.equal(item.start, 1);
  assert.equal(item.before, '先确认本次会议的验收范围。');
  assert.equal(item.after, '请保留必要的测试步骤。');
  assert.equal(item.possible, row.possible);
  assert.deepEqual(parseInterpretation('```json\n{"items":[]}\n```', source), []);
});

test('interpretation rejects fabricated, repeated or cross-speaker citations and malformed uncertainty', () => {
  const source = interpretationSource(meta());
  const invalidRows = [
    { ...row, unitIds: [] }, { ...row, unitIds: [9999] }, { ...row, unitIds: ['2'] },
    { ...row, unitIds: [2, 2] }, { ...row, unitIds: [1, 3] }, { ...row, unitIds: [3, 4] },
    { ...row, quote: 'fabricated' }, { ...row, confidence: 99 }, { ...row, status: 'certain' },
    { ...row, status: 'uncertain' }, { ...row, alternatives: [] }, { ...row, question: '' },
    { ...row, uncertainty: '' }, { ...row, literal: 'x'.repeat(501) },
  ];
  for (const item of invalidRows) assert.throws(() => parseInterpretation(JSON.stringify({ items: [item] }), source), { code: 'invalidResult' });
  for (const body of [{ items: [row, row] }, { items: Array(9).fill(row) }, { items: [], score: 0 }, { items: null }]) {
    assert.throws(() => parseInterpretation(JSON.stringify(body), source), { code: 'invalidResult' });
  }
  assert.throws(() => parseInterpretation('{not JSON', source), { code: 'invalidResult' });
  const [unknown] = parseInterpretation(JSON.stringify({ items: [{ ...row, status: 'uncertain', possible: null }] }), source);
  assert.equal(unknown.possible, null);
});

test('reports retain their source snapshot, become stale on edits, and export uncertainty in both languages', () => {
  const original = meta(), source = interpretationSource(original);
  const items = parseInterpretation(JSON.stringify({ items: [{ ...row, status: 'uncertain', possible: null }] }), source);
  original.interpretation = newInterpretation(source, items, '验收', { provider: 'example', model: 'example' }, 'zh');
  const report = interpretationView(original);
  assert.equal(report.stale, false);
  assert.match(interpretationText(report, 'zh'), /表达解读（潜台词）/);
  assert.match(interpretationText(report, 'zh'), /无法判断/);
  assert.match(interpretationText(report, 'en'), /Cannot determine/);
  assert.match(interpretationText(report, 'en'), /Before: 先确认/);
  original.meeting.turns[0].correction = '修正后的原话。';
  assert.equal(interpretationView(original).stale, true);
  assert.equal(interpretationView(original).items[0].quote, '稍后再确认。');
});

test('overlapping or unattributed turns withhold inferred meaning; attribution edits invalidate the report', () => {
  const original = meta();
  original.meeting.turns[0].overlap = true;
  original.meeting.speakers = [{ id: 1, name: 'Synthetic display name' }];
  const source = interpretationSource(original);
  assert.ok(!JSON.stringify(source).includes('Synthetic display name'));
  const [item] = parseInterpretation(JSON.stringify({ items: [row] }), source);
  assert.equal(item.status, 'uncertain');
  assert.equal(item.possible, null);
  assert.equal(item.attributionUncertain, true);
  original.interpretation = newInterpretation(source, [item], '', { provider: 'example', model: 'example' }, 'zh');
  original.meeting.speakers[0].name = 'Renamed display name';
  assert.equal(interpretationView(original).stale, false);
  original.meeting.turns[0].speakerId = 2;
  assert.equal(interpretationView(original).stale, true);
});
