# EmmStrength Spotter — iPhone home-screen app

`power-logs.html` wrapped as an installable PWA. Runs full-screen with its own icon,
works offline including charts, and exports JSON/CSV through the iOS share sheet.

Separate repo from the Program Hub. Same deploy pattern.

## Files

| File | Purpose |
|---|---|
| `power-logs.html` | The app. Same code plus a PWA `<head>`, touch field sizing, share-sheet exports, persistent-storage request, and service worker registration. |
| `rpe-estimator.html` | The RPE → %1RM load-chart tool. Opens inside the app (RPE Estimator in the sidebar) via an iframe, and also works standalone. Precached for offline use. |
| `program-hub.html` | The program builders (Gustav, Wendler, and the rest). Opens inside the app as the **Program Hub** tab in Manage Program, and also works standalone. Precached for offline use. |
| `VBT.html` | Velocity Tracker — barbell velocity and RPE from a video clip. Opens inside the app from the **Velocity Tracker** nav button, and also works standalone. Precached for offline use. |
| `manifest.webmanifest` | App name, icon set, colours, `display: standalone`. |
| `sw.js` | Service worker. Offline caching, including Chart.js. |
| `index.html` | Redirects the bare repo URL to the app. Delete if you don't want it. |
| `icons/` | 192, 512, 512-maskable, 180px `apple-touch-icon`, 32px favicon, and `_source.png` (the original logo). |
| `.nojekyll` | Stops GitHub Pages running the files through Jekyll. |
| `test-boot.js` | Smoke test — `npm install jsdom && node test-boot.js`. |
| `test-weekrange.js` | Program Hub week-range export tests across all builders — `node test-weekrange.js`. |
| `test-vbt.js` | Velocity Tracker smoke test — `node test-vbt.js`. |
| `make_icons.py` | Regenerates the icons from `icons/_source.png`. |

Everything uses **relative paths**, so it works from `username.github.io/repo-name/`
without you editing anything.

## Deploy

1. Push all of it to the repo root, keeping the `icons/` folder structure.
2. Repo → **Settings** → **Pages** → Source: *Deploy from a branch* → `main` / root.
3. Open `https://<username>.github.io/<repo-name>/` on your iPhone in **Safari**.
4. Share button → **Add to Home Screen** → Add.

Safari specifically — Chrome and Firefox on iOS can't install to the home screen.
HTTPS is required for service workers, and Pages provides it.

> Free-tier GitHub Pages makes the published site public even from a private repo.
> No training data ships in these files and nothing leaves your phone, but if you
> want the URL unreachable, Cloudflare Pages with Access is the free alternative.

## Read this bit: where your training data lives

The app keeps profiles, done/skip state, notes and custom items in `localStorage` on
the phone. Nothing syncs anywhere. Two consequences:

- **The phone copy and the desktop copy are separate.** Same URL, different
  device, different data. Moving a lifter between them means exporting the JSON on
  one and loading it on the other. There's no merge.
- **`localStorage` is not permanent storage.** An installed home-screen app is
  treated better than a Safari tab (it's exempt from the 7-day script-storage
  eviction), but iOS can still clear it under storage pressure, and deleting the
  home-screen icon can take the data with it.

I added a `navigator.storage.persist()` request at boot, which asks iOS to mark the
data as persistent rather than best-effort. Installed apps are usually granted it
without a prompt. It meaningfully reduces the risk; it does not remove it.

**So: keep exporting the JSON.** That file is the real backup, and it round-trips
the full profile including progress. Worth doing at the end of each block, or any
week where you've done a lot of editing.

## What changed inside the HTML

Six edits, all additive except the icon swap:

1. **`<head>`** — manifest link, `apple-mobile-web-app-capable`, apple-touch-icon,
   and a `theme-color` meta with an id. `viewport-fit=cover` was already there.
2. **Icons swapped from data URIs to files.** The embedded base64 `apple-touch-icon`
   wouldn't have worked: iOS is unreliable about data-URI touch icons, and that logo
   had a transparent background, which iOS renders as flat black with no padding.
   The logo is now composited onto the app's paper colour with proper margins. This
   also cut ~77KB of base64 out of the file.
3. **Touch field sizing.** Fields here run 13.5–15px (`.tool-input`, `.dm-einput`,
   `.picker.sm select`, `.add-weight`, and others). Under 16px, iOS zooms the whole
   viewport on focus and doesn't zoom back — rough in a logger you're tapping
   between sets. All editable controls go to 16px under
   `(pointer: coarse) and (max-width: 900px)`; the two fixed-width pills got a bit
   wider to fit. Desktop is untouched.
4. **Both exports** now go through one `saveFile()` helper. In a standalone iOS app
   `<a download>` silently does nothing — you'd tap Export, see the success toast,
   and get no file. It now detects standalone mode and uses `navigator.share()`,
   giving Save to Files, iCloud Drive, AirDrop, Mail. Cancelling the share sheet
   shows no toast rather than claiming a save. Desktop and browser tabs keep the
   plain download.
5. **`applyTheme()`** also sets the status bar tint, so it follows your toggle
   rather than the OS setting.
6. **Service worker registration** with auto-activation of new builds.

## Generating a program straight into Manage Program

