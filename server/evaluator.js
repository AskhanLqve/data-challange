// Оценка диалога: промпт из конфигурации чек-листа → LLM → валидация → детерминированный расчёт.
import { z } from 'zod';
import { completeJSON, MODEL, PROVIDER, EFFORT } from './llm.js';
import { computeScore, normalizeAnswer, allowedAnswers, answerLabel } from './scoring.js';
import { db, newId } from './db.js';
import { ruleFor } from './rules.js';

const RUNS = Math.max(1, Number(process.env.CQA_RUNS || 1)); // >1 — голосование нескольких прогонов
// single — все критерии одним вызовом (сильные облачные модели, дешевле);
// per-criterion — отдельный короткий вызов на каждый критерий (точнее для небольших локальных моделей).
export const MODE = process.env.CQA_MODE || (PROVIDER === 'ollama' ? 'per-criterion' : 'single');
const LANG_NAMES = { RU: 'русский', KZ: 'казахский', EN: 'английский' };

/**
 * Схема ответа строится из чек-листа: у каждого критерия своё поле, допустимые ответы — enum.
 * Генерация ограничивается схемой (Ollama grammar / Claude structured outputs), поэтому модель
 * физически не может поставить, например, балл шкалы в критерий «Да/Нет».
 */
const criterionItem = (c) => z.object({
  // Для критериев с N/A — сначала короткая проверка фактов по условию применимости, затем решение
  // (небольшие модели без этого шага путают «Нет» и N/A).
  ...(c.na_allowed && c.type !== 'flag' ? {
    applicability_check: z.string().describe(`1–2 предложения: какие реплики и факты относятся к условию N/A «${c.na_condition || 'критерий неприменим'}»`),
    na_condition_met: z.boolean().describe(`Выполнено ли условие N/A: ${c.na_condition || 'критерий неприменим'}`),
  } : {}),
  answer: z.enum(allowedAnswers(c)),
  explanation: z.string(),
  evidence: z.array(z.object({ message: z.number().int(), quote: z.string() })),
  checked_from: z.number().int().nullable(),
  checked_to: z.number().int().nullable(),
}).describe(`${c.code ? c.code + '. ' : ''}${c.name}`);

export function buildResultSchema(checklist) {
  return z.object({
    criteria: z.object(Object.fromEntries(checklist.criteria.map((c) => [c.id, criterionItem(c)]))),
    summary: z.string(),
  });
}

function fmtClock(sec) {
  if (sec == null) return '?';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : String(m)) + ':' + String(r).padStart(2, '0');
}

function criterionBlock(c) {
  const lines = [`### [${c.id}] ${c.code ? c.code + '. ' : ''}${c.name}`];
  if (c.type === 'flag') lines.push(`Тип: флаг ДА/НЕТ, без баллов. Ответ: "yes" (нарушение есть) или "no".`);
  else if (c.type === 'binary') lines.push(`Тип: ДА/НЕТ${c.na_allowed ? '/N/A' : ''}, вес ${c.weight}. Допустимые ответы: ${allowedAnswers(c).map((a) => `"${a}"`).join(', ')}.`);
  else lines.push(`Тип: шкала${c.na_allowed ? ' / N/A' : ''}, вес ${c.weight}. Допустимые ответы: ${allowedAnswers(c).map((a) => `"${a}"`).join(', ')}.`);
  lines.push(`Условие: ${c.description}`);
  if (c.type === 'scale') for (const s of [...c.scale].sort((a, b) => b.value - a.value)) lines.push(`  - ${s.value}: ${s.label}`);
  if (c.na_allowed && c.na_condition) lines.push(`N/A только если: ${c.na_condition}`);
  if (!c.na_allowed && c.type !== 'flag') lines.push('N/A для этого критерия запрещён.');
  if (c.guidance) lines.push(`Уточнения: ${c.guidance}`);
  return lines.join('\n');
}

