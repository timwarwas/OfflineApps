/* Service Worker der Anwendungssammlung: hält einzelne Apps für die Offline-Nutzung bereit.
   Betrifft ausschließlich die Seiten in PAGES – alle anderen Seiten bleiben unberührt.
   Strategie: erst Netz (immer aktueller Stand), ohne Netz die zuletzt geladene Version. */
const CACHE = 'essensplanung-v1';   // Name beibehalten, damit der bestehende Offline-Stand erhalten bleibt
const PAGES = ['/essensplanung.html', '/kosten.html', '/workout.html', '/cocktails.html', '/spiele.html'];
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

/* ---------- Mitteilungen (Web-Push vom Push-Dienst auf dem Pi) ----------
   Die Nachricht enthält nur Kanal, Art und einen verschlüsselten Block. Den Schlüssel legen die Apps
   in IndexedDB „push-keys“ ab; ohne Schlüssel erscheint ein neutraler Hinweis. */
function pushKey(ch) {
  return new Promise(res => {
    const r = indexedDB.open('push-keys', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('k');
    r.onerror = () => res(null);
    r.onsuccess = () => { try { const q = r.result.transaction('k').objectStore('k').get(ch); q.onsuccess = () => { res(q.result || null); r.result.close(); }; q.onerror = () => res(null); } catch (e) { res(null); } };
  });
}
const b64d = s => { s = String(s).replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
async function openBox(keyB64, box) {
  const p = String(box || '').split('.');
  if (p.length !== 3 || p[0] !== 'v1') return null;
  const key = await crypto.subtle.importKey('raw', b64d(keyB64), 'AES-GCM', false, ['decrypt']);
  return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(p[1]) }, key, b64d(p[2]))));
}
const KIND_TITLE = { timer: 'Timer abgelaufen', remind: 'Kocherinnerung', einkauf: 'Einkaufsliste', plan: 'Wochenplan', invite: 'Neue Einladung', kosten: 'Neue Ausgabe', spiele: 'Spiele', cocktails: 'Cocktails' };
self.addEventListener('push', e => e.waitUntil((async () => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (err) {}
  let m = null;
  try { const k = await pushKey(d.ch); if (k) m = await openBox(k, d.box); } catch (err) { m = null; }
  const title = (m && m.title) || KIND_TITLE[d.kind] || 'Anwendungssammlung';
  return self.registration.showNotification(title, {
    body: (m && m.body) || 'Öffne die App für Details.',
    tag: (m && m.tag) || d.tag || undefined,
    renotify: true,
    data: { url: (m && m.url) || 'index.html' },
  });
})()));
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL(e.notification.data && e.notification.data.url || 'index.html', self.registration.scope).href;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) { if ('focus' in c) { try { await c.navigate(url); } catch (err) {} return c.focus(); } }
    return self.clients.openWindow(url);
  })());
});
