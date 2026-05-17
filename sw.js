// Service worker — caches the app shell so the PWA installs and launches offline.
// (Gameplay still needs the WebSocket; this just keeps the UI loadable.)

const CACHE = 'snake-shell-v13';
const SHELL = [
    './',
    './index.html',
    './style.css',
    './game.js',
    './manifest.json',
    './icon.png',
    './icon-192.png',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE)
            .then(c => c.addAll(SHELL))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;
    // Network-first for navigations so a redeploy reaches users quickly;
    // cache fallback when offline.
    if (req.mode === 'navigate' || req.destination === 'document') {
        event.respondWith(
            fetch(req).catch(() => caches.match('./index.html'))
        );
        return;
    }
    // Cache-first for the rest of the shell.
    event.respondWith(
        caches.match(req).then(hit => hit || fetch(req))
    );
});
