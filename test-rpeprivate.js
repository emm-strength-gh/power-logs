/* The RPE Calculator is kept in the database like the Program Hub, but for any signed-in
 * account: downloaded to the device once signed in, opens offline, deleted on sign-out.
 * Run: node test-rpeprivate.js
 *
 * Each "device" is a jsdom copy of app.html with a stand-in for Supabase
 * (window.__spotterCloud) and for IndexedDB (window.__spotterPrivateStore), so what is kept
 * on the device can be looked at directly. test-cloudsql.js covers the database rule itself
 * (members can read what is marked for them, nobody signed out can).
 */
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const html = fs.readFileSync(path.join(__dirname, "app.html"), "utf8");
let failures = 0, checks = 0;
const check = (name, cond, extra = "") => {
  checks++;
  if (!cond) failures++;
  console.log(`${cond ? "  ok  " : " FAIL "} ${name}${extra && !cond ? " — " + extra : ""}`);
};
const tick = (ms = 50) => new Promise(r => setTimeout(r, ms));
async function until(fn, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return true; } catch (e) {} await tick(50); }
  return false;
}
const rpeDoc = v => `<!DOCTYPE html><html><head><title>fake rpe</title></head><body>the calculator ${v}</body></html>`;
const ME = "00000000-0000-4000-8000-0000000000aa";

function world(over = {}) {
  const w = Object.assign({ role: "member", coach_status: "none", version: "rpe-21", signedIn: true, offline: false, delFails: 0, missing: false, store: new Map(), calls: [] }, over);
  w.cloud = {
    session: async () => (w.signedIn ? { id: ME, email: "me@test.invalid" } : null),
    onSessionChange() {}, sendCode: async () => {}, verifyCode: async () => ({ id: ME, email: "me@test.invalid" }), signOut: async () => { w.signedIn = false; },
    fetch: async (table, o) => {
      w.calls.push([table, (o && o.columns) || "", ((o && o.ids) || []).join()]);
      if (w.offline) throw new Error("offline");
      if (table === "accounts") return [{ user_id: ME, email: "me@test.invalid", role: w.role, coach_status: w.coach_status, display_name: "" }];
      if (table === "owner_assets") {
        if (!w.signedIn || w.missing || !(o && o.ids && o.ids[0] === "rpe")) return [];     // the database's rule: only what is marked for members
        const row = { id: "rpe", version: w.version, updated_at: "2026-01-01T00:00:00Z" };
        if (o && /body/.test(o.columns || "")) row.body = rpeDoc(w.version);
        return [row];
      }
      return [];
    },
    upsert: async () => {}, remove: async () => {}, invoke: async () => ({ sent: 0 }), insert: async () => {}, update: async () => {}, rpc: async () => null, listen: () => () => {},
  };
  w.privStore = {
    get: async k => w.store.get(k),
    put: async (k, v) => { w.store.set(k, v); },
    del: async k => { if (w.delFails > 0) { w.delFails--; throw new Error("blocked"); } w.store.delete(k); },
  };
  return w;
}

