/* ==========================================================================
   Gemini Mobile Studio
   Sections: 1 Config · 2 State & DOM · 3 Helpers · 4 API key · 5 Attachments
             6 Rendering · 7 Generation · 8 Sessions (IndexedDB) · 9 Sidebar · 10 Init
   ========================================================================== */

/* ---------- 1. Config ---------- */
// At the top of app.js
import { keyStore, loadCatalogCache, saveCatalogCache, dbGet, dbPut } from './storage.js';
import { 
  streamChat, 
  fetchOpenRouterModels, 
  fetchGeminiModels, 
  setCatalog, 
  orderOpenRouterModels, 
  orderGeminiModels,
  parseModelValue 
} from './engine.js';

const STORAGE = { apiKey: 'GEMINI_API_KEY', model: 'GEMINI_MODEL', sidebar: 'GEMINI_SIDEBAR_OPEN' };
const DB_NAME = 'ChatHistoryDB';
const DB_VERSION = 1;
const STORE_NAME = 'sessions';

const MAX_INLINE_BYTES = 19 * 1024 * 1024; // Gemini accepts ~20 MB of inline data per request
const TITLE_MAX = 30;
const STICK_THRESHOLD = 80;                 // px from the bottom that still counts as "following" the chat
const STREAM_PAINT_MS = 80;
const THUMB_SIZE = 192;                     // px; shown at ~60px, so it stays sharp on 3x phone screens

// Which sprite icon fills the thumbnail tile when there is no picture
const KIND_ICON = { image: 'image', video: 'play', audio: 'music', text: 'code', pdf: 'file', file: 'file' };

// Text-like files are sent as text parts (works for any model, no MIME guessing needed)
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'xml', 'html', 'htm', 'css', 'scss',
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'ipynb', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs',
  'go', 'rs', 'rb', 'php', 'swift', 'sh', 'bash', 'sql', 'yaml', 'yml', 'toml', 'ini', 'cfg',
  'env', 'log', 'rtf', 'tex', 'r', 'lua', 'dart', 'vue', 'svelte',
]);

// Used only when the browser reports no MIME type for a binary file
const MIME_BY_EXT = {
  pdf: 'application/pdf',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  gif: 'image/gif', heic: 'image/heic', heif: 'image/heif',
  mp3: 'audio/mp3', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac', m4a: 'audio/aac',
  mp4: 'video/mp4', mov: 'video/mov', webm: 'video/webm', mpeg: 'video/mpeg', avi: 'video/avi',
};

/* ---------- 2. State & DOM ---------- */

const $ = (id) => document.getElementById(id);

const els = {
  chatBox: $('chat-box'),
  emptyState: $('empty-state'),
  emptyKeyBtn: $('empty-key-btn'),
  userInput: $('user-input'),
  sendBtn: $('send-btn'),
  attachBtn: $('attach-btn'),
  fileInput: $('file-input'),
  filePreviewBar: $('file-preview-bar'),
  thumbStrip: $('thumb-strip'),
  fileNameDisplay: $('file-name-display'),
  removeFileBtn: $('remove-file-btn'),
  modelSelect: $('model-select'),
  clearChatBtn: $('clear-chat-btn'),
  keyBtn: $('key-btn'),
  keyModal: $('key-modal'),
  apiKeyInput: $('api-key-input'),
  saveKeyBtn: $('save-key-btn'),
  closeKeyBtn: $('close-key-btn'),
  removeKeyBtn: $('remove-key-btn'),
  toggleKeyBtn: $('toggle-key-btn'),
  menuBtn: $('menu-btn'),
  sidebar: $('sidebar'),
  overlay: $('sidebar-overlay'),
  newChatBtn: $('new-chat-btn'),
  historyList: $('history-list'),
  toast: $('toast'),
};

const state = {
  ai: null,                  // GoogleGenAI client
  history: [],               // `contents` sent to the API
  ui: [],                    // what the transcript shows (saved next to `history`)
  attachments: [],           // files waiting to be sent
  pendingReads: new Set(),   // in-flight file reads
  sessionId: newId(),
  generating: false,
  abort: null,
};

let nextAttachmentId = 0;
let genaiModule = null;
let stickToBottom = true;
let toastTimer = 0;
let lastFocus = null;

/* ---------- 3. Helpers ---------- */

const SVG_NS = 'http://www.w3.org/2000/svg';

function newId() { return Date.now().toString(); }

