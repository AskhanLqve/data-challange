// HTTP-сервер CQA: REST API + статический интерфейс из ./public. Без фреймворков.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { db, newId } from './db.js';
import { DEFAULT_CHECKLIST } from './defaultChecklist.js';
import { fetchGroup, extractRecords, importRecords, resolveAudio, localUpload, normalizeRecord } from './dataset.js';
import { transcribeFile, asrAvailable, ASR_MODEL } from './asr.js';
import { conversationMetrics } from './metrics.js';
import { evaluateConversation, recomputeFinal, startBatch, getJob, listJobs, publicJob, resumeJobs, saveEvaluation, migrateTraces, backfillReview, MODE } from './evaluator.js';
import { providerInfo, providerReady, completeText } from './llm.js';
import { allowedAnswers, answerLabel, computeScore, normalizeAnswer } from './scoring.js';
import { buildResults, validateResults } from './results.js';

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.resolve('public');

// ---------- инициализация ----------
if (!db.get('checklists', DEFAULT_CHECKLIST.id)) {
  const now = new Date().toISOString();
  const doc = { ...structuredClone(DEFAULT_CHECKLIST), version: 1, created_at: now, updated_at: now };
  db.insert('checklists', doc);
  db.insert('checklist_versions', { ...structuredClone(doc), vid: `${doc.id}@1` });
}

// ---------- утилиты ----------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const send = (res, status, body, headers = {}) => {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', ...headers });
  res.end(data);
};
async function readBody(req, limit = 20 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const ch of req) { size += ch.length; if (size > limit) throw new HttpError(413, 'Слишком большой запрос'); chunks.push(ch); }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  const ct = req.headers['content-type'] || '';
  if (ct.includes('application/json')) { try { return JSON.parse(raw); } catch { throw new HttpError(400, 'Некорректный JSON'); } }
  return raw;
}

function validateChecklist(cl) {
  const errs = [];
  if (!cl.name?.trim()) errs.push('Укажите название чек-листа');
  if (!Array.isArray(cl.criteria) || !cl.criteria.length) errs.push('Добавьте хотя бы один критерий');
  const ids = new Set();
  for (const [i, c] of (cl.criteria || []).entries()) {
    const n = `Критерий ${i + 1}`;
    if (!c.id) c.id = newId('c');
    if (ids.has(c.id)) errs.push(`${n}: дублируется id ${c.id}`); ids.add(c.id);
    if (!c.name?.trim()) errs.push(`${n}: нет названия`);
    if (!c.description?.trim()) errs.push(`${n}: нет формулировки`);
    if (!['binary', 'scale', 'flag'].includes(c.type)) errs.push(`${n}: неизвестный тип ${c.type}`);
    c.weight = c.type === 'flag' ? 0 : Number(c.weight);
    if (c.type !== 'flag' && !(c.weight >= 0)) errs.push(`${n}: вес должен быть ≥ 0`);
    c.na_allowed = c.type === 'flag' ? false : Boolean(c.na_allowed);
    if (c.type === 'scale') {
      c.scale = (c.scale || []).map((s) => ({ value: Number(s.value), label: String(s.label || '') })).filter((s) => Number.isFinite(s.value));
      if (c.scale.length < 2) errs.push(`${n}: шкала должна иметь минимум 2 ступени`);
      if (new Set(c.scale.map((s) => s.value)).size !== c.scale.length) errs.push(`${n}: ступени шкалы повторяются`);
      c.scale.sort((a, b) => b.value - a.value);
    } else delete c.scale;
    if (c.section && !(cl.sections || []).some((s) => s.id === c.section)) errs.push(`${n}: секция ${c.section} не найдена`);
  }
  if (errs.length) throw new HttpError(400, errs.join('\n'));
  return cl;
}

function convSummary(c) {
  const evs = db.filter('evaluations', (e) => e.conversation_id === c.conversation_id);
  const last = evs.sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  return {
    conversation_id: c.conversation_id, group_id: c.group_id, channel: c.channel, language: c.language,
    messages: c.transcript.length, has_audio: Boolean(c.audio_url), assignee: c.assignee || null, title: c.title || null, source: c.source || 'api',
    preview: (c.transcript.find((m) => m.speaker === 'client')?.text || '').slice(0, 140),
    last_evaluation: last ? { id: last.id, needs_review: Boolean(last.needs_review) && !last.reviewed && last.status !== 'reviewed', review_reasons: last.review_reasons || [], total: last.final_score.total, original_total: last.original_score.total, gross: last.final_score.gross_error, checklist_name: last.checklist.name, checklist_version: last.checklist_version, created_at: last.created_at, status: last.status } : null,
    evaluations: evs.length,
  };
}

function csvEscape(v) { const s = v == null ? '' : String(v); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }

// ---------- маршруты ----------
const routes = [];
const route = (method, pattern, handler, opts = {}) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler, ...opts });

route('GET', '/api/health', async () => ({ ok: true, ...providerInfo(), ...(await providerReady()) }));

