# EmmStrength Spotter (Power Logs App)

An installable iPhone/desktop PWA for powerlifting training logs. No build step,
no framework, no backend — four self-contained HTML files with inline
`<script>`/`<style>`, deployed as static files to GitHub Pages and installed to
the iOS home screen via Safari. All data lives in `localStorage` on-device;
nothing syncs anywhere. This folder is a git repo tracking
`origin/main` (https://github.com/emm-strength-gh/power-logs), kept
byte-for-byte identical to it — deploy by committing the files you changed and
`git push origin main`. `node_modules/` and `test-assets/` (a personal video)
are gitignored and must never be published: the repo is public.

Full user-facing/deploy documentation is in [README.md](README.md) — read that
too, it covers iOS PWA quirks, the update/versioning ritual, and known rough
edges in more depth than this file.

## The four apps

| File | Role | Standalone? |
|---|---|---|
| [power-logs.html](power-logs.html) | **The main app** ("Spotter"). Lifter profiles, weekly program view, done/skip tracking, notes, custom items, Manage Program (day/week editing, PIN-gated), Analytics, Compare, plate calculator, rest timer, warm-up calculator, JSON/CSV import-export. Hosts the other three apps in iframes. | Yes — this is the PWA entry point (`start_url`). |
| [program-hub.html](program-hub.html) | Program **builders**: Meet Peak v2 Gen Pop (balanced 16-week peak, first card), Gustav, Wendler, equipped lifting, single-lift (squat/bench/deadlift), combined, Lilliebridge, KSB, CVBT, MDL, fatigue-managed, etc. Generates a CSV program. | Yes, and also opens inside Spotter as the **Program Hub** tab in Manage Program. |
| [VBT.html](VBT.html) | **Velocity Tracker**. Loads a video clip, tracks the barbell path frame-by-frame, computes bar speed/RPE per rep, detects stalls/grinds, exports an annotated MP4 (custom `mp4Mux` muxer + WebCodecs) or CSV. | Yes, and opens inside Spotter from the **Velocity Tracker** nav button. |
| [rpe-estimator.html](rpe-estimator.html) | RPE ↔ %1RM load-chart tool (Chart.js). | Yes, and opens inside Spotter (RPE Estimator in the sidebar). |

Supporting files: [manifest.webmanifest](manifest.webmanifest) (PWA metadata),
[sw.js](sw.js) (service worker — see caching strategy below),
[index.html](index.html) (redirect shim to `power-logs.html`),
[icons/](icons/) (+ [make_icons.py](make_icons.py) to regenerate them from
`icons/_source.png`).

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

## Data model (power-logs.html)

Everything lives in `localStorage` under versioned keys (`STORE_*` near the
top of the `<script>` in power-logs.html, e.g. `spotter.profiles.v1`). Bump
the `.vN` suffix if you ever change a stored shape incompatibly.

- `PROFILES`: `name -> { name, block, classWt, maxes:{}, weeks:[{week, days:[{day, rows:[...]}]}] }`
  — one profile per lifter, built by `buildProfile()` from an imported
  `#Name`-header CSV or a Spotter JSON export.
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
  `ingestJSON()` keeps the device's copy when an older export lacks it. The CSV
  stays the source of truth for everything it does carry (rows, `#Block`, `#Max`).
- `ORDER` (`spotter.lifterOrder.v1`): lifter names in the user's arranged
  dropdown order. Always enumerate lifters through `lifterNames()`, never
  `Object.keys(PROFILES)`: it applies this order and appends anything loaded
  since. It's a separate list because JS forces all-digit object keys first.
- Plus small scalars: last-selected lifter, theme, tools prefs (plate bar
  weight/collar mode, rest-timer duration/alert pref), Day-Manager
  add-panel-open state.

Manage Program's day/week editing (PIN-gated via `DM_PIN_HASH`, a SHA-256 of
the PIN implemented inline as `sha256()`) keeps a **donor** program in memory
only — imported from a file or received from the Program Hub — and never
writes it to `PROFILES`/localStorage until the user explicitly
Replaces/Merges a day or week. A 5-deep undo stack (`dmUndoStack`) backs
row/day/week deletes and edits there; drag-to-reorder deliberately isn't
undoable.

## Theming

CSS custom properties on `:root`, overridden under `html[data-theme="dark"]`
(`--ink`, `--bg`, `--surface`, `--border-strong`, etc. — see the top of each
file's `<style>` block). `applyTheme(t)` sets the `data-theme` attribute and
also updates the iOS status-bar tint meta and pushes the theme to all open
iframes (`pushThemeToEmbeds()`).

## Versioning / cache-busting — bump these when you change things

Four independent counters, all manual, no build tooling enforces them:

- `CACHE_VERSION` in [sw.js](sw.js) — bump when the **file list** changes
  (added/renamed files) or the pinned Chart.js version changes. Bumping drops
  every old cache on next activation. Do **not** bump for ordinary HTML edits
  — those are served network-first already.
- `APP_BUILD` in power-logs.html — cosmetic, shown in Manage Program so
  "is my deploy current?" is answerable at a glance.
- `HUB_BUILD` in power-logs.html (must match the `hub-N` string
  program-hub.html announces in its `spotter-hub-ready` message) — bump
  **both** whenever program-hub.html changes; this busts the iframe's HTTP
  cache via a `?v=N` query param and lets power-logs.html detect a stale
  deployed hub file.
- `VBT_BUILD` in power-logs.html, same pattern for VBT.html.

## Testing

No test framework/runner — plain Node scripts that regex/DOM-inspect the
built HTML files directly:

```bash
npm install jsdom   # one-time, only needed for test-boot.js
node test-boot.js       # PWA wiring smoke test (manifest, icons, saveFile routing, sw coverage)
node test-weekrange.js  # Program Hub week-range export parsing, across all builders
node test-genpop.js     # Meet Peak v2 Gen Pop: balance, loads, attempts, Clean, real import into power-logs.html
node test-lifterorder.js # Rearrange lifters: sheet, dropdown entry, persistence, reload, unload
node test-dmnotes.js    # Manage Program Notes: PIN-only, editor, links, backups, Weekly notes regression
node test-reimport.js   # Re-imports keep training maxes; CSV still wins for 1-rep maxes
node test-managelayout.js # Manage tab: section order + every action from its new place
node test-vbt.js        # Velocity Tracker smoke test
```

`npm test` runs all eight. Tests that need Manage Program (PIN-gated) swap
`DM_PIN_HASH` in their in-memory copy of the page for `sha256(DM_PIN_SALT +
"24682468")`, so the real PIN is never needed (see test-dmnotes.js). Any jsdom script that boots a page must end with
`process.exit()`: both pages leave intervals running, so node never exits on its own.

## Adding a Program Hub builder

Touch points, in file order: a `--color` var (both themes) + `.btn-*` class + view
title/checkbox accents; a `.gen-card` in `#view-hub`; the `#view-*` markup; the
generator + `*CSV()` writer (before the "shared preview engine" block); `CTX` and
`EMPTY_TXT` entries; `build*()`/`*Reset()`; the click bindings and the `*_FIELDS`
Enter-key list; a row in test-weekrange.js's `BUILDERS`; then bump `HUB_BUILD` and the
`hub-N` string together.

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
