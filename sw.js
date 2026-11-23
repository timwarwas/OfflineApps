/* Service Worker der Anwendungssammlung: hält die Apps für die Offline-Nutzung bereit.
   Betrifft ausschließlich die Seiten in PAGES – alle anderen Seiten bleiben unberührt.
   Strategie (seit 23.11.2026): sofort die gespeicherte Version zeigen und im Hintergrund nachladen.
   Ist die geladene Fassung neuer, bekommt die geöffnete Seite die Nachricht {type: 'sw-update'} und
   zeigt „Neue Version · Neu laden“. Vorher wurde bei jedem Start erst die ganze Seite aus dem Netz
   geladen – bei schwachem Empfang dauerte der Start dadurch mehrere Sekunden. */
const CACHE = 'essensplanung-v1';   // Name beibehalten, damit der bestehende Offline-Stand erhalten bleibt
const PAGES = ['/index.html', '/essensplanung.html', '/kosten.html', '/workout.html', '/cocktails.html', '/spiele.html', '/verstecken.html'];
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
const pause = ms => new Promise(r => setTimeout(r, ms));
const stamp = r => r && (r.headers.get('etag') || r.headers.get('last-modified'));
async function isNewer(cached, fresh) {
  if (stamp(cached) && stamp(fresh)) return stamp(cached) !== stamp(fresh);
  try { return (await cached.clone().text()) !== (await fresh.clone().text()); } catch (e) { return false; }
}
async function tell(clientId, page) {   // die gerade geöffnete Seite benachrichtigen (sie lädt evtl. noch)
  for (let i = 0; i < 20; i++) {
    const c = clientId && await self.clients.get(clientId);
    if (c) { c.postMessage({ type: 'sw-update', page }); return; }
    await pause(500);
  }
}
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin === location.origin && url.pathname.endsWith('/')) url.pathname += 'index.html';   // Aufruf des Ordners = Hauptmenü
  if (e.request.method !== 'GET' || url.origin !== location.origin || !(PAGES.some(p => url.pathname.endsWith(p)))) return;
  const page = PAGES.find(p => url.pathname.endsWith(p));
  let finish; e.waitUntil(new Promise(r => { finish = r; }));   // Hintergrund-Laden darf zu Ende laufen
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(url.pathname);
    const update = fetch(e.request).then(async res => {
      if (res.ok) {
        const newer = cached && await isNewer(cached, res);
        await cache.put(url.pathname, res.clone());
        if (newer) await tell(e.resultingClientId || e.clientId, page);
      }
      return res;
    });
    update.catch(() => {}).then(finish);
    if (cached) return cached.clone();   // sofort starten (Kopie: das Original wird danach mit der neuen Fassung verglichen)
    return update.catch(() => caches.match(e.request, { ignoreSearch: true }));   // erster Start: Netz
  })().catch(err => { finish(); throw err; }));
});

/* ---------- Mitteilungen (Web-Push vom Push-Dienst auf dem Pi) ----------
   Die Nachricht enthält nur Kanal, Art und einen verschlüsselten Block. Den Schlüssel legen die Apps
   in IndexedDB „push-keys“ ab; ohne Schlüssel erscheint ein neutraler Hinweis. */
function idbKey(name, ch) {
  return new Promise(res => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('k');
    r.onerror = () => res(null);
    r.onsuccess = () => { try { const q = r.result.transaction('k').objectStore('k').get(ch); q.onsuccess = () => { res(q.result || null); r.result.close(); }; q.onerror = () => res(null); } catch (e) { res(null); } };
  });
}
/* „verstecken-keys“: eigene Kanäle der Verstecken-App (getrennt, weil push.js „push-keys“ beim Abgleich leert) */
async function pushKey(ch) { return (await idbKey('push-keys', ch)) || (await idbKey('verstecken-keys', ch)); }
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