// Чек-листы
route('GET', '/api/checklists', () => db.all('checklists'));
route('GET', '/api/checklists/:id', ({ p }) => db.get('checklists', p.id) || (() => { throw new HttpError(404, 'Чек-лист не найден'); })());
route('GET', '/api/checklists/:id/versions', ({ p }) => db.filter('checklist_versions', (v) => v.id === p.id).map((v) => ({ version: v.version, updated_at: v.updated_at, criteria: v.criteria.length, name: v.name })));
route('POST', '/api/checklists', ({ body }) => {
  const cl = validateChecklist(structuredClone(body));
  cl.id = body.id && !db.get('checklists', body.id) ? body.id : newId('cl');
  const now = new Date().toISOString();
  Object.assign(cl, { version: 1, created_at: now, updated_at: now });
  db.insert('checklists', cl);
  db.insert('checklist_versions', { ...structuredClone(cl), vid: `${cl.id}@1` });
  return cl;
});
route('PUT', '/api/checklists/:id', ({ p, body }) => {
  const prev = db.get('checklists', p.id);
  if (!prev) throw new HttpError(404, 'Чек-лист не найден');
  const cl = validateChecklist(structuredClone(body));
  Object.assign(cl, { id: prev.id, version: prev.version + 1, created_at: prev.created_at, updated_at: new Date().toISOString() });
  db.upsert('checklists', cl);
  db.insert('checklist_versions', { ...structuredClone(cl), vid: `${cl.id}@${cl.version}` });
  return cl;
});
route('DELETE', '/api/checklists/:id', ({ p }) => {
  if (db.all('checklists').length <= 1) throw new HttpError(400, 'Нельзя удалить последний чек-лист');
  return { deleted: db.remove('checklists', p.id) };
});
route('POST', '/api/checklists/:id/reset-default', ({ p }) => {
  const prev = db.get('checklists', p.id);
  if (!prev) throw new HttpError(404, 'Чек-лист не найден');
  const cl = { ...structuredClone(DEFAULT_CHECKLIST), id: prev.id, version: prev.version + 1, created_at: prev.created_at, updated_at: new Date().toISOString() };
  db.upsert('checklists', cl);
  db.insert('checklist_versions', { ...structuredClone(cl), vid: `${cl.id}@${cl.version}` });
  return cl;
});

// Данные
route('POST', '/api/datasets/fetch', async ({ body }) => {
  const g = String(body.group_id || '').trim();
  if (!g) throw new HttpError(400, 'Укажите group_id');
  return fetchGroup(g);
});
route('POST', '/api/conversations/upload', ({ body, q }) => {
  let payload = body;
  if (typeof body === 'string') { try { payload = JSON.parse(body); } catch { payload = body; } }
  const records = extractRecords(payload);
  const ids = importRecords(records, q.get('group_id') || 'UPLOAD');
  return { imported: ids };
});
route('GET', '/api/conversations', ({ q }) => {
  let list = db.all('conversations');
  const g = q.get('group_id'); if (g) list = list.filter((c) => c.group_id === g);
  return list.map(convSummary);
});
route('GET', '/api/groups', () => {
  const m = new Map();
  for (const c of db.all('conversations')) m.set(c.group_id, (m.get(c.group_id) || 0) + 1);
  return [...m].map(([group_id, count]) => ({ group_id, count }));
});
route('GET', '/api/conversations/:id', ({ p }) => {
  const c = db.get('conversations', decodeURIComponent(p.id), 'conversation_id');
  if (!c) throw new HttpError(404, 'Диалог не найден');
  const evs = db.filter('evaluations', (e) => e.conversation_id === c.conversation_id)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map((e) => ({ id: e.id, created_at: e.created_at, total: e.final_score.total, checklist_name: e.checklist.name, checklist_version: e.checklist_version, status: e.status }));
  return { ...c, evaluations: evs, metrics: conversationMetrics(c) };
});
route('DELETE', '/api/conversations/:id', ({ p }) => ({ deleted: db.remove('conversations', decodeURIComponent(p.id), 'conversation_id') }));

// Аудио: перенаправление на свежую подписанную ссылку mp3
route('GET', '/api/audio/:id', async ({ p, res }) => {
  const c = db.get('conversations', decodeURIComponent(p.id), 'conversation_id');
  if (!c?.audio_url) throw new HttpError(404, 'У диалога нет записи');
  const src = await resolveAudio(c.audio_url);
  res.writeHead(302, { location: src, 'cache-control': 'no-store' });
  res.end();
});

// Файл записи через наш адрес (same-origin): браузер декодирует его и строит волны дорожек «Клиент»/«Оператор».
route('GET', '/api/audio/:id/file', async ({ p, res }) => {
  const c = db.get('conversations', decodeURIComponent(p.id), 'conversation_id');
  if (!c?.audio_url) throw new HttpError(404, 'У диалога нет записи');
  const local = localUpload(c.audio_url);
  if (local) { const buf = fs.readFileSync(local); res.writeHead(200, { 'content-type': mimeOf(local), 'content-length': buf.length }); return res.end(buf); }
  const src = await resolveAudio(c.audio_url);
  const up = await fetch(src, { signal: AbortSignal.timeout(120_000) });
  if (!up.ok) throw new HttpError(502, `Запись недоступна (HTTP ${up.status})`);
  const buf = Buffer.from(await up.arrayBuffer());
  res.writeHead(200, { 'content-type': up.headers.get('content-type') || 'audio/mpeg', 'content-length': buf.length, 'cache-control': 'private, max-age=1800' });
  res.end(buf);
});

