import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkSource, checkBatches, parseLabels, newCheck, checkView, countCharacters } from '../meeting-check.js';

test('source units preserve text, unicode counts and parent timestamps without speaker names', () => {
  const meta = { meeting: { speakers: [{ id: 1, name: 'Private Name' }], turns: [
    { start: 1, text: '甲乙。 123！', correction: '修正版。' },
    { start: 3, text: '𠀀 alpha?\nNext line.' },
  ] } };
  const source = checkSource(meta);
  assert.equal(source.units.map((unit) => unit.text).join(''), '修正版。𠀀 alpha?\nNext line.');
  assert.equal(source.units[0].start, 1);
  assert.equal(source.units[1].start, 3);
  assert.equal(source.text, '修正版。\n𠀀 alpha?\nNext line.');
  assert.equal(countCharacters('𠀀a 1,！？'), 3);
  assert.ok(!JSON.stringify(source).includes('Private Name'));
  assert.equal(checkSource({ ...meta, check: { id: 'x' } }).hash, source.hash);
});

test('model labels require complete, unique, supported source IDs and a topic for off-topic labels', () => {
  const units = [{ id: 1 }, { id: 2 }];
  const label = { id: 1, category: 'repeat', reason: 'Repeated information' };
  for (const bad of [
    [], [label, label], [label, { ...label, id: 3 }],
    [label, { ...label, id: 2, category: 'unknown' }],
    [label, { ...label, id: 2, category: 'offtopic' }],
    [label, { ...label, id: 2, reason: '' }],
  ]) assert.throws(() => parseLabels(JSON.stringify(bad), units, ''), { code: 'invalidResult' });
  assert.equal(parseLabels(JSON.stringify([label, { ...label, id: 2 }]), units, '').length, 2);
});

test('complete speaker transcripts supersede failed interim text; missing turns prevent a score', () => {
  const meta = { segments: [{ state: 'failed' }], meeting: { turns: [
    { text: '会议安排与测试确认。'.repeat(30), start: 0 },
    { text: '', overlap: true, start: 10 },
  ] } };
  assert.equal(checkSource(meta).state, 'pending');
  meta.meeting.turns[1].correction = '补全这段重叠发言。';
  assert.equal(checkSource(meta).state, 'ready');
});

test('uncertain coverage hides the gauge; compact text retains uncertainty and manual decisions', () => {
  const source = checkSource({ text: '重要信息。'.repeat(100) });
  const labels = source.units.map(({ id }) => ({ id, category: id <= 45 ? 'uncertain' : 'repeat', reason: 'Review', retained: false }));
  const meta = { text: source.units.map(({ text }) => text).join(''), check: newCheck(source, labels, '', { provider: 'test', model: 'test' }) };
  assert.equal(checkView(meta).percent, null);
  assert.equal(checkView(meta).uncertain, 45);
  assert.equal(checkView(meta).compact, '重要信息。'.repeat(45));
  meta.check.labels.forEach((label) => { label.retained = true; });
  assert.equal(checkView(meta).percent, 0);
  assert.equal(checkView(meta).compact, meta.text);
  const batches = checkBatches(source.units);
  assert.equal(batches.flat().length, source.units.length);
  assert.ok(batches.every((batch) => batch.length <= 40));
});
