// Luban Market Lab service worker: an offline page for the installed web app.
//
// It caches exactly one file, /offline.html, and shows it only when a page
// navigation fails because the network is down. Everything else goes
// straight to the network untouched: API calls, pages, scripts, and anything
// signed in are never cached or read from a cache.
//
// Registered by components/service-worker-registration.tsx (production only). Bump CACHE when offline.html changes.

const CACHE = "luban-offline-v1";
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.add(new Request(OFFLINE_URL, { cache: "reload" })))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => name.startsWith("luban-offline-") && name !== CACHE).map((name) => caches.delete(name)),
      );
      // Lets the browser start each page request while the worker boots.
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable();
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  // Only full page loads; every other request is left to the browser.
  if (request.mode !== "navigate" || request.method !== "GET") return;

  event.respondWith(
    (async () => {
      try {
        const preloaded = await event.preloadResponse;
        if (preloaded) return preloaded;
        return await fetch(request);
      } catch {
        const offline = await caches.match(OFFLINE_URL, { cacheName: CACHE });
        return offline ?? Response.error();
      }
    })(),
  );
});
