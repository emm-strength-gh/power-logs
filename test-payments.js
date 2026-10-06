/* Payments and the lifter's Home, end to end on the real database rules.
 * Run: node test-payments.js
 *
 * A coach (the owner) creates Tom and shares him; Tom signs in. Each device is a
 * jsdom copy of power-logs.html on one in-memory Postgres (supabase/schema.sql).
 */
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");
const { pgServer, OWNER_EMAIL, GOOD_CODE } = require("./test-cloudfake");

const html = fs.readFileSync(path.join(__dirname, "power-logs.html"), "utf8");
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
      url: "https://example.github.io/power-logs/power-logs.html",
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
  const active = a => [...a.doc.querySelectorAll(".view.active")].map(v => v.id).join();
  const homeBtn = (a, title) => [...a.doc.querySelectorAll("#viewHome .analytics-btn")].find(b => b.querySelector(".ab-title").textContent === title);
  const payRows = async () => rows("select month, paid, removed, paid_on::text, amount::float8 amount, currency, a.email from public.lifter_payments p left join public.accounts a on a.user_id = p.updated_by order by month");
  const now = new Date(), MK = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0");
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1), PK = prev.getFullYear() + "-" + String(prev.getMonth() + 1).padStart(2, "0");
  const month = (a, k) => a.doc.querySelector('#payMonths [data-month="' + k + '"]');

  /* ------------------------------------------------------------ the coach */
  console.log("\nThe coach's Payments card");
  C.$("ovHome") && !C.$("ovHome").hidden ? C.$("ovHome").click() : C.nav("Home");
  await tick(100);
  check("Home has a Payments card below Messages (and the owner's Storage under it)", [...C.doc.querySelectorAll("#viewHome .home-cap")].map(c => c.textContent).join() === "Notifications,Lifters,Messages,Payments,Storage");
  check("...saying how many have paid this month", /: 0 of 1 paid/.test(homeBtn(C, "Payments").textContent), homeBtn(C, "Payments").textContent);
  homeBtn(C, "Payments").click(); await tick(100);
  check("it opens the Payments page", active(C) === "viewPayments");
  check("listing the lifters this coach created, unpaid by default", /Tom/.test(C.$("payList").textContent) && /Unpaid/.test(C.$("payList").textContent));
  C.$("payList").querySelector('[data-lifter="Tom"]').click(); await tick(100);
  check("a lifter shows the last twelve months, newest first", C.$("payMonths").querySelectorAll("[data-month]").length === 12 && C.$("payMonths").querySelector("[data-month]").getAttribute("data-month") === MK);
  check("...every one unpaid until marked", [...C.$("payMonths").querySelectorAll(".pay-pill")].every(p => p.textContent === "Unpaid"));
  check("the coach chooses the currency: pesos, pounds or dollars", [...C.$("payBody").querySelectorAll(".pay-cur [data-cur]")].map(b => b.getAttribute("data-cur")).join() === "PHP,GBP,USD");

  console.log("\nMarking a month paid");
  month(C, MK).click(); await tick(50);
  check("tapping a month opens its editor", C.$("troFormScrim").classList.contains("show") && !!C.$("payOn") && !!C.$("payAmount"));
  check("...Unpaid selected, the day and amount hidden", C.$("troFormBody").querySelector('[data-paid="0"]').classList.contains("active") && C.$("payOn").closest("div").hidden);
  C.$("troFormBody").querySelector('[data-paid="1"]').click();
  check("choosing Paid shows the day (today, for this month) and amount", !C.$("payOn").closest("div").hidden && C.$("payOn").value === MK + "-" + String(now.getDate()).padStart(2, "0"), C.$("payOn").value);
  C.$("payOn").value = MK + "-03";
  C.$("troFormBody").querySelector('.seg [data-cur="GBP"]').click();
  C.$("payAmount").value = "abc";
  C.btn("Save", C.$("troFormBody")).click(); await tick(50);
  check("a non-number amount is refused", C.$("troFormScrim").classList.contains("show") || C.$("payAmount").value === "");
  C.$("payAmount").value = "45.5";
  C.btn("Save", C.$("troFormBody")).click(); await tick(100);
  check("saved: the month shows Paid, the day and the amount", /Paid/.test(month(C, MK).textContent) && /3 \w+ \d{4}/.test(month(C, MK).textContent) && /£45\.50/.test(month(C, MK).textContent), month(C, MK).textContent);
  C.sync(); await tick(1500); await C.settle();
  const r1 = (await payRows())[0];
  check("it reaches the database, as that coach", r1 && r1.month === MK && r1.paid === true && r1.paid_on === MK + "-03" && r1.amount === 45.5 && r1.currency === "GBP" && r1.email === OWNER_EMAIL, JSON.stringify(r1));
  month(C, PK).click(); await tick(50);
  C.$("troFormBody").querySelector('[data-paid="1"]').click();
  check("next time the last amount is offered", C.$("payAmount").value === "45.5");
  check("...and a past month defaults to its 1st", C.$("payOn").value === PK + "-01", C.$("payOn").value);
  C.$("payAmount").value = "";
  C.btn("Save", C.$("troFormBody")).click(); await tick(100);
  check("the amount is optional", /Paid/.test(month(C, PK).textContent) && !/£/.test(month(C, PK).textContent), month(C, PK).textContent);
  month(C, PK).click(); await tick(50);
  C.$("troFormBody").querySelector('[data-paid="0"]').click();
  C.btn("Save", C.$("troFormBody")).click(); await tick(100);
  check("a month can be set back to unpaid", /Unpaid/.test(month(C, PK).textContent));
  C.sync(); await tick(1500); await C.settle();
  const r2 = (await payRows()).find(r => r.month === PK);
  check("...in the database too", r2 && r2.paid === false && r2.amount === null && r2.paid_on === null, JSON.stringify(r2));
  C.nav("Home"); await tick(50);
  check("Home now says 1 of 1 paid", /: 1 of 1 paid/.test(homeBtn(C, "Payments").textContent), homeBtn(C, "Payments").textContent);

  console.log("\nSwipe a month to delete it");
  const item = (a, mk) => a.doc.querySelector('#payMonths [data-item="' + mk + '"]');
  const swipeRow = (a, mk, dx) => { const el = item(a, mk); const ev = (type, x) => { const e = new a.w.Event(type, { bubbles: true }); e.touches = type === "touchend" ? [] : [{ clientX: x, clientY: 0 }]; el.dispatchEvent(e); }; ev("touchstart", 20); ev("touchmove", 20 + dx); ev("touchend", 20 + dx); return el; };
  const mkOf = (y, m) => y + "-" + String(m).padStart(2, "0");
  const OLD = mkOf(now.getFullYear() - 1, 6), OLDLABEL = "June " + (now.getFullYear() - 1);
  const listed = a => [...a.doc.querySelectorAll("#payMonths [data-month]")].map(r => r.getAttribute("data-month"));
  swipeRow(C, MK, 20);
  check("a short swipe doesn't open it", !item(C, MK).classList.contains("open"));
  const it = swipeRow(C, MK, 90);
  check("swiping right slides the row over and shows an x", it.classList.contains("open") && it.querySelector(".msg-thread").style.transform === "translateX(72px)" && /Delete .*/.test(it.querySelector(".pay-del").getAttribute("aria-label")));
  it.querySelector(".msg-thread").click(); await tick(50);
  check("tapping the open row closes it again (rather than opening the editor)", !it.classList.contains("open") && !C.$("troFormScrim").classList.contains("show"));
  swipeRow(C, MK, 90);
  item(C, MK).querySelector(".pay-del").click(); await tick(100);
  check("the x removes the month from the list, not just back to Unpaid", !month(C, MK) && listed(C).length === 11, listed(C).join());
  check("...with an Undo", /Deleted/.test(C.$("toastMsg").textContent) && !C.$("toastUndoBtn").classList.contains("hidden"));
  await C.settle();
  const rd = (await payRows()).find(r => r.month === MK);
  check("...and the database marks it removed", rd && rd.removed === true && rd.paid === false && rd.amount === null && rd.paid_on === null, JSON.stringify(rd));
  check("Home no longer counts it as paid", (C.nav("Home"), await tick(50), /: 0 of 1 paid/.test(homeBtn(C, "Payments").textContent)));
  homeBtn(C, "Payments").click(); await tick(100); C.$("payList").querySelector('[data-lifter="Tom"]').click(); await tick(100);
  C.$("toastUndoBtn").click(); await tick(100);
  check("Undo brings the month back with its payment", /Paid/.test(month(C, MK).textContent) && /£45\.50/.test(month(C, MK).textContent) && listed(C).length === 12, month(C, MK) && month(C, MK).textContent);
  await C.settle();
  check("...in the database too", (await payRows()).find(r => r.month === MK).removed === false && (await payRows()).find(r => r.month === MK).paid === true);
  swipeRow(C, PK, 90);
  item(C, PK).querySelector(".pay-del").click(); await tick(100);
  check("an unpaid month can be deleted as well", !month(C, PK) && listed(C).length === 11);
  month(C, MK).click(); await tick(50);
  check("the editor has Delete month too (a computer can't swipe)", !!C.btn("Delete month", C.$("troFormBody")));
  C.$("troFormClose").click();

  console.log("\nThe + button");
  check("coaches get a round + button", !!C.$("payAdd") && C.$("payAdd").getAttribute("aria-label") === "Add a month");
  C.$("payAdd").click(); await tick(50);
  check("it asks for a month and a year", C.$("troFormScrim").classList.contains("show") && !!C.$("payAddMonth") && !!C.$("payAddYear") && C.$("payAddMonth").options.length === 12);
  C.$("payAddMonth").value = "6"; C.$("payAddYear").value = String(now.getFullYear() - 1);
  C.btn("Add", C.$("troFormBody")).click(); await tick(100);
  check("the chosen month joins the list, unpaid, in date order", !!month(C, OLD) && /Unpaid/.test(month(C, OLD).textContent) && listed(C).join() === listed(C).slice().sort().reverse().join() && listed(C).length === 12, listed(C).join());
  await C.settle();
  const ra = (await payRows()).find(r => r.month === OLD);
  check("...and the database has it", ra && ra.removed === false && ra.paid === false, JSON.stringify(ra));
  C.$("payAdd").click(); await tick(50);
  C.$("payAddMonth").value = "6"; C.$("payAddYear").value = String(now.getFullYear() - 1);
  C.btn("Add", C.$("troFormBody")).click(); await tick(100);
  check("adding a month that is already there just says so", /already in the list/.test(C.$("toastMsg").textContent) && listed(C).length === 12);
  swipeRow(C, OLD, 90);
  item(C, OLD).querySelector(".pay-del").click(); await tick(100);
  check("an added month can be deleted again", !month(C, OLD) && listed(C).length === 11);
  C.$("payAdd").click(); await tick(50);
  C.$("payAddMonth").value = String(prev.getMonth() + 1); C.$("payAddYear").value = String(prev.getFullYear());
  C.btn("Add", C.$("troFormBody")).click(); await tick(100);
  check("a deleted recent month comes back through +", !!month(C, PK) && /Unpaid/.test(month(C, PK).textContent));
  await C.settle();
  check("...the database no longer has it as removed", (await payRows()).find(r => r.month === PK).removed === false);
  C.$("payAdd").click(); await tick(50);
  C.$("payAddMonth").value = "6"; C.$("payAddYear").value = String(now.getFullYear() - 1);
  C.btn("Add", C.$("troFormBody")).click(); await tick(100);
  month(C, OLD).click(); await tick(50);
  C.$("troFormBody").querySelector('[data-paid="1"]').click();
  C.$("payOn").value = OLD + "-15"; C.$("payAmount").value = "1000";
  C.btn("Save", C.$("troFormBody")).click(); await tick(100);
  check("an added month can be marked paid like any other", /Paid/.test(month(C, OLD).textContent), month(C, OLD).textContent);
  swipeRow(C, OLD, 90);
  item(C, OLD).querySelector(".pay-del").click(); await tick(100);
  await C.settle();
  C.nav("Home"); await tick(50);
  check("Home still counts this month", /: 1 of 1 paid/.test(homeBtn(C, "Payments").textContent));
  homeBtn(C, "Payments").click(); await tick(100); C.$("payList").querySelector('[data-lifter="Tom"]').click(); await tick(100);

  /* ------------------------------------------------------------ the lifter */
  console.log("\nThe lifter's Home");
  L.sync(); await tick(1500); await L.settle();
  L.nav("Home"); await tick(100);
  check("Tom lands on a Home of his own, greeted by his program's name", active(L) === "viewHome" && L.$("homeTitle").textContent === "Welcome Tom!", L.$("homeTitle").textContent);
  check("the left menu no longer repeats the lifter's name, but keeps its line so the pills stay put", L.$("sideName").textContent === "" && L.$("sideTags").children.length >= 1 && L.w.getComputedStyle(L.$("sideName")).minHeight !== "0px" && L.w.getComputedStyle(L.$("sideName")).minHeight !== "auto");
  const lcaps = [...L.doc.querySelectorAll("#viewHome .home-card:not([hidden]) .home-cap")].map(c => c.textContent);
  check("...with Notifications, Programs, Messages and Payments", lcaps.join() === "Notifications,Programs,Messages,Payments", lcaps.join());
  check("Programs lists his program, not a list of lifters", L.$("homePrograms").querySelectorAll("[data-lifter]").length === 1 && /Prep/.test(L.$("homePrograms").textContent) && !homeBtn(L, "All lifters"));
  check("the Payments card shows this month: Paid", /Paid/.test(L.$("homePay").querySelector(".pay-pill").textContent) && L.$("homePay").querySelector(".pay-pill").classList.contains("paid"));
  homeBtn(L, "View payments").click(); await tick(100);
  check("View payments opens them straight away (one program)", active(L) === "viewPayments" && !!L.$("payMonths"));
  check("...the same months and amounts the coach set", /£45\.50/.test(month(L, MK).textContent) && /Unpaid/.test(month(L, PK).textContent), month(L, MK).textContent);
  check("...read-only: no currency choice", !L.$("payBody").querySelector(".pay-cur"));
  month(L, MK).click(); await tick(50);
  check("...and tapping a month opens nothing", !L.$("troFormScrim").classList.contains("show"));
  let refused = null;
  try { await L.dev.upsert("lifter_payments", [{ lifter_id: tomId, month: MK, paid: false }], "lifter_id,month"); } catch (e) { refused = e.message; }
  check("even going round the app, the database won't let him change it", /row-level security|permission|violates/i.test(refused || "") && (await payRows()).find(r => r.month === MK).paid === true, refused);
  L.$("payBack").click(); await tick(50);
  check("Payments has a Home button", active(L) === "viewHome");
  L.$("homePrograms").querySelector("[data-lifter]").click(); await tick(100);
  check("tapping his program opens it as before", active(L) === "viewOverview" && L.$("ovName").textContent === "Tom");
  check("...with a Home button back", !L.$("ovHome").hidden);
  homeBtn && L.$("ovHome").click(); await tick(50);
  homeBtn(L, "Messages").click(); await tick(100);
  check("the Messages card opens his messages", active(L) === "viewMessages");

  console.log("\nA coach who didn't create the lifter");
  const J = boot("jordan");
  await tick(200);
  await J.signIn("jordan@test.invalid");
  J.btn("I’m a coach: request access", J.$("acctBody")).click(); await tick();
  J.$("acctCoachName").value = "Jordan";
  J.btn("Send request", J.$("acctBody")).click();
  await until(async () => (await rows("select coach_status from public.accounts where email = 'jordan@test.invalid'"))[0].coach_status === "pending");
  J.closeSheet();
  C.sync(); await C.settle();
  C.$("acctBtn").click(); await tick();
  C.btn("Approve", C.$("acctBody")).click();
  await until(async () => (await rows("select coach_status from public.accounts where email = 'jordan@test.invalid'"))[0].coach_status === "approved");
  C.closeSheet();
  C.nav("Overview"); C.nav("Manage program"); await tick(100);
  C.$("dmShareBtn").click(); await tick(50);
  C.$("dmShare").querySelector('input[placeholder="Another coach’s email"]').value = "jordan@test.invalid";
  C.btn("Share", C.$("dmShare")).click();
  await until(async () => (await rows("select count(*)::int n from public.lifter_coaches"))[0].n === 2);
  C.$("shareClose").click();
  J.sync(); await tick(1500); await J.settle();
  J.nav("Home"); await tick(100);
  homeBtn(J, "Payments").click(); await tick(100);
  check("a co-coach sees Tom's program but not in their Payments", !J.$("payList") && /Lifters you create or load appear here/.test(J.$("payBody").textContent), J.$("payBody").textContent);
  check("...nor his payment records", (await J.dev.fetch("lifter_payments", {})).length === 0);

  const bad = [C, L, J].reduce((a, x) => a.concat(x.real()), []);
  check("no script errors on any device", bad.length === 0, bad.join(" | ").slice(0, 400));
  console.log(`\n${checks} checks · ${failures === 0 ? "ALL PASSED" : failures + " FAILED"}\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
