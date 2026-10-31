const CACHE_NAME = 'cloud-tts-v15-prebuilt-css';
const ASSETS = [
    '/',
    '/static/index.html',
    '/static/app.js',
    '/static/js/mini-player-widget.js',
    '/static/css/app.css?v=b9f801fdd8',
    '/static/js/image-manager.js',
    '/static/icon-192.png',
    '/static/manifest.json'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(ASSETS))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(
                keys
                    .filter((key) => key !== CACHE_NAME)
                    .map((key) => caches.delete(key))
            ))
            .then(() => self.clients.claim())
    );
});

// App-shell files are network-first so installed PWAs receive performance
// fixes promptly. API, WebSocket and user data are never put in this cache.
self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    const isAppShell = url.origin === self.location.origin
        && (request.mode === 'navigate' || url.pathname === '/' || url.pathname.startsWith('/static/'));
    if (!isAppShell) return;

    event.respondWith(
        fetch(request)
            .then((response) => {
                if (response.ok) {
                    const copy = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
                }
                return response;
            })
            .catch(async () => {
                const cached = await caches.match(request);
                if (cached) return cached;
                if (request.mode === 'navigate') {
                    return caches.match('/static/index.html');
                }
                throw new Error(`Offline asset unavailable: ${url.pathname}`);
            })
    );
});
