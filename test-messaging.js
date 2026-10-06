/* Messages, finished sessions, new-week alerts and notifications, end to end.
 * Run: node test-messaging.js
 *
 * Like test-cloudsync.js: each device is its own jsdom copy of power-logs.html
 * on one in-memory Postgres (supabase/schema.sql, real row-level security).
 * The notify Edge Function runs in-process (test-cloudfake.js), so every push
 * it would send is in server.pushes. Each device gets a stand-in for the
 * browser's push support (service worker, PushManager, Notification).
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
const TOM = "#Name,Tom\r\n#Block,Prep\r\nWeek,Day,Exercise,Weight (kg),Sets,Reps,RPE,Notes\r\n" +
  "1,1,Squat,160,4,4,7,\r\n1,1,Bench,110,4,5,7,\r\n1,2,Deadlift,200,3,3,8,\r\n2,1,Squat,165,4,4,7.5,\r\n";

(async () => {
  const server = await pgServer();
  const apps = [];

  // reuse: { dev, storage } to reopen the app on the same device (same session, same localStorage).
  function boot(label, reuse) {
    const dev = reuse ? reuse.dev : server.device(label), errors = [];
    const push = { sub: null, swListeners: [], unsubscribed: 0 };
    const dom = new JSDOM(html, {
      runScripts: "dangerously", pretendToBeVisual: true,
      url: "https://example.github.io/power-logs/power-logs.html",
      virtualConsole: new VirtualConsole().on("jsdomError", e => errors.push(e.message)).on("error", m => errors.push(String(m))),
      beforeParse(w) {
        w.__spotterCloud = dev;
        if (reuse) Object.entries(reuse.storage).forEach(([k, v]) => w.localStorage.setItem(k, v));
        const reg = {
          addEventListener() {},
          pushManager: {
            getSubscription: async () => push.sub,
            subscribe: async () => {
              push.sub = {
                endpoint: "https://push.test/" + label.replace(/\s/g, "-"),
                toJSON() { return { endpoint: this.endpoint, keys: { p256dh: "p256-" + label, auth: "auth-" + label } }; },
                unsubscribe: async () => { push.sub = null; push.unsubscribed++; return true; },
              };
              return push.sub;
            },
          },
        };
        Object.defineProperty(w.navigator, "serviceWorker", {
          configurable: true,
          value: { ready: Promise.resolve(reg), register: async () => reg, controller: null,
                   addEventListener: (t, fn) => { if (t === "message") push.swListeners.push(fn); } },
        });
        w.PushManager = function () {};
        w.Notification = { permission: "default", requestPermission: async () => (w.Notification.permission = "granted") };
      },
    });
    const w = dom.window, doc = w.document, $ = id => doc.getElementById(id);
    w.Element.prototype.scrollIntoView = function () {};
    w.scrollTo = function () {};
    const app = {
      label, dev, w, doc, $, push,
      real: () => errors.filter(e => !/Not implemented|HTMLCanvasElement|getContext|Chart is not defined/i.test(e)),
      store: k => JSON.parse(w.localStorage.getItem(k) || "null"),
      navs: () => [...doc.querySelectorAll("#sideNav .nav-item")].map(n => n.querySelector(".nav-label").textContent),
      badge: label => { const n = [...doc.querySelectorAll("#sideNav .nav-item")].find(x => x.querySelector(".nav-label").textContent === label); const b = n && n.querySelector(".nav-badge"); return b ? +b.textContent : 0; },
      nav(label) {
        const b = [...doc.querySelectorAll("#sideNav .nav-item")].find(n => n.querySelector(".nav-label").textContent === label);
        if (b) b.click();
        return !!b;
      },
      btn: (text, root) => [...(root || doc).querySelectorAll("button")].find(b => b.textContent.trim() === text),
      async load(text, fname) {
        const input = $("fileInput");
        Object.defineProperty(input, "files", { value: [new w.File([text], fname)], configurable: true });
        input.dispatchEvent(new w.Event("change"));
        await tick(300);
      },
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
      bubbles: () => [...doc.querySelectorAll("#msgList .msg-bubble")].map(b => b.firstChild.textContent),
      sending: () => [...doc.querySelectorAll("#msgList .msg-time")].some(t => /Sending/.test(t.textContent)),
      seen: () => { const x = doc.querySelector("#msgList .msg-seen"); return x ? x.textContent : ""; },
      storage: () => { const o = {}; for (let i = 0; i < w.localStorage.length; i++) { const k = w.localStorage.key(i); o[k] = w.localStorage.getItem(k); } return o; },
      async send(text) {
        $("msgInput").value = text;
        $("msgInput").dispatchEvent(new w.Event("input"));
        app.btn("Send", $("msgBody")).click();
        await tick(100);
      },
    };
    apps.push(app);
    return app;
  }
  const dbMsgs = () => server.sql("select m.thread, m.body, a.email from public.messages m join public.accounts a on a.user_id = m.sender_id order by m.created_at");
  const pushesTo = (label) => server.pushes.filter(p => p.endpoint.endsWith(label.replace(/\s/g, "-")));

  /* ------------------------------------------------------------ set-up */
  console.log("Set-up: the owner coaches Tom, who signs in");
  const C = boot("coach");
  await tick(200);
  await C.load(TOM, "tom.csv");
  await C.signIn(OWNER_EMAIL);
  C.closeSheet(); await tick(100);
  C.$("confirmYes").click();
  await until(async () => (await server.sql("select count(*)::int n from public.lifters"))[0].n === 1);
  await C.settle();
  const tomId = (await server.sql("select id from public.lifters where name = 'Tom'"))[0].id;
  C.nav("Manage program"); await tick(100);
  C.$("dmShareBtn").click(); await tick(50);
  const share = C.$("dmShare");
  const em = share.querySelector('input[type="email"]');
  em.value = "tom@test.invalid"; em.dispatchEvent(new C.w.Event("blur"));
  await until(async () => (await server.sql("select lifter_email from public.lifters"))[0].lifter_email === "tom@test.invalid");
  await C.settle();
  C.$("shareClose").click();
  check("no new-week notice for the weeks Tom started with", !C.$("dmNotice").querySelector(".week-notice"));

  const L = boot("lifter");
  await tick(200);
  await L.signIn("tom@test.invalid");
  check("Tom has Messages in his sidebar", L.navs().includes("Messages"), L.navs().join());
  check("...but no Inbox (that's for coaches)", !L.navs().includes("Inbox"));
  C.sync(); await C.settle();
  check("the coach has an Inbox and Tom's Messages", C.navs().includes("Inbox") && C.navs().includes("Messages"), C.navs().join());

  /* ---------------------------------------------------- notifications on */
  console.log("\nTurning notifications on");
  L.$("acctBtn").click(); await tick();
  check("the account sheet offers them", !!L.btn("Turn on for this device", L.$("acctBody")));
  L.btn("Turn on for this device", L.$("acctBody")).click();
  check("turning on saves this device", await until(async () => (await server.sql("select count(*)::int n from public.push_subscriptions"))[0].n === 1));
  await until(() => L.$("acctBody").querySelector(".acct-check"));
  const lOpts = [...L.$("acctBody").querySelectorAll(".acct-check span")].map(s => s.textContent);
  check("a lifter chooses messages, new weeks and trophies", lOpts.join() === "New messages,A new week in my program,A trophy is earned or given to me", lOpts.join());
  L.closeSheet();
  C.$("acctBtn").click(); await tick();
  C.btn("Turn on for this device", C.$("acctBody")).click();
  await until(async () => (await server.sql("select count(*)::int n from public.push_subscriptions"))[0].n === 2);
  await until(() => C.$("acctBody").querySelector(".acct-check"));
  const cOpts = [...C.$("acctBody").querySelectorAll(".acct-check span")].map(s => s.textContent);
  check("a coach also gets finished sessions", cOpts.includes("A lifter finishes a session") && cOpts.includes("New messages"), cOpts.join());
  C.closeSheet();

  /* ------------------------------------------------------- team thread */
  console.log("\nOne thread with all coaches (the default)");
  L.nav("Messages"); await tick();
  check("the lifter sees the switch, on", L.$("msgBody").querySelector(".msg-switch").checked);
  check("and goes straight into the thread", !!L.$("msgInput") && L.$("msgInput").placeholder === "Message your coaches");
  await L.send("Hi coach, knee is fine");
  check("the message shows at once, as sending", L.bubbles().includes("Hi coach, knee is fine"));
  check("once it's gone, the sender's copy stops saying Sending", await until(() => !L.sending()));
  check("it's stored, from Tom, in the team thread", await until(async () => (await dbMsgs()).some(m => m.body === "Hi coach, knee is fine" && m.thread === "team" && m.email === "tom@test.invalid")));
  check("the coach's phone gets a banner, without the message", await until(() => pushesTo("coach").some(p => p.body === "New message from Tom")) && !pushesTo("coach").some(p => /knee/.test(p.body)));
  check("...that opens the conversation", pushesTo("coach")[0].url.includes("open=messages&lifter=" + tomId + "&thread=team"));
  check("Tom's own phone isn't notified", pushesTo("lifter").length === 0);
  check("the coach's sidebar shows it unread", await until(() => C.badge("Messages") === 1 && C.badge("Inbox") === 1), C.badge("Messages") + "/" + C.badge("Inbox"));
  check("...and so does the menu button (phones)", !C.$("menuDot").hidden);
  C.nav("Inbox"); await tick();
  check("the inbox lists Tom with the message", /Tom[\s\S]*Tom: Hi coach, knee is fine/.test(C.$("inboxBody").textContent), C.$("inboxBody").textContent);
  C.$("inboxBody").querySelector(".msg-thread").click();
  await tick(100);
  check("opening it shows the thread", C.$("viewMessages").classList.contains("active") && C.bubbles().includes("Hi coach, knee is fine"));
  check("with who wrote it", [...C.doc.querySelectorAll("#msgList .msg-who")].some(x => x.textContent === "Tom"));
  check("reading clears the badges", C.badge("Messages") === 0 && C.$("menuDot").hidden);
  check("...on every device (read marker saved)", await until(async () => (await server.sql("select count(*)::int n from public.message_reads"))[0].n === 1));
  check("Tom sees his message was seen, by whom", await until(() => L.seen() === "Seen by owner"), L.seen());
  await C.send("Good. Keep it at RPE 7");
  check("Tom gets the reply live", await until(() => L.bubbles().includes("Good. Keep it at RPE 7")));
  check("...and a banner naming his coach", await until(() => pushesTo("lifter").some(p => p.body === "New message from owner")));

  /* --------------------------------------------- a second coach joins */
  console.log("\nA second coach joins later");
  const J = boot("jordan");
  await tick(200);
  await J.signIn("jordan@test.invalid");
  J.btn("I’m a coach: request access", J.$("acctBody")).click(); await tick();
  J.$("acctCoachName").value = "Jordan";
  J.btn("Send request", J.$("acctBody")).click();
  await until(async () => (await server.sql("select coach_status from public.accounts where email = 'jordan@test.invalid'"))[0].coach_status === "pending");
  J.closeSheet();
  C.sync(); await C.settle();
  C.$("acctBtn").click(); await tick();
  C.btn("Approve", C.$("acctBody")).click();
  await until(async () => (await server.sql("select coach_status from public.accounts where email = 'jordan@test.invalid'"))[0].coach_status === "approved");
  C.closeSheet();
  // Messages so far are older than Jordan's join: make that true in time too.
  await server.sql("update public.messages set created_at = created_at - interval '1 hour'");
  C.nav("Manage program"); await tick(100);
  C.$("dmShareBtn").click(); await tick(50);
  const share2 = C.$("dmShare");
  share2.querySelector('input[placeholder="Another coach’s email"]').value = "jordan@test.invalid";
  C.btn("Share", share2).click();
  await until(async () => (await server.sql("select count(*)::int n from public.lifter_coaches"))[0].n === 2);
  C.$("shareClose").click();
  J.sync(); await J.settle();
  J.nav("Messages"); await tick();
  check("Jordan doesn't see messages from before he joined", J.$("viewMessages").classList.contains("active") && J.bubbles().length === 0, J.bubbles().join("|"));
  await J.send("Welcome aboard, Tom");
  check("his message reaches Tom and the first coach", await until(() => L.bubbles().includes("Welcome aboard, Tom")) && await until(() => { C.nav("Messages"); return C.bubbles().includes("Welcome aboard, Tom"); }));
  check("Tom sees Jordan's name on it", await until(() => [...L.doc.querySelectorAll("#msgList .msg-who")].some(x => x.textContent === "Jordan")));
  await L.send("Thanks both");
  J.sync(); await J.settle(); J.nav("Overview"); J.nav("Messages"); await tick();
  C.sync(); await C.settle(); C.nav("Overview"); C.nav("Messages"); await tick();
  check("both coaches' reads show under Tom's latest", await until(() => L.seen() === "Seen by owner, Jordan"), L.seen());
  check("...while the first coach's latest counts only Tom, not Jordan (who joined after it)",
    await until(() => /^Seen by Tom$/.test(C.seen())), C.seen());
  check("a coach can't clear conversations (the owner only)", !J.btn("Clear", J.$("msgBody")));

  /* --------------------------------------------- one thread per coach */
  console.log("\nTom switches to a private thread per coach");
  L.$("msgBody").querySelector(".msg-switch").click();
  check("saved", await until(async () => (await server.sql("select team_thread from public.lifter_settings"))[0].team_thread === false));
  await tick(100);
  const tl = [...L.doc.querySelectorAll("#msgBody .msg-thread b")].map(b => b.textContent);
  check("Tom now picks a coach, with the old thread as history", tl.includes("owner") && tl.includes("Jordan") && tl.includes("Your coaches (history)"), tl.join());
  [...L.doc.querySelectorAll("#msgBody .msg-thread")].find(b => /owner/.test(b.textContent)).click(); await tick();
  await L.send("Just between us: hip is sore");
  C.sync(); await C.settle();
  C.nav("Overview"); C.nav("Messages"); await tick();
  check("the coach lands in their private thread", C.$("msgBody").querySelector(".msg-title").textContent === "Tom, just you" && C.bubbles().includes("Just between us: hip is sore"), C.$("msgBody").querySelector(".msg-title") && C.$("msgBody").querySelector(".msg-title").textContent);
  J.sync(); await J.settle();
  J.nav("Overview"); J.nav("Messages"); await tick();
  check("the other coach can't see it", !J.bubbles().includes("Just between us: hip is sore"));
  check("...not even in the database", (await J.dev.fetch("messages", { sinceCol: "created_at", orderBy: "created_at" })).every(m => m.body !== "Just between us: hip is sore"));
  C.btn("‹ All threads", C.$("msgBody")).click(); await tick();
  [...C.doc.querySelectorAll("#msgBody .msg-thread")].find(b => /history/.test(b.textContent)).click(); await tick();
  check("the team thread is readable history, with no box to write in", C.bubbles().includes("Hi coach, knee is fine") && !C.$("msgInput"));

  /* ------------------------------------------------- finished sessions */
  console.log("\nTom finishes a day");
  const before = pushesTo("coach").length;
  L.nav("Week 1"); await tick();
  const rows = () => [...L.$("wkList").querySelectorAll("li")];
  rows()[0].click(); await tick();
  L.sync(); await L.settle();
  check("half a day doesn't count", (await server.sql("select count(*)::int n from public.lifter_events"))[0].n === 0);
  rows()[1].querySelector(".act-btn").click(); await tick();    // skip the bench
  check("done + skipped = finished: recorded once", await until(async () => (await server.sql("select week, day from public.lifter_events where kind = 'session_done'")).length === 1));
  check("the coach gets a banner", await until(() => pushesTo("coach").length === before + 1 && pushesTo("coach").slice(-1)[0].body === "Tom finished week 1 · day 1"), JSON.stringify(pushesTo("coach").slice(-1)));
  check("...that opens that week", pushesTo("coach").slice(-1)[0].url.includes("open=week&lifter=" + tomId + "&week=1"));
  rows()[0].click(); await tick(); rows()[0].click(); await tick();
  L.sync(); await L.settle();
  check("unticking and re-ticking doesn't send it again", (await server.sql("select count(*)::int n from public.lifter_events"))[0].n === 1 && pushesTo("coach").length === before + 1);
  C.sync(); await C.settle();
  C.nav("Inbox"); await tick();
  check("the inbox shows it", /Finished week 1 · day 1/.test(C.$("inboxBody").textContent), C.$("inboxBody").textContent);
  C.$("inboxBody").querySelector(".msg-thread").click(); await tick(200);
  check("opening a lifter's chat from the inbox offers Back to Inbox", !!C.btn("‹ Back to Inbox", C.$("msgBody")), C.$("msgBody").textContent.slice(0, 120));
  C.btn("‹ Back to Inbox", C.$("msgBody")).click(); await tick(100);
  check("...which goes back to the inbox", C.$("viewInbox").classList.contains("active") && !C.$("viewMessages").classList.contains("active"));
  L.nav("Messages"); await tick();
  check("a lifter has no such button", !L.btn("‹ Back to Inbox", L.$("msgBody")));

  /* ----------------------------------------------------- new weeks */
  console.log("\nThe coach adds a week");
  C.nav("Manage program"); await tick(100);
  C.btn("Add week", C.$("dmBody")).click(); await tick(200);
  const notice = () => C.$("dmNotice").querySelector(".week-notice");
  check("a Notify button appears", !!notice() && /Week 3 added/.test(notice().textContent) && !!C.btn("Notify Tom", notice()), notice() && notice().textContent);
  C.btn("Notify Tom", notice()).click();
  check("Tom's phone gets a banner", await until(() => pushesTo("lifter").some(p => p.body === "A new week is in your program")));
  check("...that opens week 3", pushesTo("lifter").slice(-1)[0].url.includes("week=3"));
  check("the button turns into a note", await until(() => notice() && /Tom was notified about week 3 · by you/.test(notice().textContent) && !C.btn("Notify Tom", notice())), notice() && notice().textContent);
  J.sync(); await J.settle();
  J.nav("Manage program"); await tick(100);
  const jn = J.$("dmNotice").querySelector(".week-notice");
  check("the other coach sees it's done, with no button", !!jn && /by owner/.test(jn.textContent) && !J.btn("Notify Tom", jn), jn && jn.textContent);
  console.log("\nThe Program Hub is the owner's");
  const hubTab = a => a.$("dmTabs").querySelector('[data-tab="hub"]');
  check("the owner has the Program Hub tab", C.doc.documentElement.classList.contains("is-owner") && C.w.getComputedStyle(hubTab(C)).display !== "none", C.w.getComputedStyle(hubTab(C)).display);
  check("another coach doesn't: the tab is hidden", !J.doc.documentElement.classList.contains("is-owner") && J.w.getComputedStyle(hubTab(J)).display === "none", J.w.getComputedStyle(hubTab(J)).display);
  hubTab(J).click(); await tick(50);
  check("...and pressing it anyway (or asking for it) leaves them on Manage program", J.$("dmPaneHub").classList.contains("hidden") && !J.$("dmPaneManage").classList.contains("hidden"));
  check("...nor does Import offer to build one in it", !J.btn("Build one in Program Hub", J.$("dmBody")) && !/Program Hub/.test(J.$("dmBody").textContent.replace(/Program Hub build.*/, "")), (J.$("dmBody").textContent.match(/.{30}Program Hub.{30}/) || [""])[0]);
  C.nav("Manage program"); await tick(100);
  check("the owner still gets the button to build one in it", !!C.btn("Build one in Program Hub", C.$("dmBody")));
  hubTab(C).click(); await tick(50);
  check("...and the tab opens", !C.$("dmPaneHub").classList.contains("hidden"));
  C.nav("Overview"); await tick(50);
  check("and the server won't send it twice", (await J.dev.rpc("notify_new_week", { p_lifter: tomId })) === null);
  const newWeekPushes = pushesTo("lifter").filter(p => /new week/.test(p.body)).length;
  check("only one new-week banner in all", newWeekPushes === 1, String(newWeekPushes));

  /* ----------------------------------------- choosing what to be told */
  console.log("\nChoosing what to be told about, and tapping a banner");
  L.$("acctBtn").click(); await tick();
  const msgBox = [...L.$("acctBody").querySelectorAll(".acct-check")].find(l => /New messages/.test(l.textContent)).querySelector("input");
  msgBox.click();
  check("switching off messages is saved", await until(async () => (await server.sql("select prefs from public.push_subscriptions where endpoint like '%lifter'"))[0].prefs.messages === false));
  L.closeSheet();
  const lBefore = pushesTo("lifter").length;
  C.nav("Messages"); await tick();
  C.btn("‹ All threads", C.$("msgBody")) && C.btn("‹ All threads", C.$("msgBody")).click(); await tick();
  const mine = [...C.doc.querySelectorAll("#msgBody .msg-thread")].find(b => /just you/.test(b.textContent));
  if (mine) { mine.click(); await tick(); }
  await C.send("Deload next week");
  C.sync(); await C.settle();
  check("then no message banners reach Tom", pushesTo("lifter").length === lBefore);
  L.push.swListeners.forEach(fn => fn({ data: { type: "spotter-open", url: "https://example.github.io/power-logs/power-logs.html?open=week&lifter=" + tomId + "&week=3" } }));
  check("tapping a banner while the app is open goes to the week", await until(() => L.$("viewWeek").classList.contains("active") && /Week 3/.test(L.$("viewWeek").textContent)));

  console.log("\nA problem with messages never holds up the training log");
  await server.sql("revoke select on public.messages from authenticated");
  C.nav("Week 2"); await tick();
  C.$("wkList").querySelector("li").click(); await tick();
  C.sync(); await C.settle();
  const cs = C.store("spotter.cloud.v1");
  check("the tick still syncs, with the training log's status clear", cs.lastError === "" &&
    (await server.sql("select count(*)::int n from public.lifter_marks where state = 'done'"))[0].n >= 2, cs.lastError);
  check("...and the messaging problem is kept to itself", /permission denied/.test(cs.msgError || ""), cs.msgError);
  await server.sql("grant select on public.messages to authenticated");
  C.sync(); await C.settle();
  check("it clears once messages work again", C.store("spotter.cloud.v1").msgError === "");

  /* ------------------------------------------------ offline, sign out */
  console.log("\nOffline, and signing out");
  L.nav("Messages"); await tick();
  L.dev.state.offline = true;
  if (!L.$("msgInput")) { [...L.doc.querySelectorAll("#msgBody .msg-thread")].find(b => /Jordan/.test(b.textContent)).click(); await tick(); }
  await L.send("Written on the plane");
  L.sync(); await L.settle();
  check("offline, it waits on the phone marked as sending", [...L.doc.querySelectorAll("#msgList .msg-time")].some(t => /Sending/.test(t.textContent)));
  L.dev.state.offline = false;
  L.sync(); await L.settle();
  check("back online, it goes", await until(async () => (await dbMsgs()).some(m => m.body === "Written on the plane")));
  check("...and stops saying Sending", await until(() => !L.sending()));
  L.dev.state.offline = true;
  await L.send("Written, then the app was closed");
  L.sync(); await L.settle();
  const L2 = boot("lifter reopened", { dev: L.dev, storage: L.storage() });
  L.dev.state.offline = false;
  await tick(300);
  L2.sync(); await L2.settle();
  L2.nav("Messages"); await tick();
  if (!L2.$("msgList")) { [...L2.doc.querySelectorAll("#msgBody .msg-thread")].find(b => /Jordan/.test(b.textContent)).click(); await tick(); }
  check("reopened later, the queued message goes and shows as sent",
    await until(async () => (await dbMsgs()).some(m => m.body === "Written, then the app was closed")) &&
    await until(() => L2.bubbles().includes("Written, then the app was closed") && !L2.sending()));
  await server.sql("insert into public.push_subscriptions (endpoint, user_id, p256dh, auth) select 'https://push.test/gone', user_id, 'k', 'a' from public.accounts where email = 'tom@test.invalid'");
  L.$("msgBody").querySelector(".msg-switch").click();
  await until(async () => (await server.sql("select team_thread from public.lifter_settings"))[0].team_thread === true);
  await tick(200);
  C.sync(); await C.settle();
  C.nav("Overview"); C.nav("Messages"); await tick();
  L.$("acctBtn").click(); await tick();
  [...L.$("acctBody").querySelectorAll(".acct-check")].find(l => /New messages/.test(l.textContent)).querySelector("input").click();
  await tick(300); L.closeSheet();
  await C.send("Back to one thread");
  console.log("\nThe owner clears a conversation");
  check("the owner has Clear on the thread", !!C.btn("Clear", C.$("msgBody")));
  C.btn("Clear", C.$("msgBody")).click(); await tick();
  check("it asks first", C.$("confirmScrim").classList.contains("show") && /Clear this conversation\?/.test(C.$("confirmTitle").textContent)
    && /all their coaches, including the other coaches/.test(C.$("confirmBody").textContent), C.$("confirmBody").textContent);
  C.$("confirmNo").click(); await tick(200);
  const teamCount = async () => (await server.sql("select count(*)::int n from public.messages where thread = 'team'"))[0].n;
  check("Cancel leaves everything", (await teamCount()) > 0);
  C.btn("Clear", C.$("msgBody")).click(); await tick();
  C.$("confirmYes").click();
  check("confirmed: every team message is gone, the coaches' too", await until(async () => (await teamCount()) === 0));
  check("...private threads are untouched", (await server.sql("select count(*)::int n from public.messages where thread <> 'team'"))[0].n > 0);
  check("...gone from the owner's screen", await until(() => C.bubbles().length === 0), C.bubbles().join("|"));
  J.sync(); await J.settle();
  L.sync(); await L.settle();
  const cached = a => ((a.store("spotter.messages.v1") || {}).list || []).filter(m => m.thread === "team").length;
  check("...and from every other device's copy", await until(() => cached(J) === 0 && cached(L) === 0), cached(J) + "/" + cached(L));
  await C.send("Fresh start");
  check("the thread carries on afterwards", await until(() => L.bubbles().includes("Fresh start") || cached(L) === 1));
  check("a device that's gone is forgotten when a push bounces", await until(async () => (await server.sql("select count(*)::int n from public.push_subscriptions where endpoint = 'https://push.test/gone'"))[0].n === 0));
  console.log("\nThe owner names themselves");
  C.$("acctBtn").click(); await tick();
  check("the owner's account sheet has Your name", !!C.$("acctName"));
  C.$("acctName").value = "  Coach   Emm ";
  C.btn("Save name", C.$("acctBody")).click();
  check("saved, tidied up", await until(async () => (await server.sql("select display_name from public.accounts where email = $1", [OWNER_EMAIL]))[0].display_name === "Coach Emm"));
  check("...and shown at the top of the sheet", await until(() => /^Coach Emm · owner@/.test(C.$("acctBody").querySelector(".acct-who").textContent)), C.$("acctBody").querySelector(".acct-who").textContent);
  C.closeSheet();
  const lBanner = pushesTo("lifter").length;
  await C.send("Named now");
  check("Tom sees the new name on the owner's messages", await until(() => { L.nav("Overview"); L.nav("Messages"); return [...L.doc.querySelectorAll("#msgList .msg-who")].some(x => x.textContent === "Coach Emm") && ![...L.doc.querySelectorAll("#msgList .msg-who")].some(x => x.textContent === "owner"); }));
  check("...and in his notification", await until(() => pushesTo("lifter").slice(lBanner).some(p => p.body === "New message from Coach Emm")), JSON.stringify(pushesTo("lifter").slice(lBanner)));
  await L.send("Nice name");
  C.sync(); await C.settle(); C.nav("Overview"); C.nav("Messages"); await tick();
  L.sync(); await L.settle();
  check("...and in Seen", await until(() => /Coach Emm/.test(L.seen())), L.seen());
  L.$("acctBtn").click(); await tick();
  check("a lifter has no name field (they go by #Name)", !L.$("acctName"));
  L.btn("Sign out", L.$("acctBody")).click(); await tick(300);
  L.$("confirmYes").click();
  check("signing out stops this phone's notifications", await until(async () => (await server.sql("select count(*)::int n from public.push_subscriptions where endpoint like '%lifter'"))[0].n === 0) && L.push.unsubscribed === 1);
  check("...and clears its messages", await until(() => (L.store("spotter.messages.v1") || {}).list.length === 0));

  check("the function refused nothing it shouldn't have", server.invocations.every(i => !i.result.error), JSON.stringify(server.invocations.filter(i => i.result.error)));
  check("no script errors on any device", apps.every(a => a.real().length === 0), apps.map(a => a.label + ": " + a.real().join(" | ")).filter(s => !/: $/.test(s)).join(" || "));
  console.log(`\n${checks} checks · ${failures === 0 ? "ALL PASSED" : failures + " FAILED"}\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
