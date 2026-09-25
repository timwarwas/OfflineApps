/* Service Worker der Anwendungssammlung: hält einzelne Apps für die Offline-Nutzung bereit.
   Betrifft ausschließlich die Seiten in PAGES – alle anderen Seiten bleiben unberührt.
   Strategie: erst Netz (immer aktueller Stand), ohne Netz die zuletzt geladene Version. */
const CACHE = 'essensplanung-v1';   // Name beibehalten, damit der bestehende Offline-Stand erhalten bleibt
const PAGES = ['/essensplanung.html', '/kosten.html', '/workout.html'];
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || !(PAGES.some(p => url.pathname.endsWith(p)))) return;
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(url.pathname, copy));
      }
      return res;
    }).catch(() => caches.open(CACHE).then(c => c.match(url.pathname)).then(r => r || caches.match(e.request, { ignoreSearch: true })))
  );
});
