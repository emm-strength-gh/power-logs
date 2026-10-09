/* Display Name: two lifters can show exactly the same name; the Name field in Manage Program edits what is shown, and
 * it is shown everywhere. The name the device files a lifter under (the key) stays unique and out of sight.
 * Run: node test-displayname.js
 *
 * Like test-lifterids.js: each device is its own jsdom copy of app.html; the cloud parts run on one in-memory Postgres
 * with supabase/schema.sql (real row-level security).
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
const TOM_PREP = csv("Tom", "Prep", [[1, 1, "Deadlift", 200, 3, 3, 8, ""], [1, 2, "Squat", 160, 4, 4, 7, ""]]);
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
      keys: () => $("lifterPicker").style.display === "none" ? [] : [...$("lifterSelect").options].map(o => o.value).filter(v => !/^__/.test(v)),
      shown: () => $("lifterPicker").style.display === "none" ? [] : [...$("lifterSelect").options].filter(o => !/^__/.test(o.value)).map(o => o.textContent),
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
      nameField: () => $("viewDayMgr").querySelector('input[aria-label="Lifter name"]'),
      listed: () => [...doc.querySelectorAll("#liftersBody .msg-thread .msg-mid b")].map(b => b.childNodes[0].textContent),
      toast: () => $("toastMsg").textContent,
    };
    return app;
  }
  const rows = (sql, args) => server.sql(sql, args);
  const serverNames = async () => (await rows("select name, program->>'block' as block from public.lifters where deleted_at is null order by created_at")).map(r => r.name + "/" + r.block);

  /* ------------------------------------------------------------ two lifters, one shown name */
  console.log("Two lifters that show exactly the same name");
  const O = boot("owner");
  await tick(250);
  await O.load(TOM_PREP, "tom-prep.csv");
  await O.load(TOM_PEAK, "tom-peak.csv");
  await O.signIn(OWNER_EMAIL);
  O.$("confirmYes").click();
  check("both are uploaded", await until(async () => (await rows("select count(*)::int n from public.lifters"))[0].n === 2));
  await O.settle();
  check("the device files them under different names, out of sight", O.keys().join() === "Tom,Tom (2)", O.keys().join());
  check("the dropdown shows the same name twice, told apart by their block", O.shown().join() === "Tom · Prep,Tom · Peak", O.shown().join());
  check("the server's name for each is the shown name", (await serverNames()).join() === "Tom/Prep,Tom/Peak", (await serverNames()).join());
  const profs = O.store("spotter.profiles.v1");
  check("each profile keeps its shown name beside its key", profs.Tom.dname === "Tom" && profs["Tom (2)"].dname === "Tom" && profs["Tom (2)"].name === "Tom (2)");
  check("the stored program doesn't carry the shown name (it is the server's name column)", (await rows("select program from public.lifters")).every(r => !("dname" in r.program) && !("name" in r.program)));
  O.nav("Lifters"); await tick(100);
  check("the Lifters page has one card, Tom (one lifter: the same name, nobody signed in yet), with no number", O.listed().join() === "Tom" && /2 programs/.test(O.$("liftersBody").textContent), O.listed().join());
  O.pick("Tom (2)"); await tick(100);
  check("the Current Program page is headed Tom", O.$("ovName").textContent === "Tom", O.$("ovName").textContent);
  O.nav("Manage program"); await tick(150);
  check("Manage Program's Name field shows Tom", O.nameField().value === "Tom" && /Lifter name/.test(O.$("viewDayMgr").textContent));

  /* ------------------------------------------------------------ renaming = the display name, everywhere */
  console.log("\nRenaming in Manage Program changes the name shown everywhere");
  const ID2 = (await rows("select id from public.lifters where program->>'block' = 'Peak'"))[0].id;
  O.nameField().value = "Tommy"; O.nameField().dispatchEvent(new O.w.Event("blur"));
  check("the server has the new name for that lifter only", await until(async () => (await serverNames()).join() === "Tom/Prep,Tommy/Peak"), (await serverNames()).join());
  await O.settle();
  check("the key doesn't move: no renamed stores, same lifter ID", O.keys().join() === "Tom,Tom (2)" && O.store("spotter.profiles.v1")["Tom (2)"].cloudId === ID2);
  check("the Name field, the dropdown, the page heading and the Lifters list all say Tommy",
    O.nameField().value === "Tommy" && O.shown().join() === "Tom · Prep,Tommy · Peak" && (O.nav("Current Program"), await tick(80), O.$("ovName").textContent === "Tommy") && (O.nav("Lifters"), await tick(80), O.listed().join() === "Tom,Tommy"),
    O.nameField() && O.nameField().value + " | " + O.shown().join() + " | " + O.listed().join());
  check("it says so", /Renamed .Tom. to .Tommy./.test(O.toast()), O.toast());
  O.pick("Tom (2)"); await tick(100);
  let blob = null;
  O.w.URL.createObjectURL = b => { blob = b; return "blob:t"; };
  O.w.URL.revokeObjectURL = () => {};
  O.nav("Manage program"); await tick(100);
  O.$("saveBtn").click(); await tick();
  const backup = blob ? JSON.parse(await blob.text()) : {};
  check("a saved backup carries the shown name", backup.lifter === "Tommy" && backup.profile.dname === "Tommy" && backup.profile.name === "Tom (2)", JSON.stringify([backup.lifter, backup.profile && backup.profile.dname]));
  O.nameField().value = "Tom"; O.nameField().dispatchEvent(new O.w.Event("blur"));
  check("a name another lifter already has is fine: it can be Tom again", await until(async () => (await serverNames()).join() === "Tom/Prep,Tom/Peak") && !/already a lifter/.test(O.toast()), O.toast());
  await O.settle();

  /* ------------------------------------------------------------ the lifter's device */
  console.log("\nThe lifter sees the shown name too, and follows a rename");
  await rows("update public.lifters set lifter_email = 'tom@test.invalid'");
  const T = boot("tom");
  await tick(250);
  await T.signIn("tom@test.invalid");
  T.sync(); await T.settle();
  check("Tom has both programs, both showing Tom", T.keys().length === 2 && T.shown().every(t => /^Tom · (Prep|Peak)$/.test(t)), T.shown().join());
  O.nav("Manage program"); await tick(100);
  O.nameField().value = "Tommy"; O.nameField().dispatchEvent(new O.w.Event("blur"));
  await until(async () => (await serverNames()).join() === "Tom/Prep,Tommy/Peak");
  T.sync(); await T.settle();
  check("after a rename by the coach, Tom's dropdown shows it, his keys unchanged", T.shown().sort().join() === "Tom · Prep,Tommy · Peak" && T.keys().length === 2, T.shown().join());
  const keyPeak = T.keys().find(k => T.store("spotter.profiles.v1")[k].block === "Peak");
  T.pick(keyPeak); await tick(100);
  check("...and so does the page heading and the Messages header", (T.nav("Current Program"), await tick(80), T.$("ovName").textContent === "Tommy") && (T.nav("Messages"), await tick(150), T.$("msgSub").textContent === "Tommy"), T.$("msgSub").textContent);

  /* ------------------------------------------------------------ files */
  console.log("\nFiles keep the shown name");
  const D = boot("device");
  await tick(250);
  await D.load(TOM_PREP, "tom.csv");
  await D.load(TOM_PEAK, "tom2.csv");
  check("two CSVs called Tom show Tom twice", D.keys().join() === "Tom,Tom (2)" && D.shown().join() === "Tom · Prep,Tom · Peak", D.shown().join());
  check("the message names it without a number", /Loaded Tom · Tom was already here, so this is a separate lifter/.test(D.toast()), D.toast());
  await D.load(JSON.stringify(backup), "backup.json");
  check("a JSON backup comes back under its shown name, Tommy", D.shown().slice(-1)[0] === "Tommy · Peak" && D.keys().slice(-1)[0] === "Tommy", D.shown().join() + " / " + D.keys().join());
  await D.load(JSON.stringify(backup), "backup.json");
  check("loading it again shows Tommy twice", D.shown().slice(-2).join() === "Tommy · Peak,Tommy · Peak" && D.keys().slice(-1)[0] === "Tommy (2)", D.shown().join());
  check("no script errors", [O, T, D].every(a => a.real().length === 0), [O, T, D].map(a => a.real().join(" | ")).join(" // "));

  console.log(`\n${checks} checks · ${failures ? failures + " FAILED" : "ALL PASSED"}`);
  process.exit(failures ? 1 : 0);
})();
