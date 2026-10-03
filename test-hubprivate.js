/* The Program Hub is the owner's, kept in the database and copied to the owner's
 * device: downloaded when signed in, opens offline, deleted on sign-out.
 * Run: node test-hubprivate.js
 *
 * Each "device" is a jsdom copy of power-logs.html with a stand-in for Supabase
 * (window.__spotterCloud) and for IndexedDB (window.__spotterPrivateStore), so
 * what is kept on the device can be looked at directly. test-cloudsql.js covers
 * the database rule itself (only the owner can read owner_assets).
 */
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const html = fs.readFileSync(path.join(__dirname, "power-logs.html"), "utf8");
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
const hubDoc = v => `<!DOCTYPE html><html><head><title>fake hub</title></head><body>the hub ${v}</body></html>`;
const ME = "00000000-0000-4000-8000-0000000000aa";

// A server that serves the Hub, and a device-side store, both open to inspection.
function world(over = {}) {
  const w = Object.assign({ role: "owner", coach_status: "none", version: "hub-10", signedIn: true, offline: false, delFails: 0, store: new Map(), calls: [] }, over);
  w.cloud = {
    session: async () => (w.signedIn ? { id: ME, email: "me@test.invalid" } : null),
    onSessionChange() {}, sendCode: async () => {}, verifyCode: async () => ({ id: ME, email: "me@test.invalid" }), signOut: async () => { w.signedIn = false; },
    fetch: async (table, o) => {
      w.calls.push([table, (o && o.columns) || ""]);
      if (w.offline) throw new Error("offline");
      if (table === "accounts") return [{ user_id: ME, email: "me@test.invalid", role: w.role, coach_status: w.coach_status, display_name: "" }];
      if (table === "owner_assets") {
        if (w.role !== "owner") return [];                  // the database's rule: nothing for anyone else
        const row = { id: "program-hub", version: w.version, updated_at: "2026-01-01T00:00:00Z" };
        if (o && /body/.test(o.columns || "")) row.body = hubDoc(w.version);
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
    url: "https://example.github.io/power-logs/power-logs.html",
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
    hubTab: () => $("dmTabs").querySelector('[data-tab="hub"]'),
    async openHub() { app.nav("Manage program"); await tick(100); app.hubTab().click(); await tick(150); },
  };
  return app;
}

(async () => {
  /* -------------------------------------------------- the owner, online */
  console.log("The owner, online");
  const W = world();
  const A = await boot(W);
  await A.load();
  check("boots with no script errors", A.real().length === 0, A.real().join(" | ").slice(0, 300));
  check("the Hub is downloaded to the device once signed in", await until(() => W.store.has("program-hub")));
  check("...as the version the server has, with the whole file", W.store.get("program-hub").version === "hub-10" && W.store.get("program-hub").html === hubDoc("hub-10"));
  check("a note says a copy is held, so a failed delete is retried", A.storage()["spotter.hubHeld"] === "1");
  check("only the version is asked for first, then the file", W.calls.some(c => c[0] === "owner_assets" && c[1] === "id,version") && W.calls.some(c => c[0] === "owner_assets" && /body/.test(c[1])));
  await A.openHub();
  const f = A.$("hubFrame");
  check("opening the Hub tab shows the copy in its frame", f.getAttribute("srcdoc") && f.getAttribute("srcdoc").indexOf("the hub hub-10") !== -1 && !!f.getAttribute("data-src"));
  check("the page parameters ride in as a script, since there's no URL query", /<head><script>window\.__hubParams="embed=1&theme=(light|dark)";<\/script>/.test(f.getAttribute("srcdoc")), f.getAttribute("srcdoc").slice(0, 160));
  check("the frame isn't pointed at any file on the public site", !/program-hub\.html/.test(f.getAttribute("src") || ""));
  A.$("aboutBtn").click();
  check("About names the copy it has (for the owner)", /Program Hub hub-10/.test(A.$("aboutParts").textContent), A.$("aboutParts").textContent);

  /* ------------------------------------------------------------ offline */
  console.log("\nOffline");
  const W2 = world({ store: W.store, offline: true });
  const B = await boot(W2, A.storage());
  await B.load();
  await B.openHub();
  const fb = B.$("hubFrame");
  check("it still opens, from the copy on the device", fb.getAttribute("srcdoc") && fb.getAttribute("srcdoc").indexOf("the hub hub-10") !== -1);
  check("...with no complaint", B.$("hubStatus").classList.contains("hidden"));

  console.log("\nA device that never had it, offline");
  const W3 = world({ offline: true });
  // (signed in earlier, so the app already knows it's the owner without asking the server)
  const C = await boot(W3, { "spotter.cloud.v1": JSON.stringify({ uploadAsked: true, user: { id: ME, email: "me@test.invalid" }, lastUserId: ME, account: { role: "owner", coach_status: "none", display_name: "" } }) });
  await C.load();
  await C.openHub();
  check("it says to connect once, and shows nothing", /Connect to the internet once/.test(C.$("hubStatus").textContent) && !C.$("hubFrame").getAttribute("srcdoc"), C.$("hubStatus").textContent);

  /* ------------------------------------------------------- a new version */
  console.log("\nA newer Hub on the server");
  const W4 = world({ store: W.store, version: "hub-11" });
  const D = await boot(W4, A.storage());
  await D.load();
  check("it's downloaded in the background", await until(() => W.store.get("program-hub").version === "hub-11"));
  await D.openHub();
  check("...and is what opens", D.$("hubFrame").getAttribute("srcdoc").indexOf("the hub hub-11") !== -1);
  check("a build older than this app expects is flagged once the Hub reports in", (() => {
    D.w.dispatchEvent(new D.w.MessageEvent("message", { data: { type: "spotter-hub-ready", features: ["send", "height", "theme", "prefill"] } }));
    return D.$("hubStale").classList.contains("hidden");
  })());
  W.store.set("program-hub", { version: "hub-2", html: hubDoc("hub-2") });
  W4.version = "hub-2";
  const D2 = await boot(W4, D.storage());
  await D2.load();
  await D2.openHub();
  D2.w.dispatchEvent(new D2.w.MessageEvent("message", { data: { type: "spotter-hub-ready", features: ["send", "height", "theme", "prefill"] } }));
  check("...and an old one, even if it's all there is, shows the out-of-date notice", !D2.$("hubStale").classList.contains("hidden"));
  W.store.set("program-hub", { version: "hub-11", html: hubDoc("hub-11") });

  /* ------------------------------------------------------------ sign out */
  console.log("\nSigning out");
  const W5 = world({ store: W.store, version: "hub-11" });
  const E = await boot(W5, A.storage());
  await E.load();
  await until(() => !!E.$("acctBtn"));
  check("the copy is there before", W.store.has("program-hub"));
  E.$("acctBtn").click(); await tick();
  E.btn("Sign out", E.$("acctBody")).click(); await tick(300);
  E.$("confirmYes").click();
  check("signing out deletes the Hub from the device", await until(() => !W.store.has("program-hub")));
  check("...and the note that one is held", E.storage()["spotter.hubHeld"] === undefined);
  check("...and its frame is emptied", !E.$("hubFrame").getAttribute("srcdoc") && !E.$("hubFrame").getAttribute("data-src"));
  check("a later sign-in as someone else finds nothing", !W.store.has("program-hub"));

  console.log("\nA delete that fails is tried again");
  W.store.set("program-hub", { version: "hub-11", html: hubDoc("hub-11") });
  const W6 = world({ store: W.store, signedIn: true, delFails: 99 });
  const F = await boot(W6);
  await F.load();
  await until(() => !!F.$("acctBtn"));
  F.$("acctBtn").click(); await tick();
  F.btn("Sign out", F.$("acctBody")).click(); await tick(300);
  F.$("confirmYes").click();
  await tick(600);
  check("if it can't be deleted, the device remembers there's still a copy", W.store.has("program-hub") && F.storage()["spotter.hubHeld"] === "1");
  const W7 = world({ store: W.store, signedIn: false });
  const G = await boot(W7, F.storage());
  check("...and the next launch (signed out) deletes it", await until(() => !W.store.has("program-hub")) && G.storage()["spotter.hubHeld"] === undefined);

  /* ----------------------------------------------- everyone who isn't the owner */
  console.log("\nAnother coach");
  W.store.set("program-hub", { version: "hub-11", html: hubDoc("hub-11") });
  const W8 = world({ store: W.store, role: "member", coach_status: "approved" });
  const H = await boot(W8, { "spotter.hubHeld": "1", "spotter.cloud.v1": JSON.stringify({ uploadAsked: true }) });
  await H.load();
  await tick(800);
  check("never asks for the Hub", !W8.calls.some(c => c[0] === "owner_assets"), JSON.stringify(W8.calls.filter(c => c[0] === "owner_assets")));
  check("has no tab for it", !H.doc.documentElement.classList.contains("is-owner") && H.w.getComputedStyle(H.hubTab()).display === "none", H.w.getComputedStyle(H.hubTab()).display);
  check("a copy left on the device from before is deleted", await until(() => !W.store.has("program-hub")));
  H.nav("Manage program"); await tick(100);
  H.hubTab().click(); await tick(100);
  check("asking for the tab anyway gets them nothing", H.$("dmPaneHub").classList.contains("hidden") && !H.$("hubFrame").getAttribute("srcdoc"));

  console.log("\nA lifter");
  const W9 = world({ role: "member", coach_status: "none" });
  const I = await boot(W9);
  await I.load();
  await tick(600);
  I.$("aboutBtn").click();
  check("...and About says nothing about it", !/Program Hub/.test(I.$("aboutParts").textContent), I.$("aboutParts").textContent);
  check("a lifter never asks for it either", !W9.calls.some(c => c[0] === "owner_assets") && !W.store.has("program-hub"));

  const bad = [A, B, C, D, D2, E, F, G, H, I].reduce((a, x) => a.concat(x.real()), []);
  check("no script errors on any device", bad.length === 0, bad.join(" | ").slice(0, 400));
  console.log(`\n${checks} checks · ${failures === 0 ? "ALL PASSED" : failures + " FAILED"}\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