async function boot(wd, storage = {}) {
  const errors = [];
  const dom = new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true,
    url: "https://example.github.io/power-logs/app.html",
    virtualConsole: new VirtualConsole().on("jsdomError", e => errors.push(e.message)).on("error", m => errors.push(String(m))),
    beforeParse(w) {
      w.__spotterCloud = wd.cloud;
      w.__spotterPrivateStore = wd.privStore;
      Object.keys(storage).forEach(k => w.localStorage.setItem(k, storage[k]));
      if (!storage["spotter.cloud.v1"]) w.localStorage.setItem("spotter.cloud.v1", JSON.stringify({ uploadAsked: true }));
    },
  });
  const w = dom.window, doc = w.document, $ = id => doc.getElementById(id);
  w.Element.prototype.scrollIntoView = function () {};
  w.scrollTo = function () {};
  await new Promise(res => { if (doc.readyState === "complete") res(); else w.addEventListener("load", res); setTimeout(res, 4000); });
  const app = {
    w, doc, $, errors,
    real: () => errors.filter(e => !/Not implemented|HTMLCanvasElement|getContext|Chart is not defined/i.test(e)),
    storage: () => { const o = {}; for (let i = 0; i < w.localStorage.length; i++) { const k = w.localStorage.key(i); o[k] = w.localStorage.getItem(k); } return o; },
    btn: (t, root) => [...(root || doc).querySelectorAll("button")].find(b => b.textContent.trim() === t),
    nav(label) { const b = [...doc.querySelectorAll("#sideNav .nav-item")].find(n => n.querySelector(".nav-label").textContent === label); if (b) b.click(); return !!b; },
    async load(text = "#Name,Tom\r\n#Block,B\r\nWeek,Day,Exercise,Weight (kg),Sets,Reps,RPE,Notes\r\n1,1,Squat,150,3,5,7,\r\n") {
      const i = $("fileInput");
      Object.defineProperty(i, "files", { value: [new w.File([text], "t.csv")], configurable: true });
      i.dispatchEvent(new w.Event("change"));
      await tick(300);
    },
    async openRpe() { app.nav("RPE Calculator"); await tick(200); },
  };
  return app;
}

