/* ==========================================================================
   engine.js: provider-agnostic chat engine. No DOM, no storage, plain fetch + streams.

   Conversation format used everywhere (and saved as-is in IndexedDB):
     { role: 'user' | 'assistant', content: 'text', files?: [...], thoughts?, model?, provider? }
   Each provider adapter converts it to its own wire format just before a request:
     Gemini      -> contents: [{ role, parts: [...] }]            (+ systemInstruction)
     OpenRouter  -> messages: [{ role, content }]  (OpenAI style)

   Sections: 1 Config · 2 Errors · 3 Catalog · 4 Context window · 5 Adapters · 6 Fallback router
   ========================================================================== */

/* ---------- 1. Config ---------- */

export const PROVIDERS = {
  gemini: { id: 'gemini', label: 'Google AI Studio' },
  openrouter: { id: 'openrouter', label: 'OpenRouter' },
};

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

/** Shown until (or instead of) the live Gemini list, and used as the Gemini fallback chain. */
export const GEMINI_DEFAULTS = [
  { id: 'gemini-3.8-flash', label: '3.8 Flash' },
  { id: 'gemini-3.5-flash-lite', label: '3.5 Flash Lite' },
  { id: 'gemini-2.5-flash', label: '2.5 Flash' },
  { id: 'gemini-2.5-pro', label: '2.5 Pro' },
];
const GEMINI_CHAIN = GEMINI_DEFAULTS.map((m) => m.id);

/**
 * Where a rate-limited Gemini request goes next. These are checked against OpenRouter's live model list:
 * any that no longer exist are skipped, and if none are left the newest ":free" models take their place.
 */
export const OPENROUTER_FREE_FALLBACKS = [
  'deepseek/deepseek-r1:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'qwen/qwen-2.5-coder-32b-instruct:free',
];

export const MAX_CONTEXT_MESSAGES = 14; // system prompt + the last 14 messages
export const MAX_CONTEXT_CHARS = 200_000; // text budget (about 50k tokens) so small free models don't overflow
export const DEFAULT_SYSTEM_PROMPT = 'You are a helpful assistant. Answer clearly and format replies in Markdown.';

const defaultFetch = (...args) => globalThis.fetch(...args);

/* ---------- 2. Errors ---------- */

export class ProviderError extends Error {
  constructor(message, { status = null, provider = '', model = '', fatal = false } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.provider = provider;
    this.model = model;
    this.fatal = fatal; // true = another model would fail the same way, so don't fall back
    this.network = false;
    this.partial = false; // true = part of an answer had already streamed
    this.previous = null; // the first failure, when a fallback also failed
  }
}

async function httpError(response, provider, model) {
  let message = response.statusText || `HTTP ${response.status}`;
  try {
    const body = await response.json();
    const info = body?.error ?? body;
    if (info?.message) message = info.message;
    const raw = info?.metadata?.raw;
    if (typeof raw === 'string' && raw) message += ` (${raw.slice(0, 200)})`;
  } catch { /* body was not JSON */ }
  return new ProviderError(message, { status: response.status, provider, model });
}

function toProviderError(err, candidate) {
  if (err instanceof ProviderError) {
    err.provider ||= candidate.provider;
    err.model ||= candidate.id;
    return err;
  }
  const wrapped = new ProviderError(err instanceof TypeError ? 'Network error' : err?.message || String(err), {
    provider: candidate.provider,
    model: candidate.id,
  });
  wrapped.network = err instanceof TypeError;
  return wrapped;
}

const isModelUnavailable = (err) =>
  err.status === 404 ||
  (err.status === 400 && /model/i.test(err.message) && /not found|not supported|unsupported|invalid/i.test(err.message));

const rejectsThinking = (err) => err.status === 400 && /think/i.test(err.message);

/** Another model might succeed (overload, quota, missing model). A bad key or a bad payload won't. */
function shouldFallback(err) {
  if (err.fatal) return false;
  if ([401, 403, 413].includes(err.status)) return false;
  if (err.status === 400) return isModelUnavailable(err);
  return true;
}