// Аналитика по набору: последняя оценка каждого диалога выбранным чек-листом.
route('GET', '/api/analytics', ({ q }) => {
  const g = q.get('group_id'); const clId = q.get('checklist_id');
  const convs = db.filter('conversations', (c) => !g || c.group_id === g);
  const latest = new Map();
  for (const e of db.all('evaluations')) {
    if (clId && e.checklist_id !== clId) continue;
    if (!convs.some((c) => c.conversation_id === e.conversation_id)) continue;
    const cur = latest.get(e.conversation_id);
    if (!cur || e.created_at > cur.created_at) latest.set(e.conversation_id, e);
  }
  const evs = [...latest.values()];
  const totals = evs.map((e) => e.final_score.total).filter((x) => x != null).sort((a, b) => a - b);
  const avg = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null);
  const cl = (clId && db.get('checklists', clId)) || evs[0]?.checklist || db.all('checklists')[0];
  const criteria = cl.criteria.map((c) => {
    const rows = evs.map((e) => e.criteria.find((x) => x.criterion_id === c.id)).filter(Boolean);
    const applicable = rows.filter((r) => r.final_answer !== 'na');
    const max = c.type === 'scale' ? Math.max(...c.scale.map((s) => s.value)) : 1;
    const share = (r) => (c.type === 'scale' ? Number(r.final_answer) / max : r.final_answer === 'yes' ? 1 : 0);
    const rate = applicable.length ? Math.round((applicable.reduce((s, r) => s + share(r), 0) / applicable.length) * 1000) / 10 : null;
    return { id: c.id, code: c.code, name: c.name, type: c.type, weight: c.weight, evaluated: rows.length, applicable: applicable.length, na: rows.length - applicable.length, rate };
  });
  const group = (key) => {
    const m = new Map();
    for (const e of evs) { const conv = convs.find((c) => c.conversation_id === e.conversation_id); const k = conv?.[key] || '—'; if (!m.has(k)) m.set(k, []); if (e.final_score.total != null) m.get(k).push(e.final_score.total); }
    return [...m].map(([k, xs]) => ({ key: k, count: xs.length, avg: avg(xs) }));
  };
  const hist = Array.from({ length: 10 }, (_, i) => ({ from: i * 10, to: i * 10 + 10, count: 0 }));
  for (const t of totals) hist[Math.min(9, Math.floor(t / 10))].count++;
  const appeals = db.filter('appeals', (a) => latest.has(a.conversation_id));
  return {
    group_id: g, checklist: { id: cl.id, name: cl.name, version: cl.version },
    conversations: convs.length, evaluated: evs.length, avg: avg(totals),
    median: totals.length ? totals[Math.floor((totals.length - 1) / 2)] : null,
    gross: evs.filter((e) => e.final_score.gross_error).map((e) => e.conversation_id),
    appeals: { open: appeals.filter((a) => a.status === 'open').length, resolved: appeals.filter((a) => a.status !== 'open').length, changed: appeals.filter((a) => a.decision?.action === 'change').length },
    criteria, by_language: group('language'), by_channel: group('channel'), histogram: hist,
    weakest: evs.filter((e) => e.final_score.total != null).sort((a, b) => a.final_score.total - b.final_score.total).slice(0, 6)
      .map((e) => ({ conversation_id: e.conversation_id, total: e.final_score.total, gross: e.final_score.gross_error })),
  };
});

// Точность ИИ относительно экспертной разметки: последний отчёт `pnpm eval --run` (eval/reports).
route('GET', '/api/accuracy', () => {
  const dir = path.resolve('eval', 'reports');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().reverse() : [];
  for (const f of files) {
    const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (!r.run) continue;
    const cl = db.all('checklists')[0];
    const pct = (x) => (x?.n ? Math.round((x.ok / x.n) * 1000) / 10 : null);
    return {
      date: r.date, model: r.model?.model, provider: r.model?.provider, checklist_version: r.checklist_version,
      dialogs: r.dialogs ?? r.totals?.length ?? null, answers: r.overall.all.n,
      agreement: pct(r.overall.all), agreement_sure: pct(r.overall.sure), mae: r.mae, gross: r.gross,
      criteria: Object.entries(r.byCrit).map(([id, v]) => { const c = cl.criteria.find((x) => x.id === id); return { id, code: c?.code, name: c?.name || id, agreement: pct(v.all), n: v.all.n }; }),
      languages: Object.entries(r.byLang || {}).map(([k, v]) => ({ key: k, agreement: pct(v), n: v.n })),
    };
  }
  return { date: null };
});

