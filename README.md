# Power Logs — iPhone home-screen app

The app (`app.html`, kept out of this repo: see *The app itself is private too*) wrapped as an installable PWA. Runs full-screen with its own icon,
works offline including charts, and exports JSON/CSV through the iOS share sheet.

Separate repo from the Program Hub. Same deploy pattern.

## Files

| File | Purpose |
|---|---|
| `app.html` | The app. Same code plus a PWA `<head>`, touch field sizing, share-sheet exports, persistent-storage request, and service worker registration. **Not in the repo (gitignored) and not on the public site**: it lives in the database (`owner_assets` id `app`, readable by any signed-in account) and `index.html` downloads it after sign-in. This folder keeps the working copy, and the tests load it. |
| `publish-app.js` | Writes the SQL that uploads `app.html` to the database (`node publish-app.js`), after you change it. |
| `test-shell.js` | The sign-in page: sign-in flow, first download, offline, newer versions, a sign-in that ended, delete-on-sign-out, and the real app started and signed out through it — `node test-shell.js`. |
| `rpe-calculator.html` | The RPE Calculator — RPE → %1RM load chart. **Not in the repo (gitignored) and not on the public site**, like the Velocity Tracker: it lives in the database (`owner_assets`, readable by any signed-in account), is downloaded to the device once signed in and deleted on sign-out. Opens inside the app from the **RPE Calculator** nav button. |
| `publish-rpe.js` | Writes the SQL that uploads `rpe-calculator.html` to the database (`node publish-rpe.js`), after you change it. |
| `program-hub.html` | The program builders (Gustav, Wendler, and the rest). **Not in the repo (gitignored) and not on the public site**: it lives in the database, owner-only, and the app copies it to the owner's device. Shown inside the app as the **Program Hub** tab in Manage Program. See *Who sees the Program Hub*. |
| `publish-hub.js` | Writes the SQL that uploads `program-hub.html` to the database (`node publish-hub.js`), after you change it. |
| `test-hubprivate.js` | The Program Hub's copy: downloaded for the owner, opens offline, newer versions, deleted on sign-out, never fetched by other coaches — `node test-hubprivate.js`. |
| `VBT.html` | Velocity Tracker — barbell velocity and RPE from a video clip. **Not in the repo (gitignored) and not on the public site**: it lives in the database (`owner_assets`, readable by any signed-in account), is downloaded to the device once signed in and deleted on sign-out. Opens inside the app from the **Velocity Tracker** nav button. |
| `publish-vbt.js` | Writes the SQL that uploads `VBT.html` to the database (`node publish-vbt.js`), after you change it. |
| `test-announce.js` | Announcements: the Announce button, an owner's to everyone (themself included) and a coach's to their lifters only, the Home pop-up that stacks, scrolls and stays until closed, closed on every device, deleting, signing out — `node test-announce.js`. |
| `test-vidreview.js` | Vid Review end to end on the real rules (stand-ins for the video engine and storage): crop and cut, details, the 30 MB limit, upload, watching, pinch zoom, only coaches delete, sign-out clears the device, the MP4 writer, the owner's storage meter — `node test-vidreview.js`. |
| `test-rpeprivate.js` | The RPE Calculator's copy: same checks as the Velocity Tracker's — `node test-rpeprivate.js`. |
| `test-vbtprivate.js` | The Velocity Tracker's copy: downloaded for any signed-in account, opens offline, newer versions, a message when signed out, deleted on sign-out — `node test-vbtprivate.js`. |
| `manifest.webmanifest` | App name, icon set, colours, `display: standalone`. |
| `sw.js` | Service worker. Offline caching, including Chart.js and supabase-js. |
| `supabase/schema.sql` | The cloud database: tables and the row-level security rules that decide who sees and changes what. Paste into Supabase's SQL Editor; safe to re-run. |
| `supabase/selftest.sql` | Checks on those rules (250 at present). Paste and run after the schema; every row should say PASS. |
| `supabase/functions/notify/index.ts` | The Supabase Edge Function that sends phone/computer notifications (Web Push). Pasted into Supabase once; see *Messages and notifications*. |
| `index.html` | **The only public page**: the sign-in screen (email code), which then downloads the app from the database, keeps it on the device and starts it in the same window. It is also the home-screen `start_url`. |
| `power-logs.html` | Just forwards to `index.html` (keeping `?open=...`), so home-screen icons, bookmarks and notification links made before the move still work. |
| `icons/` | 192, 512, 512-maskable, 180px `apple-touch-icon`, 32px favicon, and `_source.png` (the logo: a red 25 kg plate and a spiral notepad on a pastel sage tile). The header and About sheet use `icon-192.png` too. |
| `.nojekyll` | Stops GitHub Pages running the files through Jekyll. |
| `test-boot.js` | Smoke test — `npm install jsdom && node test-boot.js`. |
| `test-weekrange.js` | Program Hub week-range export tests across all builders — `node test-weekrange.js`. |
| `test-taper.js` | Taper builder: last heavy day per lift for each lifter type, light sessions, rest days, volume cut, Clean, and a real import — `node test-taper.js`. |
| `test-genpop.js` | Meet Peak v2 · Gen Pop builder checks, plus a real import of its CSV into the app — `node test-genpop.js`. |
| `test-lifterorder.js` | Rearranging lifters: the sheet, the dropdown entry, saving and reloading the order — `node test-lifterorder.js`. |
| `test-dmnotes.js` | Manage Program's Notes card: coach-only, editing, links, backups, and that Weekly notes still work — `node test-dmnotes.js`. |
| `test-reimport.js` | Re-importing a lifter's CSV or an older JSON backup keeps their training maxes; the CSV still sets the 1-rep maxes — `node test-reimport.js`. |
| `test-trainingmax.js` | Training maxes: 90% of the 1-rep maxes by default, the 100/95/90/85/80% buttons, typed numbers winning, undo, the Hub and backups — `node test-trainingmax.js`. |
| `test-hubanalytics.js` | Program Hub analytics: charts for each program, controls, and the same numbers as Power Logs' Analytics for the same CSV — `node test-hubanalytics.js`. |
| `test-hubprefill.js` | Program Hub builders filled from the loaded lifter: every builder, typed values kept, Wendler/Massthetics TM %, and Power Logs sending it — `node test-hubprefill.js`. |
| `test-managelayout.js` | Manage Program's Manage tab: section order, and every action from its place (add exercise, days & weeks, undo, import, replace/merge, clear, compare) — `node test-managelayout.js`. |
| `test-cloudsql.js` | The database rules on a real (in-memory) Postgres: `supabase/selftest.sql`, re-running the schema, owner set-up — `node test-cloudsql.js`. |
| `test-cloudsync.js` | Accounts + sync end to end: sign-in, upload, two devices, offline and conflicts, coach approval, a lifter's own login, sharing, removing a coach, deleting, sign-out — `node test-cloudsync.js`. |
| `test-messaging.js` | Messages, finished sessions, new-week alerts and notifications end to end, with the notify function run in-process — `node test-messaging.js`. |
| `test-trophies.js` | Trophies and strength levels: men's and women's standards, class limits, levels, clubs, GL points, Done-set estimates, streaks, comebacks, blocks, PRs, awards, the celebration and the share image — `node test-trophies.js`. |
| `test-trophysync.js` | Trophies across devices on the real rules: earned trophies reach the coach, PR confirmation, awards given and taken back, standards, the notifications, and a trophy problem never holding up the log — `node test-trophysync.js`. |
| `test-notices.js` | The in-app notice banner: messages, finished days, notes (coach or lifter), added weeks, trophies, the x, stacking and Show more / Clear all — `node test-notices.js`. |
| `test-replies.js` | Messages: the emoji picker and replies (the reply bar, quotes, jumping to the original, swiping, saved on the server) — `node test-replies.js`. |
| `test-home.js` | The coach landing page: greeting, cards, the lifters list, Home buttons, who gets it and when — `node test-home.js`. |
| `test-payments.js` | Payments and the lifter's Home, end to end on the real rules: marking months paid/unpaid, day, amount, currency, the lifter's read-only view, and co-coaches kept out — `node test-payments.js`. |
| `test-reactions.js` | Reactions: the eleven emoji, messages (lifter and coach), coaches-only notes and days, one per person, read-only for lifters, the rules, and the notices — `node test-reactions.js`. |
| `test-chatdock.js` | The floating Messages window: minimised button and count, open/minimise, sending, replies, reactions, copy, where it shows, one set of ids on the page — `node test-chatdock.js`. |
| `test-cloudfake.js` | Not a test: the stand-in Supabase the tests plug in (`window.__spotterCloud`), and the in-process runner for the notify function. |
| `test-vbt.js` | Velocity Tracker smoke test — `node test-vbt.js`. |
| `make_icons.ps1` | Regenerates the icons from `icons/_source.png` (`powershell -ExecutionPolicy Bypass -File make_icons.ps1`; no Python needed). |

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
  Removing (or declining) a coach also clears the sign-in emails that coach entered,
  so those lifters lose access; the programs stay with the owner and other coaches.
