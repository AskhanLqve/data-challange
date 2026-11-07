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

  // обучение на апелляции: причина попадает в уточнения критерия, создаётся новая версия чек-листа
  const clBefore = (await api('GET', '/api/checklists/cqa-default')).data;
  const learn = await api('POST', `/api/appeals/${ap.data.id}/learn`, { text: 'Короткий вежливый ответ — не сбой.' });
  assert.equal(learn.status, 200);
  assert.equal(learn.data.checklist.version, clBefore.version + 1);
  const clAfter = (await api('GET', '/api/checklists/cqa-default')).data;
  assert.match(clAfter.criteria.find((c) => c.id === ap.data.criterion_id).guidance, /Короткий вежливый ответ/);
  assert.equal((await api('POST', `/api/appeals/${ap.data.id}/learn`, { text: 'ещё' })).status, 409, 'повторно не добавляется');

  // «нужна проверка» снимается подтверждением
  const conf = await api('POST', `/api/evaluations/${ev.data.id}/confirm`, { reviewer: 'QA' });
  assert.equal(conf.status, 200);
  assert.equal(conf.data.reviewed, true);
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

test('живая оценка: поток NDJSON по критериям, затем итог', async () => {
  const res = await api('POST', '/api/evaluate/stream', { conversation_id: 't-chat-1', checklist_id: 'cqa-default', mode: 'per-criterion' }, true);
  assert.equal(res.status, 200);
  const lines = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines[0].type, 'start');
  const crit = lines.filter((l) => l.type === 'criterion' && !l.rechecked);
  assert.equal(crit.length, lines[0].criteria.length, 'по строке на каждый критерий');
  assert.ok(crit.every((c) => c.label), 'у каждого критерия подпись ответа');
  const done = lines.at(-1);
  assert.equal(done.type, 'done');
  assert.equal((await api('GET', `/api/evaluations/${done.evaluation_id}`)).status, 200, 'оценка сохранена');
});

test('точность ИИ: сводка последнего замера', async () => {
  const r = await api('GET', '/api/accuracy');
  assert.equal(r.status, 200);
  if (r.data.date) {
    assert.ok(r.data.agreement >= 0 && r.data.agreement <= 100);
    assert.ok(r.data.criteria.length > 0 && r.data.criteria.every((c) => c.name));
  }
});

