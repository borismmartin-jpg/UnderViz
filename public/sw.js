// UnderViz service worker.
// - App shell: stale-while-revalidate (instant loads, updates in background).
// - /api/forecast: network-first with cache fallback, so the last fetched
//   forecast still works offline (the client shows a "cached" banner based on
//   the payload's generatedAt).
// Bump VERSION when shell files change in a breaking way.

const VERSION = 'underviz-v3';
const SHELL_CACHE = `${VERSION}-shell`;
const API_CACHE = `${VERSION}-api`;

const SHELL = [
  '/',
  '/style.css',
  '/app.js',
  '/manifest.webmanifest',
  '/lib/config.js',
  '/lib/physics.js',
  '/lib/sites.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/api/')) {
    // network-first; fall back to the last cached forecast when offline
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(API_CACHE).then((c) => c.put(e.request, copy));
          }
          return res;
        })
        .catch(async () => {
          const hit = await caches.match(e.request);
          return hit ?? new Response(
            JSON.stringify({ error: 'offline and no cached forecast for this site' }),
            { status: 503, headers: { 'Content-Type': 'application/json' } },
          );
        }),
    );
    return;
  }

  // shell: stale-while-revalidate
  e.respondWith(
    caches.match(e.request).then((hit) => {
      const refresh = fetch(e.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit ?? refresh;
    }),
  );
});
