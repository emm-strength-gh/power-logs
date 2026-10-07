/* Trophies across devices: what a lifter earns reaches their coach, a coach's
 * confirmation and awards reach the lifter, and the notifications that go with them.
 * Run: node test-trophysync.js
 *
 * Like test-messaging.js: each device is its own jsdom copy of app.html on
 * one in-memory Postgres running supabase/schema.sql (real row-level security),
 * with the notify Edge Function in-process.
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

  function boot(label, reuse) {
    const dev = reuse ? reuse.dev : server.device(label), errors = [], push = { sub: null };
    const dom = new JSDOM(html, {
      runScripts: "dangerously", pretendToBeVisual: true,
      url: "https://example.github.io/power-logs/app.html",
      virtualConsole: new VirtualConsole().on("jsdomError", e => errors.push(e.message)).on("error", m => errors.push(String(m))),
      beforeParse(w) {
        w.__spotterCloud = dev;
        if (reuse) Object.entries(reuse.storage).forEach(([k, v]) => w.localStorage.setItem(k, v));
        const reg = { addEventListener() {}, pushManager: {
          getSubscription: async () => push.sub,
          subscribe: async () => { push.sub = { endpoint: "https://push.test/" + label.replace(/\s/g, "-"), toJSON() { return { endpoint: this.endpoint, keys: { p256dh: "p-" + label, auth: "a-" + label } }; }, unsubscribe: async () => true }; return push.sub; },
        } };
        Object.defineProperty(w.navigator, "serviceWorker", { configurable: true, value: { ready: Promise.resolve(reg), register: async () => reg, controller: null, addEventListener() {} } });
        w.PushManager = function () {};
        w.Notification = { permission: "default", requestPermission: async () => (w.Notification.permission = "granted") };
        w.HTMLCanvasElement.prototype.getContext = function () {
          const g = { addColorStop() {} };
          return new Proxy({}, { get: (t, p) => p === "measureText" ? s => ({ width: String(s).length * 20 }) : (p === "createLinearGradient" || p === "createRadialGradient") ? () => g : (t[p] !== undefined ? t[p] : function () {}), set: (t, p, v) => { t[p] = v; return true; } });
        };
        w.HTMLCanvasElement.prototype.toBlob = function (cb) { cb(new w.Blob(["png"], { type: "image/png" })); };
        w.Path2D = function () {};
      },
    });
    const w = dom.window, doc = w.document, $ = id => doc.getElementById(id);
    w.Element.prototype.scrollIntoView = function () {};
    w.scrollTo = function () {};
    const app = {
      label, dev, w, doc, $, push,
      real: () => errors.filter(e => !/Not implemented|HTMLCanvasElement|getContext|Chart is not defined/i.test(e)),
      store: k => JSON.parse(w.localStorage.getItem(k) || "null"),
      tro: name => (JSON.parse(w.localStorage.getItem("spotter.trophies.v1") || "{}"))[name] || { earned: {}, prs: [], prefs: {} },
      nav(label) { const b = [...doc.querySelectorAll("#sideNav .nav-item")].find(n => n.querySelector(".nav-label").textContent === label); if (b) b.click(); return !!b; },
      btn: (text, root) => [...(root || doc).querySelectorAll("button")].find(b => b.textContent.trim() === text),
      item: id => doc.querySelector(`.tro-item[data-trophy="${id}"]`),
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
      storage: () => { const o = {}; for (let i = 0; i < w.localStorage.length; i++) { const k = w.localStorage.key(i); o[k] = w.localStorage.getItem(k); } return o; },
      async dismiss() { while ($("troScrim").classList.contains("show")) { $("troClose").click(); await tick(300); } },
    };
    return app;
  }
  const pushesTo = label => server.pushes.filter(p => p.endpoint.endsWith(label.replace(/\s/g, "-")));
  const rows = (sql, args) => server.sql(sql, args);

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
  const tomId = (await rows("select id from public.lifters where name = 'Tom'"))[0].id;
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
  C.sync(); await C.settle();
  for (const a of [L, C]) {
    a.$("acctBtn").click(); await tick();
    a.btn("Turn on for this device", a.$("acctBody")).click();
    await until(() => a.$("acctBody").querySelector(".acct-check"));
    a.closeSheet();
  }
  const optsOf = a => { a.$("acctBtn").click(); const t = [...a.$("acctBody").querySelectorAll(".acct-check span")].map(s => s.textContent); a.closeSheet(); return t; };
  check("both can choose to hear about trophies", optsOf(L).some(t => /trophy/i.test(t)) && optsOf(C).some(t => /trophy/i.test(t)), optsOf(L).join() + " / " + optsOf(C).join());

  /* ------------------------------------------------ the lifter earns some */
  console.log("\nTom sets his standards and earns a lot at once");
  L.nav("Trophies"); await tick(200);
  check("his Trophies page opens, asking for standards", L.$("viewTrophies").classList.contains("active") && /Set your standards/.test(L.$("troBody").textContent));
  check("nothing is sent before there is something to send", (await rows("select count(*)::int n from public.lifter_trophies"))[0].n === 0);
  L.doc.querySelector('.tro-form [data-sex="m"]').click();
  L.$("troBw").value = "82";
  L.btn("Save", L.$("troBody")).click();
  await tick(400);
  const mine = Object.keys(L.tro("Tom").earned);
  check("his device recorded them", mine.includes("lvl:squat:advanced") && mine.includes("total:500"), mine.length + " trophies");
  L.sync(); await L.settle();
  const inDb = (await rows("select trophy, cls, note, awarded_by from public.lifter_trophies where lifter_id = $1", [tomId]));
  check("they reach the database, all of them", inDb.length === mine.length, inDb.length + " of " + mine.length);
  check("...with the class at the time and what earned each", inDb.every(r => r.cls === "Men’s 83 kg") && inDb.find(r => r.trophy === "lvl:squat:advanced").note.indexOf("172.5") !== -1);
  check("...and none credited to a coach", inDb.every(r => r.awarded_by === null));
  check("his standards are saved for his coaches too", await until(async () => { const s = (await rows("select sex, bodyweight::float8 bw from public.lifter_settings where lifter_id = $1", [tomId]))[0]; return s && s.sex === "m" && s.bw === 82; }));
  check("each one is announced once, in the Inbox", (await rows("select count(*)::int n from public.lifter_events where kind = 'trophy' and lifter_id = $1", [tomId]))[0].n === mine.length);
  check("the coach gets one banner, naming Tom but not what he earned", await until(() => pushesTo("coach").filter(p => p.body === "Tom earned a trophy").length === 1), JSON.stringify(pushesTo("coach").map(p => p.body)));
  check("...that opens his trophies", pushesTo("coach").some(p => p.url.includes("open=trophies&lifter=" + tomId)));
  check("Tom's own phone isn't notified about his own trophies", pushesTo("lifter").length === 0);

  console.log("\nThe coach sees them");
  C.sync(); await C.settle();
  C.nav("Trophies"); await tick(300);
  check("the shelf matches, with dates", C.item("lvl:squat:advanced") && C.item("lvl:squat:advanced").classList.contains("earned") && /20\d\d/.test(C.item("lvl:squat:advanced").textContent), C.item("lvl:squat:advanced") && C.item("lvl:squat:advanced").textContent);
  check("the coach reads Tom's standards, without setting them", /Men’s 83 kg/.test(C.$("troSub").textContent) && /Overall level/.test(C.$("troBody").textContent), C.$("troSub").textContent);
  check("the coach isn't shown Tom's trophies as new, or celebrated", !C.item("lvl:squat:advanced").classList.contains("fresh") && !C.$("troScrim").classList.contains("show"));
  check("the coach has no earned trophies of their own recorded for him", Object.keys(C.tro("Tom").earned).every(k => C.tro("Tom").earned[k].sent === true));
  C.nav("Inbox"); await tick(100);
  check("the Inbox mentions the trophy", /🏆|🏆/.test(C.$("inboxBody").textContent), C.$("inboxBody").textContent);

  /* ----------------------------------------------------------- PRs */
  console.log("\nA PR waits for the coach");
  L.nav("Overview"); L.nav("Trophies"); await tick(150);
  L.btn("Log a PR", L.$("troBody")).click(); await tick(50);
  check("Tom is told his coach confirms it", /Your coach confirms it/.test(L.$("troFormBody").textContent));
  L.doc.querySelector('.tro-form [data-lift="squat"]').click();
  L.$("troPrKg").value = "180"; L.btn("Log PR", L.$("troFormBody")).click(); await tick(300);
  L.sync(); await L.settle();
  const pr = (await rows("select lift, kg::float8 kg, confirmed_by from public.lifter_prs where lifter_id = $1", [tomId]))[0];
  check("it reaches the database, unconfirmed", pr && pr.lift === "squat" && pr.kg === 180 && pr.confirmed_by === null, JSON.stringify(pr));
  check("on his page it says waiting", /Waiting for coach/.test(L.$("troBody").textContent));
  check("...and doesn't count yet", !L.tro("Tom").earned["pr:1"]);
  C.sync(); await C.settle();
  C.nav("Overview"); C.nav("Trophies"); await tick(200);
  check("the coach sees it with Confirm and Remove", /Waiting for coach/.test(C.$("troBody").textContent) && !!C.btn("Confirm", C.$("troBody")) && !!C.btn("Remove", C.$("troBody")));
  C.btn("Confirm", C.$("troBody")).click(); await tick(200);
  C.sync(); await C.settle();
  const pr2 = (await rows("select confirmed_by, confirmed_at from public.lifter_prs where lifter_id = $1", [tomId]))[0];
  check("confirming is saved, by the coach", !!pr2.confirmed_by && !!pr2.confirmed_at);
  L.sync(); await L.settle();
  L.nav("Overview"); L.nav("Trophies"); await tick(300);
  check("Tom now sees it confirmed", /Squat · 180 kg/.test(L.$("troBody").textContent) && /Confirmed/.test(L.$("troBody").textContent), L.$("troBody").textContent.slice(0, 500));
  check("his first-PR trophy unlocks", !!L.tro("Tom").earned["pr:1"]);
  await L.dismiss();
  L.sync(); await L.settle();
  check("...and reaches the coach", await until(async () => (await rows("select count(*)::int n from public.lifter_trophies where trophy = 'pr:1'"))[0].n === 1));

  /* ----------------------------------------------------------- awards */
  console.log("\nThe coach gives an award");
  C.sync(); await C.settle();
  C.nav("Overview"); C.nav("Trophies"); await tick(200);
  C.btn("Give an award", C.$("troBody")).click(); await tick(50);
  C.$("troAwardKind").value = "podium"; C.$("troAwardNote").value = "Third in the 83s"; C.btn("Give award", C.$("troFormBody")).click(); await tick(200);
  C.sync(); await C.settle();
  const aw = (await rows("select trophy, note, awarded_by, a.email from public.lifter_trophies t left join public.accounts a on a.user_id = t.awarded_by where trophy = 'award:podium'"))[0];
  check("it's in the database, from the coach", aw && aw.email === OWNER_EMAIL && aw.note === "Third in the 83s", JSON.stringify(aw));
  check("the coach isn't badged for an award they gave", !(() => { const n = [...C.doc.querySelectorAll("#sideNav .nav-item")].find(x => /Trophies/.test(x.textContent)); return !!(n && n.querySelector(".nav-badge")); })());
  check("Tom's phone gets a banner naming the coach", await until(() => pushesTo("lifter").some(p => /gave you a trophy/.test(p.body))), JSON.stringify(pushesTo("lifter").map(p => p.body)));
  L.nav("Overview"); await tick(100);
  L.sync(); await L.settle(); await tick(300);
  check("a badge shows on Trophies for the new award", (() => { const n = [...L.doc.querySelectorAll("#sideNav .nav-item")].find(x => /Trophies/.test(x.textContent)); return !!(n && n.querySelector(".nav-badge")); })() || L.$("troScrim").classList.contains("show"));
  check("...and it's celebrated: Tom is shown it", await until(() => L.$("troScrim").classList.contains("show") && L.$("troTitle").textContent === "Award"), L.$("troTitle").textContent);
  check("a lifter can't take back an award", L.$("troTakeBack").hidden);
  await L.dismiss();

  console.log("\nThe coach takes it back");
  C.nav("Trophies"); await tick(150);
  C.item("award:podium").click(); await tick(150);
  C.$("troTakeBack").click(); await tick(200);
  C.sync(); await C.settle();
  check("it's gone from the database", await until(async () => (await rows("select count(*)::int n from public.lifter_trophies where trophy = 'award:podium'"))[0].n === 0));
  const L2 = boot("lifter reopened", { dev: L.dev, storage: L.storage() });
  await tick(400);
  L2.sync(); await L2.settle();
  check("...and from Tom's phone the next time it's opened", !L2.tro("Tom").earned["award:podium"], Object.keys(L2.tro("Tom").earned).filter(k => /award/.test(k)).join());
  check("while everything he earned himself stays", !!L2.tro("Tom").earned["lvl:squat:advanced"] && !!L2.tro("Tom").earned["pr:1"]);

  /* ------------------------------------------------------ standards by coach */
  console.log("\nStandards and bodyweight");
  C.nav("Overview"); C.nav("Trophies"); await tick(150);
  C.btn("Edit", C.$("troBody")).click(); await tick(50);
  C.$("troBw").value = "89"; C.btn("Save", C.$("troFormBody")).click(); await tick(300);
  C.sync(); await C.settle();
  check("a coach can update the lifter's bodyweight", await until(async () => (await rows("select bodyweight::float8 bw from public.lifter_settings where lifter_id = $1", [tomId]))[0].bw === 89));
  L2.sync(); await L2.settle();
  L2.nav("Trophies"); await tick(200);
  check("Tom's class follows (93 kg)", /Men’s 93 kg/.test(L2.$("troSub").textContent), L2.$("troSub").textContent);
  check("...and what he earned in the 83s keeps its class", L2.tro("Tom").earned["lvl:squat:advanced"].cls === "Men’s 83 kg");

  /* ------------------------------------------------------- failures stay local */
  console.log("\nA problem with trophies never holds up the training log");
  await server.sql("revoke select on public.lifter_trophies from authenticated");
  L2.nav("Week 1"); await tick(100);
  const dayBtn = [...L2.doc.querySelectorAll(".day-alldone")].find(b => /Mark all done/.test(b.textContent));
  dayBtn.click(); await tick(300);
  L2.sync(); await L2.settle();
  const cs = L2.store("spotter.cloud.v1");
  const marksNow = async () => (await rows("select count(*)::int n from public.lifter_marks where state = 'done'"))[0].n;
  await until(async () => (await marksNow()) >= 2, 10000);
  const marks = await marksNow();
  check("the ticks still sync, with the log's status clear", cs.lastError === "" && marks >= 2, "lastError=" + cs.lastError + " marks=" + marks + " buttons=" + L2.doc.querySelectorAll(".day-alldone").length);
  await server.sql("grant select on public.lifter_trophies to authenticated");

  const bad = [C, L, L2].reduce((a, x) => a.concat(x.real()), []);
  check("no script errors on any device", bad.length === 0, bad.join(" | ").slice(0, 400));
  console.log(`\n${checks} checks · ${failures === 0 ? "ALL PASSED" : failures + " FAILED"}\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
