/* Meet Peak v2 · Gen Pop — generator checks, plus a real import into Power Logs.
 * Run: node test-genpop.js
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

function boot(file, url) {
  const errors = [];
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, file), "utf8"), {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    url,
    virtualConsole: new VirtualConsole()
      .on("jsdomError", e => errors.push(e.message))
      .on("error", m => errors.push(String(m))),
  });
  /* jsdom has no layout engine; these are not app bugs. */
  dom.window.Element.prototype.scrollIntoView = function () {};
  dom.window.scrollTo = function () {};
  return { dom, errors };
}

/* ------------------------------------------------------------ hub + builder */
const hub = boot("program-hub.html", "https://example.github.io/power-logs/program-hub.html");
const w = hub.dom.window, $ = id => w.document.getElementById(id);
check("hub boots with no script errors",
  hub.errors.filter(e => !/Not implemented/i.test(e)).length === 0, hub.errors.join(" | ").slice(0, 300));
check("hub card links to the builder", !!w.document.querySelector('.gen-card[data-go="gpop"]'));
check("builder view exists", !!$("view-gpop"));
{
  const hubN = (fs.readFileSync(path.join(__dirname, "program-hub.html"), "utf8").match(/build: "hub-(\d+)"/) || [])[1];
  const appN = (fs.readFileSync(path.join(__dirname, "app.html"), "utf8").match(/var HUB_BUILD = "(\d+)";/) || [])[1];
  check("hub's announced build matches app.html's HUB_BUILD", !!hubN && hubN === appN, `hub-${hubN} vs HUB_BUILD ${appN}`);
}

/* Reset first, so a refused build can't be mistaken for the previous one still on screen. */
function build(o) {
  w.showView("gpop");
  w.gpopReset();
  $("gp-name").value = o.name || "Gen Pop";
  $("gp-block").value = o.block || "";
  $("gp-class").value = o.cls || "";
  $("gp-squat").value = o.S == null ? "" : String(o.S);
  $("gp-bench").value = o.B == null ? "" : String(o.B);
  $("gp-dead").value = o.D == null ? "" : String(o.D);
  $("gp-bump").value = String(o.bump || 2.5);
  $("gp-acc").checked = o.acc !== false;
  w.buildGpop();
  if ($("results").style.display !== "block") return null;
  const out = {};
  for (const id of ["program", "clean"]) {
    w.setVariant(id);
    out[id] = parse(w.variantToCSV(w.activeVariant()));
  }
  w.setVariant("program");
  return out;
}
function parse(csv) {
  const lines = csv.split(/\r?\n/).filter(Boolean);
  const meta = lines.filter(l => l.startsWith("#"));
  const header = w.parseCSV(lines.find(l => /^Week,/.test(l)) + "\n")[0];
  const rows = lines.filter(l => /^\d/.test(l)).map(l => w.parseCSV(l + "\n")[0]);
  const H = n => header.indexOf(n);
  return {
    csv, meta, header,
    notes: meta.filter(l => l.startsWith("# ")).map(l => l.slice(2)),
    rows: rows.map(c => ({ week: +c[H("Week")], day: +c[H("Day")], ex: c[H("Exercise")], wt: c[H("Weight (kg)")],
                           sets: c[H("Sets")], reps: c[H("Reps")], rpe: c[H("RPE")], notes: c[H("Notes")], n: c.length })),
  };
}
const FAM = ex => /squat/i.test(ex) ? "S" : /deadlift/i.test(ex) ? "D" : /bench|larsen/i.test(ex) ? "B" : null;
const pctOf = notes => { const m = String(notes).match(/(\d+(?:\.\d+)?)%/); return m ? +m[1] : null; };
const r25 = x => Math.max(20, Math.round(x / 2.5) * 2.5);

