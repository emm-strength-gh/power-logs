/* The coach landing page: "Welcome Coach <name>!", a Notifications card, a Lifters
 * card (all lifters in a list), an Inbox card, and a Home button back from each.
 * Run: node test-home.js
 *
 * Each "device" is a jsdom copy of app.html with a stand-in for Supabase
 * (window.__spotterCloud) signed in as whoever the test needs.
 */
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const html = fs.readFileSync(path.join(__dirname, "app.html"), "utf8");
let failures = 0, checks = 0;
const check = (name, cond, extra = "") => {
  checks++;
  if (!cond) failures++;
  console.log(`${cond ? "  ok  " : " FAIL "} ${name}${extra && !cond ? " — " + extra : ""}`);
};
const tick = (ms = 50) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return true; } catch (e) {} await tick(50); }
  return false;
}
const ME = "00000000-0000-4000-8000-0000000000aa";
const CSV = (name, block) => `#Name,${name}\r\n#Block,${block}\r\n#Class,83\r\nWeek,Day,Exercise,Weight (kg),Sets,Reps,RPE,Notes\r\n1,1,Squat,150,3,5,7,\r\n1,1,Bench,100,3,5,7,\r\n2,1,Squat,155,3,5,7,\r\n`;

function world(over = {}) {
  const w = Object.assign({ role: "owner", coach_status: "none", display_name: "Emm", email: "emm@test.invalid", signedIn: true }, over);
  w.cloud = {
    session: async () => (w.signedIn ? { id: ME, email: w.email } : null),
    onSessionChange() {}, sendCode: async () => {}, verifyCode: async () => { w.signedIn = true; return { id: ME, email: w.email }; }, signOut: async () => { w.signedIn = false; },
    fetch: async table => table === "accounts" ? [{ user_id: ME, email: w.email, role: w.role, coach_status: w.coach_status, display_name: w.display_name }] : [],
    upsert: async () => {}, remove: async () => {}, invoke: async () => ({ sent: 0 }), insert: async (t, rows) => { if (t === "lifters") w.inserted = (w.inserted || []).concat(rows); }, update: async () => {}, rpc: async () => null, listen: () => () => {},
  };
  return w;
}
const cached = (w) => JSON.stringify({ uploadAsked: true, user: { id: ME, email: w.email }, lastUserId: ME, account: { role: w.role, coach_status: w.coach_status, display_name: w.display_name } });

async function boot(wd, storage = {}) {
  const errors = [];
  const dom = new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true,
    url: "https://example.github.io/power-logs/app.html",
    virtualConsole: new VirtualConsole().on("jsdomError", e => errors.push(e.message)).on("error", m => errors.push(String(m))),
    beforeParse(w) {
      w.__spotterCloud = wd.cloud;
      w.__spotterPrivateStore = { get: async () => null, put: async () => {}, del: async () => {} };
      Object.keys(storage).forEach(k => w.localStorage.setItem(k, storage[k]));
      if (!storage["spotter.cloud.v1"]) w.localStorage.setItem("spotter.cloud.v1", JSON.stringify({ uploadAsked: true }));
    },
  });
  const w = dom.window, doc = w.document, $ = id => doc.getElementById(id);
  w.Element.prototype.scrollIntoView = function () {};
  w.scrollTo = function () {};
  await new Promise(res => { if (doc.readyState === "complete") res(); else w.addEventListener("load", res); setTimeout(res, 4000); });
  const app = {
    w, doc, $, errors,
    real: () => errors.filter(e => !/Not implemented|HTMLCanvasElement|getContext|Chart is not defined/i.test(e)),
    storage: () => { const o = {}; for (let i = 0; i < w.localStorage.length; i++) { const k = w.localStorage.key(i); o[k] = w.localStorage.getItem(k); } return o; },
    btn: (t, root) => [...(root || doc).querySelectorAll("button")].find(b => b.textContent.trim() === t || (b.querySelector(".ab-title") && b.querySelector(".ab-title").textContent === t)),
    navs: () => [...doc.querySelectorAll("#sideNav .nav-item")].map(n => n.querySelector(".nav-label").textContent),
    nav(label) { const b = [...doc.querySelectorAll("#sideNav .nav-item")].find(n => n.querySelector(".nav-label").textContent === label); if (b) b.click(); return !!b; },
    active: () => [...doc.querySelectorAll(".view.active")].map(v => v.id).join(),
    async load(text) {
      const i = $("fileInput");
      Object.defineProperty(i, "files", { value: [new w.File([text], "t.csv")], configurable: true });
      i.dispatchEvent(new w.Event("change"));
      await tick(300);
    },
  };
  return app;
}

