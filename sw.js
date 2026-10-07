/* Service worker for EmmStrength Power Logs.
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
 *   supabase-js         -> cache-first, permanent, version-pinned on jsdelivr. The
 *                          account + sync layer; the app runs without it, but
 *                          a coach needs it to sign in and reach Manage program.
 *   Supabase API        -> never touched (another origin): sync must be live.
 *
 * Note the page also sends `Cache-Control: no-store` via a <meta http-equiv>.
 * Browsers ignore that tag for cache decisions, and it does not affect the
 * Cache Storage API used here, so offline still works. It's left in place as
 * harmless, but it is now redundant — this worker controls freshness instead.
 *
 * Bumping CACHE_VERSION drops every old cache on the next activation. You only
 * need that if you change the file list below or a pinned library version;
 * ordinary edits to index.html are picked up by the network-first rule. (The app itself is not
 * a file here: index.html downloads it from the database after sign-in and keeps it in IndexedDB.)
 */

const CACHE_VERSION = "v17";
const CACHE_SHELL = `spotter-shell-${CACHE_VERSION}`;
const CACHE_VENDOR = `spotter-vendor-${CACHE_VERSION}`;

const SHELL_ASSETS = [
  "./",
  "./index.html",
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
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/dist/umd/supabase.js",
];

const VENDOR_ORIGINS = [
  "https://cdnjs.cloudflare.com",
  "https://cdn.jsdelivr.net",
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

/* ------------------------------------------------------ notifications */
/* Sent by the Supabase notify function (supabase/functions/notify) as
   { title, body, url, tag }. The text never includes a message itself, only
   who or what, since banners show on a locked screen. */
self.addEventListener("push", event => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (e) { d = {}; }
  event.waitUntil(self.registration.showNotification(d.title || "Power Logs", {
    body: d.body || "",
    tag: d.tag || undefined,          // same tag replaces instead of stacking (e.g. one lifter's messages)
    icon: "./icons/icon-192.png",
    badge: "./icons/icon-192.png",
    data: { url: d.url || "./index.html" },
  }));
});

/* Tapping one opens the app at the right place: an open window is told
   where to go (it syncs first); otherwise a new one starts there. */
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "./index.html", self.registration.scope).href;
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    for (const c of list) {
      if (c.url.startsWith(self.registration.scope) && "focus" in c) {
        c.postMessage({ type: "spotter-open", url });
        return c.focus();
      }
    }
    return self.clients.openWindow(url);
  }));
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
    const shell = await cache.match("./index.html", { ignoreSearch: true });
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
