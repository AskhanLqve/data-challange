// Провайдеры LLM. По умолчанию — Claude (облако, Anthropic SDK); альтернатива — локальная модель через Ollama.
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

export const PROVIDER = (process.env.CQA_PROVIDER || 'anthropic').toLowerCase();
export const MODEL = process.env.CQA_MODEL || (PROVIDER === 'ollama' ? 'qwen2.5:7b-instruct' : PROVIDER === 'stub' ? 'stub' : 'claude-opus-5-5');
export const EFFORT = process.env.CQA_EFFORT || 'high';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
// qwen3 по умолчанию рассуждает перед ответом — для оценки по схеме это лишние минуты, поэтому выключаем, если не задано явно
const THINK = process.env.OLLAMA_THINK ? process.env.OLLAMA_THINK === 'true' : /^qwen3/.test(process.env.CQA_MODEL || '') ? false : null;

// $ за 1M токенов: input, output, cache read (запись в кэш ≈ 1.25× input)
const PRICES = {
  'claude-opus-5-5': [4, 20, 0.2],
  'claude-opus-5': [5, 25, 0.5],
  'claude-sonnet-5-5': [2, 10, 0.2],
  'claude-haiku-5-5': [0.1, 0.5, 0.01],
  'claude-fable-5-1': [10, 50, 0.25],
};

export function estimateCost(model, usage) {
  const p = PRICES[model];
  if (!p || !usage) return 0;
  const inTok = usage.input_tokens || 0;
  const outTok = usage.output_tokens || 0;
  const cRead = usage.cache_read_input_tokens || 0;
  const cWrite = usage.cache_creation_input_tokens || 0;
  return (inTok * p[0] + outTok * p[1] + cRead * p[2] + cWrite * p[0] * 1.25) / 1e6;
}

let client;
function anthropic() {
  // Ключ берётся из ANTHROPIC_API_KEY (или профиля `ant auth login`).
  client ||= new Anthropic({ maxRetries: 4, timeout: 10 * 60_000 });
  return client;
}

export function providerInfo() {
  const configured = PROVIDER === 'ollama' || PROVIDER === 'stub' ? true : Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  return { provider: PROVIDER, model: MODEL, effort: PROVIDER === 'anthropic' ? EFFORT : null, configured, price_per_mtok: PRICES[MODEL] || null };
}

/**
 * Один вызов модели со структурированным ответом.
 * @returns {Promise<{parsed:any, usage:any, model:string, cost_usd:number, stop_reason:string, text:string}>}
 */
const RETRIES = Math.max(0, Number(process.env.CQA_LLM_RETRIES ?? 3));

/** Готов ли провайдер: для Ollama — сервер отвечает и модель скачана. */
export async function providerReady() {
  if (PROVIDER === 'stub') return { ready: true };
  if (PROVIDER === 'anthropic') return providerInfo().configured ? { ready: true } : { ready: false, problem: 'Не задан ANTHROPIC_API_KEY' };
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    const tags = (await r.json()).models?.map((m) => m.name) || [];
    if (!tags.some((t) => t === MODEL || t === `${MODEL}:latest`)) return { ready: false, problem: `Модель ${MODEL} не скачана: ollama pull ${MODEL}` };
    return { ready: true };
  } catch { return { ready: false, problem: `Ollama не отвечает на ${OLLAMA_URL}: запустите ollama serve` }; }
}

export async function completeJSON(args) {
  // Повтор при сбое: битый JSON, таймаут, временная ошибка сети/модели.
  let lastErr;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try { return await completeOnce(args); } catch (e) {
      lastErr = e;
      const fatal = /refusal|ключ|API key|401|403|не скачана/i.test(String(e.message));
      if (fatal || attempt === RETRIES) break;
      // обрыв связи — обычно Ollama перезапускается (например, после нехватки памяти) и заново грузит модель: ждём дольше
      const down = /fetch failed|ECONNREFUSED|ECONNRESET|socket/i.test(String(e.message) + String(e.cause?.code || ''));
      console.warn(`[llm] попытка ${attempt + 1} не удалась: ${e.message}. Повтор…`);
      await new Promise((r) => setTimeout(r, (down ? 10_000 : 1500) * (attempt + 1)));
    }
  }
  throw lastErr;
}

async function completeOnce({ system, user, schema, temperature, seed }) {
  if (PROVIDER === 'ollama') return ollamaJSON({ system, user, schema, temperature, seed });
  if (PROVIDER === 'stub') return stubJSON({ schema });
  return anthropicJSON({ system, user, schema });
}

