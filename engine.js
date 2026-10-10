/* ==========================================================================
   engine.js — one chat engine, several providers
   streamChat() talks to Google AI Studio (Gemini) or OpenRouter over plain
   fetch + SSE (no SDK) and yields the same chunk types for both, so app.js
   never needs to know which provider answered.

   Chunks yielded by streamChat():
     { type: 'status',   provider, model }
     { type: 'text',     delta }
     { type: 'thought',  delta }
     { type: 'fallback', from: {provider, model}, to: {provider, model}, reason }
     { type: 'notice',   message }
     { type: 'done',     finishReason }

   Messages (what app.js keeps in state.history):
     { role: 'user',      content, files?: [{ name, mime, data?, text? }] }
     { role: 'assistant', content }
   `data` is base64, `text` is the raw text of a code/text file.
   ========================================================================== */

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

const SAME_PROVIDER_FALLBACKS = 2;   // extra models tried from the same provider
const OTHER_PROVIDER_FALLBACKS = 1;  // extra models tried from the other provider (only if it has a key)

export const PROVIDERS = ['gemini', 'openrouter'];
export const PROVIDER_NAMES = { gemini: 'Google AI Studio', openrouter: 'OpenRouter' };

export const DEFAULT_SYSTEM_PROMPT =
  'You are a helpful, accurate assistant. Reply in clean Markdown. ' +
  'Put code in fenced blocks and always label the language, for example ```python.';

/** Shown until the live model list has been fetched (or when there is no Gemini key yet). */
export const GEMINI_DEFAULTS = [
  { id: 'gemini-3.8-flash', label: '3.8 Flash' },
  { id: 'gemini-3.5-flash-lite', label: '3.5 Flash Lite' },
  { id: 'gemini-2.5-flash', label: '2.5 Flash' },
  { id: 'gemini-2.5-pro', label: '2.5 Pro' },
];

/* ---------- Model values: "provider:id" ---------- */

export const modelValue = (provider, id) => `${provider}:${id}`;

/** OpenRouter ids contain ":" and "/", so only the first colon is the separator. */
export function parseModelValue(value = '') {
  const match = /^(gemini|openrouter):([\s\S]+)$/.exec(value);
  if (match) return { provider: match[1], id: match[2] };
  return { provider: 'gemini', id: value }; // un-prefixed ids saved by older versions were always Gemini
}

/* ---------- In-memory catalogs ---------- */

const catalogs = { gemini: [], openrouter: [] };
export const setCatalog = (provider, models) => { catalogs[provider] = Array.isArray(models) ? models : []; };
export const getCatalog = (provider) => catalogs[provider] ?? [];

/* ---------- Errors ---------- */

async function httpError(res) {
  let message = `${res.status} ${res.statusText}`.trim();
  try {
    const text = await res.text();
    try {
      const body = JSON.parse(text);
      message = body?.error?.message || body?.message || message;
    } catch {
      if (text) message = text.slice(0, 300);
    }
  } catch { /* body unreadable: keep the status line */ }
  return Object.assign(new Error(message), { status: res.status });
}

const isAbort = (err) => err?.name === 'AbortError';

/** Another model might succeed (overload, quota, missing model). Bad keys, bad payloads and network drops won't. */
function shouldFallback(err) {
  if (err?.fatal || err instanceof TypeError) return false;
  const status = Number(err?.status) || null;
  if ([401, 403, 413].includes(status)) return false;
  if (status === 400) return /model/i.test(err.message) && /not found|not supported|unsupported|invalid/i.test(err.message);
  return true;
}

/* ---------- Model catalogs ---------- */

