/* The floating Messages window: for a coach on a lifter's Overview or week, the same
 * Messages in a small window at the bottom right, minimised to a round message button.
 * Run: node test-chatdock.js
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
  const send = async (a, host, text) => { const inp = a.doc.querySelector(host + " #msgInput"); inp.value = text; inp.dispatchEvent(new a.w.Event("input")); a.btn("Send", a.doc.querySelector(host)).click(); await tick(150); };
  const dock = a => a.$("chatDock");
  // the coach's own read markers (the lifter reading his own thread makes his)
  const reads = async () => (await rows("select count(*)::int n from public.message_reads r join public.accounts a on a.user_id = r.user_id where a.email = $1", [OWNER_EMAIL]))[0].n;
  const msgs = async () => (await rows("select body, reply_to from public.messages order by created_at"));
  const store = a => a.w.localStorage.getItem("spotter.chatDock.v1");

  C.nav("Overview"); await tick(100);
  L.nav("Overview"); await tick(100);
  console.log("The window's first look");
  check("a coach on a lifter's Overview has the floating window, minimised to a round button", !dock(C).hidden && !C.$("chatBubble").hidden && C.$("chatWin").hidden);
  check("the button is a small message bubble", !!C.$("chatBubble").querySelector("svg") && C.$("chatBubble").getAttribute("aria-label") === "Open messages");
  check("a lifter gets one too, on their own program", !dock(L).hidden && !L.$("chatBubble").hidden && L.$("chatWin").hidden);

  console.log("\nA message arrives while it's minimised");
  L.nav("Messages"); await tick(150);
  await send(L, "#msgBody", "Hi coach, quick question about Thursday");
  await settle(L); await settle(C);
  check("the button shows the unread count", !C.$("chatBadge").hidden && C.$("chatBadge").textContent === "1", C.$("chatBadge").textContent);
  check("...and the message is not marked read just because it arrived", (await reads()) === 0);

  const badgeCss = C.w.getComputedStyle(C.$("chatBadge"));
  check("the unread count is a small red circle on the round button", badgeCss.backgroundColor === "rgb(229, 56, 59)" && badgeCss.display !== "none" && C.$("chatBubble").contains(C.$("chatBadge")), badgeCss.backgroundColor + " " + badgeCss.display);
  console.log("\nOpening it");
  C.$("chatBubble").click(); await tick(200);
  check("the window opens, titled with the lifter", !C.$("chatWin").hidden && C.$("chatBubble").hidden && C.$("chatTitle").textContent === "Tom");
  check("it has the same messages as the Messages view", /quick question about Thursday/.test(C.$("chatBody").textContent) && !!C.$("chatBody").querySelector("#msgList"));
  check("...with the message box, send button, emoji button", !!C.$("chatBody").querySelector("#msgInput") && !!C.btn("Send", C.$("chatBody")) && !!C.$("chatBody").querySelector("#msgEmojiBtn"));
  check("reading it there marks it read, and the red circle goes", await until(async () => (await reads()) === 1) && C.$("chatBadge").hidden && C.w.getComputedStyle(C.$("chatBadge")).display === "none");
  check("the choice is remembered", store(C) === '"open"', store(C));
  C.$("chatBody").querySelector("#msgEmojiBtn").click(); await tick(50);
  check("the emoji picker works inside it", !!C.$("chatBody").querySelector("#msgEmoji"));
  C.$("chatBody").querySelector("#msgEmoji .msg-emoji-grid button").click();
  check("...and puts the emoji in its message box", C.$("msgInput").value.length > 0);
  C.$("msgInput").value = "";
  C.$("chatBody").querySelector("#msgEmojiBtn").click();

  console.log("\nTalking from it");
  await send(C, "#chatBody", "Thursday is a heavy single, RPE 8");
  await settle(C); await settle(L);
  check("a message sent from the window reaches the database", (await msgs()).some(m => m.body === "Thursday is a heavy single, RPE 8"));
  L.nav("Overview"); L.nav("Messages"); await tick(150);
  check("...and the lifter", [...L.doc.querySelectorAll("#msgList .msg-bubble")].some(b => /heavy single/.test(b.textContent)));
  const theirs = [...C.doc.querySelectorAll("#chatBody .msg-bubble")].find(b => /quick question/.test(b.textContent));
  check("each message has reply and react buttons, as in Messages", !!theirs.parentElement.querySelector('.msg-reply[aria-label^="Reply to"]') && !!theirs.parentElement.querySelector('button[aria-label="React to this message"]'));
  theirs.parentElement.querySelector('.msg-reply[aria-label^="Reply to"]').click(); await tick(50);
  check("replying shows the reply bar inside the window", !!C.$("chatBody").querySelector("#msgReplyBar"));
  await send(C, "#chatBody", "Yes, same as last week");
  await settle(C);
  const rep = (await msgs()).find(m => m.body === "Yes, same as last week");
  check("...and the reply is saved as a reply", !!rep && !!rep.reply_to);
  C.$("chatBody").querySelector('button[aria-label="React to this message"]').click(); await tick(50);
  check("reactions work in it too", !!C.doc.querySelector("#reactPop") && C.doc.querySelectorAll("#reactPop .react-opt").length === 7);
  C.doc.querySelector('#reactPop [data-emoji="fire"]').click(); await tick(80);
  check("...and show on the message", C.$("chatBody").querySelectorAll(".react-chip").length === 1);
  const mine = [...C.doc.querySelectorAll("#chatBody .msg-bubble")].find(b => /heavy single/.test(b.textContent));
  const copied = [];
  Object.defineProperty(C.w.navigator, "clipboard", { value: { writeText: async x => { copied.push(x); } }, configurable: true });
  mine.dispatchEvent(new C.w.MouseEvent("contextmenu", { bubbles: true, cancelable: true })); await tick(30);
  C.doc.querySelector("#reactPop .copy-opt").click(); await tick(80);
  check("holding or right-clicking a message still offers Copy", copied.join() === "Thursday is a heavy single, RPE 8", copied.join());

  console.log("\nOpen and minimise");
  check("open, the round button is gone (the window replaces it)", C.$("chatBubble").hidden && C.w.getComputedStyle(C.$("chatBubble")).display === "none", C.w.getComputedStyle(C.$("chatBubble")).display);
  check("there's no maximise button", !C.$("chatMax") && ![...C.doc.querySelectorAll("#chatWin button")].some(b => /maxim|restore/i.test(b.getAttribute("aria-label") || "")));
  check("the window is a small one (the CSS caps it at 330px tall)", /min\(330px/.test(C.doc.querySelector("style").textContent));
  C.$("chatMin").click(); await tick(50);
  check("Minimise shrinks it back to the round button", C.$("chatWin").hidden && !C.$("chatBubble").hidden && C.w.getComputedStyle(C.$("chatBubble")).display !== "none" && store(C) === '"min"');
  check("...and clears the window's copy of the thread (no duplicate ids)", C.$("chatBody").children.length === 0);
  await send(L, "#msgBody", "One more thing");
  await settle(L); await settle(C);
  check("a message that comes in while it's minimised is counted, not read", C.$("chatBadge").textContent === "1" && !C.$("chatBadge").hidden && (await reads()) === 1, C.$("chatBadge").textContent + " / " + await reads());

  console.log("\nTapping outside");
  const down = (el) => el.dispatchEvent(new C.w.Event("pointerdown", { bubbles: true }));
  C.$("chatBubble").click(); await tick(100);
  down(C.$("chatBody")); await tick(50);
  check("a tap inside the window leaves it open", !C.$("chatWin").hidden);
  C.$("chatBody").querySelector('button[aria-label="React to this message"]').click(); await tick(50);
  down(C.doc.querySelector("#reactPop .react-opt")); await tick(50);
  check("...and so does a tap on its emoji picker (that lives outside it in the page)", !C.$("chatWin").hidden);
  C.doc.dispatchEvent(new C.w.KeyboardEvent("keydown", { key: "Escape" })); await tick(30);
  down(C.$("viewOverview")); await tick(80);
  check("a tap outside it minimises it to the round button", C.$("chatWin").hidden && !C.$("chatBubble").hidden && store(C) === '"min"');
  C.$("chatBubble").click(); await tick(100);
  check("tapping the round button opens it (and that tap doesn't close it again)", !C.$("chatWin").hidden);
  C.$("chatMin").click(); await tick(30);
  down(C.$("viewOverview")); await tick(30);
  check("outside taps do nothing when it's already a button", !C.$("chatBubble").hidden);
  C.$("chatBubble").click(); await tick(100);

  console.log("\nWhere it shows");
  C.$("chatBubble").click(); await tick(150);
  check("reopened, it has the new message and clears the count", /One more thing/.test(C.$("chatBody").textContent) && C.$("chatBadge").hidden);
  C.nav("Week 1"); await tick(150);
  check("on a week it's there too, still open", !dock(C).hidden && !C.$("chatWin").hidden && /One more thing/.test(C.$("chatBody").textContent));
  C.nav("Analytics"); await tick(100);
  check("on Analytics it isn't", dock(C).hidden && C.$("chatBody").children.length === 0);
  C.nav("Home"); await tick(100);
  check("...nor on Home", dock(C).hidden);
  C.nav("Overview"); C.nav("Messages"); await tick(150);
  check("in the Messages view it gives way to the real thing: one message box on the page", dock(C).hidden && C.doc.querySelectorAll("#msgInput").length === 1 && C.$("msgBody").contains(C.$("msgInput")));
  C.nav("Overview"); await tick(150);
  check("back on the Overview it returns, and Messages' own box is empty", !dock(C).hidden && !C.$("chatWin").hidden && C.$("msgBody").children.length === 0 && C.doc.querySelectorAll("#msgInput").length === 1);

  console.log("\nScrolling");
  const sets = [];
  Object.defineProperty(C.$("chatBody"), "scrollHeight", { value: 999, configurable: true });
  Object.defineProperty(C.$("chatBody"), "scrollTop", { set(v) { sets.push(v); }, get() { return 0; }, configurable: true });
  C.$("chatMin").click(); await tick(30);
  C.$("chatBubble").click(); await tick(600);
  check("opening it scrolls its own list to the newest message", sets.includes(999), JSON.stringify(sets.slice(0, 4)));

  console.log("\nThe lifter's window");
  L.nav("Overview"); await tick(100);
  await send(C, "#chatBody", "Message from the window while you read this");
  await settle(C); await settle(L);
  check("a message from the coach is counted on the lifter's round button", L.$("chatBadge").textContent !== "0" && !L.$("chatBadge").hidden, L.$("chatBadge").textContent);
  L.$("chatBubble").click(); await tick(200);
  check("it opens with the coach's message, titled Messages", !L.$("chatWin").hidden && L.$("chatTitle").textContent === "Messages" && /Message from the window/.test(L.$("chatBody").textContent), L.$("chatTitle").textContent);
  check("...with the lifter's own controls: the one-thread-with-all-coaches switch, box, emoji, reply", !!L.$("chatBody").querySelector(".msg-switch") && !!L.$("chatBody").querySelector("#msgInput") && !!L.$("chatBody").querySelector("#msgEmojiBtn") && !!L.$("chatBody").querySelector('.msg-reply[aria-label^="Reply to"]'));
  await send(L, "#chatBody", "Thanks coach, will do");
  await settle(L); await settle(C);
  check("the lifter can answer from it", (await msgs()).some(m => m.body === "Thanks coach, will do"));
  L.doc.dispatchEvent(new L.w.Event("pointerdown", { bubbles: true }));
  L.$("viewOverview").dispatchEvent(new L.w.Event("pointerdown", { bubbles: true })); await tick(50);
  check("a tap outside minimises theirs too", L.$("chatWin").hidden && !L.$("chatBubble").hidden);
  L.nav("Home"); await tick(80);
  check("and it's hidden on their Home", L.$("chatDock").hidden);

  const bad = [C, L].reduce((a, x) => a.concat(x.real()), []);
  check("no script errors on any device", bad.length === 0, bad.join(" | ").slice(0, 400));
  console.log(`\n${checks} checks · ${failures === 0 ? "ALL PASSED" : failures + " FAILED"}\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
