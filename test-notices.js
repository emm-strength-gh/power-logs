/* In-app notices: the banner that says what happened while you were away.
 * Run: node test-notices.js
 *
 * Like test-trophysync.js: a coach and a lifter, each a jsdom copy of
 * app.html on one in-memory Postgres with the real rules.
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
  C.sync(); await tick(1800); await C.settle();
  for (const a of [L, C]) {
    a.$("acctBtn").click(); await tick();
    a.btn("Turn on for this device", a.$("acctBody")).click();
    await until(() => a.$("acctBody").querySelector(".acct-check"));
    a.closeSheet();
  }

  // Signed in, everyone (coach or lifter) reads them in the Notifications card on Home.
  const bar = a => a.$("homeNotices");
  const empty = a => a.doc.querySelectorAll("#homeNotices .nt-row").length === 0;
  const rowsOf = a => [...bar(a).querySelectorAll(".nt-row")];
  const titles = a => rowsOf(a).map(r => r.querySelector("b").textContent);
  const stored = a => (a.store("spotter.notices.v1") || { list: [] }).list;
  const lifterId = tomId;

  /* ---------------------------------------------------------- quiet to start */
  console.log("Nothing to say yet");
  check("no banner when nothing has happened", empty(C) && empty(L) && rowsOf(C).length === 0);
  check("a coach's card says they're all caught up", /all caught up/.test(C.$("homeNotices").textContent) && C.$("noticeBar").hidden);
  check("signed in, notices are the Notifications card on Home, for coach and lifter alike", !!C.$("homeNotices").closest("#viewHome") && L.$("noticeBar").hidden && C.$("noticeBar").hidden);

  /* ----------------------------------------------------------- messages */
  console.log("\nA message");
  L.nav("Messages"); await tick(150);
  const send = async (a, text) => { a.$("msgInput").value = text; a.$("msgInput").dispatchEvent(new a.w.Event("input")); a.btn("Send", a.$("msgBody")).click(); await tick(150); };
  await send(L, "Knee felt fine today");
  C.sync(); await tick(1800); await C.settle();
  check("the coach sees it as a banner, with who and what", titles(C).length === 1 && /Tom: Knee felt fine today/.test(titles(C)[0]), titles(C).join("|"));
  check("...with how long ago", /just now|min ago/.test(rowsOf(C)[0].textContent));
  check("it has an x to close it", !!rowsOf(C)[0].querySelector('button.nt-x[aria-label="Dismiss"]'));
  rowsOf(C)[0].querySelector(".nt-x").click(); await tick(50);
  check("x closes it, and it stays closed", empty(C) && stored(C).length === 0);
  C.sync(); await tick(1800); await C.settle();
  check("...even after another sync", empty(C));
  check("the sender isn't told about their own message", empty(L));

  await send(L, "Also: is Thursday heavy?");
  await send(L, "And can I swap deadlifts to Friday?");
  C.sync(); await tick(1800); await C.settle();
  check("two more become one row, not two", titles(C).length === 1 && titles(C)[0] === "2 new messages", titles(C).join("|"));
  check("...showing the latest", /Latest: Tom: And can I swap/.test(rowsOf(C)[0].textContent));
  rowsOf(C)[0].querySelector(".nt-main").click(); await tick(200);
  check("tapping it opens that conversation and clears the banner", C.$("viewMessages").classList.contains("active") && empty(C));
  C.nav("Overview"); await tick(50);

  console.log("\nMessages that get read elsewhere");
  await send(L, "One more thing");
  C.sync(); await tick(1800); await C.settle();
  check("a new one shows", titles(C).length === 1);
  C.nav("Messages"); await tick(200);
  check("opening Messages (reading it) clears it", empty(C) && stored(C).length === 0, titles(C).join("|"));
  await send(L, "Typed while you're looking");
  C.sync(); await tick(1800); await C.settle();
  check("a message that arrives while you're reading that thread makes no banner", empty(C));
  C.nav("Overview"); await tick(50);

  /* ----------------------------------------------------- finished days */
  console.log("\nFinished days");
  L.nav("Week 1"); await tick(150);
  const markAll = a => [...a.doc.querySelectorAll(".day-alldone")].filter(b => /Mark all done/.test(b.textContent));
  markAll(L)[0].click(); await tick(300);
  L.sync(); await tick(1800); await L.settle();
  C.sync(); await tick(1800); await C.settle();
  check("a finished day reaches the coach", titles(C).length === 1 && /Tom finished week 1 · day 1/.test(titles(C)[0]), titles(C).join("|"));
  markAll(L)[0].click(); await tick(300);
  L.sync(); await tick(1800); await L.settle();
  C.sync(); await tick(1800); await C.settle();
  check("a second day joins it as one row", titles(C).filter(x => /finished/.test(x)).join() === "Tom finished 2 days", titles(C).join("|"));
  check("the lifter doesn't get banners for their own ticks", empty(L));
  C.nav("Week 1"); await tick(150);
  check("opening that week clears them", !titles(C).some(x => /finished/.test(x)), titles(C).join("|"));
  C.nav("Overview"); await tick(50);

  /* ------------------------------------------------------- weekly notes */
  console.log("\nWeekly notes: who wrote it");
  await C.dev.upsert("lifter_week_notes", [{ lifter_id: lifterId, week: "1", body: "Great bar speed this week" }], "lifter_id,week");
  L.sync(); await tick(1800); await L.settle();
  check("the lifter is told a coach wrote one", titles(L).length === 1 && /^Coach owner added a note to week 1$/.test(titles(L)[0]), titles(L).join("|"));
  await L.dev.upsert("lifter_week_notes", [{ lifter_id: lifterId, week: "2", body: "Felt heavy" }], "lifter_id,week");
  C.sync(); await tick(1800); await C.settle();
  check("the coach is told the lifter wrote one, and that it's the lifter", titles(C).some(x => /^Tom \(lifter\) added a note to week 2$/.test(x)), titles(C).join("|"));
  rowsOf(C).find(r => /note to week 2/.test(r.textContent)).querySelector(".nt-main").click(); await tick(200);
  check("tapping it opens that week", C.$("viewWeek").classList.contains("active") && /Week 2/.test(C.$("viewWeek").textContent) && !titles(C).some(x => /note to week 2/.test(x)));
  C.nav("Overview"); await tick(50);

  /* ---------------------------------------------------- weeks and days */
  console.log("\nA coach adds weeks and days");
  C.nav("Manage program"); await tick(100);
  C.btn("Add week", C.$("dmBody")).click(); await tick(200);
  C.sync(); await tick(1800); await C.settle();
  L.sync(); await tick(1800); await L.settle();
  check("the lifter is told a week was added", titles(L).some(x => /Your coach added week 3/.test(x)), titles(L).join("|"));
  check("the coach isn't told about their own edit", !titles(C).some(x => /added week/.test(x)));
  L.nav("Week 3"); await tick(150);
  check("opening the week clears it", !titles(L).some(x => /week 3/.test(x)));

  /* ----------------------------------------------------------- trophies */
  console.log("\nTrophies");
  L.nav("Overview"); L.nav("Trophies"); await tick(200);
  L.doc.querySelector('.tro-form [data-sex="m"]').click();
  L.$("troBw").value = "82";
  L.btn("Save", L.$("troBody")).click();
  await tick(400);
  L.sync(); await tick(1800); await L.settle();
  C.sync(); await tick(1800); await C.settle();
  check("the coach is told Tom earned a trophy, and which", titles(C).some(x => /Tom earned a trophy: /.test(x)) || titles(C).some(x => /new trophies/.test(x)), titles(C).join("|"));
  C.nav("Overview"); C.nav("Trophies"); await tick(200);
  check("opening Trophies clears them", !titles(C).some(x => /trophy|trophies/.test(x)));
  C.btn("Give an award", C.$("troBody")).click(); await tick(50);
  C.$("troAwardKind").value = "podium"; C.btn("Give award", C.$("troFormBody")).click(); await tick(200);
  C.sync(); await tick(1800); await C.settle();
  L.nav("Overview"); await tick(50);
  L.sync(); await tick(1800); await L.settle(); await tick(300);
  await L.dismiss();
  check("the lifter is told a coach gave an award", titles(L).some(x => /^owner gave you an award: Podium$/.test(x)), titles(L).join("|"));

  /* --------------------------------------- away for days: stacking */
  console.log("\nAway for days: they stack");
  C.nav("Overview"); await tick(50);
  for (const m of ["a", "b", "c"]) await send(L, "msg " + m);
  await L.dev.upsert("lifter_week_notes", [{ lifter_id: lifterId, week: "3", body: "Week three note" }], "lifter_id,week");
  L.nav("Week 2"); await tick(100);
  [...L.doc.querySelectorAll(".day-alldone")].filter(b => /Mark all done/.test(b.textContent)).forEach(b => b.click());
  await tick(300);
  L.sync(); await tick(1800); await L.settle();
  C.sync(); await tick(1800); await C.settle();
  const n = titles(C).length;
  check("a pile from several kinds becomes a few rows, newest first", n >= 1 && n <= 3, titles(C).join("|"));
  check("...with a count, and Clear all", /updates/.test(bar(C).textContent) && !!C.btn("Clear all", bar(C)));
  // Make four groups to prove the fold.
  const fake = (k, i, extra) => Object.assign({ id: "x" + k + i, kind: k, lifter: lifterId, who: "x", text: "Fake " + k + " " + i, at: new Date(Date.now() - (i * 86400000 + 3600000)).toISOString() }, extra || {});
  const seed = { list: [fake("msg", 1, { thread: "team" }), fake("session", 2, { week: "1" }), fake("trophy", 3), fake("program", 4, { week: "3" }), fake("note", 5, { week: "2" })], base: { msgs: true, events: true, notes: true } };
  if (C.btn("Clear all", bar(C))) C.btn("Clear all", bar(C)).click(); else if (rowsOf(C).length) rowsOf(C)[0].querySelector(".nt-x").click();
  await tick(100);
  const D = boot("coach again", { dev: C.dev, storage: Object.assign(C.storage(), { "spotter.notices.v1": JSON.stringify(seed) }) });
  await tick(500);
  check("after days away: 5 kinds, only 3 rows showing", D.doc.querySelectorAll("#homeNotices .nt-row").length === 3, String(D.doc.querySelectorAll("#homeNotices .nt-row").length));
  check("the newest is first, with how long ago", /Fake msg 1/.test(D.doc.querySelector("#homeNotices .nt-row").textContent) && /yesterday/.test(D.doc.querySelector("#homeNotices .nt-row").textContent), D.doc.querySelector("#homeNotices .nt-row").textContent);
  check("the rest are one tap away", !!D.btn("Show 2 more", D.$("homeNotices")));
  D.btn("Show 2 more", D.$("homeNotices")).click(); await tick(50);
  const txt = D.$("homeNotices").textContent;
  check("Show more reveals them, newest to oldest, and Show less folds them again", D.doc.querySelectorAll("#homeNotices .nt-row").length === 5 && !!D.btn("Show less", D.$("homeNotices")) &&
    ["Fake msg 1", "Fake session 2", "Fake trophy 3", "Fake program 4", "Fake note 5"].map(s => txt.indexOf(s)).every((p, i, a) => p >= 0 && (i === 0 || p > a[i - 1])), txt);
  check("older ones say how many days ago", /5 days ago/.test(txt));
  D.btn("Clear all", D.$("homeNotices")).click(); await tick(100);
  check("Clear all empties the banner", D.doc.querySelectorAll("#homeNotices .nt-row").length === 0 && (D.store("spotter.notices.v1").list || []).length === 0);

  const bad = [C, L, D].reduce((a, x) => a.concat(x.real()), []);
  check("no script errors on any device", bad.length === 0, bad.join(" | ").slice(0, 400));
  console.log(`\n${checks} checks · ${failures === 0 ? "ALL PASSED" : failures + " FAILED"}\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
