// Выгрузка результатов в формате организаторов (Results JSON 1.0) в results/<set>/results.json.
//
//   pnpm results --group DEV --set dev                  # выгрузить уже готовые оценки DEV
//   pnpm results --group <id> --set prod --run --push   # контроль: загрузить, оценить, выгрузить, проверить, commit+push
//
//   --run      загрузить набор из API организаторов и оценить неоценённые диалоги текущей версией чек-листа
//   --push     после успешной проверки: git add/commit/push файла результатов
//   --use final  брать оценки с учётом решений по апелляциям (по умолчанию — исходный ответ ИИ)
//   --team "Название"  название команды (или CQA_TEAM_NAME в .env)
//   --checklist <id>, --api http://localhost:3000
// Работает через API запущенного сервера (pnpm start).
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const has = (k) => args.includes(`--${k}`);
const API = arg('api', process.env.CQA_API || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
const group = arg('group');
const set = arg('set', group === 'DEV' ? 'dev' : 'prod');
if (!group || !['dev', 'prod'].includes(set)) { console.error('Использование: pnpm results --group <group_id> --set dev|prod [--run] [--push]'); process.exit(2); }
const expect = set === 'prod' ? 10 : undefined;

async function api(method, url, body) {
  const res = await fetch(API + url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status} ${url}`);
  return data;
}
const t0 = Date.now();
const elapsed = () => `${Math.round((Date.now() - t0) / 1000)} с`;

try { await api('GET', '/api/health'); } catch { console.error(`Сервер не отвечает на ${API}. Запустите: pnpm start`); process.exit(1); }
const checklists = await api('GET', '/api/checklists');
const checklist = checklists.find((c) => c.id === arg('checklist', 'cqa-default')) || checklists[0];

if (has('run')) {
  const f = await api('POST', '/api/datasets/fetch', { group_id: group });
  console.log(`[${elapsed()}] набор ${group}: ${f.total} диалогов`);
  let job;
  try { job = await api('POST', '/api/evaluate/batch', { group_id: group, checklist_id: checklist.id, only_new: true }); }
  catch (e) { if (/уже оценены/.test(e.message)) console.log(`[${elapsed()}] ${e.message}`); else throw e; }
  while (job && job.status === 'running') {
    await new Promise((r) => setTimeout(r, 3000));
    job = await api('GET', `/api/jobs/${job.id}`);
    process.stdout.write(`\r[${elapsed()}] оценено ${job.done}/${job.total}, ошибок ${job.failed}   `);
  }
  if (job) console.log('');
  for (const e of job?.errors || []) console.error(`  ✗ ${e.conversation_id}: ${e.error}`);
}

const q = new URLSearchParams({ group_id: group, checklist_id: checklist.id, use: has('use') && arg('use') === 'final' ? 'final' : 'ai' });
if (arg('team')) q.set('team', arg('team'));
if (expect) q.set('expect', String(expect));
const { doc, problems } = await api('GET', `/api/results?${q}`);
const file = `results/${set}/results.json`;
fs.mkdirSync(`results/${set}`, { recursive: true });
fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', 'utf8');

const ok = doc.results.filter((r) => r.status === 'ok').length;
console.log(`[${elapsed()}] ${file}: ${doc.results.length} записей, оценено ${ok}, ошибок ${doc.results.length - ok}; команда «${doc.team_name}», модель ${doc.model.mode}/${doc.model.name}`);
if (problems.length) {
  console.error(`Проверка формата НЕ пройдена (${problems.length}):`);
  for (const p of problems.slice(0, 30)) console.error('  - ' + p);
  process.exit(1);
}
console.log('Проверка формата пройдена.');

if (has('push')) {
  const git = (...a) => execFileSync('git', a, { stdio: 'inherit' });
  git('add', file);
  try { git('commit', '-m', `results: ${set} (${group}), ${ok}/${doc.results.length}`); } catch { console.log('Нет изменений для коммита.'); }
  git('push');
  console.log(`[${elapsed()}] отправлено в репозиторий.`);
}
