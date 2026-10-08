/* ==========================================================================
   storage.js: everything that is saved on the device.
     · localStorage: API keys, preferences, the cached model lists
     · IndexedDB:    chat sessions

   Browser storage is NOT encrypted: anyone with access to this device's browser profile can read it.
   For a Capacitor app, swap the `store` object below for @capacitor/preferences or a secure-storage
   plugin; nothing else in the app needs to change.
   ========================================================================== */

/* ---------- localStorage ---------- */

export const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* storage blocked or full */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* storage blocked */ } },
};

const KEY_NAMES = { gemini: 'gemini_api_key', openrouter: 'openrouter_api_key' };

export const keyStore = {
  get: (provider) => store.get(KEY_NAMES[provider]) || '',
  set: (provider, value) => store.set(KEY_NAMES[provider], value),
  remove: (provider) => store.remove(KEY_NAMES[provider]),
  all: () => ({ gemini: keyStore.get('gemini'), openrouter: keyStore.get('openrouter') }),
};

// Older versions saved the Gemini key as GEMINI_API_KEY: carry it over once so nobody has to re-enter it.
(function migrateLegacyKey() {
  const legacy = store.get('GEMINI_API_KEY');
  if (!legacy) return;
  if (!keyStore.get('gemini')) keyStore.set('gemini', legacy);
  store.remove('GEMINI_API_KEY');
})();

/* ---------- cached model lists (so the dropdown is full instantly and works offline) ---------- */

const CATALOG_KEY = 'model_catalog_v1';

export function loadCatalogCache() {
  try { return JSON.parse(store.get(CATALOG_KEY) || '{}'); } catch { return {}; }
}

export function saveCatalogCache(provider, models) {
  const cache = loadCatalogCache();
  if (models?.length) cache[provider] = { at: Date.now(), models };
  else delete cache[provider];
  store.set(CATALOG_KEY, JSON.stringify(cache));
}

/* ---------- IndexedDB: chat sessions ---------- */

const DB_NAME = 'ChatHistoryDB';
const DB_VERSION = 1;
const STORE_NAME = 'sessions';

/** Version 2 sessions hold provider-agnostic messages. Version 1 held Gemini `contents` plus a separate `ui` list. */
export const SESSION_VERSION = 2;

const dbPromise = new Promise((resolve) => {
  if (typeof indexedDB === 'undefined') { resolve(null); return; }
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

export const dbGet = (id) => dbRun('readonly', (s) => s.get(id));
export const dbPut = (record) => dbRun('readwrite', (s) => s.put(record));
export const dbDelete = (id) => dbRun('readwrite', (s) => s.delete(id));

/** id/title/timestamp only, one record at a time, so large attachments never pile up in memory. */
export async function dbList() {
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

/* ---------- old sessions -> current message format ---------- */

const kindFromMime = (mime = '') => {
  const [type] = mime.split('/');
  return ['image', 'video', 'audio'].includes(type) ? type : mime === 'application/pdf' ? 'pdf' : 'file';
};
const extOf = (name = '') => (name.includes('.') ? name.split('.').pop().toUpperCase().slice(0, 5) : 'FILE');

/** Returns the session's messages in the current format, converting version 1 sessions on the fly. */
export function migrateSession(session) {
  if (session.version === SESSION_VERSION) return session.messages ?? [];

  const ui = session.ui ?? [];
  const userMeta = ui.filter((m) => m.role === 'user');
  const aiMeta = ui.filter((m) => m.role === 'ai');
  let userIndex = 0;
  let aiIndex = 0;

  return (session.messages ?? []).map((turn) => {
    const parts = turn.parts ?? [];

    if (turn.role === 'user') {
      const meta = userMeta[userIndex++]?.files ?? [];
      let fileIndex = 0;
      const files = [];
      const texts = [];
      for (const part of parts) {
        if (part.inlineData) {
          const m = meta[fileIndex++] ?? {};
          const { mimeType, data } = part.inlineData;
          files.push({ name: m.name || `Attachment ${fileIndex}`, size: m.size, kind: m.kind || kindFromMime(mimeType), ext: m.ext, mime: mimeType, thumb: m.thumb, data });
        } else if (typeof part.text === 'string') {
          const asFile = part.text.match(/^File: (.+)\n```\n([\s\S]*)\n```$/);
          if (asFile) {
            const m = meta[fileIndex++] ?? {};
            files.push({ name: asFile[1], size: m.size, kind: 'text', ext: m.ext || extOf(asFile[1]), thumb: m.thumb, text: asFile[2] });
          } else {
            texts.push(part.text);
          }
        }
      }
      return { role: 'user', content: texts.join('\n'), files };
    }

    const meta = aiMeta[aiIndex++] ?? {};
    return {
      role: 'assistant',
      content: parts.map((p) => p.text ?? '').join(''),
      thoughts: meta.thoughts,
      model: meta.model,
      provider: 'gemini',
    };
  });
}
