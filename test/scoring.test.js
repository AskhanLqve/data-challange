import test from 'node:test';
import assert from 'node:assert/strict';
import { computeScore, normalizeAnswer } from '../server/scoring.js';
import { DEFAULT_CHECKLIST as CL } from '../server/defaultChecklist.js';

const all = (o) => ({ c01: 'yes', c02: 'yes', c03: 'yes', c04: '20', c05: 'yes', c06: '10', c07: 'yes', c08: 'no', ...o });

test('все «Да» и верхние ступени дают 100', () => {
  const s = computeScore(CL, all());
  assert.equal(s.total, 100);
  assert.equal(s.gross_error, false);
});

test('шкала пересчитывается пропорционально весу', () => {
  // c04: 15/20 * 20 = 15 (−5); c06: 7/10 * 15 = 10.5 (−4.5)
  assert.equal(computeScore(CL, all({ c04: '15', c06: '7' })).total, 90.5);
});

test('N/A перераспределяет вес, максимум остаётся 100', () => {
  // c03 N/A (20), c01 = Нет (10): 70 / 80 * 100 = 87.5
  const s = computeScore(CL, all({ c03: 'na', c01: 'no' }));
  assert.equal(s.total, 87.5);
  assert.equal(s.per_criterion.c03.points, null);
  assert.equal(s.per_criterion.c01.max_points, 12.5);
});

test('округление до двух знаков', () => {
  // c02 N/A, c07 N/A → применимо 80; c06 = 4 → 6 из 15; (65+6)/80*100 = 88.75
  assert.equal(computeScore(CL, all({ c02: 'na', c07: 'na', c06: '4' })).total, 88.75);
  // c02 N/A (85 применимо), c01 Нет: 75/85*100 = 88.235… → 88.24
  assert.equal(computeScore(CL, all({ c02: 'na', c01: 'no' })).total, 88.24);
});

test('грубая ошибка отмечается отдельно и не меняет баллы', () => {
  const s = computeScore(CL, all({ c08: 'yes' }));
  assert.equal(s.total, 100);
  assert.equal(s.gross_error, true);
});

test('нет применимых критериев — итог не рассчитывается', () => {
  const cl = { ...CL, criteria: CL.criteria.filter((c) => c.na_allowed || c.type === 'flag') };
  const s = computeScore(cl, { c02: 'na', c03: 'na', c04: 'na', c07: 'na', c08: 'no' });
  assert.equal(s.total, null);
});

test('нормализация ответов модели', () => {
  const c04 = CL.criteria.find((c) => c.id === 'c04');
  const c01 = CL.criteria.find((c) => c.id === 'c01');
  assert.equal(normalizeAnswer(c04, '14').answer, '15');
  assert.equal(normalizeAnswer(c01, 'na').answer, 'no');
  assert.equal(normalizeAnswer(c01, 'Да').answer, 'yes');
});
