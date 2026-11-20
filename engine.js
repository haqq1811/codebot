/* ==========================================================================
   engine.js — one chat engine, several providers
   ========================================================================== */

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

const SAME_PROVIDER_FALLBACKS = 2;
const OTHER_PROVIDER_FALLBACKS = 1;

export const PROVIDERS = ['gemini', 'openrouter'];
export const PROVIDER_NAMES = { gemini: 'Google AI Studio', openrouter: 'OpenRouter' };

export const DEFAULT_SYSTEM_PROMPT =
  'You are a helpful, accurate assistant. Reply in clean Markdown. ' +
  'Put code in fenced blocks and always label the language, for example ```python.';

// Flash and Flash-Lite models have a free tier. Google changes the details per model and account,
// so this is a pattern-based hint (works for new versions too) instead of a list that goes stale.
const isGeminiFree = (id) => /^gemini-\d+(?:\.\d+)?-flash(?:-lite)?(?:-\d{2,3})?$/.test(id);

// How hard a request may think / how long it may answer. 'lean' is the default; 'full' = no caps;
// 'helper' is for background summaries and notes.
const EFFORT = {
  full: { thinking: 'default', reasoning: 'medium', maxTokens: 0, timeoutMS: 45_000 },
  lean: { thinking: 'low', reasoning: 'low', maxTokens: 8192, timeoutMS: 20_000 },
  helper: { thinking: 'off', reasoning: 'none', maxTokens: 2048, timeoutMS: 10_000 },
};

export function pricingTag(provider, model) {
  if (provider === 'openrouter') return model.free === true ? ' (Free)' : model.free === false ? ' (Paid)' : '';
  return isGeminiFree(model.id) ? ' (Free tier)' : '';
}

export const modelValue = (provider, id) => `${provider}:${id}`;

export function parseModelValue(value = '') {
  const match = /^(gemini|openrouter):([\s\S]+)$/.exec(value);
  if (match) return { provider: match[1], id: match[2] };
  return { provider: 'gemini', id: value };
}

const catalogs = { gemini: [], openrouter: [] };
export const setCatalog = (provider, models) => { catalogs[provider] = Array.isArray(models) ? models : []; };
export const getCatalog = (provider) => catalogs[provider] ?? [];

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
  } catch {}
  return Object.assign(new Error(message), { status: res.status });
}

const isAbort = (err) => err?.name === 'AbortError';

function shouldFallback(err) {
  if (err?.fatal || err instanceof TypeError) return false;
  const status = Number(err?.status) || null;
  if ([401, 403, 413].includes(status)) return false;
  if (status === 400) return /model/i.test(err.message) && /not found|not supported|unsupported|invalid/i.test(err.message);
  return true;
}

