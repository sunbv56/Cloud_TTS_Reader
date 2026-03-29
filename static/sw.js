const CACHE_NAME = 'cloud-tts-v1';
const ASSETS = [
    '/',
    '/static/index.html',
    '/static/app.js',
    '/static/icon.svg'
];

// Install Event
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(ASSETS);
        })
    );
});

// Fetch Event (Required for PWA Installability)
self.addEventListener('fetch', (event) => {
    event.respondWith(
        caches.match(event.request).then((response) => {
            return response || fetch(event.request);
        })
    );
});
