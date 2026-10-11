/* Manage Program's Edit Week: the week as text on a notepad page (written out when it has exercises, blank when it
 * has none), made into the week with Insert to current week.
 * Run: node test-weekedit.js
 *
 * Manage Program is for signed-in coaches; the page boots signed in as the
 * owner through the stand-in cloud in test-cloudfake.js.
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

// The coach's example of the format (day lines, a comma after each part, @ for RPE, notes last).
const SAMPLE = `day 1,
squat, @8, 1x1,
squat, 130, 2x5, back-off
squat, 125, 2x5, high bar
bench, 180, 2x5,
bench, @5, 3x4, spoto
leg press, @8, 3x15, this must be a single leg each set

day 2,
squat, @8, 1x1,
squat, 130, 2x5, back-off
squat, 125, 2x5, high bar
bench, 180, 2x5,
bench, @5, 3x4, spoto
leg press, @8, 3x15, this must be a single leg each set`;

(async () => {
  const errors = [];
  const dom = new JSDOM(html, {
    runScripts: "dangerously", pretendToBeVisual: true,
    url: "https://example.github.io/spotter/app.html",
    virtualConsole: new VirtualConsole().on("jsdomError", e => errors.push(e.message)).on("error", m => errors.push(String(m))),
    beforeParse(w) { installCoach(w); },
  });
  const w = dom.window, doc = w.document, $ = id => doc.getElementById(id);
  w.Element.prototype.scrollIntoView = function () {};
  w.scrollTo = function () {};
  await new Promise(res => { if (doc.readyState === "complete") res(); else w.addEventListener("load", res); setTimeout(res, 4000); });
  const real = () => errors.filter(e => !/Not implemented|HTMLCanvasElement|getContext|Chart is not defined/i.test(e));
  const CSV = `#Name,Tom\r\n#Block,Prep\r\nWeek,Day,Exercise,Weight (kg),Sets,Reps,RPE,Notes\r\n1,1,Squat,100,3,5,7,\r\n1,1,Bench,80,3,5,,paused\r\n2,1,Deadlift,180,3,3,8,\r\n`;
  const input = $("fileInput");
  Object.defineProperty(input, "files", { value: [new w.File([CSV], "tom.csv")], configurable: true });
  input.dispatchEvent(new w.Event("change"));
  await tick(400);
  const navTo = label => { const b = [...doc.querySelectorAll("#sideNav .nav-item")].find(n => (n.querySelector(".nav-label") || {}).textContent === label); if (b) b.click(); return !!b; };
  const prof = name => JSON.parse(w.localStorage.getItem("spotter.profiles.v1"))[name];
  const week = (n, name = "Tom") => prof(name).weeks.find(x => String(x.week) === String(n));
  const done = (name = "Tom") => JSON.parse(w.localStorage.getItem("spotter.done.v1") || "{}")[name] || {};
  const type = t => { $("weText").value = t; $("weText").dispatchEvent(new w.Event("input")); };
  const active = () => (doc.querySelector(".view.active") || {}).id;
  const f = r => [r.exercise, r.weight, r.sets, r.reps, r.rpe, r.notes].join("|");

  // Tick Week 1's squat, to see that it survives.
  navTo("Week 1"); await tick(150);
  $("wkList").querySelector("li").click(); await tick(100);
  const squatRid = week(1).days[0].rows[0].rid, benchRid = week(1).days[0].rows[1].rid;
  check("set-up: Week 1's squat is ticked Done", done()[squatRid] === true);

  console.log("\nThe button in Manage Program");
  navTo("Manage program"); await tick(150);
  const btn = $("dmWeekEditBtn");
  const sec = btn && btn.closest(".dm-sec");
  check("there is a big Edit Week button", !!btn && btn.textContent === "Edit Week" && btn.classList.contains("dm-weekedit-btn"));
  check("...below the Edit a day heading and above the week/day viewer",
    !!sec && /Edit a day/.test(sec.querySelector(".dm-cap-row").textContent) &&
    !!(sec.querySelector(".dm-cap-row").compareDocumentPosition(btn) & w.Node.DOCUMENT_POSITION_FOLLOWING) &&
    !!(btn.compareDocumentPosition(sec.querySelector(".dm-compare")) & w.Node.DOCUMENT_POSITION_FOLLOWING));

  console.log("\nA week with exercises opens written out");
  btn.click(); await tick(100);
  check("it opens its own page", active() === "viewWeekEdit");
  check("titled with the week", $("weTitle").textContent === "Edit Week 1" && /Week 1/.test($("weSub").textContent) && /Tom/.test($("weSub").textContent), $("weTitle").textContent);
  check("a notepad-style editor, a Back button and Insert to current week", $("weText").tagName === "TEXTAREA" && $("weText").classList.contains("we-pad") && /Back to Manage Program/.test($("weBack").textContent) && $("weInsert").textContent === "Insert to current week");
  check("the week is in the text, in the format, ready to edit", $("weText").value === "day 1,\nSquat, 100, 3x5, @7,\nBench, 80, 3x5, paused", JSON.stringify($("weText").value));
  check("...and counted", /1 day · 2 exercises/.test($("weStatus").textContent), $("weStatus").textContent);
  check("how to write it is there, folded away", !!doc.querySelector("#viewWeekEdit details.we-help") && !doc.querySelector("#viewWeekEdit details.we-help").open);
  check("Manage program stays lit in the menu", !!doc.querySelector("#sideNav .nav-item.active") && doc.querySelector("#sideNav .nav-item.active").textContent.includes("Manage program"));
  $("weBack").click(); await tick(100);
  check("Back with nothing changed goes straight back to Manage Program", active() === "viewDayMgr");

  console.log("\nEditing, adding and deleting");
  $("dmWeekEditBtn").click(); await tick(100);
  type("day 1,\nSquat, 100, 3x5, @7,\nBench, 85, 3x5, paused\nrow, 60, 3x10,\n\nday 2,\nsquat, @8, 1x1,\nleg press, @8, 3x15, single leg");
  $("weInsert").click(); await tick(150);
  check("Insert to current week goes back to Manage Program", active() === "viewDayMgr");
  let d1 = week(1).days[0].rows;
  check("day 1 is what's written: the edit and the added line", d1.map(f).join(" / ") === "Squat|100|3|5|7| / Bench|85|3|5||paused / row|60|3|10||", d1.map(f).join(" / "));
  check("lines still holding the same exercise keep their rows, so the tick stays", d1[0].rid === squatRid && d1[1].rid === benchRid && done()[squatRid] === true);
  check("a day that wasn't there is made", week(1).days.map(d => d.day + ":" + d.rows.length).join() === "1:3,2:2");
  check("Week 2 is untouched", week(2).days[0].rows.length === 1 && week(2).days[0].rows[0].exercise === "Deadlift");
  $("dmWeekEditBtn").click(); await tick(100);
  check("opening it again shows the week as it is now", $("weText").value === "day 1,\nSquat, 100, 3x5, @7,\nBench, 85, 3x5, paused\nrow, 60, 3x10,\n\nday 2,\nsquat, @8, 1x1,\nleg press, @8, 3x15, single leg", JSON.stringify($("weText").value));
  type($("weText").value.replace("Bench, 85, 3x5, paused\n", "").replace(/\n\nday 2,[\s\S]*$/, ""));
  $("weInsert").click(); await tick(150);
  d1 = week(1).days[0].rows;
  check("a line deleted from the text is gone from the week (and so is a deleted day)", d1.map(r => r.exercise).join() === "Squat,row" && week(1).days.length === 1, week(1).days.map(d => d.rows.map(r => r.exercise).join("/")).join(" | "));
  check("...the tick on the squat is still there", d1[0].rid === squatRid && done()[squatRid] === true);

  console.log("\nUndo");
  doc.querySelector(".dm-undo-btn").click(); await tick(150);
  check("one Undo puts the week back as it was before the last insert", week(1).days.map(d => d.rows.map(r => r.exercise).join("/")).join(" | ") === "Squat/Bench/row | squat/leg press" && done()[squatRid] === true);
  doc.querySelector(".dm-undo-btn").click(); await tick(150);
  check("...and again for the one before", week(1).days.length === 1 && week(1).days[0].rows.map(f).join(" / ") === "Squat|100|3|5|7| / Bench|80|3|5||paused");

  console.log("\nErasing everything");
  $("dmWeekEditBtn").click(); await tick(100);
  type("");
  $("weInsert").click(); await tick(100);
  check("an emptied page asks before emptying the week", $("confirmScrim").classList.contains("show") && /Empty Week 1/.test($("confirmTitle").textContent));
  $("confirmYes").click(); await tick(150);
  check("...and then the week has nothing in it", week(1).days.length === 0 && active() === "viewDayMgr");
  doc.querySelector(".dm-undo-btn").click(); await tick(150);
  check("...which Undo brings back", week(1).days[0].rows.length === 2 && done()[squatRid] === true);

  console.log("\nAn empty week opens blank");
  navTo("Lifters"); await tick(80);
  $("addLifterBtn").click(); await tick(80);
  $("nlName").value = "Sam";
  [...$("troFormBody").querySelectorAll("button")].find(b => b.textContent.trim() === "Create").click(); await tick(250);
  check("a new program (Week 1, Day 1, no exercises) is open in Manage Program", active() === "viewDayMgr" && week(1, "Sam").days.length === 1 && !week(1, "Sam").rows.length);
  $("dmWeekEditBtn").click(); await tick(100);
  check("its Edit Week starts as a blank page (no template, nothing filled in)", $("weText").value === "" && !$("weText").getAttribute("placeholder"), JSON.stringify($("weText").value));
  check("...saying nothing is written yet", /Nothing written yet/.test($("weStatus").textContent), $("weStatus").textContent);
  $("weInsert").click(); await tick(100);
  check("Insert with nothing written asks for a day", active() === "viewWeekEdit" && /at least one day/.test($("toastMsg").textContent));
  type(SAMPLE);
  check("the coach's example reads as 2 days, 12 exercises", /2 days · 12 exercises/.test($("weStatus").textContent) && !$("weStatus").classList.contains("bad"), $("weStatus").textContent);
  $("weInsert").click(); await tick(150);
  const s1 = week(1, "Sam"), r = s1.days[0].rows;
  check("the week becomes day 1 and day 2, six exercises each", s1.days.map(d => d.day + ":" + d.rows.length).join() === "1:6,2:6", s1.days.map(d => d.day + ":" + d.rows.length).join());
  check("“squat, @8, 1x1,” is squat, no weight, 1 x 1 at RPE 8", f(r[0]) === "squat||1|1|8|", f(r[0]));
  check("“squat, 130, 2x5, back-off” is 130 kg, 2 x 5, notes back-off", f(r[1]) === "squat|130|2|5||back-off", f(r[1]));
  check("“bench, 180, 2x5,” has no notes", f(r[3]) === "bench|180|2|5||", f(r[3]));
  check("“bench, @5, 3x4, spoto” is RPE 5 with notes", f(r[4]) === "bench||3|4|5|spoto", f(r[4]));
  check("the notes keep every word", r[5].notes === "this must be a single leg each set" && r[5].exercise === "leg press", f(r[5]));
  check("day 2 is read the same way", f(s1.days[1].rows[0]) === "squat||1|1|8|" && s1.days[1].rows.every(x => String(x.day) === "2" && String(x.week) === "1"));
  check("every line is a row of its own, and it's saved", new Set(s1.rows.map(x => x.rid)).size === 12);
  $("dmWeekEditBtn").click(); await tick(100);
  check("opened again, it now shows those exercises in the same format", /^day 1,\nsquat, @8, 1x1,\nsquat, 130, 2x5, back-off\n/.test($("weText").value) && /\n\nday 2,\n/.test($("weText").value), JSON.stringify($("weText").value.slice(0, 80)));

  console.log("\nRPE in other places, and parts written together");
  type("day 1,\nbench, 100, 2x5, @8, fast off the chest\ndeadlift @9, 1x3,\nrow, 60, 3x10 @7,\npress, 3x8,\nplank, 3x60, hold, then rest, 2 min");
  $("weInsert").click(); await tick(150);
  const r1 = week(1, "Sam").days[0].rows;
  check("@ after the sets and reps is the RPE", f(r1[0]) === "bench|100|2|5|8|fast off the chest", f(r1[0]));
  check("@ right after the exercise name works too", f(r1[1]) === "deadlift||1|3|9|", f(r1[1]));
  check("“3x10 @7” in one part is sets, reps and RPE", f(r1[2]) === "row|60|3|10|7|", f(r1[2]));
  check("no weight is fine", f(r1[3]) === "press||3|8||", f(r1[3]));
  check("notes may have commas of their own", r1[4].notes === "hold, then rest, 2 min", r1[4].notes);
  check("written out again, each line reads back the same", ($("dmWeekEditBtn").click(), await tick(100), $("weText").value === "day 1,\nbench, 100, 2x5, @8, fast off the chest\ndeadlift, @9, 1x3,\nrow, 60, 3x10, @7,\npress, 3x8,\nplank, 3x60, hold, then rest, 2 min"), JSON.stringify($("weText").value));

  console.log("\nMistakes");
  const beforeBad = JSON.stringify(week(1, "Sam"));
  type("squat, 100, 3x5,");
  check("a line before any day line is pointed out", $("weStatus").classList.contains("bad") && /Line 1: start with a day line/.test($("weStatus").textContent), $("weStatus").textContent);
  $("weInsert").click(); await tick(100);
  check("...and nothing is inserted until it's fixed", active() === "viewWeekEdit" && JSON.stringify(week(1, "Sam")) === beforeBad);
  type("day 1,\n@8, 3x5,");
  check("a line with no exercise is pointed out too", /Line 2: each line starts with the exercise/.test($("weStatus").textContent), $("weStatus").textContent);
  $("weBack").click(); await tick(100);
  check("leaving with changes asks first", $("confirmScrim").classList.contains("show") && /Leave without inserting/.test($("confirmTitle").textContent));
  $("confirmNo").click(); await tick(100);
  check("...Cancel stays on the page", active() === "viewWeekEdit");
  $("weBack").click(); await tick(50);
  $("confirmYes").click(); await tick(150);
  check("...Leave drops the changes", active() === "viewDayMgr" && JSON.stringify(week(1, "Sam")) === beforeBad);

  check("no script errors", real().length === 0, real().join(" | ").slice(0, 300));
  console.log(`\n${checks} checks · ${failures === 0 ? "ALL PASSED" : failures + " FAILED"}\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