- **Coach**: signs in, taps **I'm a coach: request access**, and once approved gets
  Manage Program for the lifters they upload or that another coach shares with them.
  Manage Program → the **Sharing** button opens a dialog with the lifter's own sign-in
  email, the list of coaches (share by email, remove), and **Delete lifter for everyone**.
- **Lifter**: signs in with the email their coach entered. Sees only their own program
  (Overview, weeks, Analytics, 1-rep maxes, RPE Calculator, Velocity Tracker) and logs
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

## Invite-only sign-up

Nobody can make an account unless their email is invited. Supabase asks the database before it creates any user (Authentication > Auth Hooks > **Before User Created**, Postgres function `public.hook_before_user_created`, turned on in the dashboard). It lets in:

- an email a coach put on a lifter (Manage Program > Sharing > the lifter's email): that is how a coach invites a lifter;
- an email the owner added under **Account > Invites** (tick *As a coach* and they are a coach the moment they sign in, no approval step);
- the owner's own email.

Anyone else gets "This email hasn't been invited to Power Logs yet. Ask your coach to add it, then try again." on the sign-in page, and no email is sent. Accounts that already exist are not affected (the check only runs when an account would be created), and taking an invite back doesn't remove an account. The list is the `invites` table: only the owner reads or changes it. To turn this off, disable the hook in the dashboard.

## The floating bar (phones and tablets)

On phones and tablets a see-through, blurred pill floats at the bottom of the screen with five buttons: **Home**, **Current Program**, **Messages** (a coach's is the **Inbox** of every lifter), **Analytics** and **Account**. The one you're on is lit, and a red dot marks unread messages (and, for the owner, a coach request waiting). Analytics drops out for a lifter whose coach has hidden it. It steps aside on a conversation (so it can't cover the message box), on the Velocity Tracker and RPE Calculator, and while you're typing. The floating chat button, pop-up messages and the Payments + sit above it.

"Tablet" means a window up to 1024 px wide, or a touch screen without a mouse up to 1400 px (iPad Pro landscape). **Computers don't get it**: they keep only the left menu. The left menu stays on every device (a drawer behind the menu button on phones and narrow tablets, always open on wide ones, where the bar centres itself over the page beside it).

## What a lifter sees: Lifter access

In **Manage Program**, a coach of a synced lifter has a **Lifter access** button (next to Sharing). Its dialog has a switch for:

- the **Analytics page**, and each of its parts (Maxes, Total tonnage, Number of lifts, Heaviest top set);
- the **Velocity Tracker** and the **RPE Calculator**.

Switch one off and it disappears from that lifter's own devices. Switching the Analytics page off (or every part of it) also removes its menu item and the Analytics button on the lifter's **Current Program** page, and takes them off the page if they're on it; a hidden tool leaves their menu the same way. When a lifter hides a tool on every program they have, the tool's file isn't kept on their device either. Coaches (the lifter's other coaches and the owner too) always see everything.

- It is stored per lifter (`lifter_settings.analytics_off` and `tools_off`) and only that lifter's coaches can change it (RPCs `set_analytics_off` and `set_tools_off`); the lifter can read it but not write it. It reaches their phone with the normal sync, and live when they're online.
- This hides the *derived* numbers and charts and the two tools. The lifter's own logged sets and program are still theirs, and their Current Program page still shows their maxes.

## Lifter limits for coaches

In **Account > Coaches** (the person icon), each approved coach shows how many lifters they have and a **Max lifters** box. Type a whole number (say 4) and press Enter or tap away: that coach can then have at most 4 lifters. Leave it empty for no limit. The owner is never limited.

- It counts every way of getting a lifter: creating one, importing a CSV or JSON, uploading lifters that were only on their device, and being shared one by another coach.
- The database enforces it (`accounts.lifter_limit`, a trigger on `lifter_coaches`, RPC `set_lifter_limit` for the owner only); the app also stops at the same number before anything is made, counting lifters only on the device too, and says "Ask the owner for more".
- Lowering a limit below what a coach already has doesn't remove any lifters; they just can't add more. The coach sees "Lifters: 3 of 4 (set by the owner)" in their account sheet.

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
- **Back to Inbox:** a coach in a lifter's chat has a **‹ Back to Inbox** button at the top.
- **Emoji and replies:** the smiley beside the message box opens an emoji picker (tabs, plus
  the ones you used last); tapping one drops it at the cursor. **Reply** (the arrow beside
  a message, or swipe it toward the middle of the screen) quotes that message above the
  box and in the reply, and tapping the quote jumps back to the original. The database
  keeps the pointer (`messages.reply_to`) and drops one that doesn't point at a message in
  the same thread.
- **Copy:** tap and hold a message (or right-click it on a computer) and a **Copy** button appears
  above it; tapping it copies the whole message. Moving your finger (a swipe or a scroll) isn't a
  hold, and on touch screens the system's own text-selection menu is switched off on messages so
  the two don't fight.
- **Swipe back:** in Messages (a thread or the list), swiping right on the empty space goes back
  to the Overview with the left menu open. A swipe that starts on a message is that message's
  reply gesture, so from a message it only counts when it starts at the very left edge.
- **Seen:** under your latest message, "Seen" (private thread) or "Seen by Tom,
  Jordan" (shared thread) once they've opened it. A coach who joined after it was sent
  isn't counted.
- **Your name:** the owner and coaches set how they appear (messages, "Seen by",
  Coaches and Sharing lists, notification banners) under **Your name** in the account
  sheet. Without one it's the start of their email. Lifters go by their `#Name`.
- **Clear (owner only):** the Clear button on a thread deletes every message in it for
  everyone, after an "are you sure". In the shared thread that includes the other
  coaches' messages; otherwise it's only the owner's own private thread with that
  lifter. It can't be undone.

How the notifications travel: after saving a message or event, the app calls the
`notify` Edge Function (`supabase/functions/notify/index.ts`) with just its id. The
function looks it up, checks the caller made it and it hasn't been announced yet,
works out who should hear about it, and sends a Web Push to each of their devices;
the service worker (`sw.js`) shows it and opens the right screen when it's tapped.
The Web Push **public** key is in `app.html`; the private one is a secret on
the function in Supabase, never in this repo. Setting the function up is a one-off
done in the Supabase dashboard (the private setup guide covers it). Until it is,
messages still work, just without banners.

## Home (coaches and lifters)

Everyone signed in lands on **Home** (at launch and right after signing in), and it is the first
item in the sidebar and a ‹ Home button on a lifter's Overview, the lifters list, the Inbox and
Payments. Notifications live in its first card for everyone signed in.

**Coaches and the owner:** "Welcome Coach <name>!" (from "Your name", else the start of their
email), then **Notifications**, **Lifters** (*All lifters* opens a list; tapping one opens their
program and profile as before), **Messages** (*Inbox*) and **Payments**.

**Lifters** (and coaches not yet approved): "Welcome <name>!" using their program's `#Name`,
then **Notifications**, **Programs** (every program assigned to them; tap one to open it),
**Messages** and **Payments** (this month's status, and *View payments*).

**Adding a lifter:** the Lifters page has **+ Add new lifter / program**: name (required), program /
block title, weight class and optional 1-rep maxes (there's no bodyweight question: it starts as the weight class, 120 for 120+, and a coach changes it later in the lifter's Trophies). It creates an empty program (Week 1,
Day 1), opens it in Manage Program to build as usual, and, signed in, uploads it to your account
straight away. Add their sign-in email under Sharing.

**Left menu:** swipe right on Home, the Overview or Analytics to open it; swipe left on the open menu (or on the dimmed page beside it) to close it.

**Deleting:** each lifter on the Lifters page has a **⋯** (coaches who can edit them). **Delete program** clears every
week, day, tick and note (on every device) and leaves an empty Week 1; the lifter stays, with their maxes, class,
messages, trophies and payments. **Delete lifter** removes the lifter altogether (the same as *Delete lifter for
everyone* under Sharing). Both ask first; neither can be undone, so save progress (JSON) first for a copy.

**Weight class** is editable in Manage Program's *Lifter & program/block title* card (IPF classes
are offered; "74kg" is saved as 74, open classes keep their +).

**Coach requests:** a declined or removed coach has **Delete request** in the owner's Coaches list.
It makes them an ordinary account again (a lifter, if they have a program), and they can ask to be a
coach again (`decide_coach(…, 'cleared')`; only declined or removed requests can be deleted).

## Floating Messages window

For coaches **and lifters** on a lifter's **Overview** or a **week** (a lifter's own program): a small window at the bottom right with the same
Messages as the Messages page (every thread, the message box, replies, emoji, reactions, hold-to-copy,
unread counts and Seen), so you can keep talking while you look at the program. It's a small window with one button, **Minimise**, which shrinks it to a round message
button with the unread count (the round button shows only while it's minimised). Tapping anywhere outside the open window minimises it too. It's a lifter-by-lifter window (it follows the lifter you're viewing), stays in
the state you left it across pages and launches, and gives way to the real Messages page there. A message that
arrives while it's minimised is counted, not marked read, until you open it. A lifter's window is titled
*Messages* and has the lifter's own controls (the switch for one thread with all their coaches).

## Gestures

- **Home:** pull down at the top to sync everything (the log, messages, trophies, payments,
  reactions). It says "Syncing…", then "Up to date". Pulling while scrolled part-way down is just scrolling.
- **Overview and Analytics:** swipe right to open the left navigation. A touch that starts on a chart,
  a field or something that scrolls sideways is that thing's, and a mostly-vertical swipe is a scroll.
- **Messages:** swipe right on the empty space goes back to the Overview (see *Messages*); swipe a message
  toward the middle to reply; hold a message to copy it. Opening Messages, focusing or typing in the box,
  and sending all scroll to the newest message.

## Payments

For a coach to track each month's payment from the lifters they created or loaded.

- **Who:** only the coach who created the lifter (`lifters.created_by`) sees and edits them; the
  lifter sees their own, read-only. Other coaches sharing the lifter don't see them. The database
  enforces this (`lifter_payments`, row-level security; `private.made_lifter()`).
- **How:** Home → Payments lists your lifters with this month's status. Open one to see the last
  twelve months, newest first, each **Unpaid** until marked. Tap a month: **Paid / Unpaid**, the
  **day** it was paid (today for the current month, otherwise the 1st, changeable), and the
  **amount** (optional) in **₱ PHP, £ GBP or $ USD**. The next month offers the last amount used.
  The currency buttons above the months set the default.
- **Delete a month:** the coach swipes a month to the right to show a red **x**; tapping it removes
  that month from the list altogether (an Undo appears). The month editor has **Delete month** too,
  for a computer. A round **+** button at the bottom right adds any month and year back (or a past
  one), unpaid. Lifters get neither. A deleted month is kept in the database as a row with
  `removed = true`, so the lifter's and the coach's other devices drop it too.
- **Lifters** see the same months and amounts, and can't change anything.
- Stored on the device in `spotter.payments.v1` (by lifter name) and synced after Trophies in
  `syncNow()`; a problem there never holds up the training log. Lifters only on the coach's device
  are tracked on that device until they're uploaded.

## Who sees the Program Hub

The **Program Hub** is the owner's alone, and it isn't a public file any more.

- **Where it lives:** `program-hub.html` is gitignored (never pushed) and stored in the database table `owner_assets`, which only the owner can read (row-level security; nobody can write through the API). `sw.js` doesn't cache it either.
- **On the owner's device:** once signed in and online, the app downloads it and keeps a copy in IndexedDB, so the Hub opens offline. It checks the version in the background (a few bytes) and downloads a newer one when there is one; the new one opens the next time the tab is opened. It runs inside the app in a frame, with its page settings handed over by the app.
- **Signing out deletes it.** So does no longer being the owner. If the delete ever fails, the device remembers (`spotter.hubHeld`) and retries on the next launch.
- **Other coaches and lifters:** the Hub tab and the Import card's "Build one in Program Hub" button are hidden (`.owner-only`, from `applyRoleUI()` / `isOwner()`), their app never asks for the file, and the database wouldn't give it to them.
- **Updating it:** change `program-hub.html`, bump its `hub-N` string and `HUB_BUILD` in `app.html` together, run `node publish-hub.js`, paste the file it writes (in "Power Logs Cloud Setup", outside this repo) into Supabase's SQL editor and Run. No app deploy needed unless the app changed.
- **History:** earlier commits in this public repo still contain the old public `program-hub.html`; removing it from `main` doesn't remove that.

## Vid Review

A page for videos a lifter or a coach wants reviewed ("Vid Review" in the left menu, for the lifter in view; it needs an account and a program shared with you).

- **Uploading:** *Upload video* → pick a clip (it opens on the device only) → **crop and cut**: drag the portrait box over the picture, *Crop size* resizes it; the **cut bar** under the picture is a strip of pictures from along the clip, with a handle at each end of the part you keep (drag them, as when cutting an Instagram story; they stay a second apart) and a white bar showing where the picture is. The **play button** in the middle of the picture plays the kept part from its start (tap the picture to stop) → *Next* → **details**: the *lift* (required, plain free text, with **Squat / Bench / Deadlift** buttons directly under it that fill it in), the *weight* ("140" means 140 kg; "60 lb" or "bodyweight" are kept as typed), *reps* and *set* (any text: "4", "Top set", "Last warm up") and **Notes** (a multi-line box up to 1,000 characters, with an emoji button; shown as a preview on the card and in full in the player) → *Upload*. The floating Messages window is on this page too, as on Overview.
- **Compression** happens on the phone (WebCodecs; iPhones need iOS 16.4 or later): H.264, **368 × 654 portrait**, 30 fps, about 800 kbps, **no sound**. A 20-second clip comes out around 2 MB. **It starts the moment the clip opens**, compressing the whole clip in the background while you crop, cut and fill in the details; the crop box starting again (after a moment) whenever you move or resize it. At *Upload*, if the crop is the one it already compressed, the finished file is simply cut to your Start and End (no second encode, so it's near-instant; the cut starts at the key frame at or before Start, up to half a second early). If you finish editing sooner it waits for the rest (the progress bar shows it), and if that would take longer than compressing just your part it does that instead. The clip is played through at up to 2× while compressing, and slows itself if the phone can't keep up. If the result is over **30 MB** it is not sent: "Video too long". Uploading needs a connection (nothing is queued).
- **Where it goes:** the private storage bucket `vid-review` (named `<lifter id>/<video id>.mp4`, mp4 only, 30 MB a file), and a row in `lifter_videos` (lift, reps, set, size, length, a tiny JPEG thumbnail, who sent it). The lifter and their coaches add and watch; **only coaches delete**, which removes the file from storage and then the row (the row is only deleted once the file is confirmed gone; otherwise nothing is deleted and it can be tried again), and other devices drop their copy at their next sync. The free plan gives 1 GB of files.
- **Watching:** the list shows thumbnails with "Squat · 140 kg · 4 reps · Top set", who uploaded it and the date and time ("6 Oct 2026, 20:44"). Tapping one downloads it (first time only) and plays it. A copy is kept on the device in IndexedDB until the user signs out (a ✓ on the card says so; `spotter.vidHeld` retries a failed delete on the next launch). The player pinch-zooms (and wheel-zooms) from fitting the screen up to 6×, never smaller than fitting and never moved so that the picture's edge leaves the screen; the zoom stays while you rewind, replay or scrub, *Fit* resets it; there's -5 s, +5 s, Replay, and 1×/0.5×/0.25× speed.
- **Coaches are told about new videos** (not the lifter about a coach's, and not the uploader): the **Vid Review** item in the left menu gets the small red circle with the count of videos not yet looked at for the lifter in view (opening the page looks at them), the menu button gets its dot for new videos on any lifter, Home's notices say "Tom uploaded a video: Squat · 140 kg · 4 reps" (tap to open it), and a **phone/computer banner** ("Tom uploaded a video", names only) goes to coaches who have notifications on and the new switch *A new video is uploaded* (Account → Notifications). The banner is a `lifter_events` row of kind `video` (week = the video's id) turned into a push by the `notify` Edge Function, which needs redeploying when it changes; the first sync after this arrived counts existing videos as seen.
- **Code:** the engine (`VID_ENGINE`: `load`, `transcode`, and `vidMp4`, a video-only MP4 writer) is separate so tests plug in a stand-in as `window.__spotterVideo`; storage calls are `storageUpload/Download/Remove` on the cloud API. The rules are the table's policies and `storage.objects` policies that call `private.vid_can_see/add/delete` (in `schema.sql`).

### The owner's storage meter

Home has a **Storage** card below Payments for the owner only: video files against 1 GB and the database against 500 MB (the free plan's limits), from the owner-only `owner_storage_usage()` function. *Refresh* re-reads it.

## Announcements

An **Announce** button on the Home page of coaches and the owner opens a window to type in (multi-line, up to 2,000 characters, with an emoji button). The **owner** chooses *Everyone* (every account in the app, the owner included) or *My lifters*; a **coach** can only announce to **their own lifters** (those who have signed in). Below the box is a list of your recent announcements, each with **Delete** (it disappears for everyone).

On the receiving side it is a **pop-up on the Home page**: the announcements stack, newest first, in a scrolling list, each on a light pastel-green card with black text, the author and the **date and time in small print**, and its own **close button**. It stays until that person closes it (not by tapping outside or Escape); closing is saved, so it is closed on their other devices too, and the pop-up goes when none are left. Leaving Home hides it and coming back shows what is still open. Nobody sees what was announced before they joined (everyone) or before their coach began coaching them (to lifters).

- **Where:** tables `announcements` (`scope` `all` or `lifters`) and `announcement_closed`; who may read/write is in `schema.sql` (`private.can_read_announcement`). A coach can't announce to everyone, a lifter can't announce, the author or the owner can delete.
- **Code:** `ANN` (`spotter.announce.v1`), `annSync()` (in `syncNow`, at most once a minute unless a change is announced), `annShow()` (called by `showView` and `renderHome`), `openAnnounce()`/`annSend()`.

## The app itself is private too

Only `index.html` (the sign-in page), `power-logs.html` (a redirect), `sw.js`, the manifest and the icons are public. The app is `app.html`: gitignored, stored in `owner_assets` as id `app` with `members = true` (any signed-in account, nobody signed out), exactly like the other tools.

- **Launch:** `index.html` checks for a sign-in (the same `spotter.auth` slot as the app). No sign-in: it deletes any stored copy and shows the email-code form. Signed in: it asks for the version (`APP_VERSION-<hash of the file>`), downloads the app when that differs from the stored copy (IndexedDB `spotter-private`, key `app`, flag `spotter.appHeld`), loads Chart.js and supabase-js, then writes the app into the same window (`document.open/write/close`) so its address, `?open=...` and storage carry straight over. Offline, or if the check times out, it starts the stored copy; with no copy it says to connect once.
- **Signing out:** the app (when started by the page, `window.__spotterShell`) calls `appLeave()`, which deletes the copy and returns to `index.html`. The same happens if the session ends elsewhere. A failed delete is retried at the next launch.
- **Opened directly** (the tests, or the local file) the app behaves as before, signed out and all.
- **History:** earlier commits of this public repo contained the old public app; they have to be rewritten out (`git filter-branch`) and force-pushed. Anyone who cloned earlier still has them. Anyone can create an account with an email code, so this keeps the code from the public, not from account holders.

## The Velocity Tracker is private too

`VBT.html` is gitignored (never pushed) and stored in `owner_assets` like the Program Hub, but marked `members`, so **any signed-in account** can read it (and nobody signed out). It works the same way on the device: downloaded once signed in and kept in IndexedDB so it opens offline, a newer version is fetched in the background, and **signing out deletes it** (retried on the next launch if that fails, via `spotter.vbtHeld`). Signed out, the Velocity Tracker page says to sign in. `sw.js` doesn't cache it.

- **Updating it:** change `VBT.html`, bump its `vbt-N` string and `VBT_BUILD` in `app.html` together, run `node publish-vbt.js`, paste the file it writes (in "Power Logs Cloud Setup") into Supabase's SQL editor and Run.
- **History:** earlier commits in this public repo still contain the old public `VBT.html`; removing it from `main` doesn't remove that.

## The RPE Calculator is private too

`rpe-calculator.html` (the old `rpe-estimator.html`, renamed) works exactly like the Velocity Tracker: gitignored, stored in `owner_assets` as id `rpe` with `members = true`, downloaded once signed in into IndexedDB (opens offline), refreshed in the background when a newer version is up, and **deleted on sign-out** (retried on the next launch via `spotter.rpeHeld`). Signed out, its page says to sign in. Both tools share one mechanism, `makePrivateTool()` in `app.html`.

- **Updating it:** change `rpe-calculator.html`, bump its `rpe-N` string and `RPE_BUILD` in `app.html` together, run `node publish-rpe.js`, paste the file it writes (in "Power Logs Cloud Setup") into Supabase's SQL editor and Run.
- **History:** earlier commits in this public repo still contain the old public `rpe-estimator.html`.

## The notice banner

Signed in, anything that happened while you were away shows as a banner at the top of
the app, on every screen: new **messages**, a lifter's **finished days** (coaches), new
**trophies and awards**, **weeks and days a coach added** (lifters; it says which, so
no need for the coach to press Notify), and **weekly notes**, saying whether a coach
or the lifter (e.g. "Tom (lifter)") wrote it. Each row has an **x** to close it;
tapping the row opens the place it's about and clears it. Nothing is shown for your
own actions.

Away for days, it stays short: notices stack by lifter and kind, newest first, so a
week of ticks is one row ("Tom finished 4 days", with the latest underneath), three
rows show at a time with **Show N more** for the rest, and **Clear all** appears once
there are two or more. Messages clear themselves once read, trophies once Trophies is
opened, and the rest once their week is opened. Notices are kept on the device for up
to 30 days (`spotter.notices.v1`), are made as a sync brings in something someone else
did (the first sync on a new device is silent), and are dropped on sign-out.

## Reactions

Eleven emoji, Instagram style: ❤️ heart, 👍 thumbs up, 💯, 🔥 fire, 😴 sleepy, 😫 tired, 😈 devil, 😞 sad, 😭 crying, 😊 happy and 😟 worried
(the database's list of allowed ones is in `schema.sql`).
One reaction per person per thing: pick another and it replaces yours, tap your own to take it back.

- **Messages:** the lifter and their coaches can react. The smiley beside a message opens the
  seven; double-tapping a message gives it a ❤️. Chips under the message show who reacted (hold
  or hover for names; several people on one emoji show a count).
- **Weekly notes and training days:** only coaches can react (to the lifter's weekly note, or to
  a day in the week view). Lifters see the reactions, read-only.
- The person whose message, note or day it is gets an in-app notice ("owner reacted 🔥 to week 1 · day 2").
- Synced after Payments (`lifter_reactions`; the database enforces who may react to what, and a
  reaction on a private coach thread is visible only to that thread). Only synced lifters have them.

## Trophies and strength levels

**Trophies** in each lifter's sidebar (everyone, signed in or not). Two things live
there: a **strength level** for each lift, and a shelf of trophies to collect.

**Levels.** Pick *Men's standards* or *Women's standards* and a bodyweight. The
lifter's IPF weight class is the limit their bodyweight falls under (men 59, 66, 74,
83, 93, 105, 120, 120+; women 47, 52, 57, 63, 69, 76, 84, 84+), and each lift is
placed on five rungs for that class: Beginner, Novice, Intermediate, Advanced, Elite.
The thresholds are the Strength Level community's percentiles (Beginner beats about
5% of lifters, Novice 20%, Intermediate 50%, Advanced 80%, Elite 95%), interpolated to
each class limit and rounded to 2.5 kg (the table is `TRO_STD` in app.html; the
open classes 120+ and 84+ use 130 kg and 95 kg). The **overall level** is the average
of the three lifts, rounded down. It is community data, not competition data, and the
women's sample is smaller, so it is a guide.

A lift's number is the best of: the 1RM on file, a coach-confirmed PR, or an Epley
estimate from a **Done** set of up to 6 reps (competition lifts only; skipped or
undone sets never count).

**The shelf** (about 60): per-lift and overall levels; strength clubs (bodyweight
multiples, totals of 300/400/500/600 kg men and 150/200/250/300 kg women, and IPF GL
points 50/65/80/100, using the classic formula); consistency (finished training days,
weekly streaks, full weeks, perfect blocks, comeback, taper complete); PRs logged;
and coach awards (Meet debut, Meet PR, 9 for 9, Podium, Total PR, or the coach's own
title and message).

- **Earned for good.** A trophy is stored with its date and the class at the time and
  is never taken back, so changing weight class or lowering a max loses nothing. The
  first look at an existing lifter is silent; after that, one new trophy opens a
  celebration, and several at once just mark themselves **New** (and badge the sidebar).
- **PRs.** The lifter taps **Log a PR**; it counts toward trophies once a coach
  confirms it (a coach's own PR entries, and PRs on a lifter who only lives on this
  device, are confirmed straight away).
- **Awards** are the coach's to give (**Give an award**) and to take back; the lifter
  is celebrated with it.
- **Streaks and comebacks** use the date each finished day was first seen, kept from
  this version on (and, for signed-in lifters, the finished-day events), so they start
  counting from then, not from earlier history.
- **Sharing.** Every trophy opens as a story-sized (1080 × 1920) picture, with the
  lifter's name optional. **Share to your story** opens the phone's share sheet with
  the picture, where Instagram, Facebook, TikTok, Snapchat or WhatsApp offer Story or
  My Day. Apps don't let a website post to a story directly, so this hands the picture
  over; on a computer it saves the image instead. Nothing is shared unless the lifter
  taps it.
- **Coaches** are notified once when a lifter earns something ("Tom earned a trophy",
  never which) and see it in their Inbox; lifters are notified of awards. Each person
  can switch those banners off in the account sheet.

How it syncs: its own store (`spotter.trophies.v1`, keyed by lifter name) rather than
the log's, pushed and pulled after Messages in `syncNow()`; a problem there never
holds up the training log. In the database: `lifter_trophies` (what's earned; awards
only by coaches, who can also take them back), `lifter_prs` (the lifter logs, a coach
confirms), the lifter's standards and bodyweight in `lifter_settings` (RPC
`set_trophy_profile`), and a `trophy` kind of `lifter_events` for the banners. The
rules are in `supabase/schema.sql`; update the database (and the `notify` function)
**before** deploying. Trophies the app works out are the lifter's own device's word,
like Done ticks; only PRs and awards need a coach.

## Rearranging lifters

With two or more lifters loaded, the lifter dropdown ends with **⇅ Rearrange lifters…**,
and the sidebar has a **Rearrange lifters** button. Both open a sheet where you drag a
lifter by its handle or nudge it with the arrows; the dropdown follows. The order is
saved on the device as you go (`spotter.lifterOrder.v1`). Newly loaded lifters join
at the bottom, a re-imported lifter keeps its place, and **Unload everything** resets
it. iOS draws its own menu for a dropdown, so its items can't be dragged in place.
That's why the dropdown opens a sheet instead.

## The Manage tab, top to bottom

1. **Lifter & program/block title** (a collapsible card; it remembers whether you left it open, and
   when collapsed its header still reads "Name · Block"): the lifter's name (a coach can
   rename them; a synced lifter is renamed on every device, theirs included),
   block/title, weight class and **bodyweight** (kg; it starts as the weight class when a lifter is added,
   and the lifter's Trophies bodyweight follows an edit here), **Export CSV**, **Compare two programs** and **Edit program notes** (the card on the
   Overview: type to add or change it, clear the text to erase it; a line like `== Heading ==`
   becomes a heading).
2. **Edit a day:** pick the week and day (Undo on the right).
   - **+ Add exercise** sits at the foot of the day's list and opens the form in place.
   - **Days & weeks** (add a day or week, delete the day or week) sits right under it.
   - With a program imported, its day shows beside yours (stacked on a phone).
3. **Use the imported program:** every Replace/Merge in one card, a **Day** row and
   a **Whole week** row that say what goes where ("Imported W1D1 → your W9D1").
4. **Import:** import a CSV/JSON or build one in the Program Hub; once loaded,
   **Import a different program** and **Clear import** live here too.
5. **Three buttons above the tabs** (two to a row on a phone). **Sharing** (signed in
   as a coach, on the left) opens a dialog with the lifter's sign-in email, their
   coaches, and deleting the lifter for everyone; a lifter only on this device gets an
   **Upload** button there instead. **Maxes and notes** opens the dialog described
   below. **Analytics** opens one dialog with the program charts (number of lifts,
   heaviest top sets, fatigue estimate) followed by the progression and load views
   (estimated 1RM, adherence, acute:chronic workload, volume by lift). Each button's
   second line summarises what's inside. The tabs underneath are Manage program, Warm up
   Calculator and Program Hub; the charts are only drawn while the Analytics dialog is
   open.

## Notes in Manage Program

Manage Program's **Maxes and notes** button opens one dialog (a bottom sheet on a
   phone, like Account). Each lift is a row with
its 1-rep max beside its training max; a row of 100/95/90/85/80% buttons sets the
percentage the training maxes follow (grey numbers follow it, dark ones were typed by
hand, and the small arrow puts a typed one back); **Add another lift** takes a 1-rep
max, a training max, or both. Below that sits the **Notes** section: one
free-text note per lifter, edited in the same sheet as Weekly notes (multi-line, with an emoji button and **Select all**,
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

If you change `program-hub.html`, see *Who sees the Program Hub* above: bump its `hub-N` and `HUB_BUILD` in `app.html` together, then `node publish-hub.js` and run the SQL it writes. If the copy a device holds is older than the app expects, the Program Hub tab says so outright instead of just missing its Send button.


To release an app change: run the tests, then `node publish-app.js` and paste the file it writes (in "Power Logs Cloud Setup") into Supabase's SQL editor and Run. Nothing needs pushing to GitHub. Every signed-in device checks the version when it opens (a small request), downloads the new one first if it differs, and otherwise starts from its stored copy; offline it starts from the copy. Only changes to `index.html`, `sw.js`, the manifest or the icons are pushed with git (HTML there is fetched network-first). Bump
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
- **A changed icon reaches the home screen only when it's re-added.** iOS copies the icon when
  you tap Add to Home Screen, so an installed app keeps the old one until you remove it and add
  it again. The header logo and browser tab update on their own. To change the logo, replace
  `icons/_source.png` (a full-bleed square) and run `make_icons.ps1`.
- **Unsigned, unlisted, no expiry.** Not in the App Store, doesn't need to be, no
  re-signing, no developer account.
