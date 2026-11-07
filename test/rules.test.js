import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ruleFor } from '../server/rules.js';

const conv = (language, ...msgs) => ({ language, transcript: msgs.map(([speaker, text], i) => ({ idx: i + 1, speaker, text })) });
const contact = { id: 'c01', export_id: 'contact' };
const closure = { id: 'c07', export_id: 'closure', na_allowed: true };

test('контакт: приветствие и имя в первом сообщении оператора', () => {
  assert.equal(ruleFor(conv('RU', ['client', 'Вопрос'], ['operator', 'Здравствуйте. Я Илья. Ответ.']), contact).answer, 'yes');
  assert.equal(ruleFor(conv('KZ', ['operator', 'Сәлеметсіз бе, мен Дидармын.']), contact).answer, 'yes');
  assert.equal(ruleFor(conv('EN', ['operator', "Hi, I'm Noah."]), contact).answer, 'yes');
  assert.equal(ruleFor(conv('RU', ['operator', 'Привет, где именно ищете?']), contact).answer, 'no');
  assert.equal(ruleFor(conv('RU', ['operator', 'Здравствуйте!'], ['operator', 'Меня зовут Анна.']), contact).answer, 'no');
  assert.equal(ruleFor(conv('RU', ['operator', 'Hello, I am Anna.']), contact).answer, 'no'); // чужой язык
});

test('завершение: прощание найдено кодом, итог решает модель без N/A', () => {
  const r = ruleFor(conv('RU', ['operator', 'Передам вопрос. До свидания.']), closure);
  assert.equal(r.answer, undefined);
  assert.equal(r.criterion.na_allowed, false);
  assert.match(r.note, /прощание есть/);
  assert.equal(ruleFor(conv('RU', ['operator', 'Тогда не знаю.'], ['system', 'Оператор закрыл чат.']), closure).answer, 'no');
  assert.match(ruleFor(conv('RU', ['operator', 'С чем помочь?'], ['system', 'Клиент покинул чат.']), closure).note, /прощания нет/);
});

test('правила не трогают критерии без export_id', () => {
  assert.equal(ruleFor(conv('RU', ['operator', 'Здравствуйте']), { id: 'x' }), null);
});

test('цитаты: приставка транскрипта убирается, номер реплики исправляется', async () => {
  const { cleanQuote, locateQuote, doubtsFor } = await import('../server/evaluator.js');
  assert.equal(cleanQuote('#10 [01:15] OPERATOR: Здравствуйте'), 'Здравствуйте');
  assert.equal(cleanQuote('[CLIENT]: Где тариф'), 'Где тариф');
  assert.equal(cleanQuote('[+1:05] client: да'), 'да');
  assert.equal(cleanQuote('[На сайте]'), 'На сайте');
  const c = conv('RU', ['client', 'Где тариф?'], ['operator', 'Откройте кабинет.'], ['client', 'Нашёл, спасибо']);
  assert.equal(locateQuote(c, { message: 1, quote: 'Откройте кабинет' }), 2, 'сдвинутый номер исправлен');
  const crit = { id: 'c05', type: 'binary' };
  assert.deepEqual(doubtsFor(crit, { answer: 'yes', evidence: [{ message: 2, quote: 'Откройте кабинет' }] }, c), []);
  assert.match(doubtsFor(crit, { answer: 'yes', evidence: [{ message: 2, quote: 'Мы вернём деньги' }] }, c)[0], /нет в диалоге/);
  assert.match(doubtsFor(crit, { answer: 'no', evidence: [] }, c)[0], /без указанной реплики/);
  assert.deepEqual(doubtsFor(crit, { answer: 'no', source: 'rule' }, c), [], 'ответ правила надёжен');
});

test('контакт: английское «I am Name»', () => {
  assert.equal(ruleFor(conv('EN', ['operator', 'Hi, I am Tyler. I can see a restriction.']), contact).answer, 'yes');
});

test('контакт: язык клиента определяется по его репликам, если поле language неверное', () => {
  assert.equal(ruleFor(conv('RU', ['client', 'Тарифімді қайдан көремін?'], ['operator', 'Сәлеметсіз бе, менің атым Аружан.']), contact).answer, 'yes');
});
