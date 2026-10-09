/* A coach decides what a lifter sees: Manage Program > Lifter access hides parts of Analytics (or the page) and the
 * Velocity Tracker / RPE Calculator from the lifter, and the lifter's own device follows. Run: node test-lifteraccess.js
 *
 * Like test-trophysync.js: each device is its own jsdom copy of app.html on one in-memory Postgres running
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
const TOM = "#Name,Tom\r\n#Block,Prep\r\n#Bodyweight,82\r\n#Max,Squat,172.5\r\n#Max,Bench,127.5\r\n#Max,Deadlift,202.5\r\n" +
  "Week,Day,Exercise,Weight (kg),Sets,Reps,RPE,Notes\r\n1,1,Squat,160,4,4,7,\r\n1,1,Bench,110,4,5,7,\r\n1,2,Deadlift,200,3,3,8,\r\n2,1,Squat,165,4,4,7.5,\r\n";

(async () => {
  const server = await pgServer();

  function boot(label) {
    const dev = server.device(label), errors = [];
    const dom = new JSDOM(html, {
      runScripts: "dangerously", pretendToBeVisual: true,
      url: "https://example.github.io/power-logs/app.html",
      virtualConsole: new VirtualConsole().on("jsdomError", e => errors.push(e.message)).on("error", m => errors.push(String(m))),
      beforeParse(w) { w.__spotterCloud = dev; },
    });
    const w = dom.window, doc = w.document, $ = id => doc.getElementById(id);
    w.Element.prototype.scrollIntoView = function () {};
    w.scrollTo = function () {};
    const app = {
      label, dev, w, doc, $,
      real: () => errors.filter(e => !/Not implemented|HTMLCanvasElement|getContext|Chart is not defined/i.test(e)),
      navs: () => [...doc.querySelectorAll("#sideNav .nav-label")].map(n => n.textContent),
      nav(l) { const b = [...doc.querySelectorAll("#sideNav .nav-item")].find(n => n.querySelector(".nav-label").textContent === l); if (b) b.click(); return !!b; },
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
      },
      closeSheet() { $("acctClose").click(); },
      shown: id => !$(id).classList.contains("an-off"),
      sw: part => $("dmAccess").querySelector(`input[data-part="${part}"]`),
      // flip a switch in the dialog and wait for the database to hold it
      async flip(part, on) {
        await until(() => app.sw(part) && !app.sw(part).disabled);
        app.sw(part).checked = on; app.sw(part).dispatchEvent(new w.Event("change"));
        await until(() => app.sw(part) && !app.sw(part).disabled);
      },
    };
    return app;
  }
  const rows = (sql, args) => server.sql(sql, args);
  const dbRow = async () => (await rows("select analytics_off, tools_off from public.lifter_settings"))[0];

  /* ------------------------------------------------------------ set-up */
  console.log("Set-up: the owner coaches Tom, who signs in");
  const C = boot("coach");
  await tick(200);
  await C.load(TOM, "tom.csv");
  await C.signIn(OWNER_EMAIL);
  C.closeSheet(); await tick(100);
  C.$("confirmYes").click();
  await until(async () => (await rows("select count(*)::int n from public.lifters"))[0].n === 1);
  await C.settle();
  C.nav("Manage program"); await tick(100);
  C.$("dmShareBtn").click(); await tick(50);
  const em = C.$("dmShare").querySelector('input[type="email"]');
  em.value = "tom@test.invalid"; em.dispatchEvent(new C.w.Event("blur"));
  await until(async () => (await rows("select lifter_email from public.lifters"))[0].lifter_email === "tom@test.invalid");
  await C.settle();
  C.$("shareClose").click();
  const L = boot("lifter");
  await tick(200);
  await L.signIn("tom@test.invalid");
  L.closeSheet(); await tick(100);
  C.sync(); await C.settle();

  /* ------------------------------------------------------------ the defaults */
  console.log("A new lifter starts with everything hidden except the RPE Calculator");
  const row0 = (await rows("select analytics_off, tools_off from public.lifter_settings"))[0];
  check("the database started it with the Analytics page, its parts and the Velocity Tracker off", ["all", "maxes", "tonnage", "nl", "top"].every(k => row0.analytics_off.includes(k)) && row0.tools_off.join() === "vbt", JSON.stringify(row0));
  L.sync(); await L.settle();
  check("on Tom's device: no Lifter's Analytics, no Velocity Tracker, the RPE Calculator is there", !L.navs().includes("Lifter’s Analytics") && !L.navs().includes("Velocity Tracker") && L.navs().includes("RPE Calculator"), L.navs().join());
  await rows("update public.lifter_settings set analytics_off = '{}', tools_off = '{}'");   // the rest of this file starts from everything on
  L.sync(); await L.settle(); C.sync(); await C.settle();

  /* ------------------------------------------------------------ the rename */
  console.log("\nThe Overview is the Current Program now");
  check("Tom's first menu item says Current Program", L.navs().includes("Current Program") && !L.navs().includes("Overview"), L.navs().join());
  check("...and so do the back buttons", [...L.doc.querySelectorAll(".wk-back")].every(b => !/Overview/.test(b.textContent)));

  /* ------------------------------------------------------------ everything on, to start */
  console.log("\nBy default Tom sees everything");
  L.nav("Current Program"); await tick(100);
  check("Analytics, the Velocity Tracker and the RPE Calculator are in his menu, and Analytics has a button on the Current Program page",
    ["Lifter’s Analytics", "RPE Calculator", "Velocity Tracker"].every(n => L.navs().includes(n)) && L.shown("ovAnalyticsBtn"), L.navs().join());
  L.nav("Lifter’s Analytics"); await tick(100);
  check("every part of Analytics shows", ["anMaxes", "anTonPanel", "anNlPanel", "anTopPanel", "anGran"].every(L.shown));
  check("Analytics has no coach controls of its own", !L.$("anAccess"));

  /* ------------------------------------------------------------ the coach's dialog */
  console.log("\nManage Program > Lifter access");
  C.nav("Manage program"); await tick(100);
  check("Manage Program has a Lifter access button, saying everything is visible", !!C.$("dmAccessBtn") && /Everything visible to Tom/.test(C.$("dmAccessBtn").textContent), C.$("dmAccessBtn") && C.$("dmAccessBtn").textContent);
  C.$("dmAccessBtn").click(); await tick(50);
  check("it opens a dialog for Tom with a switch each for the Analytics page, its four parts and the two tools",
    C.$("accessScrim").classList.contains("show") && C.$("accessFor").textContent === "Tom" && ["all", "maxes", "tonnage", "nl", "top", "vbt", "rpe"].every(k => !!C.sw(k)));
  check("...everything on", ["all", "maxes", "tonnage", "nl", "top", "vbt", "rpe"].every(k => C.sw(k).checked));

  console.log("\nParts of Analytics");
  await C.flip("tonnage", false);
  check("switching Total tonnage off is saved", JSON.stringify((await dbRow()).analytics_off) === '["tonnage"]', JSON.stringify(await dbRow()));
  check("...and the button says so", /1 hidden from Tom/.test(C.$("dmAccessBtn").textContent), C.$("dmAccessBtn").textContent);
  C.$("accessClose").click(); C.nav("Lifter’s Analytics"); await tick(100);
  check("the coach still has every part on their own Analytics", C.$("viewAnalytics").classList.contains("active") && ["anMaxes", "anTonPanel", "anNlPanel", "anTopPanel"].every(C.shown));
  L.sync(); await L.settle();
  check("on Tom's device Total tonnage is hidden and its number isn't left in the page", !L.shown("anTonPanel") && L.$("anTonKpi").textContent === "");
  check("...the other parts still show", ["anMaxes", "anNlPanel", "anTopPanel"].every(L.shown));
  C.nav("Manage program"); await tick(100); C.$("dmAccessBtn").click(); await tick(50);
  await C.flip("maxes", false);
  await C.flip("nl", false);
  await C.flip("top", false);
  L.sync(); await L.settle();
  check("with every part off, Analytics goes altogether: its menu item and its button",
    !L.navs().includes("Lifter’s Analytics") && !L.shown("ovAnalyticsBtn"), L.navs().join());
  check("...and Tom is off the Analytics page he was on", !L.$("viewAnalytics").classList.contains("active"));

  console.log("\nThe Analytics page and the Current Program page");
  for (const k of ["maxes", "nl", "top", "tonnage"]) await C.flip(k, true);
  L.sync(); await L.settle();
  check("everything back on brings Analytics back", L.navs().includes("Lifter’s Analytics") && L.shown("ovAnalyticsBtn"));
  await C.flip("all", false);
  check("switching the page off is saved, and dims the part switches", (await dbRow()).analytics_off.includes("all") && C.sw("tonnage").disabled === true);
  L.sync(); await L.settle();
  L.nav("Current Program"); await tick(100);
  check("Tom's menu loses Analytics", !L.navs().includes("Lifter’s Analytics"), L.navs().join());
  check("...and the Analytics button is gone from his Current Program page", !L.shown("ovAnalyticsBtn"));
  check("...but the coach's pages keep it", C.shown("ovAnalyticsBtn") && C.navs().includes("Lifter’s Analytics"));
  const lifterId = (await rows("select id from public.lifters"))[0].id;
  const refused = await L.dev.rpc("set_analytics_off", { p_lifter: lifterId, p_off: [] }).then(() => "allowed", e => String(e.message));
  check("Tom can't switch it back on himself", /only a coach/.test(refused), refused);
  await C.flip("all", true);

  /* ------------------------------------------------------------ the tools */
  console.log("\nVelocity Tracker and RPE Calculator");
  await C.flip("vbt", false);
  check("hiding the Velocity Tracker is saved, in its own list", JSON.stringify((await dbRow()).tools_off) === '["vbt"]', JSON.stringify(await dbRow()));
  L.sync(); await L.settle();
  check("it leaves Tom's menu, the RPE Calculator stays", !L.navs().includes("Velocity Tracker") && L.navs().includes("RPE Calculator"), L.navs().join());
  check("...and the coach still has both", C.navs().includes("Velocity Tracker") && C.navs().includes("RPE Calculator"));
  check("...the Analytics list is untouched", (await dbRow()).analytics_off.length === 0);
  L.nav("RPE Calculator"); await tick(100);
  check("Tom is on the RPE Calculator", L.$("viewRpe").classList.contains("active"));
  await C.flip("rpe", false);
  L.sync(); await L.settle();
  check("hiding it while he's on it takes him off", !L.$("viewRpe").classList.contains("active") && !L.navs().includes("RPE Calculator"));
  check("...with both tools hidden, neither is kept on his device", (await until(() => !L.w.localStorage.getItem("spotter.rpeHeld") && !L.w.localStorage.getItem("spotter.vbtHeld"))));
  const refusedTool = await L.dev.rpc("set_tools_off", { p_lifter: lifterId, p_off: [] }).then(() => "allowed", e => String(e.message));
  check("Tom can't switch them back on himself", /only a coach/.test(refusedTool), refusedTool);
  check("...and nothing outside the list is accepted", await C.dev.rpc("set_tools_off", { p_lifter: lifterId, p_off: ["plates"] }).then(() => false, e => /unknown tool/.test(e.message)));
  await C.flip("vbt", true); await C.flip("rpe", true);
  L.sync(); await L.settle();
  check("switched back on, both return", L.navs().includes("Velocity Tracker") && L.navs().includes("RPE Calculator") && /Everything visible to Tom/.test(C.$("dmAccessBtn").textContent));

  const bad = [C, L].reduce((a, x) => a.concat(x.real()), []);
  check("no script errors on either device", bad.length === 0, bad.join(" | ").slice(0, 400));
  console.log(`\n${checks} checks · ${failures === 0 ? "ALL PASSED" : failures + " FAILED"}\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