export function buildSystemPrompt(checklist) {
  return [
    'Ты — эксперт отдела контроля качества (QA) брокерской компании. Ты оцениваешь работу ОПЕРАТОРА в диалоге с клиентом строго по чек-листу.',
    'Диалоги бывают на русском, казахском и английском. Чек-лист один для всех языков. Объяснения пиши на русском языке, цитаты — на языке оригинала.',
    '',
    '## Общие правила',
    checklist.general_rules || '',
    '',
    '## Как отвечать',
    '- Поле criteria содержит по одному ключу на каждый критерий — его id в квадратных скобках ниже. Оценивай каждый критерий отдельно, только по его собственному условию; не переноси ответ с другого критерия.',
    '- answer — строго одно из допустимых значений критерия.',
    '- explanation — 1–3 предложения про ЭТОТ критерий: «<название критерия> — <ответ>. <что сделал или не сделал оператор>. Основание — <какие реплики>.» Пример для критерия «Завершение»: «Завершение — Нет. После ответа оператор закрыл чат без прощания. Основание — последняя реплика оператора и сообщение о закрытии чата.»',
    '- evidence — номера реплик (#N из транскрипта) и короткая точная цитата из них, подтверждающая вывод. Если действие пропущено — укажи реплику, где оно ожидалось.',
    '- checked_from / checked_to — диапазон номеров реплик, который проверялся. Обязателен, если действие пропущено («Нет») или для N/A; иначе можно null.',
    '- Для N/A объясни, какое условие неприменимости выполнено.',
    '- Не выдумывай реплики. Опирайся только на транскрипт.',
    '- summary — 1–2 предложения об общей работе оператора.',
    '',
    `## Чек-лист «${checklist.name}»`,
    ...checklist.criteria.map(criterionBlock),
  ].join('\n');
}

/** Системный промпт для режима per-criterion: общие правила + формат ответа на ОДИН критерий. */
export function buildCriterionSystemPrompt(checklist) {
  return [
    'Ты — эксперт отдела контроля качества (QA) брокерской компании. Ты оцениваешь работу ОПЕРАТОРА в диалоге с клиентом по ОДНОМУ критерию чек-листа, который указан в конце сообщения.',
    'Диалоги бывают на русском, казахском и английском. Объяснение пиши на русском, цитаты — на языке оригинала.',
    '',
    '## Общие правила',
    checklist.general_rules || '',
    '',
    '## Как отвечать',
    '- Сначала найди в транскрипте реплики, относящиеся к критерию, и внимательно прочитай их. Затем сравни с условием критерия.',
    '- Если у критерия есть поля applicability_check и na_condition_met: сначала в applicability_check перечисли факты из диалога, относящиеся к условию N/A (и уточнениям критерия), затем реши na_condition_met. Если условие выполнено — answer = "na".',
    '- «Нет» ставь только тогда, когда можешь указать конкретную реплику оператора, где он нарушил условие, или место, где нужное действие было пропущено. Если нарушения не видно — это «Да» (или верхняя ступень шкалы).',
    '- answer — строго одно из допустимых значений критерия.',
    '- explanation — 1–2 предложения: что именно сделал или не сделал оператор и в какой реплике.',
    '- evidence — номера реплик (#N) и точная короткая цитата из них. Если действие пропущено — реплика, где оно ожидалось.',
    '- checked_from / checked_to — проверенный диапазон реплик; обязателен для «Нет» и N/A, иначе null.',
    '- Не выдумывай реплики и не приписывай оператору того, чего нет в тексте.',
  ].join('\n');
}

export function buildCriterionUserPrompt(conv, c, note) {
  return [
    buildUserPrompt(conv, { withTask: false }),
    '',
    '## Критерий для оценки',
    criterionBlock(c),
    ...(note ? ['', note] : []),
    '',
    `Оцени работу оператора только по критерию «${c.name}».`,
  ].join('\n');
}

