/* ==========================================================================
   storage.js — API keys and the cached model lists (localStorage only)
   ========================================================================== */

const KEY_NAMES = { gemini: 'GEMINI_API_KEY', openrouter: 'OPENROUTER_API_KEY' };
const CATALOG_KEY = 'MODEL_CATALOG_CACHE_V1';

const read = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key, value) => { try { localStorage.setItem(key, value); return true; } catch { return false; } };
const drop = (key) => { try { localStorage.removeItem(key); } catch { /* storage blocked */ } };

export const keyStore = {
  get(provider) { return (read(KEY_NAMES[provider]) || '').trim(); },
  set(provider, value) { return write(KEY_NAMES[provider], String(value).trim()); },
  remove(provider) { drop(KEY_NAMES[provider]); },
  all() { return { gemini: this.get('gemini'), openrouter: this.get('openrouter') }; },
};

/** { gemini?: { models, ts }, openrouter?: { models, ts } } */
export function loadCatalogCache() {
  try { return JSON.parse(read(CATALOG_KEY)) || {}; } catch { return {}; }
}

export function saveCatalogCache(provider, models) {
  const cache = loadCatalogCache();
  cache[provider] = { models, ts: Date.now() };
  write(CATALOG_KEY, JSON.stringify(cache));
}

/** Removes one provider's cached model list (used when its key is deleted). */
export function removeCatalogCache(provider) {
  const cache = loadCatalogCache();
  if (!(provider in cache)) return;
  delete cache[provider];
  write(CATALOG_KEY, JSON.stringify(cache));
}

/* ---------- Memory notes (shared by every chat) ---------- */

const MEMORY_KEY = 'MEMORY_NOTES_V1';

// Defensive upper bound. The active cap is memory.js's MAX_NOTES = 40, enforced by mergeNotes;
// this only trims hand-edited storage so a huge list can't blow up the system prompt.
const STORED_NOTES_HARD_CAP = 200;

export const memoryStore = {
  /** { enabled: boolean, notes: string[] } */
  load() {
    try {
      const m = JSON.parse(read(MEMORY_KEY));
      const notes = Array.isArray(m?.notes) ? m.notes.filter((n) => typeof n === 'string') : [];
      return { enabled: m?.enabled !== false, notes: notes.slice(-STORED_NOTES_HARD_CAP) };
    } catch {
      return { enabled: true, notes: [] };
    }
  },
  save({ enabled, notes }) {
    return write(MEMORY_KEY, JSON.stringify({ enabled: enabled !== false, notes }));
  },
};