export async function fetchGeminiModels(apiKey, signal) {
  const models = [];
  let pageToken = '';
  for (let page = 0; page < 5; page++) {
    const url = `${GEMINI_BASE}/models?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const res = await fetchWithTimeout(url, { headers: { 'x-goog-api-key': apiKey }, signal, timeout: 15000 });
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

const GEMINI_SKIP = /(embedding|aqa|imagen|veo|tts|image|live|audio|robotics|computer-use|learnlm|gemma|vision|omni|lyria|deep-research)/i;

export function orderGeminiModels(models) {
  const rank = (id) => {
    const v = /^gemini-(\d+(?:\.\d+)?)/.exec(id);
    return {
      cost: isGeminiFree(id) ? 0 : 1,
      version: v ? parseFloat(v[1]) : 0,
      preview: /preview|exp/.test(id) ? 1 : 0,
      tier: /flash-lite/.test(id) ? 1 : /flash/.test(id) ? 0 : /pro/.test(id) ? 2 : 3,
    };
  };
  return models
    .filter((m) => /^gemini-/.test(m.id) && !GEMINI_SKIP.test(m.id))
    .map((m) => ({ m, r: rank(m.id) }))
    .sort((a, b) =>
      a.r.cost - b.r.cost || b.r.version - a.r.version || a.r.preview - b.r.preview || a.r.tier - b.r.tier || a.m.id.localeCompare(b.m.id))
    .map((x) => x.m);
}

export async function fetchOpenRouterModels(signal) {
  const res = await fetchWithTimeout(`${OPENROUTER_BASE}/models`, { signal, timeout: 15000 });
  if (!res.ok) throw await httpError(res);
  const data = await res.json();
  const price = (v) => (v == null || v === '' ? NaN : Number(v));
  return (data.data ?? []).map((m) => {
    const prompt = price(m.pricing?.prompt);
    const completion = price(m.pricing?.completion);
    const priced = Number.isFinite(prompt) && Number.isFinite(completion);
    return {
      id: m.id,
      label: (m.name || m.id).replace(/\s*\(free\)\s*$/i, ''),
      free: /:free$/.test(m.id) || (priced && prompt === 0 && completion === 0) ? true : priced ? false : null,
      ctx: m.context_length ?? 0,
      input: m.architecture?.input_modalities ?? ['text'],
      output: m.architecture?.output_modalities ?? ['text'],
    };
  });
}

export function orderOpenRouterModels(models) {
  return models
    .filter((m) => m.output.includes('text'))
    .sort((a, b) => Number(b.free) - Number(a.free) || a.label.localeCompare(b.label));
}

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
    try { await reader.cancel(); } catch {}
  }
}

async function fetchWithTimeout(resource, options = {}) {
  const { timeout = 25000 } = options;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);

  let combinedSignal = controller.signal;
  if (options.signal) {
    // AbortSignal.any is missing on older Android WebViews, so fall back to forwarding the abort.
    if (typeof AbortSignal.any === 'function') combinedSignal = AbortSignal.any([options.signal, controller.signal]);
    else if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    return await fetch(resource, { ...options, signal: combinedSignal });
  } finally {
    clearTimeout(id);
  }
}

function fileAsText(f) {
  const text = String(f.text ?? '');
  const runs = text.match(/`+/g);
  const longest = runs ? Math.max(...runs.map((r) => r.length)) : 0;
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `File: ${f.name}\n${fence}\n${text}\n${fence}`;
}

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
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  }
  return contents;
}

function geminiThinkingConfig(model, mode) {
  const cfg = {};
  if (mode !== 'off') cfg.includeThoughts = true; // background helpers never need to show thoughts
  if (mode === 'default') return cfg;
  // 2.5 Pro cannot switch thinking off (minimum 128). Flash-Lite doesn't think unless asked, so it is left alone.
  const g25 = /^gemini-2\.5-(flash|pro)(?!-lite)/.exec(model);
  if (g25) cfg.thinkingBudget = mode === 'off' ? (g25[1] === 'pro' ? 128 : 0) : 1024;
  else if (/^gemini-[3-9]/.test(model)) cfg.thinkingLevel = 'low';
  return cfg;
}

