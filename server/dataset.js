import fs from 'node:fs';
import path from 'node:path';
// Загрузка наборов через API организаторов, импорт файлов и нормализация транскриптов.
import { db } from './db.js';

// Адрес API организаторов содержит подпись доступа (sig) — хранится только в .env, не в коде.
export const DATASET_API = process.env.CQA_DATASET_API_URL || '';

const ROLES = new Set(['client', 'operator', 'bot', 'system']);
const ROLE_ALIASES = {
  клиент: 'client', customer: 'client', user: 'client', клиенту: 'client',
  оператор: 'operator', agent: 'operator', агент: 'operator', support: 'operator',
  бот: 'bot', assistant: 'bot', система: 'system', event: 'system',
};

function normRole(s) {
  const r = String(s || '').trim().toLowerCase();
  if (ROLES.has(r)) return r;
  return ROLE_ALIASES[r] || 'system';
}

/** Секунды от начала диалога для MM:SS / HH:MM:SS / ISO 8601. */
export function parseTs(ts) {
  if (ts == null) return null;
  const s = String(ts).trim();
  const m = s.match(/^(\d{1,3}):(\d{2})(?::(\d{2}))?$/);
  if (m) return m[3] != null ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : (+m[1]) * 60 + (+m[2]);
  const t = Date.parse(s);
  return Number.isFinite(t) ? t / 1000 : null;
}

export function normalizeRecord(r, groupId = 'UPLOAD') {
  if (!r || !Array.isArray(r.transcript)) throw new Error('Запись должна содержать массив transcript');
  const transcript = r.transcript.map((m, i) => ({
    idx: i + 1,
    timestamp: m.timestamp ?? m.time ?? '',
    speaker: normRole(m.speaker ?? m.role),
    text: String(m.text ?? m.message ?? ''),
  }));
  const abs = transcript.map((m) => parseTs(m.timestamp));
  // time_origin = 'zero': метки уже отсчитаны от начала записи (загруженное аудио) — не сдвигаем
  const t0 = r.time_origin === 'zero' ? 0 : abs.find((x) => x != null) ?? 0;
  transcript.forEach((m, i) => { m.offset_sec = abs[i] == null ? null : Math.max(0, Math.round((abs[i] - t0) * 10) / 10); });
  const channel = r.channel || (r.audio_url ? 'voice call' : 'agent chat');
  return {
    ...(r.title ? { title: String(r.title).slice(0, 120) } : {}),
    ...(r.source ? { source: r.source } : {}),
    conversation_id: String(r.conversation_id || r.id || `upload-${Date.now().toString(36)}`),
    group_id: r.dataset_group_id || groupId,
    channel,
    language: String(r.language || detectLanguage(transcript)).toUpperCase(),
    audio_url: r.audio_url || null,
    transcript,
    imported_at: new Date().toISOString(),
  };
}

/** Грубое определение языка, если поле language не передано. */
export function detectLanguage(transcript) {
  const text = transcript.filter((m) => m.speaker === 'client').map((m) => m.text).join(' ') || transcript.map((m) => m.text).join(' ');
  if (/[әғқңөұүһі]/i.test(text)) return 'KZ';
  if (/[а-яё]/i.test(text)) return 'RU';
  return 'EN';
}

/** Текстовый транскрипт: строки вида "[00:12] operator: текст" или "operator: текст". */
export function parsePlainText(text, meta = {}) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const transcript = [];
  for (const line of lines) {
    const m = line.match(/^(?:\[?([\dT:.\-+Z ]{4,40}?)\]?\s+)?([A-Za-zА-Яа-яЁёӘәҒғҚқҢңӨөҰұҮүҺһІі]+)\s*:\s*(.*)$/);
    if (m && (ROLES.has(m[2].toLowerCase()) || ROLE_ALIASES[m[2].toLowerCase()])) {
      transcript.push({ timestamp: m[1] || '', speaker: m[2], text: m[3] });
    } else if (transcript.length) {
      transcript[transcript.length - 1].text += '\n' + line;
    }
  }
  if (!transcript.length) throw new Error('Не удалось разобрать текст. Формат строки: "[MM:SS] operator: текст"');
  return { ...meta, transcript };
}

/** Принимает ответ API, массив записей, одну запись или текст. */
export function extractRecords(payload) {
  if (typeof payload === 'string') return [parsePlainText(payload)];
  if (Array.isArray(payload)) return payload;
  if (payload?.data?.records) return payload.data.records;
  if (payload?.records) return payload.records;
  if (payload?.transcript) return [payload];
  throw new Error('Неизвестный формат: ожидается ответ API, массив записей или запись с transcript');
}

export function importRecords(records, groupId) {
  const out = [];
  for (const r of records) {
    const conv = normalizeRecord(r, groupId);
    db.upsert('conversations', conv, 'conversation_id');
    out.push(conv.conversation_id);
  }
  return out;
}

export async function fetchGroup(groupId) {
  if (!DATASET_API) throw new Error('Не задан адрес API организаторов: укажите CQA_DATASET_API_URL в .env (ссылка «GET для DEV» из гайда, без group_id)');
  const url = new URL(DATASET_API);
  url.searchParams.set('group_id', groupId);
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`API организаторов вернул HTTP ${res.status}`);
  const body = await res.json();
  if (body.isSuccess === false) throw new Error(`API: ${body.error || 'isSuccess=false'}`);
  const records = extractRecords(body);
  const ids = importRecords(records, body?.data?.dataset_group_id || groupId);
  return { group_id: groupId, total: records.length, imported: ids };
}

// audio_url указывает на HTML-страницу с плеером; внутри — подписанная ссылка на mp3 (живёт ~1 ч).
// Достаём её при каждом запросе, чтобы встроенный плеер мог перематывать к реплике.
const audioCache = new Map();
/** Локальный файл загруженной записи: audio_url вида «upload:<id>». */
export function localUpload(audioUrl) {
  const m = /^upload:([\w.-]+)$/.exec(audioUrl || '');
  if (!m) return null;
  const dir = path.join(process.env.CQA_STORAGE_DIR || path.resolve('storage'), 'uploads');
  if (!fs.existsSync(dir)) return null;
  const f = fs.readdirSync(dir, { withFileTypes: true }).find((d) => d.name.startsWith(m[1] + '.'));
  return f ? path.join(dir, f.name) : null;
}

export async function resolveAudio(audioUrl) {
  if (audioUrl?.startsWith('upload:')) return `/api/uploads/${audioUrl.slice(7)}`;
  const hit = audioCache.get(audioUrl);
  if (hit && hit.expires > Date.now()) return hit.src;
  const res = await fetch(audioUrl, { signal: AbortSignal.timeout(30_000) });
  const ct = res.headers.get('content-type') || '';
  if (ct.startsWith('audio/')) return audioUrl;
  const html = await res.text();
  const m = html.match(/<source[^>]+src="([^"]+)"/i) || html.match(/<audio[^>]+src="([^"]+)"/i);
  if (!m) throw new Error('В странице записи не найден источник аудио');
  const src = m[1].replace(/&amp;/g, '&');
  audioCache.set(audioUrl, { src, expires: Date.now() + 40 * 60_000 });
  return src;
}