export async function fetchGeminiModels(apiKey, signal) {
  const models = [];
  let pageToken = '';
  for (let page = 0; page < 5; page++) {
    const url = `${GEMINI_BASE}/models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const res = await fetch(url, { headers: { 'x-goog-api-key': apiKey }, signal });
    if (!res.ok) throw await httpError(res);
    const data = await res.json();
    for (const m of data.models ?? []) {
      if (!m.supportedGenerationMethods?.includes('generateContent')) continue;
      const id = String(m.name ?? '').replace(/^models\//, '');
      if (id) models.push({ id, label: (m.displayName || id).replace(/^Gemini\s+/i, ''), limit: m.inputTokenLimit ?? 0 });
    }
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return models;
}

// Not chat models, or models that reject system prompts / plain text chat
const GEMINI_SKIP = /(embedding|aqa|imagen|veo|tts|image|live|audio|robotics|computer-use|learnlm|gemma|vision|omni|lyria|deep-research)/i;

/** Newest version first; within a version: Flash, Flash-Lite, Pro; stable before preview. */
export function orderGeminiModels(models) {
  const rank = (id) => {
    const v = /^gemini-(\d+(?:\.\d+)?)/.exec(id);
    return {
      version: v ? parseFloat(v[1]) : 0, // "-latest" aliases (no version) sink to the bottom
      preview: /preview|exp/.test(id) ? 1 : 0,
      tier: /flash-lite/.test(id) ? 1 : /flash/.test(id) ? 0 : /pro/.test(id) ? 2 : 3,
    };
  };
  return models
    .filter((m) => /^gemini-/.test(m.id) && !GEMINI_SKIP.test(m.id))
    .map((m) => ({ m, r: rank(m.id) }))
    .sort((a, b) =>
      b.r.version - a.r.version || a.r.preview - b.r.preview || a.r.tier - b.r.tier || a.m.id.localeCompare(b.m.id))
    .map((x) => x.m);
}

/** The public model list needs no key. */
export async function fetchOpenRouterModels(signal) {
  const res = await fetch(`${OPENROUTER_BASE}/models`, { signal });
  if (!res.ok) throw await httpError(res);
  const data = await res.json();
  return (data.data ?? []).map((m) => ({
    id: m.id,
    label: m.name || m.id,
    free: (Number(m.pricing?.prompt) === 0 && Number(m.pricing?.completion) === 0) || /:free$/.test(m.id),
    ctx: m.context_length ?? 0,
    input: m.architecture?.input_modalities ?? ['text'],
    output: m.architecture?.output_modalities ?? ['text'],
  }));
}

/** Text-output models only; free ones first, then A to Z. */
export function orderOpenRouterModels(models) {
  return models
    .filter((m) => m.output.includes('text'))
    .sort((a, b) => Number(b.free) - Number(a.free) || a.label.localeCompare(b.label));
}

/* ---------- Server-sent events ---------- */

/** Yields the `data:` payload of every event in a streaming response. */
async function* sseData(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const SEP = /\r?\n\r?\n/;
  const payload = (raw) => raw.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let m;
      while ((m = SEP.exec(buf))) {
        const raw = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        const data = payload(raw);
        if (data) yield data;
      }
    }
    buf += decoder.decode();
    const tail = payload(buf);
    if (tail) yield tail;
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }
}

/* ---------- Gemini ---------- */

const fileAsText = (f) => `File: ${f.name}\n\`\`\`\n${f.text}\n\`\`\``;

function toGeminiContents(messages) {
  const contents = [];
  for (const m of messages) {
    const role = m.role === 'user' ? 'user' : 'model';
    const parts = [];
    if (role === 'user') {
      for (const f of m.files ?? []) {
        if (f.data) parts.push({ inlineData: { mimeType: f.mime || 'application/octet-stream', data: f.data } });
        else if (f.text != null) parts.push({ text: fileAsText(f) });
      }
    }
    if (m.content) parts.push({ text: m.content });
    if (!parts.length) continue;
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts); // the API wants alternating turns
    else contents.push({ role, parts });
  }
  return contents;
}

async function* streamGemini({ model, apiKey, messages, system, signal }) {
  let includeThoughts = true;
  let res;
  for (;;) { // at most two passes: with the thinking config, then without it
    const body = { contents: toGeminiContents(messages) };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (includeThoughts) body.generationConfig = { thinkingConfig: { includeThoughts: true } };

    res = await fetch(`${GEMINI_BASE}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal,
    });
    if (res.ok) break;
    const err = await httpError(res);
    if (includeThoughts && err.status === 400 && /think/i.test(err.message)) { includeThoughts = false; continue; }
    throw err;
  }

  let finishReason = '';
  let blockReason = '';
  let gotText = false;
  let gotThought = false;

  for await (const data of sseData(res)) {
    let json;
    try { json = JSON.parse(data); } catch { continue; }
    if (json.error) {
      throw Object.assign(new Error(json.error.message || 'The stream failed.'), { status: Number(json.error.code) || 500 });
    }
    blockReason = json.promptFeedback?.blockReason || blockReason;
    const candidate = json.candidates?.[0];
    finishReason = candidate?.finishReason || finishReason;
    for (const part of candidate?.content?.parts ?? []) {
      if (!part.text) continue;
      if (part.thought) { gotThought = true; yield { type: 'thought', delta: part.text }; }
      else { gotText = true; yield { type: 'text', delta: part.text }; }
    }
  }

  if (!gotText && !gotThought) {
    const reason = blockReason || finishReason;
    throw Object.assign(
      new Error(reason ? `The model returned no text (${reason}).` : 'The model returned an empty response.'),
      { fatal: true }, // every model would answer the same way
    );
  }
  if (!gotText) yield { type: 'notice', message: `The model finished without an answer${finishReason ? ` (${finishReason})` : ''}.` };
  yield { type: 'done', finishReason };
}

/* ---------- OpenRouter ---------- */

const AUDIO_FORMATS = { 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3' };

function toOpenRouterMessages(messages, system) {
  const out = [];
  const skipped = [];
  if (system) out.push({ role: 'system', content: system });

  for (const m of messages) {
    if (m.role !== 'user') {
      if (m.content) out.push({ role: 'assistant', content: m.content });
      continue;
    }
    const content = [];
    for (const f of m.files ?? []) {
      const mime = f.mime || '';
      if (f.text != null) content.push({ type: 'text', text: fileAsText(f) });
      else if (f.data && mime.startsWith('image/')) content.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${f.data}` } });
      else if (f.data && mime === 'application/pdf') content.push({ type: 'file', file: { filename: f.name, file_data: `data:${mime};base64,${f.data}` } });
      else if (f.data && AUDIO_FORMATS[mime]) content.push({ type: 'input_audio', input_audio: { data: f.data, format: AUDIO_FORMATS[mime] } });
      else skipped.push(f.name);
    }
    if (m.content) content.push({ type: 'text', text: m.content });
    if (!content.length) continue;
    out.push({ role: 'user', content: content.length === 1 && content[0].type === 'text' ? content[0].text : content });
  }
  return { messages: out, skipped: [...new Set(skipped)] };
}

