/* Lifter IDs: every program has an ID of its own, so two lifters can share a name and loading a file never replaces
 * another program with the same name. One sign-in can have several programs. Run: node test-lifterids.js
 *
 * Like test-cloudsync.js: each device is its own jsdom copy of app.html; the cloud parts run on one in-memory Postgres
 * with supabase/schema.sql (real row-level security).
 */
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");
const { pgServer, OWNER_EMAIL, GOOD_CODE } = require("./test-cloudfake");

const html = fs.readFileSync(path.join(__dirname, "app.html"), "utf8");
let failures = 0, checks = 0;
const check = (name, cond, extra = "") => {
  checks++;
  if (!cond) failures++;
  console.log(`${cond ? "  ok  " : " FAIL "} ${name}${extra && !cond ? " — " + extra : ""}`);
};
const tick = (ms = 50) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return true; } catch (e) {} await tick(50); }
  return false;
}
const csv = (name, block, rows) => `#Name,${name}\r\n#Block,${block}\r\nWeek,Day,Exercise,Weight (kg),Sets,Reps,RPE,Notes\r\n` +
  rows.map(r => r.join(",")).join("\r\n") + "\r\n";
const TOM_PREP = csv("Tom", "Prep", [[1, 1, "Deadlift", 200, 3, 3, 8, ""], [1, 2, "Squat", 160, 4, 4, 7, ""]]);
const TOM_PEAK = csv("Tom", "Peak", [[1, 1, "Squat", 190, 2, 2, 8, ""], [1, 2, "Bench", 130, 3, 3, 8, ""], [2, 1, "Squat", 195, 1, 2, 9, ""]]);
const TOM_OTHER = csv("Tom", "Other", [[1, 1, "Bench", 100, 3, 8, 7, ""]]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

(async () => {
  const server = await pgServer();

  function boot(label, store) {
    const dev = server.device(label), errors = [];
    const dom = new JSDOM(html, {
      runScripts: "dangerously", pretendToBeVisual: true,
      url: "https://example.github.io/power-logs/app.html",
      virtualConsole: new VirtualConsole().on("jsdomError", e => errors.push(e.message)).on("error", m => errors.push(String(m))),
      beforeParse(w) {
        w.__spotterCloud = dev;
        for (const k of Object.keys(store || {})) w.localStorage.setItem(k, store[k]);
      },
    });
    const w = dom.window, doc = w.document, $ = id => doc.getElementById(id);
    w.Element.prototype.scrollIntoView = function () {};
    w.scrollTo = function () {};
    const app = {
      label, dev, w, doc, $,
      real: () => errors.filter(e => !/Not implemented|HTMLCanvasElement|getContext|Chart is not defined/i.test(e)),
      store: k => JSON.parse(w.localStorage.getItem(k) || "null"),
      raw: k => w.localStorage.getItem(k),
      names: () => $("lifterPicker").style.display === "none" ? [] :
        [...$("lifterSelect").options].map(o => o.value).filter(v => !/^__/.test(v)),
      nav(l) { const b = [...doc.querySelectorAll("#sideNav .nav-item")].find(n => (n.querySelector(".nav-label") || {}).textContent === l); if (b) b.click(); return !!b; },
      pick(name) { $("lifterSelect").value = name; $("lifterSelect").dispatchEvent(new w.Event("change")); },
      btn: (text, root) => [...(root || doc).querySelectorAll("button")].find(b => b.textContent.trim() === text),
      rows: () => [...$("wkList").querySelectorAll("li")],
      async load(text, fname) { const i = $("fileInput"); Object.defineProperty(i, "files", { value: [new w.File([text], fname)], configurable: true }); i.dispatchEvent(new w.Event("change")); await tick(300); },
      sync() { w.dispatchEvent(new w.Event("online")); },
      async settle() { await tick(900); await until(() => !/busy/.test($("acctDot").className), 8000); await tick(50); },
      async signIn(email) {
        $("acctBtn").click(); await tick();
        $("acctEmail").value = email;
        app.btn("Email me a code", $("acctBody")).click();
        await until(() => $("acctCode"));
        $("acctCode").value = GOOD_CODE;
        app.btn("Sign in", $("acctBody")).click();
        await until(() => $("acctTitle").textContent === "Account");
        await app.settle();
        $("acctClose").click(); await tick(100);
      },
      toast: () => $("toastMsg").textContent,
    };
    return app;
  }
  const rows = (sql, args) => server.sql(sql, args);
  const lifters = () => rows("select id, name, lifter_email, lifter_user_id, deleted_at, program from public.lifters where deleted_at is null order by created_at");

  /* ------------------------------------------------------------ loading files, signed out */
  console.log("A file never replaces a program with the same name");
  const D = boot("device");
  await tick(250);
  await D.load(TOM_PREP, "tom-prep.csv");
  check("the first Tom loads", D.names().join() === "Tom");
  D.nav("Week 1"); await tick();
  D.rows()[0].click();
  const doneBefore = JSON.stringify(D.store("spotter.done.v1").Tom), tomBefore = JSON.stringify(D.store("spotter.profiles.v1").Tom);
  check("...and gets a tick", Object.keys(D.store("spotter.done.v1").Tom || {}).length === 1);
  await D.load(TOM_PEAK, "tom-peak.csv");
  check("a second file called Tom is a separate lifter, kept apart as Tom (2)", D.names().join() === "Tom,Tom (2)", D.names().join());
  const prof = () => D.store("spotter.profiles.v1");
  check("the first Tom is untouched: same program, block and tick", JSON.stringify(prof().Tom) === tomBefore && prof().Tom.block === "Prep" && JSON.stringify(D.store("spotter.done.v1").Tom) === doneBefore);
  check("the new one is the Peak program with no ticks", prof()["Tom (2)"].block === "Peak" && prof()["Tom (2)"].weeks.length === 2 && !Object.keys(D.store("spotter.done.v1")["Tom (2)"] || {}).length);
  check("it says so", /Tom was already here, so this is a separate lifter/.test(D.toast()), D.toast());
  check("the new lifter is the one on screen", D.$("lifterSelect").value === "Tom (2)", D.$("lifterSelect").value);
  check("every program has a lifter ID of its own", UUID.test(prof().Tom.lid) && UUID.test(prof()["Tom (2)"].lid) && prof().Tom.lid !== prof()["Tom (2)"].lid);
  await D.load(TOM_PEAK, "tom-peak.csv");
  check("loading the same file again adds a third, never overwriting", D.names().join() === "Tom,Tom (2),Tom (3)" && new Set(Object.values(prof()).map(p => p.lid)).size === 3, D.names().join());
  check("...and the first two are still as they were", JSON.stringify(prof().Tom) === tomBefore && prof()["Tom (2)"].block === "Peak");

  console.log("\nA JSON export is a new lifter too");
  const exportJson = JSON.stringify({ profile: prof().Tom, done: D.store("spotter.done.v1").Tom, skip: {}, notes: {}, custom: [], weekNotes: {} });
  const oldLid = prof().Tom.lid;
  await D.load(exportJson, "tom-backup.json");
  check("restoring a backup of Tom adds Tom (4)", D.names().join() === "Tom,Tom (2),Tom (3),Tom (4)", D.names().join());
  check("...with a new lifter ID, not the exported one", UUID.test(prof()["Tom (4)"].lid) && prof()["Tom (4)"].lid !== oldLid && !prof()["Tom (4)"].cloudId);
  check("...keeping the ticks the backup held, under the new lifter only", Object.keys(D.store("spotter.done.v1")["Tom (4)"] || {}).length === 1 && Object.keys(D.store("spotter.done.v1").Tom).length === 1);
  check("no script errors", D.real().length === 0, D.real().join(" | "));

  console.log("\nPrograms from before lifter IDs get one");
  const legacy = JSON.parse(D.raw("spotter.profiles.v1")); delete legacy.Tom.lid; delete legacy["Tom (2)"].lid;
  const L = boot("legacy", { "spotter.profiles.v1": JSON.stringify(legacy), "spotter.done.v1": D.raw("spotter.done.v1") });
  await tick(300);
  check("on the next start every program has one, a different one each", UUID.test(L.store("spotter.profiles.v1").Tom.lid) && UUID.test(L.store("spotter.profiles.v1")["Tom (2)"].lid) && L.store("spotter.profiles.v1").Tom.lid !== L.store("spotter.profiles.v1")["Tom (2)"].lid);
  check("...and the one that already had one keeps it", L.store("spotter.profiles.v1")["Tom (3)"].lid === prof()["Tom (3)"].lid);

  /* ------------------------------------------------------------ the cloud */
  console.log("\nThe cloud: two Toms uploaded, the lifter ID is their ID");
  const O = boot("owner");
  await tick(250);
  await O.load(TOM_PREP, "tom-prep.csv");
  await O.load(TOM_PEAK, "tom-peak.csv");
  await O.signIn(OWNER_EMAIL);
  O.$("confirmYes").click();
  check("both are uploaded", await until(async () => (await lifters()).length === 2));
  await O.settle();
  const mine = O.store("spotter.profiles.v1"), srv = await lifters();
  check("the server's ids are the lifter IDs made on the device", srv.every(r => Object.values(mine).some(p => p.lid === r.id && p.cloudId === r.id)), JSON.stringify(srv.map(r => r.id)));
  check("two lifters, same first name, different programs", srv.length === 2 && new Set(srv.map(r => r.program.block)).size === 2);
  check("the lifter ID is not part of the stored program", srv.every(r => !("lid" in r.program) && !("cloudId" in r.program)));
  const idPrep = (await lifters()).find(r => r.program.block === "Prep").id, idPeak = (await lifters()).find(r => r.program.block === "Peak").id;
  O.nav("Manage program"); await tick(150);
  check("Manage Program shows the lifter's ID", new RegExp("Lifter ID: " + (O.store("spotter.profiles.v1")[O.$("lifterSelect").value].lid)).test(O.$("viewDayMgr").textContent));

  console.log("\nOne sign-in, two programs");
  await rows("update public.lifters set lifter_email = 'tom@test.invalid'");
  const T = boot("tom");
  await tick(250);
  await T.signIn("tom@test.invalid");
  T.sync(); await T.settle();
  const tomUser = (await rows("select user_id from public.accounts where email = 'tom@test.invalid'"))[0].user_id;
  check("...and the database links both rows to that account", (await lifters()).every(r => r.lifter_user_id === tomUser));
  check("he sees both programs, whatever their names", T.names().length === 2, T.names().join());
  const tp = T.store("spotter.profiles.v1");
  check("each one is its own program with its own ID", new Set(Object.values(tp).map(p => p.block)).size === 2 && new Set(Object.values(tp).map(p => p.lid)).size === 2 && Object.values(tp).every(p => UUID.test(p.lid) && p.lid === p.cloudId));
  const keyPrep = Object.keys(tp).find(k => tp[k].block === "Prep");
  T.pick(keyPrep); await tick(100);
  T.nav("Week 1"); await tick(100);
  T.rows()[0].click();
  check("a tick goes to the right program only", await until(async () => (await rows("select count(*)::int n from public.lifter_marks where lifter_id = $1", [idPrep]))[0].n === 1)
    && (await rows("select count(*)::int n from public.lifter_marks where lifter_id = $1", [idPeak]))[0].n === 0);
  O.sync(); await O.settle();
  const od = O.store("spotter.done.v1"), keyOf = id => Object.keys(O.store("spotter.profiles.v1")).find(k => O.store("spotter.profiles.v1")[k].cloudId === id);
  check("...and the coach sees it on the same one", Object.keys(od[keyOf(idPrep)] || {}).length === 1 && !Object.keys(od[keyOf(idPeak)] || {}).length);
  check("no script errors", T.real().length === 0 && O.real().length === 0, T.real().concat(O.real()).join(" | "));

  console.log("\nNew lifters by hand get the same treatment");
  O.nav("Lifters"); await tick(100);
  O.$("addLifterBtn").click(); await tick(100);
  O.$("nlName").value = "Tom";
  O.btn("Create", O.$("troFormScrim")).click(); await tick(300);
  const created = O.store("spotter.profiles.v1");
  check("a name that is taken is accepted: the new lifter is Tom (3), not a refusal", Object.keys(created).includes("Tom (3)") && /Tom added \(there was already a Tom\)/.test(O.toast()), Object.keys(created).join() + " / " + O.toast());
  check("...with an ID that becomes its cloud ID", await until(async () => (await lifters()).length === 3) && (await lifters()).some(r => r.id === created["Tom (3)"].lid));

  console.log("\nSigning in on a device that has its own Tom");
  const P = boot("laptop");
  await tick(250);
  await P.load(TOM_OTHER, "tom-other.csv");
  await P.signIn(OWNER_EMAIL);
  P.sync(); await P.settle();
  const pp = P.store("spotter.profiles.v1");
  check("the device's own Tom, a different program, is kept as it was", Object.values(pp).some(p => p.block === "Other" && !p.cloudId), Object.values(pp).map(p => p.name + "/" + p.block + "/" + (p.cloudId ? "cloud" : "local")).join());
  check("the three in the account arrive beside it: four lifters in all", Object.keys(pp).length === 4, Object.keys(pp).join());
  const Q = boot("desktop");
  await tick(250);
  await Q.load(TOM_PREP, "tom-prep.csv");
  await Q.signIn(OWNER_EMAIL);
  Q.sync(); await Q.settle();
  check("a device whose Tom is the very same program as the account's Tom joins it instead of duplicating it", Object.keys(Q.store("spotter.profiles.v1")).length === 3, Object.keys(Q.store("spotter.profiles.v1")).join());
  check("no script errors", P.real().length === 0 && Q.real().length === 0, P.real().concat(Q.real()).join(" | "));

  console.log(`\n${checks} checks · ${failures ? failures + " FAILED" : "ALL PASSED"}`);
  process.exit(failures ? 1 : 0);
})();
