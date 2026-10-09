/* Programs: Open/Closed status (coaches set it), the Programs page ("All Programs" on Current Program), and opening the
 * app with nothing selected (coaches pick from Lifters, lifters from their Programs). Run: node test-programs.js
 *
 * Like test-sharedchat.js: each device is its own jsdom copy of app.html on one in-memory Postgres with
 * supabase/schema.sql (real row-level security). "Opening the app again" is a new page on the same device and storage.
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
const TOM_PEAK = csv("Tom", "Peak", [[1, 1, "Squat", 190, 2, 2, 8, ""], [1, 2, "Bench", 130, 3, 3, 8, ""]]);
const SAM = csv("Sam", "Base", [[1, 1, "Squat", 120, 5, 5, 7, ""]]);

(async () => {
  const server = await pgServer();

  function boot(label, store, dev) {
    dev = dev || server.device(label);
    const errors = [];
    const dom = new JSDOM(html, {
      runScripts: "dangerously", pretendToBeVisual: true,
      url: "https://example.github.io/power-logs/app.html",
      virtualConsole: new VirtualConsole().on("jsdomError", e => errors.push(e.message)).on("error", m => errors.push(String(m))),
      beforeParse(w) {
        w.__spotterCloud = dev;
        w.Chart = class { static defaults = { font: {} }; constructor() {} destroy() {} };
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
      storage() { const o = {}; for (let i = 0; i < w.localStorage.length; i++) { const k = w.localStorage.key(i); o[k] = w.localStorage.getItem(k); } return o; },
      active: () => (doc.querySelector(".view.active") || {}).id,
      navs: () => [...doc.querySelectorAll("#sideNav .nav-label")].map(n => n.textContent),
      tabs: () => [...doc.querySelectorAll("#tabBar .tb-item")].map(b => b.getAttribute("aria-label")),
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
      progRows: () => [...doc.querySelectorAll("#progsList .ll-item")].map(r => ({ title: r.querySelector(".msg-mid b").textContent, st: r.querySelector(".prog-st").textContent, btn: r.querySelector(".prog-st").tagName === "BUTTON", el: r })),
    };
    return app;
  }
  const rows = (sql, args) => server.sql(sql, args);
  const statusOf = async block => (await rows("select program->>'status' as st from public.lifters where program->>'block' = $1", [block]))[0].st;

  /* ------------------------------------------------------------ set-up */
  console.log("Set-up: the owner coaches Tom on two programs (Prep, Peak) and Sam; Tom signs in");
  const O = boot("owner");
  await tick(250);
  await O.load(TOM_PREP, "tom-prep.csv"); await O.load(TOM_PEAK, "tom-peak.csv"); await O.load(SAM, "sam.csv");
  await O.signIn(OWNER_EMAIL);
  O.$("confirmYes").click();
  await until(async () => (await rows("select count(*)::int n from public.lifters"))[0].n === 3);
  await O.settle();
  await rows("update public.lifters set lifter_email = 'tom@test.invalid' where name = 'Tom'");
  O.sync(); await O.settle();
  const T = boot("tom");
  await tick(250);
  await T.signIn("tom@test.invalid");
  T.sync(); await T.settle();

  /* ------------------------------------------------------------ status */
  console.log("\nA coach marks a program Open or Closed");
  O.pick(O.keyOf("Prep")); await tick(100);
  O.nav("Manage program"); await tick(150);
  const seg = () => O.$("dmStatus");
  check("Manage Program's Lifter & program card has Status: Open or Closed, Open to start", !!seg() && [...seg().querySelectorAll("button")].map(b => b.textContent).join() === "Open,Closed" && seg().querySelector(".active").textContent === "Open");
  seg().querySelector('[data-status="closed"]').click(); await tick(100);
  check("Closed is saved on the program and synced", seg().querySelector(".active").textContent === "Closed" && await until(async () => (await statusOf("Prep")) === "closed"), String(await statusOf("Prep")));
  check("...the other program stays Open", (await statusOf("Peak")) === null);

  console.log("\nAll Programs, from Current Program");
  O.nav("Current Program"); await tick(100);
  check("Current Program has an All Programs link beside Home", !O.$("ovPrograms").hidden && /All Programs/.test(O.$("ovPrograms").textContent) && !O.$("ovHome").hidden && O.$("ovPrograms").parentNode === O.$("ovHome").parentNode);
  O.$("ovPrograms").click(); await tick(150);
  check("it opens the Programs page", O.active() === "viewPrograms" && /^Programs$/.test(O.doc.querySelector("#viewPrograms h1").textContent));
  check("...listing Tom's two programs (not Sam's), each with its status", O.progRows().map(r => r.title + ":" + r.st).join() === "Prep:Closed,Peak:Open", O.progRows().map(r => r.title + ":" + r.st).join());
  check("a coach can tap a status to change it", O.progRows().every(r => r.btn));
  O.progRows()[1].el.querySelector(".prog-st").click(); await tick(100);
  check("...Peak is Closed now, here and on the server", O.progRows()[1].st === "Closed" && await until(async () => (await statusOf("Peak")) === "closed"));
  O.progRows()[1].el.querySelector(".prog-st").click(); await tick(100);
  check("...and Open again", O.progRows()[1].st === "Open" && await until(async () => (await statusOf("Peak")) === null));
  O.progRows()[1].el.querySelector(".msg-thread").click(); await tick(150);
  check("tapping a program opens it", O.active() === "viewOverview" && O.$("lifterSelect").value === O.keyOf("Peak"));
  O.$("ovPrograms").click(); await tick(100);
  O.$("progsBack").click(); await tick(100);
  check("Back from Programs returns to Current Program", O.active() === "viewOverview");

  console.log("\nThe Lifters page: one card per lifter");
  O.nav("Lifters"); await tick(150);
  const cards = () => [...O.doc.querySelectorAll("#liftersBody .ll-item")].map(r => ({ name: r.querySelector(".msg-mid b").childNodes[0].textContent, sub: r.querySelector(".msg-mid > span").textContent, more: !!r.querySelector(".ll-more"), dot: !!r.querySelector(".pres-dot"), el: r }));
  check("Tom's two programs are one card, Sam (not signed in) another", cards().map(c => c.name).join() === "Tom,Sam", cards().map(c => c.name).join());
  check("Tom's card says 2 programs, how many are open, and has no ⋯ (each program has its own on Programs)", /2 programs · 1 open/.test(cards()[0].sub) && !cards()[0].more, cards()[0].sub);
  check("Sam's card is his one program, with its ⋯", /Base/.test(cards()[1].sub) && cards()[1].more);
  check("only signed-in lifters get an online dot (shown to the owner)", cards()[0].dot && !cards()[1].dot);
  check("the subtitle counts lifters, not programs", /^2 lifters/.test(O.$("liftersSub").textContent), O.$("liftersSub").textContent);
  cards()[0].el.querySelector(".msg-thread").click(); await tick(150);
  check("tapping Tom opens his Programs page to choose one", O.active() === "viewPrograms" && O.progRows().length === 2);
  check("...where each program has its own ⋯", O.progRows().every(r => !!r.el.querySelector(".ll-more")));
  O.progRows()[0].el.querySelector(".ll-more").click(); await tick(100);
  check("...offering Delete program / Delete lifter for that program", O.$("troFormScrim").classList.contains("show") && !!O.btn("Delete program", O.$("troFormBody")) && !!O.btn("Delete lifter", O.$("troFormBody")));
  O.$("troFormClose").click(); await tick(50);
  O.nav("Lifters"); await tick(100);
  cards()[1].el.querySelector(".msg-thread").click(); await tick(150);
  check("a lifter with one program goes there too", O.active() === "viewPrograms" && O.progRows().map(r => r.title).join() === "Base");

  console.log("\nThe lifter sees the status, and can't change it");
  T.sync(); await T.settle();
  T.pick(T.keyOf("Prep")); await tick(100);
  T.nav("Current Program"); await tick(100);
  T.$("ovPrograms").click(); await tick(150);
  check("Tom's Programs page lists both, Prep Closed and Peak Open", T.progRows().map(r => r.title + ":" + r.st).sort().join() === "Peak:Open,Prep:Closed", T.progRows().map(r => r.title + ":" + r.st).join());
  check("...as labels, not buttons", T.progRows().every(r => !r.btn));
  check("Manage Program isn't his, so there's no other way to change it", !T.navs().includes("Manage program"));

  /* ------------------------------------------------------------ opening the app */
  console.log("\nOpening the app again: nothing selected");
  const O2 = boot("owner again", O.storage(), O.dev);
  await tick(400); await O2.settle();
  check("the coach lands on Home with no lifter chosen", O2.active() === "viewHome" && O2.$("lifterSelect").value === "" && /Select a lifter/.test(O2.$("lifterSelect").options[0].textContent), O2.active() + " / " + O2.$("lifterSelect").value);
  check("...even after the first sync", (O2.sync(), await O2.settle(), O2.$("lifterSelect").value === ""));
  check("Current Program and Lifter's Analytics are still in the menu and the bar", ["Current Program", "Lifter’s Analytics"].every(n => O2.navs().includes(n)) && ["Current Program", "Lifter’s Analytics"].every(n => O2.tabs().includes(n)), O2.navs().join() + " | " + O2.tabs().join());
  O2.nav("Current Program"); await tick(150);
  check("for a coach they open the Lifters page to choose one", O2.active() === "viewLifters", O2.active());
  O2.nav("Home"); await tick(50);
  O2.nav("Lifter’s Analytics"); await tick(150);
  check("...Lifter's Analytics too", O2.active() === "viewLifters");
  O2.pick(O2.keyOf("Peak")); await tick(150);
  check("choosing one from the dropdown works as before", O2.active() === "viewOverview" && O2.$("lifterSelect").value === O2.keyOf("Peak") && !/Select a lifter/.test(O2.$("lifterSelect").textContent));

  const T2 = boot("tom again", T.storage(), T.dev);
  await tick(400); await T2.settle();
  check("the lifter opens with no program chosen either", T2.$("lifterSelect").value === "" && /Select a program/.test(T2.$("lifterSelect").options[0].textContent), T2.$("lifterSelect").value);
  T2.nav("Current Program"); await tick(150);
  check("for a lifter Current Program opens their Programs page", T2.active() === "viewPrograms" && T2.progRows().length === 2, T2.active());
  check("...where Back goes Home (nothing chosen yet)", T2.$("progsBackTx").textContent === "Home");
  T2.nav("Home"); await tick(50);
  T2.nav("Lifter’s Analytics"); await tick(150);
  check("...and so does Lifter's Analytics", T2.active() === "viewPrograms");
  T2.progRows().find(r => r.title === "Peak").el.querySelector(".msg-thread").click(); await tick(150);
  check("choosing one opens it, as before", T2.active() === "viewOverview" && T2.$("lifterSelect").value === T2.keyOf("Peak"));

  check("no script errors", [O, T, O2, T2].every(a => a.real().length === 0), [O, T, O2, T2].map(a => a.real().join(" | ")).join(" // "));
  console.log(`\n${checks} checks · ${failures ? failures + " FAILED" : "ALL PASSED"}`);
  process.exit(failures ? 1 : 0);
})();
