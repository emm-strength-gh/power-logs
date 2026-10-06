/* Vid Review end to end on the real database rules: a lifter and a coach upload videos (crop and
 * cut on the device, details, compress, send), both watch them (downloaded and kept on the device),
 * only the coach deletes, sign-out clears the device, and the owner's storage meter.
 * Run: node test-vidreview.js
 *
 * The video engine (opening a clip, compressing it with WebCodecs) needs a real browser, so a
 * stand-in plugs in as window.__spotterVideo; what it is asked to do (start, end, crop box) is
 * recorded and checked. The files themselves are kept in a stand-in for storage whose rules are
 * the real ones on storage.objects (supabase/schema.sql), run on PGlite.
 */
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");
const { pgServer, OWNER_EMAIL, GOOD_CODE } = require("./test-cloudfake");

const html = fs.readFileSync(path.join(__dirname, "power-logs.html"), "utf8");
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
  "Week,Day,Exercise,Weight (kg),Sets,Reps,RPE,Notes\r\n1,1,Squat,160,4,4,7,\r\n1,1,Bench,110,4,5,7,\r\n1,2,Deadlift,200,3,3,8,\r\n2,1,Squat,165,4,4,7.5,\r\n";
const MB = 1048576;

(async () => {
  const server = await pgServer();
  const jobs = [];                                   // what the engine was asked to make
  const eng = { size: 2 * MB, duration: 20, fail: null };

  function boot(label, reuse) {
    const dev = reuse ? reuse.dev : server.device(label), errors = [], priv = reuse ? reuse.priv : new Map();
    const dom = new JSDOM(html, {
      runScripts: "dangerously", pretendToBeVisual: true,
      url: "https://example.github.io/power-logs/power-logs.html",
      virtualConsole: new VirtualConsole().on("jsdomError", e => errors.push(e.message)).on("error", m => errors.push(String(m))),
      beforeParse(w) {
        w.__spotterCloud = dev;
        w.__spotterHooks = {};
        w.__spotterPrivateStore = { get: async k => priv.get(k), put: async (k, v) => { priv.set(k, v); }, del: async k => { priv.delete(k); } };
        w.__spotterVideo = {
          load: async file => ({ url: "blob:clip-" + file.name, duration: eng.duration, width: 1080, height: 1920 }),
          transcode: async (job, onProgress) => {
            jobs.push(JSON.parse(JSON.stringify({ start: job.start, end: job.end, crop: job.crop })));
            onProgress(0.5);
            if (eng.fail) throw new Error(eng.fail);
            return { blob: new w.Blob([new Uint8Array(eng.size)], { type: "video/mp4" }), thumb: "data:image/jpeg;base64,/9j/AAAA", duration: job.end - job.start, width: 368, height: 654 };
          },
        };
        if (reuse) Object.entries(reuse.storage).forEach(([k, v]) => w.localStorage.setItem(k, v));
        const reg = { addEventListener() {}, pushManager: { getSubscription: async () => null, subscribe: async () => ({ endpoint: "https://push.test/" + label, toJSON() { return { endpoint: this.endpoint, keys: { p256dh: "p", auth: "a" } }; }, unsubscribe: async () => true }) } };
        Object.defineProperty(w.navigator, "serviceWorker", { configurable: true, value: { ready: Promise.resolve(reg), register: async () => reg, controller: null, addEventListener() {} } });
        w.PushManager = function () {};
        w.Notification = { permission: "default", requestPermission: async () => "granted" };
        w.HTMLCanvasElement.prototype.getContext = function () {
          const g = { addColorStop() {} };
          return new Proxy({}, { get: (t, p) => p === "measureText" ? s => ({ width: String(s).length * 20 }) : (p === "createLinearGradient" || p === "createRadialGradient") ? () => g : (t[p] !== undefined ? t[p] : function () {}), set: (t, p, v) => { t[p] = v; return true; } });
        };
        w.Path2D = function () {};
        w.URL.createObjectURL = b => "blob:made-" + (b && b.size);
        w.URL.revokeObjectURL = () => {};
        w.HTMLMediaElement.prototype.play = function () { this.__paused = false; return Promise.resolve(); };
        w.HTMLMediaElement.prototype.pause = function () { this.__paused = true; };
        w.HTMLMediaElement.prototype.load = function () {};
      },
    });
    const w = dom.window, doc = w.document, $ = id => doc.getElementById(id);
    w.Element.prototype.scrollIntoView = function () {};
    w.scrollTo = function () {};
    const app = {
      label, dev, w, doc, $, priv,
      real: () => errors.filter(e => !/Not implemented|HTMLCanvasElement|getContext|Chart is not defined/i.test(e)),
      nav(l) { const b = [...doc.querySelectorAll("#sideNav .nav-item")].find(n => n.querySelector(".nav-label").textContent === l); if (b) b.click(); return !!b; },
      navs: () => [...doc.querySelectorAll("#sideNav .nav-item")].map(n => n.querySelector(".nav-label").textContent),
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
      storage: () => { const o = {}; for (let i = 0; i < w.localStorage.length; i++) { const k = w.localStorage.key(i); o[k] = w.localStorage.getItem(k); } return o; },
      ed: () => w.__spotterHooks.vidEd && w.__spotterHooks.vidEd(),
      cards: () => [...doc.querySelectorAll("#vidGrid .vid-card")],
      shown: () => $("vidEditScrim").classList.contains("show"),
      async pickFile(name) {
        const i = $("vidFile");
        Object.defineProperty(i, "files", { value: [new w.File(["x"], name, { type: "video/quicktime" })], configurable: true });
        i.dispatchEvent(new w.Event("change"));
        await until(() => app.ed() && app.ed().vw);
        await tick(50);
      },
      slide(id, v) { $(id).value = String(v); $(id).dispatchEvent(new w.Event("input")); },
      touch(el, type, pts) { const e = new w.Event(type, { bubbles: true, cancelable: true }); e.touches = pts.map(([x, y]) => ({ clientX: x, clientY: y })); el.dispatchEvent(e); },
    };
    return app;
  }
  const rows = (sql, args) => server.sql(sql, args);
  const objs = async () => rows("select name from storage.objects where bucket_id = 'vid-review' order by created_at");
  const vrows = async () => rows("select v.*, a.email from public.lifter_videos v left join public.accounts a on a.user_id = v.uploaded_by order by v.created_at");

  /* ------------------------------------------------------------ set-up */
  console.log("Set-up: the owner coaches Tom, who signs in");
  const C = boot("coach");
  await tick(200);
  await C.load(TOM, "tom.csv");
  await C.signIn(OWNER_EMAIL);
  C.closeSheet(); await tick(100);
  C.$("confirmYes").click();
  await until(async () => (await rows("select count(*)::int n from public.lifters"))[0].n === 1);
  await C.settle();
  const tomId = (await rows("select id from public.lifters where name = 'Tom'"))[0].id;
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

  /* ------------------------------------------------------------ the MP4 writer */
  console.log("\nThe MP4 writer");
  {
    const w = L.w, mp4 = w.__spotterHooks.vidMp4;
    const samples = [0, 1, 2, 3, 4].map(i => ({ pts: i * 33333, key: i === 0 || i === 3, data: new Uint8Array(100 + i * 10).fill(i + 1) }));
    const blob = mp4({ width: 368, height: 654, description: new Uint8Array([1, 0x4d, 0x40, 0x1f, 0xff, 0xe1, 0, 0]), lastDur: 33333, samples });
    const buf = await new Promise(res => { const r = new w.FileReader(); r.onload = () => res(new Uint8Array(r.result)); r.readAsArrayBuffer(blob); });
    const dv = new DataView(buf.buffer);
    const top = []; for (let o = 0; o < buf.length;) { const n = dv.getUint32(o); top.push([String.fromCharCode(...buf.slice(o + 4, o + 8)), o, n]); o += n; }
    check("a file is ftyp, moov, then mdat (it plays while it downloads)", top.map(x => x[0]).join() === "ftyp,moov,mdat", top.map(x => x[0]).join());
    check("...with sizes that add up exactly", top.reduce((a, x) => a + x[2], 0) === buf.length);
    const find = (name, from, to) => { for (let o = from; o + 8 <= to;) { const n = dv.getUint32(o), ty = String.fromCharCode(...buf.slice(o + 4, o + 8)); if (ty === name) return [o, n]; if (["moov", "trak", "mdia", "minf", "stbl"].includes(ty)) { const r = find(name, o + 8, o + n); if (r) return r; } o += n; } return null; };
    const moov = top[1], stsz = find("stsz", moov[1], moov[1] + moov[2]), stco = find("stco", moov[1], moov[1] + moov[2]), stss = find("stss", moov[1], moov[1] + moov[2]);
    check("it lists all five frames", stsz && dv.getUint32(stsz[0] + 16) === 5 && stco && dv.getUint32(stco[0] + 12) === 5);
    const sizes = [0, 1, 2, 3, 4].map(i => dv.getUint32(stsz[0] + 20 + i * 4)), offs = [0, 1, 2, 3, 4].map(i => dv.getUint32(stco[0] + 16 + i * 4));
    check("each frame's offset points at its own bytes", samples.every((x, i) => sizes[i] === x.data.length && buf[offs[i]] === i + 1 && buf[offs[i] + sizes[i] - 1] === i + 1), JSON.stringify(offs));
    check("the key frames are marked (1 and 4)", stss && dv.getUint32(stss[0] + 12) === 2 && dv.getUint32(stss[0] + 16) === 1 && dv.getUint32(stss[0] + 20) === 4);
    check("it says it is 368 x 654 H.264", (() => { const s = String.fromCharCode(...buf); return s.includes("avc1") && s.includes("avcC"); })() && (() => { const i = String.fromCharCode(...buf).lastIndexOf("avc1"); return dv.getUint16(i + 4 + 24) === 368 && dv.getUint16(i + 4 + 26) === 654; })());
  }

  /* ------------------------------------------------------------ the page */
  console.log("\nThe Vid Review page");
  check("the lifter has Vid Review in the menu", L.navs().includes("Vid Review"), L.navs().join());
  check("...and so does the coach", C.navs().includes("Vid Review"), C.navs().join());
  L.nav("Vid Review"); await tick(200);
  check("it opens, naming the lifter and offering Upload", L.$("viewVidReview").classList.contains("active") && !!L.$("vidUploadBtn") && L.$("vidSub").textContent === "Tom");
  check("with nothing yet, it says so", /No videos yet/.test(L.$("vidBody").textContent));

  /* ------------------------------------------------------------ crop, cut, details, upload */
  console.log("\nChoosing a video, then crop and cut");
  await L.pickFile("squat.mov");
  check("a chosen video opens the editor", L.shown() && !L.$("vidPaneTrim").hidden && L.$("vidPaneInfo").hidden);
  let ed = L.ed();
  check("it starts keeping the whole clip, cropped to the biggest portrait box", ed.start === 0 && ed.end === 20 && Math.round(ed.cropW || 0) >= 0 && ed.zoom === 1);
  check("...which reads as 'Keeps 0:20.0 of 0:20.0'", /Keeps 0:20\.0 of 0:20\.0/.test(L.$("vidKeeps").textContent), L.$("vidKeeps").textContent);
  L.slide("vidStart", 4); L.slide("vidEnd", 15);
  ed = L.ed();
  check("the Start and End sliders cut it", ed.start === 4 && ed.end === 15 && /Keeps 0:11\.0 of 0:20\.0/.test(L.$("vidKeeps").textContent), L.$("vidKeeps").textContent);
  L.slide("vidStart", 14.8);
  ed = L.ed();
  check("it keeps at least a second", ed.end - ed.start >= 1 - 1e-9, ed.start + " " + ed.end);
  L.slide("vidStart", 4); L.slide("vidEnd", 15);
  L.slide("vidZoom", 50);
  ed = L.ed();
  check("Crop size shrinks the box (the same portrait shape)", ed.zoom === 0.5);
  const box = L.$("vidCrop"), cx0 = ed.cx;
  box.dispatchEvent(new L.w.MouseEvent("pointerdown", { clientX: 100, clientY: 100, bubbles: true }));
  box.dispatchEvent(new L.w.MouseEvent("pointermove", { clientX: 160, clientY: 60, bubbles: true }));
  box.dispatchEvent(new L.w.MouseEvent("pointerup", { clientX: 160, clientY: 60, bubbles: true }));
  ed = L.ed();
  check("dragging the box moves the crop", Math.abs(ed.cx - (cx0 + 60)) < 1.5, cx0 + " -> " + ed.cx);
  box.dispatchEvent(new L.w.MouseEvent("pointerdown", { clientX: 0, clientY: 0, bubbles: true }));
  box.dispatchEvent(new L.w.MouseEvent("pointermove", { clientX: 99999, clientY: -99999, bubbles: true }));
  box.dispatchEvent(new L.w.MouseEvent("pointerup", { clientX: 0, clientY: 0, bubbles: true }));
  ed = L.ed();
  check("...but not off the picture", ed.cx <= 1080 - 540 + 0.5 && ed.cy >= -0.5, ed.cx + "," + ed.cy);
  L.$("vidPreview").click();
  check("Preview plays the kept part (muted) from the start", L.$("vidPreview").textContent === "Stop" && L.$("vidEditVideo").__paused === false);
  L.$("vidPreview").click();
  check("...and Stop stops it", L.$("vidPreview").textContent === "Preview" && L.$("vidEditVideo").__paused === true);

  console.log("\nThe details, and the upload");
  L.$("vidNext").click();
  check("Next asks for the lift, reps and set", !L.$("vidPaneInfo").hidden && L.$("vidPaneTrim").hidden && !!L.$("vidLift") && !!L.$("vidReps") && !!L.$("vidSet"));
  check("with suggestions for each", L.$("vidLiftList").querySelectorAll("option").length >= 5 && [...L.$("vidSetList").querySelectorAll("option")].some(o => o.value === "Last warm up"));
  L.$("vidGo").click(); await tick(100);
  check("the lift is required", !L.$("vidError").hidden && /Enter the lift/.test(L.$("vidError").textContent) && jobs.length === 0);
  L.$("vidLift").value = "Squat"; L.$("vidReps").value = "4"; L.$("vidSet").value = "Top set";
  L.$("vidGo").click();
  check("Upload starts the compression of just that part, as that crop", await until(() => jobs.length === 1));
  const j = jobs[0];
  check("...the kept 4 s to 15 s", j.start === 4 && j.end === 15, JSON.stringify(j));
  check("...and the crop box in the clip's own pixels, portrait-shaped", j.crop.w > 500 && Math.abs(j.crop.w / j.crop.h - 368 / 654) < 0.01 && j.crop.x >= 0 && j.crop.x + j.crop.w <= 1080 && j.crop.y + j.crop.h <= 1920, JSON.stringify(j.crop));
  check("the editor closes and the video is listed", await until(() => !L.shown() && L.cards().length === 1));
  const card = L.cards()[0];
  check("its card shows the lift, reps and set", /Squat/.test(card.textContent) && /4 reps/.test(card.textContent) && /Top set/.test(card.textContent) && /You/.test(card.textContent), card.textContent);
  check("...with its thumbnail", !!card.querySelector("img") && /^data:image\/jpeg/.test(card.querySelector("img").src));
  const v1 = (await vrows())[0];
  check("it is in the database with those details, from Tom", v1 && v1.lift === "Squat" && v1.reps === "4" && v1.set_label === "Top set" && v1.email === "tom@test.invalid" && v1.size_bytes === 2 * MB && Number(v1.duration) === 11, JSON.stringify(v1 && { l: v1.lift, r: v1.reps, s: v1.set_label, e: v1.email, z: v1.size_bytes, d: v1.duration }));
  check("...and the file is in the bucket under Tom's folder", (await objs()).map(o => o.name).join() === tomId + "/" + v1.id + ".mp4", JSON.stringify(await objs()));
  check("Tom's phone keeps a copy of what he sent", await until(() => L.priv.has("vid:" + v1.id)) && L.storage()["spotter.vidHeld"] === "1");
  check("...and the card says so", await until(() => !!L.cards()[0].querySelector(".vid-held")));

  console.log("\nA video that is too long");
  eng.size = 31 * MB;
  await L.pickFile("long.mov");
  L.$("vidNext").click();
  L.$("vidLift").value = "Bench press"; L.$("vidSet").value = "Set 2";
  L.$("vidGo").click();
  check("a compressed file over 30 MB is refused with 'Video too long'", await until(() => /Video too long/.test(L.$("vidError").textContent) && !L.$("vidError").hidden), L.$("vidError").textContent);
  check("...nothing is sent", (await vrows()).length === 1 && (await objs()).length === 1 && L.shown());
  check("...and the buttons come back", L.$("vidGo").textContent === "Upload" && !L.$("vidLift").disabled);
  L.$("vidEditClose").click();
  eng.size = 2 * MB; eng.duration = 400;
  const before = jobs.length;
  await L.pickFile("hour.mov");
  L.$("vidNext").click();
  L.$("vidLift").value = "Deadlift";
  L.$("vidGo").click(); await tick(100);
  check("a clip so long it can't fit is refused before compressing", /Video too long/.test(L.$("vidError").textContent) && jobs.length === before);
  L.$("vidEditClose").click();
  eng.duration = 20;
  eng.fail = "This browser can’t compress video.";
  await L.pickFile("old-phone.mov");
  L.$("vidNext").click();
  L.$("vidLift").value = "Squat";
  L.$("vidGo").click();
  check("if the phone can't compress, it says so and sends nothing", await until(() => /can.t compress/.test(L.$("vidError").textContent)) && (await vrows()).length === 1);
  L.$("vidEditClose").click();
  eng.fail = null;

  /* ------------------------------------------------------------ the coach watches */
  console.log("\nThe coach watches it");
  C.sync(); await C.settle();
  C.nav("Vid Review"); await tick(300);
  check("the coach sees Tom's video on Tom's page", await until(() => C.cards().length === 1) && /Squat/.test(C.cards()[0].textContent) && /Tom/.test(C.cards()[0].textContent), C.cards().map(c => c.textContent).join("|"));
  check("...with its thumbnail, fetched separately", await until(() => !!C.cards()[0].querySelector("img")));
  check("not on this device yet", !C.cards()[0].querySelector(".vid-held") && !C.priv.has("vid:" + v1.id));
  C.cards()[0].click();
  check("tapping it opens the player with its details", C.$("vidPlayScrim").classList.contains("show") && /Squat · 4 reps · Top set/.test(C.$("vidPlayTitle").textContent), C.$("vidPlayTitle").textContent);
  check("it downloads to the device and plays", await until(() => C.priv.has("vid:" + v1.id)) && await until(() => /^blob:made-/.test(C.$("vidPlayVideo").getAttribute("src") || "")));
  check("...marked as on this device", await until(() => !!C.cards()[0].querySelector(".vid-held")));
  check("the coach has a delete button, in the player", !C.$("vidDelete").hidden);

  console.log("\nPinch zoom, rewind and replay");
  const wrap = C.$("vidZoomWrap"), stage = C.$("vidPStage");
  const sc = () => parseFloat((/scale\(([\d.]+)\)/.exec(wrap.style.transform) || [])[1] || "1");
  check("it starts at its normal size", sc() === 1 && C.$("vidZoomReset").hidden);
  C.touch(stage, "touchstart", [[100, 200], [200, 200]]);
  C.touch(stage, "touchmove", [[50, 200], [250, 200]]);
  C.touch(stage, "touchend", []);
  check("pinching out zooms in", sc() > 1.8 && sc() < 2.2, wrap.style.transform);
  const zoomed = wrap.style.transform;
  C.touch(stage, "touchstart", [[100, 200], [200, 200]]);
  C.touch(stage, "touchmove", [[130, 200], [170, 200]]);
  C.touch(stage, "touchend", []);
  check("pinching in zooms out (even below normal)", sc() < 1, wrap.style.transform);
  C.touch(stage, "touchstart", [[100, 200], [200, 200]]);
  C.touch(stage, "touchmove", [[50, 200], [250, 200]]);
  C.touch(stage, "touchend", []);
  const keep = wrap.style.transform;
  const vp = C.$("vidPlayVideo");
  let t = 9; Object.defineProperty(vp, "currentTime", { get: () => t, set: v => { t = v; }, configurable: true });
  Object.defineProperty(vp, "duration", { get: () => 11, configurable: true });
  C.$("vidBack").click();
  check("back 5 seconds", t === 4, String(t));
  t = 3; C.$("vidFwd").click();
  check("forward 5 seconds, no further than the end", t === 8, String(t));
  C.$("vidFwd").click();
  check("...and it stops at the end", t === 11, String(t));
  C.$("vidReplay").click();
  check("Replay goes back to the start and plays", t === 0 && vp.__paused === false);
  C.$("vidSpeed").click();
  check("the speed button gives slow motion", vp.playbackRate === 0.5 && C.$("vidSpeed").textContent === "0.5×");
  C.$("vidSpeed").click(); C.$("vidSpeed").click();
  check("...and back to normal", vp.playbackRate === 1);
  C.$("vidScrub").value = "500"; C.$("vidScrub").dispatchEvent(new C.w.Event("input"));
  check("the slider scrubs", Math.abs(t - 5.5) < 0.1, String(t));
  check("through all of that the zoom stays where it was left", wrap.style.transform === keep && !C.$("vidZoomReset").hidden, wrap.style.transform + " vs " + keep);
  C.$("vidZoomReset").click();
  check("Fit puts it back", sc() === 1 && C.$("vidZoomReset").hidden);
  C.$("vidPlayClose").click();
  check("closing the player closes it", !C.$("vidPlayScrim").classList.contains("show"));

  /* ------------------------------------------------------------ the coach uploads, the lifter watches */
  console.log("\nThe coach uploads one too");
  eng.size = 3 * MB;
  await C.pickFile("pulldown.mov");
  C.$("vidNext").click();
  C.$("vidLift").value = "Lat pulldown"; C.$("vidReps").value = "10"; C.$("vidSet").value = "Last warm up";
  C.$("vidGo").click();
  check("it goes through the same steps", await until(() => !C.shown() && C.cards().length === 2));
  const v2 = (await vrows()).find(r => r.lift === "Lat pulldown");
  check("recorded as the coach's", v2 && v2.reps === "10" && v2.set_label === "Last warm up" && v2.email === OWNER_EMAIL, JSON.stringify(v2));
  check("the newest is first, saying who sent it", /Lat pulldown/.test(C.cards()[0].textContent) && /You/.test(C.cards()[0].textContent) && /10 reps/.test(C.cards()[0].textContent));
  L.sync(); await L.settle();
  L.nav("Vid Review"); await tick(300);
  check("Tom sees it, with the coach's name on it", await until(() => L.cards().length === 2) && /Lat pulldown/.test(L.cards()[0].textContent) && !/You/.test(L.cards()[0].textContent), L.cards().map(c => c.textContent).join("|"));
  L.cards()[0].click();
  check("he plays it (downloaded to his phone)", await until(() => L.priv.has("vid:" + v2.id)));
  check("there is no delete for him", L.$("vidDelete").hidden);
  L.$("vidPlayClose").click();

  console.log("\nOnly coaches delete");
  let tried = null;
  try { await L.dev.remove("lifter_videos", "id", v2.id); } catch (e) { tried = e.message; }
  const left = await objs();
  const rm = await L.dev.storageRemove("vid-review", [tomId + "/" + v2.id + ".mp4"]);
  check("even going round the app, Tom can't delete a video or its file", (await vrows()).length === 2 && (await objs()).length === 2 && rm.length === 0 && left.length === 2, tried + " " + JSON.stringify(rm));
  C.cards()[0].click(); await tick(100);
  C.$("vidDelete").click(); await tick(100);
  check("the coach is asked first", C.$("confirmScrim").classList.contains("show") && /Delete this video/.test(C.$("confirmTitle").textContent));
  C.$("confirmNo").click(); await tick(100);
  check("Cancel keeps it", (await vrows()).length === 2);
  C.$("vidDelete").click(); await tick(100);
  C.$("confirmYes").click();
  check("deleted: the record and the file are both gone", await until(async () => (await vrows()).length === 1 && (await objs()).length === 1));
  check("...the player closes and the card goes", await until(() => !C.$("vidPlayScrim").classList.contains("show") && C.cards().length === 1));
  check("...and the coach's copy of it is removed from the device", await until(() => !C.priv.has("vid:" + v2.id)));
  L.sync(); await L.settle();
  L.nav("Overview"); L.nav("Vid Review"); await tick(300);
  check("Tom's phone drops it too, and its copy", await until(() => L.cards().length === 1) && await until(() => !L.priv.has("vid:" + v2.id)));
  check("his own video is still there", /Squat/.test(L.cards()[0].textContent));

  /* ------------------------------------------------------------ outsiders, and signing out */
  console.log("\nOutsiders and signing out");
  const X = boot("stranger");
  await tick(200);
  await X.signIn("stranger@test.invalid");
  let denied = null;
  try { await X.dev.storageDownload("vid-review", tomId + "/" + v1.id + ".mp4"); } catch (e) { denied = e.message; }
  check("a stranger can't download a video", /not found/i.test(denied || ""), denied);
  check("...nor see the list", (await X.dev.fetch("lifter_videos", { orderBy: "created_at" })).length === 0);
  let evil = null;
  try { await X.dev.storageUpload("vid-review", tomId + "/" + "11111111-1111-4111-8111-111111111111.mp4", new X.w.Blob(["x"])); } catch (e) { evil = e.message; }
  check("...nor upload into Tom's folder", /row-level security|violates|policy/i.test(evil || ""), evil);
  let odd = null;
  try { await L.dev.storageUpload("vid-review", tomId + "/not-a-video-id.mp4", new L.w.Blob(["x"])); } catch (e) { odd = e.message; }
  check("a file name that isn't <lifter>/<video>.mp4 is refused, even for Tom", /row-level security|violates|policy/i.test(odd || ""), odd);

  L.$("acctBtn").click(); await tick();
  L.btn("Sign out", L.$("acctBody")).click(); await tick(300);
  L.$("confirmYes").click();
  check("signing out deletes every video from Tom's phone", await until(() => ![...L.priv.keys()].some(k => /^vid:/.test(k))), [...L.priv.keys()].join());
  check("...and the list and the note that videos are held", await until(() => (JSON.parse(L.storage()["spotter.vidreview.v1"] || "{\"list\":[]}").list || []).length === 0) && L.storage()["spotter.vidHeld"] === undefined);

  /* ------------------------------------------------------------ the owner's meter */
  console.log("\nThe owner's storage meter");
  C.nav("Home"); await tick(200);
  C.$("storageRefresh").click(); await tick(300);
  const caps = [...C.doc.querySelectorAll("#viewHome .home-cap")].map(c => c.textContent);
  check("a Storage card sits below Payments for the owner", caps.join() === "Notifications,Lifters,Messages,Payments,Storage" && !C.$("homeStorage").hidden, caps.join());
  check("it shows the video files against 1 GB, and the database against 500 MB", await until(() => /Video files/.test(C.$("homeStorage").textContent) && /of 1\.00 GB/.test(C.$("homeStorage").textContent) && /Database/.test(C.$("homeStorage").textContent) && /of 500\.0 MB/.test(C.$("homeStorage").textContent)), C.$("homeStorage").textContent);
  check("...counting the video there is", / 1 video(?!s)/.test(C.$("homeStorage").textContent) && /2\.0 MB of 1\.00 GB/.test(C.$("homeStorage").textContent), C.$("homeStorage").textContent);
  check("the meter bars are drawn", C.$("homeStorage").querySelectorAll(".stor-bar i").length === 2);
  const refresh = C.$("storageRefresh");
  check("it can be refreshed", !!refresh);
  const usage = await C.dev.rpc("owner_storage_usage");
  check("what the owner is told comes from the database", usage && Number(usage.video_bytes) === 2 * MB && usage.video_count === 1 && Number(usage.db_bytes) > 0, JSON.stringify(usage));
  check("nobody else gets the figures (a stranger is told nothing)", (await X.dev.rpc("owner_storage_usage")) === null);

  const bad = [C, L, X].reduce((a, x) => a.concat(x.real()), []);
  check("no script errors on any device", bad.length === 0, bad.join(" | ").slice(0, 400));
  console.log(`\n${checks} checks · ${failures === 0 ? "ALL PASSED" : failures + " FAILED"}\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