/** { message, detail }: a plain-language line for the UI, plus the provider's own words when they differ. */
export function describeError(err) {
  const provider = PROVIDERS[err.provider]?.label ?? 'The provider';
  const { status } = err;
  const message = err.message || String(err);
  let friendly = null;

  if (status === 401 || status === 403 || /api key/i.test(message)) {
    friendly = `${provider} rejected your API key. Open Key and check that it is correct and enabled.`;
  } else if (status === 402) {
    friendly = `${provider} says the account is out of credits. Add credits or pick a free model.`;
  } else if (status === 429) {
    friendly = `${provider} rate limit or quota reached. Wait a moment, then retry or pick another model.`;
  } else if (status === 503 || /overloaded|unavailable/i.test(message)) {
    friendly = `${provider} is overloaded right now. Try again shortly.`;
  } else if (status === 413 || /too large|exceeds the maximum/i.test(message)) {
    friendly = 'The request is too large. Remove some files or start a new chat.';
  } else if (err.network) {
    friendly = 'Network error. Check your connection, then retry.';
  }

  const details = [];
  if (friendly && friendly !== message) details.push(message);
  if (err.previous) details.push(`First attempt (${PROVIDERS[err.previous.provider]?.label ?? 'provider'}): ${err.previous.message}`);
  return { message: friendly || message, detail: details.join('\n') };
}

/* ---------- 3. Model catalogs ---------- */

const catalog = { gemini: new Map(), openrouter: new Map() };

export function setCatalog(provider, models) {
  catalog[provider] = new Map(models.map((m) => [m.id, m]));
}
export const getCatalog = (provider) => [...catalog[provider].values()];
export const getModelInfo = (provider, id) => catalog[provider].get(id) ?? null;

export const modelValue = (provider, id) => `${provider}:${id}`;

/** 'openrouter:deepseek/deepseek-r1:free' -> { provider: 'openrouter', id: 'deepseek/deepseek-r1:free' }. Unprefixed values are old Gemini choices. */
export function parseModelValue(value = '') {
  for (const provider of Object.keys(PROVIDERS)) {
    if (value.startsWith(`${provider}:`)) return { provider, id: value.slice(provider.length + 1) };
  }
  return { provider: 'gemini', id: value };
}

