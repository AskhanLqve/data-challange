// Простое файловое хранилище: одна JSON-коллекция на файл в ./storage.
// Запись атомарная (tmp + rename) и последовательная — без внешних зависимостей.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DIR = process.env.CQA_STORAGE_DIR || path.resolve('storage');
fs.mkdirSync(DIR, { recursive: true });

const cache = new Map();
const writing = new Map();

function file(name) { return path.join(DIR, `${name}.json`); }

function load(name) {
  if (!cache.has(name)) {
    let data = [];
    try { data = JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { /* пусто */ }
    cache.set(name, data);
  }
  return cache.get(name);
}

function persist(name) {
  const prev = writing.get(name) || Promise.resolve();
  const next = prev.then(async () => {
    const tmp = file(name) + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify(cache.get(name), null, 1));
    await fs.promises.rename(tmp, file(name));
  }).catch((e) => console.error('[db] write failed', name, e));
  writing.set(name, next);
  return next;
}

export const newId = (prefix) => `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;

export const db = {
  all(name) { return load(name); },
  get(name, id, key = 'id') { return load(name).find((x) => x[key] === id) || null; },
  filter(name, fn) { return load(name).filter(fn); },
  insert(name, doc) { load(name).push(doc); persist(name); return doc; },
  upsert(name, doc, key = 'id') {
    const list = load(name);
    const i = list.findIndex((x) => x[key] === doc[key]);
    if (i >= 0) list[i] = doc; else list.push(doc);
    persist(name);
    return doc;
  },
  update(name, id, patch) {
    const doc = this.get(name, id);
    if (!doc) return null;
    Object.assign(doc, typeof patch === 'function' ? patch(doc) : patch);
    persist(name);
    return doc;
  },
  remove(name, id) {
    const list = load(name);
    const i = list.findIndex((x) => x.id === id);
    if (i >= 0) { list.splice(i, 1); persist(name); return true; }
    return false;
  },
  flush() { return Promise.all([...writing.values()]); },
};