async function anthropicJSON({ system, user, schema }) {
  const params = {
    model: MODEL,
    max_tokens: 16000,
    // Системный промпт (правила + чек-лист) одинаков для всех диалогов → кэшируем.
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: user }],
    thinking: { type: 'adaptive' },
    output_config: { effort: EFFORT, format: zodOutputFormat(schema) },
    // При отказе классификатора безопасности запрос повторяется на рекомендованной модели.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
  };
  let res;
  try {
    res = await anthropic().beta.messages.parse(params);
  } catch (e) {
    if (e instanceof Anthropic.BadRequestError && /fallback/i.test(String(e.message))) {
      delete params.betas; delete params.fallbacks;
      res = await anthropic().beta.messages.parse(params);
    } else throw e;
  }
  if (res.stop_reason === 'refusal') throw new Error('Модель отказалась отвечать (stop_reason=refusal)');
  if (res.stop_reason === 'max_tokens') throw new Error('Ответ модели обрезан (max_tokens)');
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const parsed = res.parsed_output ?? schema.parse(JSON.parse(text));
  return { parsed, usage: res.usage, model: res.model, cost_usd: estimateCost(MODEL, res.usage), stop_reason: res.stop_reason, text };
}

async function ollamaJSON({ system, user, schema, temperature = 0, seed = 42 }) {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      format: z.toJSONSchema(schema),
      // temperature 0 + seed — воспроизводимая оценка; ответ одного критерия короткий, длину ограничиваем
      options: { temperature, seed, num_ctx: Number(process.env.OLLAMA_NUM_CTX || 12288), num_predict: Number(process.env.OLLAMA_NUM_PREDICT || 2048) },
      keep_alive: process.env.OLLAMA_KEEP_ALIVE || '30m', // модель остаётся в памяти между диалогами
      ...(THINK != null ? { think: THINK } : {}), // для моделей с режимом рассуждения (qwen3): по умолчанию выключен
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
    signal: AbortSignal.timeout(15 * 60_000),
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);
  const body = await res.json();
  const text = body.message?.content || '';
  const parsed = schema.parse(JSON.parse(text));
  const usage = { input_tokens: body.prompt_eval_count || 0, output_tokens: body.eval_count || 0 };
  return { parsed, usage, model: MODEL, cost_usd: 0, stop_reason: body.done_reason, text };
}

// Заглушка ТОЛЬКО для автотестов (CQA_PROVIDER=stub): мгновенно возвращает формально корректный ответ
// по JSON-схеме (первое допустимое значение), чтобы проверять API без реальной модели. Не для оценки.
function fillFromSchema(js) {
  if (js.enum) return js.enum[0];
  if (js.anyOf) return fillFromSchema(js.anyOf.find((x) => x.type !== 'null') || js.anyOf[0]);
  switch (js.type) {
    case 'object': return Object.fromEntries(Object.entries(js.properties || {}).map(([k, v]) => [k, fillFromSchema(v)]));
    case 'array': return [fillFromSchema(js.items || {})];
    case 'string': return 'stub';
    case 'integer': case 'number': return 1;
    case 'boolean': return false;
    default: return null;
  }
}
async function stubJSON({ schema }) {
  const parsed = schema.parse(fillFromSchema(z.toJSONSchema(schema)));
  return { parsed, usage: { input_tokens: 0, output_tokens: 0 }, model: 'stub', cost_usd: 0, stop_reason: 'end_turn', text: JSON.stringify(parsed) };
}

/**
 * Обычный текстовый ответ (ИИ-помощник): system + история сообщений [{role:'user'|'assistant', content}].
 * @returns {Promise<{text:string, usage:any, model:string, cost_usd:number}>}
 */
export async function completeText({ system, messages }) {
  if (PROVIDER === 'stub') return { text: 'Ответ помощника (тестовая заглушка).', usage: {}, model: 'stub', cost_usd: 0 };
  if (PROVIDER === 'ollama') {
    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL, stream: false, keep_alive: process.env.OLLAMA_KEEP_ALIVE || '30m',
        ...(THINK != null ? { think: THINK } : {}),
        options: { temperature: 0.2, seed: 42, num_ctx: Number(process.env.OLLAMA_NUM_CTX || 12288), num_predict: 1024 },
        messages: [{ role: 'system', content: system }, ...messages],
      }),
      signal: AbortSignal.timeout(10 * 60_000),
    });
    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}: ${await res.text()}`);
    const body = await res.json();
    const text = (body.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    return { text, usage: { input_tokens: body.prompt_eval_count || 0, output_tokens: body.eval_count || 0 }, model: MODEL, cost_usd: 0 };
  }
  const res = await anthropic().beta.messages.create({
    model: MODEL, max_tokens: 4000,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages, output_config: { effort: 'low' },
    betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
  });
  if (res.stop_reason === 'refusal') throw new Error('Модель отказалась отвечать');
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  return { text, usage: res.usage, model: res.model, cost_usd: estimateCost(MODEL, res.usage) };
}
