/* Announcements end to end on the real database rules: the owner announces to everyone (the owner
 * included), a coach to their own lifters, as a pop-up on Home that stacks, scrolls and stays until each
 * person closes it (saved, so it is closed on their other devices too).
 * Run: node test-announce.js
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
const TOM = "#Name,Tom\r\n#Block,Prep\r\nWeek,Day,Exercise,Weight (kg),Sets,Reps,RPE,Notes\r\n1,1,Squat,160,4,4,7,\r\n";

(async () => {
  const server = await pgServer();

  function boot(label, reuse) {
    const dev = reuse ? reuse.dev : server.device(label), errors = [];
    const dom = new JSDOM(html, {
      runScripts: "dangerously", pretendToBeVisual: true,
      url: "https://example.github.io/power-logs/app.html",
      virtualConsole: new VirtualConsole().on("jsdomError", e => errors.push(e.message)).on("error", m => errors.push(String(m))),
      beforeParse(w) {
        w.__spotterCloud = dev;
        w.__spotterPrivateStore = { get: async () => undefined, put: async () => {}, del: async () => {} };
        if (reuse) Object.entries(reuse.storage).forEach(([k, v]) => w.localStorage.setItem(k, v));
        const reg = { addEventListener() {}, pushManager: { getSubscription: async () => null, subscribe: async () => null } };
        Object.defineProperty(w.navigator, "serviceWorker", { configurable: true, value: { ready: Promise.resolve(reg), register: async () => reg, controller: null, addEventListener() {} } });
        w.PushManager = function () {};
        w.Notification = { permission: "default", requestPermission: async () => "granted" };
        w.HTMLCanvasElement.prototype.getContext = function () { return new Proxy({}, { get: (t, p) => (t[p] !== undefined ? t[p] : function () {}), set: (t, p, v) => { t[p] = v; return true; } }); };
        w.Path2D = function () {};
      },
    });
    const w = dom.window, doc = w.document, $ = id => doc.getElementById(id);
    w.Element.prototype.scrollIntoView = function () {};
    w.scrollTo = function () {};
    const app = {
      label, dev, w, doc, $,
      real: () => errors.filter(e => !/Not implemented|HTMLCanvasElement|getContext|Chart is not defined/i.test(e)),
      nav(l) { const b = [...doc.querySelectorAll("#sideNav .nav-item")].find(n => n.querySelector(".nav-label").textContent === l); if (b) b.click(); return !!b; },
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
      storage: () => { const o = {}; for (let i = 0; i < w.localStorage.length; i++) { const k = w.localStorage.key(i); o[k] = w.localStorage.getItem(k); } return o; },
      shown: () => $("annScrim").classList.contains("show"),
      items: () => [...doc.querySelectorAll("#annList .ann-item")],
      async home() { app.sync(); await app.settle(); if (!app.nav("Home")) { const b = $("ovHome"); if (b) b.click(); } await tick(200); },
    };
    return app;
  }
  const rows = (sql, args) => server.sql(sql, args);
  const anns = () => rows("select a.scope, a.body, x.email from public.announcements a left join public.accounts x on x.user_id = a.author_id order by a.created_at");

  /* ------------------------------------------------------------ set-up */
  console.log("Set-up: an owner with Tom, a second coach with Sam, and a stranger");
  const O = boot("owner");
  await tick(200);
  await O.load(TOM, "tom.csv");
  await O.signIn(OWNER_EMAIL);
  O.$("confirmYes").click();
  const tomId = await (async () => { await until(async () => (await rows("select count(*)::int n from public.lifters"))[0].n === 1); return (await rows("select id from public.lifters where name = 'Tom'"))[0].id; })();
  O.nav("Manage program"); await tick(100);
  O.$("dmShareBtn").click(); await tick(50);
  const em = O.$("dmShare").querySelector('input[type="email"]');
  em.value = "tom@test.invalid"; em.dispatchEvent(new O.w.Event("blur"));
  await until(async () => (await rows("select lifter_email from public.lifters"))[0].lifter_email === "tom@test.invalid");
  await O.settle();
  O.$("shareClose").click();
  const T = boot("tom"); await tick(200); await T.signIn("tom@test.invalid");
  const S = boot("sam"); await tick(200); await S.signIn("sam@test.invalid");
  const K = boot("kay"); await tick(200); await K.signIn("kay@test.invalid");
  const X = boot("stranger"); await tick(200); await X.signIn("stranger@test.invalid");
  const uid = async email => (await rows("select user_id from public.accounts where email = $1", [email]))[0].user_id;
  const kayId = await uid("kay@test.invalid");
  await rows("update public.accounts set coach_status = 'approved', display_name = 'Coach Kay' where user_id = $1", [kayId]);
  const samId = crypto.randomUUID();
  await rows("insert into public.lifters (id, name, program, lifter_email) values ($1, 'Sam', '{\"weeks\":[]}'::jsonb, 'sam@test.invalid')", [samId]);
  await rows("insert into public.lifter_coaches (lifter_id, coach_id) values ($1, $2)", [samId, kayId]);
  for (const a of [O, T, S, K, X]) { a.sync(); await a.settle(); }

  /* ------------------------------------------------------------ the button */
  console.log("\nThe Announce button");
  await O.home(); await K.home(); await T.home(); await S.home(); await X.home();
  check("the owner and a coach have an Announce button on Home", !O.$("homeAnnounce").hidden && !K.$("homeAnnounce").hidden);
  check("a lifter, and someone with no program, don't", T.$("homeAnnounce").hidden && S.$("homeAnnounce").hidden && X.$("homeAnnounce").hidden);
  check("nobody has a pop-up yet", !O.shown() && !K.shown() && !T.shown() && !S.shown() && !X.shown());

  /* ------------------------------------------------------------ a coach, to their lifters */
  console.log("\nA coach announces to their lifters");
  K.$("homeAnnounce").click(); await tick(100);
  check("it opens a window to type in", K.$("annComposeScrim").classList.contains("show") && K.$("annText").tagName === "TEXTAREA");
  check("a coach has no choice of audience: their own lifters", K.$("annAudience").hidden && /Goes to 1 lifter who has signed in/.test(K.$("annTo").textContent), K.$("annTo").textContent);
  K.$("annSend").click(); await tick(50);
  check("an empty announcement isn't sent", /Write the announcement first/.test(K.$("toastMsg").textContent) && (await anns()).length === 0);
  K.$("annText").value = "Squat day moved to 6pm 💪\nBring your belts"; K.$("annText").dispatchEvent(new K.w.Event("input"));
  check("it counts the characters", /^\d+ \/ 2000$/.test(K.$("annLen").textContent));
  K.$("annEmojiBtn").click();
  check("and has an emoji picker", !!K.$("annEmojiSlot").querySelector("#msgEmoji"));
  K.$("annEmojiBtn").click();
  K.$("annSend").click();
  check("sending saves it as the coach's, to lifters", await until(async () => (await anns()).length === 1) && (await anns())[0].scope === "lifters" && (await anns())[0].email === "kay@test.invalid" && (await anns())[0].body === "Squat day moved to 6pm 💪\nBring your belts", JSON.stringify(await anns()));
  check("the window closes and says so", !K.$("annComposeScrim").classList.contains("show") && /Announced to your lifters/.test(K.$("toastMsg").textContent));
  check("the coach doesn't get a pop-up for their own", (K.nav("Home"), await tick(200), !K.shown()));
  check("it is listed under their recent announcements", (K.$("homeAnnounce").click(), await tick(100), /Squat day moved/.test(K.$("annSent").textContent)));
  K.$("annComposeClose").click();

  await S.home(); await T.home(); await X.home(); await O.home();
  check("their lifter gets the pop-up on Home", await until(() => S.shown() && S.items().length === 1), String(S.items().length));
  const it = S.items()[0];
  check("saying what it says, line breaks included, and who from", /Squat day moved to 6pm/.test(it.textContent) && /Bring your belts/.test(it.textContent) && /From Coach Kay/.test(it.textContent), it.textContent);
  check("with the date and time in small print", /\d{1,2} \w{3} \d{4}, \d{2}:\d{2}/.test(it.querySelector(".ann-meta").textContent) && S.w.getComputedStyle(it.querySelector(".ann-meta")).fontSize === "11px");
  check("on a light pastel green with black text", S.w.getComputedStyle(it).backgroundColor === "rgb(216, 241, 216)" && S.w.getComputedStyle(it.querySelector(".ann-body")).color === "rgb(17, 17, 17)");
  check("nobody else's lifters get it: not Tom, not a stranger, not the owner", !T.shown() && !X.shown() && !O.shown());

  /* ------------------------------------------------------------ stays until closed */
  console.log("\nIt stays until closed");
  S.$("annScrim").dispatchEvent(new S.w.MouseEvent("click", { bubbles: true }));
  S.doc.dispatchEvent(new S.w.KeyboardEvent("keydown", { key: "Escape" }));
  await tick(100);
  check("clicking outside it, or Escape, doesn't dismiss it", S.shown() && S.items().length === 1);
  S.nav("Overview"); await tick(100);
  check("leaving Home hides it...", !S.shown());
  S.nav("Home"); await tick(150);
  check("...and it is back on Home, still open", S.shown() && S.items().length === 1);
  S.items()[0].querySelector(".ann-x").click();
  check("the close button closes it", !S.shown());
  check("...saved, so it is closed for them", await until(async () => (await rows("select count(*)::int n from public.announcement_closed"))[0].n === 1));
  const S2 = boot("sam-phone"); await tick(200); await S2.signIn("sam@test.invalid"); await S2.home();
  check("on another device of theirs it is already closed", !S2.shown() && S2.items().length === 0);
  const S3 = boot("sam-again", { dev: S.dev, storage: S.storage() }); await tick(300); await S3.home();
  check("and it stays closed after the app is restarted", !S3.shown());

  /* ------------------------------------------------------------ the owner, to everyone */
  console.log("\nThe owner announces to everyone");
  O.$("homeAnnounce").click(); await tick(100);
  check("the owner picks the audience, Everyone to start with", !O.$("annAudience").hidden && O.$("annAudience").querySelector(".active").getAttribute("data-aud") === "all" && /everyone who uses the app, you included/.test(O.$("annTo").textContent), O.$("annTo").textContent);
  O.$("annAudience").querySelector('[data-aud="lifters"]').click();
  check("...or just their own lifters", /Goes to 1 lifter/.test(O.$("annTo").textContent), O.$("annTo").textContent);
  O.$("annAudience").querySelector('[data-aud="all"]').click();
  O.$("annText").value = "Gym is closed on Friday"; O.$("annText").dispatchEvent(new O.w.Event("input"));
  O.$("annSend").click();
  check("it is saved as one to everyone", await until(async () => (await anns()).some(a => a.scope === "all" && a.body === "Gym is closed on Friday" && a.email === OWNER_EMAIL)));
  check("and says so", /Announced to everyone/.test(O.$("toastMsg").textContent));
  await tick(200);
  for (const a of [O, T, S, K, X]) await a.home();
  check("everyone gets it: the lifters, the coach, a stranger and the owner too", [O, T, S, K, X].every(a => a.shown() && a.items().length === (a === S ? 1 : 1)), [O, T, S, K, X].map(a => a.label + ":" + a.items().length).join(" "));
  check("the owner's own says it is theirs", /You ·/.test(O.items()[0].textContent), O.items()[0].textContent);
  check("Tom has only that one, not Coach Kay's (he isn't her lifter)", T.items().length === 1 && /Gym is closed/.test(T.items()[0].textContent));

  /* ------------------------------------------------------------ stacking and scrolling */
  console.log("\nStacking and scrolling");
  O.$("homeAnnounce").click(); await tick(100);
  O.$("annText").value = "Meet entries open Monday"; O.$("annText").dispatchEvent(new O.w.Event("input"));
  O.$("annSend").click();
  await until(async () => (await anns()).length === 3);
  await T.home();
  check("someone who hasn't closed the first now sees both, stacked", T.items().length === 2 && /2 announcements/.test(T.$("annCount").textContent), T.items().length + " " + T.$("annCount").textContent);
  check("newest first", /Meet entries/.test(T.items()[0].textContent) && /Gym is closed/.test(T.items()[1].textContent));
  check("in a list that scrolls", T.w.getComputedStyle(T.$("annList")).overflowY === "scroll" && T.w.getComputedStyle(T.$("annList")).minHeight === "0px");
  T.items()[0].querySelector(".ann-x").click();
  check("closing one leaves the other open", T.shown() && T.items().length === 1 && /Gym is closed/.test(T.items()[0].textContent));
  T.items()[0].querySelector(".ann-x").click();
  check("and when none are left the pop-up goes", !T.shown());
  const Z = boot("late"); await tick(200); await Z.signIn("late@test.invalid"); await Z.home();
  check("someone who joins afterwards doesn't get the old ones", !Z.shown());

  /* ------------------------------------------------------------ deleting */
  console.log("\nTaking one back");
  O.$("homeAnnounce").click(); await tick(150);
  check("the writer sees what they sent, with Delete", /Meet entries open Monday/.test(O.$("annSent").textContent) && !!O.btn("Delete", O.$("annSent")));
  O.btn("Delete", O.$("annSent")).click(); await tick(100);
  O.$("confirmYes").click();
  check("deleting removes it from the database", await until(async () => (await anns()).length === 2 && !(await anns()).some(a => /Meet entries/.test(a.body))));
  O.$("annComposeClose").click();
  X.sync(); await X.settle();
  check("and from a person who hadn't closed it", !X.items().some(i => /Meet entries/.test(i.textContent)) && X.items().length === 1);

  /* ------------------------------------------------------------ signing out */
  console.log("\nSigning out");
  T.$("acctBtn").click(); await tick();
  T.btn("Sign out", T.$("acctBody")).click(); await tick(300);
  T.$("confirmYes").click();
  check("signing out clears them from the device", await until(() => (JSON.parse(T.storage()["spotter.announce.v1"] || '{"list":[]}').list || []).length === 0));

  const bad = [O, T, S, S2, S3, K, X, Z].reduce((a, x) => a.concat(x.real()), []);
  check("no script errors on any device", bad.length === 0, bad.join(" | ").slice(0, 400));
  console.log(`\n${checks} checks · ${failures === 0 ? "ALL PASSED" : failures + " FAILED"}\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