const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* storage blocked */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* storage blocked */ } },
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function icon(name) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function escapeHTML(str) {
  return str.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function getExt(name) {
  const i = name.lastIndexOf('.');
  return i > -1 ? name.slice(i + 1).toLowerCase() : '';
}

function toast(message, ms = 3200) {
  els.toast.textContent = message;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), ms);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* clipboard API needs https; fall back below */ }
  try {
    const ta = el('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

function makeThrottle(fn, wait) {
  let timer = 0;
  let last = 0;
  const run = () => { timer = 0; last = performance.now(); fn(); };
  const throttled = () => {
    if (timer) return;
    timer = setTimeout(run, Math.max(0, wait - (performance.now() - last)));
  };
  throttled.cancel = () => { clearTimeout(timer); timer = 0; };
  return throttled;
}

const modelIds = () => [...els.modelSelect.options].map((o) => o.value);
/* ---------- 3.5 Catalog & Model Dropdown ---------- */

async function refreshCatalogs() {
  const keys = keyStore.all();

  // 1. Fetch OpenRouter models if key is present
  if (keys.openrouter) {
    try {
      const models = await fetchOpenRouterModels();
      const ordered = orderOpenRouterModels(models);
      setCatalog('openrouter', ordered);
      saveCatalogCache('openrouter', ordered);
    } catch (err) {
      console.warn('Could not refresh OpenRouter catalog:', err);
    }
  }

  // 2. Fetch Gemini models if key is present
  if (keys.gemini) {
    try {
      const models = await fetchGeminiModels(keys.gemini);
      const ordered = orderGeminiModels(models);
      setCatalog('gemini', ordered);
      saveCatalogCache('gemini', ordered);
    } catch (err) {
      console.warn('Could not refresh Gemini catalog:', err);
    }
  }

  renderModelDropdown();
}

function renderModelDropdown() {
  const select = els.modelSelect;
  select.replaceChildren();

  // Load from catalog or cache
  const cached = loadCatalogCache();
  const geminiModels = getCatalog('gemini').length ? getCatalog('gemini') : (cached.gemini?.models || GEMINI_DEFAULTS);
  const openrouterModels = getCatalog('openrouter').length ? getCatalog('openrouter') : (cached.openrouter?.models || []);

  // Gemini Group
  if (geminiModels.length) {
    const group = el('optgroup');
    group.label = 'Google AI Studio';
    geminiModels.forEach((m) => {
      const opt = el('option', '', m.label || m.id);
      opt.value = modelValue('gemini', m.id);
      group.append(opt);
    });
    select.append(group);
  }

  // OpenRouter Group
  if (openrouterModels.length) {
    const group = el('optgroup');
    group.label = 'OpenRouter';
    openrouterModels.forEach((m) => {
      const label = m.free ? `${m.label} (Free)` : m.label;
      const opt = el('option', '', label);
      opt.value = modelValue('openrouter', m.id);
      group.append(opt);
    });
    select.append(group);
  }

  // Restore saved choice or default
  const saved = store.get(STORAGE.model);
  if (saved && modelIds().includes(saved)) {
    select.value = saved;
  }
}


/* ---------- 4. API keys & Modal ---------- */

// Extra DOM elements for OpenRouter Key (make sure you add an input with id="openrouter-key-input" in HTML or use this)
const elsKeys = {
  geminiInput: els.apiKeyInput,
  openrouterInput: $('openrouter-key-input') // Add <input id="openrouter-key-input"> in your key-modal HTML
};

function openKeyModal() {
  lastFocus = document.activeElement;
  const keys = keyStore.all();
  
  if (elsKeys.geminiInput) elsKeys.geminiInput.value = keys.gemini || '';
  if (elsKeys.openrouterInput) elsKeys.openrouterInput.value = keys.openrouter || '';
  
  els.toggleKeyBtn.textContent = 'Show';
  els.keyModal.hidden = false;
  if (elsKeys.geminiInput) elsKeys.geminiInput.focus();
}

function closeKeyModal() {
  els.keyModal.hidden = true;
  lastFocus?.focus?.();
  lastFocus = null;
}

async function saveKey() {
  const geminiVal = elsKeys.geminiInput ? elsKeys.geminiInput.value.trim() : '';
  const openrouterVal = elsKeys.openrouterInput ? elsKeys.openrouterInput.value.trim() : '';

  if (geminiVal) keyStore.set('gemini', geminiVal);
  else keyStore.remove('gemini');

  if (openrouterVal) keyStore.set('openrouter', openrouterVal);
  else keyStore.remove('openrouter');

  closeKeyModal();
  toast('Updating model catalogs...');
  
  // Re-initialize catalogs with the new keys
  await refreshCatalogs();
  syncEmptyState();
}

function removeKey() {
  keyStore.remove('gemini');
  keyStore.remove('openrouter');
  closeKeyModal();
  refreshCatalogs();
  syncEmptyState();
  toast('API keys removed.');
}

function syncEmptyState() {
  const keys = keyStore.all();
  const hasAnyKey = Boolean(keys.gemini || keys.openrouter);
  els.emptyState.hidden = Boolean(els.chatBox.querySelector('.msg'));
  els.emptyKeyBtn.hidden = hasAnyKey;
}


/* ---------- 5. Attachments ---------- */

const mimeFor = (file) => file.type || MIME_BY_EXT[getExt(file.name)] || 'application/octet-stream';

const isTextFile = (file) =>
  file.type.startsWith('text/') ||
  /json|xml|javascript|yaml|x-sh/.test(file.type) ||
  TEXT_EXTENSIONS.has(getExt(file.name));

/** What the thumbnail shows. Order matters: browsers report ".ts" source files as video/mp2t. */
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
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    if (mode === 'text') reader.readAsText(file);
    else reader.readAsDataURL(file);
  });
}

/** The piece of the request this file turns into: text for code/text files, base64 for everything else. */
async function buildPart(file) {
  if (isTextFile(file)) {
    const text = await readFile(file, 'text');
    return { part: { text: `File: ${file.name}\n\`\`\`\n${text}\n\`\`\`` }, bytes: text.length };
  }
  const dataUrl = await readFile(file, 'dataURL');
  const data = dataUrl.slice(dataUrl.indexOf(',') + 1);
  return { part: { inlineData: { data, mimeType: mimeFor(file) } }, bytes: data.length };
}

/* --- thumbnails: a small JPEG drawn on a canvas, so 30 photos never sit in memory at full size --- */

function drawThumb(source, width, height) {
  if (!width || !height) return null;
  const scale = Math.min(1, THUMB_SIZE / Math.max(width, height));
  const canvas = el('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#2b2b2b'; // transparent PNGs get the input colour behind them
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.82);
}

