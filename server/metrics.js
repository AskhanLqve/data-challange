// Метрики разговора по таймингам расшифровки — без модели, воспроизводимо.
// У реплики есть только время начала, поэтому длительность речи оценивается: до следующей реплики,
// но не дольше, чем нужно, чтобы произнести её текст (≈ 2.5 слова в секунду + 1 с).
// shortcut: оценка по таймингам ASR, а не по звуковой дорожке; если появятся тайминги слов — считать по ним.

const WORDS_PER_SEC = 2.5;
const HOLD = /(подожд|ожида|минут|секунд|проверю|уточню|күте тұрыңыз|сәл күт|one moment|hold on|let me check)/i;
const words = (t) => String(t || '').split(/\s+/).filter(Boolean).length;

export function conversationMetrics(conv) {
  const t = conv.transcript.filter((m) => m.offset_sec != null);
  if (t.length < 2) return null;
  const isCall = conv.channel === 'voice call';
  const speech = (m, i) => {
    const next = t.slice(i + 1).find((x) => x.offset_sec > m.offset_sec);
    const need = words(m.text) / WORDS_PER_SEC + 1;
    return next ? Math.min(next.offset_sec - m.offset_sec, need) : need;
  };
  const talk = { operator: 0, client: 0 };
  const responses = []; const pauses = []; let interruptions = 0;
  t.forEach((m, i) => {
    const d = speech(m, i);
    if (m.speaker === 'operator' || m.speaker === 'client') talk[m.speaker] += d;
    if (m.speaker !== 'operator') return;
    const prev = t[i - 1];
    // только прямой ответ на реплику клиента; бот или системное событие между ними — это очередь, а не пауза оператора
    if (prev?.speaker !== 'client') return;
    const need = words(prev.text) / WORDS_PER_SEC + 1;
    // перебивание: оператор заговорил раньше, чем клиент мог произнести свою реплику
    if (isCall && m.offset_sec - prev.offset_sec < need - 1.5) interruptions++;
    const w = Math.max(0, m.offset_sec - (prev.offset_sec + (isCall ? speech(prev, i - 1) : 0)));
    responses.push(w);
    if (w >= (isCall ? 10 : 90)) pauses.push({ after: prev.idx, before: m.idx, sec: Math.round(w) });
  });
  const total = talk.operator + talk.client;
  const avg = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  return {
    channel: conv.channel,
    duration_sec: Math.round(t.at(-1).offset_sec - t[0].offset_sec),
    operator_share: total ? Math.round((talk.operator / total) * 100) : null,
    response_avg_sec: avg(responses),
    response_max_sec: responses.length ? Math.round(Math.max(...responses)) : null,
    long_pauses: pauses,
    interruptions: isCall ? interruptions : null,
    hold_announcements: conv.transcript.filter((m) => m.speaker === 'operator' && HOLD.test(m.text)).map((m) => m.idx),
  };
}

