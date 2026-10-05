/* Messages: the emoji picker and replies to a message.
 * Run: node test-replies.js
 *
 * A coach and a lifter, each a jsdom copy of power-logs.html on one in-memory
 * Postgres with the real rules (supabase/schema.sql).
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
  C.sync(); await tick(1800); await C.settle();
  for (const a of [L, C]) {
    a.$("acctBtn").click(); await tick();
    a.btn("Turn on for this device", a.$("acctBody")).click();
    await until(() => a.$("acctBody").querySelector(".acct-check"));
    a.closeSheet();
  }

  const send = async (a, text) => { a.$("msgInput").value = text; a.$("msgInput").dispatchEvent(new a.w.Event("input")); a.btn("Send", a.$("msgBody")).click(); await tick(150); };
  const bubbles = a => [...a.doc.querySelectorAll("#msgList .msg-bubble")];
  const bubbleOf = (a, re) => bubbles(a).find(b => re.test(b.textContent));
  const sync = async a => { a.sync(); await tick(1800); await a.settle(); };
  const replyBtn = (a, re) => bubbleOf(a, re).parentElement.querySelector('.msg-reply[aria-label^="Reply to"]');
  const dbRows = () => rows("select body, reply_to, id from public.messages order by created_at");
  const touch = (target, type, x) => { const e = new target.ownerDocument.defaultView.Event(type, { bubbles: true }); e.touches = type === "touchend" ? [] : [{ clientX: x, clientY: 0 }]; target.dispatchEvent(e); };

  L.nav("Messages"); await tick(150);
  C.nav("Messages"); await tick(150);

  /* ------------------------------------------------------------- emoji */
  console.log("Emoji");
  check("a smiley button sits beside the message box", !!L.$("msgEmojiBtn") && L.$("msgEmojiBtn").getAttribute("aria-label") === "Emoji");
  check("the picker starts closed", !L.$("msgEmoji") && L.$("msgEmojiBtn").getAttribute("aria-expanded") === "false");
  L.$("msgEmojiBtn").click(); await tick(50);
  check("it opens", !!L.$("msgEmoji") && L.$("msgEmojiBtn").getAttribute("aria-expanded") === "true");
  const emojiBtn = (a, e) => [...a.$("msgEmoji").querySelectorAll(".msg-emoji-grid button")].find(b => b.textContent === e);
  L.$("msgInput").value = "Great session  "; L.$("msgInput").setSelectionRange(14, 14);
  emojiBtn(L, "😀").click();
  check("tapping an emoji puts it at the cursor", L.$("msgInput").value === "Great session 😀 ", JSON.stringify(L.$("msgInput").value));
  L.$("msgInput").setSelectionRange(0, 0);
  emojiBtn(L, "😎").click();
  check("...wherever the cursor is", L.$("msgInput").value === "😎Great session 😀 ");
  check("the picker stays open for more, and the text is kept as a draft", !!L.$("msgEmoji"));
  L.doc.querySelector('#msgEmoji .msg-emoji-tabs button[aria-label="Training"]').click(); await tick(50);
  check("there are tabs of them", !!emojiBtn(L, "🏆") && !emojiBtn(L, "😀"));
  L.$("msgInput").setSelectionRange(L.$("msgInput").value.length, L.$("msgInput").value.length);
  emojiBtn(L, "🏆").click();
  L.btn("Send", L.$("msgBody")).click(); await tick(150);
  check("sending closes the picker", !L.$("msgEmoji"));
  await sync(L);
  check("the emoji reach the database intact", (await dbRows()).some(r => r.body === "😎Great session 😀 🏆"), JSON.stringify((await dbRows()).map(r => r.body)));
  await sync(C);
  check("...and the coach's screen", !!bubbleOf(C, /😎Great session 😀 🏆/));
  L.$("msgEmojiBtn").click(); await tick(50);
  check("recently used ones come first", L.doc.querySelector("#msgEmoji .msg-emoji-tabs button").getAttribute("aria-label") === "Recent" && /🏆/.test(L.$("msgEmoji").querySelector(".msg-emoji-grid").textContent));
  L.$("msgEmojiBtn").click(); await tick(50);
  check("the button closes it again", !L.$("msgEmoji"));

  /* ------------------------------------------------------------ replies */
  console.log("\nReplies");
  check("each sent message has a reply button", !!replyBtn(C, /Great session/) && replyBtn(C, /Great session/).getAttribute("aria-label") === "Reply to Tom");
  replyBtn(C, /Great session/).click(); await tick(50);
  check("replying shows who and what, above the box", !!C.$("msgReplyBar") && /Replying to Tom/.test(C.$("msgReplyBar").textContent) && /Great session/.test(C.$("msgReplyBar").textContent), C.$("msgReplyBar") && C.$("msgReplyBar").textContent);
  check("the box is ready to type", C.doc.activeElement === C.$("msgInput"));
  C.$("msgReplyBar").querySelector('button[aria-label="Cancel reply"]').click(); await tick(50);
  check("the x cancels it", !C.$("msgReplyBar"));
  await send(C, "Plain message, no reply");
  await sync(C);
  check("a message sent after cancelling isn't a reply", (await dbRows()).find(r => r.body === "Plain message, no reply").reply_to === null);

  replyBtn(C, /Great session/).click(); await tick(50);
  await send(C, "Glad it went well");
  check("sending clears the reply bar", !C.$("msgReplyBar"));
  const origId = (await dbRows()).find(r => /Great session/.test(r.body)).id;
  await sync(C);
  const answer = (await dbRows()).find(r => r.body === "Glad it went well");
  check("the reply is saved pointing at the original", answer && answer.reply_to === origId, JSON.stringify(answer));
  const q = () => bubbleOf(C, /Glad it went well/).querySelector(".msg-quote");
  check("it shows the quoted message above, with who wrote it", !!q() && /Tom/.test(q().querySelector("b").textContent) && /Great session/.test(q().textContent), q() && q().textContent);
  check("the reply's own text follows the quote", /Glad it went well/.test(bubbleOf(C, /Glad it went well/).textContent));
  await sync(L);
  L.nav("Overview"); L.nav("Messages"); await tick(150);
  const lq = bubbleOf(L, /Glad it went well/).querySelector(".msg-quote");
  check("the lifter sees it too, his own message as You", !!lq && /^You/.test(lq.textContent) && /Great session/.test(lq.textContent), lq && lq.textContent);
  check("the reply buttons are there as soon as a thread opens, not only after a refresh", !!replyBtn(L, /Plain message/));
  check("a plain message has no quote", !bubbleOf(L, /Plain message/).querySelector(".msg-quote"));
  lq.click(); await tick(50);
  check("tapping the quote highlights the original", bubbleOf(L, /Great session/).classList.contains("flash"));

  console.log("\nSwiping a message");
  const line = bubbleOf(L, /Plain message/).parentElement;
  touch(line, "touchstart", 0); touch(line, "touchmove", 30); touch(line, "touchend", 30);
  check("a short swipe does nothing", !L.$("msgReplyBar"));
  touch(line, "touchstart", 0); touch(line, "touchmove", 80); touch(line, "touchend", 80);
  check("swiping their message to the right replies to it", !!L.$("msgReplyBar") && /Replying to owner/.test(L.$("msgReplyBar").textContent), L.$("msgReplyBar") && L.$("msgReplyBar").textContent);
  L.$("msgReplyBar").querySelector("button").click(); await tick(50);
  const mine = bubbleOf(L, /Great session/).parentElement;
  touch(mine, "touchstart", 100); touch(mine, "touchmove", 20); touch(mine, "touchend", 20);
  check("swiping your own to the left replies to it", !!L.$("msgReplyBar") && /Replying to yourself/.test(L.$("msgReplyBar").textContent), L.$("msgReplyBar") && L.$("msgReplyBar").textContent);
  L.$("msgReplyBar").querySelector("button").click(); await tick(50);
  check("the wrong direction does nothing", (() => { touch(mine, "touchstart", 0); touch(mine, "touchmove", 90); touch(mine, "touchend", 90); return !L.$("msgReplyBar"); })());

  console.log("\nWhile it's still sending");
  L.dev.state.offline = true;
  await send(L, "Typed offline");
  check("a message that hasn't gone yet has no reply button", !bubbleOf(L, /Typed offline/).parentElement.querySelector('.msg-reply[aria-label^="Reply to"]'));
  L.dev.state.offline = false;

  console.log("\nAuto-scroll in Messages");
  const calls = [];
  L.w.scrollTo = (x, y) => calls.push(y);
  Object.defineProperty(L.doc.body, "scrollHeight", { value: 4321, configurable: true });
  L.nav("Overview"); await tick(50);
  calls.length = 0;
  L.nav("Messages"); await tick(600);
  check("opening Messages scrolls to the bottom, newest message and the box", calls.includes(4321), JSON.stringify(calls.slice(0, 5)));
  check("...and again once the slide-in settles", calls.filter(y => y === 4321).length >= 3);
  calls.length = 0;
  L.$("msgInput").value = "typing"; L.$("msgInput").dispatchEvent(new L.w.Event("input")); await tick(50);
  check("typing keeps the bottom in view", calls.includes(4321));
  calls.length = 0;
  L.$("msgInput").dispatchEvent(new L.w.Event("focus")); await tick(500);
  check("so does focusing the box (when the keyboard comes up)", calls.includes(4321));
  calls.length = 0;
  L.btn("Send", L.$("msgBody")).click(); await tick(100);
  check("sending a message scrolls to it", calls.includes(4321));

  console.log("\nTap and hold to copy");
  const copied = [];
  Object.defineProperty(L.w.navigator, "clipboard", { value: { writeText: async x => { copied.push(x); } }, configurable: true });
  const hold = async (el, ms) => { touch(el, "touchstart", 100); await tick(ms); const e = new L.w.Event("touchend", { bubbles: true }); e.touches = []; el.dispatchEvent(e); };
  L.nav("Messages"); await tick(150);
  const target = bubbleOf(L, /Glad it went well/);
  await hold(target, 150);
  check("a quick tap doesn't open anything", !L.$("reactPop"));
  await hold(target, 600);
  check("holding a message opens a Copy button", !!L.$("reactPop") && L.$("reactPop").textContent === "Copy", L.$("reactPop") && L.$("reactPop").textContent);
  L.$("reactPop").querySelector(".copy-opt").click(); await tick(100);
  check("Copy puts the whole message on the clipboard", copied.length === 1 && copied[0] === "Glad it went well", JSON.stringify(copied));
  check("...says so, and the button goes", /Copied/.test(L.$("toastMsg").textContent) && !L.$("reactPop"));
  const moving = bubbleOf(L, /Plain message/);
  touch(moving, "touchstart", 100); touch(moving, "touchmove", 140); await tick(600);
  check("moving the finger (a swipe or scroll) isn't a hold", !L.$("reactPop"));
  const e0 = new L.w.Event("touchend", { bubbles: true }); e0.touches = []; moving.dispatchEvent(e0);
  moving.dispatchEvent(new L.w.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  check("right-click does the same on a computer", !!L.$("reactPop") && L.$("reactPop").textContent === "Copy");
  await tick(30);
  L.doc.dispatchEvent(new L.w.KeyboardEvent("keydown", { key: "Escape" })); await tick(50);
  check("Escape closes it", !L.$("reactPop"));
  check("a held message isn't also a double-tap heart", !L.doc.querySelector("#msgList .react-chip"));

  console.log("\nSwiping back");
  const swipe = (el, x0, x1, y1 = 0) => { touch(el, "touchstart", x0); touch(el, "touchmove", x1); const e = new L.w.Event("touchend", { bubbles: true }); e.touches = []; el.dispatchEvent(e); };
  const toMsgs = async () => { L.nav("Messages"); await tick(150); };
  await toMsgs();
  const bg = L.doc.querySelector("#viewMessages .msg-head");
  swipe(bg, 200, 240);
  check("a short swipe right does nothing", L.$("viewMessages").classList.contains("active"));
  swipe(bg, 240, 120);
  check("a swipe to the left does nothing", L.$("viewMessages").classList.contains("active"));
  swipe(bg, 100, 260);
  check("swiping right on the empty space goes back to the Overview", L.$("viewOverview").classList.contains("active") && !L.$("viewMessages").classList.contains("active"));
  check("...with the left navigation open", L.$("layout").classList.contains("nav-open"));
  L.$("layout").classList.remove("nav-open");
  await toMsgs();
  const theirs = bubbleOf(L, /Glad it went well/).parentElement;
  swipe(theirs, 100, 260);
  check("a swipe that starts on a message is its reply gesture, not 'back'", L.$("viewMessages").classList.contains("active") && !!L.$("msgReplyBar"));
  L.$("msgReplyBar").querySelector("button").click(); await tick(50);
  swipe(theirs, 10, 170);
  check("...unless it starts at the very left edge", L.$("viewOverview").classList.contains("active") && L.$("layout").classList.contains("nav-open"));
  L.$("layout").classList.remove("nav-open");
  await toMsgs();
  swipe(L.$("msgInput"), 100, 260);
  check("a swipe in the message box (selecting text) doesn't leave", L.$("viewMessages").classList.contains("active"));

  const bad = [C, L].reduce((a, x) => a.concat(x.real()), []);
  check("no script errors on any device", bad.length === 0, bad.join(" | ").slice(0, 400));
  console.log(`\n${checks} checks · ${failures === 0 ? "ALL PASSED" : failures + " FAILED"}\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