async function imageThumb(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return drawThumb(img, img.naturalWidth || 300, img.naturalHeight || 300);
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Grabs a frame from the video. Gives up after a few seconds and lets the icon tile stand in. */
function videoThumb(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = el('video');
    let timer = 0;
    const done = (thumb) => {
      clearTimeout(timer);
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
      resolve(thumb);
    };
    timer = setTimeout(() => done(null), 6000);
    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.addEventListener('error', () => done(null), { once: true });
    video.addEventListener('loadedmetadata', () => {
      video.currentTime = Math.min(0.5, (video.duration || 1) / 2);
    }, { once: true });
    video.addEventListener('seeked', () => {
      try { done(drawThumb(video, video.videoWidth, video.videoHeight)); } catch { done(null); }
    }, { once: true });
    video.src = url;
  });
}

function makeThumb(file, kind) {
  const work = kind === 'image' ? imageThumb(file) : kind === 'video' ? videoThumb(file) : null;
  return Promise.resolve(work).catch(() => null); // undecodable (e.g. HEIC on desktop): icon tile instead
}

/** One thumbnail picture, or an icon tile with the file extension when there is no picture. Used while composing and in sent messages. */
function thumbMedia({ thumb = null, kind = 'file', ext = 'FILE' }) {
  const media = el('div', `thumb-media kind-${kind}`);
  if (thumb) {
    const img = el('img');
    img.src = thumb;
    img.alt = '';
    img.draggable = false;
    media.append(img);
    if (kind === 'video') media.append(el('span', 'thumb-badge'));
    if (kind === 'video') media.lastChild.append(icon('play'));
  } else {
    media.classList.add('is-tile');
    media.append(icon(KIND_ICON[kind] ?? 'file'), el('span', 'thumb-ext', ext));
  }
  return media;
}

/* --- the attachment list --- */

/** Accepts a FileList or array. Safe to call many times: selections accumulate. */
function addFiles(fileList) {
  const files = Array.from(fileList || []); // copy now: the input is reset right after
  if (!files.length) return;

  const job = (async () => {
    const staged = [];
    let skipped = 0;

    for (const file of files) {
      const key = `${file.name}|${file.size}|${file.lastModified}`;
      if (state.attachments.some((a) => a.key === key)) { skipped++; continue; }
      if (file.size > MAX_INLINE_BYTES) { toast(`${file.name} is over the ${formatBytes(MAX_INLINE_BYTES)} limit.`); continue; }

      const kind = fileKind(file);
      const att = {
        id: ++nextAttachmentId, key, kind,
        name: file.name, size: file.size, ext: extLabel(file, kind),
        thumb: null, part: null, bytes: 0, loading: true,
      };
      state.attachments.push(att);
      staged.push({ att, file });
    }
    renderAttachments(); // every tile appears at once, with a spinner until it is ready

    for (const { att, file } of staged) {
      try {
        const [thumb, built] = await Promise.all([makeThumb(file, att.kind), buildPart(file)]);
        if (!state.attachments.includes(att)) continue; // removed while it was loading
        Object.assign(att, { thumb, part: built.part, bytes: built.bytes, loading: false });
      } catch (err) {
        console.warn('Could not read file:', file.name, err);
        state.attachments = state.attachments.filter((a) => a !== att);
        toast(`Could not read ${file.name}.`);
      }
      renderAttachments();
    }

    if (skipped) toast(`${skipped} file(s) were already attached.`);
    if (estimateBytes(state.history) + pendingBytes() > MAX_INLINE_BYTES) {
      toast('Attachments are over the size limit. Remove some before sending.', 4500);
    }
  })();

  state.pendingReads.add(job);
  job.finally(() => { state.pendingReads.delete(job); renderAttachments(); });
}

const pendingBytes = () => state.attachments.reduce((sum, a) => sum + a.bytes, 0);

function removeAttachment(id) {
  state.attachments = state.attachments.filter((a) => a.id !== id);
  renderAttachments();
}

function clearAttachments() {
  state.attachments = [];
  els.fileInput.value = '';
  renderAttachments();
}

const thumbNodes = new Map(); // attachment id -> its DOM node, so existing thumbnails aren't rebuilt on every update

function buildThumb(att) {
  const node = el('div', 'thumb');
  node.setAttribute('role', 'listitem');
  node.setAttribute('aria-label', att.name);
  node.title = att.name; // the name only shows on hover; the thumbnail is what you see

  const remove = el('button', 'thumb-remove');
  remove.type = 'button';
  remove.setAttribute('aria-label', `Remove ${att.name}`);
  remove.append(icon('close'));
  remove.addEventListener('click', () => removeAttachment(att.id));

  node.append(thumbMedia(att), remove);
  node._thumb = att.thumb;
  return node;
}

function updateThumb(node, att) {
  node.classList.toggle('is-loading', att.loading);
  if (node._thumb !== att.thumb) { // the picture arrived: swap the icon tile for it
    node.firstChild.replaceWith(thumbMedia(att));
    node._thumb = att.thumb;
  }
}

