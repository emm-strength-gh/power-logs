/* Photos in Messages: compressed, sent, opened once (then gone from the server), kept only in memory,
 * saved, forwarded by a coach, unsent by the sender.
 * Run: node test-photos.js
 *
 * A coach (the owner) with two lifters, Tom and Sam, each on their own jsdom copy of app.html, on one
 * in-memory Postgres with the real rules (test-cloudfake.js's pgServer, which also keeps the stored files).
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
const csv = (name, block) => `#Name,${name}\r\n#Block,${block}\r\nWeek,Day,Exercise,Weight (kg),Sets,Reps,RPE,Notes\r\n1,1,Squat,100,3,5,7,\r\n`;

(async () => {
  const server = await pgServer();
  const apps = [];

  function boot(label, reuse) {
    const dev = reuse ? reuse.dev : server.device(label), errors = [], urls = [], squeezed = [];
    let n = 0;
    const dom = new JSDOM(html, {
      runScripts: "dangerously", pretendToBeVisual: true,
      url: "https://example.github.io/power-logs/app.html",
      virtualConsole: new VirtualConsole().on("jsdomError", e => errors.push(e.message)).on("error", m => errors.push(String(m))),
      beforeParse(w) {
        w.__spotterCloud = dev;
        w.__spotterHooks = {};
        if (reuse) Object.entries(reuse.storage).forEach(([k, v]) => w.localStorage.setItem(k, v));
        w.URL.createObjectURL = b => { urls.push(b); return "blob:ph-" + (++n); };
        w.URL.revokeObjectURL = () => {};
        // the picture engine: what the canvas would make (a JPEG at most 5 megapixels)
        w.__spotterPhoto = { compress: async f => { squeezed.push(f.name); return { blob: new w.Blob(["jpeg:" + f.name], { type: "image/jpeg" }), w: 1581, h: 3162 }; } };
      },
    });
    const w = dom.window, doc = w.document, $ = id => doc.getElementById(id);
    w.Element.prototype.scrollIntoView = function () {};
    w.scrollTo = function () {};
    const app = {
      label, dev, w, doc, $, urls, squeezed,
      real: () => errors.filter(e => !/Not implemented|HTMLCanvasElement|getContext|Chart is not defined/i.test(e)),
      nav(l) { const b = [...doc.querySelectorAll("#sideNav .nav-item")].find(x => x.querySelector(".nav-label").textContent === l); if (b) b.click(); return !!b; },
      btn: (text, root) => [...(root || doc).querySelectorAll("button")].find(b => b.textContent.trim() === text),
      pick(name) { $("lifterSelect").value = name; $("lifterSelect").dispatchEvent(new w.Event("change")); },
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
      async sendPhoto(fname) {
        const i = $("msgPhotoFile");
        Object.defineProperty(i, "files", { value: [new w.File(["raw"], fname, { type: "image/png" })], configurable: true });
        i.dispatchEvent(new w.Event("change"));
        await tick(300);
      },
      bubble: mid => doc.querySelector('#msgList [data-mid="' + mid + '"]'),
    };
    apps.push(app);
    return app;
  }
  const rows = (sql, args) => server.sql(sql, args);
  const photoRow = async mid => (await rows("select * from public.message_photos where message_id = $1", [mid]))[0];
  const hasFile = async (lid, mid) => (await rows("select 1 from storage.objects where bucket_id = 'msg-photos' and name = $1", [lid + "/" + mid + ".jpg"])).length > 0;

  /* ------------------------------------------------------------ set-up */
  console.log("Set-up: the owner coaches Tom and Sam, who both sign in");
  const C = boot("coach");
  await tick(200);
  await C.load(csv("Tom", "Prep"), "tom.csv"); await C.load(csv("Sam", "Base"), "sam.csv");
  await C.signIn(OWNER_EMAIL);
  C.$("confirmYes").click();
  await until(async () => (await rows("select count(*)::int n from public.lifters"))[0].n === 2);
  await C.settle();
  await rows("update public.lifters set lifter_email = lower(name) || '@test.invalid'");
  const tomId = (await rows("select id from public.lifters where name = 'Tom'"))[0].id;
  const samId = (await rows("select id from public.lifters where name = 'Sam'"))[0].id;
  const T = boot("tom"); await tick(200); await T.signIn("tom@test.invalid");
  const S = boot("sam"); await tick(200); await S.signIn("sam@test.invalid");
  const coachUid = (await rows("select user_id from public.accounts where email = $1", [OWNER_EMAIL]))[0].user_id;
  for (const a of [C, T, S]) { a.sync(); await a.settle(); }

  console.log("\nThe size it is sent at");
  const fit = C.w.__spotterHooks.photoFit;
  const mp = d => d.w * d.h;
  check("a big photo is brought down to at most 5 megapixels, keeping its shape", (() => { const d = fit(4032, 3024); return mp(d) <= 5000000 && mp(d) > 4900000 && Math.abs(d.w / d.h - 4 / 3) < 0.01; })(), JSON.stringify(fit(4032, 3024)));
  check("...portrait the same way", (() => { const d = fit(3024, 4032); return mp(d) <= 5000000 && d.h > d.w; })(), JSON.stringify(fit(3024, 4032)));
  check("...a square stays square", (() => { const d = fit(4000, 4000); return d.w === d.h && mp(d) <= 5000000; })(), JSON.stringify(fit(4000, 4000)));
  check("a phone screenshot (3 megapixels) is kept at its size; nothing is made bigger", JSON.stringify(fit(1179, 2556)) === JSON.stringify({ w: 1179, h: 2556 }) && JSON.stringify(fit(800, 600)) === JSON.stringify({ w: 800, h: 600 }));

  const squeeze = C.w.__spotterHooks.photoSqueeze;
  const enc = bpp => (w, h, q) => Promise.resolve({ size: Math.round(w * h * q * bpp), w, h, q });
  const small = await squeeze(enc(0.3), 1179, 2556);
  check("a photo that fits 2 MB at the best quality is sent at that quality and size", small.w === 1179 && small.blob.q === 0.82 && small.blob.size <= 2097152, JSON.stringify(small));
  const busy = await squeeze(enc(0.6), 4032, 3024);
  check("a detailed 5 megapixel photo gets a lower quality until it is 2 MB or less, same size", busy.w * busy.h > 4900000 && busy.blob.q < 0.82 && busy.blob.size <= 2097152, JSON.stringify({ w: busy.w, h: busy.h, q: busy.blob.q, s: busy.blob.size }));
  const huge = await squeeze(enc(1.2), 4032, 3024);
  check("if even the lowest quality is too big, it is made a little smaller until it fits", huge.w * huge.h < 4900000 && huge.blob.size <= 2097152, JSON.stringify({ w: huge.w, h: huge.h, q: huge.blob.q, s: huge.blob.size }));

  /* ------------------------------------------------------------ sending */
  console.log("\nTom sends a photo");
  T.pick("Tom"); await tick(100);
  T.nav("Messages"); await tick(200);
  check("the message box has a photo button", !!T.$("msgPhotoBtn") && T.$("msgPhotoFile").accept === "image/*");
  await T.sendPhoto("squat-depth.png");
  const m1 = await until(async () => (await rows("select count(*)::int n from public.message_photos"))[0].n === 1) && (await rows("select message_id from public.message_photos"))[0].message_id;
  check("it is made a JPEG on the phone first", T.squeezed.join() === "squat-depth.png");
  const msg1 = (await rows("select * from public.messages where id = $1", [m1]))[0] || {};
  check("the message is marked a photo (its text says so, for previews and banners)", msg1.photo === true && msg1.body === "📷 Photo", JSON.stringify(msg1));
  const p1 = await photoRow(m1);
  check("its record waits to be opened, with its size", p1.state === "waiting" && p1.width === 1581 && p1.height === 3162 && p1.size_bytes > 0, JSON.stringify(p1));
  check("the file is in the private bucket, for now", await hasFile(tomId, m1));
  check("on Tom's phone it shows as the picture, not opened yet", await until(() => !!T.bubble(m1) && !!T.bubble(m1).querySelector(".msg-photo img") && /Not opened yet/.test(T.bubble(m1).textContent)));

  /* ------------------------------------------------------------ opening */
  console.log("\nThe coach opens it");
  C.sync(); await C.settle();
  C.pick("Tom"); await tick(100);
  C.nav("Messages"); await tick(300);
  check("the coach sees a photo to tap, not the picture yet", await until(() => !!C.bubble(m1) && !!C.bubble(m1).querySelector(".msg-photo-tap")) && /Tap to view/.test(C.bubble(m1).textContent));
  C.bubble(m1).querySelector(".msg-photo-tap").click();
  check("tapping it opens the photo full screen", await until(() => C.$("phScrim").classList.contains("show")) && /^blob:ph-/.test(C.$("phImg").getAttribute("src") || ""));
  check("...with a header warning it is deleted when the app closes", /deleted from this device when you close the app/.test(C.$("phWarn").textContent) && !C.$("phWarn").hidden);
  check("...a Save button, and Forward for a coach", !!C.$("phSave") && !C.$("phFwd").hidden);
  check("the database says the coach opened it", await until(async () => (await photoRow(m1)).state === "opened") && (await photoRow(m1)).opened_by === coachUid);
  check("...and the file is gone from the server", await until(async () => !(await hasFile(tomId, m1))));
  const before = C.urls.length;
  C.$("phSave").click(); await tick(100);
  check("Save hands the JPEG to the phone", C.urls.slice(before).some(b => b && b.type === "image/jpeg"));
  T.sync(); await T.settle();
  T.nav("Current Program"); T.nav("Messages"); await tick(300);
  check("Tom's phone shows it as opened", await until(() => !!T.bubble(m1) && /Opened/.test(T.bubble(m1).textContent)));

  /* ------------------------------------------------------------ forwarding */
  console.log("\nThe coach forwards it to Sam");
  C.$("phFwd").click(); await tick(150);
  const fwdBoxes = () => [...C.$("troFormBody").querySelectorAll('.ph-fwd-list input[type="checkbox"]')];
  check("Forward lists the coach's other lifters (Sam, not Tom)", fwdBoxes().map(b => b.parentElement.textContent).join() === "Sam", fwdBoxes().map(b => b.parentElement.textContent).join());
  fwdBoxes()[0].checked = true;
  C.btn("Send", C.$("troFormBody")).click();
  check("Sam gets it as a photo of his own", await until(async () => (await rows("select count(*)::int n from public.message_photos where lifter_id = $1", [samId]))[0].n === 1));
  const m2 = (await rows("select message_id from public.message_photos where lifter_id = $1", [samId]))[0].message_id;
  check("...waiting for him, its file on the server", (await photoRow(m2)).state === "waiting" && await hasFile(samId, m2));
  S.sync(); await S.settle();
  S.pick("Sam"); await tick(100);
  S.nav("Messages"); await tick(300);
  check("on Sam's phone it is a photo to tap", await until(() => !!S.bubble(m2) && !!S.bubble(m2).querySelector(".msg-photo-tap")));
  S.bubble(m2).querySelector(".msg-photo-tap").click();
  check("Sam opens it: no Forward for a lifter", await until(() => S.$("phScrim").classList.contains("show")) && S.$("phFwd").hidden);
  check("...and it leaves the server", await until(async () => (await photoRow(m2)).state === "opened" && !(await hasFile(samId, m2))));
  S.$("phClose").click(); await tick(50);

  /* ------------------------------------------------------------ unsending */
  console.log("\nTom unsends one");
  await T.sendPhoto("oops.png");
  const m3 = await until(async () => (await rows("select count(*)::int n from public.message_photos where lifter_id = $1", [tomId]))[0].n === 2) && (await rows("select message_id from public.message_photos where lifter_id = $1 and message_id <> $2", [tomId, m1]))[0].message_id;
  C.sync(); await C.settle(); C.nav("Current Program"); C.nav("Messages"); await tick(300);
  check("the coach has it, not opened", await until(() => !!C.bubble(m3)));
  await until(() => !!T.bubble(m3));
  T.bubble(m3).dispatchEvent(new T.w.MouseEvent("contextmenu", { bubbles: true, cancelable: true })); await tick(100);
  check("holding his photo offers Unsend", !!T.$("reactPop") && !!T.btn("Unsend", T.$("reactPop")));
  T.btn("Unsend", T.$("reactPop")).click(); await tick(100);
  check("it asks first", T.$("confirmScrim").classList.contains("show") && /Unsend this photo/.test(T.$("confirmTitle").textContent));
  T.$("confirmYes").click();
  check("unsent: the message is gone from the server", await until(async () => !(await rows("select 1 from public.messages where id = $1", [m3])).length));
  check("...its record says so, and the file is gone", (await photoRow(m3)).state === "unsent" && !(await hasFile(tomId, m3)));
  check("...and from Tom's phone, picture and all", await until(() => !T.bubble(m3)) && !T.w.__spotterHooks.photoState().mem.includes(m3));
  C.sync(); await C.settle();
  check("the coach's phone drops it too", await until(() => !C.bubble(m3)) && !C.w.__spotterHooks.photoState().mem.includes(m3));
  check("a photo someone else sent has no Unsend", (() => { C.bubble(m1).dispatchEvent(new C.w.MouseEvent("contextmenu", { bubbles: true, cancelable: true })); return !C.btn("Unsend", C.doc); })());

  /* ------------------------------------------------------------ closing the app */
  console.log("\nClosing the app");
  const stored = JSON.stringify(T.storage());
  check("no picture is ever written to the phone's storage", !/jpeg:|blob:ph-/.test(stored));
  const T2 = boot("tom reopened", { dev: T.dev, storage: T.storage() });
  await tick(400);
  T2.sync(); await T2.settle();
  T2.pick("Tom"); await tick(100);
  T2.nav("Messages"); await tick(300);
  check("opened again, the photo is gone from the phone: it says so", await until(() => !!T2.bubble(m1) && !!T2.bubble(m1).querySelector(".msg-photo-gone")) && /Not on this device any more/.test(T2.bubble(m1).textContent) && !T2.bubble(m1).querySelector("img"));
  let refused = null;
  try { await T2.dev.storageDownload("msg-photos", tomId + "/" + m1 + ".jpg"); } catch (e) { refused = e.message; }
  check("...and the server doesn't have it either", !!refused);

  check("no script errors on any device", apps.every(a => a.real().length === 0), apps.map(a => a.label + ": " + a.real().join(" | ")).filter(x => !/: $/.test(x)).join(" || "));
  console.log(`\n${checks} checks · ${failures === 0 ? "ALL PASSED" : failures + " FAILED"}\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
