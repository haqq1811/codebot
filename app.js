import { keyStore, memoryStore, loadCatalogCache, saveCatalogCache, removeCatalogCache } from './storage.js';
import {
  streamChat, fetchOpenRouterModels, fetchGeminiModels, setCatalog, getCatalog,
  orderOpenRouterModels, orderGeminiModels, parseModelValue, modelValue,
  GEMINI_DEFAULTS, DEFAULT_SYSTEM_PROMPT, PROVIDER_NAMES, pricingTag,
  completeOnce, pickHelperModel,
} from './engine.js';
import { prepareRequest, maintain, mergeNotes } from './memory.js';

const STORAGE = { model: 'GEMINI_MODEL', sidebar: 'GEMINI_SIDEBAR_OPEN' };
const DB_NAME = 'ChatHistoryDB';
const DB_VERSION = 2; // Upgraded to separate attachments
const STORE_SESSIONS = 'sessions';
const STORE_ATTACHMENTS = 'attachments';

const MAX_INLINE_BYTES = 19 * 1024 * 1024;
const TITLE_MAX = 30;
const STICK_THRESHOLD = 80;
const STREAM_PAINT_MS = 100;
const THUMB_SIZE = 192;

const KIND_ICON = { image: 'image', video: 'play', audio: 'music', text: 'code', pdf: 'file', file: 'file' };
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'xml', 'html', 'htm', 'css', 'scss',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'ipynb', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs',
  'go', 'rs', 'rb', 'php', 'swift', 'sh', 'bash', 'sql', 'yaml', 'yml', 'toml', 'ini', 'cfg',
  'env', 'log', 'rtf', 'tex', 'r', 'lua', 'dart', 'vue', 'svelte',
]);
const MIME_BY_EXT = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  gif: 'image/gif', heic: 'image/heic', heif: 'image/heif', mp3: 'audio/mp3', wav: 'audio/wav',
  ogg: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac', m4a: 'audio/aac', mp4: 'video/mp4',
  mov: 'video/mov', webm: 'video/webm', mpeg: 'video/mpeg', avi: 'video/avi',
};

const $ = (id) => document.getElementById(id);
const els = {
  chatBox: $('chat-box'), emptyState: $('empty-state'), emptyKeyBtn: $('empty-key-btn'),
  userInput: $('user-input'), sendBtn: $('send-btn'), attachBtn: $('attach-btn'), fileInput: $('file-input'),
  filePreviewBar: $('file-preview-bar'), thumbStrip: $('thumb-strip'), fileNameDisplay: $('file-name-display'), removeFileBtn: $('remove-file-btn'),
  modelSelect: $('model-select'), clearChatBtn: $('clear-chat-btn'), keyBtn: $('key-btn'),
  keyModal: $('key-modal'), apiKeyInput: $('api-key-input'), saveKeyBtn: $('save-key-btn'),
  closeKeyBtn: $('close-key-btn'), removeKeyBtn: $('remove-key-btn'), toggleKeyBtn: $('toggle-key-btn'),
  menuBtn: $('menu-btn'), sidebar: $('sidebar'), overlay: $('sidebar-overlay'), newChatBtn: $('new-chat-btn'),
  historyList: $('history-list'), toast: $('toast'),
  ctxMenu: $('context-menu'), ctxCopy: $('ctx-copy'), ctxRetry: $('ctx-retry')
};
const state = {
  history: [], ui: [], attachments: [], pendingReads: new Set(),
  sessionId: newId(), generating: false, abort: null,
  summary: '', summarizedCount: 0, notesCursor: 0, memoryBusy: false, memoryRerun: false,
};

let nextAttachmentId = 0, stickToBottom = true, toastTimer = 0, lastFocus = null;
let ctxTargetIndex = -1; // For long press menu

