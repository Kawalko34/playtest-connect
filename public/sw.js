/* Play Test SW v1 — network-first, cache fallback for offline shell.
   /api is NEVER cached (live data only). */
const CACHE = 'playtest-v1';
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
  await clients.claim();
})()));
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api')) return;
  e.respondWith((async () => {
    try {
      const r = await fetch(e.request);
      if (r.ok && url.origin === location.origin) {
        const c = await caches.open(CACHE);
        c.put(e.request, r.clone());
      }
      return r;
    } catch (_) {
      const m = await caches.match(e.request);
      return m || Response.error();
    }
  })());
});