The **Program Hub** tab inside Manage Program has a **Send to Manage Program** button
next to Export CSV. Build a block, set the **Weeks** field, and it drops straight into
*Import a program to pull a day from* — no CSV file in between. There's a
**Build one in Program Hub** shortcut in the import section that jumps you to the tab.

The Weeks field scopes the send exactly as it scopes an export, using the same parser
and quick-pick chips:

| You type | You send |
|---|---|
| *(blank)* or `all` | the whole program |
| `7` | week 7 only |
| `1-4` | weeks 1 to 4 |
| `1-4, 7, 9-12` | any mix |
| `13-` | week 13 to the end |

A range that can't be read blocks the send rather than pushing the wrong weeks, and
inline Sets/Reps edits come along. Once it lands it's an ordinary donor program:
side-by-side preview against your current day, per-day **Replace** / **Merge into**,
whole-week Replace/Merge, and **Clear import**. It stays temporary in exactly the same
way — nothing touches your lifters until you replace or merge, and it's discarded when
you leave Manage Program.

Sending again replaces whatever donor is loaded, so you can iterate on maxes or switch
builders and re-send without clearing first.

## Velocity Tracker layout

The tracker is built to fit the screen with no page scroll:

- **Phone:** the video fills the free height with the scrub bar laid over it, and each
  step's controls sit in a short panel underneath. Finished steps show as chips under
  the 1-2-3-4 trail; tap one to edit it. The magnifier appears in a top corner of the
  video while your finger is down.
- **Wide screens (760px+):** video on the left, controls on the right, with the step
  list at the top of the panel doubling as the summary.
- **Step 4:** the last rep's speed and set RPE come first, then a velocity strip and
  the rep list (the only part that scrolls). *Export ▾* holds CSV and video; it turns
  into *Stop export* while a video export runs. Velocity anchors and filming tips
  live behind ⚙. The play button on the video replays with the bar path.
- **Scale:** press and drag across the plate to draw the whole line; tapping twice
  still works, and the end dots can be dragged afterwards.
- **Inside Spotter:** one-line header (details behind ⓘ), and the frame is sized to
  the rest of the window, so there's one scroll area at most.

## Stalls (grinds) in the Velocity Tracker

A stall is the bar almost stopping (under 0.05 m/s) while it's between 15% and 90% of
that rep's range, for at least 0.3 s (0.4 s on deadlifts). Setup at the floor, a pause
on the chest and the lockout hold sit outside that band, so they never count, and a
small bar movement at the floor before a pull can no longer be mistaken for the start
of the rep. Counted stalls show as a rust segment on the velocity chart and a
**hitch** tag on the rep; tap the tag to un-count it. Settings (⚙) picks the rule:

- **RPE 10 only if slow** (default): a stalled rep is 10 when its speed already reads
  8.5 or harder; otherwise the stall adds one RPE.
- **Always RPE 10**: any counted stall is 10.

## Video export

*Export video* draws every frame of the tracked window and encodes it with WebCodecs
(H.264 + AAC on iPhone, VP9 + Opus in Chromium), then writes the MP4 in the page
(`mp4Mux` in `VBT.html`). Because nothing is recorded in real time, a busy phone
makes the export take longer instead of freezing frames. The original audio is read
straight from the file and trimmed to the same window.

Browsers without WebCodecs, or without an audio encoder when the clip has sound
(Safari before 26), fall back to the older real-time recorder, which keeps the audio
but can still stutter on a slow device.

## Offline

Chart.js is pinned at `4.4.1` on cdnjs and is **precached on install**, not just on
first use. Without that, every analytics and chart view would be blank offline,
which is most of what the app is for on a phone. Bricolage Grotesque and Inter are
cached the same way.

The page still sends `Cache-Control: no-store` via `<meta http-equiv>`. Browsers
ignore that tag for cache decisions and it has no effect on the Cache Storage API,
so offline works regardless. It's now redundant — the worker controls freshness —
but harmless, so I left it.

## Updating the app later

If you change `program-hub.html`, bump **both** `CACHE_VERSION` in `sw.js` and
`HUB_BUILD` in `power-logs.html`. The first drops the old precached copy; the second
adds `?v=N` to the iframe URL so the browser's own HTTP cache can't serve a stale
build. If the deployed hub file is out of date, the Program Hub tab now says so
outright instead of just missing its Send button.


Push a new `power-logs.html` and reopen. HTML is fetched network-first, so you get
the new build whenever you're online, with the old one as offline fallback. Bump
`CACHE_VERSION` in `sw.js` only if you add/rename files or change the Chart.js
version.

**Updating never touches your data** — `localStorage` survives new builds. But if
you ever need the nuclear option (Settings → Safari → Advanced → Website Data →
remove the site), that *does* wipe it. Export first.

## Known rough edges

- **Folder scan stays desktop-only.** The app already says so in its own UI. The
  File System Access API isn't in Safari, so "Load CSV files" is the iPhone path.
  Nothing I changed affects this.
- **512px icon is upscaled.** The only source was the 180px embedded logo, so the
  large icon is slightly soft. If you have the original artwork, drop it in as
  `icons/_source.png` and re-run `make_icons.py`.
- **Unsigned, unlisted, no expiry.** Not in the App Store, doesn't need to be, no
  re-signing, no developer account.