/* ---------- Helpers ---------- */
const SVG_NS = 'http://www.w3.org/2000/svg';
function newId() { return Date.now().toString(); }
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  remove(k) { try { localStorage.removeItem(k); } catch {} },
};
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}
function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'icon'); svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use'); use.setAttribute('href', `#i-${name}`);
  svg.append(use); return svg;
}
function escapeHTML(str) {
  return str.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
function getExt(name) { const i = name.lastIndexOf('.'); return i > -1 ? name.slice(i + 1).toLowerCase() : ''; }
function toast(message, ms = 3200) {
  els.toast.textContent = message; els.toast.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => els.toast.classList.remove('show'), ms);
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  try {
    const ta = el('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.append(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); return ok;
  } catch { return false; }
}
function makeThrottle(fn, wait) {
  let timer = 0, last = performance.now() - wait;
  const run = () => { timer = 0; last = performance.now(); fn(); };
  const throttled = () => { if (timer) return; const delay = Math.max(0, wait - (performance.now() - last)); timer = setTimeout(run, delay); };
  throttled.cancel = () => { clearTimeout(timer); timer = 0; };
  return throttled;
}
const modelIds = () => [...els.modelSelect.options].map((o) => o.value);

/* ---------- Catalog & Model Dropdown ---------- */
const CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;
async function refreshCatalogs({ force = false } = {}) {
  const keys = keyStore.all(), cached = loadCatalogCache(), errors = {}, jobs = [];
  const isFresh = (p) => !force && cached[p]?.models?.length > 0 && Date.now() - (cached[p].ts ?? 0) < CATALOG_MAX_AGE_MS;

  if (keys.openrouter && isFresh('openrouter')) setCatalog('openrouter', cached.openrouter.models);
  if (keys.gemini && isFresh('gemini')) setCatalog('gemini', cached.gemini.models);

  if (keys.openrouter && !isFresh('openrouter')) {
    jobs.push((async () => {
      try { const ordered = orderOpenRouterModels(await fetchOpenRouterModels()); setCatalog('openrouter', ordered); saveCatalogCache('openrouter', ordered); }
      catch (err) { errors.openrouter = err; }
    })());
  }
  if (keys.gemini && !isFresh('gemini')) {
    jobs.push((async () => {
      try { const ordered = orderGeminiModels(await fetchGeminiModels(keys.gemini)); setCatalog('gemini', ordered); saveCatalogCache('gemini', ordered); }
      catch (err) { errors.gemini = err; }
    })());
  }
  await Promise.all(jobs); renderModelDropdown(); return errors;
}

function renderModelDropdown() {
  const select = els.modelSelect, keys = keyStore.all(), cached = loadCatalogCache();
  const pick = (p, f) => getCatalog(p).length ? getCatalog(p) : cached[p]?.models?.length ? cached[p].models : f;
  const groups = [
    { provider: 'gemini', label: 'Google AI Studio', models: pick('gemini', GEMINI_DEFAULTS) },
    { provider: 'openrouter', label: 'OpenRouter', models: pick('openrouter', []) },
  ];
  groups.sort((a, b) => Number(Boolean(keys[b.provider])) - Number(Boolean(keys[a.provider])));

  select.replaceChildren();
  for (const { provider, label, models } of groups) {
    if (!models.length) continue;
    const group = el('optgroup'); group.label = label;
    for (const m of models) {
      const opt = el('option', '', `${m.label || m.id}${pricingTag(provider, m)}`);
      opt.value = modelValue(provider, m.id); group.append(opt);
    }
    select.append(group);
  }
  const saved = store.get(STORAGE.model), ids = modelIds();
  const wanted = saved && [saved, modelValue('gemini', saved)].find((v) => ids.includes(v));
  if (wanted) select.value = wanted;
}

/* ---------- API keys ---------- */
const keyInputs = { gemini: els.apiKeyInput, openrouter: $('openrouter-key-input') };
function openKeyModal() {
  lastFocus = document.activeElement; const keys = keyStore.all();
  for (const [p, input] of Object.entries(keyInputs)) { if (!input) continue; input.value = keys[p] || ''; input.type = 'password'; }
  els.toggleKeyBtn.textContent = 'Show'; els.toggleKeyBtn.setAttribute('aria-pressed', 'false');
  els.removeKeyBtn.hidden = !(keys.gemini || keys.openrouter);
  els.keyModal.hidden = false; keyInputs.gemini?.focus();
}
function closeKeyModal() { els.keyModal.hidden = true; lastFocus?.focus?.(); lastFocus = null; }
async function saveKey() {
  for (const [p, input] of Object.entries(keyInputs)) { if (!input) continue; const v = input.value.trim(); if (v) keyStore.set(p, v); else keyStore.remove(p); }
  closeKeyModal(); toast('Updating model lists…');
  const errors = await refreshCatalogs({ force: true }); syncEmptyState();
  const rejected = Object.entries(errors).find(([, err]) => [400, 401, 403].includes(Number(err?.status)));
  const offline = Object.values(errors).some((err) => err instanceof TypeError || /failed to fetch|network/i.test(err?.message ?? ''));
  if (rejected) toast(`${PROVIDER_NAMES[rejected[0]]} rejected that key. Open Key and check it.`, 4500);
  else if (offline) toast('Keys saved, but model lists could not refresh. Retry when online.', 4500);
  else toast('Keys saved.', 3000);
}
function removeKey() {
  keyStore.remove('gemini'); keyStore.remove('openrouter');
  for (const p of ['gemini', 'openrouter']) { setCatalog(p, []); removeCatalogCache(p); }
  closeKeyModal(); renderModelDropdown(); syncEmptyState(); toast('API keys removed.');
}
function syncEmptyState() {
  const keys = keyStore.all();
  els.emptyState.hidden = Boolean(els.chatBox.querySelector('.msg'));
  els.emptyKeyBtn.hidden = Boolean(keys.gemini || keys.openrouter);
}

/* ---------- Attachments ---------- */
const mimeFor = (file) => file.type || MIME_BY_EXT[getExt(file.name)] || 'application/octet-stream';
const isTextFile = (file) => file.type.startsWith('text/') || /json|xml|javascript|yaml|x-sh/.test(file.type) || TEXT_EXTENSIONS.has(getExt(file.name));
function fileKind(file) {
  const mime = mimeFor(file);
  if (mime.startsWith('image/')) return 'image';
  if (isTextFile(file)) return 'text';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'pdf';
  return 'file';
}
function extLabel(file, kind) {
  const fallback = { image: 'IMG', video: 'VID', audio: 'AUD', pdf: 'PDF', text: 'TXT' }[kind] || 'FILE';
  return getExt(file.name).toUpperCase().slice(0, 5) || fallback;
}
function readFile(file, mode) {
  return new Promise((res, rej) => {
    const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error);
    if (mode === 'text') r.readAsText(file); else r.readAsDataURL(file);
  });
}
async function readContent(file) {
  if (isTextFile(file)) { const text = await readFile(file, 'text'); return { data: null, text, bytes: text.length }; }
  const dataUrl = await readFile(file, 'dataURL'); const data = dataUrl.slice(dataUrl.indexOf(',') + 1);
  return { data, text: null, bytes: data.length };
}
function drawThumb(source, w, h) {
  if (!w || !h) return null;
  const scale = Math.min(1, THUMB_SIZE / Math.max(w, h));
  const c = el('canvas'); c.width = Math.max(1, Math.round(w * scale)); c.height = Math.max(1, Math.round(h * scale));
  const ctx = c.getContext('2d'); ctx.fillStyle = '#2b2b2b'; ctx.fillRect(0, 0, c.width, c.height); ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, c.width, c.height); return c.toDataURL('image/jpeg', 0.82);
}
async function imageThumb(file) {
  const url = URL.createObjectURL(file);
  try { const img = new Image(); img.src = url; await img.decode(); return drawThumb(img, img.naturalWidth || 300, img.naturalHeight || 300); }
  finally { URL.revokeObjectURL(url); }
}
function videoThumb(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file), video = el('video'); let timer = 0;
    const done = (thumb) => { clearTimeout(timer); video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); resolve(thumb); };
    timer = setTimeout(() => done(null), 6000); video.muted = true; video.playsInline = true; video.preload = 'metadata';
    video.addEventListener('error', () => done(null), { once: true });
    video.addEventListener('loadedmetadata', () => { video.currentTime = Math.min(0.5, (video.duration || 1) / 2); }, { once: true });
    video.addEventListener('seeked', () => { try { done(drawThumb(video, video.videoWidth, video.videoHeight)); } catch { done(null); } }, { once: true });
    video.src = url;
  });
}
function makeThumb(file, kind) {
  const work = kind === 'image' ? imageThumb(file) : kind === 'video' ? videoThumb(file) : null;
  return Promise.resolve(work).catch(() => null);
}
function thumbMedia({ thumb = null, kind = 'file', ext = 'FILE' }) {
  const media = el('div', `thumb-media kind-${kind}`);
  if (thumb) {
    const img = el('img'); img.src = thumb; img.alt = ''; img.draggable = false; media.append(img);
    if (kind === 'video') media.append(el('span', 'thumb-badge')); if (kind === 'video') media.lastChild.append(icon('play'));
  } else {
    media.classList.add('is-tile'); media.append(icon(KIND_ICON[kind] ?? 'file'), el('span', 'thumb-ext', ext));
  }
  return media;
}
function addFiles(fileList) {
  const files = Array.from(fileList || []); if (!files.length) return;
  const job = (async () => {
    const staged = []; let skipped = 0;
    for (const file of files) {
      const key = `${file.name}|${file.size}|${file.lastModified}`;
      if (state.attachments.some((a) => a.key === key)) { skipped++; continue; }
      if (!file.size) { toast(`${file.name} is empty.`); continue; }
      const sentSize = isTextFile(file) ? file.size : Math.ceil(file.size * 4 / 3);
      if (sentSize > MAX_INLINE_BYTES) { toast(`${file.name} is over the limit.`); continue; }
      const kind = fileKind(file);
      const att = { id: ++nextAttachmentId, key, kind, name: file.name, size: file.size, ext: extLabel(file, kind), mime: mimeFor(file), thumb: null, data: null, text: null, bytes: 0, loading: true };
      state.attachments.push(att); staged.push({ att, file });
    }
    renderAttachments();
    for (const { att, file } of staged) {
      try {
        const [thumb, content] = await Promise.all([makeThumb(file, att.kind), readContent(file)]);
        if (!state.attachments.includes(att)) continue;
        Object.assign(att, { thumb, ...content, loading: false });
      } catch (err) { state.attachments = state.attachments.filter((a) => a !== att); toast(`Could not read ${file.name}.`); }
      renderAttachments();
    }
    if (skipped) toast(`${skipped} file(s) were already attached.`);
  })();
  state.pendingReads.add(job); job.finally(() => { state.pendingReads.delete(job); renderAttachments(); });
}
const pendingBytes = () => state.attachments.reduce((s, a) => s + a.bytes, 0);
function removeAttachment(id) { state.attachments = state.attachments.filter((a) => a.id !== id); renderAttachments(); }
function clearAttachments() { state.attachments = []; els.fileInput.value = ''; renderAttachments(); }
const thumbNodes = new Map();
function buildThumb(att) {
  const node = el('div', 'thumb'); node.setAttribute('role', 'listitem'); node.setAttribute('aria-label', att.name); node.title = att.name;
  const remove = el('button', 'thumb-remove'); remove.type = 'button'; remove.setAttribute('aria-label', `Remove ${att.name}`);
  remove.append(icon('close')); remove.addEventListener('click', () => removeAttachment(att.id));
  node.append(thumbMedia(att), remove); node._thumb = att.thumb; return node;
}
function updateThumb(node, att) {
  node.classList.toggle('is-loading', att.loading);
  if (node._thumb !== att.thumb) { node.firstChild.replaceWith(thumbMedia(att)); node._thumb = att.thumb; }
}
function renderAttachments() {
  const live = new Set(state.attachments.map((a) => a.id));
  for (const [id, node] of thumbNodes) { if (!live.has(id)) { node.remove(); thumbNodes.delete(id); } }
  let added = false;
  for (const att of state.attachments) {
    let node = thumbNodes.get(att.id);
    if (!node) { node = buildThumb(att); thumbNodes.set(att.id, node); els.thumbStrip.append(node); added = true; }
    updateThumb(node, att);
  }
  const count = state.attachments.length, total = state.attachments.reduce((s, a) => s + a.size, 0);
  const loading = state.attachments.some((a) => a.loading);
  els.filePreviewBar.hidden = count === 0; els.removeFileBtn.hidden = count === 0;
  els.fileNameDisplay.textContent = loading ? 'Reading files…' : `Attached: ${count} file(s), ${formatBytes(total)}`;
  if (added) els.thumbStrip.scrollLeft = els.thumbStrip.scrollWidth;
}
function estimateBytes(turns) {
  let total = 0; for (const turn of turns) { total += turn.content?.length ?? 0; for (const f of turn.files ?? []) total += (f.data?.length ?? 0) + (f.text?.length ?? 0); } return total;
}
async function waitForAttachments() {
  let guard = 0; while (state.pendingReads.size && guard++ < 50) await Promise.allSettled([...state.pendingReads]);
  if (state.attachments.some((a) => a.loading)) { toast('Some files are still loading.', 4000); return false; } return true;
}