async function* streamOpenRouter({ model, apiKey, messages, system, signal }) {
  const { messages: body, skipped } = toOpenRouterMessages(messages, system);
  if (skipped.length) yield { type: 'notice', message: `OpenRouter skipped files it can't read: ${skipped.join(', ')}` };

  const res = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': globalThis.location?.origin || 'https://localhost',
      'X-Title': 'Gemini Mobile Studio',
    },
    body: JSON.stringify({ model, messages: body, stream: true }),
    signal,
  });
  if (!res.ok) throw await httpError(res);

  let finishReason = '';
  let gotText = false;
  let gotThought = false;

  for await (const data of sseData(res)) {
    if (data === '[DONE]') break;
    let json;
    try { json = JSON.parse(data); } catch { continue; } // keep-alive comments and partial lines
    if (json.error) {
      throw Object.assign(new Error(json.error.message || 'The stream failed.'), { status: Number(json.error.code) || 500 });
    }
    const choice = json.choices?.[0];
    const delta = choice?.delta ?? {};

    const reasoning = delta.reasoning ?? delta.reasoning_content
      ?? (Array.isArray(delta.reasoning_details) ? delta.reasoning_details.map((d) => d.text || d.summary || '').join('') : '');
    if (reasoning) { gotThought = true; yield { type: 'thought', delta: reasoning }; }
    if (typeof delta.content === 'string' && delta.content) { gotText = true; yield { type: 'text', delta: delta.content }; }

    finishReason = choice?.finish_reason || finishReason;
  }

  if (!gotText && !gotThought) {
    throw Object.assign(
      new Error(finishReason ? `The model returned no text (${finishReason}).` : 'The model returned an empty response.'),
      { fatal: true },
    );
  }
  if (!gotText) yield { type: 'notice', message: `The model finished without an answer${finishReason ? ` (${finishReason})` : ''}.` };
  yield { type: 'done', finishReason };
}

const RUNNERS = { gemini: streamGemini, openrouter: streamOpenRouter };

/* ---------- The engine ---------- */

/** The chosen model first, then a few alternatives, only from providers that have a key. */
function buildAttempts(selected, keys) {
  const attempts = [];
  const seen = new Set();
  const add = (provider, id) => {
    const tag = `${provider}:${id}`;
    if (!id || seen.has(tag) || !keys[provider]) return false;
    seen.add(tag);
    attempts.push({ provider, model: id });
    return true;
  };
  const idsOf = (provider) => {
    const list = getCatalog(provider);
    return (list.length ? list : provider === 'gemini' ? GEMINI_DEFAULTS : []).map((m) => m.id);
  };

  add(selected.provider, selected.id);
  let extra = 0;
  for (const id of idsOf(selected.provider)) {
    if (extra >= SAME_PROVIDER_FALLBACKS) break;
    if (add(selected.provider, id)) extra++;
  }
  const other = PROVIDERS.find((p) => p !== selected.provider);
  extra = 0;
  for (const id of idsOf(other)) {
    if (extra >= OTHER_PROVIDER_FALLBACKS) break;
    if (add(other, id)) extra++;
  }
  return attempts;
}

export async function* streamChat({ messages, system = DEFAULT_SYSTEM_PROMPT, selected, keys, signal }) {
  if (!selected?.id) throw Object.assign(new Error('No model is selected.'), { fatal: true });
  if (!keys?.[selected.provider]) {
    throw Object.assign(
      new Error(`Add your ${PROVIDER_NAMES[selected.provider]} API key first.`),
      { status: 401, fatal: true },
    );
  }

  const attempts = buildAttempts(selected, keys);
  let lastError = null;

  for (let i = 0; i < attempts.length; i++) {
    const target = attempts[i];
    yield { type: 'status', provider: target.provider, model: target.model };

    let produced = false;
    try {
      const run = RUNNERS[target.provider]({
        model: target.model, apiKey: keys[target.provider], messages, system, signal,
      });
      for await (const chunk of run) {
        if (chunk.type === 'text' || chunk.type === 'thought') produced = true;
        yield chunk;
      }
      return;
    } catch (err) {
      if (signal?.aborted || isAbort(err)) return;
      lastError = err;
      if (produced) throw err; // part of an answer is already on screen: don't restart elsewhere
      const next = attempts[i + 1];
      if (!next || !shouldFallback(err)) throw err;
      yield { type: 'fallback', from: target, to: next, reason: String(err?.message ?? err).slice(0, 80) };
    }
  }
  throw lastError ?? new Error('No model is available.');
}