/** Google AI Studio: every model that can generate text. */
export async function fetchGeminiModels(key, { signal, fetchImpl = defaultFetch } = {}) {
  const found = [];
  let pageToken = '';
  do {
    const url = `${GEMINI_BASE}/models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const response = await fetchImpl(url, { headers: { 'x-goog-api-key': key }, signal });
    if (!response.ok) throw await httpError(response, 'gemini');
    const data = await response.json();
    found.push(...(data.models ?? []));
    pageToken = data.nextPageToken || '';
  } while (pageToken);

  return found
    .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
    .map((m) => ({ id: String(m.name).replace(/^models\//, ''), label: m.displayName || m.name, contextLength: m.inputTokenLimit ?? null }))
    .filter((m) => /^(gemini|gemma)/.test(m.id) && !/tts|image|embed|live|audio|aqa|robotics/i.test(m.id))
    .map((m) => ({ provider: 'gemini', free: false, inputModalities: ['text', 'image', 'audio', 'video', 'file'], ...m }));
}

/** OpenRouter: the public model list, text-output models only, with ":free" ones flagged. */
export async function fetchOpenRouterModels({ signal, fetchImpl = defaultFetch } = {}) {
  const response = await fetchImpl(`${OPENROUTER_BASE}/models`, { signal });
  if (!response.ok) throw await httpError(response, 'openrouter');
  const { data = [] } = await response.json();

  return data
    .filter((m) => m?.id && !m.id.endsWith(':batch'))
    .filter((m) => {
      const out = m.architecture?.output_modalities ?? ['text'];
      return out.length === 1 && out[0] === 'text'; // image-generating models answer with pictures this UI can't show
    })
    .map((m) => ({
      provider: 'openrouter',
      id: m.id,
      label: m.name || m.id,
      free: m.id.endsWith(':free'),
      contextLength: m.context_length ?? null,
      inputModalities: m.architecture?.input_modalities ?? ['text'],
      created: m.created ?? 0,
    }));
}

/** false only when OpenRouter clearly rejects the key (401). Any other outcome (404, offline, CORS) means "can't tell". */
export async function verifyOpenRouterKey(key, { signal, fetchImpl = defaultFetch } = {}) {
  try {
    const response = await fetchImpl(`${OPENROUTER_BASE}/key`, { headers: { Authorization: `Bearer ${key}` }, signal });
    return response.status !== 401;
  } catch {
    return true;
  }
}

/** Curated models first (when they exist), then everything else the key can use. */
export function orderGeminiModels(models) {
  const rank = (m) => { const i = GEMINI_CHAIN.indexOf(m.id); return i === -1 ? GEMINI_CHAIN.length : i; };
  return [...models].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
}

/** Free models first (newest first, as OpenRouter lists them), then the rest alphabetically. */
export function orderOpenRouterModels(models) {
  const free = models.filter((m) => m.free).sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
  const paid = models.filter((m) => !m.free).sort((a, b) => a.label.localeCompare(b.label));
  return [...free, ...paid];
}

function liveGeminiChain() {
  const live = catalog.gemini;
  return live.size ? GEMINI_CHAIN.filter((id) => live.has(id)) : GEMINI_CHAIN;
}

function liveFreeFallbacks() {
  const live = catalog.openrouter;
  if (!live.size) return OPENROUTER_FREE_FALLBACKS;
  const valid = OPENROUTER_FREE_FALLBACKS.filter((id) => live.has(id));
  if (valid.length) return valid;
  return orderOpenRouterModels([...live.values()]).filter((m) => m.free).slice(0, 3).map((m) => m.id);
}

/* ---------- 4. Context window ---------- */

const textSize = (m) => (m.content?.length ?? 0) + (m.files ?? []).reduce((n, f) => n + (f.text?.length ?? 0), 0);

/** The last N messages (and no more than the text budget), always starting on a user message. */
export function trimContext(messages, { maxMessages = MAX_CONTEXT_MESSAGES, maxChars = MAX_CONTEXT_CHARS } = {}) {
  let window = messages.slice(-maxMessages);
  let total = window.reduce((n, m) => n + textSize(m), 0);
  while (window.length > 1 && total > maxChars) {
    total -= textSize(window[0]);
    window = window.slice(1);
  }
  while (window.length > 1 && window[0].role !== 'user') window = window.slice(1);
  return window;
}

/* ---------- 5. Adapters ---------- */

/** Server-sent events: yields the data payload of each event. Handles chunks that split anywhere. */
async function* sseData(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const payload = (raw) => {
    const lines = raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, ''));
    return lines.length ? lines.join('\n') : null; // comment lines (": keep-alive") carry no data
  };
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
      let cut;
      while ((cut = buffer.indexOf('\n\n')) !== -1) {
        const data = payload(buffer.slice(0, cut));
        buffer = buffer.slice(cut + 2);
        if (data !== null) yield data;
      }
    }
    const tail = payload((buffer + decoder.decode()).replace(/\r\n/g, '\n'));
    if (tail !== null) yield tail;
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }
}

const fileAsText = (f) => `File: ${f.name}\n\`\`\`\n${f.text}\n\`\`\``;

/* --- Google AI Studio --- */

export function toGeminiContents(messages) {
  return messages.map((m) => {
    const parts = [];
    for (const f of m.files ?? []) {
      if (f.data) parts.push({ inlineData: { data: f.data, mimeType: f.mime } });
      else if (f.text != null) parts.push({ text: fileAsText(f) });
    }
    if (m.content) parts.push({ text: m.content });
    return { role: m.role === 'assistant' ? 'model' : 'user', parts };
  });
}

async function* streamGemini({ model, messages, system, key, signal, includeThoughts, fetchImpl }) {
  const body = { contents: toGeminiContents(messages), generationConfig: {} };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (includeThoughts) body.generationConfig.thinkingConfig = { includeThoughts: true };

  const response = await fetchImpl(`${GEMINI_BASE}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw await httpError(response, 'gemini', model);

  for await (const data of sseData(response.body)) {
    let chunk;
    try { chunk = JSON.parse(data); } catch { continue; }
    if (chunk.error) throw new ProviderError(chunk.error.message, { status: chunk.error.code, provider: 'gemini', model });

    if (chunk.promptFeedback?.blockReason) yield { blockReason: chunk.promptFeedback.blockReason };
    const candidate = chunk.candidates?.[0];
    if (candidate?.finishReason) yield { finishReason: candidate.finishReason };
    for (const part of candidate?.content?.parts ?? []) {
      if (!part.text) continue;
      yield part.thought ? { thought: part.text } : { text: part.text };
    }
  }
}

/* --- OpenRouter (OpenAI-compatible) --- */

/**
 * Converts the stored conversation to OpenAI-style messages.
 * Attachments the chosen model can't read are left out and reported in `dropped`, with a note in the text
 * so the model knows something was omitted.
 */
export function toOpenAIMessages(messages, system, modalities = ['text']) {
  const out = [];
  const dropped = [];
  if (system) out.push({ role: 'system', content: system });

  for (const m of messages) {
    if (m.role === 'assistant') { out.push({ role: 'assistant', content: m.content ?? '' }); continue; }

    const parts = [];
    const notes = [];
    for (const f of m.files ?? []) {
      if (f.text != null) {
        parts.push({ type: 'text', text: fileAsText(f) });
      } else if (f.kind === 'image' && modalities.includes('image')) {
        parts.push({ type: 'image_url', image_url: { url: `data:${f.mime};base64,${f.data}` } });
      } else if (f.mime === 'application/pdf') {
        parts.push({ type: 'file', file: { filename: f.name, file_data: `data:application/pdf;base64,${f.data}` } });
      } else {
        dropped.push(f.name);
        notes.push(`[Attachment "${f.name}" (${f.kind || 'file'}) was not sent: this model can't read it.]`);
      }
    }

    const text = [m.content, ...notes].filter(Boolean).join('\n');
    if (parts.length) {
      if (text) parts.push({ type: 'text', text });
      out.push({ role: 'user', content: parts });
    } else {
      out.push({ role: 'user', content: text });
    }
  }
  return { messages: out, dropped };
}

async function* streamOpenRouter({ model, messages, system, key, signal, fetchImpl }) {
  const info = getModelInfo('openrouter', model);
  const { messages: payload, dropped } = toOpenAIMessages(messages, system, info?.inputModalities ?? ['text']);
  if (dropped.length) yield { notice: `${model} can't read: ${[...new Set(dropped)].join(', ')}. Sent without them.` };

  const response = await fetchImpl(`${OPENROUTER_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: payload, stream: true }),
    signal,
  });
  if (!response.ok) throw await httpError(response, 'openrouter', model);

  for await (const data of sseData(response.body)) {
    if (data === '[DONE]') return;
    let chunk;
    try { chunk = JSON.parse(data); } catch { continue; }
    if (chunk.error) throw new ProviderError(chunk.error.message || 'Provider error', { status: chunk.error.code, provider: 'openrouter', model });

    const choice = chunk.choices?.[0];
    const delta = choice?.delta ?? {};
    const reasoning = delta.reasoning ?? delta.reasoning_content;
    if (reasoning) yield { thought: reasoning };
    if (delta.content) yield { text: delta.content };
    if (choice?.finish_reason) yield { finishReason: choice.finish_reason };
  }
}

const ADAPTERS = { gemini: streamGemini, openrouter: streamOpenRouter };

/* ---------- 6. Fallback router ---------- */

/** Ordered list of models to try: the one you picked, then same-provider backups, then the other provider. */
export function buildQueue(selected, keys) {
  const gemini = liveGeminiChain().map((id) => ({ provider: 'gemini', id }));
  const free = liveFreeFallbacks().map((id) => ({ provider: 'openrouter', id }));
  const ordered = selected.provider === 'gemini' ? [selected, ...gemini, ...free] : [selected, ...free, ...gemini];

  const seen = new Set();
  return ordered.filter((c) => {
    const id = `${c.provider}:${c.id}`;
    if (!keys[c.provider] || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** One model, with a single retry that drops the thinking option if the model rejects it. */
async function* attempt(candidate, context) {
  let includeThoughts = candidate.provider === 'gemini';
  let produced = false;
  for (;;) {
    try {
      for await (const event of ADAPTERS[candidate.provider]({ ...context, model: candidate.id, key: context.keys[candidate.provider], includeThoughts })) {
        if (event.text || event.thought) produced = true;
        yield event;
      }
      return;
    } catch (err) {
      const error = toProviderError(err, candidate);
      if (includeThoughts && !produced && rejectsThinking(error)) { includeThoughts = false; continue; }
      throw error;
    }
  }
}

/**
 * Streams one reply, failing over between models and providers as needed. Yields:
 *   { type: 'status', provider, model }                      an attempt is starting
 *   { type: 'text' | 'thought', delta }                      streamed content
 *   { type: 'notice', message }                              e.g. attachments a model can't read
 *   { type: 'fallback', from, to, reason }                   switching models (the stream carries on)
 *   { type: 'done', provider, model, chosenUnavailable }     finished
 * Throws a ProviderError if every option fails (error.partial = an answer was already partly shown).
 */
export async function* streamChat({ messages, system, selected, keys, signal, fetchImpl = defaultFetch }) {
  const context = { messages: trimContext(messages), system, signal, fetchImpl, keys };
  let queue = buildQueue(selected, keys);
  if (!queue.length) {
    throw new ProviderError('No API key is set for this model.', { status: 401, provider: selected.provider, fatal: true });
  }

  const deadProviders = new Set(); // providers that can't be reached at all right now
  let emitted = false;
  let firstError = null;
  let lastError = null;
  let chosenUnavailable = false;

  for (let i = 0; i < queue.length; i++) {
    const candidate = queue[i];
    if (deadProviders.has(candidate.provider)) continue;
    if (signal?.aborted) return;

    yield { type: 'status', provider: candidate.provider, model: candidate.id };

    try {
      let textLength = 0;
      let finishReason = '';
      let blockReason = '';
      for await (const event of attempt(candidate, context)) {
        if (event.text) { emitted = true; textLength += event.text.length; yield { type: 'text', delta: event.text }; }
        else if (event.thought) { emitted = true; yield { type: 'thought', delta: event.thought }; }
        else if (event.notice) yield { type: 'notice', message: event.notice };
        else { finishReason = event.finishReason || finishReason; blockReason = event.blockReason || blockReason; }
      }
      if (signal?.aborted) return;

      if (!textLength) {
        const reason = blockReason || finishReason;
        throw new ProviderError(reason ? `The model returned no text (${reason}).` : 'The model returned an empty response.', {
          provider: candidate.provider,
          model: candidate.id,
          fatal: candidate.provider === 'gemini', // blocked/filtered: another Gemini model would answer the same way
        });
      }
      yield { type: 'done', provider: candidate.provider, model: candidate.id, finishReason, chosenUnavailable };
      return;
    } catch (err) {
      if (signal?.aborted) return;
      const error = toProviderError(err, candidate);
      lastError = error;
      firstError ??= error;
      if (i > 0 && firstError !== error) error.previous = firstError;

      if (emitted) { error.partial = true; throw error; } // part of an answer is on screen: don't restart it elsewhere
      if (i === 0 && isModelUnavailable(error)) chosenUnavailable = true;
      if (!shouldFallback(error)) throw error;
      if (error.network) deadProviders.add(candidate.provider);

      // Rate-limited on Gemini: go straight to the OpenRouter free models (when a key is set) instead of other Gemini models.
      if (error.status === 429 && candidate.provider === 'gemini' && keys.openrouter) {
        queue = queue.filter((c, j) => j <= i || c.provider !== 'gemini');
      }

      const next = queue.slice(i + 1).find((c) => !deadProviders.has(c.provider));
      if (next) {
        yield {
          type: 'fallback',
          from: { provider: candidate.provider, model: candidate.id },
          to: { provider: next.provider, model: next.id },
          reason: error.status === 429 ? 'rate limit' : error.status ? `error ${error.status}` : 'error',
        };
      }
    }
  }
  throw lastError ?? new ProviderError('No model is available.', { provider: selected.provider });
}
