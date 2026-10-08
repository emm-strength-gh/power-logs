/* Coach's Analytics: the Weekly e1RM card. One row per week with the best estimated 1RM of each lift, the change from
 * the last week that had one, the best of them all, the Completed / Programmed switch and the formula.
 * Run: node test-coachweekly.js
 *
 * Like test-managelayout.js, boots the page as the owner through the stand-in cloud.
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
const MINUS = "−";

// Week 1: squat 160x4, bench 110x5, deadlift 200x3. Week 2: squat 165x4, bench 112.5x5. Week 3: squat 160x5, deadlift 205x3.
const CSV = "#Name,Weekly Tom\r\n#Block,B\r\nWeek,Day,Exercise,Weight (kg),Sets,Reps,RPE,Notes\r\n" +
  "1,1,Squat,160,4,4,7,\r\n1,1,Bench,110,4,5,7,\r\n1,2,Deadlift,200,3,3,8,\r\n" +
  "2,1,Squat,165,4,4,7.5,\r\n2,1,Bench,112.5,4,5,7.5,\r\n" +
  "3,1,Squat,160,4,5,8,\r\n3,2,Deadlift,205,3,3,8,\r\n";

(async () => {
  const errors = [];
  const dom = new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true,
    url: "https://example.github.io/spotter/app.html",
    virtualConsole: new VirtualConsole().on("jsdomError", e => errors.push(e.message)).on("error", m => errors.push(String(m))),
    beforeParse(w) {
      installCoach(w);
      w.Chart = class { static defaults = { font: {} }; constructor() {} destroy() {} };
    },
  });
  const w = dom.window, doc = w.document, $ = id => doc.getElementById(id);
  await new Promise(res => { if (doc.readyState === "complete") res(); else w.addEventListener("load", res); setTimeout(res, 4000); });
  const nav = label => { const b = [...doc.querySelectorAll("#sideNav .nav-item")].find(n => (n.querySelector(".nav-label") || {}).textContent.replace(/\s+/g, " ").trim().indexOf(label) === 0); if (b) b.click(); return !!b; };

  const input = $("fileInput");
  Object.defineProperty(input, "files", { value: [new w.File([CSV], "weekly.csv")], configurable: true });
  input.dispatchEvent(new w.Event("change"));
  await tick(400);

  // tick everything Done except Bench in week 2
  for (const wk of [1, 2, 3]) {
    nav("Week " + wk); await tick(100);
    [...$("wkList").querySelectorAll("li")].forEach(li => { if (!(wk === 2 && /Bench/.test(li.textContent))) li.click(); });
    await tick(100);
  }
  nav("Manage program"); await tick(150);
  $("dmAnalyticsBtn").click(); await tick(200);

  const table = () => [...$("cnWeekly").querySelectorAll("tbody tr")].map(r => [...r.children].map(c => c.textContent.replace(/\s+/g, " ").trim()));
  console.log("Completed sets (the default)");
  check("the card is there, under the Estimated 1RM card", /Weekly e1RM/.test($("cnWeekly").textContent) && $("viewCoachAn").contains($("cnWeekly")));
  check("the Completed sets switch is on", [...$("cnWeekly").querySelectorAll(".seg-btn")].find(b => b.classList.contains("active")).textContent === "Completed sets");
  check("the columns are Week, Squat, Bench and Deadlift", [...$("cnWeekly").querySelectorAll("thead th")].map(t => t.textContent).join() === "Week,Squat,Bench,Deadlift");
  let t = table();
  check("one row per week with a completed set, then Best", t.map(r => r[0]).join() === "Week 1,Week 2,Week 3,Best", t.map(r => r[0]).join());
  check("Week 1 has all three, with no change yet", t[0].slice(1).join("|") === "181.3|128.3|220", t[0].join("|"));
  check("Week 2: squat up 5.7; bench wasn't ticked, so none; no deadlift", t[1].slice(1).join("|") === `187+5.7|–|–`, t[1].join("|"));
  check("Week 3: squat down 0.3, and the deadlift is up 5.5 on week 1 (the last week that had one)", t[2].slice(1).join("|") === `186.7${MINUS}0.3|–|225.5+5.5`, t[2].join("|"));
  check("Best is the highest of each", t[3].slice(1).join("|") === "187|128.3|225.5", t[3].join("|"));
  check("a rise is green and a drop is red", !!$("cnWeekly").querySelector(".cn-up") && !!$("cnWeekly").querySelector(".cn-down"));

  console.log("\nProgrammed sets");
  [...$("cnWeekly").querySelectorAll(".seg-btn")].find(b => b.textContent === "Programmed sets").click(); await tick(50);
  t = table();
  check("every programmed set counts: week 2's bench appears, up 3 on week 1", t[1].slice(1).join("|") === `187+5.7|131.3+3|–`, t[1].join("|"));
  check("Best follows", t[3].slice(1).join("|") === "187|131.3|225.5", t[3].join("|"));
  check("the switch is on Programmed sets, and the card says so", /Every programmed set counts/.test($("cnWeekly").textContent));

  console.log("\nThe formula");
  const sel = [...$("dmAnControls").querySelectorAll("select")].find(s => [...s.options].some(o => o.value === "brzycki"));
  sel.value = "brzycki"; sel.dispatchEvent(new w.Event("change")); await tick(80);
  t = table();
  check("Brzycki redraws the card (squat 160 x 4 is 174.5)", t[0][1] === "174.5" && /Brzycki/.test($("cnWeekly").textContent), t[0].join("|"));
  check("...and the switch stays where it was", [...$("cnWeekly").querySelectorAll(".seg-btn")].find(b => b.classList.contains("active")).textContent === "Programmed sets");
  sel.value = "epley"; sel.dispatchEvent(new w.Event("change")); await tick(50);

  console.log("\nNothing completed");
  // untick every set in the week views, then come back
  for (const wk of [1, 2, 3]) {
    nav("Week " + wk); await tick(100);
    [...$("wkList").querySelectorAll("li")].forEach(li => { if (/\bdone\b/.test(li.className)) li.click(); });
    await tick(100);
  }
  nav("Manage program"); await tick(150);
  $("dmAnalyticsBtn").click(); await tick(200);
  [...$("cnWeekly").querySelectorAll(".seg-btn")].find(b => b.textContent === "Completed sets").click(); await tick(50);
  check("with no set ticked Done, a plain message replaces the table", /No completed sets yet/.test($("cnWeekly").textContent) && !$("cnWeekly").querySelector("table"), $("cnWeekly").textContent.slice(0, 160));
  [...$("cnWeekly").querySelectorAll(".seg-btn")].find(b => b.textContent === "Programmed sets").click(); await tick(50);
  check("...while the programmed sets still show", !!$("cnWeekly").querySelector("table") && table().length === 4);

  const real = errors.filter(e => !/Not implemented|HTMLCanvasElement|getContext|Chart is not defined/i.test(e));
  check("no script errors", real.length === 0, real.join(" | ").slice(0, 300));
  console.log(`\n${checks} checks · ${failures === 0 ? "ALL PASSED" : failures + " FAILED"}\n`);
  w.close();
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