/* ------------------------------------------------ reference build 195/160/245 */
console.log("\nReference build (195 / 160 / 245, 74kg)");
const MAX = { S: 195, B: 160, D: 245 };
const ref = build({ S: MAX.S, B: MAX.B, D: MAX.D, cls: "74kg" });
check("builds", !!ref);
if (ref) {
  const P = ref.program, rows = P.rows;
  check("header carries an RPE column", P.header.join(",") === "Week,Day,Exercise,Weight (kg),Sets,Reps,RPE,Notes", P.header.join(","));
  check("every row has 8 cells", rows.every(r => r.n === 8));
  const weeks = [...new Set(rows.map(r => r.week))];
  check("16 weeks", weeks.length === 16 && weeks[0] === 1 && weeks[15] === 16, weeks.join(","));
  let daysOk = true;
  for (let wk = 1; wk <= 16; wk++) {
    const days = [...new Set(rows.filter(r => r.week === wk).map(r => r.day))].sort().join("");
    if (days !== "1234") { daysOk = false; console.log(`       week ${wk} days ${days}`); }
  }
  check("every week has days 1-4", daysOk);
  check("#Max lines for all three lifts",
    ["Squat,195", "Bench,160", "Deadlift,245"].every(s => P.meta.some(m => m.startsWith("#Max," + s))));
  check("program notes written as '# ' lines (Power Logs shows these)", P.notes.length >= 10, `${P.notes.length}`);
  check("no quoted or double-quote-bearing note lines", P.meta.every(l => !l.startsWith('"')) && P.notes.every(n => !n.includes('"')));
  check("making-weight note uses the class limit", P.notes.some(n => /74 kg class/.test(n) && /76\.2/.test(n)));

  const main = rows.filter(r => FAM(r.ex));
  check("every main-lift row has an RPE", main.every(r => r.rpe !== ""), main.filter(r => r.rpe === "").map(r => `${r.week}/${r.day} ${r.ex}`).join(" | "));
  check("no AMRAP or failure sets in training (RPE <= 9 before meet day)",
    main.filter(r => !(r.week === 16 && r.day === 4)).every(r => +r.rpe <= 9));

  /* loads = pct x 1RM, rounded to 2.5, never under the bar */
  const bad = [];
  for (const r of main) {
    if (r.week === 16 && r.day === 4) continue;           // attempts are checked below
    const p = pctOf(r.notes); if (p == null) continue;
    const want = r25(MAX[FAM(r.ex)] * p / 100);
    if (Math.abs(+r.wt - want) > 1.3) bad.push(`${r.week}/${r.day} ${r.ex} ${r.wt} vs ${want} (${p}%)`);
  }
  check("every load = % x 1RM, rounded to 2.5kg", bad.length === 0, bad.slice(0, 4).join(" | "));

  /* balance: squat and deadlift get the same prescription, week by week */
  const sig = (wk, fam) => main.filter(r => r.week === wk && FAM(r.ex) === fam)
    .map(r => [pctOf(r.notes), r.sets, r.reps, r.rpe].join("/")).sort().join(" ");
  let mirror = true;
  for (let wk = 1; wk <= 14; wk++) if (sig(wk, "S") !== sig(wk, "D")) { mirror = false; console.log(`       week ${wk}: S ${sig(wk, "S")} | D ${sig(wk, "D")}`); }
  check("squat and deadlift mirror each other in weeks 1-14", mirror);
  const sets = fam => main.filter(r => FAM(r.ex) === fam && r.week <= 15).reduce((a, r) => a + (+r.sets || 0), 0);
  check("squat and deadlift weekly sets within 5% over weeks 1-15",
    Math.abs(sets("S") - sets("D")) / sets("S") <= 0.05, `S ${sets("S")} D ${sets("D")}`);
  check("bench trains three days a week in the build",
    [1, 2, 3, 4, 6, 7, 8, 9].every(wk => new Set(main.filter(r => r.week === wk && FAM(r.ex) === "B").map(r => r.day)).size === 3));

  /* attempts: third a PR, opener ~91% and second ~96% of it (Travis 2021) */
  for (const [L, name] of [["S", "Squat"], ["B", "Bench"], ["D", "Deadlift"]]) {
    const att = k => rows.find(r => r.week === 16 && r.day === 4 && r.ex === `${name} — ${k}`);
    const o = att("opener"), s = att("2nd attempt"), t = att("3rd attempt");
    const ok = o && s && t;
    check(`${name}: three attempts on meet day`, !!ok);
    if (!ok) continue;
    check(`${name}: 3rd attempt is a PR (${t.wt} > ${MAX[L]})`, +t.wt > MAX[L]);
    check(`${name}: opener < 2nd < 3rd`, +o.wt < +s.wt && +s.wt < +t.wt, `${o.wt} ${s.wt} ${t.wt}`);
    check(`${name}: opener ~91% and 2nd ~96% of the 3rd`,
      Math.abs(+o.wt - 0.91 * t.wt) <= 2.5 && Math.abs(+s.wt - 0.96 * t.wt) <= 2.5, `${o.wt} ${s.wt} ${t.wt}`);
    const reh = rows.find(r => r.week === 15 && r.ex === name && /Opener rehearsal/.test(r.notes));
    check(`${name}: week 15 rehearses the planned opener`, !!reh && reh.wt === o.wt, reh ? reh.wt : "none");
    const ladder = (o.notes.match(/warm-ups (.*)$/) || [])[1] || "";
    const kgs = ladder.split(", ").map(x => parseFloat(x));
    check(`${name}: warm-ups climb and stay under the opener`,
      kgs.length >= 4 && kgs.every((v, i) => i === 0 || v > kgs[i - 1]) && kgs[kgs.length - 1] < +o.wt, ladder);
  }
  const lastDay = fam => Math.max(...main.filter(r => FAM(r.ex) === fam && !(r.week === 16 && r.day === 4))
    .map(r => (r.week - 1) * 7 + [0, 1, 3, 5][r.day - 1]));
  const meet = 15 * 7 + 5;
  check("run-in: last pull 7, last squat 5, last bench 4 days out",
    meet - lastDay("D") === 7 && meet - lastDay("S") === 5 && meet - lastDay("B") === 4,
    `D ${meet - lastDay("D")} S ${meet - lastDay("S")} B ${meet - lastDay("B")}`);

  /* Clean: same rows and loads, no percentages anywhere */
  const C = ref.clean;
  check("clean has the same rows", C.rows.length === rows.length);
  check("clean keeps every load and RPE", C.rows.every((r, i) => r.wt === rows[i].wt && r.rpe === rows[i].rpe));
  check("clean row notes carry no percentages", C.rows.every(r => !/\d%/.test(r.notes)),
    (C.rows.find(r => /\d%/.test(r.notes)) || {}).notes);
  check("clean program notes carry no percentages", C.notes.every(n => !/%/.test(n)), C.notes.find(n => /%/.test(n)));
}

