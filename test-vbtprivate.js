/* The Velocity Tracker is kept in the database like the Program Hub, but for any signed-in
 * account: downloaded to the device once signed in, opens offline, deleted on sign-out.
 * Run: node test-vbtprivate.js
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
const vbtDoc = v => `<!DOCTYPE html><html><head><title>fake vbt</title></head><body>the tracker ${v}</body></html>`;
const ME = "00000000-0000-4000-8000-0000000000aa";

function world(over = {}) {
  const w = Object.assign({ role: "member", coach_status: "none", version: "vbt-21", signedIn: true, offline: false, delFails: 0, missing: false, store: new Map(), calls: [] }, over);
  w.cloud = {
    session: async () => (w.signedIn ? { id: ME, email: "me@test.invalid" } : null),
    onSessionChange() {}, sendCode: async () => {}, verifyCode: async () => ({ id: ME, email: "me@test.invalid" }), signOut: async () => { w.signedIn = false; },
    fetch: async (table, o) => {
      w.calls.push([table, (o && o.columns) || "", ((o && o.ids) || []).join()]);
      if (w.offline) throw new Error("offline");
      if (table === "accounts") return [{ user_id: ME, email: "me@test.invalid", role: w.role, coach_status: w.coach_status, display_name: "" }];
      if (table === "owner_assets") {
        if (!w.signedIn || w.missing || !(o && o.ids && o.ids[0] === "vbt")) return [];     // the database's rule: only what is marked for members
        const row = { id: "vbt", version: w.version, updated_at: "2026-01-01T00:00:00Z" };
        if (o && /body/.test(o.columns || "")) row.body = vbtDoc(w.version);
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
    async openVbt() { app.nav("Velocity Tracker"); await tick(200); },
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
  check("the tracker is downloaded to the device once signed in, whatever the role", await until(() => W.store.has("vbt")));
  check("...as the version the server has, with the whole file", W.store.get("vbt").version === "vbt-21" && W.store.get("vbt").html === vbtDoc("vbt-21"));
  check("a note says a copy is held, so a failed delete is retried", A.storage()["spotter.vbtHeld"] === "1");
  check("only the version is asked for first, then the file", W.calls.some(c => c[0] === "owner_assets" && c[1] === "id,version" && c[2] === "vbt") && W.calls.some(c => c[0] === "owner_assets" && /body/.test(c[1])));
  await A.openVbt();
  const f = A.$("vbtFrame");
  check("opening it shows the copy in its frame", f.getAttribute("srcdoc") && f.getAttribute("srcdoc").indexOf("the tracker vbt-21") !== -1 && !!f.getAttribute("data-src"));
  check("the page parameters ride in as a script, since there's no URL query", /<head><script>window\.__vbtParams="embed=1&theme=(light|dark)";<\/script>/.test(f.getAttribute("srcdoc")), f.getAttribute("srcdoc").slice(0, 160));
  check("the frame isn't pointed at any file on the public site", !/VBT\.html/.test(f.getAttribute("src") || "") && !/VBT\.html/.test(A.$("viewVbt").innerHTML));
  check("no complaint is showing", A.$("vbtStatus").classList.contains("hidden"));

  /* ------------------------------------------------------------ offline */
  console.log("\nOffline");
  const W2 = world({ store: W.store, offline: true });
  const B = await boot(W2, A.storage());
  await B.load();
  await B.openVbt();
  check("it still opens, from the copy on the device", B.$("vbtFrame").getAttribute("srcdoc") && B.$("vbtFrame").getAttribute("srcdoc").indexOf("the tracker vbt-21") !== -1);
  check("...with no complaint", B.$("vbtStatus").classList.contains("hidden"));

  console.log("\nA device that never had it, offline");
  const W3 = world({ offline: true });
  const C = await boot(W3, { "spotter.cloud.v1": JSON.stringify({ uploadAsked: true, user: { id: ME, email: "me@test.invalid" }, lastUserId: ME, account: { role: "member", coach_status: "none", display_name: "" } }) });
  await C.load();
  await C.openVbt();
  check("it says to connect once, and shows nothing", /Connect to the internet once/.test(C.$("vbtStatus").textContent) && !C.$("vbtFrame").getAttribute("srcdoc"), C.$("vbtStatus").textContent);

  console.log("\nNot uploaded yet");
  const W3b = world({ missing: true });
  const C2 = await boot(W3b);
  await C2.load();
  await C2.openVbt();
  check("it says so", /hasn.t been uploaded/.test(C2.$("vbtStatus").textContent) && !C2.$("vbtFrame").getAttribute("srcdoc"), C2.$("vbtStatus").textContent);

  /* ------------------------------------------------------- a new version */
  console.log("\nA newer version on the server");
  const W4 = world({ store: W.store, version: "vbt-22" });
  const D = await boot(W4, A.storage());
  await D.load();
  check("it's downloaded in the background", await until(() => W.store.get("vbt").version === "vbt-22"));
  await D.openVbt();
  check("...and is what opens", D.$("vbtFrame").getAttribute("srcdoc").indexOf("the tracker vbt-22") !== -1);

  /* ------------------------------------------------------------ signed out */
  console.log("\nSigned out");
  const W5 = world({ signedIn: false });
  const E = await boot(W5);
  await E.load();
  await tick(500);
  await E.openVbt();
  check("it asks them to sign in, and shows nothing", /Sign in to use the Velocity Tracker/.test(E.$("vbtStatus").textContent) && !E.$("vbtFrame").getAttribute("srcdoc"), E.$("vbtStatus").textContent);
  check("...without asking the database for it", !W5.calls.some(c => c[0] === "owner_assets"));

  /* ------------------------------------------------------------ sign out */
  console.log("\nSigning out");
  const W6 = world({ store: W.store, version: "vbt-22" });
  const G = await boot(W6, A.storage());
  await G.load();
  await until(() => !!G.$("acctBtn"));
  await G.openVbt();
  check("the copy is there before, and showing", W.store.has("vbt") && !!G.$("vbtFrame").getAttribute("srcdoc"));
  G.$("acctBtn").click(); await tick();
  G.btn("Sign out", G.$("acctBody")).click(); await tick(300);
  G.$("confirmYes").click();
  check("signing out deletes the tracker from the device", await until(() => !W.store.has("vbt")));
  check("...and the note that one is held", G.storage()["spotter.vbtHeld"] === undefined);
  check("...and its frame is emptied", !G.$("vbtFrame").getAttribute("srcdoc") && !G.$("vbtFrame").getAttribute("data-src"));

  console.log("\nA delete that fails is tried again");
  W.store.set("vbt", { version: "vbt-22", html: vbtDoc("vbt-22") });
  const W7 = world({ store: W.store, signedIn: true, delFails: 99 });
  const F = await boot(W7);
  await F.load();
  await until(() => !!F.$("acctBtn"));
  F.$("acctBtn").click(); await tick();
  F.btn("Sign out", F.$("acctBody")).click(); await tick(300);
  F.$("confirmYes").click();
  await tick(600);
  check("if it can't be deleted, the device remembers there's still a copy", W.store.has("vbt") && F.storage()["spotter.vbtHeld"] === "1");
  const W8 = world({ store: W.store, signedIn: false });
  const H = await boot(W8, F.storage());
  check("...and the next launch (signed out) deletes it", await until(() => !W.store.has("vbt")) && H.storage()["spotter.vbtHeld"] === undefined);

  console.log("\nThe Program Hub is untouched");
  const W9 = world({ role: "owner" });
  const I = await boot(W9);
  await I.load();
  await tick(600);
  check("the owner's two copies are separate: the tracker asks only for its own id", W9.calls.filter(c => c[0] === "owner_assets" && c[2] === "vbt").length >= 1 && W9.calls.some(c => c[0] === "owner_assets" && c[2] === "program-hub"));

  const bad = [A, B, C, C2, D, E, F, G, H, I].reduce((a, x) => a.concat(x.real()), []);
  check("no script errors on any device", bad.length === 0, bad.join(" | ").slice(0, 400));
  console.log(`\n${checks} checks · ${failures === 0 ? "ALL PASSED" : failures + " FAILED"}\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
