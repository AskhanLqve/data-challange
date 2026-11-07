import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conversationMetrics } from '../server/metrics.js';

const call = (...msgs) => ({ channel: 'voice call', transcript: msgs.map(([speaker, offset_sec, text], i) => ({ idx: i + 1, speaker, offset_sec, text })) });

test('метрики звонка: пауза, перебивание, ожидание в очереди не считается паузой', () => {
  const m = conversationMetrics(call(
    ['client', 0, 'Здравствуйте'],
    ['bot', 2, 'Ожидайте оператора'],
    ['operator', 60, 'Добрый день, меня зовут Анна'], // после бота — очередь, не пауза оператора
    ['client', 64, 'У меня не проходит вывод денег на карту уже третий день подряд'],
    ['operator', 66, 'Секунду, проверю'], // клиент не мог договорить 12 слов за 2 с — перебивание
    ['client', 80, 'Хорошо'],
    ['operator', 95, 'Вижу ограничение'], // ответ через ~14 с — долгая пауза
  ));
  assert.equal(m.interruptions, 1);
  assert.deepEqual(m.long_pauses.map((p) => p.before), [7]);
  assert.deepEqual(m.hold_announcements, [5]);
  assert.ok(m.operator_share > 0 && m.operator_share < 100);
});

test('метрики: без таймингов — null', () => {
  assert.equal(conversationMetrics({ channel: 'agent chat', transcript: [{ idx: 1, speaker: 'client', text: 'a' }] }), null);
});
