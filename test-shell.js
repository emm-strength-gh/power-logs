/* index.html is the only public page: it signs you in, downloads the app (app.html, kept in the
 * database) once per version, keeps it on the device, and starts it in the same window.
 * Run: node test-shell.js
 *
 * Each "device" is a jsdom copy of index.html with stand-ins for Supabase (window.__spotterCloud)
 * and for IndexedDB (window.__spotterPrivateStore). Most scenarios serve a tiny fake app so what
 * the shell does is easy to see; the last ones serve the real app.html all the way through,
 * including signing out of it. test-cloudsql.js covers the database rule (any signed-in account
 * can read what is marked for members, nobody signed out can).
 */
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const shellHtml = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
const appHtml = fs.readFileSync(path.join(__dirname, "app.html"), "utf8");
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
const fakeApp = v => `<!DOCTYPE html><html><head><title>fake app</title></head><body><p id="fakeapp">the app ${v}</p><script>window.__seen = location.search; window.__shellFlag = window.__spotterShell;</script></body></html>`;
const ME = "00000000-0000-4000-8000-0000000000aa";

function world(over = {}) {
  const w = Object.assign({ role: "member", version: "1.0.0-aaaa1111", signedIn: true, offline: false, delFails: 0, missing: false, real: false, store: new Map(), calls: [], sent: [], goodCode: "123456" }, over);
  const body = () => (w.real ? appHtml : fakeApp(w.version));
  w.cloud = {
    session: async () => { if (w.offline) throw new Error("Failed to fetch"); return w.signedIn ? { id: ME, email: "me@test.invalid" } : null; },
    onSessionChange() {},
    sendCode: async email => { w.calls.push(["sendCode", email]); if (w.offline) throw new Error("Failed to fetch"); w.sent.push(email); },
    verifyCode: async (email, code) => { w.calls.push(["verifyCode", email, code]); if (code !== w.goodCode) throw new Error("Token has expired or is invalid"); w.signedIn = true; return { id: ME, email }; },
    signOut: async () => { w.signedIn = false; },
    fetch: async (table, o) => {
      w.calls.push([table, (o && o.columns) || "", ((o && o.ids) || []).join()]);
      if (w.offline) throw new Error("Failed to fetch");
      if (table === "accounts") return [{ user_id: ME, email: "me@test.invalid", role: w.role, coach_status: "none", display_name: "" }];
      if (table === "owner_assets") {
        if (!w.signedIn || w.missing || !(o && o.ids && o.ids[0] === "app")) return [];     // the database's rule: only what is marked for members
        const row = { id: "app", version: w.version, updated_at: "2026-01-01T00:00:00Z" };
        if (o && /body/.test(o.columns || "")) row.body = body();
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

async function boot(wd, storage = {}, query = "", opts = {}) {
  const errors = [];
  const dom = new JSDOM(shellHtml, {
    runScripts: "dangerously", pretendToBeVisual: true,
    url: "https://example.github.io/power-logs/index.html" + query,
    virtualConsole: new VirtualConsole().on("jsdomError", e => errors.push(e.message)).on("error", m => errors.push(String(m))),
    beforeParse(w) {
      w.__spotterCloud = wd.cloud;
      w.__spotterPrivateStore = wd.privStore;
      if (opts.offlineFlag) Object.defineProperty(w.navigator, "onLine", { get: () => false, configurable: true });
      Object.keys(storage).forEach(k => w.localStorage.setItem(k, storage[k]));
    },
  });
  const w = dom.window, doc = w.document, $ = id => doc.getElementById(id);
  w.Element.prototype.scrollIntoView = function () {};
  w.scrollTo = function () {};
  return {
    w, doc, $, errors,
    real: () => errors.filter(e => !/Not implemented|HTMLCanvasElement|getContext|Chart is not defined/i.test(e)),
    nav: () => errors.filter(e => /Not implemented: navigation/i.test(e)),
    storage: () => { const o = {}; for (let i = 0; i < w.localStorage.length; i++) { const k = w.localStorage.key(i); o[k] = w.localStorage.getItem(k); } return o; },
    text: () => doc.body ? doc.body.textContent : "",
    btn: t => [...doc.querySelectorAll("button")].find(b => b.textContent.trim() === t),
    fakeUp: () => !!doc.getElementById("fakeapp"),
  };
}

(async () => {
  /* ------------------------------------------------ not signed in */
  console.log("Not signed in");
  const W0 = world({ signedIn: false });
  const A = await boot(W0);
  check("shows the sign-in form", await until(() => !!A.$("gateEmail") && !!A.btn("Email me a code")), A.text());
  check("...and doesn't ask the database for the app", !W0.calls.some(c => c[0] === "owner_assets"));
  check("...and the app isn't started", !A.fakeUp());
  A.$("gateEmail").value = "not an email";
  A.btn("Email me a code").click(); await tick();
  check("a bad address is refused on the spot", /Enter your email/.test(A.text()) && W0.sent.length === 0);
  A.$("gateEmail").value = "Me@Test.Invalid";
  A.btn("Email me a code").click();
  check("the code is sent to the (lower-cased) address", await until(() => W0.sent[0] === "me@test.invalid" && !!A.$("gateCode")), JSON.stringify(W0.sent));
  A.$("gateCode").value = "000000";
  A.btn("Sign in").click();
  check("a wrong code says so and stays on the form", await until(() => /didn.t work or has expired/.test(A.text())) && !!A.$("gateCode") && !A.fakeUp());
  A.$("gateCode").value = "123 456";
  A.btn("Sign in").click();
  check("the right one downloads the app and starts it, in this window", await until(() => A.fakeUp()), A.text());
  check("...the copy is kept on the device, with its version", W0.store.get("app") && W0.store.get("app").version === "1.0.0-aaaa1111" && W0.store.get("app").html === fakeApp("1.0.0-aaaa1111"));
  check("...with a note that one is held", A.storage()["spotter.appHeld"] === "1");
  check("...and the app is told it is hosted (it hands back when the sign-in ends)", A.w.__shellFlag === true && A.w.__spotterShell === true);
  check("the sign-in page is gone from the window", !A.$("gateEmail") && !A.$("card"));

  /* ------------------------------------------------ signed in */
  console.log("\nSigned in, nothing on the device");
  const W1 = world();
  const B = await boot(W1);
  check("it downloads the app and starts it", await until(() => B.fakeUp()), B.text());
  check("only the version is asked for first, then the file", W1.calls.some(c => c[0] === "owner_assets" && c[1] === "id,version" && c[2] === "app") && W1.calls.some(c => c[0] === "owner_assets" && /body/.test(c[1])));

  console.log("\nSigned in, the current copy is already there");
  const W2 = world({ store: W1.store });
  const C = await boot(W2, {}, "?open=week&lifter=abc&week=3");
  check("it starts from the copy", await until(() => C.fakeUp()));
  check("...without downloading the file again", !W2.calls.some(c => c[0] === "owner_assets" && /body/.test(c[1])));
  check("a notification link's ?open=... reaches the app untouched", C.w.__seen === "?open=week&lifter=abc&week=3", String(C.w.__seen));

  console.log("\nA newer version on the server");
  const W3 = world({ store: W1.store, version: "1.1.0-bbbb2222" });
  const D = await boot(W3);
  check("it downloads it first, then starts that one", await until(() => D.fakeUp()) && D.$("fakeapp").textContent === "the app 1.1.0-bbbb2222" && W1.store.get("app").version === "1.1.0-bbbb2222", D.text());

  /* ------------------------------------------------ offline */
  console.log("\nOffline");
  const W4 = world({ store: W1.store, offline: true });
  const E = await boot(W4);
  check("a signed-in device still opens, from the copy on it", await until(() => E.fakeUp()) && E.$("fakeapp").textContent === "the app 1.1.0-bbbb2222");
  const W4b = world({ store: W1.store, offline: true });
  const E2 = await boot(W4b, {}, "", { offlineFlag: true });
  check("...and when the browser itself says it's offline, it doesn't even try", await until(() => E2.fakeUp()) && !W4b.calls.length, JSON.stringify(W4b.calls));

  console.log("\nOffline, and never downloaded");
  const W5 = world({ offline: true });
  const F = await boot(W5);
  check("it says to connect once, and offers to try again", await until(() => /Connect to the internet once/.test(F.text()) && !!F.btn("Try again")) && !F.fakeUp(), F.text());
  W5.offline = false;
  F.btn("Try again").click();
  check("...and Try again works once it's connected", await until(() => F.fakeUp()));

  console.log("\nNot uploaded yet");
  const W6 = world({ missing: true });
  const G = await boot(W6);
  check("it says so", await until(() => /hasn.t been uploaded/.test(G.text())) && !G.fakeUp(), G.text());
  const W6b = world({ missing: true, store: W1.store });
  const G2 = await boot(W6b);
  check("with a copy already on the device, it starts that", await until(() => G2.fakeUp()));

  /* ------------------------------------------------ the sign-in ended */
  console.log("\nThe sign-in ended elsewhere");
  const W7 = world({ store: W1.store, signedIn: false });
  const H = await boot(W7);
  check("the copy is deleted and the sign-in shown", await until(() => !!H.$("gateEmail")) && !W1.store.has("app") && H.storage()["spotter.appHeld"] === undefined, H.text());
  check("...without starting the app", !H.fakeUp());

  console.log("\nA delete that fails is tried again");
  W1.store.set("app", { version: "1.1.0-bbbb2222", html: fakeApp("1.1.0-bbbb2222") });
  const W8 = world({ store: W1.store, signedIn: false, delFails: 99 });
  const I = await boot(W8, { "spotter.appHeld": "1" });
  await until(() => !!I.$("gateEmail"));
  check("if it can't be deleted, the device remembers there's still a copy", W1.store.has("app") && I.storage()["spotter.appHeld"] === "1");
  const W9 = world({ store: W1.store, signedIn: false });
  const J = await boot(W9, I.storage());
  check("...and the next launch deletes it", await until(() => !W1.store.has("app")) && J.storage()["spotter.appHeld"] === undefined);

  /* ------------------------------------------------ the real app, all the way through */
  console.log("\nThe real app, started by the shell");
  const WR = world({ real: true, role: "owner", version: "9.9.9-cccc3333" });
  const R = await boot(WR, {}, "?x=1");     // (jsdom only reports a navigation to a different address)
  check("it starts", await until(() => !!R.$("viewOverview") && !!R.$("acctBtn")), R.text().slice(0, 200));
  check("the shell is gone and the app has the window", !R.$("gateEmail") && !!R.$("sideNav") && !!R.$("themeBtn"));
  check("it runs with no script errors", R.real().length === 0, R.real().join(" | ").slice(0, 400));
  check("it knows it is hosted", R.w.__spotterShell === true);
  await until(() => R.$("acctDot") && /ok|busy/.test(R.$("acctDot").className));
  R.$("acctBtn").click(); await tick();
  const so = R.btn("Sign out");
  check("its account sheet has Sign out", !!so);
  if (so) {
    so.click(); await tick(300);
    R.$("confirmYes").click();
    check("signing out deletes the app's copy from the device", await until(() => !WR.store.has("app")));
    check("...clears the note that one is held", R.storage()["spotter.appHeld"] === undefined);
    check("...and goes back to the sign-in page", await until(() => R.nav().length > 0), R.errors.join(" | ").slice(0, 200));
  }
  const WS = world({ real: true, signedIn: false, store: new Map([["app", { version: "x", html: appHtml }]]) });
  const S = await boot(WS);
  check("a signed-out device never starts the real app", await until(() => !!S.$("gateEmail")) && !S.$("viewOverview") && !WS.store.has("app"));

  const bad = [A, B, C, D, E, E2, F, G, G2, H, I, J, S].reduce((a, x) => a.concat(x.real()), []);
  check("no script errors on any other device", bad.length === 0, bad.join(" | ").slice(0, 400));
  console.log(`\n${checks} checks · ${failures === 0 ? "ALL PASSED" : failures + " FAILED"}\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
