/* ==========================================================================
   Gemini Mobile Studio: service worker

   Strategy: network-first for the app's own files, with the saved copy as the offline fallback.
   Unlike cache-first, this can never trap a device on an old version: whenever you are online,
   you get the files that are currently on the server.

   Bump CACHE_VERSION to make every device drop its saved copies on the next visit.
   ========================================================================== */

// NEW CODE
const CACHE_VERSION = 'v5';
const CACHE = `gemini-studio-${CACHE_VERSION}`;
const APP_SHELL = [
  './',
  './index.html',
  './app.js',
  './engine.js',
  './storage.js',
  './style.css',
  './manifest.json'
];

// Saved copies from earlier versions of this app (any cache with "gemini" in its name) are cleaned up.
// Caches belonging to other sites on the same domain are left alone.
const OLD_APP_CACHES = /gemini/i;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // cache:'reload' skips the browser's HTTP cache, so a fresh install never saves stale files.
    // allSettled: a missing optional file (e.g. manifest.json) must not block the install.
    await Promise.allSettled(APP_SHELL.map(async (url) => {
      const response = await fetch(new Request(url, { cache: 'reload' }));
      if (response.status === 200) await cache.put(url, response);
    }));
    await self.skipWaiting(); // take over right away instead of waiting for every tab to close
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names.filter((name) => name !== CACHE && OLD_APP_CACHES.test(name)).map((name) => caches.delete(name)),
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only the app's own files. Gemini API calls and CDN libraries go straight to the network.
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  event.respondWith(networkFirst(event));
});

async function networkFirst(event) {
  const { request } = event;
  const cache = await caches.open(CACHE);

  try {
    // 'no-cache' = ask the server whether the file changed (a cheap 304 if not) instead of trusting a stale HTTP-cached copy.
    const fresh = await fetch(request.url, { cache: 'no-cache' });

    // A navigation can't be answered with a redirected response; hand the redirect back to the browser instead.
    if (request.mode === 'navigate' && fresh.redirected) return Response.redirect(fresh.url, 302);

    if (fresh.status === 200) event.waitUntil(cache.put(request.url, fresh.clone()));
    return fresh;
  } catch {
    // Offline (or the server is down): fall back to the last copy we saved.
    const saved = await cache.match(request.url, { ignoreSearch: true, ignoreVary: true });
    if (saved) return saved;
    if (request.mode === 'navigate') {
      const shell = await cache.match('./index.html', { ignoreVary: true });
      if (shell) return shell;
    }
    return Response.error();
  }
}
