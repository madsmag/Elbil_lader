'use strict';
// Skallen caches (stale-while-revalidate), data hentes netværk først, så priserne er friske.
const VERSION = 'v1';
const SHELL = ['./', 'index.html', 'app.css', 'app.js', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open('skal-' + VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => !k.endsWith(VERSION)).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  const isData = new URL(req.url).pathname.includes('/data/');
  if (isData) {
    e.respondWith(fetch(req).then((r) => {
      const copy = r.clone();
      caches.open('data-' + VERSION).then((c) => c.put(req, copy));
      return r;
    }).catch(() => caches.match(req)));
    return;
  }
  e.respondWith(caches.match(req).then((hit) => {
    const net = fetch(req).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open('skal-' + VERSION).then((c) => c.put(req, copy)); }
      return r;
    }).catch(() => hit);
    return hit || net;
  }));
});
