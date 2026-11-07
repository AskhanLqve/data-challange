// Оценка диалога: промпт из конфигурации чек-листа → LLM → валидация → детерминированный расчёт.
import { z } from 'zod';
import { completeJSON, MODEL, PROVIDER, EFFORT } from './llm.js';
import { computeScore, normalizeAnswer, allowedAnswers, answerLabel } from './scoring.js';
import { db, newId } from './db.js';

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
  // Для критериев с N/A — сначала отдельный вопрос о применимости (небольшие модели иначе путают «Нет» и N/A).
  ...(c.na_allowed && c.type !== 'flag' ? { na_condition_met: z.boolean().describe(`Выполнено ли условие N/A: ${c.na_condition || 'критерий неприменим'}`) } : {}),
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
    '- Если у критерия есть поле na_condition_met — сначала реши только его: выполнено ли условие N/A. Если да — answer = "na".',
    '- «Нет» ставь только тогда, когда можешь указать конкретную реплику оператора, где он нарушил условие, или место, где нужное действие было пропущено. Если нарушения не видно — это «Да» (или верхняя ступень шкалы).',
    '- answer — строго одно из допустимых значений критерия.',
    '- explanation — 1–2 предложения: что именно сделал или не сделал оператор и в какой реплике.',
    '- evidence — номера реплик (#N) и точная короткая цитата из них. Если действие пропущено — реплика, где оно ожидалось.',
    '- checked_from / checked_to — проверенный диапазон реплик; обязателен для «Нет» и N/A, иначе null.',
    '- Не выдумывай реплики и не приписывай оператору того, чего нет в тексте.',
  ].join('\n');
}

export function buildCriterionUserPrompt(conv, c) {
  return [
    buildUserPrompt(conv, { withTask: false }),
    '',
    '## Критерий для оценки',
    criterionBlock(c),
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
      .filter((e) => e.message >= 1 && e.message <= maxIdx)
      .map((e) => ({ message: e.message, quote: e.quote, speaker: conv.transcript[e.message - 1].speaker, timestamp: conv.transcript[e.message - 1].timestamp, offset_sec: conv.transcript[e.message - 1].offset_sec }));
    const clamp = (x) => (x == null ? null : Math.min(Math.max(1, x), maxIdx));
    out[c.id] = {
      answer, warning, explanation: r.explanation, evidence,
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

/** Один прогон оценки в режиме per-criterion: последовательные вызовы (общий префикс промпта кэшируется моделью). */
async function runPerCriterion(conv, checklist) {
  const system = buildCriterionSystemPrompt(checklist);
  const criteria = {}; const texts = []; const usage = {}; let cost = 0; let model;
  for (const c of checklist.criteria) {
    const r = await completeJSON({ system, user: buildCriterionUserPrompt(conv, c), schema: criterionItem(c) });
    criteria[c.id] = r.parsed;
    texts.push(`[${c.id}] ${r.text}`);
    for (const [k, v] of Object.entries(r.usage || {})) if (typeof v === 'number') usage[k] = (usage[k] || 0) + v;
    cost += r.cost_usd; model = r.model;
  }
  return { parsed: { criteria, summary: '' }, usage, cost_usd: cost, text: texts.join('\n'), model };
}

export async function evaluateConversation(conv, checklist, { runs = RUNS, mode = MODE } = {}) {
  const perCriterion = mode === 'per-criterion';
  const system = perCriterion ? buildCriterionSystemPrompt(checklist) : buildSystemPrompt(checklist);
  const user = perCriterion ? checklist.criteria.map((c) => buildCriterionUserPrompt(conv, c)).join('\n\n=====\n\n') : buildUserPrompt(conv);
  const started = Date.now();
  const schema = buildResultSchema(checklist);
  const calls = perCriterion
    ? await (async () => { const out = []; for (let i = 0; i < runs; i++) out.push(await runPerCriterion(conv, checklist)); return out; })()
    : await Promise.all(Array.from({ length: runs }, () => completeJSON({ system, user, schema })));
  const validated = calls.map((r) => validateRun(checklist, conv, r.parsed));
  const merged = runs > 1 ? vote(checklist, validated) : Object.fromEntries(Object.entries(validated[0]).map(([k, v]) => [k, { ...v, agreement: 1 }]));

  const missing = checklist.criteria.filter((c) => merged[c.id]?.answer == null).map((c) => c.id);
  if (missing.length) throw new Error(`Модель не оценила критерии: ${missing.join(', ')}`);

  const answers = Object.fromEntries(checklist.criteria.map((c) => [c.id, merged[c.id].answer]));
  const score = computeScore(checklist, answers);
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
    trace: { system_prompt: system, user_prompt: user, raw_outputs: calls.map((r) => r.text) },
  };
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
        db.insert('evaluations', ev);
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
