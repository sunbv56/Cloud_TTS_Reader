const CACHE_NAME = 'cloud-tts-v22-nova';
const ASSETS = [
    '/',
    '/static/index.html',
    '/static/app.js',
    '/static/css/console.css',
    '/static/css/mini-player.css',
    '/static/js/main.js',
    '/static/js/modules/i18n.js',
    '/static/js/modules/ui-interactions.js',
    '/static/js/modules/console-player.js',
    '/static/js/modules/account-menu.js',
    '/static/js/modules/account-sessions.js',
    '/static/js/modules/layer-history.js',
    '/static/js/mini-player-widget.js',
    '/static/js/image-manager.js',
    '/static/icon.svg',
    '/static/icon-192.png',
    '/static/icon-512.png',
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
                    // The cover cache (cloud-tts-covers-*) is user data managed by app.js.
                    .filter((key) => key !== CACHE_NAME && !key.startsWith('cloud-tts-covers-'))
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
    // Scope is '/', so only the shell is handled; /api and other routes go straight to the network.
    const isAppShell = url.origin === self.location.origin
        && (url.pathname === '/' || url.pathname.startsWith('/static/'));
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
                    return (await caches.match('/')) || caches.match('/static/index.html');
                }
                throw new Error(`Offline asset unavailable: ${url.pathname}`);
            })
    );
});
