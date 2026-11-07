// Детерминированный расчёт итогового балла по правилам чек-листа (стр. 2 PDF).
// LLM выставляет только ответы по критериям; арифметику делает код.

const round = (x, d = 2) => (x == null ? null : Math.round((x + Number.EPSILON) * 10 ** d) / 10 ** d);

export function scaleMax(criterion) {
  return Math.max(...(criterion.scale || []).map((s) => Number(s.value)));
}

/** Баллы критерия ДО перераспределения весов (0..weight) или null для N/A / флагов. */
export function rawPoints(criterion, answer) {
  if (criterion.type === 'flag') return null;
  if (answer === 'na') return null;
  const w = Number(criterion.weight) || 0;
  if (criterion.type === 'binary') return answer === 'yes' ? w : 0;
  if (criterion.type === 'scale') {
    const max = scaleMax(criterion);
    const v = Number(answer);
    if (!Number.isFinite(v) || max <= 0) return 0;
    return (v / max) * w; // верхняя ступень даёт полный вес
  }
  return null;
}

/**
 * @param checklist снимок чек-листа
 * @param answers   { [criterion_id]: 'yes'|'no'|'na'|number-string }
 */
export function computeScore(checklist, answers) {
  const digits = Number.isInteger(checklist.rounding) ? checklist.rounding : 2;
  const scored = checklist.criteria.filter((c) => c.type !== 'flag' && Number(c.weight) > 0);
  const totalWeight = scored.reduce((s, c) => s + Number(c.weight), 0); // обычно 100
  const applicable = scored.filter((c) => answers[c.id] !== 'na' && answers[c.id] != null);
  const applicableWeight = applicable.reduce((s, c) => s + Number(c.weight), 0);
  const factor = applicableWeight > 0 ? totalWeight / applicableWeight : 0;

  const perCriterion = {};
  for (const c of checklist.criteria) {
    const a = answers[c.id];
    const raw = rawPoints(c, a);
    const isScored = c.type !== 'flag' && Number(c.weight) > 0;
    perCriterion[c.id] = {
      answer: a,
      base_weight: Number(c.weight) || 0,
      effective_weight: isScored && a !== 'na' ? round(Number(c.weight) * factor, 4) : 0,
      raw_points: raw == null ? null : round(raw, 4),
      points: raw == null ? null : round(raw * factor, 4),
      max_points: isScored && a !== 'na' ? round(Number(c.weight) * factor, 4) : null,
    };
  }

  const total = applicableWeight > 0
    ? round(applicable.reduce((s, c) => s + perCriterion[c.id].raw_points, 0) * factor, digits)
    : null; // нет применимых критериев с весом — итог не рассчитывается

  const sections = (checklist.sections || []).map((sec) => {
    const items = checklist.criteria.filter((c) => c.section === sec.id && c.type !== 'flag' && Number(c.weight) > 0);
    if (!items.length) return null;
    const app = items.filter((c) => answers[c.id] !== 'na');
    const pts = app.reduce((s, c) => s + perCriterion[c.id].raw_points * factor, 0);
    const max = app.reduce((s, c) => s + Number(c.weight) * factor, 0);
    return {
      id: sec.id, name: sec.name,
      points: app.length ? round(pts, digits) : null,
      max: app.length ? round(max, digits) : null,
      percent: app.length && max > 0 ? round((pts / max) * 100, 1) : null,
    };
  }).filter(Boolean);

  const flags = checklist.criteria.filter((c) => c.type === 'flag');
  const gross = flags.filter((c) => answers[c.id] === 'yes').map((c) => ({ id: c.id, name: c.name }));

  return {
    total, max: totalWeight, applicable_weight: applicableWeight,
    redistribution_factor: round(factor, 4),
    sections, per_criterion: perCriterion,
    gross_error: gross.length > 0, gross_errors: gross,
  };
}

/** Допустимые ответы критерия. */
export function allowedAnswers(c) {
  if (c.type === 'scale') {
    const vals = (c.scale || []).map((s) => String(s.value));
    return c.na_allowed ? [...vals, 'na'] : vals;
  }
  return c.na_allowed && c.type !== 'flag' ? ['yes', 'no', 'na'] : ['yes', 'no'];
}

/** Приводит ответ модели к допустимому значению. Возвращает { answer, warning }. */
export function normalizeAnswer(c, raw) {
  let a = String(raw ?? '').trim().toLowerCase();
  const map = { 'да': 'yes', 'иә': 'yes', 'true': 'yes', 'нет': 'no', 'жоқ': 'no', 'false': 'no', 'n/a': 'na', 'н/д': 'na', 'na': 'na' };
  if (map[a]) a = map[a];
  if (c.type === 'scale') {
    if (a === 'na') {
      if (c.na_allowed) return { answer: 'na' };
      return { answer: String(Math.min(...c.scale.map((s) => s.value))), warning: 'N/A недопустим — поставлена нижняя ступень' };
    }
    const v = Number(a.replace(',', '.'));
    if (!Number.isFinite(v)) return { answer: String(Math.min(...c.scale.map((s) => s.value))), warning: `Непонятный ответ «${raw}»` };
    const nearest = c.scale.reduce((best, s) => (Math.abs(s.value - v) < Math.abs(best.value - v) ? s : best));
    return { answer: String(nearest.value), warning: nearest.value !== v ? `Значение ${v} приведено к ступени ${nearest.value}` : undefined };
  }
  if (a === 'na' && !(c.na_allowed && c.type !== 'flag')) return { answer: 'no', warning: 'N/A недопустим для критерия — поставлено «Нет»' };
  if (!['yes', 'no', 'na'].includes(a)) return { answer: 'no', warning: `Непонятный ответ «${raw}»` };
  return { answer: a };
}

export function answerLabel(c, a) {
  if (a == null) return '—';
  if (a === 'na') return 'N/A';
  if (c.type === 'scale') return `${a} / ${scaleMax(c)}`;
  return a === 'yes' ? 'Да' : 'Нет';
}
