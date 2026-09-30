# EmmStrength Power Logs — iPhone home-screen app

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
| `sw.js` | Service worker. Offline caching, including Chart.js and supabase-js. |
| `supabase/schema.sql` | The cloud database: tables and the row-level security rules that decide who sees and changes what. Paste into Supabase's SQL Editor; safe to re-run. |
| `supabase/selftest.sql` | Checks on those rules (87 at present). Paste and run after the schema; every row should say PASS. |
| `supabase/functions/notify/index.ts` | The Supabase Edge Function that sends phone/computer notifications (Web Push). Pasted into Supabase once; see *Messages and notifications*. |
| `index.html` | Redirects the bare repo URL to the app. Delete if you don't want it. |
| `icons/` | 192, 512, 512-maskable, 180px `apple-touch-icon`, 32px favicon, and `_source.png` (the original logo). |
| `.nojekyll` | Stops GitHub Pages running the files through Jekyll. |
| `test-boot.js` | Smoke test — `npm install jsdom && node test-boot.js`. |
| `test-weekrange.js` | Program Hub week-range export tests across all builders — `node test-weekrange.js`. |
| `test-genpop.js` | Meet Peak v2 · Gen Pop builder checks, plus a real import of its CSV into the app — `node test-genpop.js`. |
| `test-lifterorder.js` | Rearranging lifters: the sheet, the dropdown entry, saving and reloading the order — `node test-lifterorder.js`. |
| `test-dmnotes.js` | Manage Program's Notes card: coach-only, editing, links, backups, and that Weekly notes still work — `node test-dmnotes.js`. |
| `test-reimport.js` | Re-importing a lifter's CSV or an older JSON backup keeps their training maxes; the CSV still sets the 1-rep maxes — `node test-reimport.js`. |
| `test-hubanalytics.js` | Program Hub analytics: charts for each program, controls, and the same numbers as Power Logs' Analytics for the same CSV — `node test-hubanalytics.js`. |
| `test-hubprefill.js` | Program Hub builders filled from the loaded lifter: every builder, typed values kept, Wendler/Massthetics TM %, and Power Logs sending it — `node test-hubprefill.js`. |
| `test-managelayout.js` | Manage Program's Manage tab: section order, and every action from its place (add exercise, days & weeks, undo, import, replace/merge, clear, compare) — `node test-managelayout.js`. |
| `test-cloudsql.js` | The database rules on a real (in-memory) Postgres: `supabase/selftest.sql`, re-running the schema, owner set-up — `node test-cloudsql.js`. |
| `test-cloudsync.js` | Accounts + sync end to end: sign-in, upload, two devices, offline and conflicts, coach approval, a lifter's own login, sharing, removing a coach, deleting, sign-out — `node test-cloudsync.js`. |
| `test-messaging.js` | Messages, finished sessions, new-week alerts and notifications end to end, with the notify function run in-process — `node test-messaging.js`. |
| `test-cloudfake.js` | Not a test: the stand-in Supabase the tests plug in (`window.__spotterCloud`), and the in-process runner for the notify function. |
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
> No training data ships in these files. Signed in, it syncs to Supabase behind each
> person's login; signed out, nothing leaves the device.

## Read this bit: where your training data lives

The app keeps profiles, done/skip state, notes and custom items in `localStorage` on
the device, and that stays the working copy even when you're signed in: every change
saves here first, so the app works offline. Sign in (the person icon in the header)
and it also syncs to the cloud (see *Accounts and sync*). Signed out, nothing syncs, and:

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

**Signed out: keep exporting the JSON.** That file is the real backup, and it
round-trips the full profile including progress. Signed in, the cloud copy is the
backup, but **Save progress (JSON)** still works whenever you want a file.

## Accounts and sync