test('перепроверка спорных критериев: ещё два ответа модели и голосование', async () => {
  const ev = await api('POST', '/api/evaluate', { conversation_id: 't-chat-1', checklist_id: 'cqa-default', mode: 'per-criterion' });
  assert.equal(ev.status, 200);
  assert.ok(Array.isArray(ev.data.rechecked));
  // заглушка цитирует «stub», которого нет в диалоге, — повод для сомнения, значит перепроверка была
  assert.ok(ev.data.rechecked.length > 0, 'спорные критерии перепроверены');
  for (const r of ev.data.rechecked) assert.equal(r.votes.length, 3);
  assert.ok(ev.data.rechecked.every((r) => !['c01'].includes(r.criterion_id)), 'ответ правила не перепроверяется');
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

test('аналитика и results.json по набору', async () => {
  const an = await api('GET', '/api/analytics?group_id=B&checklist_id=cqa-default');
  assert.equal(an.status, 200);
  assert.equal(an.data.evaluated, 3);
  assert.equal(an.data.criteria.length, 8);
  assert.equal(an.data.histogram.reduce((s, b) => s + b.count, 0), 3);
  const r = await api('GET', '/api/results?group_id=B&checklist_id=cqa-default');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.problems, [], 'формат проходит проверку');
  assert.equal(r.data.doc.schema_version, '1.0');
  assert.equal(r.data.doc.results.length, 3);
  assert.deepEqual(r.data.doc.results[0].criteria.map((c) => c.criterion_id), ['contact', 'discovery', 'identification', 'consultation', 'empathy', 'dialogue', 'closure', 'critical']);
  const p = await api('GET', '/api/results?group_id=B&expect=10');
  assert.ok(p.data.problems.some((x) => /ожидается 10/.test(x)));
  assert.equal((await api('GET', '/api/audio/t-chat-1/file')).status, 404);

  // запись звонка из локального кэша: без сети, с перемоткой (Range)
  await api('POST', '/api/conversations/upload?group_id=AUD', { conversation_id: 'aud-1', channel: 'voice call', language: 'RU', audio_url: 'http://127.0.0.1:9/unreachable',
    transcript: [{ timestamp: '00:00', speaker: 'client', text: 'Алло' }, { timestamp: '00:02', speaker: 'operator', text: 'Здравствуйте' }] });
  fs.mkdirSync(path.join(storage, 'audio'), { recursive: true });
  fs.writeFileSync(path.join(storage, 'audio', 'aud-1.mp3'), Buffer.from('0123456789'));
  const full = await fetch(base + '/api/audio/aud-1');
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  const part = await fetch(base + '/api/audio/aud-1', { headers: { range: 'bytes=2-5' } });
  assert.equal(part.status, 206);
  assert.equal(await part.text(), '2345');
});

test('песочница, «что если», ручная оценка, распределение, помощник', async () => {
  // свой диалог без API
  const bad = await api('POST', '/api/sandbox/create', { transcript: [{ speaker: 'client', text: 'Привет' }] });
  assert.equal(bad.status, 400, 'без оператора оценивать нечего');
  const sb = await api('POST', '/api/sandbox/create', { title: 'Тест', language: 'RU', transcript: [
    { speaker: 'client', text: 'Где тариф?', offset_sec: 0 }, { speaker: 'operator', text: 'Здравствуйте, я Анна. Во вкладке «Кабинет».', offset_sec: 30 }] });
  assert.equal(sb.status, 200);
  assert.equal(sb.data.group_id, 'SANDBOX');
  assert.equal(sb.data.transcript[1].offset_sec, 30, 'время от начала, без сдвига');
  const ev = await api('POST', '/api/evaluate', { conversation_id: sb.data.conversation_id, checklist_id: 'cqa-default' });
  assert.equal(ev.status, 200);

  // «что если»: N/A перераспределяет вес
  const sc = await api('POST', '/api/score', { checklist_id: 'cqa-default', answers: { c01: 'no', c02: 'yes', c03: 'na', c04: '20', c05: 'yes', c06: '10', c07: 'yes', c08: 'no' } });
  assert.equal(sc.data.total, 87.5);

  // ручная оценка проверяющим
  const manualBad = await api('POST', '/api/evaluations/manual', { conversation_id: sb.data.conversation_id, checklist_id: 'cqa-default', answers: { c01: 'yes' } });
  assert.equal(manualBad.status, 400);
  const manual = await api('POST', '/api/evaluations/manual', { conversation_id: sb.data.conversation_id, checklist_id: 'cqa-default', reviewer: 'QA Иван',
    answers: { c01: 'yes', c02: 'na', c03: 'na', c04: '20', c05: 'yes', c06: '10', c07: 'no', c08: 'no' }, comments: { c07: 'Нет итога' }, evidence: { c01: [2] } });
  assert.equal(manual.status, 200);
  assert.equal(manual.data.final_score.total, 92.31);
  assert.equal(manual.data.provider, 'manual');
  // человек и ИИ на одном диалоге
  const cmp = await api('GET', `/api/conversations/${sb.data.conversation_id}/compare`);
  assert.equal(cmp.data.available, true);
  assert.equal(cmp.data.rows.length, 8);
  assert.equal(cmp.data.matched, cmp.data.rows.filter((r) => r.match).length);
  assert.equal(cmp.data.human.total, 92.31);
  assert.equal(manual.data.criteria[0].ai.evidence[0].message, 2);

  // распределение
  await api('PUT', '/api/reviewers', { names: ['Айгерим', 'Иван', 'Айгерим'] });
  assert.deepEqual((await api('GET', '/api/reviewers')).data.names, ['Айгерим', 'Иван']);
  const auto = await api('POST', '/api/assign/auto', { conversation_ids: ['b-1', 'b-2', 'b-3'] });
  assert.equal(Object.values(auto.data.plan).reduce((a, b) => a + b, 0), 3);
  assert.ok(Math.abs(auto.data.load['Айгерим'] - auto.data.load['Иван']) <= 1, 'поровну');
  await api('POST', '/api/assign', { conversation_ids: ['b-1'], assignee: 'Иван' });
  const list = (await api('GET', '/api/conversations?group_id=B')).data;
  assert.equal(list.find((c) => c.conversation_id === 'b-1').assignee, 'Иван');

  // помощник (заглушка модели)
  const as = await api('POST', '/api/assistant', { conversation_id: sb.data.conversation_id, question: 'Почему такая оценка?' });
  assert.equal(as.status, 200);
  assert.ok(as.data.answer);
  assert.equal((await api('POST', '/api/assistant', { question: ' ' })).status, 400);
  assert.equal((await api('GET', '/api/uploads/nope')).status, 404);
});
