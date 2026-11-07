import { detectLanguage } from './dataset.js';

// Проверки кодом для фактов, которые небольшая модель путает: приветствие с именем в первом сообщении и прощание.
// Привязаны к export_id критерия: у нового или переименованного критерия правила просто не срабатывают.
//
// ruleFor(conv, c) → null | { answer, explanation, evidence } — ответ без модели
//                  | { note, criterion } — подсказка модели и суженный критерий (например, без N/A)

const GREETING = {
  RU: /здравствуйте|добр(ый|ое|ого) (день|вечер|утр)|приветствую/i,
  KZ: /сәлеметсіз бе|қайырлы (күн|таң|кеш)|армысыз/i,
  EN: /\b(hello|hi|good (morning|afternoon|evening))\b/i,
};
// \b в JS работает только с латиницей, поэтому для кириллицы граница слова задана явно.
const INTRO = {
  RU: /[Мм]еня зовут|(^|[\s,.!])[Яя] [А-ЯЁ][а-яё]+|\[Имя скрыто\]/u,
  KZ: /[Мм]енің атым|(^|[\s,.!])[Мм]ен [А-ЯЁӘҒҚҢӨҰҮҺІ][а-яёәғқңөұүһі]+|\[Имя скрыто\]/u,
  EN: /\bI(?:'m| am) [A-Z][a-z]+|[Mm]y name is|[Tt]his is [A-Z][a-z]+|\[Имя скрыто\]/,
};
// Прощание на любом из трёх языков: клиент мог писать на одном, оператор ответить на другом.
const FAREWELL = /до свидания|всего (доброго|хорошего)|хорошего (дня|вечера|утра|выходн)|сау бол(ыңыз|)|(қош|көріскенше)|goodbye|\bbye\b|have a (good|nice|great)/i;
const OPERATOR_CLOSED = /оператор закрыл|operator closed|оператор чатты жапты/i;

const quote = (m) => ({ message: m.idx, quote: m.text.slice(0, 160) });

function contact(conv) {
  const first = conv.transcript.find((m) => m.speaker === 'operator');
  if (!first) return null;
  // язык клиента: поле language и то, на чём клиент реально пишет (поле бывает указано неверно)
  const clientMsgs = conv.transcript.filter((m) => m.speaker === 'client');
  const langs = [...new Set([conv.language, clientMsgs.length ? detectLanguage(clientMsgs) : null])].filter((l) => GREETING[l]);
  if (!langs.length) langs.push('RU');
  const greet = langs.some((l) => GREETING[l].test(first.text)), intro = langs.some((l) => INTRO[l].test(first.text));
  const ok = greet && intro;
  const missing = [!greet && 'приветствия на языке клиента', !intro && 'представления'].filter(Boolean).join(' и ');
  return {
    rule: true,
    answer: ok ? 'yes' : 'no',
    explanation: ok
      ? `Установление контакта — Да. В первом сообщении оператора #${first.idx} есть приветствие на языке клиента и представление (проверено правилом).`
      : `Установление контакта — Нет. В первом сообщении оператора #${first.idx} нет ${missing} (проверено правилом).`,
    evidence: [quote(first)],
  };
}

function closure(conv, c) {
  const t = conv.transcript;
  const lastOp = [...t].reverse().find((m) => m.speaker === 'operator');
  if (!lastOp) return null;
  const tail = t.slice(t.indexOf(lastOp) + 1);
  if (FAREWELL.test(lastOp.text)) {
    return {
      note: `Проверено кодом: прощание есть в последней реплике оператора #${lastOp.idx} «${lastOp.text}». N/A неприменим. Реши только, подвёл ли оператор итог или предложил дальнейшую помощь/следующий шаг (вежливое «пожалуйста» итогом не является).`,
      criterion: { ...c, na_allowed: false },
    };
  }
  if (tail.some((m) => m.speaker === 'system' && OPERATOR_CLOSED.test(m.text))) {
    return {
      rule: true,
      answer: 'no',
      explanation: `Завершение — Нет. Оператор закрыл чат без прощания; последняя реплика оператора #${lastOp.idx} (проверено правилом).`,
      evidence: [quote(lastOp)],
    };
  }
  return { note: `Проверено кодом: в последней реплике оператора #${lastOp.idx} прощания нет. Значит, ответ «Нет» или N/A (если клиент пропал/чат оборвался раньше, чем оператор мог завершить).` };
}

// Подсказка для «Идентификации» убрана: на замере 26 диалогов она снизила точность критерия с 69% до 50%
// (модель ставила «Нет» вместо N/A, когда запрос не требовал проверки).
const RULES = { contact, closure };

export function ruleFor(conv, c) {
  const fn = RULES[c.export_id];
  return fn ? fn(conv, c) : null;
}