/* ------------------------------------------------------------------ options */
console.log("\nOptions and edge cases");
const noAcc = build({ S: 195, B: 160, D: 245, acc: false });
check("accessories off leaves only barbell work and the rest day",
  !!noAcc && noAcc.program.rows.every(r => FAM(r.ex) || r.ex === "Rest"));
const big = build({ S: 195, B: 160, D: 245, bump: 4 });
const third = (b, name) => +b.program.rows.find(r => r.ex === `${name} — 3rd attempt`).wt;
check("+4% target raises every third attempt",
  !!big && third(big, "Squat") >= 195 * 1.04 - 1.25 && third(big, "Bench") >= 160 * 1.04 - 1.25 && third(big, "Deadlift") >= 245 * 1.04 - 1.25);
const shw = build({ S: 280, B: 190, D: 320, cls: "120+" });
check("super-heavyweight class gets no making-weight note", !!shw && !shw.program.notes.some(n => /Making weight/.test(n)));
const noCls = build({ S: 150, B: 90, D: 180 });
check("blank class gets no making-weight note", !!noCls && !noCls.program.notes.some(n => /Making weight/.test(n)));
const small = build({ S: 60, B: 35, D: 80 });
check("light maxes build", !!small);
if (small) {
  const rows = small.program.rows.filter(r => FAM(r.ex));
  check("light maxes: no load under the 20kg bar", rows.every(r => r.wt === "" || +r.wt >= 20));
  for (const [name, max] of [["Squat", 60], ["Bench", 35], ["Deadlift", 80]]) {
    const a = k => +small.program.rows.find(r => r.ex === `${name} — ${k}`).wt;
    check(`light ${name}: attempts distinct and the 3rd a PR`, a("opener") < a("2nd attempt") && a("2nd attempt") < a("3rd attempt") && a("3rd attempt") > max,
      `${a("opener")} ${a("2nd attempt")} ${a("3rd attempt")}`);
  }
}
check("a missing max refuses to build", build({ S: 195, B: null, D: 245 }) === null && /20 kg/.test($("gp-msg").textContent));
check("a max under 20kg refuses to build", build({ S: 195, B: 15, D: 245 }) === null);

