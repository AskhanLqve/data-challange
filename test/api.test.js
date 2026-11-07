// Автотесты API: настоящий сервер на свободном порту, временное хранилище, модель-заглушка (CQA_PROVIDER=stub).
// Проверяют сценарии из задания: загрузка → оценка → результат → апелляция → решение → пересчёт → новая версия чек-листа.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

let base, proc, storage;

const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); }); });

async function startServer() {
  const port = await freePort();
  proc = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(port), CQA_PROVIDER: 'stub', CQA_STORAGE_DIR: storage, CQA_MODE: 'single', CQA_RUNS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  base = `http://localhost:${port}`;
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(base + '/api/health')).ok) return; } catch { /* ещё стартует */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('сервер не запустился');
}
const stopServer = () => new Promise((r) => { proc.once('exit', r); proc.kill(); });

async function api(method, url, body, raw) {
  const res = await fetch(base + url, {
    method,
    headers: body === undefined ? {} : { 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    redirect: 'manual',
  });
  if (raw) return res;
  const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
  return { status: res.status, data };
}

const CHAT = {
  conversation_id: 't-chat-1', channel: 'agent chat', language: 'RU', audio_url: null,
  transcript: [
    { timestamp: '00:00', speaker: 'client', text: 'Где посмотреть тариф?' },
    { timestamp: '00:30', speaker: 'operator', text: 'Здравствуйте, меня зовут Анна. Во вкладке «Кабинет».' },
    { timestamp: '00:50', speaker: 'client', text: 'Спасибо' },
    { timestamp: '01:00', speaker: 'operator', text: 'Если будут вопросы — пишите. До свидания!' },
  ],
};

before(async () => { storage = fs.mkdtempSync(path.join(os.tmpdir(), 'cqa-test-')); await startServer(); });
after(async () => { await stopServer(); fs.rmSync(storage, { recursive: true, force: true }); });

test('health и исходный чек-лист из PDF', async () => {
  const h = await api('GET', '/api/health');
  assert.equal(h.status, 200);
  assert.equal(h.data.provider, 'stub');
  const cl = await api('GET', '/api/checklists/cqa-default');
  assert.equal(cl.data.criteria.length, 8);
  assert.equal(cl.data.criteria.filter((c) => c.type !== 'flag').reduce((s, c) => s + c.weight, 0), 100);
});

test('импорт: JSON-запись, текст, ошибка формата', async () => {
  let r = await api('POST', '/api/conversations/upload', CHAT);
  assert.deepEqual(r.data.imported, ['t-chat-1']);
  r = await api('POST', '/api/conversations/upload?group_id=T', '[00:01] client: Привет\n[00:10] operator: Здравствуйте, я Ая');
  assert.equal(r.status, 200);
  assert.equal(r.data.imported.length, 1);
  const txtId = r.data.imported[0];
  const conv = await api('GET', `/api/conversations/${txtId}`);
  assert.equal(conv.data.transcript[1].speaker, 'operator');
  assert.equal(conv.data.transcript[1].offset_sec, 9);
  r = await api('POST', '/api/conversations/upload', 'просто текст без ролей');
  assert.equal(r.status, 500);
  assert.match(r.data.error, /Не удалось разобрать/);
  r = await api('DELETE', `/api/conversations/${txtId}`);
  assert.equal(r.data.deleted, true);
  assert.equal((await api('GET', `/api/conversations/${txtId}`)).status, 404);
});

test('оценка → апелляция → решение → пересчёт итога', async () => {
  const ev = await api('POST', '/api/evaluate', { conversation_id: 't-chat-1', checklist_id: 'cqa-default' });
  assert.equal(ev.status, 200);
  assert.equal(ev.data.criteria.length, 8);
  for (const c of ev.data.criteria) {
    assert.ok(c.ai.explanation, 'есть объяснение');
    assert.ok(Array.isArray(c.ai.evidence), 'есть доказательства');
  }
  // заглушка ставит первое допустимое значение: «yes» / нижняя ступень шкалы
  const before = ev.data.final_score.total;
  assert.equal(typeof before, 'number');

  // апелляция по шкальному критерию c06 (заглушка поставила 0)
  const ap = await api('POST', '/api/appeals', { evaluation_id: ev.data.id, criterion_id: 'c06', comment: 'Ответы ясные (#2)', requested_answer: '10' });
  assert.equal(ap.status, 200);
  assert.equal(ap.data.status, 'open');
  const dup = await api('POST', '/api/appeals', { evaluation_id: ev.data.id, criterion_id: 'c06', comment: 'ещё раз' });
  assert.equal(dup.status, 409);
  const noComment = await api('POST', '/api/appeals', { evaluation_id: ev.data.id, criterion_id: 'c05', comment: '  ' });
  assert.equal(noComment.status, 400);

  const bad = await api('POST', `/api/appeals/${ap.data.id}/decision`, { action: 'change', new_answer: '11', reason: 'x' });
  assert.equal(bad.status, 400);
  const noReason = await api('POST', `/api/appeals/${ap.data.id}/decision`, { action: 'change', new_answer: '10', reason: '' });
  assert.equal(noReason.status, 400);
  const ok = await api('POST', `/api/appeals/${ap.data.id}/decision`, { action: 'change', new_answer: '10', reason: 'Сбоя нет', reviewer: 'QA' });
  assert.equal(ok.status, 200);
  assert.ok(ok.data.final_score.total > before, 'итог вырос после изменения оценки');

  const after = await api('GET', `/api/evaluations/${ev.data.id}`);
  assert.equal(after.data.status, 'reviewed');
  assert.equal(after.data.original_score.total, before, 'исходная оценка ИИ сохранена');
  const c06 = after.data.criteria.find((c) => c.criterion_id === 'c06');
  assert.equal(c06.final_answer, '10');
  assert.equal(c06.ai.answer, '0');
  assert.equal(c06.review.reason, 'Сбоя нет');
  const again = await api('POST', `/api/appeals/${ap.data.id}/decision`, { action: 'confirm', reason: 'x' });
  assert.equal(again.status, 409);
});

test('чек-лист: валидация, новая версия, замена критерия применяется к оценке', async () => {
  const bad = await api('PUT', '/api/checklists/cqa-default', { name: '', criteria: [] });
  assert.equal(bad.status, 400);
  const cl = (await api('GET', '/api/checklists/cqa-default')).data;
  cl.criteria[6] = { id: 'c09', code: '07', name: 'Предложение продукта', section: 'flow', type: 'scale', weight: 5, na_allowed: true, na_condition: 'Нет повода', description: 'Оператор предложил подходящий продукт', scale: [{ value: 2, label: 'Да' }, { value: 0, label: 'Нет' }] };
  const saved = await api('PUT', '/api/checklists/cqa-default', cl);
  assert.equal(saved.status, 200);
  assert.equal(saved.data.version, cl.version + 1);
  const versions = await api('GET', '/api/checklists/cqa-default/versions');
  assert.ok(versions.data.length >= 2);
  const ev = await api('POST', '/api/evaluate', { conversation_id: 't-chat-1', checklist_id: 'cqa-default' });
  assert.ok(ev.data.criteria.some((c) => c.criterion_id === 'c09'), 'новый критерий оценён');
  assert.ok(!ev.data.criteria.some((c) => c.criterion_id === 'c07'), 'заменённый критерий не оценивается');
  assert.match(ev.data.trace.system_prompt, /Предложение продукта/, 'новый критерий попал в промпт');
  const reset = await api('POST', '/api/checklists/cqa-default/reset-default');
  assert.equal(reset.data.criteria[6].id, 'c07');
});

test('пакетная оценка, сохранение очереди и экспорт', async () => {
  await api('POST', '/api/conversations/upload?group_id=B', [{ ...CHAT, conversation_id: 'b-1' }, { ...CHAT, conversation_id: 'b-2' }, { ...CHAT, conversation_id: 'b-3' }]);
  let job = (await api('POST', '/api/evaluate/batch', { group_id: 'B', checklist_id: 'cqa-default' })).data;
  assert.equal(job.total, 3);
  for (let i = 0; i < 50 && job.status === 'running'; i++) { await new Promise((r) => setTimeout(r, 100)); job = (await api('GET', `/api/jobs/${job.id}`)).data; }
  assert.equal(job.status, 'finished');
  assert.equal(job.done, 3);
  assert.ok(fs.existsSync(path.join(storage, 'jobs.json')), 'очередь сохранена на диск');
  const only = (await api('POST', '/api/evaluate/batch', { group_id: 'B', checklist_id: 'cqa-default', only_new: true }));
  assert.equal(only.status, 400, 'повторно уже оценённые не ставятся в очередь');

  const csv = await api('GET', '/api/export?group_id=B');
  assert.match(csv.data, /^\uFEFF?conversation_id;total;gross_error/);
  assert.equal(csv.data.trim().split('\n').length, 4);
  const json = await api('GET', '/api/export?format=json&group_id=B');
  assert.equal(json.data.length, 3);
  assert.equal(json.data[0].criteria.length, 8);
});

test('ошибки: 404 и неизвестный маршрут, статика', async () => {
  assert.equal((await api('GET', '/api/evaluations/nope')).status, 404);
  assert.equal((await api('GET', '/api/nope')).status, 404);
  assert.equal((await api('GET', '/api/audio/t-chat-1')).status, 404, 'у чата нет записи');
  const page = await api('GET', '/app.html', undefined, true);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<cqa-app/);
  const landing = await api('GET', '/', undefined, true);
  assert.match(await landing.text(), /Открыть приложение/);
});

test('очередь продолжается после перезапуска сервера', async () => {
  // имитируем прерванную задачу: «running» с непустой очередью и диалогом «в работе»
  await stopServer();
  const file = path.join(storage, 'jobs.json');
  const jobs = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cl = JSON.parse(fs.readFileSync(path.join(storage, 'checklists.json'), 'utf8'))[0];
  jobs.push({ id: 'job_resume', checklist_id: cl.id, checklist_name: cl.name, checklist: cl, total: 2, pending: ['b-2'], inflight: ['b-1'], done: 0, failed: 0, errors: [], results: [], status: 'running', started_at: new Date().toISOString(), cost_usd: 0 });
  fs.writeFileSync(file, JSON.stringify(jobs));
  await startServer();
  let job;
  for (let i = 0; i < 50; i++) { job = (await api('GET', '/api/jobs/job_resume')).data; if (job.status === 'finished') break; await new Promise((r) => setTimeout(r, 100)); }
  assert.equal(job.status, 'finished');
  assert.equal(job.done, 2, 'диалог «в работе» вернулся в очередь и оценён');
});