Supabase (Postgres plus email-code sign-in) holds a copy of every signed-in person's
data. There's no server of ours: the page talks to Supabase directly with its
**publishable** key, which is public by design. What each account can see or change
is enforced by the database's row-level security rules (`supabase/schema.sql`), not
by the app, so a modified copy of the page can't get around them.

- **Owner** (set by a private SQL script, so the email isn't in this public repo):
  sees every lifter and approves coaches under **Coaches** in the account sheet (the
  person icon shows a badge for requests); can remove a coach at any time.
- **Coach**: signs in, taps **I'm a coach: request access**, and once approved gets
  Manage Program for the lifters they upload or that another coach shares with them.
  Manage Program → **Sharing** holds the lifter's own sign-in email, the list of
  coaches (share by email, remove), and **Delete lifter for everyone**.
- **Lifter**: signs in with the email their coach entered. Sees only their own program
  (Overview, weeks, Analytics, 1-rep maxes, RPE Estimator, Velocity Tracker) and logs
  it; no Manage Program, and no loading or saving files (Load CSV/JSON, Save
  progress): their program comes through their account.
- **Signed out**: whatever is already on the device keeps working, but Manage
  Program and loading/saving files need a coach account; the start screen asks
  you to sign in. The old 8-digit PIN is gone: its hash shipped in this public
  page, so it only ever slowed people down.

How it syncs: each change is saved locally, then compared with what the server last
held, and only the differences go up, as small rows (one per tick, exercise note,
added item, weekly note), so two people editing the same lifter don't overwrite each
other. When the same thing changes on two devices, the change that reaches the server
last wins. Other devices' changes arrive live while the app is open, and whenever it's
opened or brought back. Offline, changes wait on the device (the dot on the person
icon turns amber) and go up when it's back online.

On first sign-in each device keeps a copy of its data from before the sync
(`spotter.preCloudBackup.v1`, saveable from the account sheet). A coach is asked once
whether to upload the device's lifters. A lifter already on the device under the same
name as one in the account is treated as the same lifter: the cloud's program wins,
and ticks and notes found only on the device are kept and uploaded. While signed in,
the Unload button becomes **Sign out & clear device**: synced lifters leave the
device and come back on the next sign-in; lifters only on the device stay.

Supabase's free plan pauses a project after a week without use; restore it from the
Supabase dashboard (the app keeps working offline meanwhile). Sign-in emails go out
through the owner's Gmail (SMTP with an app password, set in Supabase). The database
set-up guide and the owner script live outside this repo.

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

## Messages and notifications

Signed-in lifters and their coaches message each other in the app: **Messages** in
the lifter's sidebar, plus an **Inbox** for coaches listing every lifter they coach
(unread counts on both, and a red dot on the menu button on phones).

- **One thread or one per coach:** the lifter chooses, with the switch at the top of
  their Messages. On (the default): one thread with all their coaches. Off: a private
  thread with each coach. The other kind stays readable as history.
- **A coach who joins later** sees the shared thread only from when they joined.
- **Finished sessions:** when a lifter has marked every exercise of a day Done or
  Skipped, their coaches are notified once (re-ticking doesn't repeat it), and the
  Inbox shows it.
- **New weeks:** after a coach adds weeks, Manage Program shows **Notify [lifter]** at
  the top. One press sends "A new week is in your program" and it turns into a note
  until more weeks are added. It's shared by all the lifter's coaches, and the
  database enforces once per batch of new weeks.
- **Notifications** (banners on iPhone, Android and computers) are turned on per
  device in the account sheet, where each person also picks which kinds they want.
  They never include a message's text, only who or what. On iPhone they need the
  home-screen app (iOS 16.4 or later).
- Messages are cached on the device to read offline; ones written offline are sent
  when it's back online.
- **Seen:** under your latest message, "Seen" (private thread) or "Seen by Tom,
  Jordan" (shared thread) once they've opened it. A coach who joined after it was sent
  isn't counted.
- **Clear (owner only):** the Clear button on a thread deletes every message in it for
  everyone, after an "are you sure". In the shared thread that includes the other
  coaches' messages; otherwise it's only the owner's own private thread with that
  lifter. It can't be undone.

How the notifications travel: after saving a message or event, the app calls the
`notify` Edge Function (`supabase/functions/notify/index.ts`) with just its id. The
function looks it up, checks the caller made it and it hasn't been announced yet,
works out who should hear about it, and sends a Web Push to each of their devices;
the service worker (`sw.js`) shows it and opens the right screen when it's tapped.
The Web Push **public** key is in `power-logs.html`; the private one is a secret on
the function in Supabase, never in this repo. Setting the function up is a one-off
done in the Supabase dashboard (the private setup guide covers it). Until it is,
messages still work, just without banners.

## Rearranging lifters

With two or more lifters loaded, the lifter dropdown ends with **⇅ Rearrange lifters…**,
and the sidebar has a **Rearrange lifters** button. Both open a sheet where you drag a
lifter by its handle or nudge it with the arrows; the dropdown follows. The order is
saved on the device as you go (`spotter.lifterOrder.v1`). Newly loaded lifters join
at the bottom, a re-imported lifter keeps its place, and **Unload everything** resets
it. iOS draws its own menu for a dropdown, so its items can't be dragged in place.
That's why the dropdown opens a sheet instead.

## The Manage tab, top to bottom

1. **Program:** block/title, **Export CSV**, **Compare two programs**.
2. **Edit a day:** pick the week and day (Undo on the right).
   - **+ Add exercise** sits at the foot of the day's list and opens the form in place.
   - **Days & weeks** (add a day or week, delete the day or week) sits right under it.
   - With a program imported, its day shows beside yours (stacked on a phone).
3. **Use the imported program:** every Replace/Merge in one card, a **Day** row and
   a **Whole week** row that say what goes where ("Imported W1D1 → your W9D1").
4. **Import:** import a CSV/JSON or build one in the Program Hub; once loaded,
   **Import a different program** and **Clear import** live here too.
5. **Sharing** (signed in as a coach): the lifter's sign-in email, their coaches,
   and deleting the lifter for everyone. A lifter only on this device gets an
   **Upload** button instead.

## Notes in Manage Program

Manage Program's top section has a **Notes** card under the two maxes cards: one
free-text note per lifter, edited in the same sheet as Weekly notes (multi-line,
links become tappable). It never appears on the Overview or the week pages, and it
syncs only between the lifter's coaches: the database never sends it to the lifter.
It's stored separately from the program, so re-importing a lifter's CSV keeps it. It
travels in **Save progress (JSON)** backups but never in CSV exports.

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

## Program Hub analytics

Every generated program shows an **Analytics** section under its table: **Total
tonnage**, **Number of lifts** (reps at ≥50% of 1RM) and **Heaviest top set**, per
session or per week. These are the same charts and maths as the app's Analytics view, so
a program charts the same in both. The charts follow the variant you're viewing and
your Sets/Reps edits.

## Program Hub builders fill themselves in

Opened from Manage Program, every builder's **Lifter & 1RMs** card fills its blank
fields from the lifter you have loaded:
- **Name, block and class:** from the lifter's profile.
- **Maxes:** from their **Training maxes** in Manage Program (not the CSV's 1-rep maxes).
- **Bodyweight** (Equipped builder only).

A line under the card title says where the numbers came from. Anything you type
is kept. The fill never overwrites a field you've changed, and switching lifters
only updates the fields you left alone. **Wendler 5/3/1** and **Massthetics** normally
take a 1RM and apply a 90% training max. While they hold your training maxes, their
TM % is set to 100% so the maxes aren't reduced twice. Type your own maxes and it goes
back to 90%.

## Meet Peak v2 · Gen Pop

The first card in the Program Hub. A 16-week classic (raw) meet peak for any set of
maxes, with no lift prioritised: squat and deadlift mirror each other (a heavy day and
a secondary day on the same percentages), bench trains three times a week, and the meet
is week 16, day 4. Every main-lift row has a percentage load *and* an RPE target and
cap. The program notes (shown in the app's Program notes card) explain how to adjust.

- **Third attempts:** pick +1%, +2.5% (default) or +4%. The third is always a PR, and
  the opener and second sit at about 91% and 96% of it.
- **Week 10 calibration:** one single per lift at 87.5%. If it moves at RPE ≤6, rebuild
  with that max +2.5%; at RPE ≥8.5, with −2.5%. Then set **Weeks** to `11-16`, send
  those weeks, and replace them in Manage Program.
- **Clean** export hides the percentages; **Accessory work** can be switched off.

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
- **Scale:** tap the plate to place a circle, drag it onto the plate, and use the
  *Circle size* slider until it touches the plate's top and bottom edges (a plate
  filmed at an angle looks oval, but its height is still the true diameter). The
  magnifier follows the circle's centre, with a crosshair for lining it up on the hub.
- **Bar path:** on the replay and the exported video, the concentric part of each
  counted rep is drawn in yellow; descents, pauses and un-counted reps stay blue.
- **Inside Power Logs:** one-line header (details behind ⓘ), and the frame is sized to
  the rest of the window, so there's one scroll area at most.

## Tracking and defaults

- **Live readout:** while the bar is being tracked, the big number shows the bar's
  current speed (negative on the way down) with the peak so far, and the velocity
  chart draws as it goes.
- **New clip = clean slate:** loading another video clears the previous reps, RPE,
  chart, export and calibration.
- **Bench defaults:** RPE 10 anchor 0.12 m/s (the whole bench curve sits 0.02 m/s
  higher than before), minimum rep height 0.14 m. Anchors you've saved yourself in ⚙
  still win.

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
makes the export take longer instead of freezing frames.

The original sound comes along. For MP4/MOV clips (what an iPhone records) the AAC
audio packets are copied straight out of the file and trimmed to the tracked window,
with no decoding, so it works even where the browser can't decode the clip's audio.
Other files are decoded and re-encoded instead. The ready line says *with the original
audio*, or why the video is silent.

Browsers without WebCodecs, or without an audio encoder when the clip has sound
(Safari before 26), fall back to the older real-time recorder, which keeps the audio
but can still stutter on a slow device.

## Offline

Chart.js is pinned at `4.4.1` on cdnjs and is **precached on install**, not just on
first use. Without that, every analytics and chart view would be blank offline,
which is most of what the app is for on a phone. Bricolage Grotesque and Inter are
cached the same way, and so is supabase-js (pinned at `2.117.2` on jsdelivr), so a
coach can still reach Manage Program offline. Calls to Supabase itself are never
cached: the worker leaves them alone.

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
`CACHE_VERSION` in `sw.js` only if you add/rename files or change the Chart.js or
supabase-js version.

If you change `supabase/schema.sql`, paste it into Supabase's SQL Editor and run it
(it's written to be re-run), then run `supabase/selftest.sql` there too. Do that
**before** pushing an app build that depends on the change.

**Updating never touches your data** — `localStorage` survives new builds. But if
you ever need the nuclear option (Settings → Safari → Advanced → Website Data →
remove the site), that *does* wipe it. Signed in, sign in again and it comes back
from the cloud; signed out, export first.

## Known rough edges

- **Folder scan stays desktop-only.** The app already says so in its own UI. The
  File System Access API isn't in Safari, so "Load CSV files" is the iPhone path.
  Nothing I changed affects this.
- **512px icon is upscaled.** The only source was the 180px embedded logo, so the
  large icon is slightly soft. If you have the original artwork, drop it in as
  `icons/_source.png` and re-run `make_icons.py`.
- **Unsigned, unlisted, no expiry.** Not in the App Store, doesn't need to be, no
  re-signing, no developer account.