function renderAttachments() {
  const live = new Set(state.attachments.map((a) => a.id));
  for (const [id, node] of thumbNodes) {
    if (!live.has(id)) { node.remove(); thumbNodes.delete(id); }
  }

  let added = false;
  for (const att of state.attachments) {
    let node = thumbNodes.get(att.id);
    if (!node) {
      node = buildThumb(att);
      thumbNodes.set(att.id, node);
      els.thumbStrip.append(node);
      added = true;
    }
    updateThumb(node, att);
  }
  const count = state.attachments.length;
  const total = state.attachments.reduce((sum, a) => sum + a.size, 0);
  const loading = state.attachments.some((a) => a.loading);
  els.filePreviewBar.hidden = count === 0; // must be visible before scrolling: a hidden box has no scroll width
  els.removeFileBtn.hidden = count === 0;
  els.fileNameDisplay.textContent = loading
    ? 'Reading files…'
    : `Attached: ${count} file(s), ${formatBytes(total)}`;

  if (added) els.thumbStrip.scrollLeft = els.thumbStrip.scrollWidth; // keep the newest in view
}

function estimateBytes(contents) {
  let total = 0;
  for (const turn of contents) {
    for (const part of turn.parts ?? []) {
      total += (part.inlineData?.data?.length ?? 0) + (part.text?.length ?? 0);
    }
  }
  return total;
}

/* ---------- 6. Rendering ---------- */

function renderMarkdown(markdown) {
  const canRender = typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined';
  if (!canRender) return `<p style="white-space:pre-wrap">${escapeHTML(markdown)}</p>`;
  return DOMPurify.sanitize(marked.parse(markdown));
}

// Open links in a new tab, safely
if (typeof DOMPurify !== 'undefined') {
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
}

/**
 * Colors a code cell using the language on its fence (```python). Unlabeled fences stay plain on purpose:
 * highlight.js's auto-detect guesses wrong on short snippets and would color plain output.
 */
function highlightCode(code, lang) {
  try {
    if (typeof hljs !== 'undefined' && lang && hljs.getLanguage(lang)) hljs.highlightElement(code);
  } catch { /* highlighter missing or language unknown: leave it plain */ }
}

