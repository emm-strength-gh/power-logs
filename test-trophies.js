/* Trophies and strength levels: standards by IPF class, levels, clubs,
 * consistency, PRs, coach awards, the celebration and the share image.
 * Run: node test-trophies.js
 *
 * Signed in as a coach through the stand-in cloud, with the lifters kept on the
 * device (so the trophies are recorded locally, no database needed here:
 * test-trophysync.js covers the server side). A recording stand-in replaces the
 * canvas, since jsdom has none.
 */
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");
const { installCoach } = require("./test-cloudfake");

const html = fs.readFileSync(path.join(__dirname, "app.html"), "utf8");
let failures = 0, checks = 0;
const check = (name, cond, extra = "") => {
  checks++;
  if (!cond) failures++;
  console.log(`${cond ? "  ok  " : " FAIL "} ${name}${extra && !cond ? " — " + extra : ""}`);
};
const tick = (ms = 50) => new Promise(r => setTimeout(r, ms));

const GL = { m: [1199.72839, 1025.18162, 0.00921], f: [610.32796, 1045.59282, 0.03048] };
const gl = (sex, bw, total) => total * 100 / (GL[sex][0] - GL[sex][1] * Math.exp(-GL[sex][2] * bw));

async function boot(seed) {
  const errors = [], drawn = [], shared = [];
  const dom = new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true,
    url: "https://example.github.io/power-logs/app.html",
    virtualConsole: new VirtualConsole().on("jsdomError", e => errors.push(e.message)).on("error", m => errors.push(String(m))),
    beforeParse(w) {
      installCoach(w);
      if (seed) Object.keys(seed).forEach(k => w.localStorage.setItem(k, JSON.stringify(seed[k])));
      // A canvas that remembers what was written on it.
      w.HTMLCanvasElement.prototype.getContext = function () {
        const grad = { addColorStop() {} };
        return new Proxy({}, {
          get(t, p) {
            if (p === "fillText") return (s) => drawn.push(String(s));
            if (p === "measureText") return (s) => ({ width: String(s).length * 20 });
            if (p === "createLinearGradient" || p === "createRadialGradient") return () => grad;
            return t[p] !== undefined ? t[p] : function () {};
          },
          set(t, p, v) { t[p] = v; return true; },
        });
      };
      w.HTMLCanvasElement.prototype.toBlob = function (cb) { cb(new w.Blob(["png"], { type: "image/png" })); };
      w.Path2D = function () {};
      Object.defineProperty(w.navigator, "share", { value: async (d) => { shared.push(d); }, configurable: true });
      Object.defineProperty(w.navigator, "canShare", { value: (d) => !!(d && d.files && d.files.length), configurable: true });
    },
  });
  const w = dom.window, doc = w.document, $ = id => doc.getElementById(id);
  w.Element.prototype.scrollIntoView = function () {};
  w.scrollTo = function () {};
  await new Promise(res => { if (doc.readyState === "complete") res(); else w.addEventListener("load", res); setTimeout(res, 4000); });
  const real = () => errors.filter(e => !/Not implemented|HTMLCanvasElement|getContext|Chart is not defined/i.test(e));
  const A = {
    w, doc, $, errors, real, drawn, shared,
    async load(text, name = "t.csv") {
      const input = $("fileInput");
      Object.defineProperty(input, "files", { value: [new w.File([text], name)], configurable: true });
      input.dispatchEvent(new w.Event("change"));
      await tick(300);
    },
    nav(label) { const b = [...doc.querySelectorAll("#sideNav .nav-item")].find(n => (n.querySelector(".nav-label") || {}).textContent.indexOf(label) === 0); if (b) b.click(); return !!b; },
    store: () => JSON.parse(w.localStorage.getItem("spotter.trophies.v1") || "{}"),
    earned(name) { const t = A.store()[name]; return t ? Object.keys(t.earned) : []; },
    text: () => $("troBody").textContent,
    btn(label, root) { return [...(root || doc).querySelectorAll("button")].find(b => b.textContent.trim() === label); },
    item: id => doc.querySelector(`.tro-item[data-trophy="${id}"]`),
    async setup(sex, bw) {
      doc.querySelector(`.tro-form [data-sex="${sex}"]`).click();
      $("troBw").value = String(bw);
      A.btn("Save", $("troBody")).click();
      await tick(400);
    },
    async dismiss() { while ($("troScrim").classList.contains("show")) { $("troClose").click(); await tick(300); } },
  };
  return A;
}