async function* streamGemini({ model, apiKey, messages, system, signal, webSearch, effort }) {
  let useThinking = true;
  let res;
  for (;;) {
    const body = { contents: toGeminiContents(messages) };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    const gen = {};
    if (effort.maxTokens) gen.maxOutputTokens = effort.maxTokens;
    if (useThinking) {
      const thinking = geminiThinkingConfig(model, effort.thinking);
      if (Object.keys(thinking).length) gen.thinkingConfig = thinking;
    }
    if (Object.keys(gen).length) body.generationConfig = gen;
    if (webSearch) body.tools = [{ googleSearch: {} }];

    res = await fetchWithTimeout(`${GEMINI_BASE}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal,
      timeout: effort?.timeoutMS,
    });

    if (res.ok) break;
    const err = await httpError(res);
    if (useThinking && err.status === 400 &&
        /thinkingConfig|includeThoughts|thinkingBudget|thinkingLevel|thinking (?:is )?not supported|does not support thinking/i.test(err.message)) {
      useThinking = false; // this model rejects the thinking settings: retry once without them
      continue;
    }
    throw err;
  }

  let finishReason = '';
  let blockReason = '';
  let gotText = false;
  let gotThought = false;
  let usage = null;

  for await (const data of sseData(res)) {
    let json;
    try { json = JSON.parse(data); } catch { continue; }
    if (json.error) {
      throw Object.assign(new Error(json.error.message || 'The stream failed.'), { status: Number(json.error.code) || 500 });
    }
    blockReason = json.promptFeedback?.blockReason || blockReason;
    usage = json.usageMetadata ?? usage;
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
      { fatal: true },
    );
  }
  if (!gotText) yield { type: 'notice', message: `The model finished without an answer${finishReason ? ` (${finishReason})` : ''}.` };
  if (usage) {
    yield {
      type: 'usage',
      promptTokens: usage.promptTokenCount ?? 0,
      outputTokens: usage.candidatesTokenCount ?? 0,
      thoughtTokens: usage.thoughtsTokenCount ?? 0,
    };
  }
  yield { type: 'done', finishReason };
}

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

async function* streamOpenRouter({ model, apiKey, messages, system, signal, webSearch, effort }) {
  const { messages: body, skipped } = toOpenRouterMessages(messages, system);
  if (skipped.length) yield { type: 'notice', message: `OpenRouter skipped files it can't read: ${skipped.join(', ')}` };

  const payload = { model, messages: body, stream: true };
  if (effort.maxTokens) payload.max_tokens = effort.maxTokens;
  if (effort.reasoning) payload.reasoning = { effort: effort.reasoning };
  if (webSearch) payload.plugins = [{ id: 'web', max_results: 3 }]; // the plugin is billed per result

  const res = await fetchWithTimeout(`${OPENROUTER_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': globalThis.location?.origin || 'https://localhost',
      'X-Title': 'Gemini Mobile Studio',
    },
    body: JSON.stringify(payload),
    signal,
    timeout: effort?.timeoutMS,
  });
  if (!res.ok) throw await httpError(res);

  let finishReason = '';
  let gotText = false;
  let gotThought = false;
  let usage = null;

  for await (const data of sseData(res)) {
    if (data === '[DONE]') break;
    let json;
    try { json = JSON.parse(data); } catch { continue; }
    if (json.error) {
      throw Object.assign(new Error(json.error.message || 'The stream failed.'), { status: Number(json.error.code) || 500 });
    }
    if (json.usage) usage = json.usage;
    const choice = json.choices?.[0];
    const delta = choice?.delta ?? {};

    const reasoning = delta.reasoning ?? delta.reasoning_content
      ?? (Array.isArray(delta.reasoning_details) ? delta.reasoning_details.map((d) => d.text || d.summary || '').join('') : '');
    if (reasoning) { gotThought = true; yield { type: 'thought', delta: reasoning }; }

    if (typeof delta.content === 'string' && delta.content) {
      gotText = true;
      yield { type: 'text', delta: delta.content };
    } else if (Array.isArray(delta.content)) {
      for (const part of delta.content) {
        if (part?.type === 'text' && typeof part.text === 'string' && part.text) {
          gotText = true;
          yield { type: 'text', delta: part.text };
        }
      }
    }

    finishReason = choice?.finish_reason || finishReason;
  }

  if (!gotText && !gotThought) {
    throw Object.assign(
      new Error(finishReason ? `The model returned no text (${finishReason}).` : 'The model returned an empty response.'),
      { fatal: true },
    );
  }
  if (!gotText) yield { type: 'notice', message: `The model finished without an answer${finishReason ? ` (${finishReason})` : ''}.` };
  if (usage) {
    const thinking = usage.completion_tokens_details?.reasoning_tokens ?? 0;
    yield {
      type: 'usage',
      promptTokens: usage.prompt_tokens ?? 0,
      outputTokens: Math.max((usage.completion_tokens ?? 0) - thinking, 0),
      thoughtTokens: thinking,
    };
  }
  yield { type: 'done', finishReason };
}

const RUNNERS = { gemini: streamGemini, openrouter: streamOpenRouter };

/* ---------- Fallback planning ----------
   Fallbacks come ONLY from the live (or last cached) catalog, never from a hardcoded list, so
   they can't name models that were retired. Models that just failed are put on a cooldown so
   they are not picked again. OpenRouter fallbacks are free models only (no surprise charges)
   that can actually read what is attached. */

const COOLDOWN_KEY = 'MODEL_COOLDOWNS_V1';
const GONE_MS = 6 * 60 * 60 * 1000; // 404 / "no endpoints" / retired
const BUSY_MS = 2 * 60 * 1000;      // 429 / 5xx / timeout

function readCooldowns() {
  try {
    const map = JSON.parse(localStorage.getItem(COOLDOWN_KEY)) || {};
    const now = Date.now();
    for (const k of Object.keys(map)) if (!(map[k] > now)) delete map[k];
    return map;
  } catch { return {}; }
}
function coolDown(provider, id, ms) {
  try {
    const map = readCooldowns();
    map[`${provider}:${id}`] = Date.now() + ms;
    localStorage.setItem(COOLDOWN_KEY, JSON.stringify(map));
  } catch {}
}

const statusOf = (err) => Number(err?.status) || 0;
const messageOf = (err) => String(err?.message ?? '');
const isGone = (err) => statusOf(err) === 404
  || /no endpoints found|no longer available|not found for api|is not found|does not exist|has been (?:removed|retired|deprecated)/i.test(messageOf(err));
const isBusy = (err) => statusOf(err) === 429 || statusOf(err) >= 500 || /took too long/i.test(messageOf(err));

function requirementsOf(messages) {
  const needs = new Set();
  let chars = 0;
  for (const m of messages) {
    chars += m.content?.length ?? 0;
    for (const f of m.files ?? []) {
      chars += f.text?.length ?? 0;
      const mime = f.mime || '';
      if (f.data && mime.startsWith('image/')) needs.add('image');
      else if (f.data && mime === 'application/pdf') needs.add('file');
      else if (f.data && AUDIO_FORMATS[mime]) needs.add('audio');
    }
  }
  return { needs, tokens: Math.ceil(chars / 3.5) };
}

// Fast models first. Reasoning-heavy models (R1, "thinking", o1/o3) burn many tokens, so they go last.
const OPENROUTER_PREFERRED = [/llama-3\.3/i, /qwen/i, /gemma/i];
const OPENROUTER_HEAVY = /\br1\b|thinking|reason|\bo[13]\b/i;
const openRouterRank = (id) => {
  if (OPENROUTER_HEAVY.test(id)) return OPENROUTER_PREFERRED.length + 1;
  const i = OPENROUTER_PREFERRED.findIndex((re) => re.test(id));
  return i < 0 ? OPENROUTER_PREFERRED.length : i;
};
const isStable = (id) => !/preview|exp/i.test(id);

// Gemini fallbacks are Flash models only: cheap, fast, and never the forced-thinking Pro models.
function geminiCandidates(skip) {
  const live = getCatalog('gemini').filter((m) => /flash/i.test(m.id) && !skip(`gemini:${m.id}`));
  return [...live.filter((m) => isStable(m.id)), ...live.filter((m) => !isStable(m.id))].map((m) => m.id);
}

function openRouterCandidates(skip, { needs, tokens }) {
  const rank = openRouterRank;
  return getCatalog('openrouter')
    .filter((m) => m.free === true && !skip(`openrouter:${m.id}`))
    .filter((m) => [...needs].every((n) => (m.input ?? ['text']).includes(n)))
    .filter((m) => !m.ctx || m.ctx >= Math.max(8000, tokens * 1.15 + 1500))
    .sort((a, b) => rank(a.id) - rank(b.id) || (b.ctx || 0) - (a.ctx || 0))
    .map((m) => m.id);
}

export function buildAttempts(selected, keys, req = { needs: new Set(), tokens: 0 }) {
  const cooling = readCooldowns();
  const skip = (tag) => tag in cooling;
  const attempts = [];
  const seen = new Set();
  const add = (provider, id) => {
    const tag = `${provider}:${id}`;
    if (!id || seen.has(tag) || !keys[provider]) return false;
    seen.add(tag);
    attempts.push({ provider, model: id });
    return true;
  };
  const candidates = (provider) => (provider === 'gemini' ? geminiCandidates(skip) : openRouterCandidates(skip, req));

  // The user's own choice is tried first, even when it was rate-limited a moment ago. Only a model
  // that was reported as gone (404, a 6h cooldown) is skipped, so we don't send a request that can't work.
  const selectedTag = `${selected.provider}:${selected.id}`;
  const retired = (cooling[selectedTag] ?? 0) - Date.now() > BUSY_MS;
  if (!retired) add(selected.provider, selected.id);
  let extra = 0;
  for (const id of candidates(selected.provider)) {
    if (extra >= SAME_PROVIDER_FALLBACKS) break;
    if (add(selected.provider, id)) extra++;
  }
  const other = PROVIDERS.find((p) => p !== selected.provider);
  extra = 0;
  for (const id of candidates(other)) {
    if (extra >= OTHER_PROVIDER_FALLBACKS) break;
    if (add(other, id)) extra++;
  }
  if (!attempts.length) add(selected.provider, selected.id);
  return attempts;
}

export async function* streamChat({ messages, system = DEFAULT_SYSTEM_PROMPT, selected, keys, signal, webSearch, effort = 'lean', fallbacks = true }) {
  if (!selected?.id) throw Object.assign(new Error('No model is selected.'), { fatal: true });
  if (!keys?.[selected.provider]) {
    throw Object.assign(
      new Error(`Add your ${PROVIDER_NAMES[selected.provider]} API key first.`),
      { status: 401, fatal: true },
    );
  }

  const profile = EFFORT[effort] ?? EFFORT.lean;
  const attempts = fallbacks
    ? buildAttempts(selected, keys, requirementsOf(messages))
    : [{ provider: selected.provider, model: selected.id }];
  let lastError = null;
  let best = null; // the most informative failure, so a phantom model's 404 can't hide the real cause

  for (let i = 0; i < attempts.length; i++) {
    const target = attempts[i];
    yield { type: 'status', provider: target.provider, model: target.model };

    let produced = false;
    try {
      const run = RUNNERS[target.provider]({
        model: target.model, apiKey: keys[target.provider], messages, system, signal, webSearch, effort: profile,
      });
      for await (const chunk of run) {
        if (chunk.type === 'text' || chunk.type === 'thought') produced = true;
        yield chunk;
      }
      return;
    } catch (err) {
      if (signal?.aborted) return;

      lastError = err?.name === 'AbortError' ? new Error('Model took too long to respond.') : err;
      if (produced) throw lastError;

      if (isGone(lastError)) coolDown(target.provider, target.model, GONE_MS);
      else if (isBusy(lastError)) coolDown(target.provider, target.model, BUSY_MS);

      // A bad key on a fallback provider only rules out that provider; keep going.
      const authOnFallback = i > 0 && [401, 403].includes(statusOf(lastError));
      if (!shouldFallback(lastError) && !authOnFallback) throw lastError;

      const rank = i > 0 && (isGone(lastError) || authOnFallback) ? 0 : 1;
      if (!best || rank > best.rank) best = { err: lastError, rank };

      const next = attempts[i + 1];
      if (!next) break;
      yield { type: 'fallback', from: target, to: next, reason: messageOf(lastError).slice(0, 80) };
    }
  }
  throw best?.err ?? lastError ?? new Error('No model is available.');
}

/**
 * Cheap model for background summaries and notes. Returns null when nothing cheap is known,
 * and the caller then skips the upkeep instead of quietly spending the user's chosen model.
 */
export function pickHelperModel(keys) {
  const cooling = readCooldowns();
  if (keys.gemini) {
    const ids = getCatalog('gemini').map((m) => m.id).filter((i) => !(`gemini:${i}` in cooling));
    const id = ids.find((i) => isGeminiFree(i) && /flash-lite/.test(i)) || ids.find((i) => isGeminiFree(i));
    if (id) return { provider: 'gemini', id };
  }
  if (keys.openrouter) {
    const pick = getCatalog('openrouter')
      .filter((m) => m.free === true && !(`openrouter:${m.id}` in cooling) && (m.input ?? ['text']).includes('text') && (!m.ctx || m.ctx >= 16000))
      .sort((a, b) => openRouterRank(a.id) - openRouterRank(b.id) || (b.ctx || 0) - (a.ctx || 0))[0];
    if (pick) return { provider: 'openrouter', id: pick.id };
  }
  return null;
}

export async function completeOnce({ system, prompt, selected, keys, signal, timeoutMs = 20_000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', () => controller.abort(), { once: true });
  try {
    let text = '';
    const stream = streamChat({
      messages: [{ role: 'user', content: prompt }],
      system,
      selected,
      keys,
      signal: controller.signal,
      effort: 'helper',
      fallbacks: false, // one cheap attempt; a failing helper must not cascade into more requests
    });
    for await (const chunk of stream) {
      if (chunk.type === 'text') text += chunk.delta;
    }
    if (controller.signal.aborted) throw new Error('Helper model timed out');
    return text;
  } finally {
    clearTimeout(timer);
  }
}