export function buildUserPrompt(conv, { withTask = true } = {}) {
  const t = conv.transcript;
  const firstOp = t.find((m) => m.speaker === 'operator');
  const lastOp = [...t].reverse().find((m) => m.speaker === 'operator');
  const lastAny = t[t.length - 1];
  // Чаты: исходная метка MM:SS. Звонки (ISO 8601): смещение от начала разговора — короче и понятнее модели.
  const isIso = (ts) => /^\d{4}-\d{2}-\d{2}T/.test(String(ts));
  const stamp = (m) => (isIso(m.timestamp) && m.offset_sec != null ? `+${fmtClock(m.offset_sec)}` : m.timestamp);
  const lines = t.map((m) => `#${m.idx} [${stamp(m)}] ${m.speaker.toUpperCase()}: ${m.text}`);
  // Подсказки по времени: длинные паузы оператора после реплики клиента.
  const pauses = [];
  for (let i = 1; i < t.length; i++) {
    const m = t[i];
    if (m.speaker !== 'operator' || m.offset_sec == null) continue;
    const prev = [...t.slice(0, i)].reverse().find((x) => x.speaker !== 'system' && x.offset_sec != null);
    if (prev && prev.speaker === 'client' && m.offset_sec - prev.offset_sec >= 90) pauses.push(`#${prev.idx}→#${m.idx}: ${fmtClock(m.offset_sec - prev.offset_sec)}`);
  }
  return [
    `Диалог ${conv.conversation_id}. Канал: ${conv.channel}. Язык клиента: ${conv.language} (${LANG_NAMES[conv.language] || conv.language}).`,
    firstOp ? `Первое сообщение оператора: #${firstOp.idx} «${firstOp.text}».` : 'Оператор в диалоге не писал.',
    lastOp && lastOp !== firstOp ? `Последнее сообщение оператора: #${lastOp.idx} «${lastOp.text}».${lastAny !== lastOp ? ` После него: #${lastAny.idx} ${lastAny.speaker.toUpperCase()}.` : ''}` : '',
    pauses.length ? `Паузы оператора ≥ 1.5 мин после реплики клиента: ${pauses.join('; ')}.` : 'Пауз оператора ≥ 1.5 мин после реплики клиента нет.',
    '',
    '<transcript>',
    ...lines,
    '</transcript>',
    ...(withTask ? ['', 'Оцени работу оператора по каждому критерию чек-листа.'] : []),
  ].join('\n');
}

export function validateRun(checklist, conv, parsed) {
  const maxIdx = conv.transcript.length;
  const byId = Array.isArray(parsed.criteria)
    ? new Map(parsed.criteria.map((c) => [c.criterion_id, c]))
    : new Map(Object.entries(parsed.criteria || {}));
  const out = {};
  for (const c of checklist.criteria) {
    const r = byId.get(c.id);
    if (!r) { out[c.id] = { answer: null, missing: true }; continue; }
    let { answer, warning } = normalizeAnswer(c, r.answer);
    if (r.na_condition_met === true && c.na_allowed && answer !== 'na') { answer = 'na'; warning = undefined; }
    if (r.na_condition_met === false && answer === 'na') warning = 'Модель отметила, что условие N/A не выполнено, но поставила N/A';
    const evidence = (r.evidence || [])
      .map((e) => ({ ...e, quote: cleanQuote(e.quote) }))
      .map((e) => ({ ...e, message: locateQuote(conv, e) }))
      .filter((e) => e.message >= 1 && e.message <= maxIdx)
      .map((e) => ({ message: e.message, quote: e.quote, quote_found: quoteIn(conv.transcript[e.message - 1]?.text, e.quote), speaker: conv.transcript[e.message - 1].speaker, timestamp: conv.transcript[e.message - 1].timestamp, offset_sec: conv.transcript[e.message - 1].offset_sec }));
    const clamp = (x) => (x == null ? null : Math.min(Math.max(1, x), maxIdx));
    out[c.id] = {
      answer, warning, explanation: r.explanation, evidence, source: r.rule ? 'rule' : 'model',
      checked_range: r.checked_from != null || r.checked_to != null ? { from: clamp(r.checked_from ?? r.checked_to), to: clamp(r.checked_to ?? r.checked_from) } : null,
    };
  }
  return out;
}

/** Голосование: большинство для да/нет/N/A, медиана для шкалы. */
export function vote(checklist, runs) {
  const result = {};
  for (const c of checklist.criteria) {
    const answers = runs.map((r) => r[c.id]?.answer).filter((a) => a != null);
    if (!answers.length) { result[c.id] = { answer: null, agreement: 0 }; continue; }
    let winner;
    const counts = answers.reduce((m, a) => m.set(a, (m.get(a) || 0) + 1), new Map());
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    if (c.type === 'scale' && !(top[0][1] > answers.length / 2)) {
      const nums = answers.filter((a) => a !== 'na').map(Number).sort((a, b) => a - b);
      winner = nums.length ? String(normalizeAnswer(c, nums[Math.floor(nums.length / 2)]).answer) : 'na';
    } else winner = top[0][0];
    const pick = runs.find((r) => r[c.id]?.answer === winner) || runs[0];
    result[c.id] = { ...pick[c.id], answer: winner, agreement: Math.round(((counts.get(winner) || 0) / answers.length) * 100) / 100, votes: answers };
  }
  return result;
}

