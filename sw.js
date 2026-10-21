/* ==========================================================================
   sw.js — makes the app open offline, and stays out of the way of the AI calls
   ========================================================================== */

// Bumped after the fix pass; old v2 caches are deleted on activate.
const CACHE = 'studio-v3';

const CORE = ['./', './index.html', './app.js', './engine.js', './storage.js', './memory.js', './style.css', './manifest.json'];
const NICE_TO_HAVE = ['./icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png'];

const CDN_URLS = [
  'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js',
  'https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.1.6/purify.min.js',
];
const CDN_HOSTS = new Set(['cdnjs.cloudflare.com', 'cdn.jsdelivr.net']);

const NETWORK_TIMEOUT_MS = 4000;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(CORE.map((url) => cache.add(new Request(url, { cache: 'reload' }))));
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
    // Only touch caches this service worker owns (prefixed "studio-"). Prefix match rather than
    // exact name so a sibling PWA on the same origin keeps its own cache.
    await Promise.all(
      names
        .filter((name) => name.startsWith('studio-') && name !== CACHE)
        .map((name) => caches.delete(name)),
    );
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
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  // The old withTimeout() wrapper rejected on the JS side but left the fetch running in the
  // background (holding the connection open). This aborts it for real.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);
  try {
    const res = await fetch(request.url, {
      cache: 'no-cache',
      credentials: 'same-origin',
      signal: controller.signal,
    });
    if (res.ok) {
      cache.put(request, res.clone());
      return request.mode === 'navigate' && res.redirected ? await plainCopy(res) : res;
    }
    return (await cache.match(request)) || res;
  } catch {
    const saved = await cache.match(request, { ignoreSearch: request.mode === 'navigate' });
    if (saved) return saved;
    if (request.mode === 'navigate') {
      const shell = (await cache.match('./index.html')) || (await cache.match('./'));
      if (shell) return shell;
    }
    return Response.error();
  } finally {
    clearTimeout(timer);
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

async function plainCopy(res) {
  return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers });
}