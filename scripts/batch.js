// Пакетная оценка набора из терминала (например, контрольного):
//   pnpm batch --group CONTROL [--checklist cqa-default] [--only-new] [--api http://localhost:3000]
// Работает через API запущенного сервера (pnpm start): загружает набор по group_id из API организаторов,
// ставит его в очередь оценки, показывает прогресс и сохраняет results/<group>.json и .csv.
// Оценки сразу видны в интерфейсе; очередь переживает перезапуск сервера.
import fs from 'node:fs';

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const API = arg('api', process.env.CQA_API || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
const group = arg('group', 'DEV');

async function api(method, url, body) {
  const res = await fetch(API + url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data.error || data || `HTTP ${res.status}`);
  return data;
}

try { await api('GET', '/api/health'); } catch { console.error(`Сервер не отвечает на ${API}. Запустите: pnpm start`); process.exit(1); }
const health = await api('GET', '/api/health');
const checklists = await api('GET', '/api/checklists');
const checklist = checklists.find((c) => c.id === arg('checklist', 'cqa-default')) || checklists[0];
console.log(`Модель: ${health.provider}/${health.model} · чек-лист «${checklist.name}» v${checklist.version}`);

const fetched = await api('POST', '/api/datasets/fetch', { group_id: group });
console.log(`Набор ${group}: загружено ${fetched.total} диалогов`);
let job = await api('POST', '/api/evaluate/batch', { group_id: group, checklist_id: checklist.id, only_new: args.includes('--only-new') });
console.log(`Очередь ${job.id}: ${job.total} диалогов`);
while (job.status === 'running') {
  await new Promise((r) => setTimeout(r, 3000));
  job = await api('GET', `/api/jobs/${job.id}`);
  process.stdout.write(`\r  готово ${job.done}/${job.total}, ошибок ${job.failed}   `);
}
console.log('');
for (const e of job.errors) console.error(`✗ ${e.conversation_id}: ${e.error}`);

fs.mkdirSync('results', { recursive: true });
fs.writeFileSync(`results/${group}.json`, JSON.stringify(await api('GET', `/api/export?format=json&group_id=${group}&checklist_id=${checklist.id}`), null, 2));
fs.writeFileSync(`results/${group}.csv`, await api('GET', `/api/export?group_id=${group}&checklist_id=${checklist.id}`));
console.log(`Готово: ${job.done}/${job.total} · стоимость $${job.cost_usd} · файлы results/${group}.json, results/${group}.csv`);
