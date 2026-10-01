/* Web Push ohne Fremdbibliotheken: Verschlüsselung nach RFC 8291 (aes128gcm, RFC 8188) und VAPID (RFC 8292). */
'use strict';
const crypto = require('crypto');
const https = require('https');

const b64u = buf => Buffer.from(buf).toString('base64url');
const unb64u = s => Buffer.from(String(s), 'base64url');

function hkdf(salt, ikm, info, len) {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, len));
}

/* VAPID-Schlüssel erzeugen: öffentlicher Schlüssel (65 Byte, unkomprimiert) und privater (32 Byte), beide base64url */
function generateVapidKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

function privateKeyObject(pubB64, privB64) {
  const pub = unb64u(pubB64);
  return crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: b64u(unb64u(privB64)), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) }, format: 'jwk' });
}

/* VAPID-Kopfzeile für einen Push-Endpunkt */
function vapidHeader(endpoint, vapid, subject, nowSec) {
  const aud = new URL(endpoint).origin;
  const exp = (nowSec || Math.floor(Date.now() / 1000)) + 12 * 3600;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud, exp, sub: subject }));
  const sig = crypto.sign('sha256', Buffer.from(head + '.' + body), { key: privateKeyObject(vapid.publicKey, vapid.privateKey), dsaEncoding: 'ieee-p1363' });
  return 'vapid t=' + head + '.' + body + '.' + b64u(sig) + ', k=' + vapid.publicKey;
}

/* Nachricht für ein Abo verschlüsseln (RFC 8291). opts.asKey/opts.salt nur für Tests. */
function encrypt(sub, payload, opts) {
  opts = opts || {};
  const uaPub = unb64u(sub.keys.p256dh), auth = unb64u(sub.keys.auth);
  const as = crypto.createECDH('prime256v1');
  if (opts.asPrivate) as.setPrivateKey(unb64u(opts.asPrivate)); else as.generateKeys();
  const asPub = as.getPublicKey();
  const salt = opts.salt ? unb64u(opts.salt) : crypto.randomBytes(16);
  const ecdhSecret = as.computeSecret(uaPub);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub]);
  const ikm = hkdf(auth, ecdhSecret, keyInfo, 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const plain = Buffer.concat([Buffer.from(payload), Buffer.from([2])]);   // Trennzeichen: letzter Datensatz
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  const header = Buffer.concat([salt, rs, Buffer.from([asPub.length]), asPub]);
  return { body: Buffer.concat([header, ct]), debug: { ecdhSecret, ikm, cek, nonce } };
}

/* Zum Testen: Nachricht wie ein Browser entschlüsseln */
function decrypt(body, uaPrivB64, uaPubB64, authB64) {
  const salt = body.subarray(0, 16), idlen = body[20], asPub = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  const ua = crypto.createECDH('prime256v1'); ua.setPrivateKey(unb64u(uaPrivB64));
  const uaPub = unb64u(uaPubB64);
  const ikm = hkdf(unb64u(authB64), ua.computeSecret(asPub), Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub]), 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  return plain.subarray(0, plain.lastIndexOf(2)).toString();
}

/* Senden. Ergebnis: { status } – 404/410 heißt: Abo ist ungültig und kann gelöscht werden. */
function send(sub, payload, vapid, subject, ttl, urgency) {
  const { body } = encrypt(sub, payload);
  const u = new URL(sub.endpoint);
  return new Promise(resolve => {
    const req = https.request({ method: 'POST', hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, timeout: 15000, headers: {
      TTL: String(ttl || 3600), Urgency: urgency || 'high', 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
      'Content-Length': body.length, Authorization: vapidHeader(sub.endpoint, vapid, subject),
    } }, res => { res.resume(); res.on('end', () => resolve({ status: res.statusCode })); });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', e => resolve({ status: 0, error: e.message }));
    req.end(body);
  });
}

module.exports = { generateVapidKeys, vapidHeader, encrypt, decrypt, send, b64u, unb64u };
