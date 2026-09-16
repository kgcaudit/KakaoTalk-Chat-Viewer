// Offline shell for 대화서랍.
//
// This worker caches ONE thing: the viewer document itself. Conversations live in
// IndexedDB and never pass through here, so nothing a user imports is ever written
// to the cache. Only same-origin navigations to the app's own address are handled;
// every other request goes straight to the network untouched.
const CACHE = 'daehwa-seorap-shell-v1';
const SHELL = new URL('./', self.location).href;

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.add(new Request(SHELL, { cache: 'reload' })))
      .catch(() => {})
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
    await self.clients.claim();
  })());
});

// Network first: an online visit always gets the newest build, so a cached copy can
// never pin someone to an old version. The cache is only the fallback when offline.
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || request.mode !== 'navigate') return;
  if (new URL(request.url).href.split('?')[0].split('#')[0] !== SHELL) return;

  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response && response.ok) {
        const cache = await caches.open(CACHE);
        await cache.put(SHELL, response.clone());
      }
      return response;
    } catch (offline) {
      const cached = await caches.match(SHELL);
      if (cached) return cached;
      throw offline;
    }
  })());
});