const norm = (x) => String(x || '').toLowerCase().replace(/[«»"'.,!?…:;()\-–—]/g, ' ').replace(/\s+/g, ' ').trim();
// модель копирует в цитату служебную приставку строки транскрипта: «#10 [01:15] OPERATOR: …»
export const cleanQuote = (q) => String(q || '').replace(/^\s*(#\d+\s*)?(\[\+?[\d:]+\]\s*)?(\[?(CLIENT|OPERATOR|BOT|SYSTEM)\]?\s*:\s*)?/i, '').replace(/^\[|\]$/g, '').trim();
// модель сокращает цитаты — сверяем первые слова
const quoteIn = (text, quote) => { const q = norm(quote).split(' ').slice(0, 4).join(' '); return !q || norm(text).includes(q); };

/** Модель часто сдвигает номер реплики на 1–2. Если цитата есть в другой реплике — берём ближайшую к указанной. */
export function locateQuote(conv, e) {
  const t = conv.transcript;
  if (quoteIn(t[e.message - 1]?.text, e.quote)) return e.message;
  const hits = t.filter((m) => quoteIn(m.text, e.quote)).map((m) => m.idx);
  if (!hits.length) return e.message;
  return hits.sort((a, b) => Math.abs(a - e.message) - Math.abs(b - e.message))[0];
}

/**
 * Поводы для проверки человеком: то, что можно проверить кодом, а не «уверенность» модели на слово.
 * Ответ правила считается надёжным; грубая ошибка всегда идёт к человеку.
 */
export function doubtsFor(c, r, conv) {
  if (r.source === 'rule') return [];
  const out = [];
  if (c.type === 'flag' && r.answer === 'yes') out.push('найдена грубая ошибка — подтвердите');
  if (r.warning) out.push(r.warning);
  if (r.agreement != null && r.agreement < 1 && r.votes?.length > 1) out.push(`прогоны модели разошлись (${r.votes.join(', ')})`);
  // номер реплики уже исправлен locateQuote; если цитаты нет и после этого — модель её придумала
  const bad = (r.evidence || []).find((e) => !quoteIn(conv.transcript[e.message - 1]?.text, e.quote));
  if (bad) out.push(`цитаты «${String(bad.quote).slice(0, 40)}» нет в диалоге`);
  const lost = r.answer === 'no' || (c.type === 'scale' && r.answer !== 'na' && Number(r.answer) < Math.max(...c.scale.map((s) => s.value)));
  if (c.type !== 'flag' && lost && !r.evidence?.length && !r.checked_range) out.push('снижение без указанной реплики');
  return out;
}

/** Один прогон оценки в режиме per-criterion: последовательные вызовы (общий префикс промпта кэшируется моделью). */
async function runPerCriterion(conv, checklist, onCriterion, signal) {
  const system = buildCriterionSystemPrompt(checklist);
  const criteria = {}; const texts = []; const usage = {}; let cost = 0; let model;
  for (const c of checklist.criteria) {
    if (signal?.aborted) throw new Error('Оценка остановлена');
    const rule = ruleFor(conv, c);
    const emit = (x, byRule) => onCriterion?.({ criterion_id: c.id, answer: normalizeAnswer(c, x.answer).answer, label: answerLabel(c, normalizeAnswer(c, x.answer).answer), explanation: x.explanation, rule: byRule });
    if (rule?.answer) { criteria[c.id] = rule; texts.push(`[${c.id}] правило: ${JSON.stringify(rule)}`); emit(rule, true); continue; }
    const crit = rule?.criterion || c;
    const r = await completeJSON({ system, user: buildCriterionUserPrompt(conv, crit, rule?.note), schema: criterionItem(crit) });
    criteria[c.id] = r.parsed;
    texts.push(`[${c.id}] ${r.text}`);
    emit(r.parsed, false);
    for (const [k, v] of Object.entries(r.usage || {})) if (typeof v === 'number') usage[k] = (usage[k] || 0) + v;
    cost += r.cost_usd; model = r.model;
  }
  return { parsed: { criteria, summary: '' }, usage, cost_usd: cost, text: texts.join('\n'), model };
}

/** onCriterion(info) — вызывается по мере готовности каждого критерия (только режим per-criterion, первый прогон). */
export async function evaluateConversation(conv, checklist, { runs = RUNS, mode = MODE, onCriterion, signal } = {}) {
  const perCriterion = mode === 'per-criterion';
  const system = perCriterion ? buildCriterionSystemPrompt(checklist) : buildSystemPrompt(checklist);
  const user = perCriterion ? checklist.criteria.map((c) => buildCriterionUserPrompt(conv, c, ruleFor(conv, c)?.note)).join('\n\n=====\n\n') : buildUserPrompt(conv);
  const started = Date.now();
  const schema = buildResultSchema(checklist);
  const calls = perCriterion
    ? await (async () => { const out = []; for (let i = 0; i < runs; i++) out.push(await runPerCriterion(conv, checklist, i === 0 ? onCriterion : null, signal)); return out; })()
    : await Promise.all(Array.from({ length: runs }, () => completeJSON({ system, user, schema })));
  if (!perCriterion) for (const r of calls) for (const c of checklist.criteria) {
    const rule = ruleFor(conv, c);
    if (rule?.answer && r.parsed?.criteria) r.parsed.criteria[c.id] = rule;
  }
  const validated = calls.map((r) => validateRun(checklist, conv, r.parsed));
  const merged = runs > 1 ? vote(checklist, validated) : Object.fromEntries(Object.entries(validated[0]).map(([k, v]) => [k, { ...v, agreement: 1 }]));

  const missing = checklist.criteria.filter((c) => merged[c.id]?.answer == null).map((c) => c.id);
  if (missing.length) throw new Error(`Модель не оценила критерии: ${missing.join(', ')}`);

  const answers = Object.fromEntries(checklist.criteria.map((c) => [c.id, merged[c.id].answer]));
  const score = computeScore(checklist, answers);
  for (const c of checklist.criteria) merged[c.id].doubts = doubtsFor(c, merged[c.id], conv);
  const review_reasons = checklist.criteria.flatMap((c) => merged[c.id].doubts.map((d) => `${c.name}: ${d}`));
  const usage = calls.reduce((s, r) => {
    for (const [k, v] of Object.entries(r.usage || {})) if (typeof v === 'number') s[k] = (s[k] || 0) + v;
    return s;
  }, {});

  const criteria = checklist.criteria.map((c) => ({
    criterion_id: c.id,
    ai: { ...merged[c.id], label: answerLabel(c, merged[c.id].answer) },
    final_answer: merged[c.id].answer,
    original: score.per_criterion[c.id],
    final: score.per_criterion[c.id],
  }));

  return {
    id: newId('ev'),
    conversation_id: conv.conversation_id,
    group_id: conv.group_id,
    checklist_id: checklist.id,
    checklist_version: checklist.version,
    checklist, // снимок — результат не меняется при последующей правке чек-листа
    created_at: new Date().toISOString(),
    provider: PROVIDER, model: calls[0].model || MODEL, effort: PROVIDER === 'anthropic' ? EFFORT : null, runs, mode,
    duration_ms: Date.now() - started,
    usage, cost_usd: Math.round(calls.reduce((s, r) => s + r.cost_usd, 0) * 10000) / 10000,
    summary: calls[0].parsed.summary,
    criteria,
    original_score: score,
    final_score: score,
    status: 'evaluated',
    needs_review: review_reasons.length > 0, review_reasons,
    trace: { system_prompt: system, user_prompt: user, raw_outputs: calls.map((r) => r.text) },
  };
}

/** Сохраняет оценку: трассировка — отдельным файлом, в общем списке — только результат. */
export function saveEvaluation(ev) {
  const { trace, ...rest } = ev;
  if (trace) db.writeBlob('traces', ev.id, trace);
  db.insert('evaluations', rest);
  return ev;
}

/** Одноразовый перенос трассировок старых оценок в storage/traces. */
export function migrateTraces() {
  let n = 0;
  for (const e of db.all('evaluations')) {
    if (!e.trace) continue;
    db.writeBlob('traces', e.id, e.trace); delete e.trace; n++;
  }
  if (n) { db.update('evaluations', db.all('evaluations')[0].id, {}); console.log(`[db] трассировки ${n} оценок перенесены в storage/traces`); }
}

/** Оценки, сделанные до появления сверки цитат и «нужна проверка», дополняются при запуске — кодом, без модели. */
export function backfillReview() {
  let n = 0;
  for (const ev of db.all('evaluations')) {
    if (ev.review_reasons || ev.status === 'manual') continue;
    const conv = db.get('conversations', ev.conversation_id, 'conversation_id');
    if (!conv) continue;
    for (const cr of ev.criteria) {
      const c = ev.checklist.criteria.find((x) => x.id === cr.criterion_id);
      if (!c || !cr.ai) continue;
      cr.ai.evidence = (cr.ai.evidence || []).map((e) => { const quote = cleanQuote(e.quote); const message = locateQuote(conv, { ...e, quote }); const m = conv.transcript[message - 1]; return { ...e, quote, message, speaker: m?.speaker, timestamp: m?.timestamp, offset_sec: m?.offset_sec }; });
      cr.ai.source ||= /проверено правилом/.test(cr.ai.explanation || '') ? 'rule' : 'model';
      cr.ai.doubts = doubtsFor(c, cr.ai, conv);
    }
    ev.review_reasons = ev.criteria.flatMap((cr) => (cr.ai?.doubts || []).map((d) => `${ev.checklist.criteria.find((x) => x.id === cr.criterion_id)?.name}: ${d}`));
    ev.needs_review = ev.review_reasons.length > 0;
    n++;
  }
  if (n) { db.update('evaluations', db.all('evaluations')[0].id, {}); console.log(`[db] сверка цитат и поводы для проверки добавлены к ${n} оценкам`); }
}

export function recomputeFinal(ev) {
  const answers = Object.fromEntries(ev.criteria.map((c) => [c.criterion_id, c.final_answer]));
  ev.final_score = computeScore(ev.checklist, answers);
  for (const c of ev.criteria) c.final = ev.final_score.per_criterion[c.criterion_id];
  return ev;
}

// ---- Очередь пакетной оценки ----
// Задачи хранятся в storage/jobs.json: после перезапуска сервера незавершённые продолжаются с места остановки.
const CONCURRENCY = Math.max(1, Number(process.env.CQA_CONCURRENCY || 4));

export function getJob(id) { return db.get('jobs', id); }
export function listJobs() { return [...db.all('jobs')].slice(-20).reverse(); }

export function startBatch(conversationIds, checklist) {
  const job = {
    id: newId('job'), checklist_id: checklist.id, checklist_name: checklist.name, checklist,
    total: conversationIds.length, pending: [...conversationIds], done: 0, failed: 0, errors: [], results: [],
    status: 'running', started_at: new Date().toISOString(), cost_usd: 0,
  };
  db.insert('jobs', job);
  runJob(job);
  return publicJob(job);
}

/** Без снимка чек-листа и очереди — для ответа клиенту. */
export function publicJob(job) {
  if (!job) return null;
  const { checklist, pending, inflight, ...rest } = job;
  return { ...rest, remaining: (pending?.length ?? 0) + (inflight?.length ?? 0) };
}

function runJob(job) {
  const worker = async () => {
    while (job.pending.length) {
      const cid = job.pending.shift();
      (job.inflight ||= []).push(cid); // «в работе» — вернётся в очередь, если сервер остановят посреди оценки
      const conv = db.get('conversations', cid, 'conversation_id');
      try {
        if (!conv) throw new Error('диалог не найден');
        const ev = await evaluateConversation(conv, job.checklist);
        saveEvaluation(ev);
        job.results.push({ conversation_id: cid, evaluation_id: ev.id, total: ev.final_score.total, gross: ev.final_score.gross_error });
        job.cost_usd = Math.round((job.cost_usd + ev.cost_usd) * 10000) / 10000;
        job.done++;
      } catch (e) {
        job.failed++;
        job.errors.push({ conversation_id: cid, error: String(e.message || e) });
        console.error('[eval]', cid, e.message || e);
      }
      job.inflight = job.inflight.filter((x) => x !== cid);
      db.upsert('jobs', job);
    }
  };
  Promise.all(Array.from({ length: Math.max(1, Math.min(CONCURRENCY, job.pending.length)) }, worker)).then(() => {
    job.status = 'finished';
    job.finished_at = new Date().toISOString();
    db.upsert('jobs', job);
  });
}

/** Вызывается при старте сервера: продолжает прерванные задачи. */
export function resumeJobs() {
  for (const job of db.all('jobs')) {
    if (job.status !== 'running') continue;
    job.pending = [...(job.inflight || []), ...job.pending];
    job.inflight = [];
    console.log(`[jobs] продолжаю ${job.id}: осталось ${job.pending.length} из ${job.total}`);
    runJob(job);
  }
}
