// HTTP-сервер CQA: REST API + статический интерфейс из ./public. Без фреймворков.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { db, newId } from './db.js';
import { DEFAULT_CHECKLIST } from './defaultChecklist.js';
import { fetchGroup, extractRecords, importRecords, resolveAudio } from './dataset.js';
import { evaluateConversation, recomputeFinal, startBatch, getJob, listJobs, publicJob, resumeJobs } from './evaluator.js';
import { providerInfo } from './llm.js';
import { allowedAnswers, answerLabel } from './scoring.js';

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
    messages: c.transcript.length, has_audio: Boolean(c.audio_url),
    preview: (c.transcript.find((m) => m.speaker === 'client')?.text || '').slice(0, 140),
    last_evaluation: last ? { id: last.id, total: last.final_score.total, original_total: last.original_score.total, gross: last.final_score.gross_error, checklist_name: last.checklist.name, checklist_version: last.checklist_version, created_at: last.created_at, status: last.status } : null,
    evaluations: evs.length,
  };
}

function csvEscape(v) { const s = v == null ? '' : String(v); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }

// ---------- маршруты ----------
const routes = [];
const route = (method, pattern, handler) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler });

route('GET', '/api/health', () => ({ ok: true, ...providerInfo() }));

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
  return { ...c, evaluations: evs };
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

// Оценка
route('POST', '/api/evaluate', async ({ body }) => {
  const conv = db.get('conversations', body.conversation_id, 'conversation_id');
  if (!conv) throw new HttpError(404, 'Диалог не найден');
  const cl = db.get('checklists', body.checklist_id) || db.all('checklists')[0];
  if (!providerInfo().configured) throw new HttpError(503, 'LLM не настроен: задайте ANTHROPIC_API_KEY в .env (или CQA_PROVIDER=ollama)');
  const ev = await evaluateConversation(conv, structuredClone(cl), { runs: body.runs ? Number(body.runs) : undefined });
  db.insert('evaluations', ev);
  return ev;
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
  }
  return startBatch(ids, structuredClone(cl));
});
route('GET', '/api/jobs', () => listJobs().map(publicJob));
route('GET', '/api/jobs/:id', ({ p }) => publicJob(getJob(p.id)) || (() => { throw new HttpError(404, 'Задача не найдена'); })());
route('GET', '/api/evaluations/:id', ({ p }) => {
  const ev = db.get('evaluations', p.id);
  if (!ev) throw new HttpError(404, 'Оценка не найдена');
  return { ...ev, appeals: db.filter('appeals', (a) => a.evaluation_id === ev.id) };
});

// Апелляции
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
        const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : null;
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

resumeJobs();

server.listen(PORT, () => {
  const info = providerInfo();
  console.log(`CQA запущен: http://localhost:${PORT}`);
  console.log(`LLM: ${info.provider} / ${info.model}${info.configured ? '' : '  ⚠ ключ API не задан — оценка недоступна'}`);
});