// Оценка
route('POST', '/api/evaluate', async ({ body }) => {
  const conv = db.get('conversations', body.conversation_id, 'conversation_id');
  if (!conv) throw new HttpError(404, 'Диалог не найден');
  const cl = db.get('checklists', body.checklist_id) || db.all('checklists')[0];
  if (!providerInfo().configured) throw new HttpError(503, 'LLM не настроен: задайте ANTHROPIC_API_KEY в .env (или CQA_PROVIDER=ollama)');
  const ev = await evaluateConversation(conv, structuredClone(cl), { runs: body.runs ? Number(body.runs) : undefined, mode: ['single', 'per-criterion'].includes(body.mode) ? body.mode : undefined });
  saveEvaluation(ev);
  return ev;
});
// То же, но потоком NDJSON: строка на каждый готовый критерий, затем итоговая оценка — интерфейс показывает ход оценки.
route('POST', '/api/evaluate/stream', async ({ body, res }) => {
  const conv = db.get('conversations', body.conversation_id, 'conversation_id');
  if (!conv) throw new HttpError(404, 'Диалог не найден');
  const cl = db.get('checklists', body.checklist_id) || db.all('checklists')[0];
  if (!providerInfo().configured) throw new HttpError(503, 'LLM не настроен: задайте ANTHROPIC_API_KEY в .env (или CQA_PROVIDER=ollama)');
  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
  const line = (o) => res.write(JSON.stringify(o) + '\n');
  const mode = ['single', 'per-criterion'].includes(body.mode) ? body.mode : MODE;
  line({ type: 'start', mode, criteria: cl.criteria.map((c) => ({ id: c.id, code: c.code, name: c.name, type: c.type, max: c.type === 'scale' ? Math.max(...c.scale.map((x) => x.value)) : null })) });
  try {
    // клиент нажал «Остановить» или закрыл страницу — дальнейшие критерии не запускаем
    const ac = new AbortController();
    res.on('close', () => { if (!res.writableFinished) ac.abort(); });
    const ev = await evaluateConversation(conv, structuredClone(cl), { mode, signal: ac.signal, onCriterion: (x) => line({ type: 'criterion', ...x }) });
    saveEvaluation(ev);
    line({ type: 'done', evaluation_id: ev.id, total: ev.final_score.total, duration_ms: ev.duration_ms });
  } catch (e) { if (!res.destroyed) line({ type: 'error', error: String(e.message || e) }); }
  res.end();
});
route('POST', '/api/evaluate/batch', ({ body }) => {
  const cl = db.get('checklists', body.checklist_id) || db.all('checklists')[0];
  if (!providerInfo().configured) throw new HttpError(503, 'LLM не настроен: задайте ANTHROPIC_API_KEY в .env (или CQA_PROVIDER=ollama)');
  let ids = body.conversation_ids;
  if (!ids?.length && body.group_id) ids = db.filter('conversations', (c) => c.group_id === body.group_id).map((c) => c.conversation_id);
  if (!ids?.length) throw new HttpError(400, 'Нет диалогов для оценки');
  if (body.only_new) {
    const done = new Set(db.filter('evaluations', (e) => e.checklist_id === cl.id && e.checklist_version === cl.version).map((e) => e.conversation_id));
    ids = ids.filter((id) => !done.has(id));
    if (!ids.length) throw new HttpError(400, `Все выбранные диалоги уже оценены чек-листом «${cl.name}» v${cl.version}`);
  }
  return startBatch(ids, structuredClone(cl));
});
route('GET', '/api/jobs', () => listJobs().map(publicJob));
route('GET', '/api/jobs/:id', ({ p }) => publicJob(getJob(p.id)) || (() => { throw new HttpError(404, 'Задача не найдена'); })());
route('GET', '/api/evaluations/:id', ({ p }) => {
  const ev = db.get('evaluations', p.id);
  if (!ev) throw new HttpError(404, 'Оценка не найдена');
  return { ...ev, trace: ev.trace || db.readBlob('traces', ev.id) || {}, appeals: db.filter('appeals', (a) => a.evaluation_id === ev.id) };
});

