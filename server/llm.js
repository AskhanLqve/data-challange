// Провайдеры LLM. По умолчанию — Claude (облако, Anthropic SDK); альтернатива — локальная модель через Ollama.
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';

export const PROVIDER = (process.env.CQA_PROVIDER || 'anthropic').toLowerCase();
export const MODEL = process.env.CQA_MODEL || (PROVIDER === 'ollama' ? 'qwen2.5:7b-instruct' : 'claude-opus-5-5');
export const EFFORT = process.env.CQA_EFFORT || 'high';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';

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
  const configured = PROVIDER === 'ollama' ? true : Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  return { provider: PROVIDER, model: MODEL, effort: PROVIDER === 'anthropic' ? EFFORT : null, configured, price_per_mtok: PRICES[MODEL] || null };
}

/**
 * Один вызов модели со структурированным ответом.
 * @returns {Promise<{parsed:any, usage:any, model:string, cost_usd:number, stop_reason:string, text:string}>}
 */
export async function completeJSON({ system, user, schema }) {
  if (PROVIDER === 'ollama') return ollamaJSON({ system, user, schema });
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

async function ollamaJSON({ system, user, schema }) {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      stream: false,
      format: z.toJSONSchema(schema),
      options: { temperature: 0, num_ctx: 16384 },
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
