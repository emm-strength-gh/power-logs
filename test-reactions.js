/* Emoji reactions: on messages (lifter and coach), and, coaches only, on weekly notes
 * and training days. One per person, eleven emoji, and the rules enforced by the database.
 * Run: node test-reactions.js
 *
 * A coach (the owner) and a lifter, each a jsdom copy of power-logs.html on one
 * in-memory Postgres (supabase/schema.sql).
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
  const settle = async a => { a.sync(); await tick(1800); await a.settle(); };
  const SIX = ["heart", "up", "100", "fire", "sleep", "tired", "devil", "sad", "cry", "happy", "worried"];
  const dbRx = () => rows("select target_type, target_id, emoji, a.email from public.lifter_reactions r left join public.accounts a on a.user_id = r.user_id order by r.updated_at");
  const chips = (a, sel) => [...a.doc.querySelectorAll(sel + " .react-chip")].map(c => c.textContent);
  const addBtn = (a, sel) => a.doc.querySelector(sel + " .react-add");
  const pick = async (a, key) => { a.doc.querySelector('#reactPop [data-emoji="' + key + '"]').click(); await tick(80); };
  const dayBar = (a, d) => [...a.doc.querySelectorAll("#wkList .day-group")][d - 1].querySelector(".react-row");

  /* ----------------------------------------------------------- set-up */
  await L.dev.upsert("lifter_week_notes", [{ lifter_id: tomId, week: "1", body: "Felt strong today" }], "lifter_id,week");
  C.nav("Overview"); await tick(50);
  await settle(C); await settle(L);
  C.nav("Week 1"); L.nav("Week 1"); await tick(150);
  check("the coach's week shows the lifter's note", /Felt strong today/.test(C.$("wkNotes").textContent));

  /* ------------------------------------------------------- the day */
  console.log("Reactions on a training day");
  check("a coach has a button to react to Day 1", !!dayBar(C, 1) && !!dayBar(C, 1).querySelector(".react-add"));
  check("the lifter sees no reaction row on a day nobody reacted to", !dayBar(L, 1));
  dayBar(C, 1).querySelector(".react-add").click(); await tick(50);
  check("it offers exactly eleven emoji", C.$("reactPop") && [...C.$("reactPop").querySelectorAll(".react-opt")].map(b => b.getAttribute("data-emoji")).join() === SIX.join(), C.$("reactPop") && C.$("reactPop").textContent);
  check("heart, thumbs up, 100, fire, sleepy, tired, the blue devil, then sad, crying, happy and worried", C.$("reactPop").textContent === "\u2764\uFE0F\uD83D\uDC4D\uD83D\uDCAF\uD83D\uDD25\uD83D\uDE34\uD83D\uDE2B\uD83D\uDE08\uD83D\uDE1E\uD83D\uDE2D\uD83D\uDE0A\uD83D\uDE1F", C.$("reactPop").textContent);
  await pick(C, "fire");
  check("picking one puts it on the day, as yours, and closes the picker", chips(C, "#wkList .day-group:nth-child(1)").join() === "\uD83D\uDD25" && !C.$("reactPop") && dayBar(C, 1).querySelector(".react-chip.mine"));
  await settle(C);
  const r1 = await dbRx();
  check("it reaches the database, from that coach", r1.length === 1 && r1[0].target_type === "day" && r1[0].target_id === "1|1" && r1[0].emoji === "fire" && r1[0].email === OWNER_EMAIL, JSON.stringify(r1));
  await settle(L);
  L.nav("Overview"); L.nav("Week 1"); await tick(150);
  check("the lifter sees the fire on Day 1", chips(L, "#wkList .day-group:nth-child(1)").join() === "\uD83D\uDD25");
  check("...but can't add or change one", !addBtn(L, "#wkList .day-group:nth-child(1)") && dayBar(L, 1).querySelector("button") === null);
  check("...and nothing on Day 2", !dayBar(L, 2));
  dayBar(C, 1).querySelector(".react-add").click(); await tick(50);
  check("the coach's picker marks the one they have", C.$("reactPop").querySelector('[data-emoji="fire"]').classList.contains("on"));
  await pick(C, "heart");
  check("one reaction per person: a new one replaces it", chips(C, "#wkList .day-group:nth-child(1)").join() === "\u2764\uFE0F");
  dayBar(C, 1).querySelector(".react-chip.mine").click(); await tick(80);
  check("tapping your own takes it back", !dayBar(C, 1).querySelector(".react-chip"));
  await settle(C); await settle(L);
  L.nav("Overview"); L.nav("Week 1"); await tick(150);
  check("...for the lifter too", !dayBar(L, 1));
  check("...saved as an empty reaction, not a deleted row", (await dbRx())[0].emoji === null);
  dayBar(C, 2).querySelector(".react-add").click(); await tick(50);
  await pick(C, "100");
  await settle(C);

  /* ------------------------------------------------------- the weekly note */
  console.log("\nReactions on a weekly note");
  check("a coach can react to the note", !!C.$("wkNotesReact").querySelector(".react-add"));
  C.$("wkNotesReact").querySelector(".react-add").click(); await tick(50);
  await pick(C, "up");
  await settle(C); await settle(L);
  L.nav("Home"); await tick(100);
  const lnt = [...L.doc.querySelectorAll("#homeNotices .nt-row")].map(r => r.textContent);
  check("the lifter is told, on Home, that a coach reacted (grouped, with the latest)", lnt.length === 1 && /new reactions|reacted .* to/.test(lnt[0]) && /owner reacted/.test(lnt[0]), lnt.join(" | "));
  L.nav("Overview"); L.nav("Week 1"); await tick(150);
  check("opening the week clears them", ![...L.doc.querySelectorAll("#homeNotices .nt-row")].some(r => /reacted/.test(r.textContent)));
  check("the lifter sees it under the note, read-only", chips(L, "#wkNotesReact").join() === "\uD83D\uDC4D" && !L.$("wkNotesReact").querySelector(".react-add"));
  check("...and the 100 on Day 2", chips(L, "#wkList .day-group:nth-child(2)").join() === "\uD83D\uDCAF");
  const types = (await dbRx()).map(r => r.target_type + ":" + r.target_id + ":" + r.emoji).sort().join();
  check("the database has the note and day reactions", types === "day:1|1:null,day:1|2:100,note:1:up", types);

  console.log("\nThe database won't let a lifter in, whatever the app does");
  let refused = null;
  try { await L.dev.upsert("lifter_reactions", [{ lifter_id: tomId, target_type: "note", target_id: "1", emoji: "heart" }], "lifter_id,target_type,target_id,user_id"); } catch (e) { refused = e.message; }
  check("a lifter's reaction on a note is refused", /row-level security|violates|permission/i.test(refused || ""), refused);
  refused = null;
  try { await L.dev.upsert("lifter_reactions", [{ lifter_id: tomId, target_type: "day", target_id: "1|1", emoji: "heart" }], "lifter_id,target_type,target_id,user_id"); } catch (e) { refused = e.message; }
  check("...and on a day", /row-level security|violates|permission/i.test(refused || ""), refused);
  refused = null;
  try { await C.dev.upsert("lifter_reactions", [{ lifter_id: tomId, target_type: "note", target_id: "1", emoji: "poop" }], "lifter_id,target_type,target_id,user_id"); } catch (e) { refused = e.message; }
  check("an emoji outside the eleven is refused", /check|violates|constraint/i.test(refused || ""), refused);

  /* ---------------------------------------------------------- messages */
  console.log("\nReactions on messages");
  L.nav("Messages"); await tick(150);
  const send = async (a, text) => { a.$("msgInput").value = text; a.$("msgInput").dispatchEvent(new a.w.Event("input")); a.btn("Send", a.$("msgBody")).click(); await tick(150); };
  await send(L, "Hit a double today");
  await settle(L); await settle(C);
  C.nav("Overview"); C.nav("Messages"); await tick(150);
  const bub = (a, re) => [...a.doc.querySelectorAll("#msgList .msg-bubble")].find(b => re.test(b.textContent));
  const reactBtn = (a, re) => bub(a, re).parentElement.querySelector('button[aria-label="React to this message"]');
  check("a coach can react to a message with the button beside it", !!reactBtn(C, /double today/));
  reactBtn(C, /double today/).click(); await tick(50);
  check("the same eleven are offered", [...C.$("reactPop").querySelectorAll(".react-opt")].length === 11);
  await pick(C, "fire");
  check("it shows under the message, and the thread stays where it was", chips(C, "#msgList .msg-bubble").join() === "\uD83D\uDD25");
  await settle(C); await settle(L);
  L.nav("Overview"); L.nav("Messages"); await tick(150);
  check("the lifter sees it", chips(L, "#msgList .msg-bubble").join() === "\uD83D\uDD25");
  check("...and has the button too: lifters react to messages", !!reactBtn(L, /double today/));
  reactBtn(L, /double today/).click(); await tick(50);
  await pick(L, "fire");
  check("two people, one emoji: a count", chips(L, "#msgList .msg-bubble").join() === "\uD83D\uDD25" + "2" && bub(L, /double today/).querySelector(".react-chip").title.split(", ").sort().join() === "You,owner", chips(L, "#msgList .msg-bubble").join() + " / " + bub(L, /double today/).querySelector(".react-chip").title);
  await settle(L); await settle(C);
  C.nav("Overview"); C.nav("Messages"); await tick(150);
  check("the coach's copy agrees", chips(C, "#msgList .msg-bubble").join() === "\uD83D\uDD25" + "2");
  await send(C, "Nice one, keep it up");
  await settle(C); await settle(L);
  L.nav("Overview"); L.nav("Messages"); await tick(150);
  const b2 = bub(L, /Nice one/);
  b2.click(); b2.click(); await tick(100);
  check("double-tapping a message gives it a heart", chips(L, "#msgList .msg-bubble").includes("\u2764\uFE0F"));
  await settle(L); await settle(C);
  check("...saved for the coach to see", (await dbRx()).some(r => r.target_type === "message" && r.emoji === "heart"));
  await settle(C);
  C.nav("Home"); await tick(100);
  const cnt = [...C.doc.querySelectorAll("#homeNotices .nt-row b")].map(b => b.textContent);
  check("the coach is told the lifter reacted to their message", cnt.some(x => /Tom reacted .* to your message/.test(x)), cnt.join(" | "));
  C.nav("Overview"); C.nav("Messages"); await tick(150);
  check("reading the thread clears that", ![...C.doc.querySelectorAll("#homeNotices .nt-row b")].some(b => /reacted/.test(b.textContent)));
  L.dev.state.offline = true;
  await send(L, "Pending one");
  check("a message still sending has no react button yet", !!bub(L, /Pending one/) && !reactBtn(L, /Pending one/));
  L.dev.state.offline = false;

  const bad = [C, L].reduce((a, x) => a.concat(x.real()), []);
  check("no script errors on any device", bad.length === 0, bad.join(" | ").slice(0, 400));
  console.log(`\n${checks} checks · ${failures === 0 ? "ALL PASSED" : failures + " FAILED"}\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
