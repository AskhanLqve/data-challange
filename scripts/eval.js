// Измерение точности оценки ИИ по эталонной разметке (eval/gold/*.json).
//
//   pnpm eval                      # сравнить последние сохранённые оценки с эталоном (без вызовов модели)
//   pnpm eval --run                # оценить эталонные диалоги заново текущей моделью и чек-листом
//   pnpm eval --run --set synthetic   # только собственные пограничные случаи
//   параметры: --mode single|per-criterion, --set dev|synthetic|all (по умолчанию all), --ids id1,id2 (подмножество), --api http://localhost:3000
//
// Работает через API запущенного сервера (pnpm start), поэтому не конфликтует с его хранилищем.
// Сравнивается исходный ответ ИИ (до апелляций). Отчёт: консоль + eval/LATEST.md + eval/reports/<время>.json
import fs from 'node:fs';
import { computeScore, answerLabel } from '../server/scoring.js';

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const API = (arg('api', process.env.CQA_API || `http://localhost:${process.env.PORT || 3000}`)).replace(/\/$/, '');
const SET = arg('set', 'all');
const RUN = args.includes('--run');

async function api(method, url, body) {
  const res = await fetch(API + url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status} ${url}`);
  return data;
}

// ---------- эталон ----------
const sets = [];
if (SET === 'all' || SET === 'dev') sets.push({ name: 'dev', ...JSON.parse(fs.readFileSync('eval/gold/dev.json', 'utf8')) });
if (SET === 'all' || SET === 'synthetic') sets.push({ name: 'synthetic', ...JSON.parse(fs.readFileSync('eval/gold/synthetic.json', 'utf8')) });

try { await api('GET', '/api/health'); } catch { console.error(`Сервер не отвечает на ${API}. Запустите: pnpm start`); process.exit(1); }
const checklist = await api('GET', `/api/checklists/${sets[0].checklist_id}`);
const crit = new Map(checklist.criteria.map((c) => [c.id, c]));
const health = await api('GET', '/api/health');

// синтетические диалоги загружаем в сервис (группа SYNTH), если их там нет
const synth = sets.find((s) => s.name === 'synthetic');
if (synth) {
  const have = new Set((await api('GET', '/api/conversations?group_id=SYNTH')).map((c) => c.conversation_id));
  const missing = synth.items.filter((i) => !have.has(i.conversation_id)).map(({ labels, purpose, ...rec }) => rec);
  if (missing.length) await api('POST', '/api/conversations/upload?group_id=SYNTH', missing);
}

// ---------- получение предсказаний ----------
const convs = new Map((await api('GET', '/api/conversations')).map((c) => [c.conversation_id, c]));
const preds = new Map(); // conversation_id → { answers, total, explanations, evaluation_id }
const toPred = (ev) => ({
  evaluation_id: ev.id, total: ev.original_score.total, duration_ms: ev.duration_ms, cost_usd: ev.cost_usd, model: ev.model, provider: ev.provider,
  answers: Object.fromEntries(ev.criteria.map((c) => [c.criterion_id, c.ai.answer])),
  explanations: Object.fromEntries(ev.criteria.map((c) => [c.criterion_id, c.ai.explanation])),
});

const onlyIds = arg('ids', '') ? new Set(arg('ids').split(',')) : null;
const allItems = sets.flatMap((s) => s.items.map((i) => ({ ...i, set: s.name }))).filter((i) => !onlyIds || onlyIds.has(i.conversation_id));
if (RUN) {
  console.log(`Оцениваю ${allItems.length} диалогов: ${health.provider}/${health.model}, чек-лист «${checklist.name}» v${checklist.version}`);
  let n = 0;
  for (const item of allItems) {
    const t0 = Date.now();
    const ev = await api('POST', '/api/evaluate', { conversation_id: item.conversation_id, checklist_id: checklist.id, mode: arg('mode') });
    preds.set(item.conversation_id, toPred(ev));
    console.log(`  [${++n}/${allItems.length}] ${item.conversation_id}: ${ev.original_score.total} (${Math.round((Date.now() - t0) / 1000)} с)`);
  }
} else {
  for (const item of allItems) {
    const id = convs.get(item.conversation_id)?.last_evaluation?.id;
    if (id) preds.set(item.conversation_id, toPred(await api('GET', `/api/evaluations/${id}`)));
  }
}

// ---------- метрики ----------
const stat = () => ({ n: 0, ok: 0 });
const add = (s, ok) => { s.n++; if (ok) s.ok++; };
const pct = (s) => (s.n ? `${Math.round((s.ok / s.n) * 1000) / 10}%` : '—');
const byCrit = new Map(checklist.criteria.map((c) => [c.id, { all: stat(), sure: stat(), near: stat() }]));
const byLang = new Map();
const bySet = new Map();
const overall = { all: stat(), sure: stat() };
const gross = { tp: 0, fp: 0, fn: 0, tn: 0 };
const totals = [];
const mismatches = [];
let skipped = 0;

for (const item of allItems) {
  const p = preds.get(item.conversation_id);
  if (!p) { skipped++; continue; }
  const lang = convs.get(item.conversation_id)?.language || item.language || '?';
  if (!byLang.has(lang)) byLang.set(lang, stat());
  if (!bySet.has(item.set)) bySet.set(item.set, stat());
  for (const [cid, gold] of Object.entries(item.labels)) {
    const c = crit.get(cid);
    if (!c) continue;
    const pred = p.answers[cid];
    const ok = String(pred) === String(gold);
    const sure = !(item.uncertain || []).includes(cid);
    const b = byCrit.get(cid);
    add(b.all, ok); if (sure) add(b.sure, ok);
    if (c.type === 'scale') {
      // «рядом» — соседняя ступень шкалы
      const steps = c.scale.map((s) => String(s.value));
      const i = steps.indexOf(String(gold)), j = steps.indexOf(String(pred));
      add(b.near, ok || (i >= 0 && j >= 0 && Math.abs(i - j) <= 1));
    }
    add(overall.all, ok); if (sure) add(overall.sure, ok);
    add(byLang.get(lang), ok); add(bySet.get(item.set), ok);
    if (c.type === 'flag') {
      if (gold === 'yes' && pred === 'yes') gross.tp++; else if (gold === 'yes') gross.fn++; else if (pred === 'yes') gross.fp++; else gross.tn++;
    }
    if (!ok) mismatches.push({ id: item.conversation_id, set: item.set, cid, name: c.name, gold, pred, sure, why: (p.explanations[cid] || '').slice(0, 160), note: item.notes?.[cid] || item.purpose || '' });
  }
  const full = checklist.criteria.every((c) => item.labels[c.id] != null);
  if (full) {
    const goldTotal = computeScore(checklist, item.labels).total;
    totals.push({ id: item.conversation_id, gold: goldTotal, pred: p.total, diff: p.total == null || goldTotal == null ? null : Math.abs(p.total - goldTotal) });
  }
}

const diffs = totals.filter((t) => t.diff != null).map((t) => t.diff);
const mae = diffs.length ? Math.round((diffs.reduce((a, b) => a + b, 0) / diffs.length) * 100) / 100 : null;
const within = (x) => (diffs.length ? `${Math.round((diffs.filter((d) => d <= x).length / diffs.length) * 100)}%` : '—');

// ---------- отчёт ----------
const now = new Date();
const md = [];
md.push(`# Точность оценки ИИ`, '');
md.push(`- Дата: ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC`);
md.push(`- Модель: \`${health.provider}/${health.model}\`${health.effort ? `, effort ${health.effort}` : ''}`);
md.push(`- Чек-лист: «${checklist.name}» v${checklist.version}`);
md.push(`- Наборы: ${[...bySet.keys()].join(', ')} · диалогов с оценкой: ${preds.size}${skipped ? ` · без оценки (пропущено): ${skipped}` : ''}`);
md.push(`- Режим: ${RUN ? `свежая оценка (--run)${arg('mode') ? `, mode=${arg('mode')}` : ''}` : 'последние сохранённые оценки'}`, '');
md.push('## Итог', '', '| Метрика | Значение |', '|---|---|');
md.push(`| Совпадение ответов по критериям, все | **${pct(overall.all)}** (${overall.all.ok}/${overall.all.n}) |`);
md.push(`| … без спорных критериев | **${pct(overall.sure)}** (${overall.sure.ok}/${overall.sure.n}) |`);
md.push(`| Средняя ошибка итогового балла (MAE), DEV | ${mae ?? '—'} |`);
md.push(`| Итог в пределах ±5 / ±10 баллов | ${within(5)} / ${within(10)} |`);
md.push(`| Грубые ошибки: найдено / пропущено / ложных | ${gross.tp} / ${gross.fn} / ${gross.fp} |`, '');
md.push('## По критериям', '', '| Критерий | Все | Без спорных | Шкала ±1 ступень |', '|---|---|---|---|');
for (const c of checklist.criteria) { const b = byCrit.get(c.id); if (b.all.n) md.push(`| ${c.code} ${c.name} | ${pct(b.all)} (${b.all.ok}/${b.all.n}) | ${pct(b.sure)} | ${c.type === 'scale' ? pct(b.near) : ''} |`); }
md.push('', '## По языкам и наборам', '', '| Группа | Совпадение |', '|---|---|');
for (const [k, v] of byLang) md.push(`| язык ${k} | ${pct(v)} (${v.ok}/${v.n}) |`);
for (const [k, v] of bySet) md.push(`| набор ${k} | ${pct(v)} (${v.ok}/${v.n}) |`);
md.push('', `## Расхождения (${mismatches.length})`, '', '| Диалог | Критерий | Эталон | ИИ | Спорный | Объяснение ИИ |', '|---|---|---|---|---|---|');
for (const m of mismatches) {
  const c = crit.get(m.cid);
  md.push(`| ${m.id} | ${c.code} ${m.name} | ${answerLabel(c, m.gold)} | ${answerLabel(c, m.pred)} | ${m.sure ? '' : 'да'} | ${m.why.replace(/\|/g, '/').replace(/\n/g, ' ')} |`);
}
if (totals.length) {
  md.push('', '## Итоговый балл: эталон и ИИ (DEV)', '', '| Диалог | Эталон | ИИ | Разница |', '|---|---|---|---|');
  for (const t of totals) md.push(`| ${t.id} | ${t.gold ?? '—'} | ${t.pred ?? '—'} | ${t.diff == null ? '—' : Math.round(t.diff * 100) / 100} |`);
}
const report = md.join('\n') + '\n';
fs.mkdirSync('eval/reports', { recursive: true });
fs.writeFileSync('eval/LATEST.md', report);
const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
fs.writeFileSync(`eval/reports/${stamp}.json`, JSON.stringify({ date: now, model: health, checklist_version: checklist.version, run: RUN, overall, byCrit: Object.fromEntries(byCrit), byLang: Object.fromEntries(byLang), dialogs: allItems.length, mae,
  // время и стоимость одной оценки — для сравнения моделей (локальная / облачная)
  avg_sec: preds.size ? Math.round([...preds.values()].reduce((a, p) => a + (p.duration_ms || 0), 0) / preds.size / 100) / 10 : null,
  avg_cost_usd: preds.size ? Math.round([...preds.values()].reduce((a, p) => a + (p.cost_usd || 0), 0) / preds.size * 10000) / 10000 : null,
  recheck: health.recheck ?? null, gross, mismatches, totals }, null, 1));

// краткая сводка в консоль
console.log(`\nСовпадение ответов: ${pct(overall.all)} (без спорных ${pct(overall.sure)}) · MAE итога ${mae ?? '—'} · грубые ошибки ${gross.tp}/${gross.tp + gross.fn} найдено, ложных ${gross.fp}`);
for (const c of checklist.criteria) { const b = byCrit.get(c.id); if (b.all.n) console.log(`  ${c.code} ${c.name.padEnd(46)} ${pct(b.all).padStart(6)}  (без спорных ${pct(b.sure)})`); }
console.log(`Расхождений: ${mismatches.length}. Подробно: eval/LATEST.md`);