/* ------------------------------------------- real import into Power Logs */
console.log("\nImport into Power Logs (real parser)");
(async () => {
  const app = boot("app.html", "https://example.github.io/spotter/app.html");
  const aw = app.dom.window;
  await new Promise(res => { if (aw.document.readyState === "complete") res(); else aw.addEventListener("load", res); setTimeout(res, 4000); });
  const store = () => { try { return JSON.parse(aw.localStorage.getItem("spotter.profiles.v1") || "{}"); } catch (e) { return {}; } };
  async function importCSV(csv, fname) {
    const input = aw.document.getElementById("fileInput");
    Object.defineProperty(input, "files", { value: [new aw.File([csv], fname, { type: "text/csv" })], configurable: true });
    input.dispatchEvent(new aw.Event("change"));
    for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 50)); }
  }
  if (ref) {
    await importCSV(ref.program.csv, "gpop.csv");
    const p = store()["Gen Pop"];
    check("imports as its own lifter", !!p);
    if (p) {
      check("16 weeks after import", p.weeks.length === 16, `${p.weeks.length}`);
      check("four days in every week", p.weeks.every(wk => wk.days.length === 4), p.weeks.map(wk => wk.days.length).join(""));
      const n = p.weeks.reduce((a, wk) => a + wk.days.reduce((b, d) => b + d.rows.length, 0), 0);
      check("every row survives the import", n === ref.program.rows.length, `${n} vs ${ref.program.rows.length}`);
      check("maxes carried over", p.maxes && p.maxes.Squat === "195" && p.maxes.Bench === "160" && p.maxes.Deadlift === "245", JSON.stringify(p.maxes));
      check("program notes land in the Program notes card", (p.programNotes || "").split("\n").length === ref.program.notes.length,
        `${(p.programNotes || "").split("\n").length} vs ${ref.program.notes.length}`);
      const any = p.weeks[0].days[0].rows[0];
      check("RPE column read", any && any.rpe === "7", any && JSON.stringify(any));
    }
    await importCSV(ref.clean.csv.replace("#Name,Gen Pop", "#Name,Gen Pop Clean"), "gpop_clean.csv");
    const c = store()["Gen Pop Clean"];
    check("clean variant imports too", !!c && c.weeks.length === 16);
  }
  const src = fs.readFileSync(path.join(__dirname, "app.html"), "utf8");
  check("analytics treat paused deadlifts like pause squats (variations excluded)",
    /AN_EXCLUDED = \[[^\]]*"pause squat"[^\]]*"paused deadlift"/.test(src));

  console.log(`\n${checks} checks · ${failures === 0 ? "ALL PASSED" : failures + " FAILED"}\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