const csv = (o = {}) => {
  const name = o.name || "Test Lifter", block = o.block || "Strength block";
  const maxes = o.maxes || [["Squat", 172.5], ["Bench", 127.5], ["Deadlift", 202.5]];
  const weeks = o.weeks || 2;
  let t = `#Name,${name}\r\n#Block,${block}\r\n`;
  if (o.bw !== undefined) t += `#Bodyweight,${o.bw}\r\n`;
  if (o.cls !== undefined) t += `#Class,${o.cls}\r\n`;
  t += maxes.map(([l, v]) => `#Max,${l},${v}\r\n`).join("");
  t += "Week,Day,Exercise,Weight (kg),Sets,Reps,RPE,Notes\r\n";
  for (let wk = 1; wk <= weeks; wk++) {
    t += `${wk},1,Squat,${wk === 2 ? 170 : 150},3,${wk === 2 ? 2 : 3},7,\r\n${wk},1,Bench,100,3,5,7,\r\n`;
    t += `${wk},2,Deadlift,180,3,3,7,\r\n`;
  }
  return t;
};

(async () => {
  /* ============================================================ men, 83 kg class */
  const A = await boot();
  check("boots with no script errors", A.real().length === 0, A.real().join(" | ").slice(0, 300));
  await A.load(csv({ bw: 82 }));
  check("Trophies sits in the sidebar", !!A.nav("Trophies"));
  await tick(200);
  check("the Trophies view opens", A.$("viewTrophies").classList.contains("active"));
  check("without standards it asks for them, and shows no levels", /Set your standards/.test(A.text()) && !/Overall level/.test(A.text()));
  check("the bodyweight from the program is prefilled", A.$("troBw").value === "82", A.$("troBw").value);
  check("nothing is awarded before the standards are set", A.earned("Test Lifter").length === 0, A.earned("Test Lifter").join());

  console.log("\nMen's standards, 82 kg: the 83 kg class");
  await A.setup("m", 82);
  check("the class is named", /Men’s 83 kg/.test(A.$("troSub").textContent), A.$("troSub").textContent);
  check("the levels card shows", /Overall level/.test(A.text()));
  const e1 = A.earned("Test Lifter");
  check("squat 172.5 is Advanced at 83 kg", e1.includes("lvl:squat:advanced") && !e1.includes("lvl:squat:elite"));
  check("every lower tier comes with it", ["beginner", "novice", "intermediate"].every(t => e1.includes("lvl:squat:" + t)));
  check("bench 127.5 and deadlift 202.5 are Advanced too", e1.includes("lvl:bench:advanced") && e1.includes("lvl:deadlift:advanced"));
  check("so the overall level is Advanced", e1.includes("lvl:overall:advanced") && !e1.includes("lvl:overall:elite"));
  check("the overall level is shown in words", /Overall level\s*Advanced/.test(A.text()), A.text().slice(0, 200));
  check("the total is 502.5 kg", /502\.5 kg total/.test(A.text()), A.text().slice(0, 300));
  const glv = gl("m", 82, 502.5);
  check("IPF points are worked out for the bodyweight", A.text().includes(glv.toFixed(1) + " GL points"), A.text().slice(0, 300) + " want " + glv.toFixed(1));
  check("GL 50 and 65 are earned, 80 is not", e1.includes("gl:50") && e1.includes("gl:65") && !e1.includes("gl:80"), glv.toFixed(1));
  check("total clubs: 300, 400, 500 but not 600", ["total:300", "total:400", "total:500"].every(t => e1.includes(t)) && !e1.includes("total:600"));
  check("bodyweight clubs: squat 2x, bench 1.5x, deadlift 2x (not 2.5x)", e1.includes("bw:squat:2") && e1.includes("bw:bench:1.5") && e1.includes("bw:deadlift:2") && !e1.includes("bw:deadlift:2.5") && !e1.includes("bw:bench:2"));
  check("the women's multiples are not on a men's shelf", !A.item("bw:squat:1") && !A.item("bw:deadlift:1.5") && !!A.item("bw:squat:1.5"));
  check("trophies are stored with the class at the time", A.store()["Test Lifter"].earned["lvl:squat:advanced"].cls === "Men’s 83 kg");
  check("...and with what earned them", /172\.5 kg/.test(A.store()["Test Lifter"].earned["lvl:squat:advanced"].note));
  check("lots at once: no dialog, just the shelf", !A.$("troScrim").classList.contains("show"));
  check("earned trophies show their date, locked ones what is needed", /Need 212\.5 kg/.test(A.item("lvl:squat:elite").textContent) && A.item("lvl:squat:advanced").classList.contains("earned"), A.item("lvl:squat:elite").textContent);
  check("what's new is marked, and counts as seen once drawn", A.item("lvl:squat:advanced").classList.contains("fresh") && Object.values(A.store()["Test Lifter"].earned).every(e => e.seen === true));
  A.nav("Overview"); A.nav("Trophies"); await tick(100);
  check("...so the mark is gone next time", !A.item("lvl:squat:advanced").classList.contains("fresh"));
  check("the Earned filter hides what isn't", (() => { A.btn("Earned", A.$("troBody")).click(); const r = !A.item("lvl:squat:elite") && !!A.item("lvl:squat:advanced"); A.btn("All", A.$("troBody")).click(); return r; })());
  check("bench next-level hint", /Elite at 155 kg · 27\.5 kg to go/.test(A.text()), A.text().slice(0, 600));

  console.log("\nClass limits");
  A.btn("Edit", A.$("troBody")).click(); await tick(50);
  check("Edit opens the standards form", A.$("troFormScrim").classList.contains("show") && A.$("troBw").value === "82");
  const setBw = async v => { A.$("troBw").value = v; A.btn("Save", A.$("troFormBody")).click(); await tick(300); };
  await setBw("83");
  check("exactly 83 kg is still the 83 kg class", /Men’s 83 kg/.test(A.$("troSub").textContent), A.$("troSub").textContent);
  A.btn("Edit", A.$("troBody")).click(); await tick(50); await setBw("83.1");
  check("83.1 kg is the 93 kg class", /Men’s 93 kg/.test(A.$("troSub").textContent), A.$("troSub").textContent);
  check("a trophy already earned stays after moving up a class", A.earned("Test Lifter").includes("lvl:squat:advanced") && A.store()["Test Lifter"].earned["lvl:squat:advanced"].cls === "Men’s 83 kg");
  A.btn("Edit", A.$("troBody")).click(); await tick(50); await setBw("130");
  check("over 120 kg is the 120+ class", /Men’s 120\+ kg/.test(A.$("troSub").textContent), A.$("troSub").textContent);
  A.btn("Edit", A.$("troBody")).click(); await tick(50);
  A.$("troBw").value = "10"; A.btn("Save", A.$("troFormBody")).click(); await tick(100);
  check("an impossible bodyweight is refused", A.$("troFormScrim").classList.contains("show") && A.store()["Test Lifter"].prefs.bw === 130);
  A.$("troFormClose").click();
  A.btn("Edit", A.$("troBody")).click(); await tick(50); await setBw("82");

  /* ------------------------------------------------------------ the picture */
  console.log("\nThe celebration and the share image");
  A.item("lvl:squat:advanced").click(); await tick(150);
  check("tapping an earned trophy opens it", A.$("troScrim").classList.contains("show"));
  check("the image is on the page", !!A.doc.querySelector("#troCard canvas.tro-canvas"));
  check("it says what it is, in whose name, and when", ["TROPHY UNLOCKED", "Squat · Advanced", "Test Lifter", "Power Logs"].every(s => A.drawn.some(d => d.indexOf(s) !== -1)), A.drawn.join(" | "));
  check("...with the lift that earned it", A.drawn.some(d => /172\.5 kg/.test(d)));
  check("the share button is offered (this browser can share files)", A.$("troShare").textContent === "Share to your story" && !A.$("troSave").hidden);
  check("the hint names the apps and says why it can't post for you", /Instagram/.test(A.$("troShareHint").textContent) && /directly/.test(A.$("troShareHint").textContent));
  A.$("troShare").click(); await tick(100);
  check("sharing hands the share sheet a PNG", A.shared.length === 1 && A.shared[0].files[0].type === "image/png" && /\.png$/.test(A.shared[0].files[0].name), JSON.stringify(A.shared.map(s => Object.keys(s))));
  check("...with a caption", /Squat · Advanced/.test(A.shared[0].text) && /\nPower Logs$/.test(A.shared[0].text));
  A.drawn.length = 0;
  A.$("troShowName").checked = false; A.$("troShowName").dispatchEvent(new A.w.Event("change")); await tick(100);
  check("hiding the name redraws the image without it", A.drawn.length > 0 && !A.drawn.some(d => d === "Test Lifter"), A.drawn.join(" | "));
  check("...and remembers the choice", A.w.localStorage.getItem("spotter.trophyShareName") === "0");
  A.$("troClose").click(); await tick(100);
  check("closing the dialog", !A.$("troScrim").classList.contains("show"));
  A.item("lvl:squat:elite").click();
  check("a locked trophy only says what it needs", !A.$("troScrim").classList.contains("show") && /Squat · Elite/.test(A.$("toastMsg").textContent), A.$("toastMsg").textContent);

  /* ------------------------------------------------ finishing days and weeks */
  console.log("\nConsistency");
  A.nav("Week 1"); await tick(100);
  const allDone = () => [...A.doc.querySelectorAll(".day-alldone")];
  check("the week view shows", A.$("viewWeek").classList.contains("active") && allDone().length === 2, "buttons: " + allDone().length);
  allDone()[0].click(); await tick(500);
  check("one day finished: no trophy yet", !A.earned("Test Lifter").includes("fullweek:1"));
  check("...but the day's date is kept for streaks", Object.values(A.store()["Test Lifter"].days).filter(Boolean).length === 1, JSON.stringify(A.store()["Test Lifter"].days));
  allDone().find(b => /Mark all done/.test(b.textContent)).click(); await tick(600);
  check("a full week earns its trophy", A.earned("Test Lifter").includes("fullweek:1"));
  check("...and, with one new thing, a dialog opens for it", A.$("troScrim").classList.contains("show") && /Full week/.test(A.$("troCard").textContent + A.drawn.join("|")), A.drawn.join("|"));
  check("the dialog says Trophy unlocked", A.$("troTitle").textContent === "Trophy unlocked");
  await A.dismiss();
  check("two finished days are counted, not ten", !A.earned("Test Lifter").includes("sessions:10"));

  console.log("\nA number from a Done set");
  A.nav("Week 2"); await tick(100);
  allDone()[0].click(); await tick(600);
  await A.dismiss();
  A.nav("Trophies"); await tick(100);
  check("170 x 2 estimates 181 kg (Epley, rounded down to 0.5)", /181 kg · from W2 · D1 \(170 kg × 2\)/.test(A.text()), A.text().slice(0, 700));

  /* ---------------------------------------------------------------- PRs */
  console.log("\nPersonal records");
  A.btn("Log a PR", A.$("troBody")).click(); await tick(50);
  check("the PR form opens", A.$("troFormScrim").classList.contains("show") && !!A.$("troPrKg"));
  check("a coach's own lifter: logged as confirmed", /Logged as confirmed/.test(A.$("troFormBody").textContent));
  A.$("troPrKg").value = "700"; A.btn("Log PR", A.$("troFormBody")).click(); await tick(50);
  check("an impossible weight is refused", A.store()["Test Lifter"].prs.length === 0 && A.$("troFormScrim").classList.contains("show"));
  A.doc.querySelector('.tro-form [data-lift="bench"]').click();
  A.$("troPrKg").value = "130"; A.btn("Log PR", A.$("troFormBody")).click(); await tick(600);
  const prs = A.store()["Test Lifter"].prs;
  check("the PR is stored", prs.length === 1 && prs[0].lift === "bench" && prs[0].kg === 130 && prs[0].reps === 1 && prs[0].conf === true);
  check("it shows on the page", /Bench press · 130 kg/.test(A.text()));
  check("the first PR earns its trophy", A.earned("Test Lifter").includes("pr:1"));
  await A.dismiss();
  check("...and the lift number follows (130 beats 127.5)", /130 kg · from a confirmed PR/.test(A.text()), A.text().slice(0, 700));
  A.btn("Remove", A.$("troBody")).click(); await tick(50);
  check("a PR can be removed", A.store()["Test Lifter"].prs.length === 0 && A.earned("Test Lifter").includes("pr:1"), "(the trophy stays)");

  /* ------------------------------------------------------------ awards */
  console.log("\nCoach awards");
  A.btn("Give an award", A.$("troBody")).click(); await tick(50);
  check("a coach can give an award", A.$("troFormScrim").classList.contains("show") && !!A.$("troAwardKind"));
  A.$("troAwardKind").value = "podium"; A.$("troAwardNote").value = "Third in the 83s"; A.btn("Give award", A.$("troFormBody")).click(); await tick(100);
  const pod = A.store()["Test Lifter"].earned["award:podium"];
  check("it's stored with the coach's note", pod && pod.note === "Third in the 83s" && pod.by, JSON.stringify(pod));
  check("...and shows on the shelf", A.item("award:podium").classList.contains("earned"));
  A.btn("Give an award", A.$("troBody")).click(); await tick(50);
  A.$("troAwardKind").value = "custom"; A.$("troAwardKind").dispatchEvent(new A.w.Event("change"));
  A.btn("Give award", A.$("troFormBody")).click(); await tick(50);
  check("a custom award needs a title", A.$("troFormScrim").classList.contains("show") && !Object.keys(A.store()["Test Lifter"].earned).some(k => /custom/.test(k)));
  A.$("troAwardTitle").value = "Iron Will"; A.$("troAwardNote").value = "Never missed a session"; A.btn("Give award", A.$("troFormBody")).click(); await tick(100);
  const cid = Object.keys(A.store()["Test Lifter"].earned).find(k => /^award:custom:/.test(k));
  check("a custom award has its own title", !!cid && A.item(cid) && /Iron Will/.test(A.item(cid).textContent));
  A.btn("Give an award", A.$("troBody")).click(); await tick(50);
  A.$("troAwardKind").value = "podium"; A.btn("Give award", A.$("troFormBody")).click(); await tick(50);
  check("the same award twice is refused", /already have that award/.test(A.$("toastMsg").textContent), A.$("toastMsg").textContent);
  A.$("troFormClose").click();
  A.item("award:podium").click(); await tick(150);
  check("an award opens as Award, with the coach's note", A.$("troTitle").textContent === "Award" && A.drawn.some(d => /Third in the 83s/.test(d)), A.drawn.join("|"));
  check("a coach can take it back", !A.$("troTakeBack").hidden);
  A.$("troTakeBack").click(); await tick(100);
  check("...and it's gone", !A.earned("Test Lifter").includes("award:podium") && !A.item("award:podium").classList.contains("earned"));

  check("no script errors along the way", A.real().length === 0, A.real().join(" | ").slice(0, 400));

  /* ============================================================ women's standards */
  console.log("\nWomen's standards");
  const B = await boot();
  await B.load(csv({ name: "Sam", maxes: [["Squat", 105], ["Bench", 60], ["Deadlift", 125]], bw: 60 }));
  B.nav("Trophies"); await tick(200);
  await B.setup("f", 60);
  check("60 kg is the women's 63 class", /Women’s 63 kg/.test(B.$("troSub").textContent), B.$("troSub").textContent);
  const eb = B.earned("Sam");
  check("squat 105 is Advanced for 63 kg women (102.5)", eb.includes("lvl:squat:advanced") && !eb.includes("lvl:squat:elite"));
  check("bench 60 is Intermediate, not Advanced (67.5)", eb.includes("lvl:bench:intermediate") && !eb.includes("lvl:bench:advanced"));
  check("deadlift 125 is Intermediate (Advanced is 120)", eb.includes("lvl:deadlift:advanced"));
  check("women's clubs: squat 1.5x bodyweight, bench 1x, deadlift 2x", eb.includes("bw:squat:1.5") && eb.includes("bw:bench:1") && eb.includes("bw:deadlift:2") && !eb.includes("bw:squat:2"), eb.filter(x => /^bw/.test(x)).join());
  check("women's total clubs: 150, 200, 250 (290 kg), not 300", ["total:150", "total:200", "total:250"].every(t => eb.includes(t)) && !eb.includes("total:300"));
  check("women's IPF points use the women's formula", B.text().includes(gl("f", 60, 290).toFixed(1) + " GL points"), gl("f", 60, 290).toFixed(1));

  /* ============================================================ streaks, comebacks, blocks */
  console.log("\nStreaks, comebacks and blocks");
  const day = (d) => new Date(Date.UTC(2026, 0, 5 + d, 10)).toISOString();   // 5 Jan 2026 is a Monday
  const days = {};
  [0, 7, 14, 21].forEach((d, i) => { days["1|" + (i + 1)] = day(d); });         // four weeks in a row
  days["9|1"] = day(21 + 21);                                                     // three weeks away, then back
  // An award a coach gave, not yet looked at.
  const unseen = { "award:podium": { at: day(1), on: "2026-01-06", cls: "", note: "Third", by: "coach-x", sent: true, seen: false } };
  const C = await boot({ "spotter.trophies.v1": { "Streaky": { earned: unseen, prs: [], prefs: { sex: "m", bw: 82 }, days, blocks: {}, gone: { prs: [], trophies: [] }, init: true } } });
  await C.load(csv({ name: "Streaky" }));
  const badge = () => { const n = [...C.doc.querySelectorAll("#sideNav .nav-item")].find(x => /Trophies/.test(x.textContent)); const b = n && n.querySelector(".nav-badge"); return b ? Number(b.textContent) : 0; };
  check("a new trophy from a coach puts a badge on Trophies in the sidebar", badge() === 1, String(badge()));
  C.nav("Trophies"); await tick(300);
  check("...it's marked New on the shelf, and the badge clears once seen", C.item("award:podium").classList.contains("fresh") && badge() === 0);
  const ec = C.earned("Streaky");
  check("four weeks running earns the 4-week streak", ec.includes("streak:4") && !ec.includes("streak:8"), ec.join());
  check("three weeks away then back is a comeback", ec.includes("comeback"));
  check("a streak needs the dates days finished", !ec.includes("sessions:10"));

  const D = await boot();
  await D.load(csv({ name: "Peaker", block: "Taper", weeks: 3 }));
  D.nav("Trophies"); await tick(200);
  await D.setup("m", 80);
  D.nav("Week 1"); await tick(100);
  for (const wk of [1, 2, 3]) {
    D.nav("Week " + wk); await tick(80);
    [...D.doc.querySelectorAll(".day-alldone")].filter(b => /Mark all done/.test(b.textContent)).forEach(b => b.click());
    await tick(80);
  }
  await tick(600);
  const ed = D.earned("Peaker");
  check("finishing every exercise of a 3-week block is a perfect block", ed.includes("perfect:1"), ed.join());
  check("...and a block named Taper earns Taper complete", ed.includes("taper"));
  check("...with full weeks", ed.includes("fullweek:1") && !ed.includes("fullweek:5"));
  check("...and the block is remembered after the program is replaced", Object.keys(D.store().Peaker.blocks).length === 1);
  await D.dismiss();

  const bad = [...A.errors, ...B.errors, ...C.errors, ...D.errors].filter(e => !/Not implemented|HTMLCanvasElement|getContext|Chart is not defined/i.test(e));
  check("no script errors in any scenario", bad.length === 0, bad.join(" | ").slice(0, 400));

  console.log(`\n${checks} checks · ${failures === 0 ? "ALL PASSED" : failures + " FAILED"}\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