/** Highlights code cells, pins a Copy button to each one's top-right corner, and makes tables scroll sideways. */
function enhanceContent(root) {
  root.querySelectorAll('pre').forEach((pre) => {
    if (pre.parentElement.classList.contains('code-block')) return;
    const code = pre.querySelector('code');
    const lang = code?.className.match(/language-([\w+#-]+)/)?.[1] || '';
    if (code) highlightCode(code, lang);

    const copy = el('button', 'copy-btn', 'Copy');
    copy.type = 'button';
    copy.setAttribute('aria-label', 'Copy code');
    copy.addEventListener('click', async () => {
      const ok = await copyText((code ?? pre).textContent);
      copy.textContent = ok ? 'Copied!' : 'Copy failed';
      setTimeout(() => { copy.textContent = 'Copy'; }, 2000);
    });

    // The button lives on the wrapper, not inside the scrolling <pre>, so it stays put while long lines scroll.
    const wrapper = el('div', 'code-block');
    pre.replaceWith(wrapper);
    wrapper.append(el('span', 'code-lang', lang || 'code'), copy, pre);
  });

  root.querySelectorAll('table').forEach((table) => {
    if (table.parentElement.classList.contains('table-wrap')) return;
    const wrap = el('div', 'table-wrap');
    table.replaceWith(wrap);
    wrap.append(table);
  });
}

function syncEmptyState() {
  els.emptyState.hidden = Boolean(els.chatBox.querySelector('.msg'));
  els.emptyKeyBtn.hidden = Boolean(store.get(STORAGE.apiKey));
}

function createMessage(role) {
  const msg = el('div', `msg ${role}`);
  els.chatBox.append(msg);
  els.emptyState.hidden = true;
  return msg;
}

function scrollToBottom(force = false) {
  if (force) stickToBottom = true;
  if (stickToBottom) els.chatBox.scrollTop = els.chatBox.scrollHeight;
}

function clearTranscript() {
  els.chatBox.querySelectorAll('.msg').forEach((node) => node.remove());
  syncEmptyState();
}

function renderUserMessage({ text = '', files = [] }) {
  const msg = createMessage('user');
  if (files.length) {
    const list = el('div', 'msg-files');
    files.forEach((file) => {
      const thumb = el('div', 'msg-thumb');
      thumb.title = file.name;
      thumb.append(thumbMedia(file));
      list.append(thumb);
    });
    msg.append(list);
  }
  if (text) msg.append(document.createTextNode(text));
  return msg;
}

function thinkingDots() {
  const dots = el('span', 'thinking-dots');
  dots.append(el('span'), el('span'), el('span'));
  return dots;
}

/** Builds the AI bubble's inner structure once; later renders only update its parts. */
function assistantParts(msg) {
  if (!msg._parts) {
    const status = el('div', 'thinking-status');

    const details = el('details', 'thought');
    details.hidden = true;
    const thoughtBody = el('div', 'thought-content md');
    details.append(el('summary', '', 'Thought process'), thoughtBody);

    const body = el('div', 'md');
    body.hidden = true;
    const meta = el('div', 'msg-meta');
    meta.hidden = true;

    msg.append(status, details, body, meta);
    msg._parts = { status, details, thoughtBody, body, meta };
  }
  return msg._parts;
}

function setThinking(msg, model) {
  assistantParts(msg).status.replaceChildren(document.createTextNode(`Thinking using (${model})`), thinkingDots());
}

function renderAssistant(msg, data, { final = false, note = '' } = {}) {
  const parts = assistantParts(msg);
  const { text = '', thoughts = '', model = '' } = data;
  const hasText = text.length > 0;
  const hasThoughts = thoughts.trim().length > 0;

  msg.classList.toggle('is-thinking', !hasText && !final);
  msg.classList.toggle('has-thoughts', hasThoughts);

  parts.status.hidden = hasText || final;

  parts.details.hidden = !hasThoughts;
  if (hasThoughts) parts.thoughtBody.innerHTML = renderMarkdown(thoughts);

  parts.body.hidden = !hasText;
  if (hasText) {
    parts.body.innerHTML = renderMarkdown(text);
    enhanceContent(parts.body);
  }

  const label = model ? (note ? `${model} (${note})` : model) : note;
  parts.meta.hidden = !(final && label);
  parts.meta.textContent = label;
}

function renderTranscript() {
  clearTranscript();
  state.ui.forEach((entry) => {
    if (entry.role === 'user') {
      renderUserMessage(entry);
    } else {
      renderAssistant(createMessage('ai'), entry, { final: true });
    }
  });
  scrollToBottom(true);
}

/** Old sessions (saved before the transcript was stored separately) are rebuilt from `history`. */
function deriveUi(history) {
  return history.map((turn) => {
    const parts = turn.parts ?? [];
    const text = parts.filter((p) => p.text).map((p) => p.text).join('\n');
    if (turn.role === 'user') {
      const files = parts.filter((p) => p.inlineData).map((p, i) => {
        const mime = p.inlineData.mimeType || '';
        const [type, subtype = ''] = mime.split('/');
        const kind = ['image', 'video', 'audio'].includes(type) ? type : mime === 'application/pdf' ? 'pdf' : 'file';
        return { name: `Attachment ${i + 1}`, kind, ext: subtype.toUpperCase().slice(0, 5) || 'FILE' };
      });
      return { role: 'user', text, files };
    }
    return { role: 'ai', text };
  });
}

/* ---------- 7. Generation ---------- */

function setBusy(busy) {
  state.generating = busy;
  els.sendBtn.classList.toggle('is-stop', busy);
  els.sendBtn.setAttribute('aria-label', busy ? 'Stop' : 'Send');
  els.sendBtn.replaceChildren(icon(busy ? 'stop' : 'send'), el('span', 'btn-label', busy ? 'Stop' : 'Send'));
}

function stopGeneration() { state.abort?.abort(); }

async function sendMessage() {
  if (state.generating) return;

  await Promise.all(state.pendingReads); // let files that are still loading finish first

  const text = els.userInput.value.trim();
  if (!text && state.attachments.length === 0) return;
  if (!(await requireAI())) return;

  const parts = state.attachments.map((a) => a.part);
  if (text) parts.push({ text });

  if (estimateBytes([...state.history, { parts }]) > MAX_INLINE_BYTES) {
    toast('This chat plus your attachments is over the 19 MB limit. Remove files or start a new chat.', 5000);
    return;
  }

  const ui = {
    role: 'user',
    text,
    files: state.attachments.map(({ name, size, kind, ext, thumb }) => ({ name, size, kind, ext, thumb })),
  };

  document.querySelectorAll('.retry-btn').forEach((btn) => btn.remove());
  renderUserMessage(ui);
  scrollToBottom(true);

  els.userInput.value = '';
  autoGrow();
  clearAttachments();

  await runTurn({ parts, ui });
}

/** One request/response cycle. `turn` = { parts, ui }. */
/* ---------- 7. Generation (Using engine.js streamChat) ---------- */

async function runTurn(turn) {
  state.abort = new AbortController();
  const { signal } = state.abort;
  setBusy(true);

  // Convert turn parts/ui to engine message format
  const userMessage = {
    role: 'user',
    content: turn.ui.text,
    files: state.attachments.map(a => ({
      name: a.name,
      size: a.size,
      kind: a.kind,
      ext: a.ext,
      mime: mimeFor(a),
      thumb: a.thumb,
      data: a.part?.inlineData?.data || null,
      text: a.part?.text ? a.part.text.replace(/^File: .+\n```\n([\s\S]*)\n```$/, '$1') : null
    }))
  };

  state.history.push(userMessage);
  state.ui.push(turn.ui);

  const bubble = createMessage('ai');
  const selectedModel = parseModelValue(els.modelSelect.value);
  setThinking(bubble, selectedModel.id);
  renderAssistant(bubble, {});
  scrollToBottom(true);

  const result = { text: '', thoughts: '', model: selectedModel.id, finishReason: '' };
  const paint = makeThrottle(() => { renderAssistant(bubble, result); scrollToBottom(); }, STREAM_PAINT_MS);

  let failure = null;

  try {
    const stream = streamChat({
      messages: state.history,
      system: DEFAULT_SYSTEM_PROMPT,
      selected: selectedModel,
      keys: keyStore.all(),
      signal
    });

    for await (const chunk of stream) {
      if (chunk.type === 'status') {
        result.model = chunk.model;
        if (!result.text && !result.thoughts) setThinking(bubble, chunk.model);
      } else if (chunk.type === 'text') {
        result.text += chunk.delta;
        paint();
      } else if (chunk.type === 'thought') {
        result.thoughts += chunk.delta;
        paint();
      } else if (chunk.type === 'fallback') {
        toast(`Switched from ${chunk.from.model} to ${chunk.to.model} (${chunk.reason})`, 4000);
      } else if (chunk.type === 'notice') {
        toast(chunk.message, 4000);
      } else if (chunk.type === 'done') {
        result.finishReason = chunk.finishReason;
      }
    }
  } catch (err) {
    failure = err;
  }

  paint.cancel();
  const stopped = signal.aborted;
  state.abort = null;
  setBusy(false);

  if (result.text.trim() || result.thoughts.trim()) {
    const assistantMessage = {
      role: 'assistant',
      content: result.text,
      thoughts: result.thoughts,
      model: result.model,
      provider: selectedModel.provider
    };
    state.history.push(assistantMessage);
    state.ui.push({ role: 'ai', text: result.text, thoughts: result.thoughts, model: result.model });
    
    renderAssistant(bubble, result, { final: true, note: stopped ? 'stopped' : failure ? 'interrupted' : '' });
    if (failure && !stopped) toast(describeError(failure).message, 5000);
    scrollToBottom();
    saveCurrentSession();
    return;
  }

  // Rollback on complete failure
  state.history.pop();
  state.ui.pop();
  showError(bubble, turn, stopped ? null : failure ?? new Error('The model returned an empty response.'));
}


/* --- model fallback --- */

async function generateWithFallback(result, { signal, onStatus, onUpdate }) {
  const chosen = els.modelSelect.value;
  const queue = [chosen, ...modelIds().filter((m) => m !== chosen)];
  const unavailable = [];
  let lastError = null;

  for (const model of queue) {
    if (signal.aborted) return;
    onStatus(model);
    result.model = model;
    let includeThoughts = true;

    for (;;) { // at most two passes: with the thinking config, then without it
      try {
        await streamFromModel(model, includeThoughts, result, signal, onUpdate);
        if (!signal.aborted && model !== chosen && unavailable.includes(chosen)) {
          els.modelSelect.value = model;
          store.set(STORAGE.model, model);
          toast(`${chosen} isn't available, so I switched to ${model}.`, 4500);
        }
        return;
      } catch (err) {
        if (signal.aborted) return;
        lastError = err;
        if (result.text || result.thoughts) throw err; // partial answer is on screen: don't restart elsewhere
        if (includeThoughts && rejectsThinking(err)) { includeThoughts = false; continue; }
        break;
      }
    }

    if (isModelUnavailable(lastError)) unavailable.push(model);
    if (!shouldFallback(lastError)) throw lastError;
  }
  throw lastError ?? new Error('No model is available.');
}

const ABORTED = Symbol('aborted');

/** Resolves with ABORTED as soon as `signal` fires, even if the SDK ignores the signal itself. */
function raceAbort(promise, signal) {
  promise.catch(() => {}); // a late rejection after an abort is expected
  if (signal.aborted) return Promise.resolve(ABORTED);
  return new Promise((resolve, reject) => {
    const onAbort = () => resolve(ABORTED);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

async function streamFromModel(model, includeThoughts, result, signal, onUpdate) {
  const config = { abortSignal: signal };
  if (includeThoughts) config.thinkingConfig = { includeThoughts: true };

  const stream = await raceAbort(
    state.ai.models.generateContentStream({ model, contents: state.history, config }),
    signal,
  );
  if (stream === ABORTED) return;

  const iterator = stream[Symbol.asyncIterator]();
  try {
    for (;;) {
      const step = await raceAbort(iterator.next(), signal);
      if (step === ABORTED || step.done) break;
      collectChunk(step.value, result);
      onUpdate();
    }
  } finally {
    Promise.resolve(iterator.return?.()).catch(() => {});
  }

  if (!signal.aborted && !result.text.trim()) {
    const reason = result.blockReason || result.finishReason;
    throw Object.assign(
      new Error(reason ? `The model returned no text (${reason}).` : 'The model returned an empty response.'),
      { fatal: true }, // every model would answer the same way
    );
  }
}

function collectChunk(chunk, result) {
  const candidate = chunk?.candidates?.[0];
  result.finishReason = candidate?.finishReason || result.finishReason;
  result.blockReason = chunk?.promptFeedback?.blockReason || result.blockReason;

  const parts = candidate?.content?.parts;
  if (Array.isArray(parts) && parts.length) {
    for (const part of parts) {
      if (!part.text) continue;
      if (part.thought) result.thoughts += part.text;
      else result.text += part.text;
    }
  } else if (typeof chunk?.text === 'string') {
    result.text += chunk.text;
  }
}

/* --- error handling --- */

function errInfo(err) {
  let message = err?.message ?? String(err ?? 'Unknown error');
  let status = err?.status ?? err?.code ?? null;
  try {
    const body = JSON.parse(message);
    if (body?.error) {
      message = body.error.message || message;
      status = body.error.code || status;
    }
  } catch { /* message was not JSON */ }
  return { status: Number(status) || null, message };
}

const rejectsThinking = (err) => {
  const { status, message } = errInfo(err);
  return status === 400 && /think/i.test(message);
};

function isModelUnavailable(err) {
  const { status, message } = errInfo(err);
  return status === 404 || (status === 400 && /model/i.test(message) && /not found|not supported|unsupported|invalid/i.test(message));
}

/** Another model might succeed (overload, quota, missing model). Bad keys, bad payloads and network drops won't. */
function shouldFallback(err) {
  if (err?.fatal || err instanceof TypeError) return false;
  const { status } = errInfo(err);
  if ([401, 403, 413].includes(status)) return false;
  if (status === 400) return isModelUnavailable(err);
  return true;
}

function describeError(err) {
  const { status, message } = errInfo(err);
  let friendly = null;
  if (status === 401 || status === 403 || /api key|API_KEY_INVALID/i.test(message)) {
    friendly = 'Your API key was rejected. Open Key and check that it is correct and enabled.';
  } else if (status === 429) {
    friendly = 'Rate limit or quota reached. Wait a moment, then retry or pick another model.';
  } else if (status === 503 || /overloaded|unavailable/i.test(message)) {
    friendly = 'The model is overloaded right now. Try again shortly.';
  } else if (status === 413 || /too large|exceeds the maximum/i.test(message)) {
    friendly = 'The request is too large. Remove some files or start a new chat.';
  } else if (err instanceof TypeError || /failed to fetch|network/i.test(message)) {
    friendly = 'Network error. Check your connection, then retry.';
  }
  return friendly
    ? { message: friendly, detail: message === friendly ? '' : message }
    : { message, detail: '' };
}

/* ---------- 8. Sessions (IndexedDB) ---------- */

const dbPromise = new Promise((resolve) => {
  if (!('indexedDB' in window)) { resolve(null); return; }
  const request = indexedDB.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains(STORE_NAME)) {
      request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
    }
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => { console.warn('IndexedDB unavailable:', request.error); resolve(null); };
});

async function dbRun(mode, operation) {
  const db = await dbPromise;
  if (!db) return null;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const request = operation(tx.objectStore(STORE_NAME));
    tx.oncomplete = () => resolve(request?.result ?? null);
    tx.onabort = tx.onerror = () => reject(tx.error);
  });
}

const dbGet = (id) => dbRun('readonly', (s) => s.get(id));
const dbPut = (record) => dbRun('readwrite', (s) => s.put(record));
const dbDelete = (id) => dbRun('readwrite', (s) => s.delete(id));

/** Lists id/title/timestamp only, one record at a time, so large attachments never pile up in memory. */
async function dbList() {
  const db = await dbPromise;
  if (!db) return [];
  return new Promise((resolve, reject) => {
    const out = [];
    const tx = db.transaction(STORE_NAME, 'readonly');
    const cursor = tx.objectStore(STORE_NAME).openCursor();
    cursor.onsuccess = () => {
      const c = cursor.result;
      if (!c) return;
      const { id, title, timestamp } = c.value;
      out.push({ id, title, timestamp });
      c.continue();
    };
    tx.oncomplete = () => resolve(out);
    tx.onabort = tx.onerror = () => reject(tx.error);
  });
}

function makeTitle(ui) {
  const first = ui.find((m) => m.role === 'user');
  const base = first?.text?.trim().split('\n')[0]
    || (first?.files?.length ? `Files: ${first.files.map((f) => f.name).join(', ')}` : '');
  if (!base) return 'New Chat';
  return base.length > TITLE_MAX ? `${base.slice(0, TITLE_MAX)}…` : base;
}

async function saveCurrentSession() {
  if (!state.history.length) return;
  try {
    await dbPut({
      id: state.sessionId,
      title: makeTitle(state.ui),
      messages: state.history,
      ui: state.ui,
      timestamp: Date.now(),
    });
    renderHistoryList();
  } catch (err) {
    console.warn('Could not save session:', err);
    toast('Could not save this chat. Storage may be full.');
  }
}

async function renderHistoryList() {
  let sessions = [];
  try { sessions = (await dbList()).sort((a, b) => b.timestamp - a.timestamp); } catch (err) { console.warn(err); }

  if (!sessions.length) {
    els.historyList.replaceChildren(el('p', 'history-empty', 'No saved chats yet.'));
    return;
  }

  els.historyList.replaceChildren(
    ...sessions.map((session) => {
      const item = el('div', `history-item${session.id === state.sessionId ? ' active' : ''}`);

      const open = el('button', 'history-title', session.title);
      open.type = 'button';
      open.title = session.title;
      open.addEventListener('click', () => loadSession(session.id));

      const del = el('button', 'delete-btn');
      del.type = 'button';
      del.setAttribute('aria-label', `Delete chat: ${session.title}`);
      del.append(icon('close'));
      del.addEventListener('click', (e) => { e.stopPropagation(); deleteSession(session.id); });

      item.append(open, del);
      return item;
    }),
  );
}

function resetConversation() {
  state.sessionId = newId();
  state.history = [];
  state.ui = [];
  clearAttachments();
  clearTranscript();
}

const busyGuard = () => {
  if (!state.generating) return false;
  toast('Wait for the current response to finish, or press Stop.');
  return true;
};

async function loadSession(id) {
  if (busyGuard()) return;
  let session = null;
  try { session = await dbGet(id); } catch (err) { console.warn(err); }
  if (!session) { toast('That chat could not be opened.'); return; }

  clearAttachments();
  state.sessionId = session.id;
  state.history = session.messages ?? [];
  state.ui = session.ui ?? deriveUi(state.history);
  renderTranscript();

  if (!desktopMQ.matches) setSidebar(false);
  renderHistoryList();
}

async function deleteSession(id) {
  if (busyGuard()) return;
  if (!confirm('Delete this chat?')) return;
  try { await dbDelete(id); } catch (err) { console.warn(err); }
  if (id === state.sessionId) resetConversation();
  renderHistoryList();
}

function startNewChat() {
  if (busyGuard()) return;
  if (state.history.length || state.ui.length) resetConversation();
  if (!desktopMQ.matches) setSidebar(false);
  renderHistoryList();
  els.userInput.focus();
}

async function clearChat() {
  if (busyGuard()) return;
  if (state.history.length && !confirm('Clear this conversation? It will also be removed from your history.')) return;
  const id = state.sessionId;
  resetConversation();
  try { await dbDelete(id); } catch (err) { console.warn(err); }
  renderHistoryList();
}

/* ---------- 9. Sidebar ---------- */

const desktopMQ = window.matchMedia('(min-width: 900px)');

function isSidebarOpen() {
  return desktopMQ.matches
    ? !document.body.classList.contains('sidebar-collapsed')
    : els.sidebar.classList.contains('open');
}

function setSidebar(open) {
  if (desktopMQ.matches) {
    document.body.classList.toggle('sidebar-collapsed', !open);
    store.set(STORAGE.sidebar, open ? '1' : '0');
  } else {
    els.sidebar.classList.toggle('open', open);
    els.overlay.classList.toggle('active', open);
  }
  els.menuBtn.setAttribute('aria-expanded', String(open));
}

function syncSidebarToViewport() {
  els.sidebar.classList.remove('open');
  els.overlay.classList.remove('active');
  document.body.classList.toggle('sidebar-collapsed', desktopMQ.matches && store.get(STORAGE.sidebar) === '0');
  els.menuBtn.setAttribute('aria-expanded', String(isSidebarOpen()));
}

/* ---------- 10. Init & event wiring ---------- */

function autoGrow() {
  els.userInput.style.height = 'auto';
  els.userInput.style.height = `${Math.min(els.userInput.scrollHeight, 200)}px`;
}

/** Keeps the layout the size of what is actually visible (on-screen keyboard, iOS toolbars). */
function trackViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const sync = () => {
    if (vv.scale > 1.01) return; // pinch-zoomed: leave the layout alone
    document.documentElement.style.setProperty('--app-h', `${Math.round(vv.height)}px`);
    if (vv.offsetTop > 0) window.scrollTo(0, 0);
    scrollToBottom();
  };
  vv.addEventListener('resize', sync);
  vv.addEventListener('scroll', sync);
  sync();
}

function wireDragAndDrop() {
  let depth = 0;
  const hasFiles = (e) => e.dataTransfer?.types?.includes('Files');
  const reset = () => { depth = 0; document.body.classList.remove('dragging'); };

  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    document.body.classList.add('dragging');
  });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('dragleave', (e) => {
    if (hasFiles(e) && --depth <= 0) reset();
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    reset();
    addFiles(e.dataTransfer.files);
  });
}

