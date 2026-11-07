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
  const fmt = (x, d = 2) => (x == null ? '—' : Number(x).toLocaleString('ru-RU', { maximumFractionDigits: d }));
  const fmtDate = (s) => (s ? new Date(s).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : '');
  const clock = (sec) => { if (sec == null) return ''; const s = Math.round(sec); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const ICONS = {
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>',
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 12l3 3 5-6"/></svg>',
    scale: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18M7 21h10M5 7h14M5 7l-3 7a4 4 0 0 0 6 0zM19 7l-3 7a4 4 0 0 0 6 0z"/></svg>',
    bars: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="12" width="4" height="8" rx="1"/><rect x="10" y="7" width="4" height="13" rx="1"/><rect x="16" y="3" width="4" height="17" rx="1"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>',
    ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>',
    no: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>',
    na: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M6 12h12"/></svg>',
    warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>',
  };
  const LANG_NAME = { RU: 'Русский', KZ: 'Қазақша', EN: 'English' };
  // CSV с колонками timestamp/time, speaker/role, text/message → строки «[время] роль: текст»
  function csvToLines(text) {
    const rows = text.split(/\r?\n/).filter(Boolean);
    const sep = rows[0].includes(';') ? ';' : ',';
    const split = (l) => { const out = []; let cur = '', q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === sep && !q) { out.push(cur); cur = ''; } else cur += ch; } out.push(cur); return out.map((x) => x.trim()); };
    const head = split(rows[0]).map((x) => x.toLowerCase());
    const iT = head.findIndex((x) => /time|время/.test(x)), iS = head.findIndex((x) => /speaker|role|роль/.test(x)), iX = head.findIndex((x) => /text|message|реплика|текст/.test(x));
    if (iS < 0 || iX < 0) return text;
    return rows.slice(1).map((l) => { const c = split(l); return `${iT >= 0 && c[iT] ? '[' + c[iT] + '] ' : ''}${c[iS]}: ${c[iX]}`; }).join('\n');
  }
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
      this.state = { checklists: [], health: null, jobs: {}, selected: new Set(), filters: { q: '', lang: '', channel: '', assignee: '', group: (() => { try { return localStorage.getItem('cqa.group') || ''; } catch { return ''; } })() } };
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
    /**
     * Живая оценка: карточка внизу справа показывает каждый критерий по мере готовности.
     * Возвращает итоговую оценку { evaluation_id, total, duration_ms } или null при ошибке (карточка остаётся с текстом ошибки).
     */
    async evaluateLive(conversationId, checklistId) {
      this.querySelector('.live')?.remove();
      const started = Date.now();
      const status = h('div', { class: 'live-status' }, 'Подключаюсь к модели…');
      const list = h('ol', { class: 'live-list' });
      const actions = h('div', { class: 'row live-actions', hidden: true });
      const card = h('section', { class: 'live', role: 'status', 'aria-live': 'polite', 'aria-label': 'Ход оценки' },
        h('div', { class: 'live-head' }, h('strong', {}, 'Оценка ИИ'), h('span', { class: 'muted' }, conversationId)), status, list, actions);
      this.append(card);
      const rows = new Map(); let total = 0; let done = 0;
      const tick = () => { const sec = Math.round((Date.now() - started) / 1000); if (done < total) status.textContent = `Критерий ${done + 1} из ${total} · ${sec} с${sec > 120 ? ' · дольше обычного (~1 мин)' : ''}`; };
      const timer = setInterval(tick, 1000);
      const ac = new AbortController();
      const stopBtn = h('button', { class: 'btn', onclick: () => ac.abort() }, 'Остановить');
      actions.hidden = false; actions.replaceChildren(stopBtn);
      const fail = (msg) => {
        clearInterval(timer);
        for (const r of rows.values()) if (!r.li.className.startsWith('done')) { r.li.className = 'wait'; r.st.textContent = 'не оценён'; }
        status.textContent = ac.signal.aborted ? 'Остановлено. Оценка не сохранена.' : `Ошибка: ${msg}. Оценка не сохранена.`;
        status.classList.add('bad');
        actions.hidden = false;
        actions.replaceChildren(
          h('button', { class: 'btn primary', onclick: () => this.evaluateLive(conversationId, checklistId).then((r) => r && this.go(`#/c/${encodeURIComponent(conversationId)}?ev=${r.evaluation_id}`)) }, 'Повторить'),
          h('button', { class: 'btn', onclick: () => card.remove() }, 'Закрыть'));
        return null;
      };
      let res;
      try {
        res = await fetch(this.api + '/api/evaluate/stream', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ conversation_id: conversationId, checklist_id: checklistId }), signal: ac.signal });
      } catch { return fail('сервер не отвечает'); }
      if (!res.ok) { const e = await res.json().catch(() => ({})); return fail(e.error || `HTTP ${res.status}`); }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '', result = null;
      const handle = (m) => {
        if (m.type === 'start') {
          total = m.criteria.length;
          for (const c of m.criteria) {
            const st = h('span', { class: 'live-state' }, 'ждёт');
            const li = h('li', { class: 'wait' }, h('span', { class: 'live-name' }, `${c.code ? c.code + ' ' : ''}${c.name}`), st);
            rows.set(c.id, { li, st, type: c.type, max: c.max }); list.append(li);
          }
          // в режиме одного вызова критерии приходят все сразу в конце
          if (m.mode !== 'per-criterion') list.querySelectorAll('.live-state').forEach((x) => { x.textContent = 'в общем запросе'; });
          else { const f = rows.values().next().value; if (f) { f.li.className = 'work'; f.st.textContent = 'оценивается…'; } }
          tick();
        } else if (m.type === 'criterion') {
          const r = rows.get(m.criterion_id); if (!r) return;
          done++;
          // цвет — хорошо/плохо, а не буква ответа: у флага «Да» — нарушение, у шкалы цвет по доле баллов
          const tone = r.type === 'flag' ? (m.answer === 'yes' ? 'bad' : 'ok') : m.answer === 'na' ? 'na' : m.answer === 'no' ? 'bad' : m.answer === 'yes' || r.max === Number(m.answer) ? 'ok' : 'mid';
          r.li.className = `done t-${tone}`;
          r.st.replaceChildren(...[h('b', {}, m.label), m.rule && h('span', { class: 'live-rule', title: 'Факт проверен кодом, без модели' }, 'правило')].filter(Boolean));
          r.li.title = m.explanation || '';
          const next = [...rows.values()].find((x) => x.li.className === 'wait');
          if (next) { next.li.className = 'work'; next.st.textContent = 'оценивается…'; }
          tick();
        } else if (m.type === 'done') result = m;
        else if (m.type === 'error') throw new Error(m.error);
      };
      try {
        for (;;) {
          const { value, done: end } = await reader.read();
          if (value) { buf += value; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) handle(JSON.parse(line)); } }
          if (end) break;
        }
      } catch (e) { return fail(e.message || 'обрыв связи'); }
      if (!result) return fail('ответ сервера оборвался');
      clearInterval(timer);
      actions.hidden = true;
      status.textContent = `Готово: ${fmt(result.total)} из 100 · ${Math.round(result.duration_ms / 1000)} с`;
      status.classList.add('ok');
      setTimeout(() => card.remove(), 6000);
      return result;
    }
    async guard(fn) { try { return await fn(); } catch (e) { this.toast(e.message, true); console.error(e); } }

    async init() {
      this.innerHTML = '';
      this.side = h('aside', { class: 'side' });
      this.main = h('main');
      this.append(h('div', { class: 'shell' }, this.side, this.main));
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

    async renderSide() {
      const { parts } = this.route();
      const sect = parts[0] || '';
      let open = 0;
      try { open = (await this.req('GET', '/api/appeals?status=open')).length; } catch { /* ignore */ }
      const hlth = this.state.health;
      const item = (href, active, icon, label, extra) => h('a', { href, class: 'side-link' + (active ? ' active' : ''), 'aria-current': active ? 'page' : null }, h('span', { class: 'ico', html: ICONS[icon] }), h('span', {}, label), extra || null);
      this.side.replaceChildren(
        h('a', { class: 'side-brand', href: this.getAttribute('home-url') || 'index.html', title: 'О проекте' }, 'CQA'),
        h('nav', { class: 'side-nav', 'aria-label': 'Разделы' },
          item('#/new', sect === 'new', 'plus', 'Новая проверка'),
          item('#/', ['', 'c'].includes(sect), 'chat', 'Диалоги'),
          item('#/checklists', sect === 'checklists', 'check', 'Чек-листы'),
          item('#/appeals', sect === 'appeals', 'scale', 'Апелляции', open ? h('span', { class: 'count' }, open) : null),
          item('#/analytics', sect === 'analytics', 'bars', 'Аналитика')),
        h('div', { class: 'side-foot' },
          h('label', { class: 'side-field' }, 'Чек-лист',
            h('select', { onchange: (e) => { this.state.checklistId = e.target.value; localStorage.setItem('cqa.checklist', e.target.value); this.render(); } },
              this.state.checklists.map((c) => h('option', { value: c.id, selected: c.id === this.state.checklistId ? 'selected' : null }, `${c.name}, v${c.version}`)))),
          hlth ? h('div', { class: 'side-model' + (hlth.configured ? '' : ' off'), title: hlth.configured ? 'Модель оценки' : 'Ключ API не задан — оценка недоступна' },
            h('span', {}, hlth.provider === 'ollama' ? 'Локальная модель' : hlth.provider === 'anthropic' ? 'Облачная модель' : 'Модель'), h('b', {}, hlth.model + (hlth.configured ? '' : ', нет ключа'))) : null),
      );
    }

    async render() {
      this.renderSide();
      const { parts, query } = this.route();
      const view = h('div');
      this.main.replaceChildren(view);
      await this.guard(async () => {
        if (parts[0] === 'c' && parts[1]) return this.viewCard(view, parts[1], query.get('ev'), query.get('m'));
        if (parts[0] === 'appeals') return this.viewAppeals(view, parts[1]);
        if (parts[0] === 'checklists') return this.viewChecklists(view, parts[1]);
        if (parts[0] === 'analytics') return this.viewAnalytics(view);
        if (parts[0] === 'new') return this.viewSandbox(view, parts[1] || 'chat');
        return this.viewList(view);
      });
    }

    // =====================================================================
    // Список диалогов
    // =====================================================================
    async viewList(view) {
      const [convs, groups, rv] = await Promise.all([this.req('GET', '/api/conversations'), this.req('GET', '/api/groups'), this.req('GET', '/api/reviewers').catch(() => ({ names: [] }))]);
      const reviewerNames = rv.names;
      const f = this.state.filters;
      if (f.group && !groups.some((g) => g.group_id === f.group)) f.group = ''; // набора нет — показываем все
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
        (!f.lang || c.language === f.lang) && (!f.channel || c.channel === f.channel) && (f.review !== 'need' || c.last_evaluation?.needs_review) && (!f.group || c.group_id === f.group) &&
        (!f.assignee || (f.assignee === '—' ? !c.assignee : c.assignee === f.assignee)) &&
        (!f.q || (c.conversation_id + ' ' + (c.title || '') + ' ' + c.preview).toLowerCase().includes(f.q.toLowerCase())));

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
          h('td', {}, h('b', {}, c.conversation_id), h('div', { class: 'small muted' }, c.title || c.group_id)),
          h('td', {}, h('span', { class: 'tag blue' }, LANG[c.language] || c.language)),
          h('td', {}, c.channel === 'voice call' ? '📞 звонок' : '💬 чат', h('div', { class: 'small muted' }, `${c.messages} реплик`)),
          h('td', { class: 'small', style: { maxWidth: '420px' } }, c.preview),
          h('td', {}, ev ? h('div', {},
            h('span', { class: 'score' }, fmt(ev.total)),
            ev.original_total !== ev.total ? h('span', { class: 'small muted' }, ` (ИИ: ${fmt(ev.original_total)})`) : null,
            ev.gross ? h('div', {}, h('span', { class: 'tag no' }, 'грубая ошибка')) : null,
            h('div', { class: 'small muted' }, `${ev.checklist_name} v${ev.checklist_version}`)) : h('span', { class: 'muted small' }, 'не оценён')),
          h('td', {}, ev ? (ev.needs_review
            ? h('span', { class: 'tag warn', title: ev.review_reasons.join('\n') }, 'нужна проверка')
            : h('span', { class: 'tag ' + (ev.status === 'appealed' ? 'warn' : ev.status === 'reviewed' ? 'yes' : '') }, { evaluated: 'оценён', appealed: 'апелляция', reviewed: 'пересмотрен', manual: 'ручная' }[ev.status] || ev.status)) : null),
          h('td', { onclick: (e) => e.stopPropagation() }, h('select', { class: 'assignee', 'aria-label': 'Проверяющий', onchange: (e) => this.guard(async () => { await this.req('POST', '/api/assign', { conversation_ids: [c.conversation_id], assignee: e.target.value || null }); c.assignee = e.target.value || null; }) },
            h('option', { value: '' }, '—'), [...new Set([...reviewerNames, ...(c.assignee ? [c.assignee] : [])])].map((n) => h('option', { value: n, selected: c.assignee === n ? 'selected' : null }, n))))));
      }

      const select = (key, opts, label) => h('select', { onchange: (e) => { f[key] = e.target.value; if (key === 'group') { try { localStorage.setItem('cqa.group', f.group); } catch { /* ignore */ } } this.render(); } },
        h('option', { value: '' }, label), opts.map(([v, t]) => h('option', { value: v, selected: f[key] === v ? 'selected' : null }, t)));
      const search = h('input', { type: 'search', placeholder: 'Поиск по ID и тексту', value: f.q, oninput: (e) => { f.q = e.target.value; clearTimeout(this._t); this._t = setTimeout(() => { this.render().then(() => { const s = this.querySelector('input[type=search]'); s?.focus(); s?.setSelectionRange(s.value.length, s.value.length); }); }, 300); } });

      // распределение между проверяющими
      const namesInput = h('input', { type: 'text', value: reviewerNames.join(', '), placeholder: 'Айгерим, Иван, Дана', style: { minWidth: '18rem', flex: 1 } });
      const distBox = h('div', { class: 'panel dist', hidden: true },
        h('h3', {}, 'Распределить диалоги между проверяющими'),
        h('p', { class: 'small muted', style: { margin: '0 0 0.6rem' } }, 'Поровну с учётом уже назначенных: следующий диалог получает тот, у кого меньше всего в работе. Отмеченные галочками — или все показанные, если ничего не отмечено.'),
        h('div', { class: 'row' }, h('label', { class: 'field', style: { flex: 1 } }, 'Проверяющие (через запятую)', namesInput),
          h('button', { class: 'btn primary', onclick: () => this.guard(async () => {
            const names = namesInput.value.split(',').map((x) => x.trim()).filter(Boolean);
            await this.req('PUT', '/api/reviewers', { names });
            const ids = sel.size ? [...sel] : filtered.map((c) => c.conversation_id);
            const r = await this.req('POST', '/api/assign/auto', { conversation_ids: ids, reviewers: names });
            this.toast('Распределено: ' + Object.entries(r.plan).map(([n, k]) => `${n} — ${k}`).join(', '));
            this.render();
          }) }, 'Распределить поровну'),
          h('button', { class: 'btn', onclick: () => this.guard(async () => {
            const ids = sel.size ? [...sel] : filtered.map((c) => c.conversation_id);
            await this.req('POST', '/api/assign', { conversation_ids: ids, assignee: null }); this.toast(`Снято назначение: ${ids.length}`); this.render();
          }) }, 'Снять назначение')));

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
              h('a', { class: 'btn', href: `${this.api}/api/export?format=json&checklist_id=${cl?.id || ''}${f.group ? '&group_id=' + f.group : ''}`, target: '_blank' }, 'JSON'),
              h('button', { class: 'btn primary', title: 'Файл в формате организаторов (Results JSON 1.0)', onclick: () => this.guard(async () => {
                if (!f.group) throw new Error('Выберите набор в фильтре «Все наборы», чтобы выгрузить results.json');
                const r = await this.req('GET', `/api/results?group_id=${encodeURIComponent(f.group)}&checklist_id=${cl?.id || ''}`);
                const okCount = r.doc.results.filter((x) => x.status === 'ok').length;
                const blob = new Blob([JSON.stringify(r.doc, null, 2)], { type: 'application/json' });
                const a = h('a', { href: URL.createObjectURL(blob), download: 'results.json' }); this.append(a); a.click(); a.remove();
                this.toast(r.problems.length ? `results.json: ${okCount}/${r.doc.results.length} оценено. Проблемы:\n${r.problems.slice(0, 6).join('\n')}` : `results.json готов: ${okCount}/${r.doc.results.length} диалогов, проверка пройдена`, r.problems.length > 0);
              }) }, 'results.json'))),
          pasteBox,
          h('div', { class: 'panel' },
            h('div', { class: 'row', style: { marginBottom: '10px' } },
              search,
              select('group', groups.map((g) => [g.group_id, `${g.group_id} (${g.count})`]), 'Все наборы'),
              select('lang', [['RU', 'RU'], ['KZ', 'KZ'], ['EN', 'EN']], 'Все языки'),
              select('channel', [['agent chat', 'Чаты'], ['voice call', 'Звонки']], 'Все каналы'),
              select('review', [['need', `Нужна проверка (${convs.filter((c) => c.last_evaluation?.needs_review).length})`]], 'Все оценки'),
              select('assignee', [['—', 'Не назначены'], ...reviewerNames.map((n) => [n, n])], 'Все проверяющие'),
              h('span', { class: 'muted small' }, `${filtered.length} из ${convs.length}`, avg != null ? `, средний итог ${fmt(avg)}` : ''),
              h('div', { class: 'spacer' }),
              h('button', { class: 'btn', onclick: () => { distBox.hidden = !distBox.hidden; } }, 'Распределить'),
              h('button', { class: 'btn', onclick: () => sel.size ? runBatch([...sel], false) : this.toast('Отметьте диалоги галочками', true) }, `Оценить выбранные (${sel.size})`),
              h('button', { class: 'btn primary', onclick: () => runBatch(filtered.map((c) => c.conversation_id), true), title: 'Пропустит диалоги, уже оценённые текущей версией чек-листа' }, `Оценить все показанные (${filtered.length})`)),
            distBox,
            jobBox,
            filtered.length ? h('div', { class: 'table-wrap' }, h('table', {},
              h('thead', {}, h('tr', {}, h('th', {}, allBox), h('th', {}, 'Диалог'), h('th', {}, 'Язык'), h('th', {}, 'Канал'), h('th', {}, 'Запрос клиента'), h('th', {}, 'Итог'), h('th', {}, 'Статус'), h('th', {}, 'Проверяющий'))),
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
      const isCall = conv.channel === 'voice call';
      const T = conv.transcript;
      const lastOff = Math.max(0, ...T.map((m) => m.offset_sec || 0));
      const duration = lastOff + 5;
      const timeOf = (m) => (isCall ? clock(m.offset_sec) : m.timestamp);
      const span = (idx) => { const m = T[idx - 1]; const next = T.slice(idx).find((x) => x.offset_sec != null && x.offset_sec > (m?.offset_sec ?? 0)); return m?.offset_sec == null ? null : [m.offset_sec, next ? next.offset_sec : m.offset_sec + 4]; };
      const speakerAt = (t) => { let sp = null; for (const m of T) { if (m.offset_sec == null || m.offset_sec > t) break; if (m.speaker === 'client' || m.speaker === 'operator') sp = m.speaker; else if (m.speaker === 'bot') sp = null; } return sp; };
      const state = { selected: focusMsg ? Number(focusMsg) : null };

      // ---------- заголовок ----------
      const cl = this.checklist;
      const evalBtn = h('button', { class: 'btn primary', title: `Чек-лист «${cl.name}» v${cl.version}`, onclick: async () => {
        evalBtn.disabled = true; evalBtn.textContent = 'Идёт оценка…';
        await this.guard(async () => {
          const r = await this.evaluateLive(conv.conversation_id, cl.id);
          if (r) this.go(`#/c/${encodeURIComponent(conv.conversation_id)}?ev=${r.evaluation_id}`);
        });
        evalBtn.disabled = false; evalBtn.textContent = ev ? 'Переоценить' : 'Оценить';
      } }, ev ? 'Переоценить' : 'Оценить');
      const head = h('div', { class: 'page-head' },
        h('div', {},
          h('a', { href: '#/', class: 'back' }, 'Диалоги'),
          h('h1', {}, isCall ? 'Анализ разговора' : 'Анализ чата'),
          h('div', { class: 'sub' }, `${isCall ? 'Звонок' : 'Чат'} ${conv.conversation_id} · ${LANG_NAME[conv.language] || conv.language} · ${clock(lastOff)}`)),
        h('div', { class: 'row' },
          conv.evaluations.length > 1 ? h('select', { 'aria-label': 'История оценок', onchange: (e) => this.go(`#/c/${encodeURIComponent(conv.conversation_id)}?ev=${e.target.value}`) },
            conv.evaluations.map((e) => h('option', { value: e.id, selected: e.id === ev?.id ? 'selected' : null }, `${fmtDate(e.created_at)}, ${fmt(e.total)}`))) : null,
          evalBtn));

      // ---------- панель записи / хронологии ----------
      const BARS = 220;
      const canvas = h('canvas', { class: 'wave', height: 120, 'aria-label': isCall ? 'Волны записи: клиент и оператор' : 'Хронология чата: клиент и оператор' });
      const playBtn = h('button', { class: 'play-btn', 'aria-label': 'Воспроизвести', html: ICONS.play, disabled: !isCall });
      const timeLbl = h('span', { class: 'time' }, `0:00 / ${clock(isCall ? lastOff : lastOff)}`);
      const range = h('input', { type: 'range', min: 0, max: Math.round(duration * 10), value: 0, class: 'seek', 'aria-label': 'Позиция', disabled: !isCall });
      const media = h('div', { class: 'panel media' },
        h('div', { class: 'lanes' }, h('div', { class: 'lane-names' }, h('span', {}, 'Клиент'), h('span', {}, 'Оператор')), canvas),
        h('div', { class: 'transport' }, playBtn, timeLbl, range,
          isCall ? h('a', { class: 'small muted', href: conv.audio_url, target: '_blank', rel: 'noopener' }, 'Плеер организаторов') : h('span', { class: 'small muted' }, 'Чат: высота столбика — длина реплики')));
      let audio = null;
      let peaks = null; // амплитуда по времени
      let dur = duration;
      const draw = () => {
        const dpr = window.devicePixelRatio || 1;
        const w = canvas.clientWidth || 800, hgt = 120;
        canvas.width = w * dpr; canvas.height = hgt * dpr;
        const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr); ctx.clearRect(0, 0, w, hgt);
        const css = getComputedStyle(this);
        const cClient = css.getPropertyValue('--wave-client').trim() || '#0c5f35';
        const cOp = css.getPropertyValue('--wave-op').trim() || '#00b323';
        const cIdle = css.getPropertyValue('--line').trim() || '#e7e7ea';
        // выделенный фрагмент
        const sel = state.selected ? span(state.selected) : null;
        if (sel) {
          const x1 = (sel[0] / dur) * w, x2 = Math.max(x1 + 6, (sel[1] / dur) * w);
          ctx.fillStyle = css.getPropertyValue('--hl-frag').trim() || 'rgba(255,167,0,.16)'; ctx.fillRect(x1, 0, x2 - x1, hgt);
          ctx.strokeStyle = css.getPropertyValue('--hl-frag-line').trim() || '#ffa700'; ctx.lineWidth = 1; ctx.strokeRect(x1 + .5, .5, x2 - x1 - 1, hgt - 1);
        }
        const step = w / BARS, bw = Math.max(1.5, step * 0.55);
        for (let i = 0; i < BARS; i++) {
          const t = ((i + 0.5) / BARS) * dur;
          let amp;
          if (peaks) amp = peaks[Math.min(peaks.length - 1, Math.floor((i / BARS) * peaks.length))];
          else { // хронология: столбик там, где была реплика, высота — длина текста
            // реплика «звучит» от своей метки времени пропорционально длине текста (≈15 символов в секунду)
            const m = T.find((x) => x.offset_sec != null && (x.speaker === 'client' || x.speaker === 'operator') && t >= x.offset_sec && t <= x.offset_sec + Math.max(dur / 90, x.text.length / 15));
            amp = m ? 0.35 + 0.5 * Math.abs(Math.sin(i * 1.7)) * Math.min(1, m.text.length / 120) + 0.15 : 0;
          }
          const sp = speakerAt(t);
          const x = i * step + (step - bw) / 2;
          for (const [lane, color, cy] of [['client', cClient, 30], ['operator', cOp, 90]]) {
            const active = sp === lane && amp > 0;
            const hh = active ? Math.max(3, amp * 26) : 1.5;
            ctx.fillStyle = active ? color : cIdle;
            ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, cy - hh, bw, hh * 2, bw / 2) : ctx.rect(x, cy - hh, bw, hh * 2); ctx.fill();
          }
        }
        if (audio && isFinite(audio.currentTime)) { const px = (audio.currentTime / dur) * w; ctx.fillStyle = cOp; ctx.fillRect(px, 0, 2, hgt); }
      };
      const select = (idx, { scroll = true, seekAudio = true } = {}) => {
        state.selected = idx;
        trBox.querySelectorAll('.line.sel').forEach((e) => e.classList.remove('sel'));
        const el = lineEls.get(idx);
        if (el) { el.classList.add('sel'); if (scroll) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
        const m = T[idx - 1];
        if (audio && seekAudio && m?.offset_sec != null) this.seek(audio, m.offset_sec, false);
        history.replaceState(null, '', `#/c/${encodeURIComponent(conv.conversation_id)}?ev=${ev?.id || ''}&m=${idx}`);
        draw();
      };
      canvas.addEventListener('click', (e) => {
        const r = canvas.getBoundingClientRect(); const t = ((e.clientX - r.left) / r.width) * dur;
        const m = [...T].reverse().find((x) => x.offset_sec != null && x.offset_sec <= t) || T[0];
        if (audio) this.seek(audio, t, false);
        select(m.idx, { seekAudio: false });
      });
      if (isCall) {
        audio = h('audio', { preload: 'metadata', src: `${this.api}/api/audio/${encodeURIComponent(conv.conversation_id)}` });
        media.append(audio);
        playBtn.onclick = () => { if (audio.paused) audio.play().catch((e) => this.toast('Запись недоступна: ' + e.message, true)); else audio.pause(); };
        audio.addEventListener('play', () => { playBtn.innerHTML = ICONS.pause; playBtn.setAttribute('aria-label', 'Пауза'); });
        audio.addEventListener('pause', () => { playBtn.innerHTML = ICONS.play; playBtn.setAttribute('aria-label', 'Воспроизвести'); });
        audio.addEventListener('loadedmetadata', () => { if (isFinite(audio.duration)) { dur = Math.max(audio.duration, lastOff + 1); range.max = Math.round(dur * 10); draw(); } });
        audio.addEventListener('timeupdate', () => {
          timeLbl.textContent = `${clock(audio.currentTime)} / ${clock(dur)}`;
          range.value = Math.round(audio.currentTime * 10);
          const cur = [...T].reverse().find((x) => x.offset_sec != null && x.offset_sec <= audio.currentTime);
          if (!audio.paused && cur && cur.idx !== state.selected) select(cur.idx, { seekAudio: false });
          else draw();
        });
        range.addEventListener('input', () => { audio.currentTime = range.value / 10; });
        // волна из настоящей записи (файл через наш адрес → Web Audio)
        fetch(`${this.api}/api/audio/${encodeURIComponent(conv.conversation_id)}/file`).then((r) => { if (!r.ok) throw new Error(); return r.arrayBuffer(); })
          .then((buf) => new (window.AudioContext || window.webkitAudioContext)().decodeAudioData(buf))
          .then((ab) => {
            const N = 2000, data = ab.getChannelData(0), per = Math.floor(data.length / N); const out = new Float32Array(N); let mx = 0;
            for (let i = 0; i < N; i++) { let s2 = 0; for (let j = i * per; j < (i + 1) * per; j += 8) s2 += data[j] * data[j]; out[i] = Math.sqrt(s2 / (per / 8)); mx = Math.max(mx, out[i]); }
            peaks = out.map((v) => (mx ? v / mx : 0)); dur = Math.max(ab.duration, lastOff + 1); range.max = Math.round(dur * 10); draw();
          }).catch(() => { /* остаётся хронология по транскрипту */ });
      }

      // ---------- расшифровка ----------
      const trBox = h('div', { class: 'tr-list' });
      const lineEls = new Map();
      for (const m of T) {
        const el = h('button', { class: `line ${m.speaker}`, type: 'button', onclick: () => select(m.idx, { scroll: false }) },
          h('span', { class: 'when' }, timeOf(m)), h('span', { class: 'who' }, ROLE[m.speaker] || m.speaker), h('span', { class: 'num' }, '#' + m.idx),
          h('span', { class: 'what' }, m.text));
        lineEls.set(m.idx, el);
        trBox.append(el);
      }
      const trPanel = h('div', { class: 'panel tr-panel' }, h('h2', {}, 'Расшифровка'), trBox);

      // ---------- оценка качества ----------
      const qPanel = h('div', { class: 'panel q-panel' }, h('h2', {}, 'Оценка качества'));
      const details = h('div', { class: 'stack' });
      if (!ev) {
        qPanel.append(h('div', { class: 'empty' }, 'Диалог ещё не оценён.', h('div', { style: { marginTop: '12px' } }, evalBtn.cloneNode(true))));
        qPanel.querySelector('.empty button').onclick = () => evalBtn.click();
      } else {
        const ckl = ev.checklist; const fs = ev.final_score;
        const rows = ckl.criteria.map((c) => ({ c, r: ev.criteria.find((x) => x.criterion_id === c.id) })).filter((x) => x.r);
        const lost = rows.filter(({ c, r }) => c.type !== 'flag' && r.final_answer !== 'na' && r.final.points < r.final.max_points - 0.001);
        let focusCrit = lost[0] || null;
        const pct = fs.total == null ? 0 : fs.total / 100;
        const R = 52, C = 2 * Math.PI * R;
        const ring = h('div', { class: 'ring', html: `<svg viewBox="0 0 120 120" aria-hidden="true"><circle cx="60" cy="60" r="${R}" class="ring-bg"/><circle cx="60" cy="60" r="${R}" class="ring-fg" stroke-dasharray="${C * pct} ${C}" transform="rotate(-90 60 60)"/></svg>` },
          h('div', { class: 'ring-val' }, h('b', {}, fs.total == null ? '—' : fmt(fs.total)), h('span', {}, '/ 100')));
        const list = h('div', { class: 'q-list' });
        for (const { c, r } of rows) {
          if (c.type === 'flag') continue;
          const p = r.final; const na = r.final_answer === 'na';
          const state2 = na ? 'na' : p.points >= p.max_points - 0.001 ? 'ok' : p.points > 0 ? 'part' : 'no';
          list.append(h('button', { class: `q-row ${state2}`, type: 'button', title: r.ai.explanation, onclick: () => { focusCrit = { c, r }; renderWhy(); } },
            h('span', { class: 'q-ico', html: ICONS[state2 === 'no' ? 'no' : state2 === 'na' ? 'na' : 'ok'] }),
            h('span', { class: 'q-name' }, c.name, r.ai.doubts?.length ? h('span', { class: 'q-doubt', title: r.ai.doubts.join('\n') }, ' · проверить') : null),
            h('span', { class: 'q-pts' }, na ? 'N/A' : h('span', {}, h('b', {}, fmt(p.points, 1)), ` / ${fmt(p.max_points, 1)}`))));
        }
        const flag = rows.find(({ c }) => c.type === 'flag');
        const why = h('div', { class: 'why' });
        const renderWhy = () => {
          const fc = focusCrit;
          why.replaceChildren(
            h('h3', {}, fc ? 'Почему снижена оценка' : 'Оценка без снижений'),
            fc ? h('p', {}, h('b', {}, fc.c.name + ': '), fc.r.ai.explanation) : h('p', { class: 'muted' }, 'Все применимые критерии выполнены полностью.'),
            lost.length > 1 ? h('div', { class: 'why-tabs' }, lost.map((x) => h('button', { type: 'button', class: 'chip-btn' + (x === fc ? ' on' : ''), onclick: () => { focusCrit = x; renderWhy(); } }, x.c.name))) : null,
            h('div', { class: 'why-actions' },
              h('button', { class: 'btn primary', type: 'button', disabled: !fc, onclick: () => {
                const e = fc?.r.ai.evidence?.[0]?.message || fc?.r.ai.checked_range?.from; if (e) select(e); else this.toast('Модель не указала реплику для этого критерия', true);
              } }, 'Перейти к фрагменту'),
              h('button', { class: 'btn', type: 'button', disabled: !fc, onclick: () => { appealBox.replaceChildren(this.appealForm(ev, fc.c, () => this.render())); appealBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } }, 'Оспорить оценку')));
        };
        renderWhy();
        const appealBox = h('div');
        const reviewed = ev.reviewed || ev.status === 'reviewed';
        const meta = ev.provider === 'manual' || ev.status === 'manual' ? null : h('div', { class: 'ai-meta small muted' },
          h('span', { class: 'ai-mark' }, 'ИИ'), ` ${ev.model || ''} · ${Math.round((ev.duration_ms || 0) / 1000)} с`,
          ev.usage ? ` · ${fmt(((ev.usage.input_tokens || 0) + (ev.usage.output_tokens || 0)) / 1000, 1)} тыс. токенов` : '',
          ` · ${ev.cost_usd ? '$' + fmt(ev.cost_usd, 4) : 'бесплатно, локальная модель'}`);
        const reviewBox = ev.needs_review && !reviewed ? h('div', { class: 'need-review', role: 'note' },
          h('b', {}, 'Нужна проверка человеком'),
          h('ul', {}, (ev.review_reasons || []).slice(0, 4).map((x) => h('li', {}, x))),
          h('button', { class: 'btn sm', type: 'button', onclick: () => this.guard(async () => { await this.req('POST', `/api/evaluations/${ev.id}/confirm`, {}); this.toast('Оценка подтверждена'); this.render(); }) }, 'Подтвердить оценку'))
          : ev.reviewed ? h('div', { class: 'small muted' }, `Проверено: ${ev.reviewed_by}, ${fmtDate(ev.reviewed_at)}`) : null;
        appendAll(qPanel,
          meta, reviewBox,
          h('div', { class: 'q-top' }, ring, list),
          flag?.r.final_answer === 'yes' ? h('div', { class: 'gross', html: ICONS.warn }, h('span', {}, h('b', {}, 'Грубая ошибка. '), flag.r.ai.explanation)) : null,
          fs.total !== ev.original_score.total ? h('div', { class: 'small muted' }, `После пересмотра. Исходная оценка ИИ: ${fmt(ev.original_score.total)}`) : null,
          why, appealBox);
        this.renderEvaluation(details, ev, conv, (idx) => select(idx), { noTotals: true });
      }

      const M = conv.metrics;
      const stat = (label, value, note) => h('div', { class: 'mt' }, h('span', { class: 'mt-l' }, label), h('b', {}, value), note ? h('span', { class: 'mt-n' }, note) : null);
      const jumpList = (idxs, fmtOne) => idxs.length ? h('span', { class: 'mt-n' }, idxs.slice(0, 4).map((x, i) => h('a', { href: 'javascript:void 0', onclick: () => select(x.idx ?? x) }, (i ? ', ' : '') + fmtOne(x)))) : null;
      const metrics = M ? h('div', { class: 'panel metrics', 'aria-label': 'Метрики разговора' },
        stat('Ответ оператора', M.response_avg_sec == null ? '—' : `${M.response_avg_sec} с`, M.response_max_sec != null ? `в среднем; максимум ${M.response_max_sec} с` : null),
        h('div', { class: 'mt' }, h('span', { class: 'mt-l' }, isCall ? 'Паузы ≥ 10 с' : 'Ожидание ≥ 1,5 мин'), h('b', {}, String(M.long_pauses.length)),
          jumpList(M.long_pauses.map((p) => ({ idx: p.before, sec: p.sec })), (p) => `#${p.idx} (${p.sec} с)`)),
        h('div', { class: 'mt' }, h('span', { class: 'mt-l' }, 'Предупредил об ожидании'), h('b', {}, String(M.hold_announcements.length)), jumpList(M.hold_announcements, (x) => `#${x}`)),
        stat('Доля оператора', M.operator_share == null ? '—' : `${M.operator_share}%`, isCall ? 'времени речи' : 'объёма переписки'),
        isCall ? stat('Перебивания', String(M.interruptions), 'оператор заговорил раньше, чем клиент мог договорить') : null,
        h('p', { class: 'mt-src small muted' }, 'Считается кодом по времени реплик в расшифровке, без ИИ.')) : null;
      appendAll(view, head, media, metrics, h('div', { class: 'card-cols' }, trPanel, qPanel),
        h('div', { class: 'card-cols', style: { marginTop: '1rem' } }, this.assistantPanel(conv, ev), this.whatIfPanel(conv, ev)),
        ev ? h('h2', { class: 'section-title' }, 'Подробно по критериям') : null, details);
      requestAnimationFrame(draw);
      new ResizeObserver(() => draw()).observe(canvas);
      if (state.selected) setTimeout(() => select(state.selected), 60);
    }

    // =====================================================================
    // Аналитика: сводка для руководителей и контроля качества
    // =====================================================================
    async viewAnalytics(view) {
      const groups = await this.req('GET', '/api/groups');
      const f = this.state.filters;
      if (!f.group || !groups.some((g) => g.group_id === f.group)) f.group = groups.find((g) => g.group_id === 'DEV')?.group_id || groups[0]?.group_id || '';
      const cl = this.checklist;
      const [a, acc] = await Promise.all([
        this.req('GET', `/api/analytics?group_id=${encodeURIComponent(f.group)}&checklist_id=${cl?.id || ''}`),
        this.req('GET', '/api/accuracy').catch(() => ({ date: null }))]);
      const tip = h('div', { class: 'tip', hidden: true, role: 'tooltip' });
      const showTip = (e, text) => { tip.textContent = text; tip.hidden = false; tip.style.left = Math.min(e.clientX + 14, window.innerWidth - 300) + 'px'; tip.style.top = (e.clientY + 14) + 'px'; };
      const hideTip = () => { tip.hidden = true; };
      const hover = (el, text) => { el.addEventListener('mousemove', (e) => showTip(e, text)); el.addEventListener('mouseleave', hideTip); el.addEventListener('focus', (e) => { const r = el.getBoundingClientRect(); showTip({ clientX: r.right, clientY: r.top }, text); }); el.addEventListener('blur', hideTip); el.tabIndex = 0; return el; };
      const tableToggle = (rows, headers) => h('details', { class: 'as-table' }, h('summary', {}, 'Показать таблицей'),
        h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, headers.map((x) => h('th', {}, x)))), h('tbody', {}, rows.map((r) => h('tr', {}, r.map((x) => h('td', {}, x))))))));

      const kpi = (label, value, note) => h('div', { class: 'panel kpi' }, h('span', { class: 'kpi-l' }, label), h('b', {}, value), note ? h('span', { class: 'kpi-n' }, note) : null);
      const head = h('div', { class: 'page-head' },
        h('div', {}, h('h1', {}, 'Аналитика'), h('div', { class: 'sub' }, `Набор ${f.group || '—'} · чек-лист «${a.checklist.name}» v${a.checklist.version}`)),
        h('div', { class: 'row' }, h('select', { 'aria-label': 'Набор', onchange: (e) => { f.group = e.target.value; try { localStorage.setItem('cqa.group', f.group); } catch { /* */ } this.render(); } },
          groups.map((g) => h('option', { value: g.group_id, selected: g.group_id === f.group ? 'selected' : null }, `${g.group_id} (${g.count})`)))));

      if (!a.evaluated) { view.append(head, h('div', { class: 'panel empty' }, 'В этом наборе пока нет оценок. Откройте «Диалоги» и нажмите «Оценить все показанные».')); return; }

      // выполнение по критериям — горизонтальные столбики, один цвет
      const critRows = a.criteria.filter((c) => c.type !== 'flag');
      const critChart = h('div', { class: 'hbars' }, critRows.map((c) => h('div', { class: 'hbar-row' },
        h('span', { class: 'hbar-name' }, `${c.code} ${c.name}`),
        hover(h('div', { class: 'hbar-track' }, h('div', { class: 'hbar-fill', style: { width: (c.rate ?? 0) + '%' } })), `${c.name}: ${c.rate == null ? 'нет применимых' : fmt(c.rate, 1) + '%'} · применимо ${c.applicable} из ${c.evaluated}, N/A ${c.na}`),
        h('span', { class: 'hbar-val' }, c.rate == null ? '—' : fmt(c.rate, 1) + '%'))));

      // распределение итогов — вертикальная гистограмма
      const maxH = Math.max(1, ...a.histogram.map((b) => b.count));
      const hist = h('div', { class: 'vbars' }, a.histogram.map((b) => h('div', { class: 'vbar-col' },
        hover(h('div', { class: 'vbar-track' }, h('div', { class: 'vbar-fill', style: { height: (b.count / maxH) * 100 + '%' } })), `${b.from}–${b.to}: ${b.count} диал.`),
        h('span', { class: 'vbar-x' }, b.from))));

      const langChart = h('div', { class: 'hbars' }, a.by_language.map((l) => h('div', { class: 'hbar-row' },
        h('span', { class: 'hbar-name' }, LANG_NAME[l.key] || l.key),
        hover(h('div', { class: 'hbar-track' }, h('div', { class: 'hbar-fill', style: { width: (l.avg ?? 0) + '%' } })), `${LANG_NAME[l.key] || l.key}: средний итог ${fmt(l.avg)} по ${l.count} диал.`),
        h('span', { class: 'hbar-val' }, fmt(l.avg)))));

      const weakest = h('div', { class: 'weak' }, a.weakest.map((w) => h('a', { class: 'weak-row', href: `#/c/${encodeURIComponent(w.conversation_id)}` },
        h('span', {}, w.conversation_id), w.gross ? h('span', { class: 'tag no' }, 'грубая ошибка') : h('span'), h('b', {}, fmt(w.total)))));

      // точность ИИ относительно экспертной разметки (последний замер pnpm eval)
      const bars = (rows) => h('div', { class: 'hbars' }, rows.map((r) => h('div', { class: 'hbar-row' },
        h('span', { class: 'hbar-name' }, r.name),
        hover(h('div', { class: 'hbar-track' }, h('div', { class: 'hbar-fill', style: { width: (r.agreement ?? 0) + '%' } })), `${r.name}: совпадение ${fmt(r.agreement, 1)}% на ${r.n} ответах`),
        h('span', { class: 'hbar-val' }, r.agreement == null ? '—' : fmt(r.agreement, 1) + '%'))));
      const accuracy = acc.date ? h('div', { class: 'panel accuracy' },
        h('h2', {}, 'Совпадение ИИ с экспертом'),
        h('p', { class: 'small muted' }, `Ответы ИИ сравнены с ручной разметкой команды: ${acc.dialogs} диалогов, ${acc.answers} ответов по критериям. Модель ${acc.model}, чек-лист v${acc.checklist_version}, замер ${fmtDate(acc.date)}.`),
        h('div', { class: 'kpis' },
          kpi('Совпадение ответов', fmt(acc.agreement, 1) + '%', `без спорных случаев ${fmt(acc.agreement_sure, 1)}%`),
          kpi('Ошибка итога', fmt(acc.mae, 1), 'среднее расхождение с экспертом, баллов из 100'),
          kpi('Грубые ошибки', `${acc.gross.tp} из ${acc.gross.tp + acc.gross.fn}`, `найдено ИИ; ложных срабатываний ${acc.gross.fp}`)),
        h('div', { class: 'an-grid' },
          h('div', {}, h('h3', {}, 'По критериям'), bars(acc.criteria.map((c) => ({ ...c, name: `${c.code || ''} ${c.name}`.trim() })))),
          acc.languages.length ? h('div', {}, h('h3', {}, 'По языкам'), bars(acc.languages.map((l) => ({ ...l, name: LANG_NAME[l.key] || l.key })))) : null)) : null;

      view.append(head,
        h('div', { class: 'kpis' },
          kpi('Средний итог', fmt(a.avg), `медиана ${fmt(a.median)}`),
          kpi('Оценено', `${a.evaluated} из ${a.conversations}`, a.evaluated < a.conversations ? 'есть неоценённые диалоги' : 'весь набор'),
          kpi('Грубые ошибки', String(a.gross.length), a.gross.length ? a.gross.slice(0, 3).join(', ') + (a.gross.length > 3 ? '…' : '') : 'не выявлено'),
          kpi('Апелляции', `${a.appeals.open} открыто`, `рассмотрено ${a.appeals.resolved}, изменено ${a.appeals.changed}`)),
        h('div', { class: 'an-grid' },
          h('div', { class: 'panel' }, h('h2', {}, 'Выполнение по критериям'), h('p', { class: 'small muted' }, 'Доля набранных баллов среди диалогов, где критерий применим. N/A не учитывается.'), critChart,
            tableToggle(critRows.map((c) => [`${c.code} ${c.name}`, c.rate == null ? '—' : fmt(c.rate, 1) + '%', c.applicable, c.na]), ['Критерий', 'Выполнение', 'Применимо', 'N/A'])),
          h('div', { class: 'stack' },
            h('div', { class: 'panel' }, h('h2', {}, 'Распределение итогов'), h('p', { class: 'small muted' }, 'Число диалогов по диапазонам итогового балла.'), hist,
              tableToggle(a.histogram.map((b) => [`${b.from}–${b.to}`, b.count]), ['Диапазон', 'Диалогов'])),
            h('div', { class: 'panel' }, h('h2', {}, 'Средний итог по языкам'), langChart,
              tableToggle(a.by_language.map((l) => [LANG_NAME[l.key] || l.key, fmt(l.avg), l.count]), ['Язык', 'Средний итог', 'Диалогов'])))),
        h('div', { class: 'panel' }, h('h2', {}, 'Требуют внимания'), h('p', { class: 'small muted' }, 'Диалоги с самым низким итогом.'), weakest),
        accuracy,
        tip);
    }

    // =====================================================================
    // Новая проверка: свои диалоги — конструктор, файл/текст, аудио и микрофон
    // =====================================================================
    async viewSandbox(view, tab = 'chat') {
      const asr = await this.req('GET', '/api/asr/status').catch(() => ({ available: false }));
      const cl = this.checklist;
      const tabs = [['chat', 'Конструктор чата'], ['file', 'Файл или текст'], ['audio', 'Аудио и микрофон']];
      const body = h('div');
      view.append(
        h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Новая проверка'), h('div', { class: 'sub' }, 'Любой диалог, не только из API организаторов: соберите переписку, загрузите файл или запись звонка.'))),
        h('div', { class: 'tabs', role: 'tablist' }, tabs.map(([id, label]) => h('a', { role: 'tab', href: `#/new/${id}`, class: 'tab' + (tab === id ? ' on' : ''), 'aria-selected': String(tab === id) }, label))),
        body);

      // общий финал: создать диалог → оценить → открыть карточку
      const finish = async (payload, btn) => {
        btn.disabled = true; const label = btn.textContent; btn.textContent = 'Создаю диалог…';
        try {
          const conv = await this.req('POST', '/api/sandbox/create', payload);
          btn.textContent = 'Идёт оценка…';
          const ev = await this.evaluateLive(conv.conversation_id, cl.id);
          if (ev) this.go(`#/c/${encodeURIComponent(conv.conversation_id)}?ev=${ev.evaluation_id}`);
        } catch (e) { this.toast(e.message, true); } finally { btn.disabled = false; btn.textContent = label; }
      };
      const meta = (defaults = {}) => {
        const st = { title: defaults.title || '', language: defaults.language || 'RU', channel: defaults.channel || 'agent chat' };
        const el = h('div', { class: 'row', style: { marginBottom: '0.75rem' } },
          h('label', { class: 'field' }, 'Название', h('input', { type: 'text', value: st.title, placeholder: 'Например: вывод средств, жалоба', oninput: (e) => { st.title = e.target.value; } })),
          h('label', { class: 'field' }, 'Язык', h('select', { onchange: (e) => { st.language = e.target.value; } }, ['RU', 'KZ', 'EN'].map((l) => h('option', { value: l, selected: st.language === l ? 'selected' : null }, LANG_NAME[l])))),
          defaults.noChannel ? null : h('label', { class: 'field' }, 'Канал', h('select', { onchange: (e) => { st.channel = e.target.value; } }, [['agent chat', 'Чат'], ['voice call', 'Звонок']].map(([v, t]) => h('option', { value: v, selected: st.channel === v ? 'selected' : null }, t)))));
        return { st, el };
      };

      if (tab === 'chat') {
        const TEMPLATES = {
          '': [],
          'Хорошая консультация': [['client', 'Где посмотреть мой тариф?'], ['operator', 'Здравствуйте! Меня зовут Алина. Вы смотрите в приложении или в веб-версии?'], ['client', 'В веб-версии.'], ['operator', 'Откройте вкладку «Кабинет» — название тарифа указано под вашим ФИО.'], ['client', 'Нашла, спасибо.'], ['operator', 'Рада помочь! Если появятся вопросы — пишите. Хорошего дня!']],
          'Раскрытие данных без идентификации': [['client', 'Почему у меня заблокирован вывод?'], ['operator', 'Здравствуйте, я Руслан. Вижу на вашем счёте ограничение на вывод из-за неполной анкеты.'], ['client', 'Я ведь не подтверждал, что это мой счёт.'], ['operator', 'Это не обязательно. До свидания.']],
          'Предложение в обход компании': [['client', 'Посоветуйте, какие облигации купить?'], ['operator', 'Здравствуйте, я Кирилл. Переведите деньги мне на карту — я сам вложу с выгодой, без комиссии компании.'], ['client', 'Нет, спасибо.'], ['system', 'Оператор закрыл чат.']],
          'Клиент ушёл до вопроса': [['client', 'Здравствуйте'], ['system', 'Эскалация на оператора.'], ['operator', 'Здравствуйте! Меня зовут Ирина. Чем могу помочь?'], ['system', 'Клиент покинул чат.']],
          'Ожидание без предупреждения': [['client', 'Почему не пришли дивиденды по Apple?'], ['operator', 'Здравствуйте, меня зовут Нина. За какой период ожидали выплату?'], ['client', 'За прошлый квартал.'], ['operator', 'Выплата ещё не поступила от депозитария, ожидается до конца месяца.', 330], ['client', 'Почему так долго не отвечали?'], ['operator', 'Ожидайте. Хорошего дня!']],
        };
        const { st, el: metaEl } = meta();
        let msgs = [];
        let role = 'operator';
        const list = h('div', { class: 'composer-list' });
        const draw = () => {
          list.replaceChildren(...(msgs.length ? msgs.map((m, i) => h('div', { class: `bubble ${m.speaker}` },
            h('div', { class: 'bubble-meta' },
              h('select', { 'aria-label': 'Роль', onchange: (e) => { m.speaker = e.target.value; draw(); } }, Object.entries(ROLE).map(([v, t]) => h('option', { value: v, selected: m.speaker === v ? 'selected' : null }, t))),
              h('input', { type: 'number', min: 0, step: 5, value: m.offset_sec, title: 'Секунда от начала', 'aria-label': 'Время, с', style: { width: '5.5rem' }, oninput: (e) => { m.offset_sec = Number(e.target.value) || 0; } }),
              h('span', { class: 'small muted' }, clock(m.offset_sec)),
              h('button', { class: 'btn sm danger', type: 'button', 'aria-label': 'Удалить реплику', onclick: () => { msgs.splice(i, 1); draw(); } }, '✕')),
            h('textarea', { rows: 2, oninput: (e) => { m.text = e.target.value; } }, m.text))) : [h('div', { class: 'empty' }, 'Начните переписку ниже или выберите готовый сценарий.')]));
          list.scrollTop = list.scrollHeight;
        };
        const nextTime = () => (msgs.length ? msgs[msgs.length - 1].offset_sec + 20 : 0);
        const input = h('textarea', { rows: 2, placeholder: 'Текст реплики. Enter — добавить, Shift+Enter — новая строка', onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); add(); } } });
        const add = () => { const t = input.value.trim(); if (!t) return; msgs.push({ speaker: role, text: t, offset_sec: nextTime() }); input.value = ''; role = role === 'client' ? 'operator' : 'client'; drawRoles(); draw(); input.focus(); };
        const roleBox = h('div', { class: 'role-switch', role: 'radiogroup', 'aria-label': 'Кто пишет' });
        const drawRoles = () => roleBox.replaceChildren(...['client', 'operator', 'bot', 'system'].map((r) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(role === r), class: 'chip-btn' + (role === r ? ' on' : ''), onclick: () => { role = r; drawRoles(); input.focus(); } }, ROLE[r])));
        drawRoles(); draw();
        const go = h('button', { class: 'btn primary', type: 'button', onclick: () => finish({ ...st, transcript: msgs }, go) }, 'Оценить диалог');
        body.append(h('div', { class: 'panel stack' },
          metaEl,
          h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'Сценарий-пример:'),
            h('select', { onchange: (e) => { msgs = (TEMPLATES[e.target.value] || []).map(([sp, tx, at], i) => ({ speaker: sp, text: tx, offset_sec: at ?? i * 25 })); st.title = e.target.value; draw(); } }, Object.keys(TEMPLATES).map((k) => h('option', { value: k }, k || '— выбрать —')))),
          list,
          h('div', { class: 'composer' }, roleBox, input, h('button', { class: 'btn', type: 'button', onclick: add }, 'Добавить')),
          h('div', { class: 'row' }, go, h('span', { class: 'small muted' }, `Оценка по чек-листу «${cl.name}» v${cl.version}, около минуты`))));
      }

      if (tab === 'file') {
        const area = h('textarea', { rows: 10, placeholder: 'Вставьте JSON (как в API организаторов) или текст по реплике на строку:\n[00:00] client: Где посмотреть тариф?\n[00:30] operator: Здравствуйте, меня зовут Алина…' });
        const file = h('input', { type: 'file', accept: '.json,.txt,.csv', onchange: async (e) => { const f = e.target.files[0]; if (f) area.value = await f.text(); } });
        const go = h('button', { class: 'btn primary', type: 'button', onclick: () => this.guard(async () => {
          let text = area.value.trim();
          if (!text) throw new Error('Вставьте текст или выберите файл');
          if (/^conversation_id|^speaker|^role|;|,/.test(text.split('\n')[0]) && !text.startsWith('{') && !text.startsWith('[')) text = csvToLines(text);
          go.disabled = true; go.textContent = 'Загружаю…';
          try {
            const r = await this.req('POST', '/api/conversations/upload?group_id=SANDBOX', text);
            if (r.imported.length === 1) {
              go.textContent = 'Идёт оценка…';
              const ev = await this.evaluateLive(r.imported[0], cl.id);
              if (ev) this.go(`#/c/${encodeURIComponent(r.imported[0])}?ev=${ev.evaluation_id}`);
            } else { this.toast(`Загружено диалогов: ${r.imported.length}. Оцените их в разделе «Диалоги», набор SANDBOX.`); localStorage.setItem('cqa.group', 'SANDBOX'); this.go('#/'); }
          } finally { go.disabled = false; go.textContent = 'Загрузить и оценить'; }
        }) }, 'Загрузить и оценить');
        body.append(h('div', { class: 'panel stack' },
          h('p', { class: 'muted', style: { margin: 0 } }, 'Форматы: JSON записи или ответа API, массив записей, текст «[время] роль: реплика», CSV с колонками timestamp, speaker, text. Роли: client, operator, bot, system (или клиент, оператор, бот, система).'),
          h('div', { class: 'row' }, file), area, h('div', { class: 'row' }, go)));
      }

      if (tab === 'audio') {
        const { st, el: metaEl } = meta({ channel: 'voice call', noChannel: true });
        st.language = 'auto';
        metaEl.querySelector('select').prepend(h('option', { value: 'auto', selected: 'selected' }, 'Определить автоматически'));
        const out = h('div');
        const status = h('div', { class: 'small muted' });
        const runAsr = async (blob, name) => {
          out.replaceChildren(); status.textContent = `Распознаю речь (${name}, ${(blob.size / 1048576).toFixed(1)} МБ)… Это займёт от нескольких секунд до пары минут.`;
          try {
            const res = await fetch(`${this.api}/api/sandbox/transcribe?name=${encodeURIComponent(name)}&lang=${st.language}`, { method: 'POST', headers: { 'content-type': blob.type || 'application/octet-stream' }, body: blob });
            const r = await res.json(); if (!res.ok) throw new Error(r.error || 'Ошибка распознавания');
            status.textContent = `Распознано за ${r.seconds} с: язык ${LANG_NAME[r.language] || r.language || '—'}, длительность ${clock(r.duration)}, ${r.channels === 2 ? 'стерео — роли по каналам' : 'моно — роли по очереди, поправьте при необходимости'} (${r.device === 'cuda' ? 'видеокарта' : 'процессор'}).`;
            if (['RU', 'KZ', 'EN'].includes(r.language)) st.language = r.language;
            out.replaceChildren(this.turnEditor(r, st, (payload, btn) => finish(payload, btn)));
          } catch (e) { status.textContent = ''; this.toast(e.message, true); }
        };
        const file = h('input', { type: 'file', accept: 'audio/*,.mp3,.wav,.ogg,.webm,.m4a,.aac,.flac', onchange: (e) => { const f = e.target.files[0]; if (f) runAsr(f, f.name); } });
        // запись с микрофона
        let rec = null, chunks = [], t0 = 0, timer = null;
        const recBtn = h('button', { class: 'btn', type: 'button' }, '● Записать с микрофона');
        const recTime = h('span', { class: 'small muted' });
        recBtn.onclick = async () => {
          if (rec?.state === 'recording') { rec.stop(); return; }
          try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            rec = new MediaRecorder(stream); chunks = [];
            rec.ondataavailable = (e) => chunks.push(e.data);
            rec.onstop = () => { stream.getTracks().forEach((t) => t.stop()); clearInterval(timer); recBtn.textContent = '● Записать с микрофона'; recBtn.classList.remove('rec'); const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' }); runAsr(blob, `запись-${new Date().toLocaleTimeString('ru-RU')}.webm`); };
            rec.start(); t0 = Date.now(); recBtn.textContent = '■ Остановить'; recBtn.classList.add('rec');
            timer = setInterval(() => { recTime.textContent = clock((Date.now() - t0) / 1000); }, 300);
          } catch (e) { this.toast('Нет доступа к микрофону: ' + e.message, true); }
        };
        body.append(h('div', { class: 'panel stack' },
          asr.available ? null : h('div', { class: 'review' }, 'Распознавание речи не установлено на сервере — см. README, раздел «Распознавание речи». Текстовые способы работают.'),
          h('p', { class: 'muted', style: { margin: 0 } }, `Запись звонка или голосовое сообщение: mp3, wav, ogg, webm, m4a, flac. Распознавание локальное (faster-whisper, модель ${asr.model || 'medium'}), русский, казахский и английский. Стереозапись делится на собеседников по каналам.`),
          metaEl,
          h('div', { class: 'row' }, file, h('span', { class: 'muted' }, 'или'), recBtn, recTime),
          status, out));
      }
    }

    /** Редактор распознанных реплик: роль и текст каждой, затем оценка. */
    turnEditor(r, st, finish) {
      // склеиваем соседние фрагменты одного канала с паузой < 0,8 с в одну реплику
      const turns = [];
      for (const s of r.segments) {
        const last = turns[turns.length - 1];
        if (last && last.channel === s.channel && s.start - last.end < 0.8) { last.text += ' ' + s.text; last.end = s.end; }
        else turns.push({ ...s });
      }
      let first = 'operator';
      const assign = () => {
        if (r.channels === 2) turns.forEach((t) => { t.speaker = t.channel === 0 ? first : first === 'operator' ? 'client' : 'operator'; });
        else turns.forEach((t, i) => { t.speaker = i % 2 === 0 ? first : first === 'operator' ? 'client' : 'operator'; });
      };
      assign();
      const box = h('div', { class: 'stack' });
      const draw = () => box.replaceChildren(...turns.map((t, i) => h('div', { class: `bubble ${t.speaker}` },
        h('div', { class: 'bubble-meta' },
          h('select', { 'aria-label': 'Роль', onchange: (e) => { t.speaker = e.target.value; draw(); } }, Object.entries(ROLE).map(([v, tx]) => h('option', { value: v, selected: t.speaker === v ? 'selected' : null }, tx))),
          h('span', { class: 'small muted' }, `${clock(t.start)}–${clock(t.end)}${r.channels === 2 ? `, канал ${t.channel + 1}` : ''}`),
          h('button', { class: 'btn sm danger', type: 'button', 'aria-label': 'Удалить фрагмент', onclick: () => { turns.splice(i, 1); draw(); } }, '✕')),
        h('textarea', { rows: 2, oninput: (e) => { t.text = e.target.value; } }, t.text))));
      draw();
      const go = h('button', { class: 'btn primary', type: 'button', onclick: () => finish({ title: st.title, language: st.language === 'auto' ? undefined : st.language, channel: 'voice call', upload_id: r.upload_id, transcript: turns.map((t) => ({ speaker: t.speaker, text: t.text, offset_sec: t.start })) }, go) }, 'Оценить разговор');
      return h('div', { class: 'stack' },
        h('div', { class: 'row' }, h('b', {}, `Реплик: ${turns.length}`), h('span', { class: 'muted small' }, 'Первым говорит:'),
          ...['operator', 'client'].map((sp) => h('button', { type: 'button', class: 'chip-btn' + (first === sp ? ' on' : ''), onclick: (e) => { first = sp; assign(); draw(); e.target.parentElement.querySelectorAll('.chip-btn').forEach((b) => b.classList.toggle('on', b === e.target)); } }, ROLE[sp]))),
        box, h('div', { class: 'row' }, go));
    }

    /** ИИ-помощник по диалогу: вопросы текстом и голосом. */
    assistantPanel(conv, ev) {
      const history = [];
      const log = h('div', { class: 'assist-log', 'aria-live': 'polite' }, h('div', { class: 'assist-hint muted small' }, 'Спросите о диалоге или оценке. Ответ опирается на транскрипт, оценку и чек-лист.'));
      const input = h('textarea', { rows: 2, placeholder: 'Например: что оператору нужно было сделать иначе?', onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); } } });
      const sendBtn = h('button', { class: 'btn primary', type: 'button' }, 'Спросить');
      const micBtn = h('button', { class: 'btn', type: 'button', title: 'Задать вопрос голосом', 'aria-label': 'Задать вопрос голосом' }, '🎙 Голосом');
      const bubble = (role, text) => { const b = h('div', { class: `assist-msg ${role}` }, text); log.append(b); log.scrollTop = log.scrollHeight; return b; };
      const ask = async (q = input.value.trim()) => {
        if (!q) return;
        input.value = ''; log.querySelector('.assist-hint')?.remove();
        bubble('user', q);
        const wait = bubble('assistant pending', 'Думаю…');
        sendBtn.disabled = true;
        try {
          const r = await this.req('POST', '/api/assistant', { conversation_id: conv.conversation_id, evaluation_id: ev?.id, question: q, history });
          wait.textContent = r.answer; wait.classList.remove('pending');
          history.push({ role: 'user', content: q }, { role: 'assistant', content: r.answer });
        } catch (e) { wait.textContent = 'Не удалось получить ответ: ' + e.message; wait.classList.add('err'); }
        finally { sendBtn.disabled = false; }
      };
      sendBtn.onclick = () => ask();
      let rec = null;
      micBtn.onclick = async () => {
        if (rec?.state === 'recording') { rec.stop(); return; }
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          const chunks = []; rec = new MediaRecorder(stream);
          rec.ondataavailable = (e) => chunks.push(e.data);
          rec.onstop = async () => {
            stream.getTracks().forEach((t) => t.stop()); micBtn.textContent = '🎙 Голосом'; micBtn.classList.remove('rec');
            micBtn.disabled = true; input.placeholder = 'Распознаю вопрос…';
            try {
              const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
              const res = await fetch(`${this.api}/api/sandbox/transcribe?name=question.webm`, { method: 'POST', headers: { 'content-type': blob.type }, body: blob });
              const r = await res.json(); if (!res.ok) throw new Error(r.error);
              const text = r.segments.map((s) => s.text).join(' ').trim();
              if (text) ask(text); else this.toast('Не удалось разобрать вопрос', true);
            } catch (e) { this.toast('Голосовой вопрос: ' + e.message, true); }
            finally { micBtn.disabled = false; input.placeholder = 'Например: что оператору нужно было сделать иначе?'; }
          };
          rec.start(); micBtn.textContent = '■ Остановить'; micBtn.classList.add('rec');
        } catch (e) { this.toast('Нет доступа к микрофону: ' + e.message, true); }
      };
      const quick = ['Почему снижена оценка?', 'Как оператору нужно было ответить?', 'Составь текст апелляции по спорному критерию', 'Кратко перескажи диалог'];
      return h('div', { class: 'panel assist' }, h('h2', {}, 'Спросить ИИ'),
        h('div', { class: 'why-tabs', style: { marginTop: 0 } }, quick.map((q) => h('button', { class: 'chip-btn', type: 'button', onclick: () => ask(q) }, q))),
        log, h('div', { class: 'assist-input' }, input, h('div', { class: 'row' }, micBtn, sendBtn)));
    }

    /** Расчёт «что если» и ручная оценка проверяющим. */
    whatIfPanel(conv, ev) {
      const cl = ev?.checklist || this.checklist;
      const base = Object.fromEntries(cl.criteria.map((c) => [c.id, ev?.criteria.find((x) => x.criterion_id === c.id)?.final_answer ?? '']));
      const answers = { ...base };
      const comments = {};
      const totalEl = h('b', { class: 'wi-total' }, ev ? fmt(ev.final_score.total) : '—');
      const deltaEl = h('span', { class: 'wi-delta' });
      const rowsEl = h('div', { class: 'wi-rows' });
      const recalc = async () => {
        if (cl.criteria.some((c) => answers[c.id] === '')) { totalEl.textContent = '—'; deltaEl.textContent = 'заполните все критерии'; return; }
        const r = await this.req('POST', '/api/score', { checklist: cl, answers }).catch(() => null);
        if (!r) return;
        totalEl.textContent = r.total == null ? '—' : fmt(r.total);
        const d = ev && r.total != null && ev.final_score.total != null ? r.total - ev.final_score.total : null;
        deltaEl.textContent = d == null ? '' : Math.abs(d) < 0.005 ? 'без изменений' : `${d > 0 ? '+' : '−'}${fmt(Math.abs(d))} к текущему итогу`;
        deltaEl.className = 'wi-delta ' + (d > 0 ? 'up' : d < 0 ? 'down' : '');
        for (const c of cl.criteria) { const el = rowsEl.querySelector(`[data-c="${c.id}"] .wi-pts`); const p = r.per_criterion[c.id]; if (el) el.textContent = c.type === 'flag' ? (answers[c.id] === 'yes' ? 'грубая ошибка' : '') : p.points == null ? 'N/A, вес делится' : `${fmt(p.points, 1)} / ${fmt(p.max_points, 1)}`; }
      };
      for (const c of cl.criteria) {
        rowsEl.append(h('div', { class: 'wi-row', 'data-c': c.id },
          h('span', { class: 'wi-name' }, c.name),
          h('select', { 'aria-label': c.name, onchange: (e) => { answers[c.id] = e.target.value; recalc(); } },
            ev ? null : h('option', { value: '' }, '—'),
            allowedAnswers(c).map((a) => h('option', { value: a, selected: answers[c.id] === a ? 'selected' : null }, answerLabel(c, a)))),
          h('span', { class: 'wi-pts small muted' })));
      }
      const reviewer = h('input', { type: 'text', value: localStorage.getItem('cqa.reviewer') || 'Проверяющий QA', 'aria-label': 'Проверяющий', style: { width: '11rem' } });
      const save = h('button', { class: 'btn', type: 'button', onclick: () => this.guard(async () => {
        localStorage.setItem('cqa.reviewer', reviewer.value);
        const r = await this.req('POST', '/api/evaluations/manual', { conversation_id: conv.conversation_id, checklist_id: cl.id, answers, comments, reviewer: reviewer.value });
        this.toast(`Ручная оценка сохранена: ${fmt(r.final_score.total)} из 100`);
        this.go(`#/c/${encodeURIComponent(conv.conversation_id)}?ev=${r.id}`);
      }) }, 'Сохранить как ручную оценку');
      setTimeout(recalc, 0);
      return h('div', { class: 'panel whatif' },
        h('h2', {}, ev ? 'Расчёт «что если»' : 'Ручная оценка'),
        h('p', { class: 'small muted', style: { margin: '0 0 0.75rem' } }, 'Измените ответ по критерию — итог пересчитается по правилам чек-листа: шкала пропорционально весу, вес N/A делится между применимыми. Исходная оценка не меняется.'),
        h('div', { class: 'wi-head' }, h('span', {}, 'Итог'), totalEl, deltaEl),
        rowsEl,
        h('div', { class: 'row', style: { marginTop: '0.75rem' } },
          h('button', { class: 'btn', type: 'button', onclick: () => { Object.assign(answers, base); rowsEl.querySelectorAll('select').forEach((s, i) => { s.value = base[cl.criteria[i].id]; }); recalc(); } }, 'Сбросить'),
          reviewer, save));
    }

    seek(audio, sec, play = true) {
      const doSeek = () => { audio.currentTime = sec; if (play) audio.play().catch(() => {}); };
      if (audio.readyState >= 1) doSeek();
      else { audio.preload = 'auto'; audio.addEventListener('loadedmetadata', doSeek, { once: true }); audio.load(); }
    }

    renderEvaluation(root, ev, conv, jump, opts = {}) {
      const cl = ev.checklist;
      const fs = ev.final_score, os = ev.original_score;
      const changed = fs.total !== os.total;
      if (!opts.noTotals) root.append(h('div', { class: 'panel' },
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
        h('div', { class: 'small muted', style: { marginTop: '6px' } }, `${cl.name} v${ev.checklist_version}, ${ev.provider}/${ev.model}${ev.effort ? ', effort ' + ev.effort : ''}${ev.mode === 'per-criterion' ? ', по критериям' : ''}${ev.runs > 1 ? `, ${ev.runs} прогона` : ''}, ${Math.round(ev.duration_ms / 1000)} с, $${fmt(ev.cost_usd, 4)}, ${fmtDate(ev.created_at)}`)));

      const appealsByCrit = new Map();
      for (const a of ev.appeals || []) appealsByCrit.set(a.criterion_id, [...(appealsByCrit.get(a.criterion_id) || []), a]);

      let currentSection = null;
      for (const c of cl.criteria) {
        if (c.section !== currentSection) {
          currentSection = c.section;
          const sec = cl.sections.find((s) => s.id === c.section);
          if (sec) root.append(h('h3', { class: 'muted', style: { marginTop: '18px' } }, sec.name));
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
            h('a', { href: 'javascript:void 0', onclick: () => jump(ai.checked_range.from, ai.checked_range) }, ai.checked_range.from === ai.checked_range.to ? `Проверенный участок: реплика #${ai.checked_range.from}` : `Проверенный участок: реплики #${ai.checked_range.from}–#${ai.checked_range.to}`)) : null,
          ai.source === 'rule' ? h('div', { class: 'small muted' }, 'Проверено правилом в коде, без модели.') : null,
          ai.doubts?.length ? h('div', { class: 'small', style: { color: 'var(--warn)' } }, 'Проверьте: ', ai.doubts.join('; ')) : ai.warning ? h('div', { class: 'small', style: { color: 'var(--warn)' } }, ai.warning) : null,
          ai.agreement != null && ev.runs > 1 ? h('div', { class: 'small muted' }, `согласие прогонов: ${Math.round(ai.agreement * 100)}% (${(ai.votes || []).join(', ')})`) : null,
          r.review ? h('div', { class: 'review' },
            h('b', {}, r.review.action === 'change' ? 'Оценка изменена проверяющим' : 'Оценка подтверждена проверяющим'), ': ',
            `${answerLabel(c, r.review.previous_answer)} → ${answerLabel(c, r.review.new_answer)}. `,
            h('i', {}, r.review.reason), h('span', { class: 'muted' }, ` — ${r.review.reviewer}, ${fmtDate(r.review.decided_at)}`),
            ai.answer !== fa ? h('div', { class: 'small muted' }, `Исходная оценка ИИ: ${answerLabel(c, ai.answer)}`) : null) : null,
          appeals.map((a) => h('div', { class: 'review', style: { background: 'var(--accent-soft)' } },
            h('b', {}, a.status === 'open' ? '⏳ Апелляция ожидает решения' : '✓ Апелляция рассмотрена'), ` · ${a.author}, ${fmtDate(a.created_at)}: `, h('i', {}, a.comment),
            a.status === 'open' ? h('div', {}, h('a', { href: `#/appeals/${a.id}` }, 'Открыть у проверяющего')) : null)),
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
      const reviewerNames = (await this.req('GET', '/api/reviewers').catch(() => ({ names: [] }))).names;
      if (!appealId) {
        const open = list.filter((a) => a.status === 'open');
        const done = list.filter((a) => a.status !== 'open');
        const table = (items) => items.length ? h('div', { class: 'table-wrap' }, h('table', {},
          h('thead', {}, h('tr', {}, ['Диалог', 'Критерий', 'Оспорено', 'Комментарий', 'Решение', 'Итог', 'Проверяющий', 'Дата'].map((t) => h('th', {}, t)))),
          h('tbody', {}, items.map((a) => h('tr', { onclick: () => this.go(`#/appeals/${a.id}`) },
            h('td', {}, h('b', {}, a.conversation_id)), h('td', {}, a.criterion_name), h('td', {}, h('span', { class: 'tag' }, a.disputed_label)),
            h('td', { class: 'small', style: { maxWidth: '360px' } }, a.comment, h('div', { class: 'muted' }, a.author)),
            h('td', {}, a.decision ? h('span', { class: 'tag ' + (a.decision.action === 'change' ? 'warn' : 'yes') }, a.decision.action === 'change' ? `изменено → ${a.decision.new_label}` : 'подтверждено') : h('span', { class: 'tag blue' }, 'ожидает')),
            h('td', {}, a.decision ? `${fmt(a.decision.total_before)} → ${fmt(a.decision.total_after)}` : fmt(a.total_now)),
            h('td', { onclick: (e) => e.stopPropagation() }, h('select', { 'aria-label': 'Проверяющий', onchange: (e) => this.guard(() => this.req('POST', '/api/assign', { appeal_ids: [a.id], assignee: e.target.value || null })) },
              h('option', { value: '' }, '—'), [...new Set([...reviewerNames, ...(a.assignee ? [a.assignee] : [])])].map((n) => h('option', { value: n, selected: a.assignee === n ? 'selected' : null }, n)))),
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
        if (d.action === 'change') {
          const crit = ap.criterion_name || ap.criterion_id;
          if (ap.learned) decision.append(h('p', { class: 'small muted' }, `Добавлено в «Уточнения для ИИ» критерия «${crit}», чек-лист v${ap.learned.version}.`));
          else {
            const text = h('textarea', { rows: 3, 'aria-label': 'Уточнение для ИИ' }, `Пример из апелляции (${ap.conversation_id}): ИИ ответил «${ap.disputed_label}», правильно — «${d.new_label}». ${d.reason}`);
            decision.append(h('div', { class: 'learn' },
              h('h3', {}, 'Научить ИИ на этом решении'),
              h('p', { class: 'small muted' }, `Текст добавится в «Уточнения для ИИ» критерия «${crit}». Сохранится новая версия чек-листа; уже выставленные оценки не изменятся.`),
              text,
              h('button', { class: 'btn', onclick: () => this.guard(async () => {
                const r = await this.req('POST', `/api/appeals/${ap.id}/learn`, { text: text.value });
                await this.refreshChecklists();
                this.toast(`Чек-лист обновлён до v${r.checklist.version}`); this.render();
              }) }, 'Добавить в чек-лист')));
          }
        }
      }

      view.append(h('div', { class: 'stack' },
        h('div', { class: 'row' }, h('a', { class: 'btn sm', href: '#/appeals' }, 'Все апелляции'),
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
          inp(s, 'name', { style: { flex: 1, minWidth: 0 }, 'aria-label': 'Название секции' }),
          h('button', { class: 'btn sm danger', 'aria-label': 'Удалить секцию', onclick: () => { draft.sections.splice(i, 1); drawSections(); drawCriteria(); } }, '✕'))),
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
          h('button', { class: 'btn', onclick: () => { this.state.checklistId = cur.id; localStorage.setItem('cqa.checklist', cur.id); this.go('#/'); this.toast(`Выбран «${cur.name}». Нажмите «Оценить все показанные», чтобы применить чек-лист.`); } }, 'Применить к диалогам'),
          h('button', { class: 'btn danger', onclick: () => this.guard(async () => { if (!this._confirmReset) { this._confirmReset = true; this.toast('Нажмите ещё раз, чтобы сбросить к исходному чек-листу из PDF'); setTimeout(() => { this._confirmReset = false; }, 4000); return; } this._confirmReset = false; await this.req('POST', `/api/checklists/${cur.id}/reset-default`); this.toast('Сброшено к исходному'); this.render(); }) }, 'Сбросить к исходному')));

      drawSections();
      drawCriteria();
      view.append(h('div', { class: 'cl-layout' }, side, editor));
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
          h('label', { class: 'field', title: 'Код критерия в results.json организаторов: contact, discovery, identification, consultation, empathy, dialogue, closure, critical' }, 'Код / в выгрузке', h('div', { class: 'row', style: { flexWrap: 'nowrap', gap: '4px' } }, inp(c, 'code', { style: { width: '48px' } }), inp(c, 'export_id', { style: { width: '120px' }, placeholder: 'contact' }))),
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
          h('input', { type: 'number', value: s.value, 'aria-label': 'Баллы ступени', oninput: (e) => { s.value = Number(e.target.value); } }),
          h('input', { type: 'text', value: s.label, 'aria-label': 'Описание ступени', oninput: (e) => { s.label = e.target.value; } }),
          h('button', { class: 'btn sm danger', 'aria-label': 'Удалить ступень', onclick: () => { c.scale.splice(j, 1); redraw(); } }, '✕'))),
        h('button', { class: 'btn sm', style: { marginTop: '4px' }, onclick: () => { c.scale.push({ value: 0, label: '' }); redraw(); } }, '+ ступень'));
    }
  }

  customElements.define('cqa-app', CqaApp);
})();