/* ---------- Rendering ---------- */
function renderMarkdown(markdown) {
  const canRender = typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined';
  if (!canRender) return `<p style="white-space:pre-wrap">${escapeHTML(markdown)}</p>`;
  return DOMPurify.sanitize(marked.parse(markdown));
}
if (typeof DOMPurify !== 'undefined') {
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer'); }
  });
}
function highlightCode(code, lang) {
  try { if (typeof hljs !== 'undefined' && lang && hljs.getLanguage(lang)) hljs.highlightElement(code); } catch {}
}
function enhanceContent(root) {
  root.querySelectorAll('pre').forEach((pre) => {
    if (pre.parentElement.classList.contains('code-block')) return;
    const code = pre.querySelector('code'), lang = code?.className.match(/language-([\w+#-]+)/)?.[1] || '';
    if (code) highlightCode(code, lang);
    const copy = el('button', 'copy-btn', 'Copy'); copy.type = 'button'; copy.setAttribute('aria-label', 'Copy code');
    copy.addEventListener('click', async () => {
      const ok = await copyText((code ?? pre).textContent);
      copy.textContent = ok ? 'Copied!' : 'Failed'; setTimeout(() => { copy.textContent = 'Copy'; }, 2000);
    });
    const wrapper = el('div', 'code-block'); pre.replaceWith(wrapper);
    wrapper.append(el('span', 'code-lang', lang || 'code'), copy, pre);
  });
  root.querySelectorAll('table').forEach((table) => {
    if (table.parentElement.classList.contains('table-wrap')) return;
    const wrap = el('div', 'table-wrap'); table.replaceWith(wrap); wrap.append(table);
  });
}
function createMessage(role) {
  const msg = el('div', `msg ${role}`); els.chatBox.append(msg); els.emptyState.hidden = true; return msg;
}
function scrollToBottom(force = false) { if (force) stickToBottom = true; if (stickToBottom) els.chatBox.scrollTop = els.chatBox.scrollHeight; }
function clearTranscript() { els.chatBox.querySelectorAll('.msg').forEach((n) => n.remove()); syncEmptyState(); }

function attachMessageActions(msgNode, content, index, isUser = false) {
  const actionBar = el('div', 'msg-actions');
  
  const copyBtn = el('button'); copyBtn.title = 'Copy';
  copyBtn.append(icon('copy'), 'Copy');
  copyBtn.addEventListener('click', async () => {
    const ok = await copyText(content);
    toast(ok ? 'Copied to clipboard.' : 'Copy failed.');
  });

  const shareBtn = el('button'); shareBtn.title = 'Share';
  shareBtn.append(icon('share'), 'Share');
  shareBtn.addEventListener('click', async () => {
    if (navigator.share) {
      try { await navigator.share({ text: content }); } catch {}
    } else { await copyText(content); toast('Sharing not supported. Copied instead.'); }
  });

  const retryBtn = el('button'); retryBtn.title = 'Retry';
  retryBtn.append(icon('refresh'), 'Retry');
  retryBtn.addEventListener('click', () => retryFrom(index));

  actionBar.append(copyBtn, shareBtn, retryBtn);
  msgNode.append(actionBar);
}

function renderUserMessage({ text = '', files = [] }, index) {
  const msg = createMessage('user');
  if (files.length) {
    const list = el('div', 'msg-files');
    files.forEach((file) => {
      const thumb = el('div', 'msg-thumb'); thumb.title = file.name; thumb.append(thumbMedia(file)); list.append(thumb);
    });
    msg.append(list);
  }
  if (text) msg.append(document.createTextNode(text));
  
  // Long press logic
  let pressTimer;
  msg.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return; // mouse uses right click
    pressTimer = setTimeout(() => {
      showContextMenu(e.clientX, e.clientY, text, index);
    }, 500);
  });
  msg.addEventListener('pointerup', () => clearTimeout(pressTimer));
  msg.addEventListener('pointermove', () => clearTimeout(pressTimer));
  msg.addEventListener('pointercancel', () => clearTimeout(pressTimer));
  msg.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, text, index);
  });

  return msg;
}

