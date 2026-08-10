// Service worker — Suivi Bébé (PWA offline)
// Bump CACHE à chaque mise à jour d'asset (aligné sur ?v=N).
const CACHE = 'suivi-bebe-v17';

const ASSETS = [
  '.',
  'index.html',
  'styles.css?v=17',
  'app.js?v=17',
  'config.js?v=15',
  'vendor/supabase.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  // Navigations : réseau d'abord, repli sur l'index en cache (offline)
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).catch(() => caches.match('index.html', { ignoreSearch: true }))
    );
    return;
  }

  // Autres GET : cache d'abord, puis réseau (et on met en cache au passage)
  e.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      });
    })
  );
});
