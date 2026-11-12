/* Only versioned assets and the public offline page are stored. */
const CACHE = 'aq-shell-v1';
const SHELL = '/offline.html';
const PUBLIC_ASSETS = [SHELL, '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PUBLIC_ASSETS)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('aq-shell-') && name !== CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'ACTIVATE_UPDATE') event.waitUntil(self.skipWaiting());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin ||
      url.pathname === '/api' || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(async () => (await caches.match(SHELL)) || Response.error()));
    return;
  }
  if (!PUBLIC_ASSETS.includes(url.pathname) && !url.pathname.startsWith('/_next/static/')) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok && !response.redirected && response.type === 'basic') {
      await cache.put(request, response.clone()).catch(() => undefined);
    }
    return response;
  })());
});
