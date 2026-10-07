/* Taper builder (Program Hub): the three lifter types against the taper research
 * it was built from, the Clean version, and a real import into Power Logs.
 * Run: node test-taper.js
 *
 * Day numbers are weekdays and the meet is week 2 day 6 (Saturday), so
 * "days out" = (2 - week) * 7 + (6 - day).
 */
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

let failures = 0, checks = 0;
const check = (name, cond, extra = "") => {
  checks++;
  if (!cond) failures++;
  console.log(`${cond ? "  ok  " : " FAIL "} ${name}${extra && !cond ? " — " + extra : ""}`);
};
const tick = (ms = 50) => new Promise(r => setTimeout(r, ms));
function boot(file, url) {
  const errors = [];
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, file), "utf8"), {
    runScripts: "dangerously", pretendToBeVisual: true, url,
    virtualConsole: new VirtualConsole().on("jsdomError", e => errors.push(e.message)).on("error", m => errors.push(String(m))),
    beforeParse(w) { w.Chart = class { static defaults = { font: {} }; constructor() {} destroy() {} }; },
  });
  dom.window.Element.prototype.scrollIntoView = function () {};
  dom.window.scrollTo = function () {};
  return { w: dom.window, real: () => errors.filter(e => !/Not implemented|HTMLCanvasElement|getContext/i.test(e)) };
}
// Minimal CSV line split (quoted cells with commas).
const cells = line => { const out = []; let cur = "", q = false;
  for (let i = 0; i < line.length; i++) { const c = line[i];
    if (q) { if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true; else if (c === ",") { out.push(cur); cur = ""; } else cur += c; }
  out.push(cur); return out; };
const parse = csv => {
  const lines = csv.split(/\r?\n/).filter(Boolean), at = lines.findIndex(l => /^Week,Day,/.test(l));
  return { head: lines.slice(0, at), rows: lines.slice(at + 1).map(cells).map(c => ({
    week: +c[0], day: +c[1], ex: c[2], wt: parseFloat(c[3]), sets: +c[4] || 0, reps: +c[5] || 0, rpe: c[6], notes: c[7] || "",
    out: (2 - +c[0]) * 7 + (6 - +c[1]) })) };
};
const MAX = { Squat: 200, Bench: 140, Deadlift: 230 }, LIFTS = ["Squat", "Bench", "Deadlift"];
// What the research files give for each lifter type: last heavy single, days out.
const EXPECT = {
  regular: { label: "Regular lifter",         heavy: { Deadlift: 10, Squat: 8,  Bench: 5 }, rest: 2 },
  heavy:   { label: "Super heavy lifter",     heavy: { Deadlift: 12, Squat: 10, Bench: 8 }, rest: 3 },
  light:   { label: "Novice or female lifter", heavy: { Deadlift: 7,  Squat: 5,  Bench: 4 }, rest: 2 },
};

(async () => {
  const hub = boot("program-hub.html", "https://example.github.io/power-logs/program-hub.html");
  const w = hub.w, $ = id => w.document.getElementById(id);
  check("hub boots with no script errors", hub.real().length === 0, hub.real().join(" | ").slice(0, 300));
  check("the hub has a Taper card and view", !!w.document.querySelector('.gen-card[data-go="taper"]') && !!$("view-taper"));
  check("lifter type offers regular, super heavy, novice or female",
    [...$("tp-type").options].map(o => o.value).join() === "regular,heavy,light" && $("tp-type").value === "regular");
  check("the menu says what the chosen type changes", /deadlift 10 days out, squat 8, bench 5. .* 2 days of complete rest/.test($("tp-typehint").textContent), $("tp-typehint").textContent);
  $("tp-type").value = "heavy"; $("tp-type").dispatchEvent(new w.Event("change"));
  check("...and follows the choice", /deadlift 12 days out, squat 10, bench 8. .* 3 days of complete rest/.test($("tp-typehint").textContent), $("tp-typehint").textContent);
  $("tp-type").value = "regular"; $("tp-type").dispatchEvent(new w.Event("change"));
  w.showView("taper");
  w.buildTaper();
  check("it needs all three maxes", /Enter all three 1RMs/.test($("tp-msg").textContent) && $("results").style.display !== "block");

  const built = {};
  for (const type of Object.keys(EXPECT)) {
    const E = EXPECT[type];
    console.log("\n" + E.label);
    $("tp-name").value = "Smith, J"; $("tp-block").value = "Nationals";
    $("tp-squat").value = MAX.Squat; $("tp-bench").value = MAX.Bench; $("tp-dead").value = MAX.Deadlift;
    $("tp-type").value = type;
    w.buildTaper();
    const segs = [...w.document.querySelectorAll("#seg button")];
    check("builds, with Program and Clean versions", $("results").style.display === "block" && segs.map(b => b.textContent.trim()).join() === "Program,Clean", segs.map(b => b.textContent).join());
    w.setVariant("program");
    const prog = parse(w.variantToCSV(w.activeVariant()));
    w.setVariant("clean");
    const cleanCSV = w.variantToCSV(w.activeVariant()), clean = parse(cleanCSV);
    w.setVariant("program");
    built[type] = { prog, cleanCSV };
    const bar = prog.rows.filter(r => LIFTS.includes(r.ex));
    const of = l => bar.filter(r => r.ex === l);

    check("two weeks: a last heavy week and a taper week", [...new Set(prog.rows.map(r => r.week))].join() === "1,2");
    check("the meet is week 2, day 6", prog.rows.some(r => r.week === 2 && r.day === 6 && r.ex === "Meet day"));
    const heavyAt = {}, lastAt = {};
    LIFTS.forEach(l => {
      const h = of(l).filter(r => /^Last heavy/.test(r.notes));
      heavyAt[l] = h.length === 1 ? h[0].out : -1;
      lastAt[l] = Math.min(...of(l).map(r => r.out));
    });
    check("last heavy day per lift is where the research puts it", LIFTS.every(l => heavyAt[l] === E.heavy[l]), JSON.stringify(heavyAt));
    check("deadlift stops heavy first, then squat, bench last", heavyAt.Deadlift > heavyAt.Squat && heavyAt.Squat > heavyAt.Bench);
    check("the note on each says how many days out", LIFTS.every(l => of(l).some(r => r.notes.includes("Last heavy") && r.notes.includes(E.heavy[l] + " days out"))));
    check("heavy singles are 1 rep at 90-92.5%, not a max", LIFTS.every(l => of(l).filter(r => /^Last heavy/.test(r.notes))
      .every(r => { const p = parseFloat((r.notes.match(/(\d+(?:\.\d+)?)%/) || [])[1]); return r.sets === 1 && r.reps === 1 && p >= 90 && p <= 92.5 && +r.rpe <= 8.5; })));
    check("nothing is heavier than the last heavy single", LIFTS.every(l => Math.max(...of(l).map(r => r.wt)) === of(l).find(r => /^Last heavy/.test(r.notes)).wt));
    check("after its last heavy day each lift stays at 70-80%",
      LIFTS.every(l => of(l).filter(r => r.out < heavyAt[l]).every(r => r.wt / MAX[l] >= 0.69 && r.wt / MAX[l] <= 0.805)),
      JSON.stringify(LIFTS.map(l => of(l).filter(r => r.out < heavyAt[l]).map(r => r.wt))));
    check("no lift is trained after its turn: bench last, deadlift first", lastAt.Bench <= lastAt.Squat && lastAt.Squat <= lastAt.Deadlift, JSON.stringify(lastAt));
    const restDays = prog.rows.filter(r => r.ex === "Rest").map(r => r.out).sort();
    check(`${E.rest} days of complete rest, right before the meet`, restDays.join() === Array.from({ length: E.rest }, (_, i) => i + 1).join()
      && Math.min(...bar.map(r => r.out)) === E.rest + 1, restDays.join());
    check("bench's last session is 3-4 days out (it fades first with rest)", lastAt.Bench <= 4 && lastAt.Bench >= 3, String(lastAt.Bench));
    const reps = (l, wk) => of(l).filter(r => r.week === wk).reduce((n, r) => n + r.sets * r.reps, 0);
    const cut = l => 1 - reps(l, 2) / reps(l, 1);
    const total = wk => LIFTS.reduce((n, l) => n + reps(l, wk), 0), cutAll = 1 - total(2) / total(1);
    check("squat and bench volume drop 30-70% in the taper week", ["Squat", "Bench"].every(l => cut(l) >= 0.3 && cut(l) <= 0.7),
      ["Squat", "Bench"].map(l => l + " " + Math.round(cut(l) * 100) + "%").join(", "));
    check("total volume drops 30-70%", cutAll >= 0.3 && cutAll <= 0.7, Math.round(cutAll * 100) + "%");
    check("every load is its % of the 1RM, rounded to 2.5 kg", bar.every(r => {
      const p = parseFloat((r.notes.match(/(\d+(?:\.\d+)?)%/) || [])[1]);
      return r.wt % 2.5 === 0 && Math.abs(r.wt - Math.round(MAX[r.ex] * p / 100 / 2.5) * 2.5) < 0.01;
    }));
    check("every bench set is paused", of("Bench").every(r => /1s pause/.test(r.notes)));
    const notes = prog.head.filter(l => l.startsWith("# "));
    check("program notes name the lifter type and the meet day", notes.some(n => n.includes(E.label)) && notes.some(n => /Meet = Week 2 Day 6 \(Saturday\)/.test(n)) && /^# TAPER/.test(notes[0]));
    check("...and each lift's last heavy day", notes.some(n => n.includes(`deadlift ${E.heavy.Deadlift} days out, squat ${E.heavy.Squat}, bench ${E.heavy.Bench}`)), notes.join(" | ").slice(0, 400));
    check("a name with a comma survives", /^#Name,"Smith, J"/m.test(prog.head.join("\n")));

    check("Clean has the same sessions and loads", JSON.stringify(clean.rows.map(r => [r.week, r.day, r.ex, r.wt, r.sets, r.reps, r.rpe])) ===
      JSON.stringify(prog.rows.map(r => [r.week, r.day, r.ex, r.wt, r.sets, r.reps, r.rpe])));
    check("Clean carries no percentages anywhere", !cleanCSV.includes("%"), (cleanCSV.match(/.*%.*/) || [""])[0].slice(0, 120));
    check("Clean keeps the cues", clean.rows.some(r => /^Last heavy pull · \d+ days out/.test(r.notes)));
  }

  console.log("\nBetween the types");
  const h = t => { const o = {}; LIFTS.forEach(l => { o[l] = built[t].prog.rows.find(r => r.ex === l && /^Last heavy/.test(r.notes)).out; }); return o; };
  check("the super heavy lifter stops every lift earlier than the regular one", LIFTS.every(l => h("heavy")[l] > h("regular")[l]));
  check("the novice or female lifter keeps every lift heavy later", LIFTS.every(l => h("light")[l] < h("regular")[l]));
  check("regular: squat and deadlift 7-10 days out, bench inside the last week",
    h("regular").Squat >= 7 && h("regular").Squat <= 10 && h("regular").Deadlift >= 7 && h("regular").Deadlift <= 10 && h("regular").Bench < 7);
  w.taperReset();
  check("Clear empties the builder", $("tp-squat").value === "" && $("tp-type").value === "regular" && $("results").style.display === "none");

  console.log("\nInto Power Logs");
  const app = boot("app.html", "https://example.github.io/power-logs/app.html");
  const aw = app.w, a$ = id => aw.document.getElementById(id);
  await new Promise(res => { if (aw.document.readyState === "complete") res(); else aw.addEventListener("load", res); setTimeout(res, 4000); });
  const csv = built.regular.cleanCSV.replace('"Smith, J"', "Taper Test");
  const input = a$("fileInput");
  Object.defineProperty(input, "files", { value: [new aw.File([csv], "taper.csv")], configurable: true });
  input.dispatchEvent(new aw.Event("change"));
  await tick(400);
  const prof = JSON.parse(aw.localStorage.getItem("spotter.profiles.v1"))["Taper Test"];
  check("the Clean CSV loads as a lifter with two weeks", !!prof && prof.weeks.length === 2 && prof.maxes.Squat === "200");
  check("Program notes show in the Overview", /TAPER · 2 weeks/.test(a$("viewOverview").textContent));
  check("rest days and the meet day come through", prof.weeks[1].days.some(d => d.rows.some(r => r.exercise === "Rest")) &&
    prof.weeks[1].days.some(d => String(d.day) === "6" && d.rows.some(r => r.exercise === "Meet day")));
  check("no script errors in either page", hub.real().length === 0 && app.real().filter(e => !/Chart is not defined/.test(e)).length === 0,
    hub.real().concat(app.real()).join(" | ").slice(0, 300));

  console.log(`\n${checks} checks · ${failures === 0 ? "ALL PASSED" : failures + " FAILED"}\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
