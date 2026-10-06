# EmmStrength Power Logs

An installable iPhone/desktop PWA for powerlifting training logs. No build step,
no framework, no server of our own — four self-contained HTML files with inline
`<script>`/`<style>`, deployed as static files to GitHub Pages and installed to
the iOS home screen via Safari. Data lives in `localStorage` on-device; signed
in, it also syncs through Supabase (see *Accounts + sync*). This folder is a git repo tracking
`origin/main` (https://github.com/emm-strength-gh/power-logs), kept
byte-for-byte identical to it — deploy by committing the files you changed and
`git push origin main`. `node_modules/`, `test-assets/` (a personal video) and
`program-hub.html` (owner-only; see below) and `VBT.html` (members-only, same mechanism) are gitignored and must never be published:
the repo is public.

Full user-facing/deploy documentation is in [README.md](README.md) — read that
too, it covers iOS PWA quirks, the update/versioning ritual, and known rough
edges in more depth than this file.

## The four apps

| File | Role | Standalone? |
|---|---|---|
| [power-logs.html](power-logs.html) | **The main app** ("Power Logs"). Lifter profiles, weekly program view, done/skip tracking, notes, custom items, Manage Program (day/week editing, coaches only), accounts + cloud sync, Analytics, Compare, plate calculator, rest timer, warm-up calculator, JSON/CSV import-export. Hosts the other three apps in iframes. | Yes — this is the PWA entry point (`start_url`). |
| [program-hub.html](program-hub.html) | Program **builders**: Meet Peak v2 Gen Pop (balanced 16-week peak, first card), Taper (2 weeks: last heavy week + taper, three lifter types), Gustav, Wendler, equipped lifting, single-lift (squat/bench/deadlift), combined, Lilliebridge, KSB, CVBT, MDL, fatigue-managed, etc. Generates a CSV program. | Not served: gitignored, kept in the database (`owner_assets`, owner-only) and copied to the owner's device. Opens inside Power Logs as the **Program Hub** tab in Manage Program. |
| [VBT.html](VBT.html) | **Velocity Tracker**. Loads a video clip, tracks the barbell path frame-by-frame, computes bar speed/RPE per rep, detects stalls/grinds, exports an annotated MP4 (custom `mp4Mux` muxer + WebCodecs) or CSV. | Not served: gitignored, kept in the database (`owner_assets` with `members = true`, readable by any signed-in account) and copied to the device (`vbtSync()`, IndexedDB `HUB_STORE`, deleted on sign-out by `vbtLocalClear()`). Opens inside Power Logs from the **Velocity Tracker** nav button as an iframe `srcdoc` (`window.__vbtParams`). Upload with `node publish-vbt.js`. |
| [rpe-estimator.html](rpe-estimator.html) | RPE ↔ %1RM load-chart tool (Chart.js). | Yes, and opens inside Power Logs (RPE Estimator in the sidebar). |

Supporting files: [manifest.webmanifest](manifest.webmanifest) (PWA metadata),
[sw.js](sw.js) (service worker — see caching strategy below),
[index.html](index.html) (redirect shim to `power-logs.html`),
[icons/](icons/) (+ [make_icons.ps1](make_icons.ps1) to regenerate them from
`icons/_source.png`: the 25 kg plate and notepad logo on the app's pastel sage).

## Embedding protocol (iframe ⇄ parent postMessage)

`power-logs.html` embeds the other three as iframes and talks to them only via
`postMessage` — never reaches into their DOM directly. Each embedded page:

- Only activates embed behavior when loaded with `?embed=1` in the query
  string (see `qp("embed")` guards near the bottom of each file); opened
  standalone, it behaves like an ordinary page with no parent.
- Reads `?theme=light|dark` from the URL at load (so there's no wrong-palette
  flash) and then listens for `{ type: "spotter-theme", theme }` messages to
  stay in sync if the user toggles theme while the panel is open
  (`applyHostTheme()` in each file).
- Announces readiness once its message listener is live:
  `spotter-rpe-ready`, `spotter-vbt-ready`, `spotter-hub-ready` (the hub's
  ready message also carries `features: [...]`, checked by `checkHubBuild()`
  in power-logs.html to detect a stale deployed copy).

Program Hub additionally:
- Sends `spotter-hub-height` so the parent can resize the iframe to fit
  content (one scrollable document instead of nested scroll areas).
- Sends `spotter-hub-program` with a generated CSV (**Send to Manage
  Program** button) — `loadDonorFromHub()` in power-logs.html parses it and
  drops it into the Manage Program **donor** slot, exactly like a file import.
- Sends `spotter-hub-toast` to surface a message via the parent's toast UI.
- Receives `spotter-lifter` (`pushLifterToHub()`: on hub-ready, on opening
  the Hub tab, after max or block edits) with the lifter in view: `name`,
  `block`, `cls`, `bodyweight`, `trainingMaxes`. The embed shim fills each
  builder's blank fields from it: training maxes, not the CSV 1-rep maxes.
  A field is written only while blank, at its default, or still holding the
  previous fill (`data-filled`), so typed values are never overwritten.
  Wendler/Massthetics derive their own TM, so their TM % goes to 100% while
  their max fields hold prefilled TMs.

## Data model (power-logs.html)

Everything lives in `localStorage` under versioned keys (`STORE_*` near the
top of the `<script>` in power-logs.html, e.g. `spotter.profiles.v1`). Bump
the `.vN` suffix if you ever change a stored shape incompatibly.

- `PROFILES`: `name -> { name, block, classWt, maxes:{}, weeks:[{week, days:[{day, rows:[...]}]}] }`
  — one profile per lifter, built by `buildProfile()` from an imported
  `#Name`-header CSV or a Power Logs JSON export.
- `DONE` / `SKIP`: `name -> { rid: true }` — per-row completion/skip state,
  keyed by row id (`rid`), independent of the program data itself.
- `NOTES`: `name -> { rid: "text" }` — user overrides of the derived
  RPE+Notes text for a row.
- `CUSTOM`: `name -> [{ cid, week, day, text, ... }]` — user-added items not
  present in the imported program.
- `WKNOTES` (`spotter.weekNotes.v1`): `name -> { week: "text" }`, Weekly notes.
  `DMNOTES` (`spotter.dmNotes.v1`): `name -> "text"`, the single Notes entry in
  Manage Program's top section, never rendered outside Manage Program. Both are
  their own stores, not on the profile, because a CSV re-import replaces the whole
  profile. Both share one editor sheet (`openNoteEditor()` with save/done
  callbacks) and ride in the JSON export (`weekNotes`, `manageNotes`).
- `trainingMaxes` does live on the profile, and it has no CSV form, so
  `ingestText()` carries it over from the lifter being replaced, and
  `ingestJSON()` keeps the device's copy when an older export lacks it. It holds
  only the numbers typed by hand; every other lift's training max is computed as
  `p.tmPct`% (90 until a 100/95/90/85/80% button is pressed) of its 1-rep max, to
  the nearest 0.5 kg (`trainingMaxesOf(p)`, which the card and the Hub use), so
  defaults follow the 1-rep maxes and a lift without one has none. `tmPct` is
  carried over by re-imports like `trainingMaxes`. Manage Program shows 1-rep maxes, training
  maxes and the Notes in one dialog (`buildMaxesNotesBody()`, opened from the "Maxes
  and notes" button), Sharing in another (`buildShareSection()`), and the program charts plus the
  progression/load views in a third (`fillAnalyticsDialog()`: `renderDMCharts()` +
  `renderDMAnalytics()`, drawn only while it's open, freed on close); the buttons are
  `renderDMMaxes()`'s `#dmTools` row, which also refills an open dialog (`fillDialog`).
  Both scrims sit before the note editor and confirmations in the DOM so those open on
  top. One undo step
  (`mnSnap`/`mnRestore`) restores both max stores and `tmPct` together. The CSV
  stays the source of truth for everything it does carry (rows, `#Block`, `#Max`).
- `ORDER` (`spotter.lifterOrder.v1`): lifter names in the user's arranged
  dropdown order. Always enumerate lifters through `lifterNames()`, never
  `Object.keys(PROFILES)`: it applies this order and appends anything loaded
  since. It's a separate list because JS forces all-digit object keys first.
- `TRO` (`spotter.trophies.v1`): `name -> { earned: {id: {at,on,cls,note,title,by,rid,sent,seen,notify}}, prs, prefs: {sex,bw,dirty}, days, blocks, gone, init }`.
  Its own store like Messages (not in `SYNCED_STORES`, synced by `troSync()` after
  `pullMessages`/`pushMessages` in `syncNow()`; a failure there only sets `troUI.error`).
  See *Trophies and strength levels* below. `renameLocal`/`removeLocalLifter` move/drop it.
- Plus small scalars: last-selected lifter, theme, tools prefs (plate bar
  weight/collar mode, rest-timer duration/alert pref), Day-Manager
  add-panel-open state.

Manage Program's day/week editing (coaches only: `canManage(name)`, see below)
keeps a **donor** program in memory only — imported from a file or received from the Program Hub — and never
writes it to `PROFILES`/localStorage until the user explicitly
Replaces/Merges a day or week. A 5-deep undo stack (`dmUndoStack`) backs
row/day/week deletes and edits there; drag-to-reorder deliberately isn't
undoable.

## Accounts + sync (Supabase)

The "Cloud: accounts + sync" section of power-logs.html. localStorage stays the
working copy; the database is Supabase (project URL + **publishable** key are in
the page, public by design). **Who may see or change what is enforced only by
row-level security in [supabase/schema.sql](supabase/schema.sql)**; the app's own
checks (`isOwner`/`isCoach`/`canManage`/`isCoachManaged`) just decide what to show.
Never put the secret key or the owner's email in this repo: the owner is set by a
private script kept outside it (`private.settings`).

- Roles: owner (sees all, approves coaches via the `decide_coach` RPC, which on
  revoke/decline also clears the `lifter_email`s that coach entered,
  `lifters.lifter_email_by`), coach
  (`coach_status = 'approved'`; edits lifters linked in `lifter_coaches`), lifter
  (`lifters.lifter_email` matches their confirmed email; reads the program, writes
  only the log tables). Manage Program shows only when `canManage(current)`; a
  lifter only on this device counts as the coach's own. The old PIN is gone.
  Loading/saving files (every Load/Save control, marked `.files-only`) is
  coaches-only too: `applyRoleUI()` toggles `html.can-files`.
- Tables: `lifters` (program as jsonb without `name`/`cloudId`/flat `week.rows`),
  and one small row per tick/note/item: `lifter_marks`, `lifter_row_notes`
  (null body = no override), `lifter_custom` (item carries `pos`),
  `lifter_week_notes`, `lifter_coach_notes` (coaches only), `user_prefs`.
- Every `safeWrite` to a store in `SYNCED_STORES` calls `cloudDirty()` →
  `syncNow()`: pull (apply server rows unless the local value differs from
  `CLOUD.shadow`, i.e. has an unsent change), then push (diff against `shadow`,
  `lifterChanges()`). Programs are compared by hash (`progHash`, stable JSON),
  not stored twice. Writes that come from the server go through `quietWrite` so
  they don't trigger another upload. Profiles carry `cloudId`; the local key is
  still the name (`localNameFor` suffixes clashes).
  Renaming (Manage Program's "Lifter name", `renameLifter()`): the server's
  `lifters.name` first, then `renameLocal()` moves every name-keyed store; other
  devices notice `row.name` differing from `shadow.name` on pull and follow. Row
  ids keep the old name inside them (they're only ids).
- Messages (the "Messages" section of power-logs.html, below the account sheet):
  thread `team` = lifter + all their coaches, else one per coach keyed by the
  coach's user id; the lifter chooses (`lifter_settings.team_thread`, RPC
  `set_team_thread`). A coach reads the team thread only from their
  `lifter_coaches.created_at`. Not local-first like the log: cached in
  `spotter.messages.v1` (`MSG`) with an outbox, synced after the log in
  `syncNow()` (a messaging failure only sets `CLOUD.msgError`). Finished days
  (`sessionCheck()`, from `setDone`/`setSkipped`) and new weeks
  (`notify_new_week` RPC, once per batch, shared by coaches) are
  `lifter_events`. Notifications: Web Push via the `notify` Edge Function
  (`supabase/functions/notify/index.ts`), called by the app with just an id;
  it claims `notified_at` so each thing is announced once. `sw.js` shows them
  and opens `power-logs.html?open=messages|week&lifter=…` (`applyPendingOpen`).
  VAPID public key in the page; the private key is a Supabase secret only.
  "Seen": `message_reads` are readable by everyone in the thread
  (`private.in_thread`); mine go to `MSG.reads`, others' to `MSG.seen`
  (`seenLine()`; a coach's marker counts only for messages after they joined).
  Names: owner/coaches set `accounts.display_name` ("Your name" in the account
  sheet, RPC `set_display_name`), used by `coachName()` and the notify function;
  lifters are always their program's `#Name`.
  "Clear": owner-only RPC `clear_thread` deletes a thread's messages and stamps
  `lifter_settings.cleared[thread]`, which other devices use to drop their copies.
- Replies in Messages: `messages.reply_to` (a trigger drops pointers outside the thread);
  the app only sends `reply_to` when set, so plain messages still work before the column
  exists. `renderThread()` builds the dock (reply bar, emoji panel, box), `fillThread()`
  the lines (bubble + reply button, `msgSwipe`, `msgQuote`); `msgUI.startReply` links them.
- The Program Hub is owner-only and not a public file: `.owner-only` / `html.is-owner` from
  `applyRoleUI()` plus `isOwner()` guards hide it; the file itself is in `owner_assets` (RLS:
  owner reads, no API writes; `node publish-hub.js` writes the upload SQL), downloaded by
  `hubSync()` into IndexedDB (`HUB_STORE`, test stand-in `window.__spotterPrivateStore`) so it
  opens offline, shown by `loadHubFrame()` as the iframe's `srcdoc` with `window.__hubParams`
  injected (the hub reads that when it has no URL query). `hubLocalClear()` deletes it on
  sign-out / non-owner, retried via `spotter.hubHeld`.
- Coach home (`viewHome`, `viewLifters`; the "Coach home" section): `openHome()` for `CLOUD.user && isCoach()`
  at launch, after a fresh sign-in (`goHomeAfterSync`) and from the sidebar's Home item and the
  Overview's Home button; `renderHome()` fills the three cards. `renderNotices()` draws into
  `#homeNotices` for coaches (the top `#noticeBar` is hidden for them) and into `#noticeBar` for
  everyone else. `inHome`/`inLifters` are set by `showView()`.
- Home is for everyone signed in (`hasHome()`); `renderHome()` branches on `isCoach()` (coach:
  Lifters / Inbox / Payments cards; lifter: Programs from `athleteNames()`, Messages, Payments
  read-only). Payments ("Payments" section): `PAY` (`spotter.payments.v1`), `payCanEdit()` = the
  coach who created the lifter (`lifterMeta.createdBy`) or a local-only lifter; `paySync()` after
  `troSync()` in `syncNow()`; table `lifter_payments` (RLS `private.made_lifter`). The month
  editor reuses the Trophies form dialog (`troOpenForm`). The list is the last twelve months plus
  any added one, minus `gone` entries (`lifter_payments.removed`, a flag rather than a delete so other
  devices learn of it); swipe-to-delete is `paySwipe`/`payDelete`, the + button `payAddMonth`.
- New lifters from the app: `openNewLifter()` (Lifters page) → `createLifter()` builds the profile,
  `addEmptyWeek`/`addEmptyDay`, opens Manage Program and calls `uploadLifter()` when signed in as a
  coach. Weight class: `cleanClass()`/`setClass()` in the Lifter & program card. Each Lifters-page row has a ⋯
  (`lifterMenu()`) for `deleteProgramFlow()` (clears to an empty Week 1; synced by the normal program/log diff)
  and `deleteLifterFlow()` (sets `lifters.deleted_at`; also behind Sharing's *Delete lifter for everyone*).
- Reactions ("Reactions" section): `REACT` (`spotter.reactions.v1`, by lifter id) keyed `lid|type|target|uid`
  (types `message`, `note`, `day`; targets the message id, the week, `week|day`); `reactBar()` draws the chips
  and button, `reactPick()` the eleven-emoji bubble (`REACT_SET`; the allowed keys are also a check constraint in schema.sql), `reactSet()` changes yours (removal = `emoji: null`),
  `reactSync()` after `paySync()`. Table `lifter_reactions`: messages need read access to the message
  (so private coach threads stay private); notes/days are coaches-only (`can_coach_live`). The notice
  kind `react` is made in `ntFromReaction()`.
- The floating Messages window ("Floating Messages window" section, `#chatDock`): `updateChatDock()` (called by
  `showView`) shows it for `chatEligible()` (a coach with a lifter they can message) on Overview/week. It renders
  with the same `renderMessages()`/`renderThread()` into `#chatBody` instead of `#msgBody` (the other is cleared,
  so each id exists once); `msgLive()` (= `inMessages || chatOpen()`) is what the refresh code checks, and
  `msgToBottom()` scrolls the window's own list. State (`min`/`open`/`max`) in `spotter.chatDock.v1`.
- Vid Review ("Vid Review" section; `viewVidReview`, `inVid`, nav item via `vidCanUse(name)`): `VID` (`spotter.vidreview.v1`: list of
  `{id, lid, by, lift, reps, set, size, dur, at, thumb}`), synced by `vidSync(api)` after `reactSync` (throttled to a minute unless
  `vidUI.dirty`/forced; the list without thumbnails, thumbnails only for ids not held; a video missing from the server is dropped).
  Files live in the private bucket `vid-review` as `<lifter id>/<video id>.mp4` (policies on `storage.objects` call
  `private.vid_can_see/add/delete`; table `lifter_videos`: the lifter and coaches add/read, only coaches delete). The cloud API gained
  `storageUpload/storageDownload/storageRemove`; `fetchChunked` takes an `orderBy`. The video itself: `VID_ENGINE` (`window.__spotterVideo`
  in tests) does `load(file)` and `transcode(job)` (WebCodecs H.264 368x654, crop + trim, no audio, played through with
  requestVideoFrameCallback and gap-filling seeks, like VBT's export); `vidMp4` is the MP4 writer. Videos watched are kept in IndexedDB
  (`vid:<id>`, index `vid:index`, flag `spotter.vidHeld`) and removed by `vidLocalClear()` wherever `vbtLocalClear()` runs. The owner's
  Home **Storage** card (`renderStorageCard`, RPC `owner_storage_usage`) is below Payments.
- In-app notices (the "In-app notices" section, `#noticeBar` at the top of `.content`):
  `NT` (`spotter.notices.v1`) holds `{id, kind, lifter, thread?, week?, who, text, at}`,
  made by `ntFromMessage`/`ntFromEvent` (in `pullMessages`), `ntFromWeekNote` (in
  `applyLogRow`) and `ntFromProgram` (in `applyLifterRow`, athletes only, diffing the
  old and new program for new weeks/days). `NT.base` flags make the first sync of each
  source silent. `renderNotices()` groups by kind + lifter (+ thread) and is redrawn
  from `setCloudStatus()`; reading clears them (`markRead`, `openTrophies`, `openWeek`).
  Reset with `MSG` on sign-out / account change. No database change.
- Trophies and strength levels (the "Trophies and strength levels" section of
  power-logs.html, before Theme): `troDefs()` is the catalogue (every trophy with its
  `test(model)`), `troModel()` the lifter's numbers (best of 1RM, confirmed PR, Epley
  from Done sets of <= 6 reps; standards from `TRO_STD` at the IPF class limit, GL
  points), `troCheck()` records what is newly true (silent on the first look,
  `init`), and only on the lifter's own device or a local-only lifter (`troCanRecord`):
  a coach reads what the lifter's device recorded. Trophies are never revoked; the class
  at the time is stored. `award:` ones are coach-only (database rule). The story image
  is a 1080x1920 canvas shared with `navigator.share({files})`, else saved with
  `saveFile`. Tables `lifter_trophies`, `lifter_prs`, `lifter_settings.sex/bodyweight`
  (RPC `set_trophy_profile`) and `lifter_events.kind = 'trophy'` (the `notify` function
  names the lifter, never the trophy); `TRO_CUR` cursors are in memory so each launch
  reads everything once, which is how a taken-back award reaches other devices. Keep
  `TRO_STD`'s tiers consistent with the README's description.
- Changing the database: edit `supabase/schema.sql` (keep it re-runnable), run
  `node test-cloudsql.js`, and have the user paste it into Supabase **before**
  deploying app code that needs it.

## Theming

CSS custom properties on `:root`, overridden under `html[data-theme="dark"]`
(`--ink`, `--bg`, `--surface`, `--border-strong`, etc. — see the top of each
file's `<style>` block). `applyTheme(t)` sets the `data-theme` attribute and
also updates the iOS status-bar tint meta and pushes the theme to all open
iframes (`pushThemeToEmbeds()`).

## Versioning / cache-busting — bump these when you change things

Four independent counters, all manual, no build tooling enforces them:

- `CACHE_VERSION` in [sw.js](sw.js) — bump when the **file list** changes
  (added/renamed files) or a pinned library version (Chart.js, supabase-js) changes. Bumping drops
  every old cache on next activation. Do **not** bump for ordinary HTML edits
  — those are served network-first already.
- `APP_VERSION` in power-logs.html (e.g. `1.30.0`) — cosmetic, shown in the
  About sheet (header ⓘ button) and at the foot of Manage Program so "is my
  deploy current?" is answerable at a glance. Bump the minor number for each
  release, the patch number for a fix to one.
- `HUB_BUILD` in power-logs.html (must match the `hub-N` string
  program-hub.html announces in its `spotter-hub-ready` message) — bump
  **both** whenever program-hub.html changes, then `node publish-hub.js` and run
  its SQL in Supabase (the file isn't deployed by git). power-logs.html flags a
  copy older than `HUB_BUILD` as out of date.
- `VBT_BUILD` in power-logs.html, same pattern for VBT.html (its `vbt-N` string; `node publish-vbt.js` then the SQL in Supabase).

## Testing

No test framework/runner — plain Node scripts that regex/DOM-inspect the
built HTML files directly:

```bash
npm install         # one-time: jsdom, and PGlite (in-memory Postgres) for the cloud tests
node test-boot.js       # PWA wiring smoke test (manifest, icons, saveFile routing, sw coverage)
node test-weekrange.js  # Program Hub week-range export parsing, across all builders
node test-genpop.js     # Meet Peak v2 Gen Pop: balance, loads, attempts, Clean, real import into power-logs.html
node test-taper.js      # Taper builder: each lifter type's last heavy days, light sessions, rest, volume cut, Clean, import
node test-lifterorder.js # Rearrange lifters: sheet, dropdown entry, persistence, reload, unload
node test-dmnotes.js    # Manage Program Notes: coach-only, editor, links, backups, Weekly notes regression
node test-reimport.js   # Re-imports keep training maxes; CSV still wins for 1-rep maxes
node test-trainingmax.js # Training maxes: 90% default, 100-80% buttons, typed numbers win, Hub + backups
node test-managelayout.js # Manage tab: section order + every action from its new place
node test-hubprefill.js # Hub builders prefilled from the loaded lifter (both pages)
node test-hubanalytics.js # Hub analytics charts + parity with Power Logs' Analytics view
node test-cloudsql.js   # supabase/schema.sql + selftest.sql on PGlite: the row-level security rules
node test-cloudsync.js  # accounts + sync end to end, several jsdom devices on one PGlite database
node test-messaging.js  # messages, finished sessions, new-week alerts, push (notify function run in-process)
node test-trophies.js   # Trophies: standards by IPF class, levels, clubs, streaks, PRs, awards, celebration, share image
node test-trophysync.js # Trophies across devices on the real rules, plus their notifications
node test-notices.js    # In-app notice banner: kinds, who wrote it, x, stacking
node test-hubprivate.js # The Program Hub's private copy: owner download, offline, sign-out delete
node test-vbtprivate.js # The Velocity Tracker's private copy: any signed-in account, offline, sign-out delete
node test-vidreview.js  # Vid Review: crop/cut, upload, 30 MB rule, watch, zoom, coach-only delete, sign-out, the MP4 writer, the owner's storage meter
node test-home.js       # Home: coach and lifter landing pages, cards, lifters list, Home buttons
node test-payments.js   # Payments: coach marks months paid, lifter read-only, real rules
node test-replies.js    # Messages: emoji picker and replies
node test-chatdock.js   # The floating Messages window for coaches
node test-reactions.js  # Reactions on messages, coach-only on notes and days
node test-vbt.js        # Velocity Tracker smoke test
```

`npm test` runs all twenty-six. The Program Hub's analytics (`renderHubAnalytics()`) is a
port of power-logs.html's Analytics view: keep `AN_LIFTS`/`AN_EXCLUDED` and the
tonnage/NL/top-set maths identical in both files, as test-hubanalytics.js checks.
Its tests stub `window.Chart` (needs `static defaults = { font: {} }` for power-logs). Tests that need Manage Program boot the page signed in as a coach:
`beforeParse(w) { installCoach(w); }` from test-cloudfake.js, which plugs a
stand-in into `window.__spotterCloud` (what `cloudApi()` uses instead of
supabase-js). test-cloudfake.js's `pgServer()` is the real-rules version: every
call runs as the signed-in user against supabase/schema.sql on PGlite. Any jsdom script that boots a page must end with
`process.exit()`: both pages leave intervals running, so node never exits on its own.

## Adding a Program Hub builder

Touch points, in file order: a `--color` var (both themes) + `.btn-*` class + view
title/checkbox accents; a `.gen-card` in `#view-hub`; the `#view-*` markup; the
generator + `*CSV()` writer (before the "shared preview engine" block); `CTX` and
`EMPTY_TXT` entries; `build*()`/`*Reset()`; the click bindings and the `*_FIELDS`
Enter-key list; a row in test-weekrange.js's `BUILDERS`; its max inputs in
`LIFTER_FIELDS` in the embed shim (name/block/class are found by their
`-name`/`-block`/`-class` id suffix), plus a `TM_PCT` entry if it applies its
own TM %; then bump `HUB_BUILD` and the `hub-N` string together.

- Power Logs only shows **`# ` lines** (hash + space) in its Program notes card;
  `#Note,...` lines, which several older builders write, are silently ignored. Write
  `# ` lines raw (not through `csvRow`), and never with user-typed text in them,
  because a quoted line no longer starts with `#` and the Hub's `splitCSV` drops it.
- Keep variation names out of the competition-lift charts: `AN_EXCLUDED` in
  power-logs.html matches by substring ("pause squat", "paused deadlift", "close
  grip", "larsen", ...). Anything else containing "squat"/"bench"/"deadlift" is
  counted as that lift, e.g. "Bulgarian split squat" would count as squat volume.

Run the relevant one after touching the corresponding file. There's no CI —
run these manually before calling a change done.

## Deploy

Static push to a GitHub Pages repo root (branch `main` / root), relative
paths throughout so it works unmodified from `username.github.io/repo-name/`.
See [README.md](README.md) for the full deploy/update ritual and the iOS
"Add to Home Screen" steps (Safari only — Chrome/Firefox on iOS can't
install a home-screen PWA).

## Conventions worth matching

- Plain ES5-leaning JS (`var`, `function` declarations, no modules/bundler,
  no framework), one giant IIFE per file (`(function () { "use strict"; ... })()`).
  Match this style rather than introducing `let`/`const`/classes/modules.
- `$(id)` / `el(tag, cls, txt)` / `clear(node)` are the DOM helpers used
  everywhere in power-logs.html instead of a framework.
- `safeRead`/`safeWrite` wrap every localStorage access in try/catch (private
  browsing / storage-blocked contexts must degrade, not throw).
- Comments explain *why*, not *what* — this codebase already follows that
  style; keep matching it in new code.
