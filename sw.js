/* ==========================================================================
   sw.js — makes the app open offline, and stays out of the way of the AI calls

   Three rules, in this order:
   1. Only plain GET requests are handled. Everything else goes straight to the network.
   2. Your own files (html, js, css, icons): network first, so a new deploy shows up
      right away, with the saved copy as the offline fallback.
   3. The few CDN libraries (markdown, highlighting): cache first, they never change.

   Any other host, including generativelanguage.googleapis.com and openrouter.ai, is
   not handled at all. That is what keeps token streaming exactly as it is without a
   service worker, and means no model answer is ever cached.
   ========================================================================== */

// Bump this only to throw away every saved file. Normal deploys do not need it.
const CACHE = 'studio-v1';

// If a deploy changes this list, the page picks it up the next time it is online.
const CORE = ['./', './index.html', './app.js', './engine.js', './storage.js', './memory.js', './style.css', './manifest.json'];
const NICE_TO_HAVE = ['./icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png'];

// The exact URLs index.html loads. Fetching them now means markdown and code
// highlighting work offline from the very first visit.
const CDN_URLS = [
  'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js',
  'https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.1.6/purify.min.js',
];
const CDN_HOSTS = new Set(['cdnjs.cloudflare.com', 'cdn.jsdelivr.net']);

const NETWORK_TIMEOUT_MS = 4000; // on a very slow connection, fall back to the saved copy

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Core files must all arrive, otherwise this install is dropped and retried later.
    await Promise.all(CORE.map((url) => cache.add(new Request(url, { cache: 'reload' }))));
    // These may fail without breaking the install.
    await Promise.allSettled([
      ...NICE_TO_HAVE.map((url) => cache.add(new Request(url, { cache: 'reload' }))),
      ...CDN_URLS.map((url) => cache.add(new Request(url, { mode: 'cors' }))),
    ]);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || request.headers.has('range')) return;

  const url = new URL(request.url);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return;

  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(request));
  } else if (CDN_HOSTS.has(url.hostname) && !url.pathname.includes('/eruda')) {
    event.respondWith(cacheFirst(request));
  }
  // anything else: not handled, the browser talks to the network directly
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    // "no-cache" forces a check with the server, so the browser's own HTTP cache
    // (GitHub Pages keeps files for 10 minutes) cannot serve an outdated app.
    const res = await withTimeout(fetch(request.url, { cache: 'no-cache', credentials: 'same-origin' }), NETWORK_TIMEOUT_MS);
    if (res.ok) {
      cache.put(request, res.clone());
      return request.mode === 'navigate' && res.redirected ? await plainCopy(res) : res;
    }
    return (await cache.match(request)) || res; // server error: prefer a saved copy over an error page
  } catch {
    const saved = await cache.match(request, { ignoreSearch: request.mode === 'navigate' });
    if (saved) return saved;
    if (request.mode === 'navigate') {
      const shell = (await cache.match('./index.html')) || (await cache.match('./'));
      if (shell) return shell;
    }
    return Response.error();
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const saved = await cache.match(request);
  if (saved) return saved;
  const res = await fetch(request);
  if (res.ok || res.type === 'opaque') cache.put(request, res.clone());
  return res;
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/** Browsers refuse a redirected response for a page load, so hand back a clean copy. */
async function plainCopy(res) {
  return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers });
}
