// Service Worker — cache app shell for offline load
const CACHE = 'jb-health-v7';
const SHELL = ['/Health-Journal/', '/Health-Journal/index.html', '/Health-Journal/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL).catch(() => {})));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Network first for API calls, cache first for app shell
  if (e.request.url.includes('journal-api.fybertech.cloud')) return;
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