// Апелляции
// Проверяющий просмотрел оценку, помеченную «нужна проверка», и согласен с ней без апелляции.
route('POST', '/api/evaluations/:id/confirm', ({ p, body }) => {
  const ev = db.get('evaluations', p.id);
  if (!ev) throw new HttpError(404, 'Оценка не найдена');
  return db.update('evaluations', ev.id, { reviewed: true, reviewed_by: String(body?.reviewer || 'Проверяющий'), reviewed_at: new Date().toISOString() });
});
route('POST', '/api/appeals', ({ body }) => {
  const ev = db.get('evaluations', body.evaluation_id);
  if (!ev) throw new HttpError(404, 'Оценка не найдена');
  const crit = ev.criteria.find((c) => c.criterion_id === body.criterion_id);
  if (!crit) throw new HttpError(400, 'Критерий не найден в оценке');
  if (!String(body.comment || '').trim()) throw new HttpError(400, 'Добавьте комментарий к апелляции');
  if (db.filter('appeals', (a) => a.evaluation_id === ev.id && a.criterion_id === crit.criterion_id && a.status === 'open').length) throw new HttpError(409, 'По этому критерию уже есть открытая апелляция');
  const def = ev.checklist.criteria.find((c) => c.id === crit.criterion_id);
  const appeal = {
    id: newId('ap'), evaluation_id: ev.id, conversation_id: ev.conversation_id, criterion_id: crit.criterion_id,
    criterion_name: def.name, disputed_answer: crit.final_answer, disputed_label: answerLabel(def, crit.final_answer),
    requested_answer: body.requested_answer ?? null, comment: String(body.comment).trim(), author: body.author || 'Оператор',
    created_at: new Date().toISOString(), status: 'open', decision: null,
  };
  db.insert('appeals', appeal);
  db.update('evaluations', ev.id, { status: 'appealed' });
  return appeal;
});
route('GET', '/api/appeals', ({ q }) => {
  let list = db.all('appeals');
  const st = q.get('status'); if (st) list = list.filter((a) => a.status === st);
  return [...list].sort((a, b) => b.created_at.localeCompare(a.created_at)).map((a) => {
    const ev = db.get('evaluations', a.evaluation_id);
    return { ...a, total_before: ev?.original_score.total, total_now: ev?.final_score.total };
  });
});
route('POST', '/api/appeals/:id/decision', ({ p, body }) => {
  const ap = db.get('appeals', p.id);
  if (!ap) throw new HttpError(404, 'Апелляция не найдена');
  if (ap.status !== 'open') throw new HttpError(409, 'Решение по апелляции уже принято');
  const ev = db.get('evaluations', ap.evaluation_id);
  const def = ev.checklist.criteria.find((c) => c.id === ap.criterion_id);
  const crit = ev.criteria.find((c) => c.criterion_id === ap.criterion_id);
  const reason = String(body.reason || '').trim();
  if (!reason) throw new HttpError(400, 'Укажите причину решения');
  let newAnswer = crit.final_answer;
  if (body.action === 'change') {
    newAnswer = String(body.new_answer);
    if (!allowedAnswers(def).includes(newAnswer)) throw new HttpError(400, `Недопустимое значение. Варианты: ${allowedAnswers(def).join(', ')}`);
  } else if (body.action !== 'confirm') throw new HttpError(400, 'action должен быть confirm или change');
  const before = ev.final_score.total;
  crit.final_answer = newAnswer;
  crit.review = { appeal_id: ap.id, action: body.action, previous_answer: ap.disputed_answer, new_answer: newAnswer, reason, reviewer: body.reviewer || 'Проверяющий', decided_at: new Date().toISOString() };
  recomputeFinal(ev);
  ev.status = db.filter('appeals', (a) => a.evaluation_id === ev.id && a.status === 'open' && a.id !== ap.id).length ? 'appealed' : 'reviewed';
  db.upsert('evaluations', ev);
  ap.status = 'resolved';
  ap.decision = { ...crit.review, new_label: answerLabel(def, newAnswer), total_before: before, total_after: ev.final_score.total };
  db.upsert('appeals', ap);
  return { appeal: ap, final_score: ev.final_score };
});

// Обучение на апелляциях: причина решения проверяющего добавляется в «Уточнения для ИИ» критерия → новая версия чек-листа.
route('POST', '/api/appeals/:id/learn', ({ p, body }) => {
  const ap = db.get('appeals', p.id);
  if (!ap) throw new HttpError(404, 'Апелляция не найдена');
  if (ap.status !== 'resolved' || ap.decision?.action !== 'change') throw new HttpError(409, 'Добавить в чек-лист можно только изменённую оценку');
  if (ap.learned) throw new HttpError(409, `Уже добавлено в чек-лист v${ap.learned.version}`);
  const text = String(body.text || '').trim();
  if (!text) throw new HttpError(400, 'Пустое уточнение');
  const ev = db.get('evaluations', ap.evaluation_id);
  const prev = db.get('checklists', ev.checklist_id);
  if (!prev) throw new HttpError(404, 'Чек-лист оценки удалён');
  const cl = structuredClone(prev);
  const c = cl.criteria.find((x) => x.id === ap.criterion_id);
  if (!c) throw new HttpError(409, 'В текущей версии чек-листа этого критерия нет');
  c.guidance = [c.guidance, text].filter(Boolean).join(' ');
  Object.assign(cl, { version: prev.version + 1, updated_at: new Date().toISOString() });
  db.upsert('checklists', cl);
  db.insert('checklist_versions', { ...structuredClone(cl), vid: `${cl.id}@${cl.version}` });
  ap.learned = { version: cl.version, text, at: cl.updated_at };
  db.upsert('appeals', ap);
  return { appeal: ap, checklist: { id: cl.id, version: cl.version } };
});

// Экспорт последних оценок (CSV / JSON)
route('GET', '/api/export', ({ q, res }) => {
  const clId = q.get('checklist_id');
  const g = q.get('group_id');
  const latest = new Map();
  for (const e of db.all('evaluations')) {
    if (clId && e.checklist_id !== clId) continue;
    if (g && e.group_id !== g) continue;
    const cur = latest.get(e.conversation_id);
    if (!cur || e.created_at > cur.created_at) latest.set(e.conversation_id, e);
  }
  const evs = [...latest.values()].sort((a, b) => a.conversation_id.localeCompare(b.conversation_id));
  if (q.get('format') === 'json') {
    return evs.map((e) => ({
      conversation_id: e.conversation_id, checklist: `${e.checklist.name} v${e.checklist_version}`, total: e.final_score.total, ai_total: e.original_score.total, gross_error: e.final_score.gross_error,
      criteria: e.criteria.map((c) => ({ id: c.criterion_id, name: e.checklist.criteria.find((d) => d.id === c.criterion_id)?.name, ai_answer: c.ai.answer, final_answer: c.final_answer, points: c.final.points, explanation: c.ai.explanation, evidence: c.ai.evidence })),
    }));
  }
  const crits = evs[0]?.checklist.criteria || [];
  const header = ['conversation_id', 'total', 'gross_error', ...crits.map((c) => `${c.code || c.id} ${c.name}`), 'checklist', 'model', 'cost_usd'];
  const rows = evs.map((e) => [e.conversation_id, e.final_score.total, e.final_score.gross_error ? 'yes' : 'no',
    ...crits.map((c) => { const x = e.criteria.find((y) => y.criterion_id === c.id); return x ? answerLabel(c, x.final_answer) : ''; }),
    `${e.checklist.name} v${e.checklist_version}`, e.model, e.cost_usd]);
  const csv = '﻿' + [header, ...rows].map((r) => r.map(csvEscape).join(';')).join('\n');
  res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="cqa-results.csv"' });
  res.end(csv);
});