(async () => {
  /* -------------------------------------------------------- set-up: a coach with lifters */
  const WD = world();
  const first = await boot(WD, { "spotter.cloud.v1": cached(WD) });
  await first.load(CSV("Tom", "Prep"));
  await first.load(CSV("Sam", "Peak"));
  const saved = first.storage();

  console.log("A coach opens the app");
  const A = await boot(WD, saved);
  await tick(300);
  check("boots with no script errors", A.real().length === 0, A.real().join(" | ").slice(0, 300));
  check("it opens on Home, not on a lifter", A.active() === "viewHome", A.active());
  check("the title greets the coach by name", A.$("homeTitle").textContent === "Welcome Coach Emm!", A.$("homeTitle").textContent);
  const caps = [...A.doc.querySelectorAll("#viewHome .home-cap")].map(c => c.textContent);
  check("below it: Notifications, Lifters, Messages, Payments, then the owner's Storage", caps.join() === "Notifications,Lifters,Messages,Payments,Storage", caps.join());
  check("the Notifications card is the existing banner, moved here", !!A.$("homeNotices").closest(".home-card") && /all caught up/.test(A.$("homeNotices").textContent) && A.$("noticeBar").hidden);
  check("the Lifters card has a button for the list", !!A.btn("All lifters", A.$("homeLifters")));
  check("the next card starts with Inbox", !!A.btn("Inbox", A.$("homeComms")));
  check("the sidebar leads with Home and Lifters", A.navs().slice(0, 2).join() === "Home,Lifters", A.navs().join());
  check("...and Home is the one marked", A.doc.querySelector("#sideNav .nav-item.active .nav-label").textContent === "Home");
  check("the count of lifters is under the title", A.$("homeSub").textContent === "2 lifters", A.$("homeSub").textContent);

  console.log("\nAll lifters");
  A.btn("All lifters", A.$("homeLifters")).click(); await tick(100);
  check("the button opens a list", A.active() === "viewLifters");
  const rows = [...A.doc.querySelectorAll("#liftersBody .msg-thread")];
  check("every lifter is on it, with their block and progress", rows.length === 2 && /Tom/.test(rows[0].textContent) && /Prep/.test(rows[0].textContent) && /83 kg/.test(rows[0].textContent) && /2 weeks/.test(rows[0].textContent) && /0% done/.test(rows[0].textContent), rows.map(r => r.textContent).join(" | "));
  A.nav("Home"); await tick(50);
  check("Home in the sidebar goes back", A.active() === "viewHome");
  A.nav("Lifters"); await tick(50);
  check("...and Lifters in the sidebar opens the list again", A.active() === "viewLifters");
  A.$("liftersBack").click(); await tick(50);
  check("the list has its own Home button", A.active() === "viewHome");
  A.btn("All lifters", A.$("homeLifters")).click(); await tick(50);
  [...A.doc.querySelectorAll("#liftersBody .msg-thread")].find(r => /Sam/.test(r.textContent)).click(); await tick(150);
  check("tapping a lifter opens their Programs page to choose one", A.active() === "viewPrograms" && A.doc.querySelectorAll("#progsList .msg-thread").length === 1, A.active());
  A.doc.querySelector("#progsList .msg-thread").click(); await tick(150);
  check("...and choosing it opens it as it always did", A.active() === "viewOverview" && A.$("ovName").textContent === "Sam", A.active() + " " + A.$("ovName").textContent);
  check("...with the usual sidebar: Overview, Analytics, Messages…, the weeks", ["Current Program", "Lifter’s Analytics", "Trophies"].every(l => A.navs().includes(l)) && A.navs().some(l => /^Week 1/.test(l)), A.navs().join());
  check("...and Home is still in it", A.navs().includes("Home"));
  check("the lifter's page has a Home button of its own", !A.$("ovHome").hidden);
  A.nav("Lifter’s Analytics"); await tick(100);
  A.nav("Home"); await tick(50);
  check("Home works from any lifter screen", A.active() === "viewHome");
  A.btn("All lifters", A.$("homeLifters")).click(); await tick(50);
  [...A.doc.querySelectorAll("#liftersBody .msg-thread")].find(r => /Tom/.test(r.textContent)).click(); await tick(100);
  A.doc.querySelector("#progsList .msg-thread").click(); await tick(100);
  A.$("ovHome").click(); await tick(50);
  check("...and from the Home button on the Overview", A.active() === "viewHome");

  console.log("\nAdd new lifter / program");
  A.nav("Lifters"); await tick(50);
  check("the Lifters page has an Add button", !!A.$("addLifterBtn") && /Add new lifter \/ program/.test(A.$("addLifterBtn").textContent));
  A.$("addLifterBtn").click(); await tick(50);
  check("it opens a form for the lifter's profile", A.$("troFormScrim").classList.contains("show") && ["nlName", "nlBlock", "nlCls", "nlSquat", "nlBench", "nlDeadlift"].every(id => !!A.$(id)) && !A.$("nlBw"));
  check("...with a weight class but no bodyweight question", !!A.$("nlCls") && !/Bodyweight \(kg/.test(A.$("troFormBody").textContent));
  A.btn("Create", A.$("troFormBody")).click(); await tick(50);
  check("a name is required", A.$("troFormScrim").classList.contains("show") && /name/.test(A.$("toastMsg").textContent));
  A.$("nlName").value = "Tom";
  A.btn("Create", A.$("troFormBody")).click(); await tick(200);
  check("...a name that is already taken is fine: the new lifter is Tom (2), with an ID of its own", !A.$("troFormScrim").classList.contains("show") && !!JSON.parse(A.w.localStorage.getItem("spotter.profiles.v1"))["Tom (2)"] && /Tom added \(there was already a Tom\)/.test(A.$("toastMsg").textContent), A.$("toastMsg").textContent);
  A.nav("Lifters"); await tick(50);
  A.$("addLifterBtn").click(); await tick(50);
  A.$("nlName").value = "  Jo   Reyes "; A.$("nlBlock").value = "Off-season"; A.$("nlCls").value = "63kg";
  A.$("nlSquat").value = "120"; A.$("nlDeadlift").value = "150";
  A.btn("Create", A.$("troFormBody")).click(); await tick(200);
  const jo = JSON.parse(A.w.localStorage.getItem("spotter.profiles.v1"))["Jo Reyes"];
  check("the lifter is created with their profile", !!jo && jo.block === "Off-season" && jo.classWt === "63" && jo.bodyweight === "63" && jo.maxes.Squat === "120" && jo.maxes.Deadlift === "150" && !jo.maxes.Bench, JSON.stringify(jo && { b: jo.block, c: jo.classWt, bw: jo.bodyweight, m: jo.maxes }));
  check("...with an empty program: Week 1, Day 1, no exercises", jo.weeks.length === 1 && jo.weeks[0].week === "1" && jo.weeks[0].days.length === 1 && jo.weeks[0].days[0].rows.length === 0);
  check("...and it opens in Manage Program to be built", A.active() === "viewDayMgr" && A.$("dmBody").querySelector(".dm-progcard input[aria-label='Lifter name']").value === "Jo Reyes");
  check("...and appears in the list of lifters", (A.nav("Lifters"), [...A.doc.querySelectorAll("#liftersBody .msg-thread")].some(r => /Jo Reyes/.test(r.textContent))));
  check("signed in as a coach, it's uploaded to the account", WD.inserted && WD.inserted.some(r => r.name === "Jo Reyes"), JSON.stringify(WD.inserted || []).slice(0, 200));

  console.log("\nDelete a lifter or just their program");
  const rowsNow = () => [...A.doc.querySelectorAll("#liftersBody .msg-thread")];
  const more = nm => A.doc.querySelector('#liftersBody [data-more="' + nm + '"]');
  const stored = () => JSON.parse(A.w.localStorage.getItem("spotter.profiles.v1"));
  A.nav("Lifters"); await tick(50);
  // One card per lifter: the two Toms (neither signed in) are one card with two programs, whose ⋯ are on their Programs page.
  const tomCard = rowsNow().find(r => /^Tom/.test(r.querySelector(".msg-mid b").textContent));
  check("one card per lifter: the two programs called Tom are one card, without a ⋯", !!tomCard && tomCard.getAttribute("data-programs") === "2" && !tomCard.parentElement.querySelector(".ll-more") && /2 programs/.test(tomCard.textContent));
  check("each lifter with a single program has a ⋯ for coaches", rowsNow().filter(r => r.getAttribute("data-programs") === "1").length >= 2 && rowsNow().filter(r => r.getAttribute("data-programs") === "1").every(r => !!r.parentElement.querySelector(".ll-more")));
  A.$("addLifterBtn").click(); await tick(50);
  A.$("nlName").value = "Zed"; A.$("nlBlock").value = "Temp block"; A.$("nlSquat").value = "100";
  A.btn("Create", A.$("troFormBody")).click(); await tick(200);
  A.nav("Lifters"); await tick(50);
  check("a new lifter is listed", !!more("Zed"));
  more("Zed").click(); await tick(50);
  check("the ⋯ offers Delete program and Delete lifter", A.$("troFormScrim").classList.contains("show") && !!A.btn("Delete program", A.$("troFormBody")) && !!A.btn("Delete lifter", A.$("troFormBody")));
  A.btn("Delete program", A.$("troFormBody")).click(); await tick(50);
  check("deleting a program asks first", A.$("confirmScrim").classList.contains("show") && /program/.test(A.$("confirmTitle").textContent));
  A.$("confirmNo").click(); await tick(50);
  check("Cancel changes nothing", stored().Zed.block === "Temp block");
  more("Zed").click(); await tick(50);
  A.btn("Delete program", A.$("troFormBody")).click(); await tick(50);
  A.$("confirmYes").click(); await tick(100);
  const z = stored().Zed;
  check("the program is cleared to an empty Week 1, Day 1", z.weeks.length === 1 && z.weeks[0].days.length === 1 && z.weeks[0].days[0].rows.length === 0 && z.block === "", JSON.stringify(z.weeks).slice(0, 120));
  check("...but the lifter stays, with their maxes", !!more("Zed") && z.maxes.Squat === "100");
  more("Zed").click(); await tick(50);
  A.btn("Delete lifter", A.$("troFormBody")).click(); await tick(50);
  check("deleting a lifter asks first", A.$("confirmScrim").classList.contains("show") && /Delete Zed/.test(A.$("confirmTitle").textContent));
  A.$("confirmYes").click(); await tick(150);
  check("the lifter is gone from the list and the device", !more("Zed") && !stored().Zed && A.active() === "viewLifters");
  check("...and the others are untouched", !!more("Sam") && rowsNow().some(r => /^Tom/.test(r.querySelector(".msg-mid b").textContent)));

  console.log("\nSwipe gestures");
  const sw = (a, el, x0, y0, x1, y1) => {
    const ev = (type, x, y) => { const e = new a.w.Event(type, { bubbles: true }); e.touches = type === "touchend" ? [] : [{ clientX: x, clientY: y }]; el.dispatchEvent(e); };
    ev("touchstart", x0, y0); ev("touchmove", x1, y1); ev("touchend", x1, y1);
  };
  A.nav("Home"); await tick(50);
  const syncs = () => (WD.fetched || 0);
  const before = A.$("toastMsg").textContent;
  sw(A, A.$("viewHome"), 150, 100, 160, 260);
  await tick(100);
  check("pulling down at the top of Home syncs everything", /Syncing/.test(A.$("toastMsg").textContent) || /Up to date/.test(A.$("toastMsg").textContent), A.$("toastMsg").textContent);
  check("...and says when it's done", await until(() => /Up to date|Couldn/.test(A.$("toastMsg").textContent), 4000), A.$("toastMsg").textContent);
  A.$("toastMsg").textContent = "";
  sw(A, A.$("viewHome"), 150, 100, 160, 130);
  await tick(50);
  check("a short pull does nothing", A.$("toastMsg").textContent === "");
  Object.defineProperty(A.w, "pageYOffset", { value: 300, configurable: true });
  sw(A, A.$("viewHome"), 150, 100, 160, 260);
  await tick(50);
  check("...and neither does a swipe down while scrolled part-way (that's just scrolling up)", A.$("toastMsg").textContent === "");
  Object.defineProperty(A.w, "pageYOffset", { value: 0, configurable: true });
  A.$("layout").classList.remove("nav-open");
  A.nav("Lifters"); await tick(30);
  [...A.doc.querySelectorAll("#liftersBody .msg-thread")].find(r => /Tom/.test(r.textContent)).click(); await tick(150);
  sw(A, A.$("viewOverview"), 60, 200, 220, 210);
  check("swiping right on the Overview opens the left navigation", A.$("layout").classList.contains("nav-open"));
  A.$("layout").classList.remove("nav-open");
  sw(A, A.$("viewOverview"), 220, 200, 60, 210);
  check("swiping left doesn't", !A.$("layout").classList.contains("nav-open"));
  sw(A, A.$("viewOverview"), 100, 200, 200, 400);
  check("a diagonal swipe (mostly scrolling) doesn't", !A.$("layout").classList.contains("nav-open"));
  A.nav("Home"); await tick(150);
  A.$("layout").classList.remove("nav-open");
  sw(A, A.$("viewHome"), 60, 300, 230, 310);
  check("swiping right on Home opens the left navigation", A.$("layout").classList.contains("nav-open"));
  A.$("layout").classList.remove("nav-open");
  sw(A, A.$("viewHome"), 230, 300, 60, 310);
  check("swiping left on Home doesn't", !A.$("layout").classList.contains("nav-open"));
  sw(A, A.$("viewHome"), 100, 200, 200, 400);
  check("a mostly-vertical swipe on Home doesn't (that's scrolling)", !A.$("layout").classList.contains("nav-open"));
  sw(A, A.$("viewHome"), 150, 100, 160, 260);
  await tick(50);
  check("and pulling down to sync still works on Home", /Syncing|Up to date/.test(A.$("toastMsg").textContent), A.$("toastMsg").textContent);
  A.nav("Current Program"); await tick(100);
  console.log("\nClosing the left navigation");
  A.$("layout").classList.add("nav-open");
  sw(A, A.$("sidebar"), 220, 300, 40, 310);
  check("swiping left on the open left navigation closes it", !A.$("layout").classList.contains("nav-open"));
  A.$("layout").classList.add("nav-open");
  sw(A, A.$("sidebar"), 40, 300, 220, 310);
  check("a swipe right on it doesn't", A.$("layout").classList.contains("nav-open"));
  sw(A, A.$("sidebar"), 200, 200, 120, 420);
  check("neither does a mostly-vertical one (that's scrolling the menu)", A.$("layout").classList.contains("nav-open"));
  sw(A, A.$("sidebar"), 200, 300, 150, 305);
  check("nor a short one", A.$("layout").classList.contains("nav-open"));
  const dimEl = A.doc.querySelector(".scrim");
  sw(A, dimEl, 300, 300, 100, 310);
  check("a swipe left on the dimmed page beside it closes it too", !A.$("layout").classList.contains("nav-open"));
  A.nav("Lifter’s Analytics"); await tick(150);
  sw(A, A.$("viewAnalytics"), 60, 300, 230, 310);
  check("the same on Analytics", A.$("layout").classList.contains("nav-open"));
  A.$("layout").classList.remove("nav-open");
  const cv = A.$("viewAnalytics").querySelector("canvas");
  if (cv) { sw(A, cv, 60, 300, 230, 310); check("...but not when it starts on a chart (that's the chart's)", !A.$("layout").classList.contains("nav-open")); }

  console.log("\nInbox");
  A.btn("Inbox", A.$("homeComms")).click(); await tick(100);
  check("the Inbox button opens the inbox view", A.active() === "viewInbox");
  check("the inbox has a Home button", /Home/.test(A.$("inboxBack").textContent));
  A.$("inboxBack").click(); await tick(50);
  check("...which goes back to the landing page", A.active() === "viewHome");

  console.log("\nBefore any lifter is loaded");
  const E = await boot(WD, { "spotter.cloud.v1": cached(WD) });
  await tick(300);
  check("a coach with no lifters still lands on Home", E.active() === "viewHome", E.active());
  check("...which says so", E.$("homeSub").textContent === "No lifters yet");
  E.btn("All lifters", E.$("homeLifters")).click(); await tick(50);
  check("the list explains", /No lifters yet/.test(E.$("liftersBody").textContent));

  console.log("\nWho gets a name");
  const W2 = world({ display_name: "", email: "jordan@test.invalid" });
  const B = await boot(W2, { "spotter.cloud.v1": cached(W2) });
  await tick(300);
  check("a coach with no display name is greeted by their email's first part", B.$("homeTitle").textContent === "Welcome Coach Jordan!", B.$("homeTitle").textContent);

  const W2b = world({ display_name: "Coach Emm" });
  const B2 = await boot(W2b, { "spotter.cloud.v1": cached(W2b) });
  await tick(300);
  check("a name that already starts with Coach isn't doubled", B2.$("homeTitle").textContent === "Welcome Coach Emm!", B2.$("homeTitle").textContent);

  console.log("\nSigning in");
  const W3 = world({ signedIn: false, display_name: "Emm" });
  const C = await boot(W3, Object.assign({}, saved, { "spotter.cloud.v1": JSON.stringify({ uploadAsked: true }) }));
  await tick(200);
  check("signed out, a device with lifters opens on a lifter (unchanged)", C.active() === "viewOverview", C.active());
  C.$("acctBtn").click(); await tick();
  C.$("acctEmail").value = "emm@test.invalid";
  C.btn("Email me a code", C.$("acctBody")).click();
  await until(() => C.$("acctCode"));
  C.$("acctCode").value = "123456";
  C.btn("Sign in", C.$("acctBody")).click();
  check("signing in as a coach lands on Home", await until(() => C.active() === "viewHome"), C.active());
  check("...greeting them", C.$("homeTitle").textContent === "Welcome Coach Emm!", C.$("homeTitle").textContent);

  console.log("\nA lifter gets a Home of their own");
  const W4 = world({ role: "member", coach_status: "none", display_name: "" });
  const D = await boot(W4, Object.assign({}, saved, { "spotter.cloud.v1": JSON.stringify({ uploadAsked: true, user: { id: ME, email: W4.email }, lastUserId: ME, account: { role: "member", coach_status: "none", display_name: "" }, lifterMeta: { a1: { name: "Tom", mine: true, createdBy: "someone" } } }) }));
  await tick(400);
  check("a lifter opens on Home too", D.active() === "viewHome", D.active());
  check("...greeted without 'Coach'", /^Welcome (?!Coach)/.test(D.$("homeTitle").textContent), D.$("homeTitle").textContent);
  const dcaps = [...D.doc.querySelectorAll("#viewHome .home-cap")].filter(c => !c.closest("[hidden]")).map(c => c.textContent);
  check("...with Notifications and Programs, not a list of lifters", dcaps[0] === "Notifications" && dcaps[1] === "Programs" && !D.btn("All lifters", D.$("homeLifters")), dcaps.join());
  check("...no Lifters or Inbox in the sidebar, but Home", D.navs().includes("Home") && !D.navs().includes("Lifters") && !D.navs().includes("Inbox"), D.navs().join());
  check("...and their notices are on Home, not a banner", D.$("noticeBar").hidden);
  const W5 = world({ role: "member", coach_status: "pending", display_name: "" });
  const F = await boot(W5, Object.assign({}, saved, { "spotter.cloud.v1": cached(W5) }));
  await tick(400);
  check("a coach who hasn't been approved yet gets the lifter's Home, not the coach's", F.active() === "viewHome" && !/Coach/.test(F.$("homeTitle").textContent) && !F.navs().includes("Lifters"), F.$("homeTitle").textContent);

  console.log("\nAnother coach");
  const W6 = world({ role: "member", coach_status: "approved", display_name: "Jordan" });
  const G = await boot(W6, Object.assign({}, saved, { "spotter.cloud.v1": cached(W6) }));
  await tick(400);
  check("an approved coach lands on Home too", G.active() === "viewHome" && G.$("homeTitle").textContent === "Welcome Coach Jordan!", G.active() + " " + G.$("homeTitle").textContent);
  check("...but has no Storage card: that is the owner's alone", G.$("homeStorage").hidden && ![...G.doc.querySelectorAll("#viewHome .home-cap")].some(c => c.textContent === "Storage") && G.$("homeStorage").children.length === 0);

  const bad = [first, A, E, B, C, D, F, G].reduce((a, x) => a.concat(x.real()), []);
  check("no script errors on any device", bad.length === 0, bad.join(" | ").slice(0, 400));
  console.log(`\n${checks} checks · ${failures === 0 ? "ALL PASSED" : failures + " FAILED"}\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
