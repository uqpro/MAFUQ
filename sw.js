const CACHE_NAME = 'masjid-finder-v5';

const EXTERNAL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.css',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async cache => {
      console.log('[SW] Caching static assets');
      await Promise.allSettled(
        EXTERNAL_ASSETS.map(url => cache.add(url).catch(err => console.warn('[SW] Failed to cache:', url, err)))
      );
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = request.url;

  // Jangan cache request ke Google Apps Script dan OpenStreetMap
  if (
    url.includes('overpass-api.de') ||
    url.includes('kumi.systems') ||
    url.includes('script.google.com') ||
    url.includes('googleusercontent.com')
  ) {
    return;
  }

  if (request.method !== 'GET') return;

  event.respondWith(
    fetch(request)
      .then(response => {
        if (response && response.status === 200) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, responseClone));
        }
        return response;
      })
      .catch(() => {
        return caches.match(request).then(cachedResponse => {
          if (cachedResponse) return cachedResponse;
          if (request.mode === 'navigate') {
            return caches.match('./index.html');
          }
        });
      })
  );
});