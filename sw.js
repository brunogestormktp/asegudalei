// Service Worker mínimo — habilita instalação PWA no Android/iOS
// Não faz cache agressivo para garantir que o app sempre carrega a versão mais recente

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
    e.respondWith(
        fetch(e.request).catch(() => {
            // Offline ou erro de rede — retorna resposta vazia para não rejeitar a promise
            return new Response('', { status: 503, statusText: 'Service Unavailable' });
        })
    );
});
