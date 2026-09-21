/* Service Worker der Essensplanung: hält die App für die Offline-Nutzung bereit.
   Betrifft ausschließlich essensplanung.html – alle anderen Seiten bleiben unberührt. */
const CACHE = 'essensplanung-v1';
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || !url.pathname.endsWith('/essensplanung.html')) return;
  e.respondWith(
    fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request))
  );
});
