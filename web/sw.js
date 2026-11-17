// Service worker for the Shift & Incident Log PWA (self-hosted / NAS build).
// Strategy:
//   • App shell (HTML/CSS/JS/icon/vendor libs) is precached so the app loads offline.
//   • /api/* is never handled here — always hits the network. Writes made while
//     offline are queued in IndexedDB by the app and synced when back online.

const CACHE = "shiftlog-v72";

// Relative paths so the SW works at the domain root.
const CORE = [
  "./",
  "./index.html",
  "./style.css?v=72",
  "./script.js?v=72",
  "./db-shim.js",
  "./manifest.json",
  "./icon.svg",
  "./vendor/chart.umd.min.js",
  "./vendor/inter.css",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // Ignore individual precache misses (e.g. a font file) so install never fails.
      .then((cache) => Promise.allSettled(CORE.map((u) => cache.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network-first: try network, fall back to cache when offline.
function networkFirst(request) {
  return caches.open(CACHE).then(async (cache) => {
    try {
      const res = await fetch(request);
      if (res && res.ok) cache.put(request, res.clone());
      return res;
    } catch {
      return cache.match(request);
    }
  });
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // API + realtime + attachments: always network, never cached/handled here.
  if (url.pathname.startsWith("/api/")) return;

  // Page navigations: network-first, fall back to cached shell when offline.
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("./index.html")));
    return;
  }

  // Same-origin static assets (JS/CSS/fonts/icons): network-first.
  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(request));
  }
});
