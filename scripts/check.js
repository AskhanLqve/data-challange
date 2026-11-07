// Проверка готовности перед демонстрацией: pnpm check
// Сервер, модель, API организаторов, чек-лист, данные, results.json, записи звонков, точность.
// Меняет только кэш: записи звонков скачиваются в storage/audio, чтобы демо не зависело от сети.
const API = (process.env.CQA_API || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
const rows = []; let failed = 0;
const check = async (name, fn) => {
  try { const note = await fn(); rows.push(['✔', name, note || '']); } catch (e) { failed++; rows.push(['✘', name, String(e.message || e)]); }
};
const get = async (url) => {
  const r = await fetch(API + url, { signal: AbortSignal.timeout(15000) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
};

let health;
await check('Сервер отвечает', async () => { health = await get('/api/health'); return API; });
if (health) {
  await check('Модель готова', async () => { if (!health.ready) throw new Error(health.problem || 'не готова'); return `${health.provider} / ${health.model}`; });
  await check('Адрес API организаторов задан', async () => { if (!process.env.CQA_DATASET_API_URL) throw new Error('нет CQA_DATASET_API_URL в .env'); return 'из .env'; });
  await check('Чек-лист', async () => { const [cl] = await get('/api/checklists'); return `«${cl.name}» v${cl.version}, критериев ${cl.criteria.length}`; });
  let groups = [];
  await check('Диалоги загружены', async () => { groups = await get('/api/groups'); if (!groups.length) throw new Error('нет ни одного набора'); return groups.map((g) => `${g.group_id}: ${g.count}`).join(', '); });
  for (const g of groups.filter((x) => x.group_id !== 'SYNTH' && x.group_id !== 'SANDBOX')) {
    await check(`Набор ${g.group_id} оценён`, async () => {
      const a = await get(`/api/analytics?group_id=${encodeURIComponent(g.group_id)}`);
      if (!a.evaluated) throw new Error('нет оценок — «Диалоги» → «Оценить все показанные»');
      return `${a.evaluated} из ${a.conversations}, средний итог ${a.avg}`;
    });
    await check(`results.json для ${g.group_id} собирается`, async () => {
      const r = await get(`/api/results?group_id=${encodeURIComponent(g.group_id)}`);
      if (r.problems?.length) throw new Error(`ошибки формата: ${r.problems.slice(0, 3).join('; ')}`);
      return `${r.doc.results.length} записей, формат ${r.doc.schema_version}, без ошибок`;
    });
  }
  await check('Есть демонстрационный звонок', async () => {
    const calls = (await get('/api/conversations')).filter((c) => c.channel === 'voice call' && c.last_evaluation);
    if (!calls.length) throw new Error('нет оценённого звонка — оцените хотя бы один');
    return calls[0].conversation_id;
  });
  await check('Записи звонков сохранены локально (демо без интернета)', async () => {
    const calls = (await get('/api/conversations')).filter((c) => c.channel === 'voice call' && c.has_audio);
    let ok = 0; const bad = [];
    for (const c of calls) {
      const r = await fetch(`${API}/api/audio/${encodeURIComponent(c.conversation_id)}/file`, { signal: AbortSignal.timeout(130000) }).catch(() => null);
      if (r?.ok) { ok++; await r.arrayBuffer(); } else bad.push(c.conversation_id);
    }
    if (bad.length) throw new Error(`не скачались: ${bad.join(', ')}`);
    return `${ok} из ${calls.length}`;
  });
  await check('Замер точности', async () => { const a = await get('/api/accuracy'); if (!a.date) throw new Error('нет — pnpm eval --run'); return `${a.agreement}% на ${a.dialogs} диалогах, ${a.date.slice(0, 16)}`; });
}

for (const [s, n, note] of rows) console.log(`${s} ${n}${note ? ' — ' + note : ''}`);
console.log(failed ? `\nНе готово: ${failed} проверок не прошло.` : '\nВсё готово к демонстрации.');
process.exit(failed ? 1 : 0);
