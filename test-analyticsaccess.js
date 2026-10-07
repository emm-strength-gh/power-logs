/* A coach switches parts of Analytics (or the whole page) off for a lifter: the Lifter access card on the
 * coach's Analytics page, the database rule, and what the lifter's own device then shows. Run: node test-analyticsaccess.js
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
      sw: part => $("anAccess").querySelector(`input[data-part="${part}"]`),
    };
    return app;
  }
  const rows = (sql, args) => server.sql(sql, args);
  const offInDb = async () => (await rows("select analytics_off from public.lifter_settings"))[0];

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

  /* ------------------------------------------------------------ everything on, to start */
  console.log("\nBy default the lifter sees all of Analytics");
  L.nav("Analytics"); await tick(100);
  check("Tom has Analytics in his menu and every part shows", L.navs().includes("Analytics") && ["anMaxes", "anTonPanel", "anNlPanel", "anTopPanel", "anGran"].every(L.shown));
  check("...and no Lifter access card (that's the coach's)", !L.shown("anAccess") === true && L.$("anAccess").children.length === 0);
  check("the tonnage is worked out for him", /\d/.test(L.$("anTonKpi").textContent), L.$("anTonKpi").textContent);

  console.log("\nThe coach's Lifter access card");
  C.nav("Analytics"); await tick(100);
  check("the coach's Analytics page has the card, with a switch for the page and each part",
    C.shown("anAccess") && /Lifter access/.test(C.$("anAccess").textContent) && ["all", "maxes", "tonnage", "nl", "top"].every(k => !!C.sw(k)));
  check("...everything on", ["all", "maxes", "tonnage", "nl", "top"].every(k => C.sw(k).checked));
  C.sw("tonnage").checked = false; C.sw("tonnage").dispatchEvent(new C.w.Event("change"));
  check("switching Total tonnage off is saved", await until(async () => JSON.stringify((await offInDb()).analytics_off) === '["tonnage"]'), JSON.stringify(await offInDb()));
  await until(() => C.sw("tonnage") && !C.sw("tonnage").disabled);
  check("the coach still sees every part (and the switch shows it off)", ["anMaxes", "anTonPanel", "anNlPanel", "anTopPanel"].every(C.shown) && C.sw("tonnage").checked === false);

  console.log("\nOn Tom's device");
  L.sync(); await L.settle();
  check("Total tonnage is hidden, and its number isn't left in the page", !L.shown("anTonPanel") && L.$("anTonKpi").textContent === "");
  check("...the other parts still show", ["anMaxes", "anNlPanel", "anTopPanel", "anGran"].every(L.shown));
  C.sw("maxes").checked = false; C.sw("maxes").dispatchEvent(new C.w.Event("change"));
  await until(async () => JSON.stringify((await offInDb()).analytics_off) === '["maxes","tonnage"]');
  await until(() => C.sw("maxes") && !C.sw("maxes").disabled);
  L.sync(); await L.settle();
  check("Maxes can be hidden too", !L.shown("anMaxes") && L.$("anMaxes").children.length === 0 && L.shown("anNlPanel") && L.shown("anTopPanel"));
  for (const k of ["nl", "top"]) { await until(() => C.sw(k) && !C.sw(k).disabled); C.sw(k).checked = false; C.sw(k).dispatchEvent(new C.w.Event("change")); await until(async () => (await offInDb()).analytics_off.includes(k)); }
  L.sync(); await L.settle();
  check("with every part off, the granularity switch goes too", !L.shown("anGran") && ["anMaxes", "anTonPanel", "anNlPanel", "anTopPanel"].every(id => !L.shown(id)));

  console.log("\nThe whole page");
  await until(() => C.sw("all") && !C.sw("all").disabled);
  C.sw("all").checked = false; C.sw("all").dispatchEvent(new C.w.Event("change"));
  check("switching the page off is saved", await until(async () => (await offInDb()).analytics_off.includes("all")));
  await until(() => C.sw("all") && !C.sw("all").disabled);
  check("...the coach's part switches dim", C.sw("tonnage").disabled === true);
  L.sync(); await L.settle();
  check("Tom loses Analytics from his menu, and is taken off the page he was on", !L.navs().includes("Analytics") && !L.$("viewAnalytics").classList.contains("active"), L.navs().join());
  check("...and the coach keeps it, with everything", C.navs().includes("Analytics") && ["anMaxes", "anTonPanel", "anNlPanel", "anTopPanel"].every(C.shown));
  const refused = await L.dev.rpc("set_analytics_off", { p_lifter: (await rows("select id from public.lifters"))[0].id, p_off: [] }).then(() => "allowed", e => String(e.message));
  check("Tom can't switch it back on himself", /only a coach/.test(refused), refused);
  check("...nor can an outside caller invent a part", await C.dev.rpc("set_analytics_off", { p_lifter: (await rows("select id from public.lifters"))[0].id, p_off: ["charts"] }).then(() => false, e => /unknown part/.test(e.message)));

  console.log("\nBack on");
  C.sw("all").checked = true; C.sw("all").dispatchEvent(new C.w.Event("change"));
  await until(async () => !(await offInDb()).analytics_off.includes("all"));
  L.sync(); await L.settle();
  check("the menu item returns, with the parts that were off still off", L.navs().includes("Analytics") && (L.nav("Analytics"), true));
  await tick(100);
  check("...Tom sees Analytics, but none of its parts", L.$("viewAnalytics").classList.contains("active") && ["anMaxes", "anTonPanel", "anNlPanel", "anTopPanel"].every(id => !L.shown(id)));
  for (const k of ["maxes", "tonnage", "nl", "top"]) { await until(() => C.sw(k) && !C.sw(k).disabled); C.sw(k).checked = true; C.sw(k).dispatchEvent(new C.w.Event("change")); await until(async () => !(await offInDb()).analytics_off.includes(k)); }
  L.sync(); await L.settle();
  check("everything back on shows everything again", ["anMaxes", "anTonPanel", "anNlPanel", "anTopPanel", "anGran"].every(L.shown) && /\d/.test(L.$("anTonKpi").textContent));

  const bad = [C, L].reduce((a, x) => a.concat(x.real()), []);
  check("no script errors on either device", bad.length === 0, bad.join(" | ").slice(0, 400));
  console.log(`\n${checks} checks · ${failures === 0 ? "ALL PASSED" : failures + " FAILED"}\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
