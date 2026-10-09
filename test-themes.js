/* Colour themes (the Color theme item in the ⋯ menu) and the owner's "who is online" dots on the Lifters page.
 * Run: node test-themes.js
 *
 * Like test-lifteraccess.js: each device is its own jsdom copy of app.html on one in-memory Postgres running
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
const TOM = "#Name,Tom\r\n#Block,Prep\r\n#Bodyweight,82\r\n#Max,Squat,172.5\r\n#Max,Bench,127.5\r\n#Max,Deadlift,202.5\r\n" +
  "Week,Day,Exercise,Weight (kg),Sets,Reps,RPE,Notes\r\n1,1,Squat,160,4,4,7,\r\n1,1,Bench,110,4,5,7,\r\n1,2,Deadlift,200,3,3,8,\r\n";

(async () => {
  const server = await pgServer();

  function boot(label, store) {
    const dev = server.device(label), errors = [], rpcs = [];
    const orig = dev.rpc;
    dev.rpc = function (fn, args) { rpcs.push(fn); return orig.call(dev, fn, args); };
    const dom = new JSDOM(html, {
      runScripts: "dangerously", pretendToBeVisual: true,
      url: "https://example.github.io/power-logs/app.html",
      virtualConsole: new VirtualConsole().on("jsdomError", e => errors.push(e.message)).on("error", m => errors.push(String(m))),
      beforeParse(w) {
        w.__spotterCloud = dev;
        for (const k of Object.keys(store || {})) w.localStorage.setItem(k, store[k]);
      },
    });
    const w = dom.window, doc = w.document, $ = id => doc.getElementById(id);
    w.Element.prototype.scrollIntoView = function () {};
    w.scrollTo = function () {};
    const app = {
      label, dev, w, doc, $, rpcs,
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
      accent: () => doc.documentElement.getAttribute("data-accent"),
      opts: () => [...doc.querySelectorAll("#accentList .accent-opt")],
      statusTint: () => doc.getElementById("themeColorMeta").getAttribute("content"),
      lifterRows: () => [...doc.querySelectorAll("#liftersBody .msg-thread")],
    };
    return app;
  }
  const rows = (sql, args) => server.sql(sql, args);

  /* ------------------------------------------------------------ the picker */
  console.log("Colour themes: the picker in the ⋯ menu");
  const O = boot("owner");
  await tick(200);
  check("a fresh device wears Sage Green: no accent attribute, the plain sage status bar", O.accent() === null && O.statusTint() === "#f1f3ee", O.accent() + " " + O.statusTint());
  O.$("moreBtn").click(); await tick(50);
  const item = O.doc.querySelector('#moreMenu [data-for="accentBtn"]');
  check("the ⋯ menu has a Color theme item", !!item && /Color theme/.test(item.textContent));
  item.click(); await tick(50);
  check("it opens the picker with the five themes, in order", O.$("accentScrim").classList.contains("show")
    && O.opts().map(b => b.getAttribute("data-accent")).join() === "sage,ocean,purple,amber,charcoal", O.opts().map(b => b.getAttribute("data-accent")).join());
  check("...named Sage Green, Ocean Blue, Purple Clean, Amber Warm and Charcoal Mode, each with its tagline", [["Sage Green", "Fresh & Calm"], ["Ocean Blue", "Trust & Focus"], ["Purple Clean", "Modern & Energetic"], ["Amber Warm", "Friendly & Inviting"], ["Charcoal Mode", "Sleek & Professional"]]
    .every(([n, s], i) => O.opts()[i].textContent.includes(n) && O.opts()[i].textContent.includes(s)));
  check("...each showing five swatches", O.opts().every(b => b.querySelectorAll(".accent-sw i").length === 5));
  check("Sage Green is the ticked one", O.opts()[0].getAttribute("aria-pressed") === "true" && O.opts().slice(1).every(b => b.getAttribute("aria-pressed") === "false") && !!O.opts()[0].querySelector(".accent-check"));
  O.opts()[1].click(); await tick(50);
  check("choosing Ocean Blue applies it at once", O.accent() === "ocean" && O.w.localStorage.getItem("spotter.accent") === '"ocean"');
  check("...the status bar takes the theme's page tint", O.statusTint() === "#eef3f9", O.statusTint());
  check("...the picker stays open with the tick moved", O.$("accentScrim").classList.contains("show") && O.opts()[1].getAttribute("aria-pressed") === "true" && O.opts()[0].getAttribute("aria-pressed") === "false");
  O.opts()[4].click(); await tick(50);
  check("Charcoal Mode likewise", O.accent() === "charcoal" && O.statusTint() === "#f1f2f3");
  O.$("themeBtn").click(); await tick(50);
  check("dark mode keeps the colour theme and the dark status bar", O.doc.documentElement.getAttribute("data-theme") === "dark" && O.accent() === "charcoal" && O.statusTint() === "#14171a", O.doc.documentElement.getAttribute("data-theme") + " " + O.statusTint());
  O.opts()[0].click(); await tick(50);
  check("going back to Sage Green removes the attribute", O.accent() === null && O.w.localStorage.getItem("spotter.accent") === '"sage"');
  O.$("accentClose").click();
  check("the close button closes it", !O.$("accentScrim").classList.contains("show"));
  O.$("accentBtn").click(); await tick(50);
  O.doc.dispatchEvent(new O.w.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await tick(50);
  check("Escape closes it too", !O.$("accentScrim").classList.contains("show"));

  console.log("\nColour themes: remembered, and wired into the page");
  const R = boot("reload", { "spotter.accent": '"amber"' });
  await tick(200);
  check("a device that chose Amber Warm starts in it", R.accent() === "amber" && R.statusTint() === "#faf3ea", R.accent() + " " + R.statusTint());
  const bad = boot("junk", { "spotter.accent": '"hotpink"' });
  await tick(200);
  check("an unknown saved value falls back to Sage Green", bad.accent() === null);
  const css = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
  check("the stylesheet has a light and a dark rule for each of the four other themes", ["ocean", "purple", "amber", "charcoal"].every(id =>
    css.includes(`html:not([data-theme="dark"])[data-accent="${id}"]`) && css.includes(`html[data-theme="dark"][data-accent="${id}"]`)));
  check("the header button is hidden on phones (the ⋯ menu has it) like Theme and About", /#themeBtn, #accentBtn, #aboutBtn \{ display: none; \}/.test(css));
  check("no script errors", O.real().length === 0 && R.real().length === 0, O.real().concat(R.real()).join(" | "));

  /* ------------------------------------------------------------ who is online */
  console.log("\nWho is online: set-up (the owner coaches Tom, a second coach has Sam)");
  await O.load(TOM, "tom.csv");
  await O.signIn(OWNER_EMAIL);
  O.$("confirmYes").click();
  await until(async () => (await rows("select count(*)::int n from public.lifters"))[0].n === 1);
  await O.settle();
  O.nav("Manage program"); await tick(100);
  O.$("dmShareBtn").click(); await tick(50);
  const em = O.$("dmShare").querySelector('input[type="email"]');
  em.value = "tom@test.invalid"; em.dispatchEvent(new O.w.Event("blur"));
  await until(async () => (await rows("select lifter_email from public.lifters"))[0].lifter_email === "tom@test.invalid");
  await O.settle();
  O.$("shareClose").click();
  const T = boot("tom"); await tick(200); await T.signIn("tom@test.invalid");
  const K = boot("kay"); await tick(200); await K.signIn("kay@test.invalid");
  const uid = async email => (await rows("select user_id from public.accounts where email = $1", [email]))[0].user_id;
  const kayId = await uid("kay@test.invalid"), tomUser = await uid("tom@test.invalid");
  await rows("update public.accounts set coach_status = 'approved', display_name = 'Coach Kay' where user_id = $1", [kayId]);
  const samId = crypto.randomUUID();
  await rows("insert into public.lifters (id, name, program, lifter_email) values ($1, 'Sam', '{\"weeks\":[]}'::jsonb, 'sam@test.invalid')", [samId]);
  await rows("insert into public.lifter_coaches (lifter_id, coach_id) values ($1, $2)", [samId, kayId]);
  const tomLifter = (await rows("select id from public.lifters where name = 'Tom'"))[0].id;
  await rows("insert into public.lifter_coaches (lifter_id, coach_id) values ($1, $2)", [tomLifter, kayId]);
  for (const a of [O, T, K]) { a.sync(); await a.settle(); }

  console.log("\nEvery signed-in device reports in");
  check("Tom's device told the server he is here", T.rpcs.includes("touch_presence") && (await rows("select 1 from public.user_presence where user_id = $1", [tomUser])).length === 1, T.rpcs.join());
  check("so did the coach's and the owner's", K.rpcs.includes("touch_presence") && O.rpcs.includes("touch_presence"));

  console.log("\nThe owner sees the dots");
  O.nav("Lifters"); await tick(100);
  await until(() => /online/.test(O.$("liftersSub").textContent) && O.lifterRows().some(r => r.querySelector(".pres-dot")));
  await until(() => O.lifterRows().some(r => /Tom/.test(r.textContent) && r.querySelector(".pres-dot.on")));
  const tomRow = () => O.lifterRows().find(r => /Tom/.test(r.querySelector("b").textContent));
  check("the owner's Lifters page asked who is online", O.rpcs.includes("presence_online"), O.rpcs.join());
  check("Tom (signed in, on the app) has a green dot and the word Online", !!tomRow().querySelector(".pres-dot.on") && /Online/.test(tomRow().textContent), tomRow().textContent);
  check("the dot is labelled for screen readers", tomRow().querySelector(".pres-dot").getAttribute("aria-label") === "Online now");
  check("the subtitle counts how many are online", /\b1 online\b/.test(O.$("liftersSub").textContent), O.$("liftersSub").textContent);

  console.log("\nWhen Tom stops reporting in he goes grey");
  await rows("update public.user_presence set seen_at = now() - interval '10 minutes' where user_id = $1", [tomUser]);
  O.nav("Home"); await tick(50);
  // the page asks again at most every 20 s: move its clock on, then open the page again
  const realNow = O.w.Date.now.bind(O.w.Date);
  O.w.Date.now = () => realNow() + 60000;
  O.nav("Lifters"); await tick(50);
  const stale = await until(async () => { O.nav("Lifters"); await tick(80); return !!tomRow() && !tomRow().querySelector(".pres-dot.on") && /\b0 online\b/.test(O.$("liftersSub").textContent); }, 5000);
  check("grey dot, no Online word, 0 online", stale && !/Online/.test(tomRow().textContent) && !!tomRow().querySelector(".pres-dot") && tomRow().querySelector(".pres-dot").getAttribute("aria-label") === "Offline", O.$("liftersSub").textContent);

  console.log("\nA coach doesn't get the indicator");
  K.nav("Lifters"); await tick(300);
  check("the coach's Lifters page lists their lifters", K.lifterRows().length >= 2, String(K.lifterRows().length));
  check("...with no dots, no Online word and no count", K.doc.querySelectorAll("#liftersBody .pres-dot").length === 0 && !/online/i.test(K.$("liftersBody").textContent) && !/online/i.test(K.$("liftersSub").textContent), K.$("liftersSub").textContent);
  check("...and the coach's device never even asks", !K.rpcs.includes("presence_online"), K.rpcs.join());
  check("the lifter's device doesn't ask either", !T.rpcs.includes("presence_online"));

  console.log("\nSigning out takes you off the list");
  const kayRowBefore = (await rows("select 1 from public.user_presence where user_id = $1", [kayId])).length;
  await K.w.eval("void 0");
  K.$("acctBtn").click(); await tick(100);
  const so = K.btn("Sign out", K.$("acctBody"));
  if (so) { so.click(); await tick(100); const yes = K.$("confirmYes"); if (yes && yes.offsetParent !== null || K.$("confirmScrim") && K.$("confirmScrim").classList.contains("show")) yes.click(); }
  await until(async () => (await rows("select 1 from public.user_presence where user_id = $1", [kayId])).length === 0, 6000);
  check("her row was there, and sign-out removed it", kayRowBefore === 1 && (await rows("select 1 from public.user_presence where user_id = $1", [kayId])).length === 0, String(kayRowBefore));

  check("no script errors on any device", [O, T, K].every(a => a.real().length === 0), [O, T, K].map(a => a.real().join(" | ")).join(" // "));

  console.log(`\n${checks} checks · ${failures ? failures + " FAILED" : "ALL PASSED"}`);
  process.exit(failures ? 1 : 0);
})();
