/* StockFlow - mode hors ligne. Changer VERSION à chaque mise à jour publiée pour renouveler le cache. */
const VERSION = 'stockflow-v2.2.0';
const CORE = ['./', 'index.html', 'css/styles.css', 'js/core.js', 'js/sync.js', 'js/exports.js', 'js/io.js', 'js/app.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png'];
const VENDOR = ['vendor/xlsx.full.min.js', 'vendor/docx.umd.js', 'vendor/jspdf.umd.min.js', 'vendor/jspdf.plugin.autotable.min.js', 'vendor/font-pagella.js'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then(async (c) => { await c.addAll(CORE); await Promise.all(VENDOR.map((u) => c.add(u).catch(() => {}))); }).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request; const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return; // jamais l'API GitHub
  if (url.pathname.includes('/vendor/')) { // bibliothèques : cache d'abord
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((r) => { const cp = r.clone(); caches.open(VERSION).then((c) => c.put(req, cp)); return r; })));
    return;
  }
  // code de l'app : réseau d'abord (mises à jour immédiates), cache en secours (hors ligne)
  e.respondWith(fetch(req).then((r) => { const cp = r.clone(); caches.open(VERSION).then((c) => c.put(req, cp)); return r; }).catch(() => caches.match(req).then((hit) => hit || caches.match('index.html'))));
});
