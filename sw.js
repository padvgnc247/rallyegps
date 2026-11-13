// Service worker : l'app fonctionne hors ligne, les images de carte sont gardées en cache.
const VERSION = 'rg-1.0.0';
const TILES = 'rg-tiles-v1';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/style.css',
  'vendor/leaflet.js', 'vendor/leaflet.css',
  'js/app.js', 'js/geo.js', 'js/analysis.js', 'js/services.js', 'js/gpx.js', 'js/storage.js', 'js/sun.js',
  'js/speech.js', 'js/maps.js', 'js/drive.js', 'js/hud.js',
  'profiles/rallye-chemins.brf', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== TILES).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const isTile = u => u.hostname === 'tile.openstreetmap.org' || (u.hostname === 'data.geopf.fr' && u.pathname.startsWith('/wmts'));

async function tile(req) {
  const cache = await caches.open(TILES);
  const hit = await cache.match(req.url, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req.url, res.clone()).catch(() => {});
  return res;
}

// Fichiers de l'app : réseau d'abord (pour recevoir les mises à jour), cache si le réseau ne répond pas.
async function shell(req) {
  const cache = await caches.open(VERSION);
  try {
    const res = await Promise.race([
      fetch(req, { cache: 'no-cache' }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3500)),
    ]);
    if (res.ok) cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: true }) || (req.mode === 'navigate' && await cache.match('index.html'));
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (isTile(u)) e.respondWith(tile(req));
  else if (u.origin === self.location.origin) e.respondWith(shell(req));
});