// Результаты в формате организаторов (Results JSON 1.0): /api/results?group_id=DEV&checklist_id=…&use=ai|final&expect=10
route('GET', '/api/results', ({ q }) => {
  const g = q.get('group_id');
  if (!g) throw new HttpError(400, 'Укажите group_id');
  const convs = db.filter('conversations', (c) => c.group_id === g);
  if (!convs.length) throw new HttpError(404, `Набор ${g} не загружен`);
  const clId = q.get('checklist_id');
  const latest = (id) => db.filter('evaluations', (e) => e.conversation_id === id && (!clId || e.checklist_id === clId))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  const doc = buildResults({ conversationIds: convs.map((c) => c.conversation_id), latestEval: latest, teamName: q.get('team'), use: q.get('use') === 'final' ? 'final' : 'ai' });
  const expect = q.get('expect') ? Number(q.get('expect')) : undefined;
  const problems = validateResults(doc, { expectCount: expect, transcriptLengths: Object.fromEntries(convs.map((c) => [c.conversation_id, c.transcript.length])) });
  return { doc, problems };
});

// ===================== Песочница: свои диалоги, аудио, микрофон =====================
const UPLOADS = path.join(process.env.CQA_STORAGE_DIR || path.resolve('storage'), 'uploads');
const AUDIO_EXT = { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/ogg': 'ogg', 'audio/webm': 'webm', 'video/webm': 'webm', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/flac': 'flac' };
function mimeOf(f) { const e = path.extname(f).slice(1); return { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', webm: 'audio/webm', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac' }[e] || 'application/octet-stream'; }
async function readRaw(req, limit = 200 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const ch of req) { size += ch.length; if (size > limit) throw new HttpError(413, 'Файл больше 200 МБ'); chunks.push(ch); }
  return Buffer.concat(chunks);
}

route('GET', '/api/asr/status', () => ({ available: asrAvailable(), model: ASR_MODEL }));

// Аудиофайл или запись с микрофона → распознавание. Тело — сами байты, тип — в content-type.
route('POST', '/api/sandbox/transcribe', async ({ req, q }) => {
  const ct = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const ext = AUDIO_EXT[ct] || (q.get('name') || '').split('.').pop().toLowerCase();
  if (!Object.values(AUDIO_EXT).includes(ext)) throw new HttpError(415, 'Поддерживаются аудиофайлы mp3, wav, ogg, webm, m4a, aac, flac');
  const buf = await readRaw(req);
  if (buf.length < 1000) throw new HttpError(400, 'Слишком короткая запись');
  fs.mkdirSync(UPLOADS, { recursive: true });
  const id = newId('up');
  const file = path.join(UPLOADS, `${id}.${ext}`);
  fs.writeFileSync(file, buf);
  const lang = ({ RU: 'ru', KZ: 'kk', EN: 'en' })[(q.get('lang') || '').toUpperCase()] || 'auto';
  const started = Date.now();
  const r = await transcribeFile(file, { lang });
  return { upload_id: id, file_name: q.get('name') || `${id}.${ext}`, ...r, language: ({ ru: 'RU', kk: 'KZ', en: 'EN' })[r.language] || (r.language || '').toUpperCase(), seconds: Math.round((Date.now() - started) / 100) / 10 };
}, { raw: true });

