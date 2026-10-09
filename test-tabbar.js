/* The floating tab bar (phones and tablets): its five buttons, what each opens, which one is lit, the red dots,
 * where it hides, and that it follows the coach's Lifter access. Run: node test-tabbar.js
 *
 * (jsdom doesn't apply media queries, so this checks the bar the page builds; the CSS that shows it on phones
 * and tablets only is checked as text.)
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
const TOM = "#Name,Tom\r\n#Block,Prep\r\n#Max,Squat,172.5\r\nWeek,Day,Exercise,Weight (kg),Sets,Reps,RPE,Notes\r\n1,1,Squat,160,4,4,7,\r\n";

(async () => {
  const server = await pgServer();

  function boot(label) {
    const dev = server.device(label), errors = [];
    const dom = new JSDOM(html, {
      runScripts: "dangerously", pretendToBeVisual: true,
      url: "https://example.github.io/power-logs/app.html",
      virtualConsole: new VirtualConsole().on("jsdomError", e => errors.push(e.message)).on("error", m => errors.push(String(m))),
      beforeParse(w) { w.__spotterCloud = dev; },
    });
    const w = dom.window, doc = w.document, $ = id => doc.getElementById(id);
    w.Element.prototype.scrollIntoView = function () {};
    w.scrollTo = function () {};
    const app = {
      label, dev, w, doc, $,
      real: () => errors.filter(e => !/Not implemented|HTMLCanvasElement|getContext|Chart is not defined/i.test(e)),
      bar: () => [...$("tabBar").querySelectorAll(".tb-item")],
      names: () => app.bar().map(b => b.getAttribute("aria-label")),
      lit: () => app.bar().filter(b => b.classList.contains("active")).map(b => b.getAttribute("aria-label")),
      dots: () => app.bar().filter(b => b.querySelector(".tb-dot")).map(b => b.getAttribute("aria-label")),
      tap: name => { const b = app.bar().find(x => x.getAttribute("aria-label") === name); if (b) b.click(); return !!b; },
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
      },
      closeSheet() { $("acctClose").click(); },
      active: () => [...doc.querySelectorAll(".view.active")].map(v => v.id).join(),
    };
    return app;
  }
  const rows = (sql, args) => server.sql(sql, args);

  /* ------------------------------------------------------------ the styling */
  console.log("The look");
  const css = html.slice(html.indexOf("The floating tab bar"), html.indexOf("The floating tab bar") + 3800);
  check("it is shown on phones and tablets only: a narrow window, or a touch screen without a mouse", /@media \(max-width: 1024px\), \(pointer: coarse\) and \(hover: none\) and \(max-width: 1400px\)/.test(css));
  check("...and not otherwise (hidden by default, so computers keep only the side menu)", /\.tabbar \{ display: none; \}/.test(html));
  check("it wears the colour theme (--bar-bg fill, --bar-ink icons, --bar-line outline, --bar-active page highlight), so every theme and dark mode follow by themselves", /backdrop-filter: blur\(20px\)/.test(css) && /background: var\(--bar-bg\); border: 1px solid var\(--bar-line\)/.test(css) && /color: var\(--bar-ink\)/.test(css) && /\.tb-item\.active \{ background: var\(--bar-active\)/.test(css) && /html\[data-theme="dark"\] \.tabbar/.test(css));
  check("the floating chat button, the message pop-up and the Payments + sit above it", /body\.has-tabbar \.chat-dock/.test(css) && /body\.has-tabbar #toast/.test(css) && /body\.has-tabbar \.pay-add/.test(css));
  check("the left menu button and menu are not touched by it", /\.menu-btn \{ display: grid; \}/.test(html));
  check("the person icon leaves the header only where the bar shows (it is inside that rule, so computers keep it)", /\.acct-btn \{ display: none; \}/.test(css));
  check("the left menu has no Rearrange lifters button", !/id="orderBtn"/.test(html));

  /* ------------------------------------------------------------ set-up */
  console.log("\nSet-up: the owner coaches Tom, who signs in");
  const C = boot("coach");
  await tick(200);
  await C.load(TOM, "tom.csv");
  await C.signIn(OWNER_EMAIL);
  C.closeSheet(); await tick(100);
  C.$("confirmYes").click();
  await until(async () => (await rows("select count(*)::int n from public.lifters"))[0].n === 1);
  await C.settle();
  C.nav = l => { const b = [...C.doc.querySelectorAll("#sideNav .nav-item")].find(n => n.querySelector(".nav-label").textContent === l); if (b) b.click(); return !!b; };
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
  L.closeSheet(); await tick(100);
  C.sync(); await C.settle();
  const tomId = (await rows("select id from public.lifters"))[0].id;

  /* ------------------------------------------------------------ a coach */
  console.log("\nThe coach's bar");
  C.nav("Current Program"); await tick(100);
  check("five buttons: Home, Current Program, Inbox, Analytics, Account", C.names().join() === "Home,Current Program,Inbox,Lifter’s Analytics,Account", C.names().join());
  check("the bar is showing, and the page knows (so the floating things move up)", !C.$("tabBar").hidden && C.doc.body.classList.contains("has-tabbar"));
  check("each is a button with a label, no words on it", C.bar().every(b => b.tagName === "BUTTON" && b.querySelector("svg") && b.textContent.trim() === ""));
  check("on the Current Program page, that one is lit", C.lit().join() === "Current Program", C.lit().join());
  C.tap("Home"); await tick(100);
  check("Home opens Home and lights up", C.active() === "viewHome" && C.lit().join() === "Home", C.active() + " " + C.lit());
  C.tap("Lifter’s Analytics"); await tick(100);
  check("Analytics opens it and lights up", C.active() === "viewAnalytics" && C.lit().join() === "Lifter’s Analytics");
  C.tap("Current Program"); await tick(100);
  check("Current Program comes back", C.active() === "viewOverview" && C.lit().join() === "Current Program");
  C.tap("Inbox"); await tick(100);
  check("a coach's Messages button is the Inbox of every lifter", C.active() === "viewInbox" && C.lit().join() === "Inbox", C.active());
  C.tap("Account"); await tick(100);
  check("Account opens the account sheet", C.$("acctScrim").classList.contains("show"));
  C.closeSheet(); await tick(50);

  console.log("\nUnread messages");
  check("no red dot to begin with", C.dots().length === 0, C.dots().join());
  await L.dev.insert("messages", [{ lifter_id: tomId, thread: "team", sender_id: L.dev.user.id, body: "Hi coach" }]);   // from Tom's phone
  C.sync(); await C.settle();
  check("a message from Tom puts a red dot on the Inbox button", C.dots().join() === "Inbox", C.dots().join());
  C.tap("Inbox"); await tick(100);
  [...C.doc.querySelectorAll("#inboxBody button")].find(b => /Tom/.test(b.textContent)) && [...C.doc.querySelectorAll("#inboxBody button")].find(b => /Tom/.test(b.textContent)).click();
  await tick(200);
  check("in a conversation the bar steps aside, so it can't cover the message box", C.active() === "viewMessages" && C.$("tabBar").hidden && !C.doc.body.classList.contains("has-tabbar"), C.active());
  await C.settle();
  C.tap("Home") || C.nav("Current Program"); await tick(100);
  check("...and returns afterwards, with the dot gone once it's read", !C.$("tabBar").hidden && C.dots().length === 0, C.dots().join());

  console.log("\nA field has focus");
  const field = C.doc.createElement("input"); field.type = "text"; C.doc.body.appendChild(field);
  const box = C.doc.createElement("input"); box.type = "checkbox"; C.doc.body.appendChild(box);
  field.dispatchEvent(new C.w.FocusEvent("focusin", { bubbles: true }));
  check("typing in a field marks the page, and the style hides the bar then", C.doc.body.classList.contains("kbd") && /body\.kbd \.tabbar/.test(html));
  field.focus(); field.blur(); await tick(150);
  check("...and leaving the field brings it back", !C.doc.body.classList.contains("kbd"));
  box.dispatchEvent(new C.w.FocusEvent("focusin", { bubbles: true }));
  check("a checkbox isn't typing", !C.doc.body.classList.contains("kbd"));

  /* ------------------------------------------------------------ a lifter */
  console.log("\nTom's bar");
  L.sync(); await L.settle();
  check("the same, with his own Messages instead of an Inbox, and no Analytics (a new lifter starts with it hidden)", L.names().join() === "Home,Current Program,Messages,Account", L.names().join());
  L.tap("Messages"); await tick(100);
  check("Messages opens his conversation, and the bar steps aside", L.active() === "viewMessages" && L.$("tabBar").hidden);
  L.nav = l => { const b = [...L.doc.querySelectorAll("#sideNav .nav-item")].find(n => n.querySelector(".nav-label").textContent === l); if (b) b.click(); return !!b; };
  L.nav("Current Program"); await tick(100);
  check("...and is back on the Current Program page", !L.$("tabBar").hidden && L.lit().join() === "Current Program");

  console.log("\nLifter access");
  await C.dev.rpc("set_analytics_off", { p_lifter: tomId, p_off: ["all"] });
  L.sync(); await L.settle();
  check("with Analytics hidden from him, its button goes", L.names().join() === "Home,Current Program,Messages,Account", L.names().join());
  await C.dev.rpc("set_analytics_off", { p_lifter: tomId, p_off: [] });
  L.sync(); await L.settle();
  check("...and returns when it's switched back on", L.names().includes("Lifter’s Analytics"));

  console.log("\nThe red dot on Account");
  check("an owner with no one waiting has no dot", !C.dots().includes("Account"));

  const bad = [C, L].reduce((a, x) => a.concat(x.real()), []);
  check("no script errors on either device", bad.length === 0, bad.join(" | ").slice(0, 400));
  console.log(`\n${checks} checks · ${failures === 0 ? "ALL PASSED" : failures + " FAILED"}\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
