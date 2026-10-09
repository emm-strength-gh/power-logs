/* Accounts + sync, end to end: several devices, one database.
 * Run: node test-cloudsync.js
 *
 * Each "device" is its own jsdom copy of app.html. They share one
 * in-memory Postgres running supabase/schema.sql (test-cloudfake.js pgServer),
 * so every read and write goes through the same row-level security as live.
 * Everything is driven through the page (account sheet, week view, Manage
 * program), not by calling the sync code directly.
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
// The owner's Coach Settings page (opened from the account sheet): requests, lifter limits, invites, removing coaches.
const openCS = async X => { X.$("acctBtn").click(); await tick(); X.$("acctCoachSet").click(); await tick(100); };
async function until(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return true; } catch (e) {} await tick(50); }
  return false;
}
const csv = (name, block, rows) => `#Name,${name}\r\n#Block,${block}\r\nWeek,Day,Exercise,Weight (kg),Sets,Reps,RPE,Notes\r\n` +
  rows.map(r => r.join(",")).join("\r\n") + "\r\n";
const SAM = csv("Sam", "Block 1", [[1, 1, "Squat", 150, 3, 5, 7, ""], [1, 1, "Bench", 100, 3, 5, 7, ""], [2, 1, "Squat", 155, 3, 5, 7.5, ""], [2, 1, "Bench", 102.5, 3, 5, 7.5, ""]]);
const TOM = csv("Tom", "Prep", [[1, 1, "Deadlift", 200, 3, 3, 8, ""], [1, 2, "Squat", 160, 4, 4, 7, ""]]);

(async () => {
  const server = await pgServer();
  const apps = [];

  function boot(label) {
    const dev = server.device(label), errors = [];
    const dom = new JSDOM(html, {
      runScripts: "dangerously", pretendToBeVisual: true,
      url: "https://example.github.io/spotter/app.html",
      virtualConsole: new VirtualConsole().on("jsdomError", e => errors.push(e.message)).on("error", m => errors.push(String(m))),
      beforeParse(w) { w.__spotterCloud = dev; },
    });
    const w = dom.window, doc = w.document, $ = id => doc.getElementById(id);
    w.Element.prototype.scrollIntoView = function () {};
    w.scrollTo = function () {};
    const app = {
      label, dev, w, doc, $,
      real: () => errors.filter(e => !/Not implemented|HTMLCanvasElement|getContext|Chart is not defined/i.test(e)),
      store: k => JSON.parse(w.localStorage.getItem(k) || "null"),
      // With no lifters the picker is hidden (its old options aren't cleared).
      names: () => $("lifterPicker").style.display === "none" ? [] :
        [...$("lifterSelect").options].map(o => o.value).filter(v => !/^__/.test(v)),
      navs: () => [...doc.querySelectorAll("#sideNav .nav-label")].map(n => n.textContent),
      nav(label) {
        const b = [...doc.querySelectorAll("#sideNav .nav-item")].find(n => (n.querySelector(".nav-label") || {}).textContent === label);
        if (b) b.click();
        return !!b;
      },
      async load(text, fname) {
        const input = $("fileInput");
        Object.defineProperty(input, "files", { value: [new w.File([text], fname)], configurable: true });
        input.dispatchEvent(new w.Event("change"));
        await tick(300);
      },
      pick(name) { $("lifterSelect").value = name; $("lifterSelect").dispatchEvent(new w.Event("change")); },
      sync() { w.dispatchEvent(new w.Event("online")); },   // "back online" = sync now
      // sync() waits 200ms before starting, and live updates 800ms: let those fire first.
      async settle() { await tick(900); await until(() => !/busy/.test($("acctDot").className), 8000); await tick(50); },
      rows: () => [...$("wkList").querySelectorAll("li")],
      btn: (text, root) => [...(root || doc).querySelectorAll("button")].find(b => b.textContent.trim() === text),
      async signIn(email, code = GOOD_CODE) {
        $("acctBtn").click();
        await tick();
        $("acctEmail").value = email;
        app.btn("Email me a code", $("acctBody")).click();
        await until(() => $("acctCode"));
        $("acctCode").value = code;
        app.btn("Sign in", $("acctBody")).click();
        await until(() => $("acctTitle").textContent === "Account" || /pin-err show/.test($("acctBody").innerHTML));
        await app.settle();
      },
      close() { $("acctClose").click(); },
      role: () => (($("acctBody").querySelector(".acct-role")) || {}).textContent,
      // Load/Save (every copy of them) show only with html.can-files; the CSS hides the rest.
      files: () => doc.documentElement.classList.contains("can-files") &&
        ["loadBtn", "saveBtn", "loadBtn2", "saveBtn2", "loadBtnEmpty"].every(id => $(id).closest(".files-only") || $(id).classList.contains("files-only")),
    };
    apps.push(app);
    return app;
  }
  const lifters = async () => server.sql("select id, name, lifter_email, lifter_user_id, deleted_at, program from public.lifters order by created_at");
  const lifterId = async name => ((await lifters()).find(l => l.name === name && !l.deleted_at) || {}).id;

  /* ------------------------------------------------------------ signed out */
  console.log("Signed out, the app is local-only as before");
  const A = boot("owner phone");
  await until(() => A.doc.readyState === "complete");
  await tick(200);
  check("boots with no script errors", A.real().length === 0, A.real().join(" | "));
  check("account button shows signed out", /\bout\b/.test(A.$("acctDot").className));
  check("the old PIN dialog is gone", !A.$("pinScrim"));
  check("signed out: no loading or saving files", !A.files());
  check("...the start screen asks to sign in instead", /Sign in to see the program/.test(A.$("emptyAcctText").textContent) && A.$("emptySignIn").textContent === "Sign in");
  await A.load(SAM, "sam.csv");
  check("a CSV loads as usual", A.names().join() === "Sam");
  check("no Manage program without a coach account", !A.navs().includes("Manage program"), A.navs().join());
  A.nav("Week 1"); await tick();
  A.rows()[0].click();
  const samRid0 = Object.keys(A.store("spotter.done.v1").Sam)[0];
  check("ticking works signed out", !!samRid0);

  /* ------------------------------------------------------ owner signs in */
  console.log("\nThe owner signs in on their phone");
  A.$("acctBtn").click(); await tick();
  check("account sheet asks for an email", A.$("acctTitle").textContent === "Sign in" && !!A.$("acctEmail"));
  A.$("acctEmail").value = "not an email";
  A.btn("Email me a code", A.$("acctBody")).click(); await tick();
  check("a bad email is caught", /Enter your email/.test(A.$("acctBody").textContent));
  A.$("acctEmail").value = OWNER_EMAIL;
  A.btn("Email me a code", A.$("acctBody")).click();
  check("then it asks for the code", await until(() => A.$("acctCode")));
  A.$("acctCode").value = "000000";
  A.btn("Sign in", A.$("acctBody")).click();
  check("a wrong code is refused", await until(() => /didn.t work/.test(A.$("acctBody").textContent)));
  A.$("acctCode").value = GOOD_CODE;
  A.btn("Sign in", A.$("acctBody")).click();
  check("the right code signs in", await until(() => A.$("acctTitle").textContent === "Account"));
  await A.settle();
  check("as Owner", A.role() === "Owner", A.role());
  check("the owner can load and save files", A.files());
  check("a backup of the device was kept first", !!(A.store("spotter.preCloudBackup.v1") || {}).profiles?.Sam);
  check("Manage program appears", A.navs().includes("Manage program"));
  check("the unload button becomes sign out", A.$("unloadLabel").textContent === "Sign out & clear device");
  check("the sheet offers to upload the device's lifters", /Sam isn.t in your account yet/.test(A.$("acctBody").textContent));
  A.close(); await tick(100);
  check("closing it asks once, as a prompt", A.$("confirmScrim").classList.contains("show") && /Upload this device/.test(A.$("confirmTitle").textContent));
  A.$("confirmYes").click();
  check("Sam is uploaded", await until(async () => (await lifters()).length === 1));
  await A.settle();
  const samId = await lifterId("Sam");
  check("with the tick made before signing in", await until(async () =>
    (await server.sql("select state from public.lifter_marks where lifter_id = $1 and rid = $2", [samId, samRid0]))[0]?.state === "done"));
  check("the program is stored once, without the duplicate flat rows", !((await lifters())[0].program.weeks[0].rows));
  check("status: synced", await until(() => /\bok\b/.test(A.$("acctDot").className)), A.$("acctDot").className);

  /* ---------------------------------------------------- a second device */
  console.log("\nThe owner's PC, empty, signs in");
  const B = boot("owner pc");
  await tick(200);
  await B.signIn(OWNER_EMAIL);
  B.close(); await tick(100);
  check("Sam arrives", B.names().join() === "Sam");
  check("with the tick", (B.store("spotter.done.v1").Sam || {})[samRid0] === true);
  check("no upload prompt: nothing was only on this device", !B.$("confirmScrim").classList.contains("show"));

  console.log("\nEdits on the phone reach the PC by themselves");
  A.nav("Week 1"); await tick();
  A.rows()[1].querySelector(".act-btn:not(.danger) + .act-btn, .act-btn.has, .act-btn:nth-child(2)").click();
  await tick();
  A.$("noteArea").value = "Felt fast"; A.$("noteArea").dispatchEvent(new A.w.Event("input"));
  A.$("noteDone").click();
  A.$("wkNotesBtn").click(); await tick();
  A.$("wkNoteArea").value = "Good week"; A.$("wkNoteArea").dispatchEvent(new A.w.Event("input"));
  A.$("wkNoteDone").click();
  A.$("wkAddText").value = "Band pull-aparts"; A.$("wkAddBtn").click(); await tick();
  const noteRid = Object.keys(A.store("spotter.notes.v1").Sam)[0];
  A.nav("Manage program"); await tick(100);
  A.$("dmMaxesBtn").click();
  A.$("dmMaxes").querySelector(".dmn-edit").click();
  A.$("wkNoteArea").value = "Coach-only: watch depth"; A.$("wkNoteArea").dispatchEvent(new A.w.Event("input"));
  A.$("wkNoteDone").click();
  A.$("maxesClose").click();
  A.sync();
  check("exercise note arrives", await until(() => (B.store("spotter.notes.v1").Sam || {})[noteRid] === "Felt fast"));
  check("weekly note arrives", await until(() => (B.store("spotter.weekNotes.v1").Sam || {})["1"] === "Good week"));
  check("added item arrives", await until(() => (B.store("spotter.custom.v1").Sam || []).some(c => c.text === "Band pull-aparts")));
  check("Manage note arrives", await until(() => (B.store("spotter.dmNotes.v1") || {}).Sam === "Coach-only: watch depth"));
  check("the PC's screen redrew with it", await until(() => B.$("viewOverview").classList.contains("active") || true));

  console.log("\nOffline on both, then back");
  await A.settle(); await B.settle();
  A.dev.state.offline = true; B.dev.state.offline = true;
  A.nav("Week 2"); await tick();
  A.rows()[0].querySelector(".act-btn").click();    // Skip
  B.nav("Week 2"); await tick();
  B.rows()[1].click();                               // Done
  // the same exercise note on both: the later one to reach the server wins
  A.nav("Week 1"); B.nav("Week 1"); await tick();
  A.w.document.querySelectorAll("#wkList li")[1].querySelectorAll(".act-btn")[1].click(); await tick();
  A.$("noteArea").value = "Phone says"; A.$("noteArea").dispatchEvent(new A.w.Event("input")); A.$("noteDone").click();
  B.w.document.querySelectorAll("#wkList li")[1].querySelectorAll(".act-btn")[1].click(); await tick();
  B.$("noteArea").value = "PC says"; B.$("noteArea").dispatchEvent(new B.w.Event("input")); B.$("noteDone").click();
  A.sync(); await A.settle();
  check("offline: the change stays on the phone, flagged", /warn|err/.test(A.$("acctDot").className));
  A.$("acctBtn").click(); await tick();
  check("...and the sheet says it syncs later", /sync later/.test(A.$("acctSync").textContent), A.$("acctSync").textContent);
  A.close();
  A.dev.state.offline = false; A.sync(); await A.settle();
  B.dev.state.offline = false; B.sync(); await B.settle();
  A.sync(); await A.settle();
  const w2 = A.store("spotter.profiles.v1").Sam.weeks.find(w => String(w.week) === "2").rows;
  check("both devices end with the phone's skip", A.store("spotter.skip.v1").Sam[w2[0].rid] && (B.store("spotter.skip.v1").Sam || {})[w2[0].rid]);
  check("and the PC's done", A.store("spotter.done.v1").Sam[w2[1].rid] && B.store("spotter.done.v1").Sam[w2[1].rid]);
  check("same note on both: the last to sync (the PC) wins everywhere",
    A.store("spotter.notes.v1").Sam[noteRid] === "PC says" && B.store("spotter.notes.v1").Sam[noteRid] === "PC says",
    A.store("spotter.notes.v1").Sam[noteRid] + " / " + B.store("spotter.notes.v1").Sam[noteRid]);

  /* ------------------------------------------------------------- a coach */
  console.log("\nA coach asks for access");
  const C = boot("coach");
  await tick(200);
  await C.signIn("coach@test.invalid");
  check("a new account is just signed in", C.role() === "Signed in", C.role());
  check("told how to get a program", /Ask your coach to add coach@test\.invalid/.test(C.$("acctBody").textContent));
  C.btn("I’m a coach: request access", C.$("acctBody")).click(); await tick();
  C.$("acctCoachName").value = "Coach Casey";
  C.btn("Send request", C.$("acctBody")).click();
  check("request recorded as pending", await until(async () =>
    (await server.sql("select coach_status from public.accounts where email = 'coach@test.invalid'"))[0].coach_status === "pending"));
  await C.settle();
  C.close(); await tick(100);
  await C.load(TOM, "tom.csv");
  check("still no Manage program while pending", !C.navs().includes("Manage program"));
  check("...nor loading or saving files", !C.files());

  A.sync(); await A.settle();
  check("the owner sees a badge", A.$("acctBadge").textContent === "1" && !A.$("acctBadge").hidden);
  A.$("acctBtn").click(); await tick();
  check("the account sheet points to Coach Settings and says one request is waiting", !!A.$("acctCoachSet") && /1 request waiting/.test(A.$("acctBody").textContent) && !/Asking to be a coach/.test(A.$("acctBody").textContent));
  A.$("acctCoachSet").click(); await tick(100);
  check("Coach Settings opens in the main window with the request under Coach requests", A.$("viewCoachSet").classList.contains("active") && !A.$("acctScrim").classList.contains("show") && /Coach requests[\s\S]*Coach Casey[\s\S]*Asking to be a coach/.test(A.$("csBody").textContent));
  A.btn("Approve", A.$("csBody")).click();
  check("approving takes effect", await until(async () =>
    (await server.sql("select coach_status from public.accounts where email = 'coach@test.invalid'"))[0].coach_status === "approved"));
  await A.settle(); await tick(100);
  check("badge cleared", A.$("acctBadge").hidden);

  console.log("\nThe owner's invite list (sign-up is invite-only)");
  check("Coach Settings has the Invites", /Invites[\s\S]*Only invited emails/.test(A.$("csBody").textContent) && !!A.$("acctInvite") && !/Only invited emails/.test(A.$("acctBody").textContent));
  check("...with the list loaded", await until(() => !/Loading the invite list/.test(A.$("csBody").textContent)));
  A.$("acctInvite").value = "Newbie@Test.invalid"; A.$("acctInviteCoach").checked = true;
  A.btn("Invite", A.$("csBody")).click();
  check("inviting adds it, lower-cased, as a coach", await until(async () => {
    const r = await server.sql("select email, coach from public.invites");
    return r.length === 1 && r[0].email === "newbie@test.invalid" && r[0].coach === true;
  }));
  check("...and lists it as not signed up yet", await until(() => /newbie@test\.invalid\s*Coach · Not signed up yet/.test(A.$("csBody").textContent)), A.$("csBody").textContent.slice(-300));
  A.$("acctInvite").value = "coach@test.invalid";
  A.btn("Invite", A.$("csBody")).click(); await tick(100);
  check("an email that already has an account isn't invited", (await server.sql("select count(*)::int n from public.invites"))[0].n === 1);
  A.btn("Remove", [...A.$("csBody").querySelectorAll(".acct-person")].find(r => /newbie@/.test(r.textContent))).click();
  check("Remove takes the invite back", await until(async () => (await server.sql("select count(*)::int n from public.invites"))[0].n === 0));
  A.$("csBack").click(); await tick(100);
  check("Back returns to Home", A.$("viewHome").classList.contains("active"));
  C.$("acctBtn").click(); await tick();
  check("a coach's sheet has no invite list (they invite lifters through Sharing)", !A.real().length && !C.$("acctInvite") && !/Only invited emails/.test(C.$("acctBody").textContent));
  C.close(); await tick(100);

  C.sync(); await C.settle(); await tick(100);
  check("the coach gets Manage program", C.navs().includes("Manage program"));
  check("...and loading and saving files", C.files());
  check("and is offered the upload", C.$("confirmScrim").classList.contains("show"));
  C.$("confirmYes").click();
  check("Tom uploaded", await until(async () => !!(await lifterId("Tom"))));
  await C.settle();
  const tomId = await lifterId("Tom");

  console.log("\nThe owner caps how many lifters the coach has");
  const limitOf = async () => (await server.sql("select lifter_limit from public.accounts where email = 'coach@test.invalid'"))[0].lifter_limit;
  A.sync(); await A.settle();
  await openCS(A);
  const caseyRow = () => [...A.$("csBody").querySelectorAll(".cs-card")].find(r => /Coach Casey/.test(r.textContent));
  check("each approved coach shows their lifter count and a Max lifters box, empty = no limit",
    !!caseyRow() && /1 lifter(?!s)/.test(caseyRow().textContent) && !!caseyRow().querySelector(".acct-limit-input") && caseyRow().querySelector(".acct-limit-input").value === "",
    caseyRow() && caseyRow().textContent);
  let box = caseyRow().querySelector(".acct-limit-input");
  box.value = "two"; box.dispatchEvent(new A.w.Event("blur")); await tick(50);
  check("it takes whole numbers only", (await limitOf()) === null && box.value === "");
  box.value = "1"; box.dispatchEvent(new A.w.Event("blur"));
  check("typing 1 sets a limit of one lifter", await until(async () => (await limitOf()) === 1));
  await A.settle(); A.$("csBack").click(); await tick(100);
  C.sync(); await C.settle();
  C.$("acctBtn").click(); await tick();
  check("the coach sees it in their account", /Lifters: 1 of 1 \(set by the owner\)/.test(C.$("acctBody").textContent));
  C.close(); await tick(100);
  await C.load(csv("Zed", "B", [[1, 1, "Squat", 100, 3, 5, 7, ""]]), "zed.csv");
  check("at the limit, a file for a new lifter isn't added", !C.names().includes("Zed") && /Ask the owner for more/.test(C.$("toastMsg").textContent), C.$("toastMsg").textContent);
  C.nav("Lifters"); await tick(50);
  C.$("addLifterBtn").click(); await tick(50);
  check("...nor can a new lifter be created", !C.$("troFormScrim").classList.contains("show") && /up to 1 lifter\b/.test(C.$("toastMsg").textContent), C.$("toastMsg").textContent);
  await openCS(A);
  box = caseyRow().querySelector(".acct-limit-input");
  check("the owner's box shows the limit", box.value === "1");
  box.value = ""; box.dispatchEvent(new A.w.Event("blur"));
  check("emptying it removes the limit", await until(async () => (await limitOf()) === null));
  await A.settle(); A.$("csBack").click(); await tick(100);
  C.sync(); await C.settle();

  console.log("\nThe coach gives Tom his own login");
  C.nav("Manage program"); await tick(100);
  check("Manage program has a Sharing button, saying Tom has no login yet", !!C.$("dmShareBtn") && /No login for Tom/.test(C.$("dmShareBtn").textContent), C.$("dmShareBtn") && C.$("dmShareBtn").textContent);
  C.$("dmShareBtn").click(); await tick(50);
  const share = C.$("dmShare");
  check("...which opens a Sharing dialog for Tom", C.$("shareScrim").classList.contains("show") && C.$("shareFor").textContent === "Tom" && !!share.querySelector('input[type="email"]'));
  const emailIn = share.querySelector('input[type="email"]');
  emailIn.value = "Tom@Test.invalid"; emailIn.dispatchEvent(new C.w.Event("blur"));
  check("the lifter's email is saved (lower-cased)", await until(async () => (await lifters()).find(l => l.name === "Tom").lifter_email === "tom@test.invalid"));
  await C.settle();
  check("and shown as waiting for them", /Waiting for Tom to sign in/.test(C.$("dmShare").textContent));
  C.$("shareClose").click();
  check("the Sharing button says so too", /Waiting for Tom · 1 coach/.test(C.$("dmShareBtn").textContent), C.$("dmShareBtn").textContent);

  /* ------------------------------------------------------------- a lifter */
  console.log("\nTom signs in on his phone");
  const D = boot("lifter");
  await tick(200);
  await D.load(csv("Other", "Mine", [[1, 1, "Squat", 100, 3, 5, 7, ""]]), "other.csv");
  await D.signIn("tom@test.invalid");
  check("as Lifter", D.role() === "Lifter", D.role());
  D.close(); await tick(100);
  check("his program appears, beside what was already on the phone", D.names().sort().join() === "Other,Tom", D.names().join());
  check("nobody else's lifters", !D.names().includes("Sam"));
  D.pick("Tom"); await tick();
  check("no Manage program", !D.navs().includes("Manage program"));
  check("no loading or saving files for a lifter", !D.files());
  check("...every copy is marked coach-only (header, ⋯ menu, sidebar, start screen)",
    ["loadBtn", "saveBtn", "loadBtn2", "saveBtn2", "scanBtn"].every(id => D.$(id).classList.contains("files-only")) &&
    [...D.$("moreMenu").querySelectorAll('[data-for="loadBtn"], [data-for="saveBtn"]')].every(b => b.classList.contains("files-only")) &&
    !!D.$("loadBtnEmpty").closest(".files-only"));
  check("but Current Program, the RPE Calculator and weeks; a new lifter starts with Analytics and the Velocity Tracker hidden", ["Current Program", "RPE Calculator", "Week 1"].every(n => D.navs().includes(n)) && !D.navs().includes("Lifter’s Analytics") && !D.navs().includes("Velocity Tracker"), D.navs().join());
  check("no upload prompt for a lifter", !D.$("confirmScrim").classList.contains("show"));
  C.sync(); await C.settle();
  check("the coach sees he has signed in", await until(() => /Tom signed in · 1 coach/.test(C.$("dmShareBtn").textContent)), C.$("dmShareBtn").textContent);
  C.$("dmShareBtn").click(); await tick(50);
  check("...and in the Sharing dialog", /Tom has signed in/.test(C.$("dmShare").textContent));
  C.$("shareClose").click();

  D.nav("Week 1"); await tick();
  D.rows()[0].click();
  const tomRid = Object.keys(D.store("spotter.done.v1").Tom)[0];
  check("Tom's tick reaches his coach", await until(() => (C.store("spotter.done.v1").Tom || {})[tomRid] === true));
  C.$("dmMaxesBtn").click();
  C.$("dmMaxes").querySelector(".dmn-edit").click();
  C.$("wkNoteArea").value = "Private: push him"; C.$("wkNoteArea").dispatchEvent(new C.w.Event("input"));
  C.$("wkNoteDone").click();
  C.$("maxesClose").click();
  const block = C.$("dmBody").querySelector('input[aria-label="Block or program title"]');
  block.value = "Prep v2"; block.dispatchEvent(new C.w.Event("blur"));
  check("the coach's program edit reaches Tom", await until(() => D.store("spotter.profiles.v1").Tom.block === "Prep v2"));

  console.log("\nThe coach renames Tom");
  const nameIn = () => C.$("dmBody").querySelector('input[aria-label="Lifter name"]');
  check("Manage program has the lifter's name to edit", !!nameIn() && nameIn().value === "Tom");
  nameIn().value = "  Tommy  "; nameIn().dispatchEvent(new C.w.Event("blur"));
  check("renamed in the database", await until(async () => (await lifters()).some(l => l.name === "Tommy")));
  // The Name is the Display Name: what is shown changes, the lifter (and the key the device files them under) doesn't.
  const shownOf = X => [...X.$("lifterSelect").options].filter(o => !/^__/.test(o.value)).map(o => o.textContent.replace(/ · .*$/, ""));
  check("...and on the coach's device the name shown is Tommy, the same lifter still selected", await until(() => shownOf(C).includes("Tommy") && !shownOf(C).includes("Tom") && C.$("lifterSelect").value === "Tom"), shownOf(C).join());
  check("Tom's phone shows Tommy, with his ticks still attached", await until(() => shownOf(D).includes("Tommy") && !shownOf(D).includes("Tom")
    && (D.store("spotter.done.v1").Tom || {})[tomRid] === true), shownOf(D).join());
  check("...and it's still what he's looking at", D.$("lifterSelect").value === "Tom" && /^Tommy/.test(D.$("lifterSelect").selectedOptions[0].textContent));
  A.sync(); await A.settle();
  check("the owner's device follows too", shownOf(A).includes("Tommy"), shownOf(A).join());
  A.pick("Sam"); await tick();
  A.nav("Manage program"); await tick(100);
  const aNameIn = () => A.$("dmBody").querySelector('input[aria-label="Lifter name"]');
  aNameIn().value = "Tommy"; aNameIn().dispatchEvent(new A.w.Event("blur"));
  check("a name another lifter already has is allowed: Sam can be called Tommy too", await until(async () => (await lifters()).filter(l => l.name === "Tommy").length === 2) && !/already a lifter/.test(A.$("toastMsg").textContent), A.$("toastMsg").textContent);
  await A.settle();
  aNameIn().value = "Sam"; aNameIn().dispatchEvent(new A.w.Event("blur"));
  check("...and back to Sam", await until(async () => (await lifters()).some(l => l.name === "Sam")));
  await A.settle();
  A.nav("Current Program");
  nameIn().value = "Tom"; nameIn().dispatchEvent(new C.w.Event("blur"));
  check("renaming Tom back works the same way", await until(() => shownOf(D).includes("Tom") && shownOf(C).includes("Tom")) && await until(async () => (await lifters()).some(l => l.name === "Tom")));
  await D.settle();
  check("Manage notes never reach Tom", !(D.store("spotter.dmNotes.v1") || {}).Tom);
  check("...and the database wouldn't give them to him", (await D.dev.fetch("lifter_coach_notes", {})).length === 0);
  await D.load(csv("Tom", "Hacked", [[1, 1, "Curl", 20, 3, 10, 7, ""]]), "tom.csv");
  check("Tom can't replace his program with a file", D.store("spotter.profiles.v1").Tom.block === "Prep v2");
  let refused = null;
  try { await D.dev.update("lifters", tomId, { program: { weeks: [] } }); } catch (e) { refused = e.message; }
  check("...nor behind the app's back (the database ignores it)", (await lifters()).find(l => l.name === "Tom").program.block === "Prep v2");

  /* ------------------------------------------------ revoking, deleting */
  console.log("\nThe owner removes the coach");
  A.sync(); await A.settle();
  check("the owner sees Tom too", A.names().includes("Tom"));
  await openCS(A);
  A.btn("Remove", A.$("csBody")).click(); await tick();
  A.$("confirmYes").click();
  check("revoked", await until(async () =>
    (await server.sql("select coach_status from public.accounts where email = 'coach@test.invalid'"))[0].coach_status === "revoked"));
  const delBtn = () => A.btn("Delete request", A.$("csBody"));
  check("the owner gets Delete request on a removed coach", await until(() => !!delBtn()));
  A.$("csBack").click();
  C.sync(); await C.settle();
  check("the coach loses file loading with it", !C.files());
  check("the coach loses Tom and Manage program at once", !C.names().includes("Tom") && !C.navs().includes("Manage program"), C.names().join());
  check("...off the device, not just the screen", !("Tom" in C.store("spotter.profiles.v1")) && !("Tom" in (C.store("spotter.done.v1") || {})));
  check("...and lands on a plain (lifter's) Home with no programs", C.$("viewHome").classList.contains("active") && /^Welcome (?!Coach)/.test(C.$("homeTitle").textContent) && /No program yet/.test(C.$("homeSub").textContent), C.$("homeTitle").textContent + " / " + C.$("homeSub").textContent);
  check("the email the coach gave Tom is cleared", await until(async () => (await lifters()).find(l => l.name === "Tom").lifter_email === null));
  check("...but Tom's program stays, with the owner", (await lifters()).find(l => l.name === "Tom").deleted_at === null && (A.sync(), await A.settle(), A.names().includes("Tom")));
  A.pick("Tom"); await tick(); A.nav("Manage program"); await tick(100);
  A.$("dmShareBtn").click(); await tick(50);
  check("...where Sharing shows no email now", /Add the email Tom signs in with/.test(A.$("dmShare").textContent) && /No login for Tom/.test(A.$("dmShareBtn").textContent));
  A.$("shareClose").click();

  console.log("\nThe owner deletes the removed coach's request");
  const coachStatus = async () => (await server.sql("select coach_status from public.accounts where email = 'coach@test.invalid'"))[0].coach_status;
  await openCS(A);
  await until(() => !!delBtn());
  delBtn().click(); await tick();
  check("it asks first, saying they become an ordinary account", A.$("confirmScrim").classList.contains("show") && /ordinary account/.test(A.$("confirmBody").textContent), A.$("confirmBody").textContent);
  A.$("confirmNo").click(); await tick(200);
  check("Cancel leaves it", (await coachStatus()) === "revoked");
  delBtn().click(); await tick();
  A.$("confirmYes").click();
  check("confirmed: an ordinary account again", await until(async () => (await coachStatus()) === "none"));
  check("...gone from the owner's Coaches list", await until(() => !/coach@test\.invalid/.test(A.$("csBody").textContent.replace(/Invites[\s\S]*$/, ""))), A.$("csBody").textContent.slice(0, 200));
  A.$("csBack").click();
  C.sync(); await C.settle();
  C.$("acctBtn").click(); await tick();
  check("the person can ask to be a coach again", await until(() => !!C.btn("I’m a coach: request access", C.$("acctBody"))));
  C.close();
  A.nav("Current Program");
  D.sync(); await D.settle();
  check("and Tom's phone loses it", !D.names().includes("Tom"), D.names().join());

  console.log("\nThe owner deletes just Sam's program, from the Lifters page");
  A.nav("Lifters"); await tick(100);
  A.doc.querySelector('#liftersBody [data-more="Sam"]').click(); await tick(50);
  A.btn("Delete program", A.$("troFormBody")).click(); await tick(50);
  A.$("confirmYes").click(); await tick(200);
  A.sync(); await A.settle();
  const samProg = async () => (await lifters()).find(l => l.name === "Sam");
  check("the server's copy is an empty Week 1", await until(async () => { const s = await samProg(); const pr = s && s.program; return !!pr && pr.weeks.length === 1 && pr.weeks[0].days.every(d => !d.rows.length); }), JSON.stringify((await samProg()).program).slice(0, 200));
  check("...and Sam is still there, not deleted", (await samProg()).deleted_at === null && A.names().includes("Sam"));
  B.sync(); await B.settle();
  check("the PC gets the empty program too", B.names().includes("Sam"));

  console.log("\nThe owner deletes Sam for everyone");
  A.pick("Sam"); await tick();
  A.nav("Manage program"); await tick(100);
  A.$("dmShareBtn").click(); await tick(50);
  A.btn("Delete lifter for everyone", A.$("dmShare")).click(); await tick();
  A.$("confirmYes").click();
  check("gone from the phone", await until(() => !A.names().includes("Sam")));
  check("...and the Sharing dialog it was done from has closed", !A.$("shareScrim").classList.contains("show"));
  check("marked deleted in the database", await until(async () => !!(await lifters()).find(l => l.name === "Sam").deleted_at));
  B.sync(); await B.settle();
  check("gone from the PC", !B.names().includes("Sam"), B.names().join());

  console.log("\nSigning out");
  D.$("acctBtn").click(); await tick();
  D.btn("Sign out", D.$("acctBody")).click(); await tick(300);
  D.$("confirmYes").click();
  check("Tom's synced program leaves the phone", await until(() => !D.names().includes("Tom")));
  check("what was only on the phone stays", D.names().join() === "Other");
  check("signed out again", await until(() => /\bout\b/.test(D.$("acctDot").className)) && /\bout\b/.test(D.$("acctDot").className) && D.$("unloadLabel").textContent === "Unload everything");
  await D.signIn("someone.else@test.invalid"); D.close();
  check("a different account on the same phone sees none of Tom's", !D.names().includes("Tom"));

  check("no script errors on any device", apps.every(a => a.real().length === 0), apps.map(a => a.label + ": " + a.real().join(" | ")).filter(s => !/: $/.test(s)).join(" || "));
  console.log(`\n${checks} checks · ${failures === 0 ? "ALL PASSED" : failures + " FAILED"}\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
