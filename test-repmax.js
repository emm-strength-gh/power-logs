/* Week status (Incomplete / Completed, coaches only) and the Rep maxes page: the heaviest Done set of 1 to 8 reps on
 * squat, bench and deadlift, from weeks marked Completed, kept per signed-in lifter (so a deleted program's records
 * stay). Run: node test-repmax.js
 *
 * Like test-programs.js: each device is its own jsdom copy of app.html on one in-memory Postgres with
 * supabase/schema.sql (real row-level security).
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
const TOM_PREP = csv("Tom", "Prep", [[1, 1, "Deadlift", 200, 3, 3, 8, ""], [1, 1, "Pause squat", 150, 3, 3, 7, ""], [1, 2, "Squat", 160, 4, 4, 7, ""]]);
const TOM_PEAK = csv("Tom", "Peak", [[1, 1, "Squat", 190, 2, 2, 8, ""], [1, 1, "Bench", 130, 3, 3, 8, ""], [1, 1, "Deadlift", 190, 1, 3, 8, ""], [1, 1, "Deadlift", 205, 1, 3, 9, ""]]);

(async () => {
  const server = await pgServer();

  function boot(label) {
    const dev = server.device(label);
    const errors = [];
    const dom = new JSDOM(html, {
      runScripts: "dangerously", pretendToBeVisual: true,
      url: "https://example.github.io/power-logs/app.html",
      virtualConsole: new VirtualConsole().on("jsdomError", e => errors.push(e.message)).on("error", m => errors.push(String(m))),
      beforeParse(w) {
        w.__spotterCloud = dev;
        w.Chart = class { static defaults = { font: {} }; constructor() {} destroy() {} };
      },
    });
    const w = dom.window, doc = w.document, $ = id => doc.getElementById(id);
    w.Element.prototype.scrollIntoView = function () {};
    w.scrollTo = function () {};
    const app = {
      label, dev, w, doc, $,
      real: () => errors.filter(e => !/Not implemented|HTMLCanvasElement|getContext|Chart is not defined/i.test(e)),
      store: k => JSON.parse(w.localStorage.getItem(k) || "null"),
      active: () => (doc.querySelector(".view.active") || {}).id,
      nav(l) { const b = [...doc.querySelectorAll("#sideNav .nav-item")].find(n => (n.querySelector(".nav-label") || {}).textContent === l); if (b) b.click(); return !!b; },
      pick(name) { $("lifterSelect").value = name; $("lifterSelect").dispatchEvent(new w.Event("change")); },
      btn: (text, root) => [...(root || doc).querySelectorAll("button")].find(b => b.textContent.trim() === text),
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
      keyOf: block => { const p = app.store("spotter.profiles.v1"); return Object.keys(p).find(k => p[k].block === block); },
      // tick the sets whose text matches, on week 1 (day cards start locked)
      async tick(block, re) {
        app.pick(app.keyOf(block)); await tick(100);
        app.nav("Week 1"); await tick(150);
        let q; while ((q = $("wkList").querySelector(".day-lock:not(.open)"))) q.click();
        [...$("wkList").querySelectorAll("li")].filter(li => re.test(li.textContent)).forEach(li => li.click());
        await tick(100);
      },
      cell: (lift, reps) => $("rmGrid") && $("rmGrid").querySelector(`td[data-lift="${lift}"][data-reps="${reps}"]`),
      kg: (lift, reps) => { const c = app.cell(lift, reps); return c && c.querySelector(".rm-kg") ? c.querySelector(".rm-kg").textContent : null; },
    };
    return app;
  }
  const rows = (sql, args) => server.sql(sql, args);

  console.log("Set-up: the owner coaches Tom on two programs (Prep, Peak); Tom signs in");
  const O = boot("owner");
  await tick(250);
  await O.load(TOM_PREP, "tom-prep.csv"); await O.load(TOM_PEAK, "tom-peak.csv");
  await O.signIn(OWNER_EMAIL);
  O.$("confirmYes").click();
  await until(async () => (await rows("select count(*)::int n from public.lifters"))[0].n === 2);
  await O.settle();
  await rows("update public.lifters set lifter_email = 'tom@test.invalid' where name = 'Tom'");
  O.sync(); await O.settle();
  const T = boot("tom");
  await tick(250);
  await T.signIn("tom@test.invalid");
  T.sync(); await T.settle();

  console.log("\nWeek status");
  O.pick(O.keyOf("Prep")); await tick(100);
  O.nav("Current Program"); await tick(150);
  const pill = () => O.$("ovWeeks").querySelector(".wk-st");
  check("a coach sees each week as Incomplete to start", !!pill() && pill().textContent === "Incomplete");
  T.pick(T.keyOf("Prep")); await tick(100);
  T.nav("Current Program"); await tick(150);
  check("the lifter sees no week status", !!T.$("ovWeeks").querySelector(".week-card") && !T.$("ovWeeks").querySelector(".wk-st"));
  pill().click(); await tick(100);
  check("tapping it marks the week Completed, and it is saved on the program", pill().textContent === "Completed" &&
    await until(async () => (await rows("select program->'weeks'->0->>'status' as s from public.lifters where program->>'block' = 'Prep'"))[0].s === "completed"));
  check("...without opening the week", O.active() === "viewOverview");
  pill().click(); await tick(100);
  check("...and again marks it Incomplete", pill().textContent === "Incomplete" &&
    await until(async () => (await rows("select program->'weeks'->0->>'status' as s from public.lifters where program->>'block' = 'Prep'"))[0].s === null));
  O.nav("Week 1"); await tick(150);
  check("the week page shows it beside the heading", !!O.$("wkHead").querySelector(".wk-st"));
  O.nav("Manage program"); await tick(150);
  check("...and so does Manage Program, under the Week and Day", !!O.$("dmWeekStatus") && /Incomplete/.test(O.$("dmWeekStatus").textContent));

  console.log("\nRep maxes");
  await T.tick("Prep", /Deadlift|Pause squat/);
  T.sync(); await T.settle();
  await until(async () => (await rows("select count(*)::int n from public.lifter_marks where state = 'done'"))[0].n === 2);
  O.sync(); await O.settle();
  O.pick(O.keyOf("Prep")); await tick(100);
  O.nav("Manage program"); await tick(150);
  check("Manage Program has a Rep maxes button", !!O.$("dmRepMaxBtn"));
  O.$("dmRepMaxBtn").click(); await tick(100);
  check("it opens the Rep maxes page: 1RM to 8RM for Squat, Bench and Deadlift", O.active() === "viewRepMax" && O.$("rmGrid").querySelectorAll("tbody tr").length === 8 &&
    [...O.$("rmGrid").querySelectorAll("th")].map(t => t.textContent).join() === "Reps,Squat,Bench,Deadlift");
  await tick(500);
  check("a Done set in a week not yet Completed doesn't count", O.kg("deadlift", 3) === null);
  O.$("rmBack").click(); await tick(100);
  check("Back returns to Manage Program", O.active() === "viewDayMgr");
  O.$("dmWeekStatus").querySelector(".wk-st").click(); await tick(100);
  O.sync(); await O.settle();
  O.$("dmRepMaxBtn").click();
  check("once Week 1 is Completed, its Done deadlift is the 3RM", await until(() => O.kg("deadlift", 3) === "200"), O.kg("deadlift", 3));
  check("...with the date it was ticked", /\d{4}/.test(O.cell("deadlift", 3).querySelector(".rm-when").textContent));
  check("variations (pause squat) and sets not Done (the 4x4 squat) don't count", O.kg("squat", 3) === null && O.kg("squat", 4) === null);
  check("...and it is kept for Tom's sign-in, not the program", (await rows("select count(*)::int n from public.lifter_rep_maxes r join auth.users u on u.id = r.user_id where u.email = 'tom@test.invalid'"))[0].n === 1);

  console.log("\nAnother program of the same lifter");
  await T.tick("Peak", /Squat|Deadlift: 190/);
  T.sync(); await T.settle();
  O.sync(); await O.settle();
  O.pick(O.keyOf("Peak")); await tick(100);
  O.nav("Current Program"); await tick(150);
  pill().click(); await tick(100);
  O.sync(); await O.settle();
  O.nav("Manage program"); await tick(150);
  O.$("dmRepMaxBtn").click();
  check("Peak's Done squat adds a 2RM", await until(() => O.kg("squat", 2) === "190"), O.kg("squat", 2));
  check("Peak's lighter 3-rep deadlift leaves the 200 kg 3RM alone", O.kg("deadlift", 3) === "200");
  check("the bench, not ticked, has no record", O.kg("bench", 3) === null);

  console.log("\nA heavier set replaces it");
  await T.tick("Peak", /Deadlift: 205/);   // ticked after the week was Completed
  T.sync(); await T.settle();
  O.sync(); await O.settle();
  O.$("rmBack").click(); await tick(100);
  O.$("dmRepMaxBtn").click();
  check("a 205 kg 3-rep deadlift ticked later in that Completed week is the new 3RM", await until(() => O.kg("deadlift", 3) === "205"), O.kg("deadlift", 3));

  console.log("\nA deleted program");
  await rows("update public.lifters set deleted_at = now() where program->>'block' = 'Peak'");
  O.sync(); await O.settle();
  O.pick(O.keyOf("Prep")); await tick(100);
  O.nav("Manage program"); await tick(150);
  O.$("dmRepMaxBtn").click();
  check("the records made from it stay", await until(() => O.kg("squat", 2) === "190" && O.kg("deadlift", 3) === "205"), O.kg("squat", 2) + " " + O.kg("deadlift", 3));

  check("no script errors", [O, T].every(a => a.real().length === 0), [O, T].map(a => a.real().join(" | ")).join(" // "));
  console.log(`\n${checks} checks · ${failures === 0 ? "ALL PASSED" : failures + " FAILED"}\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
