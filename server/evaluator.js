// Оценка диалога: промпт из конфигурации чек-листа → LLM → валидация → детерминированный расчёт.
import { z } from 'zod';
import { completeJSON, MODEL, PROVIDER, EFFORT } from './llm.js';
import { computeScore, normalizeAnswer, allowedAnswers, answerLabel } from './scoring.js';
import { db, newId } from './db.js';

const RUNS = Math.max(1, Number(process.env.CQA_RUNS || 1)); // >1 — голосование нескольких прогонов
const LANG_NAMES = { RU: 'русский', KZ: 'казахский', EN: 'английский' };

const ResultSchema = z.object({
  criteria: z.array(z.object({
    criterion_id: z.string(),
    answer: z.string().describe('yes | no | na | значение ступени шкалы'),
    explanation: z.string(),
    evidence: z.array(z.object({ message: z.number().int(), quote: z.string() })),
    checked_from: z.number().int().nullable(),
    checked_to: z.number().int().nullable(),
  })),
  summary: z.string(),
});

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
    '- Оцени КАЖДЫЙ критерий из списка ниже, используя его id. Ничего не добавляй и не пропускай.',
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

export function buildUserPrompt(conv) {
  const t = conv.transcript;
  const firstOp = t.find((m) => m.speaker === 'operator');
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
    firstOp ? `Первое сообщение оператора: #${firstOp.idx}.` : 'Оператор в диалоге не писал.',
    pauses.length ? `Паузы оператора ≥ 1.5 мин после реплики клиента: ${pauses.join('; ')}.` : 'Пауз оператора ≥ 1.5 мин после реплики клиента нет.',
    '',
    '<transcript>',
    ...lines,
    '</transcript>',
    '',
    'Оцени работу оператора по каждому критерию чек-листа.',
  ].join('\n');
}

export function validateRun(checklist, conv, parsed) {
  const maxIdx = conv.transcript.length;
  const byId = new Map(parsed.criteria.map((c) => [c.criterion_id, c]));
  const out = {};
  for (const c of checklist.criteria) {
    const r = byId.get(c.id);
    if (!r) { out[c.id] = { answer: null, missing: true }; continue; }
    const { answer, warning } = normalizeAnswer(c, r.answer);
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

export async function evaluateConversation(conv, checklist, { runs = RUNS } = {}) {
  const system = buildSystemPrompt(checklist);
  const user = buildUserPrompt(conv);
  const started = Date.now();
  const calls = await Promise.all(Array.from({ length: runs }, () => completeJSON({ system, user, schema: ResultSchema })));
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
    provider: PROVIDER, model: calls[0].model || MODEL, effort: PROVIDER === 'anthropic' ? EFFORT : null, runs,
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
const CONCURRENCY = Math.max(1, Number(process.env.CQA_CONCURRENCY || 4));
const jobs = new Map();

export function getJob(id) { return jobs.get(id) || null; }
export function listJobs() { return [...jobs.values()].slice(-20).reverse(); }

export function startBatch(conversationIds, checklist) {
  const job = { id: newId('job'), checklist_id: checklist.id, checklist_name: checklist.name, total: conversationIds.length, done: 0, failed: 0, errors: [], results: [], status: 'running', started_at: new Date().toISOString(), cost_usd: 0 };
  jobs.set(job.id, job);
  const queue = [...conversationIds];
  const worker = async () => {
    while (queue.length) {
      const cid = queue.shift();
      const conv = db.get('conversations', cid, 'conversation_id');
      try {
        if (!conv) throw new Error('диалог не найден');
        const ev = await evaluateConversation(conv, checklist);
        db.insert('evaluations', ev);
        job.results.push({ conversation_id: cid, evaluation_id: ev.id, total: ev.final_score.total, gross: ev.final_score.gross_error });
        job.cost_usd += ev.cost_usd;
        job.done++;
      } catch (e) {
        job.failed++;
        job.errors.push({ conversation_id: cid, error: String(e.message || e) });
        console.error('[eval]', cid, e.message || e);
      }
    }
  };
  Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker)).then(() => {
    job.status = 'finished';
    job.finished_at = new Date().toISOString();
    job.cost_usd = Math.round(job.cost_usd * 10000) / 10000;
  });
  return job;
}
