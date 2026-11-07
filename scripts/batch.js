// Пакетная оценка из терминала (для контрольного набора):
//   npm run batch -- --group CONTROL [--checklist cqa-default] [--only-new]
// Загружает набор из API организаторов, оценивает все диалоги текущей версией чек-листа,
// сохраняет оценки в хранилище (видны в UI) и пишет results/<group>.json и .csv.
import fs from 'node:fs';
import { db } from '../server/db.js';
import { fetchGroup } from '../server/dataset.js';
import { evaluateConversation } from '../server/evaluator.js';
import { providerInfo } from '../server/llm.js';
import { answerLabel } from '../server/scoring.js';
import { DEFAULT_CHECKLIST } from '../server/defaultChecklist.js';

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const group = arg('group', 'DEV');
const onlyNew = args.includes('--only-new');
const concurrency = Number(arg('concurrency', process.env.CQA_CONCURRENCY || 4));

const info = providerInfo();
if (!info.configured) { console.error('Задайте ANTHROPIC_API_KEY в .env (или CQA_PROVIDER=ollama)'); process.exit(1); }

let checklist = db.get('checklists', arg('checklist', DEFAULT_CHECKLIST.id)) || db.all('checklists')[0];
if (!checklist) checklist = { ...DEFAULT_CHECKLIST, version: 1 };
console.log(`Модель: ${info.provider}/${info.model} · чек-лист «${checklist.name}» v${checklist.version}`);

const { imported } = await fetchGroup(group);
console.log(`Набор ${group}: ${imported.length} диалогов`);
let ids = imported;
if (onlyNew) {
  const done = new Set(db.filter('evaluations', (e) => e.checklist_id === checklist.id && e.checklist_version === checklist.version).map((e) => e.conversation_id));
  ids = ids.filter((i) => !done.has(i));
}

const results = []; let cost = 0; const queue = [...ids];
await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
  while (queue.length) {
    const id = queue.shift();
    const conv = db.get('conversations', id, 'conversation_id');
    try {
      const ev = await evaluateConversation(conv, structuredClone(checklist));
      db.insert('evaluations', ev);
      cost += ev.cost_usd;
      results.push(ev);
      console.log(`✓ ${id}: ${ev.final_score.total}${ev.final_score.gross_error ? ' ⚠ грубая ошибка' : ''}  ($${ev.cost_usd})`);
    } catch (e) { console.error(`✗ ${id}: ${e.message}`); }
  }
}));
await db.flush();

results.sort((a, b) => a.conversation_id.localeCompare(b.conversation_id));
fs.mkdirSync('results', { recursive: true });
fs.writeFileSync(`results/${group}.json`, JSON.stringify(results.map((e) => ({
  conversation_id: e.conversation_id, total: e.final_score.total, gross_error: e.final_score.gross_error,
  criteria: e.criteria.map((c) => ({ id: c.criterion_id, answer: c.final_answer, points: c.final.points, explanation: c.ai.explanation, evidence: c.ai.evidence.map((x) => ({ message: x.message, quote: x.quote })) })),
})), null, 2));
const crits = checklist.criteria;
const csv = [['conversation_id', 'total', 'gross_error', ...crits.map((c) => `${c.code} ${c.name}`)].join(';'),
  ...results.map((e) => [e.conversation_id, e.final_score.total, e.final_score.gross_error ? 'yes' : 'no', ...crits.map((c) => answerLabel(c, e.criteria.find((x) => x.criterion_id === c.id)?.final_answer))].join(';'))].join('\n');
fs.writeFileSync(`results/${group}.csv`, '﻿' + csv);
console.log(`\nГотово: ${results.length}/${ids.length} · стоимость $${cost.toFixed(4)} (в среднем $${(cost / Math.max(1, results.length)).toFixed(4)} за диалог)`);
console.log(`Файлы: results/${group}.json, results/${group}.csv`);
