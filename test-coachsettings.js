/* Coach Settings: the owner's page (opened from the account sheet) for coach requests, lifter limits, invites and
 * which cards of Coach's Analytics each coach sees. Run: node test-coachsettings.js
 *
 * Like test-lifteraccess.js: each device is its own jsdom copy of app.html on one in-memory Postgres running
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
        $("acctClose").click(); await tick(100);
      },
      async coachAn() { app.nav("Manage program"); await tick(100); const b = $("dmAnalyticsBtn"); if (b) { b.click(); await tick(250); } return !!b; },
      shown: id => $(id).style.display !== "none",
      cardBox: (coachId, key) => $("csBody").querySelector(`input[data-coach="${coachId}"][data-card="${key}"]`),
    };
    return app;
  }
  const rows = (sql, args) => server.sql(sql, args);
  const off = async email => (await rows("select coach_cards_off from public.accounts where email = $1", [email]))[0].coach_cards_off;

  /* ------------------------------------------------------------ set-up */
  console.log("Set-up: the owner has Tom; Kay and Lee are coaches of Tom; Pat is asking to be a coach");
  const O = boot("owner");
  await tick(200);
  await O.load(TOM, "tom.csv");
  await O.signIn(OWNER_EMAIL);
  O.$("confirmYes").click();
  await until(async () => (await rows("select count(*)::int n from public.lifters"))[0].n === 1);
  await O.settle();
  const K = boot("kay"); await tick(200); await K.signIn("kay@test.invalid");
  const L = boot("lee"); await tick(200); await L.signIn("lee@test.invalid");
  const P = boot("pat"); await tick(200); await P.signIn("pat@test.invalid");
  const uid = async email => (await rows("select user_id from public.accounts where email = $1", [email]))[0].user_id;
  const kayId = await uid("kay@test.invalid"), leeId = await uid("lee@test.invalid");
  const tomLifter = (await rows("select id from public.lifters where name = 'Tom'"))[0].id;
  await rows("update public.accounts set coach_status = 'approved', display_name = 'Coach Kay' where user_id = $1", [kayId]);
  await rows("update public.accounts set coach_status = 'approved', display_name = 'Coach Lee' where user_id = $1", [leeId]);
  await rows("update public.accounts set coach_status = 'pending', display_name = 'Pat' where email = 'pat@test.invalid'");
  const defaults = JSON.stringify([await off("kay@test.invalid"), await off("lee@test.invalid")]);
  await rows("update public.accounts set coach_cards_off = '{}' where user_id in ($1, $2)", [kayId, leeId]);   // the rest of this file starts from every card on
  await rows("insert into public.lifter_coaches (lifter_id, coach_id) values ($1, $2), ($1, $3)", [tomLifter, kayId, leeId]);
  for (const a of [O, K, L]) { a.sync(); await a.settle(); }

  /* ------------------------------------------------------------ the page */
  check("a newly approved coach starts with Progression and load hidden", defaults === '[["load"],["load"]]', defaults);
  console.log("\nThe owner's account sheet has a Coach Settings button");
  O.$("acctBtn").click(); await tick(100);
  check("there is a Coach Settings button in the owner's account popup", !!O.$("acctCoachSet") && O.$("acctCoachSet").textContent.trim() === "Coach Settings");
  check("the popup says a request is waiting, and no longer lists coaches or invites itself", /1 request waiting/.test(O.$("acctBody").textContent) && !O.$("acctInvite") && !O.btn("Approve", O.$("acctBody")) && !O.$("acctBody").querySelector(".acct-limit-input"));
  O.$("acctCoachSet").click(); await tick(150);
  check("it opens a page in the main window and closes the popup", O.$("viewCoachSet").classList.contains("active") && !O.$("acctScrim").classList.contains("show"));
  check("the page is titled Coach Settings", /Coach Settings/.test(O.$("viewCoachSet").querySelector("h1").textContent));
  const body = () => O.$("csBody").textContent;
  check("Pat's request is there to approve or decline", /Coach requests[\s\S]*Pat[\s\S]*Asking to be a coach/.test(body()) && !!O.btn("Approve", O.$("csBody")) && !!O.btn("Decline", O.$("csBody")));
  check("each approved coach has a card with a Max lifters box and four switches, all on", ["Coach Kay", "Coach Lee"].every(n => {
    const c = [...O.$("csBody").querySelectorAll(".cs-card")].find(x => x.textContent.includes(n));
    return c && !!c.querySelector(".acct-limit-input") && c.querySelectorAll('input[data-card]').length === 4 && [...c.querySelectorAll('input[data-card]')].every(i => i.checked);
  }));
  check("the four cards are Estimated 1RM, Weekly e1RM, Program charts and Progression and load", ["Estimated 1RM", "Weekly e1RM", "Program charts", "Progression and load"].every(t => body().includes(t)));
  check("invites are on the page too", /Invites[\s\S]*Only invited emails/.test(body()) && !!O.$("acctInvite"));

  /* ------------------------------------------------------------ everything shown to start */
  console.log("\nTo start, both coaches see every card");
  await K.coachAn(); await L.coachAn();
  check("Kay's Coach's Analytics has all four", K.$("viewCoachAn").classList.contains("active") && K.$("cnE1rm").children.length > 0 && K.$("cnWeekly").children.length > 0 && K.$("dmCharts").children.length > 0 && K.$("dmAnBody").children.length > 0 && ["cnE1rm", "cnWeekly", "dmCharts", "dmAnSec"].every(K.shown));
  check("so does Lee's", L.$("viewCoachAn").classList.contains("active") && L.$("cnE1rm").children.length > 0 && ["cnE1rm", "cnWeekly", "dmCharts", "dmAnSec"].every(L.shown));

  /* ------------------------------------------------------------ hide one for Kay */
  console.log("\nThe owner hides Estimated 1RM from Kay only");
  const flip = async (id, key, on) => { const b = O.cardBox(id, key); b.checked = on; b.dispatchEvent(new O.w.Event("change")); await until(() => !O.cardBox(id, key).disabled); };
  await flip(kayId, "e1rm", false);
  check("the database holds it for Kay", await until(async () => (await off("kay@test.invalid")).join() === "e1rm"), String(await off("kay@test.invalid")));
  check("...and not for Lee", (await off("lee@test.invalid")).length === 0);
  check("the owner is told", /Estimated 1RM is hidden from Coach Kay/.test(O.$("toastMsg").textContent), O.$("toastMsg").textContent);
  K.sync(); await K.settle(); L.sync(); await L.settle();
  check("Kay's open Coach's Analytics page drops that card", !K.shown("cnE1rm") && K.$("cnE1rm").children.length === 0 && K.shown("cnWeekly") && K.shown("dmCharts") && K.shown("dmAnSec"), K.$("cnE1rm").style.display);
  await L.coachAn();
  check("Lee still has it", L.shown("cnE1rm") && L.$("cnE1rm").children.length > 0);
  check("Kay's own device reads the switches from the database", (await K.dev.fetch("accounts", {})).find(a => a.user_id === kayId).coach_cards_off.join() === "e1rm");

  console.log("\nAnother card, then everything, then back");
  await flip(kayId, "load", false); await flip(kayId, "weekly", false);
  K.sync(); await K.settle();
  check("Kay now sees only the program charts", !K.shown("cnE1rm") && !K.shown("cnWeekly") && K.shown("dmCharts") && !K.shown("dmAnSec") && K.$("dmAnBody").children.length === 0);
  await flip(kayId, "charts", false);
  K.sync(); await K.settle(); await tick(200);
  check("with all four off, Kay's Coach's Analytics page closes and the button is gone from Manage Program", !K.$("viewCoachAn").classList.contains("active") && !K.$("dmAnalyticsBtn"));
  K.nav("Manage program"); await tick(100);
  check("...and Manage Program itself still works", !!K.$("dmShareBtn") || !!K.$("dmMaxesBtn"));
  await flip(kayId, "e1rm", true);
  K.sync(); await K.settle(); K.nav("Manage program"); await tick(100);
  check("switching one back on brings the button back, showing just that card", !!K.$("dmAnalyticsBtn"));
  K.$("dmAnalyticsBtn").click(); await tick(250);
  check("...with only Estimated 1RM on it", K.shown("cnE1rm") && K.$("cnE1rm").children.length > 0 && !K.shown("cnWeekly") && !K.shown("dmCharts") && !K.shown("dmAnSec"));
  for (const k of ["weekly", "charts", "load"]) await flip(kayId, k, true);
  check("switching them all on empties the list", await until(async () => (await off("kay@test.invalid")).length === 0));

  /* ------------------------------------------------------------ owner and others */
  console.log("\nThe owner always sees everything; nobody else can change it");
  await rows("update public.accounts set coach_cards_off = '{e1rm,weekly,charts,load}' where user_id = $1", [kayId]);
  O.$("csBack").click(); await tick(100);
  check("Back goes to Home", O.$("viewHome").classList.contains("active"));
  await O.coachAn();
  check("the owner's own Coach's Analytics shows every card", O.shown("cnE1rm") && O.shown("cnWeekly") && O.shown("dmCharts") && O.shown("dmAnSec") && O.$("cnE1rm").children.length > 0);
  await rows("update public.accounts set coach_cards_off = '{}' where user_id = $1", [kayId]);
  K.$("acctBtn").click(); await tick(100);
  check("a coach's account popup has no Coach Settings", !K.$("acctCoachSet"));
  K.$("acctClose").click();
  let refused = null;
  try { await K.dev.rpc("set_coach_cards", { p_user: kayId, p_off: ["e1rm"] }); } catch (e) { refused = e.message; }
  check("...and the database refuses a coach who tries", !!refused && (await off("kay@test.invalid")).length === 0, String(refused));

  /* ------------------------------------------------------------ requests and invites live here */
  console.log("\nApproving and inviting happen on the page");
  O.$("acctBtn").click(); await tick(100); O.$("acctCoachSet").click(); await tick(150);
  O.btn("Approve", O.$("csBody")).click();
  check("approving Pat works from Coach Settings", await until(async () => (await rows("select coach_status from public.accounts where email = 'pat@test.invalid'"))[0].coach_status === "approved"));
  check("...and Pat gets a card of their own", await until(() => [...O.$("csBody").querySelectorAll(".cs-card")].some(c => /Pat/.test(c.textContent))));
  check("...with the request gone", await until(() => /Nobody is asking to be a coach right now/.test(O.$("csBody").textContent)));
  O.$("csBack").click(); await tick(100);
  O.$("acctBtn").click(); await tick(100);
  check("the popup no longer counts a request", !/request waiting/.test(O.$("acctBody").textContent) && O.$("acctBadge").hidden);
  O.$("acctClose").click();

  check("no script errors on any device", [O, K, L, P].every(a => a.real().length === 0), [O, K, L, P].map(a => a.real().join(" | ")).join(" // "));
  console.log(`\n${checks} checks · ${failures ? failures + " FAILED" : "ALL PASSED"}`);
  process.exit(failures ? 1 : 0);
})();