function init() {
  // Model Dropdown Setup
  renderModelDropdown();
  refreshCatalogs().catch((err) => console.warn('Catalog refresh failed:', err));
  els.modelSelect.addEventListener('change', () => store.set(STORAGE.model, els.modelSelect.value));
   

  // Composer
  els.sendBtn.addEventListener('click', () => (state.generating ? stopGeneration() : sendMessage()));
  els.userInput.addEventListener('input', autoGrow);
  els.userInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    // Desktop: Enter sends, Shift+Enter adds a line. Touch screens: Enter adds a line, the button sends.
    const touch = window.matchMedia('(pointer: coarse)').matches;
    if (e.ctrlKey || e.metaKey || (!e.shiftKey && !touch)) {
      e.preventDefault();
      sendMessage();
    }
  });
  els.userInput.addEventListener('paste', (e) => {
    const files = e.clipboardData?.files;
    if (files?.length && !e.clipboardData.getData('text/plain')) {
      e.preventDefault();
      addFiles(files);
    }
  });

  // Attachments
  els.attachBtn.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', () => {
    addFiles(els.fileInput.files);
    els.fileInput.value = ''; // lets the same file be picked again later
  });
  els.removeFileBtn.addEventListener('click', clearAttachments);
  wireDragAndDrop();

  // Header & key modal
  els.clearChatBtn.addEventListener('click', clearChat);
  els.keyBtn.addEventListener('click', openKeyModal);
  els.emptyKeyBtn.addEventListener('click', openKeyModal);
  els.saveKeyBtn.addEventListener('click', saveKey);
  els.closeKeyBtn.addEventListener('click', closeKeyModal);
  els.removeKeyBtn.addEventListener('click', removeKey);
  els.apiKeyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveKey(); });
  els.toggleKeyBtn.addEventListener('click', () => {
    const show = els.apiKeyInput.type === 'password';
    els.apiKeyInput.type = show ? 'text' : 'password';
    els.toggleKeyBtn.textContent = show ? 'Hide' : 'Show';
    els.toggleKeyBtn.setAttribute('aria-pressed', String(show));
  });
  els.keyModal.addEventListener('click', (e) => { if (e.target === els.keyModal) closeKeyModal(); });

  // Sidebar
  els.menuBtn.addEventListener('click', () => setSidebar(!isSidebarOpen()));
  els.overlay.addEventListener('click', () => setSidebar(false));
  els.newChatBtn.addEventListener('click', startNewChat);
  desktopMQ.addEventListener('change', syncSidebarToViewport);
  syncSidebarToViewport();

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!els.keyModal.hidden) closeKeyModal();
    else if (!desktopMQ.matches && isSidebarOpen()) setSidebar(false);
  });

  // Follow the stream only while the reader is near the bottom
  els.chatBox.addEventListener('scroll', () => {
    const box = els.chatBox;
    stickToBottom = box.scrollHeight - box.scrollTop - box.clientHeight < STICK_THRESHOLD;
  }, { passive: true });

  trackViewport();
  setBusy(false);
  renderAttachments();
  syncEmptyState();
  renderHistoryList();

  // Warm up the SDK if a key is already saved (no modal, no interruption)
  const savedKey = store.get(STORAGE.apiKey);
  if (savedKey) initAI(savedKey).catch((err) => console.warn('SDK load failed:', err));
}

init();

// Register Service Worker for PWA & offline support
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then((reg) => console.log('Service Worker registered:', reg.scope))
      .catch((err) => console.warn('Service Worker registration failed:', err));
  });
}
