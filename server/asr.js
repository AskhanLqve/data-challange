// Распознавание речи (faster-whisper, локально) для песочницы и голосовых вопросов ИИ-помощнику.
// Python-окружение с faster-whisper: CQA_ASR_PYTHON (по умолчанию ~/tools/whisper-venv/bin/python).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PY = process.env.CQA_ASR_PYTHON || path.join(os.homedir(), 'tools/whisper-venv/bin/python');
const SCRIPT = path.resolve('scripts/asr.py');
export const ASR_MODEL = process.env.CQA_ASR_MODEL || 'medium';

/** Библиотеки CUDA из pip-пакетов nvidia-* внутри окружения (системный CUDA не нужен). */
function cudaLibPath() {
  const lib = path.join(path.dirname(path.dirname(PY)), 'lib');
  const dirs = [];
  try {
    for (const py of fs.readdirSync(lib)) {
      const nv = path.join(lib, py, 'site-packages', 'nvidia');
      if (!fs.existsSync(nv)) continue;
      for (const pkg of fs.readdirSync(nv)) { const d = path.join(nv, pkg, 'lib'); if (fs.existsSync(d)) dirs.push(d); }
    }
  } catch { /* окружения нет */ }
  return dirs.join(':');
}

export function asrAvailable() {
  return fs.existsSync(PY) && fs.existsSync(SCRIPT);
}

/** Распознаёт файл. lang: auto | ru | kk | en. Возвращает { language, duration, channels, device, segments }. */
export function transcribeFile(file, { lang = 'auto', timeoutMs = 15 * 60_000 } = {}) {
  if (!asrAvailable()) return Promise.reject(new Error(`Распознавание речи не установлено: нет ${PY}. См. README, раздел «Распознавание речи».`));
  return new Promise((resolve, reject) => {
    const env = { ...process.env, LD_LIBRARY_PATH: [cudaLibPath(), process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') };
    const p = spawn(PY, [SCRIPT, file, '--model', ASR_MODEL, '--lang', lang], { env });
    let out = '', err = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('Распознавание заняло слишком много времени')); }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => {
      clearTimeout(timer);
      try {
        const j = JSON.parse(out.trim().split('\n').pop() || '{}');
        if (j.error) return reject(new Error(j.error));
        if (code !== 0 || !j.segments) return reject(new Error(`Ошибка распознавания: ${err.trim().split('\n').slice(-3).join(' ') || 'код ' + code}`));
        resolve(j);
      } catch { reject(new Error(`Ошибка распознавания: ${err.trim().split('\n').slice(-3).join(' ') || out.slice(0, 200)}`)); }
    });
  });
}
