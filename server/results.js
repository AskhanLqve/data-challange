// Выгрузка результатов в формате организаторов (Results JSON 1.0, приложение к гайду).
// results/dev/results.json — DEV, results/prod/results.json — контрольный набор.
import { computeScore } from './scoring.js';

export const SCHEMA_VERSION = '1.0';

// Коды критериев из приложения к гайду и допустимые значения.
export const OFFICIAL = {
  contact: { kind: 'bool' },
  discovery: { kind: 'bool', nullable: true },
  identification: { kind: 'bool', nullable: true },
  consultation: { kind: 'scale', steps: [0, 5, 10, 15, 20], nullable: true },
  empathy: { kind: 'bool' },
  dialogue: { kind: 'scale', steps: [0, 4, 7, 10] },
  closure: { kind: 'bool', nullable: true },
  critical: { kind: 'bool' },
};
// Соответствие исходного чек-листа (если в критерии нет export_id).
const DEFAULT_EXPORT_IDS = { c01: 'contact', c02: 'discovery', c03: 'identification', c04: 'consultation', c05: 'empathy', c06: 'dialogue', c07: 'closure', c08: 'critical' };

export const exportId = (c) => c.export_id || DEFAULT_EXPORT_IDS[c.id] || c.id;

/** Ответ системы → value формата: true / false / null / число ступени. */
export function toValue(c, answer) {
  if (answer == null || answer === 'na') return null;
  if (c.type === 'scale') return Number(answer);
  return answer === 'yes';
}

/**
 * Запись результата по последней оценке диалога.
 * @param use 'ai' — исходный ответ ИИ (по умолчанию), 'final' — с учётом решений по апелляциям
 */
export function buildRecord(conversationId, ev, { use = 'ai' } = {}) {
  if (!ev) return { conversation_id: conversationId, status: 'error', criteria: [], score: null, error: 'Диалог не оценён системой.' };
  const answers = Object.fromEntries(ev.criteria.map((c) => [c.criterion_id, use === 'final' ? c.final_answer : c.ai.answer]));
  const score = computeScore(ev.checklist, answers);
  const criteria = ev.checklist.criteria.map((c) => {
    const r = ev.criteria.find((x) => x.criterion_id === c.id);
    const turns = [...new Set((r?.ai.evidence || []).map((e) => e.message))].sort((a, b) => a - b);
    const range = r?.ai.checked_range;
    return {
      criterion_id: exportId(c),
      value: toValue(c, answers[c.id]),
      rationale: (r?.review && use === 'final' ? `${r.ai.explanation} Пересмотр: ${r.review.reason}` : r?.ai.explanation || '').trim(),
      evidence_turns: turns.length ? turns : range ? [range.from] : [],
    };
  });
  return {
    conversation_id: conversationId,
    status: 'ok',
    criteria,
    score: { final_score: score.total == null ? null : Math.round(score.total * 100) / 100, critical_flag: score.gross_error },
  };
}

export function buildResults({ conversationIds, latestEval, teamName, use = 'ai' }) {
  const records = conversationIds.map((id) => buildRecord(id, latestEval(id), { use }));
  const evs = conversationIds.map(latestEval).filter(Boolean);
  const providers = new Set(evs.map((e) => e.provider));
  const models = [...new Set(evs.map((e) => e.model))];
  const mode = providers.size > 1 ? 'hybrid' : providers.has('ollama') ? 'local' : 'external_api';
  return {
    schema_version: SCHEMA_VERSION,
    team_name: teamName || process.env.CQA_TEAM_NAME || 'CQA',
    model: { mode, name: models.join(', ') || 'нет оценок' },
    results: records,
  };
}

/** Проверка по правилам приложения. Возвращает список проблем (пустой — всё в порядке). */
export function validateResults(doc, { expectCount, transcriptLengths } = {}) {
  const errs = [];
  if (doc.schema_version !== SCHEMA_VERSION) errs.push(`schema_version должен быть "${SCHEMA_VERSION}"`);
  if (!doc.team_name) errs.push('пустой team_name');
  if (!['local', 'external_api', 'hybrid'].includes(doc.model?.mode)) errs.push('model.mode: local | external_api | hybrid');
  if (!doc.model?.name) errs.push('пустой model.name');
  if (!Array.isArray(doc.results)) return [...errs, 'results должен быть массивом'];
  if (expectCount != null && doc.results.length !== expectCount) errs.push(`ожидается ${expectCount} записей, сейчас ${doc.results.length}`);
  const seen = new Set();
  for (const r of doc.results) {
    const id = r.conversation_id;
    if (!id) { errs.push('запись без conversation_id'); continue; }
    if (seen.has(id)) errs.push(`${id}: повторяющийся ID`);
    seen.add(id);
    if (r.status === 'error') {
      if (!Array.isArray(r.criteria) || r.criteria.length) errs.push(`${id}: при ошибке criteria должен быть пустым массивом`);
      if (r.score !== null) errs.push(`${id}: при ошибке score должен быть null`);
      if (!r.error) errs.push(`${id}: при ошибке нужна причина в error`);
      continue;
    }
    if (r.status !== 'ok') { errs.push(`${id}: status должен быть ok или error`); continue; }
    const codes = r.criteria.map((c) => c.criterion_id);
    for (const code of Object.keys(OFFICIAL)) {
      const n = codes.filter((x) => x === code).length;
      if (n !== 1) errs.push(`${id}: критерий ${code} встречается ${n} раз`);
    }
    for (const c of r.criteria) {
      const spec = OFFICIAL[c.criterion_id];
      if (!spec) { errs.push(`${id}: неизвестный код критерия ${c.criterion_id}`); continue; }
      const v = c.value;
      const ok = v === null ? !!spec.nullable : spec.kind === 'bool' ? typeof v === 'boolean' : Number.isInteger(v) && spec.steps.includes(v);
      if (!ok) errs.push(`${id}: ${c.criterion_id} = ${JSON.stringify(v)} — недопустимое значение`);
      if (typeof c.rationale !== 'string' || !c.rationale.trim()) errs.push(`${id}: ${c.criterion_id} — пустой rationale`);
      if (!Array.isArray(c.evidence_turns) || c.evidence_turns.some((t) => !Number.isInteger(t) || t < 1)) errs.push(`${id}: ${c.criterion_id} — evidence_turns должны быть номерами реплик с 1`);
      const max = transcriptLengths?.[id];
      if (max && c.evidence_turns?.some((t) => t > max)) errs.push(`${id}: ${c.criterion_id} — номер реплики больше длины транскрипта (${max})`);
    }
    const fs = r.score?.final_score;
    if (fs !== null && (typeof fs !== 'number' || fs < 0 || fs > 100 || Math.round(fs * 100) / 100 !== fs)) errs.push(`${id}: final_score должен быть числом 0–100 с двумя знаками`);
    const crit = r.criteria.find((c) => c.criterion_id === 'critical')?.value;
    if (r.score?.critical_flag !== crit) errs.push(`${id}: critical_flag должен совпадать с value критерия critical`);
  }
  return errs;
}
