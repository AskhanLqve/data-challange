import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRecord, buildResults, validateResults, toValue } from '../server/results.js';
import { computeScore } from '../server/scoring.js';
import { DEFAULT_CHECKLIST as CL } from '../server/defaultChecklist.js';

const ANS = { c01: 'yes', c02: 'na', c03: 'na', c04: '20', c05: 'yes', c06: '10', c07: 'no', c08: 'no' };
const fakeEval = (answers = ANS) => ({
  provider: 'ollama', model: 'qwen2.5:7b-instruct', checklist: CL,
  criteria: CL.criteria.map((c) => ({ criterion_id: c.id, final_answer: answers[c.id], ai: { answer: answers[c.id], explanation: 'Обоснование', evidence: [{ message: 10 }, { message: 10 }, { message: 2 }] } })),
});

test('значения переводятся по правилам приложения', () => {
  const c = (id) => CL.criteria.find((x) => x.id === id);
  assert.equal(toValue(c('c01'), 'yes'), true);
  assert.equal(toValue(c('c02'), 'na'), null);
  assert.equal(toValue(c('c04'), '15'), 15);
  assert.equal(toValue(c('c08'), 'no'), false);
});

test('запись: коды критериев, итог, флаг, реплики без повторов', () => {
  const r = buildRecord('p1-ru-001', fakeEval());
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.criteria.map((c) => c.criterion_id), ['contact', 'discovery', 'identification', 'consultation', 'empathy', 'dialogue', 'closure', 'critical']);
  assert.equal(r.score.final_score, computeScore(CL, ANS).total);
  assert.equal(r.score.final_score, 92.31);
  assert.equal(r.score.critical_flag, false);
  assert.deepEqual(r.criteria[0].evidence_turns, [2, 10]);
});

test('неоценённый диалог — status error, без нулевой оценки', () => {
  const doc = buildResults({ conversationIds: ['a', 'b'], latestEval: (id) => (id === 'a' ? fakeEval() : undefined), teamName: 'T' });
  assert.equal(doc.results[1].status, 'error');
  assert.deepEqual(doc.results[1].criteria, []);
  assert.equal(doc.results[1].score, null);
  assert.equal(doc.model.mode, 'local');
  assert.deepEqual(validateResults(doc), []);
});

test('проверка ловит нарушения формата', () => {
  const doc = buildResults({ conversationIds: ['a'], latestEval: () => fakeEval(), teamName: 'T' });
  doc.results.push(structuredClone(doc.results[0]));
  doc.results[0].criteria[5].value = 8;
  doc.results[0].score.critical_flag = true;
  const p = validateResults(doc, { expectCount: 10 });
  assert.ok(p.some((x) => /ожидается 10/.test(x)));
  assert.ok(p.some((x) => /повторяющийся ID/.test(x)));
  assert.ok(p.some((x) => /dialogue = 8/.test(x)));
  assert.ok(p.some((x) => /critical_flag/.test(x)));
});