function thinkingDots() { const d = el('span', 'thinking-dots'); d.append(el('span'), el('span'), el('span')); return d; }
function assistantParts(msg) {
  if (!msg._parts) {
    const status = el('div', 'thinking-status');
    const details = el('details', 'thought'); details.hidden = true;
    const thoughtBody = el('div', 'thought-content md');
    details.append(el('summary', '', 'Thought process'), thoughtBody);
    const body = el('div', 'md'); body.hidden = true;
    const meta = el('div', 'msg-meta'); meta.hidden = true;
    msg.append(status, details, body, meta);
    msg._parts = { status, details, thoughtBody, body, meta };
  }
  return msg._parts;
}
function setThinking(msg, model) { assistantParts(msg).status.replaceChildren(document.createTextNode(`Thinking using (${model})`), thinkingDots()); }

function renderAssistant(msg, data, { final = false, note = '', index = -1 } = {}) {
  const parts = assistantParts(msg);
  const { text = '', thoughts = '', model = '', stats = null } = data;
  const hasText = text.length > 0, hasThoughts = thoughts.trim().length > 0;

  msg.classList.toggle('is-thinking', !hasText && !final);
  msg.classList.toggle('has-thoughts', hasThoughts);
  parts.status.hidden = hasText || final;
  parts.details.hidden = !hasThoughts;
  
  if (hasThoughts && msg._lastThoughts !== thoughts) { parts.thoughtBody.innerHTML = renderMarkdown(thoughts); msg._lastThoughts = thoughts; }
  parts.body.hidden = !hasText;
  
  if (hasText) {
    if (msg._lastText !== text) {
      parts.body.innerHTML = renderMarkdown(text);
      msg._lastText = text; msg._lastEnhanced = false;
    }
    if (final && !msg._lastEnhanced) {
      enhanceContent(parts.body); msg._lastEnhanced = true;
    }
  }
  const label = model ? (note ? `${model} (${note})` : model) : note;
  const caption = [label, formatStats(stats)].filter(Boolean).join('\n');
  parts.meta.hidden = !(final && caption); parts.meta.textContent = caption;

  // Add actions if final and we don't already have them
  if (final && text && !msg.querySelector('.msg-actions') && index !== -1) {
    attachMessageActions(msg, text, index);
  }
}

