self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const cacheNames = await caches.keys();
      await Promise.all(cacheNames.map((cacheName) => caches.delete(cacheName)));
      await self.clients.claim();
      const clients = await self.clients.matchAll({
        includeUncontrolled: true,
        type: 'window'
      });

      await self.registration.unregister();

      await Promise.all(
        clients.map(async (client) => {
          try {
            const url = new URL(client.url);
            url.searchParams.set('janvaani-sw-reset', Date.now().toString());

            if (typeof client.navigate === 'function') {
              await client.navigate(url.href);
              return;
            }

            client.postMessage({
              type: 'JANVAANI_DEV_SW_RESET',
              url: url.href
            });
          } catch (error) {
            client.postMessage({
              type: 'JANVAANI_DEV_SW_RESET_ERROR',
              message: error.message
            });
          }
        })
      );
    })()
  );
});

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
