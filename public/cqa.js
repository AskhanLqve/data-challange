// CQA — Conversation Quality Analytics. Веб-компонент <cqa-app api-base="..."> на чистом JS.
// Встраивание в Dynamics 365: подключите cqa.css + cqa.js в HTML web resource и задайте api-base.

(() => {
  // ---------- мини-DOM ----------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = v;
      else if (k === 'html') el.innerHTML = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const appendAll = (el, ...kids) => el.append(...kids.flat(Infinity).filter((k) => k != null && k !== false));
  const fmt = (x, d = 2) => (x == null ? '—' : Number(x).toFixed(d).replace(/\.?0+$/, '') || '0');
  const fmtDate = (s) => (s ? new Date(s).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : '');
  const clock = (sec) => { if (sec == null) return ''; const s = Math.round(sec); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const LANG = { RU: 'RU', KZ: 'KZ', EN: 'EN' };
  const ROLE = { client: 'Клиент', operator: 'Оператор', bot: 'Бот', system: 'Система' };
  const TYPE = { binary: 'Да / Нет', scale: 'Шкала', flag: 'Флаг (без баллов)' };

  function answerLabel(c, a) {
    if (a == null) return '—';
    if (a === 'na') return 'N/A';
    if (c.type === 'scale') return `${a} / ${Math.max(...c.scale.map((s) => s.value))}`;
    if (c.type === 'flag') return a === 'yes' ? 'Да — выявлено' : 'Нет';
    return a === 'yes' ? 'Да' : 'Нет';
  }
  function answerClass(c, a) {
    if (a === 'na') return 'na';
    if (c.type === 'flag') return a === 'yes' ? 'no' : 'yes';
    if (c.type === 'scale') { const max = Math.max(...c.scale.map((s) => s.value)); const v = Number(a); return v >= max ? 'yes' : v <= 0 ? 'no' : 'warn'; }
    return a === 'yes' ? 'yes' : 'no';
  }
  function allowedAnswers(c) {
    if (c.type === 'scale') return [...c.scale.map((s) => String(s.value)), ...(c.na_allowed ? ['na'] : [])];
    return c.na_allowed && c.type !== 'flag' ? ['yes', 'no', 'na'] : ['yes', 'no'];
  }

  class CqaApp extends HTMLElement {
    connectedCallback() {
      this.api = (this.getAttribute('api-base') || window.CQA_API_BASE || '').replace(/\/$/, '');
      this.state = { checklists: [], health: null, jobs: {}, selected: new Set(), filters: { q: '', lang: '', channel: '', group: '' } };
      window.addEventListener('hashchange', () => this.render());
      this.init();
    }

    async req(method, url, body) {
      const res = await fetch(this.api + url, { method, headers: body !== undefined ? { 'content-type': typeof body === 'string' ? 'text/plain' : 'application/json' } : {}, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
      const ct = res.headers.get('content-type') || '';
      const data = ct.includes('json') ? await res.json() : await res.text();
      if (!res.ok) throw new Error(data?.error || data || `HTTP ${res.status}`);
      return data;
    }
    toast(msg, err) {
      this.querySelector('.toast')?.remove();
      const t = h('div', { class: 'toast' + (err ? ' err' : '') }, msg);
      this.append(t);
      setTimeout(() => t.remove(), err ? 8000 : 3500);
    }
    async guard(fn) { try { return await fn(); } catch (e) { this.toast(e.message, true); console.error(e); } }

    async init() {
      this.innerHTML = '';
      this.top = h('div', { class: 'topbar' });
      this.main = h('main');
      this.append(this.top, this.main);
      await this.guard(async () => {
        [this.state.health, this.state.checklists] = await Promise.all([this.req('GET', '/api/health'), this.req('GET', '/api/checklists')]);
        this.state.checklistId = localStorage.getItem('cqa.checklist') || this.state.checklists[0]?.id;
        if (!this.state.checklists.some((c) => c.id === this.state.checklistId)) this.state.checklistId = this.state.checklists[0]?.id;
      });
      this.render();
    }
    get checklist() { return this.state.checklists.find((c) => c.id === this.state.checklistId); }
    async refreshChecklists() { this.state.checklists = await this.req('GET', '/api/checklists'); }

    route() {
      const raw = location.hash.replace(/^#\/?/, '');
      const [pathPart, query] = raw.split('?');
      const parts = pathPart.split('/').filter(Boolean).map(decodeURIComponent);
      return { parts, query: new URLSearchParams(query || '') };
    }
    go(hash) { location.hash = hash; }

    async renderTop() {
      const { parts } = this.route();
      const sect = parts[0] || '';
      let open = 0;
      try { open = (await this.req('GET', '/api/appeals?status=open')).length; } catch { /* ignore */ }
      const hlth = this.state.health;
      this.top.replaceChildren(
        h('a', { class: 'brand', href: this.getAttribute('home-url') || 'index.html', title: 'На главную' }, h('span', { class: 'mark' }, 'QA'), 'CQA', h('small', {}, 'Контроль качества диалогов')),
        h('nav', {},
          h('a', { href: '#/', class: ['', 'c'].includes(sect) ? 'active' : '' }, 'Диалоги'),
          h('a', { href: '#/appeals', class: sect === 'appeals' ? 'active' : '' }, 'Апелляции', open ? h('span', { class: 'count' }, open) : null),
          h('a', { href: '#/checklists', class: sect === 'checklists' ? 'active' : '' }, 'Чек-листы')),
        h('div', { class: 'spacer' }),
        h('label', { class: 'row small muted' }, 'Чек-лист:',
          h('select', { onchange: (e) => { this.state.checklistId = e.target.value; localStorage.setItem('cqa.checklist', e.target.value); this.render(); } },
            this.state.checklists.map((c) => h('option', { value: c.id, selected: c.id === this.state.checklistId ? 'selected' : null }, `${c.name} · v${c.version}`)))),
        hlth ? h('span', { class: 'model-badge' + (hlth.configured ? '' : ' off'), title: hlth.configured ? 'Модель оценки' : 'Ключ API не задан — оценка недоступна' }, `${hlth.provider}: ${hlth.model}${hlth.effort ? ' · ' + hlth.effort : ''}${hlth.configured ? '' : ' · нет ключа'}`) : null,
      );
    }

    async render() {
      this.renderTop();
      const { parts, query } = this.route();
      const view = h('div');
      this.main.replaceChildren(view);
      await this.guard(async () => {
        if (parts[0] === 'c' && parts[1]) return this.viewCard(view, parts[1], query.get('ev'), query.get('m'));
        if (parts[0] === 'appeals') return this.viewAppeals(view, parts[1]);
        if (parts[0] === 'checklists') return this.viewChecklists(view, parts[1]);
        return this.viewList(view);
      });
    }

    // =====================================================================
    // Список диалогов
    // =====================================================================
    async viewList(view) {
      const [convs, groups] = await Promise.all([this.req('GET', '/api/conversations'), this.req('GET', '/api/groups')]);
      const f = this.state.filters;
      const cl = this.checklist;

      const groupInput = h('input', { type: 'text', placeholder: 'group_id, напр. DEV', value: localStorage.getItem('cqa.group') || 'DEV', style: { width: '160px' } });
      const fileInput = h('input', { type: 'file', accept: '.json,.txt', multiple: true, style: { display: 'none' }, onchange: async (e) => {
        for (const file of e.target.files) {
          await this.guard(async () => {
            const text = await file.text();
            const r = await this.req('POST', '/api/conversations/upload', text);
            this.toast(`${file.name}: импортировано ${r.imported.length}`);
          });
        }
        this.render();
      } });
      const pasteArea = h('textarea', { placeholder: 'Вставьте JSON записи/ответа API или текст: "[00:05] operator: Здравствуйте!" — по реплике на строку', rows: 5 });
      const pasteBox = h('div', { class: 'panel stack', hidden: true },
        h('h3', {}, 'Вставить транскрипт'),
        pasteArea,
        h('div', { class: 'row' },
          h('button', { class: 'btn primary', onclick: () => this.guard(async () => {
            const r = await this.req('POST', '/api/conversations/upload', pasteArea.value);
            this.toast(`Импортировано: ${r.imported.join(', ')}`);
            if (r.imported.length === 1) this.go(`#/c/${encodeURIComponent(r.imported[0])}`); else this.render();
          }) }, 'Импортировать'),
          h('button', { class: 'btn', onclick: () => { pasteBox.hidden = true; } }, 'Отмена')));

      const filtered = convs.filter((c) =>
        (!f.lang || c.language === f.lang) && (!f.channel || c.channel === f.channel) && (!f.group || c.group_id === f.group) &&
        (!f.q || (c.conversation_id + ' ' + c.preview).toLowerCase().includes(f.q.toLowerCase())));

      const sel = this.state.selected;
      const jobBox = h('div');
      const runBatch = (ids, onlyNew) => this.guard(async () => {
        const job = await this.req('POST', '/api/evaluate/batch', { conversation_ids: ids, checklist_id: cl.id, only_new: onlyNew });
        this.toast(`Запущена оценка ${job.total} диалогов`);
        this.pollJob(job.id, jobBox);
      });

      const tbody = h('tbody');
      const allBox = h('input', { type: 'checkbox', onclick: (e) => { filtered.forEach((c) => (e.target.checked ? sel.add(c.conversation_id) : sel.delete(c.conversation_id))); this.render(); } });
      allBox.checked = filtered.length > 0 && filtered.every((c) => sel.has(c.conversation_id));
      for (const c of filtered) {
        const ev = c.last_evaluation;
        const box = h('input', { type: 'checkbox', checked: sel.has(c.conversation_id), onclick: (e) => { e.stopPropagation(); e.target.checked ? sel.add(c.conversation_id) : sel.delete(c.conversation_id); } });
        tbody.append(h('tr', { onclick: () => this.go(`#/c/${encodeURIComponent(c.conversation_id)}`) },
          h('td', { onclick: (e) => e.stopPropagation() }, box),
          h('td', {}, h('b', {}, c.conversation_id), h('div', { class: 'small muted' }, c.group_id)),
          h('td', {}, h('span', { class: 'tag blue' }, LANG[c.language] || c.language)),
          h('td', {}, c.channel === 'voice call' ? '📞 звонок' : '💬 чат', h('div', { class: 'small muted' }, `${c.messages} реплик`)),
          h('td', { class: 'small', style: { maxWidth: '420px' } }, c.preview),
          h('td', {}, ev ? h('div', {},
            h('span', { class: 'score' }, fmt(ev.total)),
            ev.original_total !== ev.total ? h('span', { class: 'small muted' }, ` (ИИ: ${fmt(ev.original_total)})`) : null,
            ev.gross ? h('div', {}, h('span', { class: 'tag no' }, 'грубая ошибка')) : null,
            h('div', { class: 'small muted' }, `${ev.checklist_name} v${ev.checklist_version}`)) : h('span', { class: 'muted small' }, 'не оценён')),
          h('td', {}, ev ? h('span', { class: 'tag ' + (ev.status === 'appealed' ? 'warn' : ev.status === 'reviewed' ? 'yes' : '') }, { evaluated: 'оценён', appealed: 'апелляция', reviewed: 'пересмотрен' }[ev.status] || ev.status) : null)));
      }

      const select = (key, opts, label) => h('select', { onchange: (e) => { f[key] = e.target.value; this.render(); } },
        h('option', { value: '' }, label), opts.map(([v, t]) => h('option', { value: v, selected: f[key] === v ? 'selected' : null }, t)));
      const search = h('input', { type: 'search', placeholder: 'Поиск по ID и тексту', value: f.q, oninput: (e) => { f.q = e.target.value; clearTimeout(this._t); this._t = setTimeout(() => { this.render().then(() => { const s = this.querySelector('input[type=search]'); s?.focus(); s?.setSelectionRange(s.value.length, s.value.length); }); }, 300); } });

      const evaluated = filtered.filter((c) => c.last_evaluation);
      const avg = evaluated.length ? evaluated.reduce((s, c) => s + (c.last_evaluation.total || 0), 0) / evaluated.length : null;

      view.append(
        h('div', { class: 'stack' },
          h('div', { class: 'panel' },
            h('div', { class: 'row' },
              h('h2', { style: { margin: 0 } }, 'Данные'),
              groupInput,
              h('button', { class: 'btn primary', onclick: (e) => this.guard(async () => {
                e.target.disabled = true; e.target.textContent = 'Загрузка…';
                localStorage.setItem('cqa.group', groupInput.value.trim());
                const r = await this.req('POST', '/api/datasets/fetch', { group_id: groupInput.value.trim() });
                this.toast(`Набор ${r.group_id}: загружено ${r.total} диалогов`);
                f.group = r.group_id;
                this.render();
              }).finally(() => { e.target.disabled = false; }) }, 'Загрузить из API'),
              h('button', { class: 'btn', onclick: () => fileInput.click() }, 'Загрузить файл…'), fileInput,
              h('button', { class: 'btn', onclick: () => { pasteBox.hidden = !pasteBox.hidden; } }, 'Вставить текст'),
              h('div', { class: 'spacer' }),
              h('a', { class: 'btn', href: `${this.api}/api/export?checklist_id=${cl?.id || ''}${f.group ? '&group_id=' + f.group : ''}` }, 'Экспорт CSV'),
              h('a', { class: 'btn', href: `${this.api}/api/export?format=json&checklist_id=${cl?.id || ''}${f.group ? '&group_id=' + f.group : ''}`, target: '_blank' }, 'JSON'))),
          pasteBox,
          h('div', { class: 'panel' },
            h('div', { class: 'row', style: { marginBottom: '10px' } },
              search,
              select('group', groups.map((g) => [g.group_id, `${g.group_id} (${g.count})`]), 'Все наборы'),
              select('lang', [['RU', 'RU'], ['KZ', 'KZ'], ['EN', 'EN']], 'Все языки'),
              select('channel', [['agent chat', 'Чаты'], ['voice call', 'Звонки']], 'Все каналы'),
              h('span', { class: 'muted small' }, `${filtered.length} из ${convs.length}`, avg != null ? ` · средний балл ${fmt(avg)}` : ''),
              h('div', { class: 'spacer' }),
              h('button', { class: 'btn', onclick: () => sel.size ? runBatch([...sel], false) : this.toast('Отметьте диалоги галочками', true) }, `Оценить выбранные (${sel.size})`),
              h('button', { class: 'btn primary', onclick: () => runBatch(filtered.map((c) => c.conversation_id), true), title: 'Пропустит диалоги, уже оценённые текущей версией чек-листа' }, `Оценить все показанные — «${cl?.name || ''} v${cl?.version || ''}»`)),
            jobBox,
            filtered.length ? h('div', { class: 'table-wrap' }, h('table', {},
              h('thead', {}, h('tr', {}, h('th', {}, allBox), h('th', {}, 'Диалог'), h('th', {}, 'Язык'), h('th', {}, 'Канал'), h('th', {}, 'Запрос клиента'), h('th', {}, 'Итог'), h('th', {}, 'Статус'))),
              tbody)) : h('div', { class: 'empty' }, convs.length ? 'Ничего не найдено' : 'Диалогов пока нет. Загрузите набор из API (group_id = DEV) или файл.'))));

      // Показываем идущую оценку и после перезагрузки страницы — состояние берём с сервера.
      const serverJobs = await this.req('GET', '/api/jobs').catch(() => []);
      const running = serverJobs.find((j) => j.status === 'running');
      if (running) this.pollJob(running.id, jobBox);
    }

    async pollJob(id, box) {
      if (this._polling === id) { this.drawJob(this.state.jobs[id], box); return; }
      this._polling = id;
      while (this._polling === id) {
        const job = await this.req('GET', `/api/jobs/${id}`).catch(() => null);
        if (!job) break;
        this.state.jobs[id] = job;
        if (!box.isConnected) { const nb = this.querySelector('[data-jobbox]'); if (nb) box = nb; }
        this.drawJob(job, box);
        if (job.status !== 'running') { this._polling = null; this.toast(`Оценка завершена: ${job.done} успешно, ${job.failed} с ошибкой · $${fmt(job.cost_usd, 4)}`); if (box.isConnected && this.route().parts.length === 0) this.render(); break; }
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    drawJob(job, box) {
      if (!job || !box) return;
      box.setAttribute('data-jobbox', '1');
      const pct = job.total ? Math.round(((job.done + job.failed) / job.total) * 100) : 0;
      box.replaceChildren(h('div', { class: 'panel', style: { margin: '8px 0', background: 'var(--accent-soft)' } },
        h('div', { class: 'row' },
          h('b', {}, job.status === 'running' ? 'Идёт оценка…' : 'Оценка завершена'),
          h('div', { class: 'progress', style: { flex: 1 } }, h('div', { style: { width: pct + '%' } })),
          h('span', { class: 'small' }, `${job.done + job.failed}/${job.total} · ошибок ${job.failed} · $${fmt(job.cost_usd, 4)}`)),
        job.errors.length ? h('details', {}, h('summary', {}, 'Ошибки'), h('pre', {}, job.errors.map((e) => `${e.conversation_id}: ${e.error}`).join('\n'))) : null));
    }

    // =====================================================================
    // Карточка диалога: транскрипт + результат
    // =====================================================================
    async viewCard(view, convId, evId, focusMsg) {
      const conv = await this.req('GET', `/api/conversations/${encodeURIComponent(convId)}`);
      const evMeta = conv.evaluations.find((e) => e.id === evId) || conv.evaluations[0];
      const ev = evMeta ? await this.req('GET', `/api/evaluations/${evMeta.id}`) : null;

      // --- транскрипт ---
      let audio = null;
      const tr = h('div', { class: 'panel transcript' });
      if (conv.audio_url) {
        audio = h('audio', { controls: true, preload: 'none', src: `${this.api}/api/audio/${encodeURIComponent(conv.conversation_id)}` });
        tr.append(h('div', { class: 'audio-bar' }, h('div', { class: 'row small muted', style: { marginBottom: '4px' } }, '🎧 Запись звонка',
          h('a', { href: conv.audio_url, target: '_blank', rel: 'noopener' }, 'открыть плеер организаторов ↗'),
          h('label', { class: 'row' }, 'скорость', h('select', { onchange: (e) => { audio.playbackRate = Number(e.target.value); } }, ['0.75', '1', '1.25', '1.5', '2'].map((v) => h('option', { value: v, selected: v === '1' ? 'selected' : null }, v + 'x'))))), audio));
      }
      const msgEls = new Map();
      for (const m of conv.transcript) {
        const el = h('div', { class: `msg ${m.speaker}`, id: `m-${m.idx}` },
          h('div', { class: 'num' }, '#' + m.idx),
          h('div', {},
            h('div', { class: 'meta' }, h('span', { class: 'role' }, ROLE[m.speaker] || m.speaker), h('span', {}, m.timestamp),
              audio && m.offset_sec != null ? h('button', { class: 'play', title: 'Прослушать с этого места', onclick: () => this.seek(audio, m.offset_sec) }, `▶ ${clock(m.offset_sec)}`) : null),
            h('div', { class: 'text' }, m.text)));
        msgEls.set(m.idx, el);
        tr.append(el);
      }
      const focus = (idx, range) => {
        tr.querySelectorAll('.flash, .inrange').forEach((e) => e.classList.remove('flash', 'inrange'));
        if (range) for (let i = range.from; i <= range.to; i++) msgEls.get(i)?.classList.add('inrange');
        const el = msgEls.get(idx);
        if (!el) return;
        el.classList.add('flash');
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        history.replaceState(null, '', `#/c/${encodeURIComponent(conv.conversation_id)}?ev=${ev?.id || ''}&m=${idx}`);
      };
      const jump = (idx, range) => {
        focus(idx, range);
        const m = conv.transcript[idx - 1];
        if (audio && m?.offset_sec != null) this.seek(audio, m.offset_sec, false);
      };

      // --- результат ---
      const right = h('div', { class: 'stack' });
      const cl = this.checklist;
      const evalBtn = h('button', { class: 'btn primary', onclick: async () => {
        evalBtn.disabled = true; evalBtn.textContent = 'Оценка… (до минуты)';
        await this.guard(async () => {
          const r = await this.req('POST', '/api/evaluate', { conversation_id: conv.conversation_id, checklist_id: cl.id });
          this.toast(`Готово: ${fmt(r.final_score.total)} баллов · $${fmt(r.cost_usd, 4)} · ${Math.round(r.duration_ms / 1000)} с`);
          this.go(`#/c/${encodeURIComponent(conv.conversation_id)}?ev=${r.id}`);
        });
        evalBtn.disabled = false; evalBtn.textContent = 'Оценить';
      } }, ev ? `Переоценить — «${cl.name} v${cl.version}»` : `Оценить — «${cl.name} v${cl.version}»`);

      right.append(h('div', { class: 'panel' },
        h('div', { class: 'row' },
          h('a', { href: '#/', class: 'btn sm' }, '← К списку'),
          h('h1', { style: { margin: 0 } }, conv.conversation_id),
          h('span', { class: 'tag blue' }, conv.language), h('span', { class: 'tag' }, conv.channel === 'voice call' ? '📞 звонок' : '💬 чат'),
          h('span', { class: 'muted small' }, conv.group_id),
          h('div', { class: 'spacer' }), evalBtn),
        conv.evaluations.length > 1 ? h('div', { class: 'row small', style: { marginTop: '8px' } }, 'История оценок:',
          h('select', { onchange: (e) => this.go(`#/c/${encodeURIComponent(conv.conversation_id)}?ev=${e.target.value}`) },
            conv.evaluations.map((e) => h('option', { value: e.id, selected: e.id === ev?.id ? 'selected' : null }, `${fmtDate(e.created_at)} · ${e.checklist_name} v${e.checklist_version} · ${fmt(e.total)}`)))) : null));

      if (!ev) right.append(h('div', { class: 'panel empty' }, 'Диалог ещё не оценён. Нажмите «Оценить».'));
      else this.renderEvaluation(right, ev, conv, jump);

      view.append(h('div', { class: 'card-grid' }, tr, right));
      if (focusMsg) setTimeout(() => focus(Number(focusMsg)), 50);
    }

    seek(audio, sec, play = true) {
      const doSeek = () => { audio.currentTime = sec; if (play) audio.play().catch(() => {}); };
      if (audio.readyState >= 1) doSeek();
      else { audio.preload = 'auto'; audio.addEventListener('loadedmetadata', doSeek, { once: true }); audio.load(); }
    }

    renderEvaluation(root, ev, conv, jump) {
      const cl = ev.checklist;
      const fs = ev.final_score, os = ev.original_score;
      const changed = fs.total !== os.total;
      root.append(h('div', { class: 'panel' },
        h('div', { class: 'totals' },
          h('div', {},
            h('div', { class: 'score big' }, fs.total == null ? '—' : fmt(fs.total)),
            h('div', { class: 'small muted' }, `из ${fs.max}`),
            changed ? h('div', { class: 'small' }, 'исходная ИИ: ', h('s', {}, fmt(os.total))) : null),
          h('div', { class: 'stack' },
            h('div', { class: 'row' },
              fs.gross_error ? h('span', { class: 'tag no' }, '⚠ Грубая ошибка: ' + fs.gross_errors.map((g) => g.name).join(', ')) : h('span', { class: 'tag yes' }, 'Грубых ошибок нет'),
              ev.status === 'appealed' ? h('span', { class: 'tag warn' }, 'на апелляции') : ev.status === 'reviewed' ? h('span', { class: 'tag yes' }, 'пересмотрено') : null,
              fs.total == null ? h('span', { class: 'tag warn' }, 'итог не рассчитывается — нет применимых критериев') : null,
              fs.redistribution_factor && fs.redistribution_factor !== 1 ? h('span', { class: 'small muted', title: 'Веса критериев с N/A перераспределены между применимыми' }, `веса ×${fmt(fs.redistribution_factor, 3)} (N/A)`) : null),
            h('div', { class: 'sections stack' }, fs.sections.map((s) => h('div', { class: 'sec' },
              h('span', {}, s.name),
              h('div', { class: 'bar' }, h('div', { style: { width: (s.percent ?? 0) + '%' } })),
              h('span', { class: 'small', style: { textAlign: 'right' } }, s.points == null ? 'N/A' : `${fmt(s.points)} / ${fmt(s.max)}`)))))),
        ev.summary ? h('p', { class: 'muted', style: { marginBottom: 0 } }, ev.summary) : null,
        h('div', { class: 'small muted', style: { marginTop: '6px' } }, `${cl.name} v${ev.checklist_version} · ${ev.provider}/${ev.model}${ev.effort ? ' · effort ' + ev.effort : ''}${ev.runs > 1 ? ` · ${ev.runs} прогона` : ''} · ${Math.round(ev.duration_ms / 1000)} с · $${fmt(ev.cost_usd, 4)} · ${fmtDate(ev.created_at)}`)));

      const appealsByCrit = new Map();
      for (const a of ev.appeals || []) appealsByCrit.set(a.criterion_id, [...(appealsByCrit.get(a.criterion_id) || []), a]);

      let currentSection = null;
      for (const c of cl.criteria) {
        if (c.section !== currentSection) {
          currentSection = c.section;
          const sec = cl.sections.find((s) => s.id === c.section);
          if (sec) root.append(h('h3', { class: 'muted', style: { marginTop: '18px' } }, sec.name.toUpperCase()));
        }
        const r = ev.criteria.find((x) => x.criterion_id === c.id);
        if (!r) continue;
        const ai = r.ai;
        const fa = r.final_answer;
        const pts = r.final;
        const appeals = appealsByCrit.get(c.id) || [];
        const openAppeal = appeals.find((a) => a.status === 'open');
        const box = h('div', { class: 'crit' + (c.type === 'flag' && fa === 'yes' ? ' flagged' : '') });
        appendAll(box,
          h('div', { class: 'crit-head' },
            h('span', { class: 'muted' }, c.code || ''),
            h('span', { class: 'name' }, c.name),
            h('span', { class: 'tag ' + answerClass(c, fa) }, answerLabel(c, fa)),
            h('span', { class: 'pts', title: 'Баллы / максимум после перераспределения (базовый вес)' },
              c.type === 'flag' ? 'без баллов' : fa === 'na' ? `вес ${c.weight} → перераспределён` : `${fmt(pts.points)} / ${fmt(pts.max_points)} (вес ${c.weight})`)),
          h('div', { class: 'expl' }, ai.explanation),
          fa === 'na' && c.na_condition ? h('div', { class: 'small muted' }, 'Условие N/A: ', c.na_condition) : null,
          ai.evidence?.length ? h('div', {}, ai.evidence.map((e) => h('button', { class: 'ev', title: 'Перейти к реплике', onclick: () => jump(e.message, ai.checked_range) },
            h('b', {}, `#${e.message}`), h('span', {}, `${ROLE[e.speaker] || ''}: «${e.quote}»`)))) : null,
          ai.checked_range ? h('div', { class: 'small', style: { marginTop: '4px' } },
            h('a', { href: 'javascript:void 0', onclick: () => jump(ai.checked_range.from, ai.checked_range) }, `Проверенный участок: реплики #${ai.checked_range.from}–#${ai.checked_range.to}`)) : null,
          ai.warning ? h('div', { class: 'small', style: { color: 'var(--warn)' } }, '⚠ ', ai.warning) : null,
          ai.agreement != null && ev.runs > 1 ? h('div', { class: 'small muted' }, `согласие прогонов: ${Math.round(ai.agreement * 100)}% (${(ai.votes || []).join(', ')})`) : null,
          r.review ? h('div', { class: 'review' },
            h('b', {}, r.review.action === 'change' ? 'Оценка изменена проверяющим' : 'Оценка подтверждена проверяющим'), ': ',
            `${answerLabel(c, r.review.previous_answer)} → ${answerLabel(c, r.review.new_answer)}. `,
            h('i', {}, r.review.reason), h('span', { class: 'muted' }, ` — ${r.review.reviewer}, ${fmtDate(r.review.decided_at)}`),
            ai.answer !== fa ? h('div', { class: 'small muted' }, `Исходная оценка ИИ: ${answerLabel(c, ai.answer)}`) : null) : null,
          appeals.map((a) => h('div', { class: 'review', style: { background: 'var(--accent-soft)' } },
            h('b', {}, a.status === 'open' ? '⏳ Апелляция ожидает решения' : '✓ Апелляция рассмотрена'), ` · ${a.author}, ${fmtDate(a.created_at)}: `, h('i', {}, a.comment),
            a.status === 'open' ? h('div', {}, h('a', { href: `#/appeals/${a.id}` }, 'Открыть у проверяющего →')) : null)),
        );
        if (!openAppeal) {
          const formHolder = h('div');
          box.append(h('div', { class: 'row', style: { marginTop: '6px' } },
            h('button', { class: 'btn sm', onclick: () => { formHolder.replaceChildren(this.appealForm(ev, c, () => this.render())); } }, 'Оспорить')), formHolder);
        }
        root.append(box);
      }

      root.append(h('details', { class: 'panel' }, h('summary', {}, 'Трассировка оценки (промпт и ответ модели)'),
        h('p', { class: 'small muted' }, 'Система строит промпт из текущей конфигурации чек-листа и нового транскрипта; ответ модели проверяется по схеме, баллы считает код.'),
        h('h3', {}, 'Системный промпт'), h('pre', {}, ev.trace?.system_prompt || ''),
        h('h3', {}, 'Транскрипт для модели'), h('pre', {}, ev.trace?.user_prompt || ''),
        h('h3', {}, 'Ответ модели'), h('pre', {}, (ev.trace?.raw_outputs || []).map((t) => { try { return JSON.stringify(JSON.parse(t), null, 2); } catch { return t; } }).join('\n\n---\n\n')),
        h('h3', {}, 'Использование токенов'), h('pre', {}, JSON.stringify(ev.usage, null, 2))));
    }

    appealForm(ev, c, done) {
      const comment = h('textarea', { placeholder: 'Почему оценка неверна? Сошлитесь на реплики (#N).', rows: 3 });
      const want = h('select', {}, h('option', { value: '' }, 'Предлагаемая оценка (необязательно)'),
        allowedAnswers(c).map((a) => h('option', { value: a }, answerLabel(c, a))));
      const author = h('input', { type: 'text', value: localStorage.getItem('cqa.author') || 'Оператор', style: { width: '160px' } });
      return h('div', { class: 'appeal-form stack' },
        h('b', {}, `Апелляция по критерию «${c.name}»`),
        comment,
        h('div', { class: 'row' }, want, h('label', { class: 'row small muted' }, 'Автор', author),
          h('button', { class: 'btn primary', onclick: () => this.guard(async () => {
            localStorage.setItem('cqa.author', author.value);
            await this.req('POST', '/api/appeals', { evaluation_id: ev.id, criterion_id: c.id, comment: comment.value, requested_answer: want.value || null, author: author.value });
            this.toast('Апелляция сохранена и передана проверяющему');
            done();
          }) }, 'Подать апелляцию')));
    }

    // =====================================================================
    // Апелляции (рабочее место проверяющего)
    // =====================================================================
    async viewAppeals(view, appealId) {
      const list = await this.req('GET', '/api/appeals');
      if (!appealId) {
        const open = list.filter((a) => a.status === 'open');
        const done = list.filter((a) => a.status !== 'open');
        const table = (items) => items.length ? h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, ['Диалог', 'Критерий', 'Оспорено', 'Комментарий', 'Решение', 'Итог', 'Дата'].map((t) => h('th', {}, t)))),
          h('tbody', {}, items.map((a) => h('tr', { onclick: () => this.go(`#/appeals/${a.id}`) },
            h('td', {}, h('b', {}, a.conversation_id)), h('td', {}, a.criterion_name), h('td', {}, h('span', { class: 'tag' }, a.disputed_label)),
            h('td', { class: 'small', style: { maxWidth: '360px' } }, a.comment, h('div', { class: 'muted' }, a.author)),
            h('td', {}, a.decision ? h('span', { class: 'tag ' + (a.decision.action === 'change' ? 'warn' : 'yes') }, a.decision.action === 'change' ? `изменено → ${a.decision.new_label}` : 'подтверждено') : h('span', { class: 'tag blue' }, 'ожидает')),
            h('td', {}, a.decision ? `${fmt(a.decision.total_before)} → ${fmt(a.decision.total_after)}` : fmt(a.total_now)),
            h('td', { class: 'small muted' }, fmtDate(a.created_at))))))) : h('div', { class: 'empty' }, 'Нет');
        view.append(h('div', { class: 'stack' },
          h('div', { class: 'panel' }, h('h1', {}, `Ожидают решения (${open.length})`), table(open)),
          h('div', { class: 'panel' }, h('h2', {}, `Рассмотренные (${done.length})`), table(done))));
        return;
      }
      const ap = list.find((a) => a.id === appealId);
      if (!ap) throw new Error('Апелляция не найдена');
      const [ev, conv] = await Promise.all([this.req('GET', `/api/evaluations/${ap.evaluation_id}`), this.req('GET', `/api/conversations/${encodeURIComponent(ap.conversation_id)}`)]);
      const c = ev.checklist.criteria.find((x) => x.id === ap.criterion_id);
      const r = ev.criteria.find((x) => x.criterion_id === ap.criterion_id);
      const ai = r.ai;

      // фрагмент диалога: реплики-доказательства ±2 и проверенный участок
      const keep = new Set();
      for (const e of ai.evidence || []) for (let i = e.message - 2; i <= e.message + 2; i++) keep.add(i);
      if (ai.checked_range) for (let i = ai.checked_range.from; i <= ai.checked_range.to; i++) keep.add(i);
      for (const m of String(ap.comment).matchAll(/#(\d+)/g)) keep.add(Number(m[1]));
      const evIdx = new Set((ai.evidence || []).map((e) => e.message));
      const frag = h('div', { class: 'fragment' });
      let last = 0;
      for (const m of conv.transcript) {
        if (!keep.has(m.idx)) continue;
        if (m.idx > last + 1) frag.append(h('div', { class: 'small muted', style: { textAlign: 'center' } }, '…'));
        frag.append(h('div', { class: `msg ${m.speaker}${evIdx.has(m.idx) ? ' flash' : ''}` }, h('div', { class: 'num' }, '#' + m.idx),
          h('div', {}, h('div', { class: 'meta' }, h('span', { class: 'role' }, ROLE[m.speaker]), h('span', {}, m.timestamp)), h('div', { class: 'text' }, m.text))));
        last = m.idx;
      }
      if (!frag.children.length) frag.append(h('div', { class: 'muted' }, 'Модель не указала реплик — откройте полный транскрипт.'));

      const decision = h('div', { class: 'panel stack' });
      if (ap.status === 'open') {
        const action = h('select', {}, h('option', { value: 'confirm' }, 'Подтвердить исходную оценку'), h('option', { value: 'change' }, 'Изменить оценку'));
        const newAns = h('select', {}, allowedAnswers(c).map((a) => h('option', { value: a, selected: a === (ap.requested_answer ?? '') ? 'selected' : null }, answerLabel(c, a))));
        const newWrap = h('label', { class: 'field', hidden: true }, 'Новая оценка', newAns);
        action.onchange = () => { newWrap.hidden = action.value !== 'change'; };
        if (ap.requested_answer) { action.value = 'change'; newWrap.hidden = false; }
        const reason = h('textarea', { placeholder: 'Причина решения (обязательно)', rows: 3 });
        const reviewer = h('input', { type: 'text', value: localStorage.getItem('cqa.reviewer') || 'Проверяющий QA' });
        decision.append(h('h2', {}, 'Решение проверяющего'),
          h('label', { class: 'field' }, 'Действие', action), newWrap,
          h('label', { class: 'field' }, 'Причина', reason),
          h('label', { class: 'field' }, 'Проверяющий', reviewer),
          h('button', { class: 'btn ok', onclick: () => this.guard(async () => {
            localStorage.setItem('cqa.reviewer', reviewer.value);
            const out = await this.req('POST', `/api/appeals/${ap.id}/decision`, { action: action.value, new_answer: newAns.value, reason: reason.value, reviewer: reviewer.value });
            this.toast(`Решение сохранено. Итог: ${fmt(out.appeal.decision.total_before)} → ${fmt(out.appeal.decision.total_after)}`);
            this.render();
          }) }, 'Сохранить решение'));
      } else {
        const d = ap.decision;
        decision.append(h('h2', {}, 'Решение'),
          h('dl', { class: 'kv' },
            h('dt', {}, 'Действие'), h('dd', {}, d.action === 'change' ? 'Оценка изменена' : 'Оценка подтверждена'),
            h('dt', {}, 'Оценка'), h('dd', {}, `${ap.disputed_label} → ${d.new_label}`),
            h('dt', {}, 'Причина'), h('dd', {}, d.reason),
            h('dt', {}, 'Проверяющий'), h('dd', {}, `${d.reviewer}, ${fmtDate(d.decided_at)}`),
            h('dt', {}, 'Итог диалога'), h('dd', {}, h('b', {}, `${fmt(d.total_before)} → ${fmt(d.total_after)}`))));
      }

      view.append(h('div', { class: 'stack' },
        h('div', { class: 'row' }, h('a', { class: 'btn sm', href: '#/appeals' }, '← Все апелляции'),
          h('h1', { style: { margin: 0 } }, `Апелляция: ${ap.conversation_id} · ${c.code || ''} ${c.name}`),
          h('div', { class: 'spacer' }), h('a', { class: 'btn', href: `#/c/${encodeURIComponent(ap.conversation_id)}?ev=${ev.id}` }, 'Открыть карточку диалога')),
        h('div', { class: 'appeal' },
          h('div', { class: 'stack' },
            h('div', { class: 'panel stack' },
              h('h2', {}, 'Спорная оценка'),
              h('div', { class: 'row' }, h('span', { class: 'tag ' + answerClass(c, ap.disputed_answer) }, ap.disputed_label),
                h('span', { class: 'muted small' }, c.type === 'flag' ? '' : `вес ${c.weight}`), ai.answer !== ap.disputed_answer ? h('span', { class: 'small muted' }, `(ИИ: ${answerLabel(c, ai.answer)})`) : null),
              h('div', { class: 'small muted' }, c.description),
              h('div', {}, h('b', {}, 'Обоснование ИИ: '), ai.explanation),
              h('div', { class: 'review', style: { background: 'var(--accent-soft)' } }, h('b', {}, `Комментарий (${ap.author}): `), ap.comment,
                ap.requested_answer ? h('div', { class: 'small' }, `Предлагаемая оценка: ${answerLabel(c, ap.requested_answer)}`) : null),
              h('div', { class: 'small muted' }, `Текущий итог диалога: ${fmt(ev.final_score.total)} (ИИ: ${fmt(ev.original_score.total)})`)),
            decision),
          h('div', { class: 'panel' }, h('h2', {}, 'Фрагмент диалога'), frag))));
    }

    // =====================================================================
    // Чек-листы: редактор конфигурации
    // =====================================================================
    async viewChecklists(view, id) {
      await this.refreshChecklists();
      const cur = this.state.checklists.find((c) => c.id === (id || this.state.checklistId)) || this.state.checklists[0];
      const draft = structuredClone(cur);
      const versions = await this.req('GET', `/api/checklists/${cur.id}/versions`);

      const side = h('div', { class: 'panel stack', style: { alignSelf: 'start' } },
        h('h2', {}, 'Чек-листы'),
        this.state.checklists.map((c) => h('div', {}, h('a', { href: `#/checklists/${c.id}`, style: { fontWeight: c.id === cur.id ? 700 : 400 } }, c.name), h('span', { class: 'small muted' }, ` v${c.version} · ${c.criteria.length} крит.`))),
        h('button', { class: 'btn', onclick: () => this.guard(async () => {
          const copy = structuredClone(cur); delete copy.id; copy.name = cur.name + ' (копия)';
          const r = await this.req('POST', '/api/checklists', copy);
          this.toast('Создана копия'); this.go(`#/checklists/${r.id}`);
        }) }, 'Создать копию'),
        h('h3', { style: { marginTop: '14px' } }, 'Версии'),
        h('div', { class: 'small muted' }, [...versions].reverse().slice(0, 12).map((v) => h('div', {}, `v${v.version} · ${fmtDate(v.updated_at)} · ${v.criteria} крит.`))));

      const editor = h('div', { class: 'stack' });
      const weightInfo = h('span', { class: 'weights' });
      const updateWeights = () => {
        const sum = draft.criteria.filter((c) => c.type !== 'flag').reduce((s, c) => s + (Number(c.weight) || 0), 0);
        weightInfo.textContent = `Сумма весов: ${sum}`;
        weightInfo.className = 'weights' + (sum !== 100 ? ' bad' : '');
        weightInfo.title = sum !== 100 ? 'Сумма весов не равна 100 — максимум итога будет равен сумме весов' : '';
      };

      const bind = (obj, key, el, cast = (v) => v) => { el.addEventListener('input', () => { obj[key] = cast(el.type === 'checkbox' ? el.checked : el.value); updateWeights(); }); el.addEventListener('change', () => { obj[key] = cast(el.type === 'checkbox' ? el.checked : el.value); updateWeights(); }); return el; };
      const inp = (obj, key, attrs = {}, cast) => bind(obj, key, h('input', { type: 'text', value: obj[key] ?? '', ...attrs }), cast);
      const area = (obj, key, attrs = {}) => bind(obj, key, h('textarea', { rows: 2, ...attrs }, obj[key] ?? ''));

      const drawCriteria = () => {
        critList.replaceChildren(...draft.criteria.map((c, i) => this.criterionEditor(draft, c, i, { inp, area, bind, redraw: drawCriteria, updateWeights })));
        updateWeights();
      };
      const critList = h('div', { class: 'stack' });

      const sectionsBox = h('div', { class: 'stack' });
      const drawSections = () => {
        sectionsBox.replaceChildren(...draft.sections.map((s, i) => h('div', { class: 'row' },
          h('input', { type: 'text', value: s.id, style: { width: '110px' }, title: 'id секции', onchange: (e) => { const old = s.id; s.id = e.target.value.trim(); draft.criteria.forEach((c) => { if (c.section === old) c.section = s.id; }); drawCriteria(); } }),
          inp(s, 'name', { style: { flex: 1 } }),
          h('button', { class: 'btn sm danger', onclick: () => { draft.sections.splice(i, 1); drawSections(); drawCriteria(); } }, '✕'))),
        h('button', { class: 'btn sm', onclick: () => { draft.sections.push({ id: 's' + (draft.sections.length + 1), name: 'Новая секция' }); drawSections(); drawCriteria(); } }, '+ секция'));
      };

      const save = () => this.guard(async () => {
        const r = await this.req('PUT', `/api/checklists/${cur.id}`, draft);
        this.state.checklistId = r.id; localStorage.setItem('cqa.checklist', r.id);
        this.toast(`Сохранено: «${r.name}» v${r.version}. Новые оценки будут выполняться по этой версии.`);
        this.render();
      });

      editor.append(
        h('div', { class: 'panel stack' },
          h('div', { class: 'row' }, h('h1', { style: { margin: 0, flex: 1 } }, 'Настройка чек-листа'), h('span', { class: 'muted small' }, `v${cur.version} · изменён ${fmtDate(cur.updated_at)}`)),
          h('label', { class: 'field' }, 'Название', inp(draft, 'name')),
          h('label', { class: 'field' }, 'Описание', inp(draft, 'description')),
          h('label', { class: 'field' }, 'Общие правила оценки (передаются модели)', area(draft, 'general_rules', { rows: 6 })),
          h('div', { class: 'row' },
            h('label', { class: 'field' }, 'Округление итога (знаков)', inp(draft, 'rounding', { type: 'number', min: 0, max: 4, style: { width: '90px' } }, Number)))),
        h('div', { class: 'panel stack' }, h('h2', {}, 'Секции'), sectionsBox),
        h('div', { class: 'panel stack' },
          h('div', { class: 'row' }, h('h2', { style: { margin: 0, flex: 1 } }, 'Критерии'), weightInfo,
            h('button', { class: 'btn', onclick: () => { draft.criteria.push({ id: 'c' + Date.now().toString(36), code: String(draft.criteria.length + 1).padStart(2, '0'), name: 'Новый критерий', section: draft.sections[0]?.id || '', type: 'binary', weight: 10, na_allowed: false, description: 'Да — …', na_condition: '', guidance: '' }); drawCriteria(); critList.lastElementChild?.scrollIntoView({ behavior: 'smooth' }); } }, '+ Добавить критерий')),
          critList),
        h('div', { class: 'panel row', style: { position: 'sticky', bottom: '0', zIndex: 4 } },
          h('button', { class: 'btn primary', onclick: save }, 'Сохранить новую версию'),
          h('button', { class: 'btn', onclick: () => this.render() }, 'Отменить изменения'),
          h('div', { class: 'spacer' }),
          h('button', { class: 'btn', onclick: () => { this.state.checklistId = cur.id; localStorage.setItem('cqa.checklist', cur.id); this.go('#/'); this.toast(`Выбран «${cur.name}». Нажмите «Оценить все показанные», чтобы применить чек-лист.`); } }, 'Применить к диалогам →'),
          h('button', { class: 'btn danger', onclick: () => this.guard(async () => { if (!this._confirmReset) { this._confirmReset = true; this.toast('Нажмите ещё раз, чтобы сбросить к исходному чек-листу из PDF'); setTimeout(() => { this._confirmReset = false; }, 4000); return; } this._confirmReset = false; await this.req('POST', `/api/checklists/${cur.id}/reset-default`); this.toast('Сброшено к исходному'); this.render(); }) }, 'Сбросить к исходному')));

      drawSections();
      drawCriteria();
      view.append(h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(200px, 260px) 1fr', gap: '16px' } }, side, editor));
    }

    criterionEditor(draft, c, i, { inp, area, bind, redraw, updateWeights }) {
      const typeSel = bind(c, 'type', h('select', {}, Object.entries(TYPE).map(([v, t]) => h('option', { value: v, selected: c.type === v ? 'selected' : null }, t))));
      typeSel.addEventListener('change', () => {
        if (c.type === 'scale' && !c.scale?.length) c.scale = [{ value: 10, label: 'Полностью' }, { value: 5, label: 'Частично' }, { value: 0, label: 'Нет' }];
        if (c.type === 'flag') { c.weight = 0; c.na_allowed = false; }
        redraw();
      });
      const secSel = bind(c, 'section', h('select', {}, h('option', { value: '' }, '— без секции —'), draft.sections.map((s) => h('option', { value: s.id, selected: c.section === s.id ? 'selected' : null }, s.name))));
      const move = (d) => { const j = i + d; if (j < 0 || j >= draft.criteria.length) return; [draft.criteria[i], draft.criteria[j]] = [draft.criteria[j], draft.criteria[i]]; redraw(); };
      const naBox = bind(c, 'na_allowed', h('input', { type: 'checkbox', checked: c.na_allowed, disabled: c.type === 'flag' }));
      naBox.addEventListener('change', redraw);

      const box = h('div', { class: 'crit-edit stack' },
        h('div', { class: 'grid' },
          h('label', { class: 'field' }, 'Код', inp(c, 'code')),
          h('label', { class: 'field' }, 'Название', inp(c, 'name')),
          h('label', { class: 'field' }, 'Секция', secSel),
          h('label', { class: 'field' }, 'Тип ответа', typeSel),
          h('label', { class: 'field' }, 'Вес', c.type === 'flag' ? h('input', { type: 'text', value: '—', disabled: true }) : inp(c, 'weight', { type: 'number', min: 0 }, Number)),
          h('label', { class: 'field' }, 'N/A допустим', h('div', {}, naBox))),
        h('label', { class: 'field' }, c.type === 'flag' ? 'Формулировка (когда ставится флаг «Да»)' : 'Формулировка (условие «Да» / что оценивать)', area(c, 'description')),
        c.na_allowed ? h('label', { class: 'field' }, 'Условие N/A', inp(c, 'na_condition')) : null,
        c.type === 'scale' ? this.scaleEditor(c, redraw) : null,
        h('label', { class: 'field' }, 'Уточнения для ИИ (необязательно)', area(c, 'guidance', { rows: 2 })),
        h('div', { class: 'row small' },
          h('span', { class: 'muted' }, `id: ${c.id}`), h('div', { class: 'spacer' }),
          h('button', { class: 'btn sm', onclick: () => move(-1) }, '↑'), h('button', { class: 'btn sm', onclick: () => move(1) }, '↓'),
          h('button', { class: 'btn sm danger', onclick: () => { draft.criteria.splice(i, 1); redraw(); } }, 'Удалить критерий')));
      updateWeights();
      return box;
    }

    scaleEditor(c, redraw) {
      c.scale ||= [];
      return h('div', {},
        h('div', { class: 'small muted' }, 'Шкала: ступени (верхняя ступень даёт полный вес критерия)'),
        c.scale.map((s, j) => h('div', { class: 'scale-row' },
          h('input', { type: 'number', value: s.value, oninput: (e) => { s.value = Number(e.target.value); } }),
          h('input', { type: 'text', value: s.label, oninput: (e) => { s.label = e.target.value; } }),
          h('button', { class: 'btn sm danger', onclick: () => { c.scale.splice(j, 1); redraw(); } }, '✕'))),
        h('button', { class: 'btn sm', style: { marginTop: '4px' }, onclick: () => { c.scale.push({ value: 0, label: '' }); redraw(); } }, '+ ступень'));
    }
  }

  customElements.define('cqa-app', CqaApp);
})();
