// Service Worker para Bitácora - Offline First
// v2: subimos el número de versión a propósito para forzar que los celulares
// que ya tienen la app instalada (PWA) descarten el caché viejo y vuelvan a
// descargar index.html, bitacora.html, etc. — si no, siguen viendo versiones
// desactualizadas para siempre aunque subamos cambios a GitHub.
const CACHE_NAME = 'bitacora-v2';
const urlsToCache = [
  './',
  './bitacora.html',
  './promo-sistema-escolar.html',
  'https://cdn.tailwindcss.com',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-auth-compat.js',
  'https://www.gstatic.com/firebasejs/9.23.0/firebase-database-compat.js'
];

// Instala el service worker y cachea archivos
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log('Service Worker: Cacheando archivos offline...');
      return cache.addAll(urlsToCache).catch(err => {
        console.log('Algunos recursos no pudieron cachearse:', err);
        // Continua aunque algunos fallen
      });
    })
  );
  self.skipWaiting(); // Activa inmediatamente
});

// Estrategia: Cache First, Network Fallback
self.addEventListener('fetch', event => {
  // Solo cachea GET
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then(response => {
      if (response) return response; // Serve from cache

      return fetch(event.request)
        .then(response => {
          // No cachear requests fallidas
          if (!response || response.status !== 200 || response.type === 'error') {
            return response;
          }

          // Cachea la respuesta exitosa
          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, responseToCache);
          });

          return response;
        })
        .catch(() => {
          // Offline: regresa desde caché o error
          return caches.match('./bitacora.html').catch(() => {
            return new Response('Offline - Página no disponible', {
              status: 503,
              statusText: 'Service Unavailable'
            });
          });
        });
    })
  );
});

// Limpia cachés viejos
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            console.log('Service Worker: Eliminando caché antiguo:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});
