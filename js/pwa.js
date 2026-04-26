import { registerSW } from 'virtual:pwa-register';

/**
 * Removes service workers that may have been registered during local development.
 * @returns {Promise<number>} Number of unregistered workers.
 */
export async function clearDevelopmentServiceWorkers() {
  try {
    if (!import.meta.env.DEV || !('serviceWorker' in navigator)) {
      return 0;
    }

    const registrations = await navigator.serviceWorker.getRegistrations();
    const janVaaniRegistrations = registrations.filter((registration) => {
      const scriptURL = registration.active?.scriptURL || registration.waiting?.scriptURL || registration.installing?.scriptURL || '';
      return !scriptURL || scriptURL.includes(window.location.origin);
    });
    const cacheNames = 'caches' in window ? await caches.keys() : [];

    await Promise.all([
      ...janVaaniRegistrations.map((registration) => registration.unregister()),
      ...cacheNames.map((cacheName) => caches.delete(cacheName))
    ]);
    return janVaaniRegistrations.length;
  } catch (error) {
    throw new Error(`Failed to clear development service workers: ${error.message}`);
  }
}

/**
 * Registers the JanVaani service worker and reports lifecycle status.
 * @param {(status: string) => void} onStatus - Status callback.
 * @returns {() => Promise<void>} Update function returned by vite-plugin-pwa.
 */
export function registerJanVaaniServiceWorker(onStatus) {
  if (!import.meta.env.PROD) {
    return async () => {};
  }

  const report = typeof onStatus === 'function' ? onStatus : () => {};

  return registerSW({
    immediate: true,
    onNeedRefresh() {
      report('Update ready');
    },
    onOfflineReady() {
      report('Offline ready');
    },
    onRegisteredSW() {
      report('Service worker active');
    },
    onRegisterError(error) {
      report(`Service worker error: ${error.message}`);
    }
  });
}