function formatDuration(ms) { const s = ms / 1000; if (s < 10) return `${s.toFixed(1)}s`; if (s < 60) return `${Math.round(s)}s`; return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`; }
const formatTokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
function formatStats(stats) {
  if (!stats?.totalMs) return ''; const bits = [];
  if (stats.firstMs) bits.push(`first output ${formatDuration(stats.firstMs)}`);
  if (stats.answerMs && stats.answerMs - stats.firstMs >= 1000) bits.push(`answer began ${formatDuration(stats.answerMs)}`);
  bits.push(`total ${formatDuration(stats.totalMs)}`);
  const u = stats.usage;
  if (u) { bits.push(`${formatTokens(u.promptTokens)} in`); if (u.thoughtTokens) bits.push(`${formatTokens(u.thoughtTokens)} thinking`); bits.push(`${formatTokens(u.outputTokens)} out`); }
  return bits.join(' · ');
}

function renderTranscript() {
  clearTranscript();
  state.ui.forEach((entry, index) => {
    if (entry.role === 'user') renderUserMessage(entry, index);
    else renderAssistant(createMessage('ai'), entry, { final: true, index });
  });
  scrollToBottom(true);
}

/* ---------- Context Menu (User Long Press) ---------- */
function showContextMenu(x, y, text, index) {
  els.ctxMenu.hidden = false;
  els.ctxMenu.style.left = `${Math.min(x, window.innerWidth - 140)}px`;
  els.ctxMenu.style.top = `${Math.min(y, window.innerHeight - 100)}px`;
  ctxTargetIndex = index;

  // Clean up previous listeners
  const newCtxCopy = els.ctxCopy.cloneNode(true);
  const newCtxRetry = els.ctxRetry.cloneNode(true);
  els.ctxCopy.replaceWith(newCtxCopy); els.ctxRetry.replaceWith(newCtxRetry);
  els.ctxCopy = newCtxCopy; els.ctxRetry = newCtxRetry;

  els.ctxCopy.addEventListener('click', async () => {
    els.ctxMenu.hidden = true;
    const ok = await copyText(text);
    toast(ok ? 'Copied.' : 'Copy failed.');
  });
  els.ctxRetry.addEventListener('click', () => {
    els.ctxMenu.hidden = true;
    retryFrom(ctxTargetIndex);
  });
}
document.addEventListener('pointerdown', (e) => {
  if (!els.ctxMenu.hidden && !els.ctxMenu.contains(e.target)) els.ctxMenu.hidden = true;
});

/* ---------- Generation ---------- */
function setBusy(busy) {
  state.generating = busy; els.sendBtn.classList.toggle('is-stop', busy); els.sendBtn.setAttribute('aria-label', busy ? 'Stop' : 'Send');
  els.sendBtn.replaceChildren(icon(busy ? 'stop' : 'send'));
}
function stopGeneration() { state.abort?.abort(); }
function ensureKeyFor(provider) {
  if (keyStore.get(provider)) return true;
  toast(`Add your ${PROVIDER_NAMES[provider]} API key.`, 4000); openKeyModal(); return false;
}

async function sendMessage() {
  if (state.generating) return;
  if (!await waitForAttachments()) return;
  if (state.generating) return;

  const text = els.userInput.value.trim();
  if (!text && state.attachments.length === 0) return;
  if (!navigator.onLine) { toast("You're offline.", 4500); return; }

  const selected = parseModelValue(els.modelSelect.value);
  if (!ensureKeyFor(selected.provider)) return;

  const files = state.attachments.map(({ name, size, kind, ext, mime, thumb, data, text: fileText }) => ({ name, size, kind, ext, mime, thumb, data, text: fileText }));
  const message = { role: 'user', content: text, files: files.map(({ thumb, ...req }) => req) };
  if (estimateBytes([...state.history, message]) > MAX_INLINE_BYTES) { toast('Request over 19 MB limit.', 5000); return; }

  const ui = { role: 'user', text, files: files.map(({ name, size, kind, ext, thumb }) => ({ name, size, kind, ext, thumb })) };

  document.querySelectorAll('.retry-btn').forEach((btn) => btn.remove());
  const msgIndex = state.ui.length;
  renderUserMessage(ui, msgIndex); scrollToBottom(true);

  els.userInput.value = ''; autoGrow(); clearAttachments();
  await runTurn({ message, ui });
}

async function retryFrom(index) {
  if (state.generating) { toast('Wait for the current response or press Stop.'); return; }
  if (!navigator.onLine) { toast("You're offline."); return; }

  const targetMsg = state.history[index];
  if (!targetMsg || targetMsg.role !== 'user') return;

  // Slice history and UI to remove everything from this message onwards
  state.history = state.history.slice(0, index);
  state.ui = state.ui.slice(0, index);
  
  // Reset memory cursor if we are going back far
  if (state.summarizedCount > index) { state.summarizedCount = index; state.summary = ''; state.notesCursor = Math.min(state.notesCursor, index); }
  
  renderTranscript();
  
  // Re-send
  const message = { ...targetMsg };
  const ui = state.ui[index] || deriveUi([targetMsg])[0]; // fallback if missing
  
  // We can't easily reconstruct the full `ui` array without mutating state deeply, so we just push the ui back.
  state.history.push(message);
  state.ui.push(ui);
  renderUserMessage(ui, index);
  
  await runTurn({ message, ui });
}

async function runTurn(turn) {
  state.abort = new AbortController(); const { signal } = state.abort; setBusy(true);

  state.history.push(turn.message);
  state.ui.push(turn.ui);
  const msgIndex = state.ui.length - 1;

  const selected = parseModelValue(els.modelSelect.value);
  const used = { provider: selected.provider, model: selected.id };

  const bubble = createMessage('ai');
  setThinking(bubble, used.model); renderAssistant(bubble, {}); scrollToBottom(true);

  const result = { text: '', thoughts: '', model: used.model, finishReason: '', usage: null };
  const t0 = performance.now(); let firstMs = 0, answerMs = 0;
  const paint = makeThrottle(() => { renderAssistant(bubble, result); scrollToBottom(); }, STREAM_PAINT_MS);

  let failure = null;
  try {
    const memory = memoryStore.load();
    const request = prepareRequest({
      history: state.history, summary: state.summary, summarizedCount: state.summarizedCount,
      notes: memory.enabled ? memory.notes : [], base: DEFAULT_SYSTEM_PROMPT,
    });
    if (request.dropped > 0) toast(`${request.dropped} older message(s) left out of this request.`, 5000);

    const stream = streamChat({ messages: request.messages, system: request.system, selected, keys: keyStore.all(), signal });
    for await (const chunk of stream) {
      if (chunk.type === 'status') {
        used.provider = chunk.provider; used.model = chunk.model; result.model = chunk.model;
        if (!result.text && !result.thoughts) setThinking(bubble, chunk.model);
      } else if (chunk.type === 'text') {
        if (!firstMs) firstMs = performance.now() - t0; if (!answerMs) answerMs = performance.now() - t0;
        result.text += chunk.delta; paint();
      } else if (chunk.type === 'thought') {
        if (!firstMs) firstMs = performance.now() - t0; result.thoughts += chunk.delta; paint();
      } else if (chunk.type === 'usage') result.usage = chunk;
      else if (chunk.type === 'fallback') toast(`Switched from ${chunk.from.model} to ${chunk.to.model}`, 4500);
      else if (chunk.type === 'notice') toast(chunk.message, 4000);
      else if (chunk.type === 'done') result.finishReason = chunk.finishReason;
    }
  } catch (err) { failure = err; }

  paint.cancel();
  result.stats = { firstMs, answerMs, totalMs: performance.now() - t0, usage: result.usage };
  const stopped = signal.aborted; state.abort = null; setBusy(false);

  if (result.text.trim() || result.thoughts.trim()) {
    state.history.push({ role: 'assistant', content: result.text, thoughts: result.thoughts, model: result.model, provider: used.provider });
    state.ui.push({ role: 'ai', text: result.text, thoughts: result.thoughts, model: result.model, stats: result.stats });

    renderAssistant(bubble, result, { final: true, note: stopped ? 'stopped' : failure ? 'interrupted' : '', index: msgIndex });
    if (failure && !stopped) { console.warn(failure); toast(describeError(failure).message, 5000); }
    scrollToBottom(); saveCurrentSession();
    if (!failure && !stopped) runMemoryUpkeep();
    return;
  }

  state.history.pop(); state.ui.pop();
  showError(bubble, turn, msgIndex, stopped ? null : failure ?? new Error('Empty response.'));
}

function showError(bubble, turn, msgIndex, err) {
  const { message, detail } = err ? describeError(err) : { message: 'Stopped before a reply arrived.', detail: '' };
  bubble.className = 'msg ai error';
  bubble.replaceChildren(el('div', 'error-text', message));
  delete bubble._parts; delete bubble._lastText; delete bubble._lastThoughts; delete bubble._lastEnhanced;
  if (detail) bubble.append(el('div', 'error-detail', detail));
  attachMessageActions(bubble, '', msgIndex, false); // Will only add Retry really, but Copy/Share on error is harmless
  scrollToBottom();
}

function errInfo(err) {
  let message = err?.message ?? String(err ?? 'Unknown error'), status = err?.status ?? err?.code ?? null;
  try { const body = JSON.parse(message); if (body?.error) { message = body.error.message || message; status = body.error.code || status; } } catch {}
  return { status: Number(status) || null, message };
}
function describeError(err) {
  const { status, message } = errInfo(err); let friendly = null;
  if (status === 401 || status === 403 || /api key|API_KEY_INVALID/i.test(message)) friendly = 'Your API key was rejected.';
  else if (status === 402) friendly = 'Needs OpenRouter credits.';
  else if (status === 429) friendly = 'Rate limit reached. Wait a moment.';
  else if (status === 503 || /overloaded|unavailable/i.test(message)) friendly = 'Model overloaded. Try again shortly.';
  else if (status === 413 || /too large|exceeds the maximum/i.test(message)) friendly = 'Request too large.';
  else if (err instanceof TypeError || /failed to fetch|network/i.test(message)) friendly = 'Network error.';
  return friendly ? { message: friendly, detail: message === friendly ? '' : message } : { message, detail: '' };
}

/* ---------- Database (Sessions + Attachments) ---------- */
const dbPromise = new Promise((resolve) => {
  if (!('indexedDB' in window)) { resolve(null); return; }
  const request = indexedDB.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = (e) => {
    const db = request.result;
    if (!db.objectStoreNames.contains(STORE_SESSIONS)) db.createObjectStore(STORE_SESSIONS, { keyPath: 'id' });
    if (!db.objectStoreNames.contains(STORE_ATTACHMENTS)) db.createObjectStore(STORE_ATTACHMENTS, { keyPath: 'id' });
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => { console.warn('IndexedDB unavailable:', request.error); resolve(null); };
});

async function dbRun(storeName, mode, operation) {
  const db = await dbPromise; if (!db) return null;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode); const request = operation(tx.objectStore(storeName));
    tx.oncomplete = () => resolve(request?.result ?? null); tx.onabort = tx.onerror = () => reject(tx.error);
  });
}
const dbGetSession = (id) => dbRun(STORE_SESSIONS, 'readonly', (s) => s.get(id));
const dbPutSession = (rec) => dbRun(STORE_SESSIONS, 'readwrite', (s) => s.put(rec));
const dbDeleteSession = (id) => dbRun(STORE_SESSIONS, 'readwrite', (s) => s.delete(id));
const dbPutAttachment = (rec) => dbRun(STORE_ATTACHMENTS, 'readwrite', (s) => s.put(rec));
const dbGetAttachment = (id) => dbRun(STORE_ATTACHMENTS, 'readonly', (s) => s.get(id));

async function dbListSessions() {
  const db = await dbPromise; if (!db) return [];
  return new Promise((resolve, reject) => {
    const out = [], tx = db.transaction(STORE_SESSIONS, 'readonly'), cursor = tx.objectStore(STORE_SESSIONS).openCursor();
    cursor.onsuccess = () => { const c = cursor.result; if (!c) return; out.push(c.value); c.continue(); };
    tx.oncomplete = () => resolve(out.sort((a, b) => b.timestamp - a.timestamp)); tx.onabort = tx.onerror = () => reject(tx.error);
  });
}

function makeTitle(ui) {
  const first = ui.find((m) => m.role === 'user');
  const base = first?.text?.trim().split('\n')[0] || (first?.files?.length ? `Files: ${first.files.map((f) => f.name).join(', ')}` : '');
  if (!base) return 'New Chat'; return base.length > TITLE_MAX ? `${base.slice(0, TITLE_MAX)}…` : base;
}

function updateHistoryItemInPlace() {
  const existing = els.historyList.querySelector(`[data-session-id="${CSS.escape(state.sessionId)}"]`);
  if (!existing) { renderHistoryList(); return; }
  const title = makeTitle(state.ui), titleBtn = existing.querySelector('.history-title');
  if (titleBtn && titleBtn.textContent !== title) { titleBtn.textContent = title; titleBtn.title = title; }
  els.historyList.querySelectorAll('.history-item.active').forEach((el) => { if (el !== existing) el.classList.remove('active'); });
  existing.classList.add('active');
}

async function saveCurrentSession() {
  if (!state.history.length) return;
  try {
    // Strip heavy data and save to attachments store
    const cleanHistory = JSON.parse(JSON.stringify(state.history));
    const cleanUi = JSON.parse(JSON.stringify(state.ui));
    const attachmentsToSave = [];

    // Clean history (data/text)
    for (const msg of cleanHistory) {
      for (const f of msg.files ?? []) {
        if (f.data || f.text) {
          const id = `att_${Date.now()}_${Math.random().toString(36).slice(2)}`;
          attachmentsToSave.push({ id, data: f.data, text: f.text, mime: f.mime });
          f.attachmentId = id; delete f.data; delete f.text;
        }
      }
    }
    // Clean ui (thumbs)
    for (const msg of cleanUi) {
      for (const f of msg.files ?? []) {
        if (f.thumb) {
          const id = `thumb_${Date.now()}_${Math.random().toString(36).slice(2)}`;
          attachmentsToSave.push({ id, thumb: f.thumb });
          f.thumbId = id; delete f.thumb;
        }
      }
    }

    for (const att of attachmentsToSave) await dbPutAttachment(att);
    await dbPutSession({
      id: state.sessionId, title: makeTitle(state.ui),
      messages: cleanHistory, ui: cleanUi,
      summary: state.summary, summarizedCount: state.summarizedCount, notesCursor: state.notesCursor,
      timestamp: Date.now(),
    });
    updateHistoryItemInPlace();
  } catch (err) { console.warn('Could not save session:', err); toast('Could not save chat. Storage may be full.'); }
}

async function renderHistoryList() {
  let sessions = [];
  try { sessions = await dbListSessions(); } catch (err) { console.warn(err); }
  if (!sessions.length) { els.historyList.replaceChildren(el('p', 'history-empty', 'No saved chats yet.')); return; }
  els.historyList.replaceChildren(
    ...sessions.map((session) => {
      const item = el('div', `history-item${session.id === state.sessionId ? ' active' : ''}`);
      item.dataset.sessionId = session.id;
      const open = el('button', 'history-title', session.title); open.type = 'button'; open.title = session.title;
      open.addEventListener('click', () => loadSession(session.id));
      const del = el('button', 'delete-btn'); del.type = 'button'; del.setAttribute('aria-label', `Delete chat: ${session.title}`);
      del.append(icon('trash')); del.addEventListener('click', (e) => { e.stopPropagation(); deleteSession(session.id); });
      item.append(open, del); return item;
    }),
  );
}

function resetConversation() {
  state.sessionId = newId(); state.history = []; state.ui = [];
  state.summary = ''; state.summarizedCount = 0; state.notesCursor = 0;
  clearAttachments(); clearTranscript();
}
const busyGuard = () => { if (!state.generating) return false; toast('Wait for the current response.'); return true; };

async function loadSession(id) {
  if (busyGuard()) return;
  let session = null;
  try { session = await dbGetSession(id); } catch (err) { console.warn(err); }
  if (!session) { toast('Chat could not be opened.'); return; }

  // Hydrate attachments
  for (const msg of session.messages ?? []) {
    for (const f of msg.files ?? []) {
      if (f.attachmentId) { const att = await dbGetAttachment(f.attachmentId); if (att) { f.data = att.data; f.text = att.text; f.mime = att.mime || f.mime; } }
    }
  }
  for (const msg of session.ui ?? []) {
    for (const f of msg.files ?? []) {
      if (f.thumbId) { const att = await dbGetAttachment(f.thumbId); if (att) f.thumb = att.thumb; }
    }
  }

  clearAttachments();
  state.sessionId = session.id;
  state.history = session.messages ?? [];
  state.ui = session.ui ?? deriveUi(state.history);
  state.summary = session.summary ?? '';
  state.summarizedCount = Math.min(session.summarizedCount ?? 0, state.history.length);
  state.notesCursor = Math.min(session.notesCursor ?? 0, state.history.length);
  renderTranscript();
  if (!desktopMQ.matches) setSidebar(false);
  renderHistoryList();
}

async function deleteSession(id) {
  if (busyGuard()) return; if (!confirm('Delete this chat?')) return;
  try { await dbDeleteSession(id); } catch (err) { console.warn(err); }
  if (id === state.sessionId) resetConversation();
  renderHistoryList();
}
function startNewChat() {
  if (busyGuard()) return; if (state.history.length || state.ui.length) resetConversation();
  if (!desktopMQ.matches) setSidebar(false); renderHistoryList(); els.userInput.focus();
}
async function clearChat() {
  if (busyGuard()) return; if (state.history.length && !confirm('Clear this conversation?')) return;
  const id = state.sessionId; resetConversation();
  try { await dbDeleteSession(id); } catch (err) { console.warn(err); }
  renderHistoryList();
}

/* ---------- Sidebar ---------- */
const desktopMQ = window.matchMedia('(min-width: 900px)');
function isSidebarOpen() {
  return desktopMQ.matches ? !document.body.classList.contains('sidebar-collapsed') : els.sidebar.classList.contains('open');
}
function setSidebar(open) {
  if (desktopMQ.matches) { document.body.classList.toggle('sidebar-collapsed', !open); store.set(STORAGE.sidebar, open ? '1' : '0'); }
  else { els.sidebar.classList.toggle('open', open); els.overlay.classList.toggle('active', open); }
  els.menuBtn.setAttribute('aria-expanded', String(open));
}
function syncSidebarToViewport() {
  els.sidebar.classList.remove('open'); els.overlay.classList.remove('active');
  document.body.classList.toggle('sidebar-collapsed', desktopMQ.matches && store.get(STORAGE.sidebar) === '0');
  els.menuBtn.setAttribute('aria-expanded', String(isSidebarOpen()));
}

/* ---------- Init & Event wiring ---------- */
function autoGrow() { els.userInput.style.height = 'auto'; els.userInput.style.height = `${Math.min(els.userInput.scrollHeight, 200)}px`; }

function trackViewport() {
  const vv = window.visualViewport; if (!vv) return;
  const sync = () => {
    if (vv.scale > 1.01) return; document.documentElement.style.setProperty('--app-h', `${Math.round(vv.height)}px`);
    if (vv.offsetTop > 0) window.scrollTo(0, 0); scrollToBottom();
  };
  vv.addEventListener('resize', sync); vv.addEventListener('scroll', sync); sync();
}
function wireDragAndDrop() {
  let depth = 0; const hasFiles = (e) => e.dataTransfer?.types?.includes('Files');
  const reset = () => { depth = 0; document.body.classList.remove('dragging'); };
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; document.body.classList.add('dragging'); });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('dragleave', (e) => { if (hasFiles(e) && --depth <= 0) reset(); });
  window.addEventListener('drop', (e) => { if (!hasFiles(e)) return; e.preventDefault(); reset(); addFiles(e.dataTransfer.files); });
}

async function runMemoryUpkeep() {
  if (state.memoryBusy) { state.memoryRerun = true; return; }
  state.memoryBusy = true;
  const snap = { id: state.sessionId, history: state.history.slice(), summary: state.summary, summarizedCount: state.summarizedCount, notesCursor: state.notesCursor };
  try {
    const keys = keyStore.all(), memory = memoryStore.load(), helper = pickHelperModel(keys, parseModelValue(els.modelSelect.value));
    const upkeep = maintain({
      history: snap.history, summary: snap.summary, summarizedCount: snap.summarizedCount, notesCursor: snap.notesCursor,
      notes: memory.notes, notesEnabled: memory.enabled,
      complete: (system, prompt) => completeOnce({ system, prompt, selected: helper, keys }),
      onStep: (changes) => applyMemoryChanges(snap, changes),
    }).catch((err) => ({ changes: {}, errors: [err] }));
    const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 90_000));
    const { errors } = await Promise.race([upkeep, timeout]);
    errors.forEach((err) => console.warn('[memory] step failed:', err));
  } catch (err) { console.warn('[memory] upkeep failed:', err); }
  finally { state.memoryBusy = false; if (state.memoryRerun) { state.memoryRerun = false; runMemoryUpkeep(); } }
}

async function applyMemoryChanges(snap, changes) {
  if (changes.addedNotes?.length) {
    const fresh = memoryStore.load(); memoryStore.save({ ...fresh, notes: mergeNotes(fresh.notes, changes.addedNotes) });
    if (!memoryEls.modal.hidden) renderMemoryModal();
  }
  if (state.sessionId !== snap.id) return;
  let dirty = false;
  if (changes.summary !== undefined) { state.summary = changes.summary; state.summarizedCount = changes.summarizedCount; dirty = true; }
  if (changes.notesCursor !== undefined) { state.notesCursor = changes.notesCursor; dirty = true; }
  if (dirty) await saveCurrentSession();
}

const memoryEls = {
  modal: $('memory-modal'), list: $('memory-list'), enabled: $('memory-enabled'),
  addInput: $('memory-add-input'), addBtn: $('memory-add-btn'), status: $('memory-chat-status'),
  openBtn: $('memory-btn'), closeBtn: $('close-memory-btn'), clearBtn: $('clear-memory-btn'),
};
function renderMemoryModal() {
  const memory = memoryStore.load(); memoryEls.enabled.checked = memory.enabled;
  const items = memory.notes.map((note) => {
    const li = el('li', 'memory-item'); li.append(el('span', 'memory-text', note));
    const del = el('button', 'memory-del', '×'); del.type = 'button'; del.setAttribute('aria-label', `Delete note: ${note}`);
    del.addEventListener('click', () => { const curr = memoryStore.load(); memoryStore.save({ ...curr, notes: curr.notes.filter((n) => n !== note) }); renderMemoryModal(); });
    li.append(del); return li;
  });
  memoryEls.list.replaceChildren(...(items.length ? items : [el('li', 'history-empty', 'No notes yet.')]));
  const total = state.history.length;
  memoryEls.status.textContent = total ? `This chat: ${total} messages; ${state.summarizedCount ? `${state.summarizedCount} summarized` : 'none summarized'}.` : 'This chat is empty.';
}
function openMemoryModal() { lastFocus = document.activeElement; if (!desktopMQ.matches) setSidebar(false); renderMemoryModal(); memoryEls.modal.hidden = false; }
function closeMemoryModal() { memoryEls.modal.hidden = true; lastFocus?.focus?.(); lastFocus = null; }
function addMemoryNote() {
  const text = memoryEls.addInput.value.trim().replace(/\s+/g, ' ').slice(0, 200); if (!text) return;
  memoryStore.save({ ...memoryStore.load(), notes: mergeNotes(memoryStore.load().notes, [text]) });
  memoryEls.addInput.value = ''; renderMemoryModal();
}
function wireMemoryModal() {
  memoryEls.openBtn.addEventListener('click', openMemoryModal); memoryEls.closeBtn.addEventListener('click', closeMemoryModal);
  memoryEls.modal.addEventListener('click', (e) => { if (e.target === memoryEls.modal) closeMemoryModal(); });
  memoryEls.enabled.addEventListener('change', () => memoryStore.save({ ...memoryStore.load(), enabled: memoryEls.enabled.checked }));
  memoryEls.addBtn.addEventListener('click', addMemoryNote); memoryEls.addInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addMemoryNote(); });
  memoryEls.clearBtn.addEventListener('click', () => { if (!confirm('Delete all memory notes?')) return; memoryStore.save({ ...memoryStore.load(), notes: [] }); renderMemoryModal(); });
}

const offlineBanner = $('offline-banner');
function syncOnline() { if (offlineBanner) offlineBanner.hidden = navigator.onLine; }

function init() {
  renderModelDropdown(); refreshCatalogs().catch((err) => console.warn('Catalog refresh failed:', err));
  syncOnline();
  window.addEventListener('offline', syncOnline);
  window.addEventListener('online', () => { syncOnline(); toast('Back online.'); refreshCatalogs().catch((err) => console.warn('Catalog failed:', err)); });
  
  els.modelSelect.addEventListener('change', () => store.set(STORAGE.model, els.modelSelect.value));

  els.sendBtn.addEventListener('click', () => (state.generating ? stopGeneration() : sendMessage()));
  els.userInput.addEventListener('input', autoGrow);
  els.userInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    const touch = window.matchMedia('(pointer: coarse)').matches;
    if (e.ctrlKey || e.metaKey || (!e.shiftKey && !touch)) { e.preventDefault(); sendMessage(); }
  });
  els.userInput.addEventListener('paste', (e) => { const files = e.clipboardData?.files; if (files?.length && !e.clipboardData.getData('text/plain')) { e.preventDefault(); addFiles(files); } });

  els.attachBtn.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', () => { addFiles(els.fileInput.files); els.fileInput.value = ''; });
  els.removeFileBtn.addEventListener('click', clearAttachments); wireDragAndDrop();

  els.clearChatBtn.addEventListener('click', clearChat); els.keyBtn.addEventListener('click', openKeyModal); els.emptyKeyBtn.addEventListener('click', openKeyModal);
  els.saveKeyBtn.addEventListener('click', saveKey); els.closeKeyBtn.addEventListener('click', closeKeyModal); els.removeKeyBtn.addEventListener('click', removeKey);
  Object.values(keyInputs).forEach((input) => { input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveKey(); }); });
  els.toggleKeyBtn.addEventListener('click', () => {
    const show = els.apiKeyInput.type === 'password';
    Object.values(keyInputs).forEach((i) => { if (i) i.type = show ? 'text' : 'password'; });
    els.toggleKeyBtn.textContent = show ? 'Hide' : 'Show'; els.toggleKeyBtn.setAttribute('aria-pressed', String(show));
  });
  els.keyModal.addEventListener('click', (e) => { if (e.target === els.keyModal) closeKeyModal(); }); wireMemoryModal();

  els.menuBtn.addEventListener('click', () => setSidebar(!isSidebarOpen())); els.overlay.addEventListener('click', () => setSidebar(false));
  els.newChatBtn.addEventListener('click', startNewChat); desktopMQ.addEventListener('change', syncSidebarToViewport); syncSidebarToViewport();

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!els.keyModal.hidden) closeKeyModal();
    else if (!memoryEls.modal.hidden) closeMemoryModal();
    else if (!desktopMQ.matches && isSidebarOpen()) setSidebar(false);
    else if (!els.ctxMenu.hidden) els.ctxMenu.hidden = true;
  });

  els.chatBox.addEventListener('scroll', () => { const box = els.chatBox; stickToBottom = box.scrollHeight - box.scrollTop - box.clientHeight < STICK_THRESHOLD; }, { passive: true });

  trackViewport(); setBusy(false); renderAttachments(); syncEmptyState(); renderHistoryList();
}

init();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').then((reg) => console.log('SW registered')).catch((err) => console.warn('SW failed', err));
  });
}