// Загруженная запись: отдаём с поддержкой Range, чтобы плеер мог перематывать.
route('GET', '/api/uploads/:id', ({ p, req, res }) => {
  const f = localUpload(`upload:${p.id}`);
  if (!f) throw new HttpError(404, 'Файл не найден');
  const size = fs.statSync(f).size;
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (m) {
    const start = m[1] ? Number(m[1]) : 0, end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    res.writeHead(206, { 'content-type': mimeOf(f), 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes', 'content-length': end - start + 1 });
    return fs.createReadStream(f, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'content-type': mimeOf(f), 'content-length': size, 'accept-ranges': 'bytes' });
  fs.createReadStream(f).pipe(res);
});

// Новый диалог из песочницы (конструктор, текст или распознанное аудио).
route('POST', '/api/sandbox/create', ({ body }) => {
  const tr = (body.transcript || []).filter((m) => String(m.text || '').trim());
  if (!tr.length) throw new HttpError(400, 'Добавьте хотя бы одну реплику');
  if (!tr.some((m) => m.speaker === 'operator')) throw new HttpError(400, 'В диалоге нет ни одной реплики оператора — оценивать нечего');
  const mmss = (sec) => `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
  const isAudio = Boolean(body.upload_id && localUpload(`upload:${body.upload_id}`));
  const rec = {
    conversation_id: `sb-${Date.now().toString(36)}`,
    title: body.title, source: isAudio ? 'audio' : 'sandbox',
    channel: body.channel === 'voice call' || isAudio ? 'voice call' : 'agent chat',
    language: ['RU', 'KZ', 'EN'].includes(body.language) ? body.language : undefined,
    audio_url: isAudio ? `upload:${body.upload_id}` : null,
    time_origin: 'zero',
    transcript: tr.map((m, i) => ({ timestamp: mmss(Number.isFinite(+m.offset_sec) ? +m.offset_sec : i * 20), speaker: m.speaker, text: String(m.text).trim() })),
  };
  const conv = normalizeRecord(rec, 'SANDBOX');
  db.upsert('conversations', conv, 'conversation_id');
  return conv;
});

// ===================== ИИ-помощник по диалогу и оценке =====================
route('POST', '/api/assistant', async ({ body }) => {
  const q = String(body.question || '').trim();
  if (!q) throw new HttpError(400, 'Задайте вопрос');
  const conv = body.conversation_id ? db.get('conversations', body.conversation_id, 'conversation_id') : null;
  const ev = body.evaluation_id ? db.get('evaluations', body.evaluation_id) : conv ? db.filter('evaluations', (e) => e.conversation_id === conv.conversation_id).sort((a, b) => b.created_at.localeCompare(a.created_at))[0] : null;
  const cl = ev?.checklist || db.get('checklists', body.checklist_id) || db.all('checklists')[0];
  const ctx = [];
  ctx.push(`Чек-лист «${cl.name}»:\n` + cl.criteria.map((c) => `- ${c.code} ${c.name} (${c.type === 'flag' ? 'флаг' : 'вес ' + c.weight}${c.na_allowed ? ', N/A: ' + c.na_condition : ''}): ${c.description}`).join('\n'));
  if (conv) ctx.push(`Диалог ${conv.conversation_id} (${conv.channel}, ${conv.language}):\n` + conv.transcript.map((m) => `#${m.idx} ${m.speaker}: ${m.text}`).join('\n'));
  if (ev) ctx.push(`Оценка системы: итог ${ev.final_score.total ?? '—'} из 100${ev.final_score.gross_error ? ', есть грубая ошибка' : ''}.\n` + ev.criteria.map((r) => {
    const c = cl.criteria.find((x) => x.id === r.criterion_id);
    return `- ${c?.name}: ${answerLabel(c, r.final_answer)}${r.final_answer !== r.ai.answer ? ` (ИИ: ${answerLabel(c, r.ai.answer)}, изменено проверяющим)` : ''}. ${r.ai.explanation} Реплики: ${(r.ai.evidence || []).map((e) => '#' + e.message).join(', ') || '—'}`;
  }).join('\n'));
  const system = [
    'Ты — ИИ-помощник отдела контроля качества брокерской компании. Отвечаешь специалистам QA, руководителям и операторам.',
    'Опирайся только на данные ниже: чек-лист, транскрипт и оценку. Не выдумывай реплики; ссылайся на номера (#N).',
    'Если просят текст апелляции или рекомендацию оператору — пиши кратко, по делу, деловым языком. Отвечай на языке вопроса, по умолчанию по-русски. 3–8 предложений, без лишних вступлений.',
    '', ...ctx,
  ].join('\n');
  const history = (body.history || []).slice(-8).filter((m) => ['user', 'assistant'].includes(m.role) && m.content).map((m) => ({ role: m.role, content: String(m.content).slice(0, 4000) }));
  const r = await completeText({ system, messages: [...history, { role: 'user', content: q }] });
  return { answer: r.text, model: r.model, cost_usd: r.cost_usd };
});

// ===================== Расчёт «что если» и ручная оценка =====================
route('POST', '/api/score', ({ body }) => {
  const cl = body.checklist || db.get('checklists', body.checklist_id) || db.all('checklists')[0];
  const answers = {};
  for (const c of cl.criteria) answers[c.id] = body.answers?.[c.id] == null ? null : normalizeAnswer(c, body.answers[c.id]).answer;
  return computeScore(cl, answers);
});

route('POST', '/api/evaluations/manual', ({ body }) => {
  const conv = db.get('conversations', body.conversation_id, 'conversation_id');
  if (!conv) throw new HttpError(404, 'Диалог не найден');
  const cl = structuredClone(db.get('checklists', body.checklist_id) || db.all('checklists')[0]);
  const answers = {};
  for (const c of cl.criteria) {
    const raw = body.answers?.[c.id];
    if (raw == null || raw === '') throw new HttpError(400, `Не заполнен критерий «${c.name}»`);
    if (!allowedAnswers(c).includes(String(raw))) throw new HttpError(400, `«${c.name}»: недопустимое значение ${raw}`);
    answers[c.id] = String(raw);
  }
  const score = computeScore(cl, answers);
  const who = String(body.reviewer || 'Проверяющий').slice(0, 80);
  const ev = {
    id: newId('ev'), conversation_id: conv.conversation_id, group_id: conv.group_id, checklist_id: cl.id, checklist_version: cl.version, checklist: cl,
    created_at: new Date().toISOString(), provider: 'manual', model: who, effort: null, runs: 1, mode: 'manual', duration_ms: 0, usage: {}, cost_usd: 0,
    summary: body.summary || `Ручная оценка: ${who}`,
    criteria: cl.criteria.map((c) => ({ criterion_id: c.id, final_answer: answers[c.id], original: score.per_criterion[c.id], final: score.per_criterion[c.id],
      ai: { answer: answers[c.id], label: answerLabel(c, answers[c.id]), explanation: String(body.comments?.[c.id] || 'Ручная оценка проверяющего.'), evidence: (body.evidence?.[c.id] || []).filter((n) => n >= 1 && n <= conv.transcript.length).map((n) => ({ message: n, quote: conv.transcript[n - 1].text.slice(0, 160), speaker: conv.transcript[n - 1].speaker, timestamp: conv.transcript[n - 1].timestamp, offset_sec: conv.transcript[n - 1].offset_sec })), checked_range: null, agreement: 1 } })),
    original_score: score, final_score: score, status: 'manual',
  };
  saveEvaluation(ev);
  return ev;
});

// ===================== Распределение между проверяющими =====================
const reviewers = () => db.get('settings', 'reviewers')?.names || [];
route('GET', '/api/reviewers', () => ({ names: reviewers() }));
route('PUT', '/api/reviewers', ({ body }) => {
  const names = [...new Set((body.names || []).map((n) => String(n).trim()).filter(Boolean))].slice(0, 50);
  db.upsert('settings', { id: 'reviewers', names });
  return { names };
});
// Назначить конкретному проверяющему (или снять: assignee = null).
route('POST', '/api/assign', ({ body }) => {
  const who = body.assignee ? String(body.assignee).trim() : null;
  let n = 0;
  for (const id of body.conversation_ids || []) { const c = db.get('conversations', id, 'conversation_id'); if (c) { c.assignee = who; n++; } }
  for (const id of body.appeal_ids || []) { const a = db.get('appeals', id); if (a) { a.assignee = who; n++; } }
  db.touch('conversations'); db.touch('appeals');
  return { updated: n };
});
// Распределить поровну с учётом текущей нагрузки (у кого меньше назначенных — тому следующий).
route('POST', '/api/assign/auto', ({ body }) => {
  const names = (body.reviewers?.length ? body.reviewers : reviewers()).map(String);
  if (!names.length) throw new HttpError(400, 'Добавьте проверяющих');
  const load = Object.fromEntries(names.map((n) => [n, db.filter('conversations', (c) => c.assignee === n).length]));
  const plan = {};
  for (const id of body.conversation_ids || []) {
    const c = db.get('conversations', id, 'conversation_id'); if (!c) continue;
    if (c.assignee && load[c.assignee] != null) load[c.assignee]--;
    const who = names.reduce((a, b) => (load[b] < load[a] ? b : a));
    c.assignee = who; load[who]++; plan[who] = (plan[who] || 0) + 1;
  }
  db.touch('conversations');
  return { plan, load };
});

// ---------- сервер ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  // CORS — чтобы UI можно было встроить как HTML-ресурс Dynamics 365 с другого домена
  res.setHeader('access-control-allow-origin', process.env.CQA_CORS_ORIGIN || '*');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  try {
    if (url.pathname.startsWith('/api/')) {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = url.pathname.match(r.re);
        if (!m) continue;
        const body = ['POST', 'PUT'].includes(req.method) && !r.raw ? await readBody(req) : null;
        const out = await r.handler({ req, res, p: m.groups || {}, q: url.searchParams, body });
        if (!res.headersSent) send(res, 200, out ?? {});
        return;
      }
      throw new HttpError(404, 'Маршрут не найден');
    }
    let file = path.normalize(path.join(PUBLIC, decodeURIComponent(url.pathname)));
    if (!file.startsWith(PUBLIC)) throw new HttpError(403, 'Forbidden');
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) file = path.join(PUBLIC, 'index.html');
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    const status = e.status || (e.constructor?.name?.includes('Authentication') ? 401 : 500);
    if (status >= 500) console.error('[http]', req.method, url.pathname, e);
    if (!res.headersSent) send(res, status, { error: String(e.message || e) });
  }
});

migrateTraces();
backfillReview();
resumeJobs();

// Долгие оценки (локальная модель, 8 вызовов) не должны обрываться таймаутом HTTP-сервера.
server.requestTimeout = 20 * 60_000;
server.headersTimeout = 65_000;
server.keepAliveTimeout = 60_000;

// Корректная остановка: дописать хранилище на диск. Незавершённая очередь продолжится при запуске.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, async () => {
    console.log(`\n${sig}: сохраняю данные…`);
    server.close();
    await db.flush();
    process.exit(0);
  });
}

server.listen(PORT, async () => {
  const info = providerInfo();
  console.log(`CQA запущен: http://localhost:${PORT}`);
  console.log(`LLM: ${info.provider} / ${info.model}${info.configured ? '' : '  ⚠ ключ API не задан — оценка недоступна'}`);
  const ready = await providerReady();
  if (!ready.ready) console.log(`⚠ ${ready.problem}`);
});