(async () => {
  /* ---------------------------------------- a lifter (not the owner), online */
  console.log("A signed-in lifter, online");
  const W = world();
  const A = await boot(W);
  await A.load();
  check("boots with no script errors", A.real().length === 0, A.real().join(" | ").slice(0, 300));
  check("the calculator is downloaded to the device once signed in, whatever the role", await until(() => W.store.has("rpe")));
  check("...as the version the server has, with the whole file", W.store.get("rpe").version === "rpe-21" && W.store.get("rpe").html === rpeDoc("rpe-21"));
  check("a note says a copy is held, so a failed delete is retried", A.storage()["spotter.rpeHeld"] === "1");
  check("only the version is asked for first, then the file", W.calls.some(c => c[0] === "owner_assets" && c[1] === "id,version" && c[2] === "rpe") && W.calls.some(c => c[0] === "owner_assets" && /body/.test(c[1])));
  await A.openRpe();
  const f = A.$("rpeFrame");
  check("opening it shows the copy in its frame", f.getAttribute("srcdoc") && f.getAttribute("srcdoc").indexOf("the calculator rpe-21") !== -1 && !!f.getAttribute("data-src"));
  check("the page parameters ride in as a script, since there's no URL query", /<head><script>window\.__rpeParams="embed=1&theme=(light|dark)";<\/script>/.test(f.getAttribute("srcdoc")), f.getAttribute("srcdoc").slice(0, 160));
  check("the frame isn't pointed at any file on the public site", !/rpe-(calculator|estimator)\.html/.test(f.getAttribute("src") || "") && !/rpe-(calculator|estimator)\.html/.test(A.$("viewRpe").innerHTML));
  check("no complaint is showing", A.$("rpeStatus").classList.contains("hidden"));

  /* ------------------------------------------------------------ offline */
  console.log("\nOffline");
  const W2 = world({ store: W.store, offline: true });
  const B = await boot(W2, A.storage());
  await B.load();
  await B.openRpe();
  check("it still opens, from the copy on the device", B.$("rpeFrame").getAttribute("srcdoc") && B.$("rpeFrame").getAttribute("srcdoc").indexOf("the calculator rpe-21") !== -1);
  check("...with no complaint", B.$("rpeStatus").classList.contains("hidden"));

  console.log("\nA device that never had it, offline");
  const W3 = world({ offline: true });
  const C = await boot(W3, { "spotter.cloud.v1": JSON.stringify({ uploadAsked: true, user: { id: ME, email: "me@test.invalid" }, lastUserId: ME, account: { role: "member", coach_status: "none", display_name: "" } }) });
  await C.load();
  await C.openRpe();
  check("it says to connect once, and shows nothing", /Connect to the internet once/.test(C.$("rpeStatus").textContent) && !C.$("rpeFrame").getAttribute("srcdoc"), C.$("rpeStatus").textContent);

  console.log("\nNot uploaded yet");
  const W3b = world({ missing: true });
  const C2 = await boot(W3b);
  await C2.load();
  await C2.openRpe();
  check("it says so", /hasn.t been uploaded/.test(C2.$("rpeStatus").textContent) && !C2.$("rpeFrame").getAttribute("srcdoc"), C2.$("rpeStatus").textContent);

  /* ------------------------------------------------------- a new version */
  console.log("\nA newer version on the server");
  const W4 = world({ store: W.store, version: "rpe-22" });
  const D = await boot(W4, A.storage());
  await D.load();
  check("it's downloaded in the background", await until(() => W.store.get("rpe").version === "rpe-22"));
  await D.openRpe();
  check("...and is what opens", D.$("rpeFrame").getAttribute("srcdoc").indexOf("the calculator rpe-22") !== -1);

  /* ------------------------------------------------------------ signed out */
  console.log("\nSigned out");
  const W5 = world({ signedIn: false });
  const E = await boot(W5);
  await E.load();
  await tick(500);
  await E.openRpe();
  check("it asks them to sign in, and shows nothing", /Sign in to use the RPE Calculator/.test(E.$("rpeStatus").textContent) && !E.$("rpeFrame").getAttribute("srcdoc"), E.$("rpeStatus").textContent);
  check("...without asking the database for it", !W5.calls.some(c => c[0] === "owner_assets"));

  /* ------------------------------------------------------------ sign out */
  console.log("\nSigning out");
  const W6 = world({ store: W.store, version: "rpe-22" });
  const G = await boot(W6, A.storage());
  await G.load();
  await until(() => !!G.$("acctBtn"));
  await G.openRpe();
  check("the copy is there before, and showing", W.store.has("rpe") && !!G.$("rpeFrame").getAttribute("srcdoc"));
  G.$("acctBtn").click(); await tick();
  G.btn("Sign out", G.$("acctBody")).click(); await tick(300);
  G.$("confirmYes").click();
  check("signing out deletes the calculator from the device", await until(() => !W.store.has("rpe")));
  check("...and the note that one is held", G.storage()["spotter.rpeHeld"] === undefined);
  check("...and its frame is emptied", !G.$("rpeFrame").getAttribute("srcdoc") && !G.$("rpeFrame").getAttribute("data-src"));

  console.log("\nA delete that fails is tried again");
  W.store.set("rpe", { version: "rpe-22", html: rpeDoc("rpe-22") });
  const W7 = world({ store: W.store, signedIn: true, delFails: 99 });
  const F = await boot(W7);
  await F.load();
  await until(() => !!F.$("acctBtn"));
  F.$("acctBtn").click(); await tick();
  F.btn("Sign out", F.$("acctBody")).click(); await tick(300);
  F.$("confirmYes").click();
  await tick(600);
  check("if it can't be deleted, the device remembers there's still a copy", W.store.has("rpe") && F.storage()["spotter.rpeHeld"] === "1");
  const W8 = world({ store: W.store, signedIn: false });
  const H = await boot(W8, F.storage());
  check("...and the next launch (signed out) deletes it", await until(() => !W.store.has("rpe")) && H.storage()["spotter.rpeHeld"] === undefined);

  console.log("\nThe Program Hub is untouched");
  const W9 = world({ role: "owner" });
  const I = await boot(W9);
  await I.load();
  await tick(600);
  check("the owner's two copies are separate: the calculator asks only for its own id", W9.calls.filter(c => c[0] === "owner_assets" && c[2] === "rpe").length >= 1 && W9.calls.some(c => c[0] === "owner_assets" && c[2] === "program-hub"));

  const bad = [A, B, C, C2, D, E, F, G, H, I].reduce((a, x) => a.concat(x.real()), []);
  check("no script errors on any device", bad.length === 0, bad.join(" | ").slice(0, 400));
  console.log(`\n${checks} checks · ${failures === 0 ? "ALL PASSED" : failures + " FAILED"}\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
