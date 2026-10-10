/* ==========================================================================
   storage.js — API keys and the cached model lists (localStorage only)
   Every call is wrapped so private-mode / blocked storage never throws.
   ========================================================================== */

// The Gemini key keeps the name app.js always used, so a saved key survives the upgrade.
const KEY_NAMES = { gemini: 'GEMINI_API_KEY', openrouter: 'OPENROUTER_API_KEY' };
const CATALOG_KEY = 'MODEL_CATALOG_CACHE_V1';

const read = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key, value) => { try { localStorage.setItem(key, value); return true; } catch { return false; } };
const drop = (key) => { try { localStorage.removeItem(key); } catch { /* storage blocked */ } };

export const keyStore = {
  get(provider) { return (read(KEY_NAMES[provider]) || '').trim(); },
  set(provider, value) { return write(KEY_NAMES[provider], String(value).trim()); },
  remove(provider) { drop(KEY_NAMES[provider]); },
  /** { gemini: 'key or empty string', openrouter: '…' } */
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
