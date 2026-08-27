/* Service worker for EmmStrength Spotter.
 *
 * Strategy:
 *   HTML / navigation   -> network-first, cache fallback. Online you get the newest
 *                          build you pushed; offline you get the last good one.
 *   Icons + manifest    -> cache-first, revalidated in the background.
 *   Chart.js (cdnjs)    -> cache-first, permanent. The URL is version-pinned
 *                          (…/Chart.js/4.4.1/…) so it never changes underneath us.
 *                          Without this, every analytics and chart view is blank
 *                          offline, which is most of the app's value on a phone.
 *   Google Fonts        -> cache-first, permanent, same reasoning.
 *
 * Note the page also sends `Cache-Control: no-store` via a <meta http-equiv>.
 * Browsers ignore that tag for cache decisions, and it does not affect the
 * Cache Storage API used here, so offline still works. It's left in place as
 * harmless, but it is now redundant — this worker controls freshness instead.
 *
 * Bumping CACHE_VERSION drops every old cache on the next activation. You only
 * need that if you change the file list below or the pinned Chart.js version;
 * ordinary edits to power-logs.html are picked up by the network-first rule.
 */

const CACHE_VERSION = "v1";
const CACHE_SHELL = `spotter-shell-${CACHE_VERSION}`;
const CACHE_VENDOR = `spotter-vendor-${CACHE_VERSION}`;

const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./power-logs.html",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-512-maskable.png",
  "./icons/apple-touch-icon.png",
  "./icons/favicon-32.png",
];

/* Third-party assets the app can't run without offline. Precached on install so
   the very first offline launch already has charts, not just the second. */
const VENDOR_ASSETS = [
  "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js",
];

const VENDOR_ORIGINS = [
  "https://cdnjs.cloudflare.com",
  "https://fonts.googleapis.com",
  "https://fonts.gstatic.com",
];

/* ---------------------------------------------------------------- install */
self.addEventListener("install", event => {
  event.waitUntil(Promise.all([
    caches.open(CACHE_SHELL).then(cache =>
      /* Individually, so one failed asset can't abort the whole install. */
      Promise.all(SHELL_ASSETS.map(url =>
        cache.add(new Request(url, { cache: "reload" }))
             .catch(err => console.warn("[sw] precache skipped:", url, err))
      ))
    ),
    caches.open(CACHE_VENDOR).then(cache =>
      Promise.all(VENDOR_ASSETS.map(url =>
        cache.add(new Request(url, { mode: "cors" }))
             .catch(err => console.warn("[sw] vendor precache skipped:", url, err))
      ))
    ),
  ]));
});

/* --------------------------------------------------------------- activate */
self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_SHELL && k !== CACHE_VENDOR)
            .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/* Lets the page tell a waiting worker to take over immediately. */
self.addEventListener("message", event => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

/* ------------------------------------------------------------------ fetch */
self.addEventListener("fetch", event => {
  const req = event.request;

  // Never interfere with anything but plain GETs.
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // --- Pinned third-party libraries and fonts: cache-first, effectively permanent.
  if (VENDOR_ORIGINS.includes(url.origin)) {
    event.respondWith(cacheFirst(req, CACHE_VENDOR));
    return;
  }

  // --- Anything else off-origin: leave it alone.
  if (url.origin !== self.location.origin) return;

  // --- The app page itself (or any navigation): network-first.
  if (req.mode === "navigate" || url.pathname.endsWith(".html")) {
    event.respondWith(networkFirst(req, CACHE_SHELL));
    return;
  }

  // --- Same-origin static files: cache-first.
  event.respondWith(cacheFirst(req, CACHE_SHELL));
});

/* -------------------------------------------------------------- strategies */
async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res && (res.ok || res.type === "opaque")) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    const shell = await cache.match("./power-logs.html", { ignoreSearch: true });
    if (shell) return shell;
    return new Response(
      "<h1>Offline</h1><p>This page hasn't been cached yet. Reconnect once and it will work offline afterwards.</p>",
      { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) {
    // Refresh in the background; don't block the response on it.
    fetch(req).then(res => {
      if (res && (res.ok || res.type === "opaque")) cache.put(req, res.clone());
    }).catch(() => {});
    return hit;
  }
  try {
    const res = await fetch(req);
    if (res && (res.ok || res.type === "opaque")) cache.put(req, res.clone());
    return res;
  } catch (err) {
    return new Response("", { status: 504, statusText: "Offline" });
  }
}
