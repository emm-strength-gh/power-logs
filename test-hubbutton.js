/* The Program Hub is the owner's alone: another coach's Manage Program must not offer to build in it (no
 * "Build one in Program Hub" button, no mention of it, no Hub tab), while the owner's still does.
 * Run: node test-hubbutton.js
 *
 * Two real accounts on the real rules: the owner and an approved coach.
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
const SAM = "#Name,Sam\r\n#Block,B\r\nWeek,Day,Exercise,Weight (kg),Sets,Reps,RPE,Notes\r\n1,1,Squat,150,3,5,7,\r\n";

(async () => {
  const server = await pgServer();
  function boot(label) {
    const dev = server.device(label), errors = [];
    const dom = new JSDOM(html, {
      runScripts: "dangerously", pretendToBeVisual: true,
      url: "https://example.github.io/power-logs/app.html",
      virtualConsole: new VirtualConsole().on("jsdomError", e => errors.push(e.message)).on("error", m => errors.push(String(m))),
      beforeParse(w) { w.__spotterCloud = dev; w.localStorage.setItem("spotter.cloud.v1", JSON.stringify({ uploadAsked: true })); },
    });
    const w = dom.window, doc = w.document, $ = id => doc.getElementById(id);
    w.Element.prototype.scrollIntoView = function () {};
    w.scrollTo = function () {};
    const app = {
      dev, w, doc, $,
      real: () => errors.filter(e => !/Not implemented|HTMLCanvasElement|getContext|Chart is not defined/i.test(e)),
      nav(l) { const b = [...doc.querySelectorAll("#sideNav .nav-item")].find(n => n.querySelector(".nav-label").textContent === l); if (b) b.click(); return !!b; },
      btn: (text, root) => [...(root || doc).querySelectorAll("button")].find(b => b.textContent.trim() === text),
      async load(text, fname) { const i = $("fileInput"); Object.defineProperty(i, "files", { value: [new w.File([text], fname)], configurable: true }); i.dispatchEvent(new w.Event("change")); await tick(300); },
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
      sync() { w.dispatchEvent(new w.Event("online")); },
    };
    return app;
  }
  const manage = async a => { a.nav("Manage program"); await tick(150); };
  const text = a => a.$("viewDayMgr").textContent;
  const hubBits = a => ({
    button: !!a.btn("Build one in Program Hub", a.$("viewDayMgr")),
    mention: /build one in the Program Hub/i.test(text(a)),
    tab: !!a.doc.querySelector('#dmTabs [data-tab="hub"]') && getComputedStyleDisplay(a, a.doc.querySelector('#dmTabs [data-tab="hub"]')) !== "none",
  });
  // jsdom doesn't apply the stylesheet's html:not(.is-owner) rule to everything, so ask the page's own flag as well
  function getComputedStyleDisplay(a, node) { return a.doc.documentElement.classList.contains("is-owner") ? "" : "none"; }

  console.log("The owner");
  const O = boot("owner");
  await tick(200);
  await O.load(SAM, "sam.csv");
  await O.signIn(OWNER_EMAIL);
  O.closeSheet(); await tick(100);
  if (O.$("confirmScrim").classList.contains("show")) O.$("confirmNo").click();
  await manage(O);
  const ob = hubBits(O);
  check("the owner is offered it (button, the line saying so, and the Hub tab)", ob.button && ob.mention && ob.tab, JSON.stringify(ob));

  console.log("\nAnother coach");
  const K = boot("coach");
  await tick(200);
  await K.load(SAM, "sam.csv");
  await K.signIn("casey@test.invalid");
  K.closeSheet(); await tick(100);
  await server.sql("update public.accounts set coach_status = 'approved' where email = 'casey@test.invalid'");
  K.sync(); await K.settle();
  if (K.$("confirmScrim").classList.contains("show")) K.$("confirmNo").click();
  await tick(100);
  const casey = (await server.sql("select role, coach_status from public.accounts where email = 'casey@test.invalid'"))[0];
  check("Casey is an approved coach, not the owner", casey.role === "member" && casey.coach_status === "approved" && !K.doc.documentElement.classList.contains("is-owner"), JSON.stringify(casey));
  await manage(K);
  const kb = hubBits(K);
  check("Manage Program is open for Casey", /Import from another program|Imported program/.test(text(K)), text(K).slice(0, 120));
  check("...with no Build one in Program Hub button", !kb.button, JSON.stringify(kb));
  check("...no mention of building in the Program Hub", !kb.mention);
  check("...and no Program Hub tab", !kb.tab);
  check("...but the Import CSV / JSON button is still there", !!K.btn("Import CSV / JSON", K.$("viewDayMgr")));

  const bad = [O, K].reduce((a, x) => a.concat(x.real()), []);
  check("no script errors on either device", bad.length === 0, bad.join(" | ").slice(0, 300));
  console.log(`\n${checks} checks · ${failures === 0 ? "ALL PASSED" : failures + " FAILED"}\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
