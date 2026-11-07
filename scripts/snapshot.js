// Снимки хранилища для демонстрации: сохранить состояние до показа и вернуть его после.
//
//   pnpm snapshot [имя]          # сохранить storage/ в snapshots/<имя> (по умолчанию — дата и время)
//   pnpm restore  [имя]          # вернуть снимок (по умолчанию — последний); сервер должен быть остановлен
//   pnpm restore --list          # список снимков
//
// Перед восстановлением текущее состояние само сохраняется снимком «before-restore-…», поэтому ничего не теряется.
// Восстановление при запущенном сервере запрещено: сервер держит данные в памяти и перезаписал бы файлы.
import fs from 'node:fs';
import path from 'node:path';

const STORAGE = process.env.CQA_STORAGE_DIR || path.resolve('storage');
const SNAPS = path.resolve('snapshots');
const API = (process.env.CQA_API || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
const [cmd, ...rest] = process.argv.slice(2);
const name = rest.find((a) => !a.startsWith('--'));

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const safe = (n) => { if (!/^[\w.-]{1,64}$/.test(n)) { console.error(`Недопустимое имя снимка: «${n}» (буквы, цифры, . _ -)`); process.exit(2); } return n; };
const list = () => (fs.existsSync(SNAPS) ? fs.readdirSync(SNAPS).filter((d) => fs.statSync(path.join(SNAPS, d)).isDirectory()).sort() : []);
const size = (dir) => fs.readdirSync(dir, { recursive: true }).reduce((s, f) => { const p = path.join(dir, f); return s + (fs.statSync(p).isFile() ? fs.statSync(p).size : 0); }, 0);
const mb = (b) => `${(b / 1048576).toFixed(1)} МБ`;

function save(n) {
  if (!fs.existsSync(STORAGE)) { console.error(`Хранилище не найдено: ${STORAGE}`); process.exit(1); }
  const dest = path.join(SNAPS, safe(n));
  if (fs.existsSync(dest)) { console.error(`Снимок «${n}» уже есть. Выберите другое имя.`); process.exit(1); }
  fs.mkdirSync(SNAPS, { recursive: true });
  fs.cpSync(STORAGE, dest, { recursive: true });
  console.log(`Снимок «${n}» сохранён: ${mb(size(dest))} → snapshots/${n}`);
  return n;
}

async function serverRunning() {
  try { await fetch(API + '/api/health', { signal: AbortSignal.timeout(1500) }); return true; } catch { return false; }
}

if (cmd === 'save') {
  save(name || stamp());
} else if (cmd === 'restore') {
  const snaps = list();
  if (rest.includes('--list')) { console.log(snaps.length ? snaps.map((s) => `  ${s}  ${mb(size(path.join(SNAPS, s)))}`).join('\n') : 'Снимков нет: pnpm snapshot [имя]'); process.exit(0); }
  const target = name ? safe(name) : snaps.filter((s) => !s.startsWith('before-restore-')).pop();
  if (!target || !snaps.includes(target)) { console.error(name ? `Снимок «${name}» не найден. Список: pnpm restore --list` : 'Снимков нет: сначала pnpm snapshot'); process.exit(1); }
  if (await serverRunning()) { console.error(`Сервер работает на ${API}. Остановите его (Ctrl+C в окне pnpm start), затем повторите pnpm restore.`); process.exit(1); }
  const backup = fs.existsSync(STORAGE) ? save(`before-restore-${stamp()}`) : null;
  const tmp = STORAGE + '.restoring';
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.cpSync(path.join(SNAPS, target), tmp, { recursive: true }); // сначала копия рядом, потом подмена — без полупустого хранилища
  if (fs.existsSync(STORAGE)) fs.rmSync(STORAGE, { recursive: true, force: true });
  fs.renameSync(tmp, STORAGE);
  console.log(`Восстановлен снимок «${target}».${backup ? ` Предыдущее состояние сохранено как «${backup}».` : ''} Запустите pnpm start.`);
} else {
  console.error('Использование: pnpm snapshot [имя] · pnpm restore [имя] · pnpm restore --list');
  process.exit(2);
}
