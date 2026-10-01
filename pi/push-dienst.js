#!/usr/bin/env node
/* Push-Dienst der Anwendungssammlung (läuft auf dem Pi neben PocketBase).
   - Geräte melden ihr Push-Abo mit einer Liste von Kanälen und gewünschten Arten an.
   - Apps schicken Mitteilungen an Kanäle (sofort oder zu einem Zeitpunkt, z. B. Kochtimer).
   - Kanal-IDs und Inhalte sind aus den Geheimnissen der Apps abgeleitet bzw. verschlüsselt:
     der Dienst kennt weder Namen noch Texte, nur „Kanal X, Art Y, verschlüsselter Block“.
   Keine Fremdbibliotheken, nur Node.js (ab Version 18). */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const wp = require('./webpush.js');

const DIR = process.env.PUSH_DIR || '/var/lib/push-dienst';
const PORT = +process.env.PUSH_PORT || 8091;
const ORIGIN = process.env.PUSH_ORIGIN || 'https://timwarwas.github.io';
const SUBJECT = process.env.PUSH_SUBJECT || 'https://timwarwas.github.io/OfflineApps/';
const KINDS = ['test', 'timer', 'remind', 'invite', 'kosten', 'einkauf', 'plan', 'spiele', 'cocktails'];
const LIMIT = { body: 8000, box: 4000, channels: 200, jobsPerChannel: 60, sendsPerMin: 60 };
const sendImpl = { fn: wp.send };   // für Tests austauschbar

fs.mkdirSync(DIR, { recursive: true });
const FILE = path.join(DIR, 'state.json'), VAPID = path.join(DIR, 'vapid.json');
let vapid;
try { vapid = JSON.parse(fs.readFileSync(VAPID, 'utf8')); }
catch (e) { vapid = wp.generateVapidKeys(); fs.writeFileSync(VAPID, JSON.stringify(vapid), { mode: 0o600 }); }
let state = { devices: {}, jobs: [] };
try { state = Object.assign(state, JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch (e) {}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { fs.writeFileSync(FILE + '.tmp', JSON.stringify(state)); fs.renameSync(FILE + '.tmp', FILE); }, 300);
}
const hash = s => crypto.createHash('sha256').update(String(s)).digest('base64url');
const isId = s => typeof s === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(s);
const log = (...a) => console.log(new Date().toISOString(), ...a);

/* ---------- Zustellung ---------- */
async function deliver(job) {
  const targets = Object.entries(state.devices).filter(([id, d]) => id !== job.exclude && job.channels.some(ch => {
    const kinds = d.channels[ch]; return kinds && (!kinds.length || kinds.includes(job.kind));
  }));
  let ok = 0;
  for (const [id, d] of targets) {
    const ch = job.channels.find(c => d.channels[c]);
    const payload = JSON.stringify({ ch, kind: job.kind, box: job.boxes[ch] || job.boxes['*'], tag: job.tag || null, at: job.at || null });
    const r = await sendImpl.fn(d.sub, payload, vapid, SUBJECT, job.ttl || 3600, 'high');
    if (r.status === 404 || r.status === 410) { delete state.devices[id]; save(); log('Abo entfernt', id.slice(0, 6)); }
    else if (r.status >= 200 && r.status < 300) ok++;
    else log('Zustellung fehlgeschlagen', r.status, r.error || '');
  }
  return { targets: targets.length, ok };
}
async function tick() {
  const now = Date.now(), due = state.jobs.filter(j => j.atMs <= now);
  if (!due.length) return;
  state.jobs = state.jobs.filter(j => j.atMs > now); save();
  for (const j of due) await deliver(j);
}

