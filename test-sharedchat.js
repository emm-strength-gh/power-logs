/* One conversation per lifter: a signed-in lifter with two programs (the same sign-in email on both) has one chat with
 * their coach, whichever program is on screen; the coach's Inbox has one row for them. Also: the fatigue estimate lives
 * in Coach's Analytics > Progression and load. Run: node test-sharedchat.js
 *
 * Like test-messaging.js: each device is its own jsdom copy of app.html on one in-memory Postgres with
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
const TOM_PREP = csv("Tom", "Prep", [[1, 1, "Deadlift", 200, 3, 3, 8, ""], [1, 2, "Squat", 160, 4, 4, 7, ""], [2, 1, "Squat", 165, 4, 4, 7.5, ""]]);
const TOM_PEAK = csv("Tom", "Peak", [[1, 1, "Squat", 190, 2, 2, 8, ""], [1, 2, "Bench", 130, 3, 3, 8, ""]]);

(async () => {
  const server = await pgServer();

  function boot(label) {
    const dev = server.device(label), errors = [];
    const dom = new JSDOM(html, {
      runScripts: "dangerously", pretendToBeVisual: true,
      url: "https://example.github.io/power-logs/app.html",
      virtualConsole: new VirtualConsole().on("jsdomError", e => errors.push(e.message)).on("error", m => errors.push(String(m))),
      beforeParse(w) { w.__spotterCloud = dev; w.Chart = class { static defaults = { font: {} }; constructor() {} destroy() {} }; },
    });
    const w = dom.window, doc = w.document, $ = id => doc.getElementById(id);
    w.Element.prototype.scrollIntoView = function () {};
    w.scrollTo = function () {};
    const app = {
      label, dev, w, doc, $,
      real: () => errors.filter(e => !/Not implemented|HTMLCanvasElement|getContext|Chart is not defined/i.test(e)),
      store: k => JSON.parse(w.localStorage.getItem(k) || "null"),
      keys: () => [...$("lifterSelect").options].map(o => o.value).filter(v => !/^__/.test(v)),
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
      bubbles: () => [...doc.querySelectorAll("#msgList .msg-bubble")].map(b => b.firstChild.textContent),
      async send(text) {
        $("msgInput").value = text;
        $("msgInput").dispatchEvent(new w.Event("input"));
        app.btn("Send", $("msgBody")).click();
        await tick(100);
      },
      keyOf: block => { const p = app.store("spotter.profiles.v1"); return Object.keys(p).find(k => p[k].block === block); },
    };
    return app;
  }
  const rows = (sql, args) => server.sql(sql, args);
  const dbMsgs = () => rows("select l.program->>'block' as block, m.body from public.messages m join public.lifters l on l.id = m.lifter_id order by m.created_at");

  /* ------------------------------------------------------------ set-up */
  console.log("Set-up: the owner coaches Tom on two programs (Prep and Peak), both with Tom's sign-in email");
  const O = boot("owner");
  await tick(250);
  await O.load(TOM_PREP, "tom-prep.csv");
  await O.load(TOM_PEAK, "tom-peak.csv");
  await O.signIn(OWNER_EMAIL);
  O.$("confirmYes").click();
  await until(async () => (await rows("select count(*)::int n from public.lifters"))[0].n === 2);
  await O.settle();
  await rows("update public.lifters set lifter_email = 'tom@test.invalid'");
  O.sync(); await O.settle();
  const T = boot("tom");
  await tick(250);
  await T.signIn("tom@test.invalid");
  T.sync(); await T.settle();
  check("Tom has both programs", T.keys().length === 2, T.keys().join());

  /* ------------------------------------------------------------ one chat */
  console.log("\nOne conversation, whichever program is on screen");
  T.pick(T.keyOf("Prep")); await tick(100);
  T.nav("Messages"); await tick(150);
  await T.send("Hi from Prep");
  check("Tom's message is saved on the program he was on", await until(async () => (await dbMsgs()).some(m => m.body === "Hi from Prep" && m.block === "Prep")), JSON.stringify(await dbMsgs()));
  await T.settle();
  T.pick(T.keyOf("Peak")); await tick(100);
  T.nav("Messages"); await tick(150);
  check("on the Peak program it's the same chat", T.bubbles().includes("Hi from Prep"), T.bubbles().join(" | "));
  T.nav("Home"); await tick(100);   // away from the chat, so the coach's reply arrives unread

  O.sync(); await O.settle();
  O.nav("Inbox"); await tick(150);
  check("the coach's Inbox has one row for Tom, not two", O.$("inboxBody").querySelectorAll(".msg-thread").length === 1, String(O.$("inboxBody").querySelectorAll(".msg-thread").length));
  check("...counting his message once", /\b1\b/.test((O.$("inboxBody").querySelector(".nav-badge") || {}).textContent || ""), (O.$("inboxBody").querySelector(".nav-badge") || {}).textContent);
  O.pick(O.keyOf("Peak")); await tick(100);
  O.nav("Messages"); await tick(150);
  check("the coach on the Peak program sees Tom's message from Prep", O.bubbles().includes("Hi from Prep"), O.bubbles().join(" | "));
  await O.send("Coach reply on Peak");
  check("the coach's reply is saved on the program the coach was on", await until(async () => (await dbMsgs()).some(m => m.body === "Coach reply on Peak" && m.block === "Peak")));
  await O.settle();

  T.sync(); await T.settle();
  T.nav("Home"); await tick(150);
  check("Tom's Home counts the reply once (one conversation, not one per program)", /(^|\D)1 unread/.test(T.$("homeComms").textContent), T.$("homeComms").textContent);
  T.pick(T.keyOf("Prep")); await tick(100);
  T.nav("Messages"); await tick(200);
  check("on the Prep program Tom sees the reply sent on Peak, in order", T.bubbles().join(" | ") === "Hi from Prep | Coach reply on Peak", T.bubbles().join(" | "));
  T.nav("Home"); await tick(150);
  check("reading it once clears it for both programs", !/unread/.test(T.$("homeComms").textContent), T.$("homeComms").textContent);
  check("no script errors", O.real().length === 0 && T.real().length === 0, O.real().concat(T.real()).join(" | "));

  /* ------------------------------------------------------------ fatigue estimate */
  console.log("\nCoach's Analytics: the fatigue estimate is under Progression and load");
  O.pick(O.keyOf("Prep")); await tick(100);
  O.nav("Manage program"); await tick(150);
  O.$("dmAnalyticsBtn").click(); await tick(250);
  check("Program charts no longer has it", !/Fatigue estimate/.test(O.$("dmCharts").textContent) && !/Starting condition/.test(O.$("dmCharts").textContent) && /Number of lifts/.test(O.$("dmCharts").textContent));
  check("Progression and load has the chart and its Starting condition", /Fatigue estimate/.test(O.$("dmAnBody").textContent) && /Starting condition \(fatigue\)/.test(O.$("dmAnControls").textContent));
  check("no script errors", O.real().length === 0, O.real().join(" | "));

  console.log(`\n${checks} checks · ${failures ? failures + " FAILED" : "ALL PASSED"}`);
  process.exit(failures ? 1 : 0);
})();