/* ---------- Anfragen ---------- */
const sendCounts = new Map();
function rateOk(ip) {
  const m = Math.floor(Date.now() / 60000), k = ip + '|' + m, n = (sendCounts.get(k) || 0) + 1;
  sendCounts.set(k, n); if (sendCounts.size > 5000) sendCounts.clear();
  return n <= LIMIT.sendsPerMin;
}
const routes = {
  'GET /vapid': () => [200, { publicKey: vapid.publicKey }],
  'GET /health': () => [200, { ok: true, devices: Object.keys(state.devices).length, jobs: state.jobs.length }],
  /* Gerät anmelden/aktualisieren: { device, secret, sub:{endpoint,keys:{p256dh,auth}}, channels:{ch:[kinds]} } */
  'POST /subscribe': b => {
    if (!isId(b.device) || !isId(b.secret)) return [400, { error: 'device/secret' }];
    const cur = state.devices[b.device];
    if (cur && cur.secret !== hash(b.secret)) return [403, { error: 'secret' }];
    const s = b.sub || {};
    if (typeof s.endpoint !== 'string' || !/^https:\/\//.test(s.endpoint) || !s.keys || !s.keys.p256dh || !s.keys.auth) return [400, { error: 'sub' }];
    const channels = {};
    for (const [ch, kinds] of Object.entries(b.channels || {}).slice(0, LIMIT.channels)) {
      if (!isId(ch) || !Array.isArray(kinds)) continue;
      channels[ch] = kinds.filter(k => KINDS.includes(k));
    }
    state.devices[b.device] = { secret: hash(b.secret), sub: { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } }, channels, seen: new Date().toISOString() };
    save();
    return [200, { ok: true, channels: Object.keys(channels).length }];
  },
  'POST /unsubscribe': b => {
    const cur = state.devices[b.device];
    if (cur && cur.secret === hash(b.secret)) { delete state.devices[b.device]; save(); }
    return [200, { ok: true }];
  },
  /* Mitteilung: { channels:[...], kind, boxes:{ch|'*': box}, at?, tag?, exclude?, ttl? } */
  'POST /send': async (b, ip) => {
    if (!rateOk(ip)) return [429, { error: 'zu viele Mitteilungen' }];
    const channels = (Array.isArray(b.channels) ? b.channels : []).filter(isId).slice(0, 50);
    if (!channels.length || !KINDS.includes(b.kind)) return [400, { error: 'channels/kind' }];
    const boxes = {};
    for (const [k, v] of Object.entries(b.boxes || {})) if ((k === '*' || channels.includes(k)) && typeof v === 'string' && v.length <= LIMIT.box) boxes[k] = v;
    if (!Object.keys(boxes).length) return [400, { error: 'boxes' }];
    const job = { id: crypto.randomBytes(9).toString('base64url'), channels, kind: b.kind, boxes, tag: typeof b.tag === 'string' ? b.tag.slice(0, 64) : null,
      exclude: isId(b.exclude) ? b.exclude : null, ttl: Math.min(Math.max(+b.ttl || 3600, 60), 86400) };
    const atMs = b.at ? Date.parse(b.at) : 0;
    if (job.tag) state.jobs = state.jobs.filter(j => !(j.tag === job.tag && j.channels.join() === channels.join()));   // gleicher Timer → ersetzen
    if (atMs && atMs > Date.now() + 1000) {
      if (atMs > Date.now() + 8 * 864e5) return [400, { error: 'zu weit in der Zukunft' }];
      if (state.jobs.filter(j => j.channels.includes(channels[0])).length >= LIMIT.jobsPerChannel) return [429, { error: 'zu viele geplante' }];
      job.atMs = atMs; job.at = new Date(atMs).toISOString();
      state.jobs.push(job); save();
      return [200, { ok: true, scheduled: job.at, id: job.id }];
    }
    save();
    return [200, Object.assign({ ok: true }, await deliver(job))];
  },
  /* geplante Mitteilung zurücknehmen: { channels:[...], tag } */
  'POST /cancel': b => {
    const channels = (Array.isArray(b.channels) ? b.channels : []).filter(isId);
    const before = state.jobs.length;
    state.jobs = state.jobs.filter(j => !(j.tag === b.tag && j.channels.join() === channels.join()));
    if (before !== state.jobs.length) save();
    return [200, { ok: true, removed: before - state.jobs.length }];
  },
};
const server = http.createServer((req, res) => {
  const cors = { 'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400', 'Vary': 'Origin' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  const p = new URL(req.url, 'http://x').pathname.replace(/^\/push(?=\/)/, '');   // mit oder ohne /push davor
  const fn = routes[req.method + ' ' + p];
  const reply = (st, j) => { res.writeHead(st, Object.assign({ 'Content-Type': 'application/json' }, cors)); res.end(JSON.stringify(j)); };
  if (!fn) return reply(404, { error: 'unbekannt' });
  let raw = '';
  req.on('data', c => { raw += c; if (raw.length > LIMIT.body) req.destroy(); });
  req.on('end', async () => {
    let b = {};
    if (raw) { try { b = JSON.parse(raw); } catch (e) { return reply(400, { error: 'json' }); } }
    const ip = req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : req.socket.remoteAddress;
    try { const [st, j] = await fn(b, ip); reply(st, j); } catch (e) { log('Fehler', e.message); reply(500, { error: 'intern' }); }
  });
});
if (require.main === module) {
  server.listen(PORT, '127.0.0.1', () => log(`Push-Dienst läuft auf 127.0.0.1:${PORT}, Origin ${ORIGIN}`));
  setInterval(() => tick().catch(e => log('tick', e.message)), 2000);
}
module.exports = { server, tick, state: () => state, sendImpl, vapid: () => vapid };
