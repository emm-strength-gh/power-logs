/* Manage Program's Manage tab: section order, and every action still working
 * from its new place (add exercise, days & weeks, import, replace/merge, clear).
 * Run: node test-managelayout.js
 *
 * Manage Program is for coaches; like test-dmnotes.js, this boots the page signed
 * in as the owner through the stand-in cloud in test-cloudfake.js.
 */
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");
const { installCoach } = require("./test-cloudfake");
const html = fs.readFileSync(path.join(__dirname, "power-logs.html"), "utf8");
let failures = 0, checks = 0;
const check = (name, cond, extra = "") => {
  checks++;
  if (!cond) failures++;
  console.log(`${cond ? "  ok  " : " FAIL "} ${name}${extra && !cond ? " — " + extra : ""}`);
};
const tick = (ms = 50) => new Promise(r => setTimeout(r, ms));

(async () => {
  const errors = [];
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    url: "https://example.github.io/spotter/power-logs.html",
    virtualConsole: new VirtualConsole()
      .on("jsdomError", e => errors.push(e.message))
      .on("error", m => errors.push(String(m))),
    beforeParse(w) {
      installCoach(w);
      // jsdom has no canvas: a stand-in that records which charts get drawn and freed.
      w.__charts = [];
      w.Chart = class { static defaults = { font: {} }; constructor(c, cfg) { this.id = c.id; this.cfg = cfg; this.alive = true; this.inCharts = !!c.closest("#dmCharts"); this.inAn = !!c.closest("#dmAnBody"); w.__charts.push(this); } destroy() { this.alive = false; } };
    },
  });
  const w = dom.window, doc = w.document, $ = id => doc.getElementById(id);
  await new Promise(res => { if (doc.readyState === "complete") res(); else w.addEventListener("load", res); setTimeout(res, 4000); });
  const real = () => errors.filter(e => !/Not implemented|HTMLCanvasElement|getContext|Chart is not defined/i.test(e));
  check("boots with no script errors", real().length === 0, real().join(" | ").slice(0, 300));

  const NAME = "Layout Lifter";
  const mk = (name, weeks, days, ex) => {
    let s = `#Name,${name}\r\n#Block,B\r\nWeek,Day,Exercise,Weight (kg),Sets,Reps,RPE,Notes\r\n`;
    for (const wk of weeks) for (const d of days) ex.forEach(e => { s += `${wk},${d},${e},100,3,5,7,\r\n`; });
    return s;
  };
  async function loadInto(inputId, text, fname) {
    const input = $(inputId);
    Object.defineProperty(input, "files", { value: [new w.File([text], fname)], configurable: true });
    input.dispatchEvent(new w.Event("change"));
    await tick(400);
  }
  const body = () => $("dmBody");
  const caps = () => [...body().querySelectorAll(".dm-sec-cap")].map(c => c.textContent);
  const btn = (text, root) => [...(root || body()).querySelectorAll("button")].find(b => b.textContent.trim() === text);
  const rows = () => [...body().querySelectorAll(".dm-cmp-col.is-current .dm-preview .dm-row")];
  const where = () => (body().querySelector(".dm-cmp-col.is-current .dm-cmp-where") || {}).textContent;
  const prof = () => JSON.parse(w.localStorage.getItem("spotter.profiles.v1") || "{}")[NAME];
  async function confirmYes() { await tick(); $("confirmYes").click(); await tick(100); }
  async function openManage() {
    [...doc.querySelectorAll("#sideNav .nav-item")].find(n => /Manage program/.test(n.textContent)).click();
    await tick();
    await tick(50);
    return $("viewDayMgr").classList.contains("active");
  }

  await loadInto("fileInput", mk(NAME, [8, 9], [1, 2], ["Squat", "Bench"]), "lifter.csv");
  check("Manage Program opens", await openManage());

  console.log("\nThe two dialogs");
  const toolNames = [...$("dmTools").querySelectorAll(".dm-tool b")].map(b => b.textContent);
  check("Sharing, Maxes and notes and Analytics sit in that order, left to right", toolNames.join() === "Sharing,Maxes and notes,Analytics", toolNames.join());
  check("each says what's in it", /Only on this device/.test($("dmShareBtn").textContent) && /Add your 1-rep maxes/.test($("dmMaxesBtn").textContent), $("dmShareBtn").textContent + " | " + $("dmMaxesBtn").textContent);
  check("both dialogs start closed", !$("shareScrim").classList.contains("show") && !$("maxesScrim").classList.contains("show"));
  $("dmShareBtn").click(); await tick(50);
  check("Sharing opens as a dialog for this lifter", $("shareScrim").classList.contains("show") && $("shareTitle").textContent === "Sharing" && $("shareFor").textContent === NAME);
  check("...with the upload prompt for a lifter only on this device", /Upload lifters to my account/.test($("dmShare").textContent));
  doc.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape" })); await tick(30);
  check("Escape closes it", !$("shareScrim").classList.contains("show"));
  $("dmMaxesBtn").click(); await tick(50);
  check("Maxes and notes opens as a dialog", $("maxesScrim").classList.contains("show") && $("maxesFor").textContent === NAME && !!$("dmMaxes").querySelector(".mn-grid"));
  const pos = (a, b) => !!(doc.getElementById(a).compareDocumentPosition(doc.getElementById(b)) & w.Node.DOCUMENT_POSITION_FOLLOWING);
  check("the note editor and confirmations open above these dialogs", pos("maxesScrim", "wkNoteScrim") && pos("shareScrim", "wkNoteScrim") && pos("maxesScrim", "confirmScrim") && pos("shareScrim", "confirmScrim"));
  $("maxesClose").click();
  check("the close button closes it", !$("maxesScrim").classList.contains("show"));

  console.log("\nAnalytics");
  const liveCharts = () => w.__charts.filter(c => c.alive);
  check("the tabs are Manage program, Warm up Calculator and Program Hub (Analytics moved)",
    [...$("dmTabs").querySelectorAll(".seg-btn")].map(b => b.textContent.trim()).join() === "Manage program,Warm up Calculator,Program Hub");
  check("the page itself no longer carries the program charts", !$("dmPaneManage").querySelector(".dm-charts") && !/Program charts/.test($("dmPaneManage").textContent) && !$("dmPaneAnalytics"));
  check("nothing is drawn until the dialog opens", liveCharts().length === 0 && !$("viewDayMgr").querySelector("canvas"));
  $("dmAnalyticsBtn").click(); await tick(100);
  const dlg = $("dmAnalyticsScrim");
  check("Analytics opens as a dialog for this lifter", dlg.classList.contains("show") && $("dmAnalyticsTitle").textContent === "Analytics" && $("dmAnalyticsFor").textContent === NAME);
  check("...with the program charts first", /Program charts/.test($("dmCharts").textContent) && /Number of lifts/.test($("dmCharts").textContent) && /Heaviest top set/.test($("dmCharts").textContent));
  check("...then the progression and load views", /Progression and load/.test(dlg.textContent) && $("dmAnBody").children.length > 0 && !!$("dmAnControls").querySelector(".seg"));
  const both = () => liveCharts().some(c => c.inCharts) && liveCharts().some(c => c.inAn);
  check("charts are drawn in both the program-charts part and the progression-and-load part", both(), liveCharts().map(c => (c.inCharts ? "charts" : "") + (c.inAn ? "an" : "")).join());
  // changing a control inside redraws in place
  const chartsBefore = w.__charts.length;
  [...$("dmCharts").querySelectorAll(".seg-btn")].find(b => b.textContent === "Daily").click(); await tick(50);
  check("switching a control redraws the dialog's charts in place", w.__charts.length > chartsBefore && dlg.classList.contains("show"));
  doc.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape" })); await tick(30);
  check("Escape closes it, and the charts are freed", !dlg.classList.contains("show") && liveCharts().length === 0, liveCharts().map(c => c.id).join());
  $("dmAnalyticsBtn").click(); await tick(60);
  check("it opens again with the charts back", both());
  $("dmAnalyticsClose").click();
  check("the close button closes it too", !dlg.classList.contains("show") && liveCharts().length === 0);

  console.log("\nLayout without an import");
  check("sections: the Lifter & program/block title card, then Edit a day and Import", caps().join(" | ") === "Edit a day | Import from another program" &&
    body().firstElementChild.classList.contains("dm-progcard"), caps().join(" | "));
  const progCard = body().querySelector(".dm-progcard");
  check("the card holds the lifter's name, block, Export CSV and Compare two programs",
    !!progCard && !!btn("Export CSV", progCard) && !!btn("Compare two programs", progCard) &&
    !!progCard.querySelector('input[aria-label="Lifter name"]') && !!progCard.querySelector('input[aria-label="Block or program title"]'));

  console.log("\nBodyweight");
  const bwIn = progCard.querySelector("#dmBodyweight");
  check("the card has a Bodyweight field, after the weight class", !!bwIn && bwIn.getAttribute("aria-label") === "Bodyweight in kg" && !!progCard.querySelector("#dmClass") && (progCard.querySelector("#dmClass").compareDocumentPosition(bwIn) & w.Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
  const storedBw = () => JSON.parse(w.localStorage.getItem("spotter.profiles.v1"))[NAME].bodyweight;
  bwIn.value = "83.5 kg"; bwIn.dispatchEvent(new w.Event("blur")); await tick(50);
  check("typing one saves it (a trailing kg is fine)", storedBw() === "83.5" && bwIn.value === "83.5", storedBw());
  bwIn.value = "5"; bwIn.dispatchEvent(new w.Event("blur")); await tick(50);
  check("an impossible one is refused and put back", storedBw() === "83.5" && bwIn.value === "83.5");
  bwIn.value = ""; bwIn.dispatchEvent(new w.Event("blur")); await tick(50);
  check("clearing it clears it", !storedBw());
  bwIn.value = "83.5"; bwIn.dispatchEvent(new w.Event("blur")); await tick(50);

  console.log("\nEdit program notes");
  const storedPN = () => JSON.parse(w.localStorage.getItem("spotter.profiles.v1"))[NAME].programNotes || "";
  check("the card has an Edit program notes button", !!btn("Edit program notes", progCard));
  btn("Edit program notes", progCard).click(); await tick(50);
  check("it opens the notes editor for the program notes", $("wkNoteScrim").classList.contains("show") && $("wkNoteTitle").textContent === "Program notes" && /Clear the text to erase/.test($("wkNoteSaved").textContent), $("wkNoteTitle").textContent);
  $("wkNoteArea").value = "== Goals ==\nPeak for nationals"; $("wkNoteArea").dispatchEvent(new w.Event("input"));
  $("wkNoteDone").click(); await tick(50);
  check("what is typed becomes the program notes", storedPN() === "== Goals ==\nPeak for nationals", storedPN());
  btn("Edit program notes", progCard).click(); await tick(50);
  check("it reopens with them, to change or erase", $("wkNoteArea").value === "== Goals ==\nPeak for nationals");
  $("wkNoteArea").value = ""; $("wkNoteArea").dispatchEvent(new w.Event("input"));
  $("wkNoteDone").click(); await tick(50);
  check("clearing the text erases them", storedPN() === "", storedPN());

  console.log("\nThe Lifter & program/block title card collapses");
  const progSub = () => progCard.querySelector(".pn-sub").textContent;
  check("it's titled Lifter & program/block title, and open to start with", progCard.querySelector(".pn-title").textContent === "Lifter & program/block title" && progCard.classList.contains("open"));
  check("collapsed or not, its header says whose program it is", progSub() === NAME + " · B", progSub());
  progCard.querySelector(".pn-toggle").click();
  check("the header collapses it", !progCard.classList.contains("open"));
  check("...and the choice is remembered", w.localStorage.getItem("spotter.dmProgramCollapsed") === "1");
  const blockIn = progCard.querySelector('input[aria-label="Block or program title"]');
  blockIn.value = "B2"; blockIn.dispatchEvent(new w.Event("blur")); await tick(50);
  check("changing the block updates the header too", progSub() === NAME + " · B2", progSub());
  [...doc.querySelectorAll("#sideNav .nav-item")].find(n => /Overview/.test(n.textContent)).click(); await tick(50);
  await openManage();
  check("it stays collapsed when you come back", !body().querySelector(".dm-progcard").classList.contains("open"));
  body().querySelector(".dm-progcard .pn-toggle").click();
  check("and opens again", body().querySelector(".dm-progcard").classList.contains("open") && w.localStorage.getItem("spotter.dmProgramCollapsed") === "0");
  console.log("\nWeight class");
  const clsIn = () => body().querySelector('.dm-progcard input[aria-label="Weight class in kg"]');
  const pill = () => (doc.querySelector("#sideTags .pill.cls") || {}).textContent || "";
  const profCls = () => JSON.parse(w.localStorage.getItem("spotter.profiles.v1"))[NAME].classWt;
  check("the card has a Weight class field, offering the IPF classes", !!clsIn() && clsIn().getAttribute("list") === "classOptions" && doc.querySelectorAll("#classOptions option").length === 16);
  clsIn().value = "74kg"; clsIn().dispatchEvent(new w.Event("blur")); await tick(50);
  check("'74kg' is saved as 74, and the sidebar pill follows", profCls() === "74" && pill() === "74kg" && clsIn().value === "74", profCls() + " / " + pill());
  clsIn().value = "120+"; clsIn().dispatchEvent(new w.Event("blur")); await tick(50);
  check("an open class keeps its +", profCls() === "120+" && pill() === "120+kg");
  clsIn().value = "heavy"; clsIn().dispatchEvent(new w.Event("blur")); await tick(50);
  check("something that isn't a class is refused, and the old one kept", profCls() === "120+" && clsIn().value === "120+");
  clsIn().value = ""; clsIn().dispatchEvent(new w.Event("blur")); await tick(50);
  check("blank clears it", profCls() === "" && !doc.querySelector("#sideTags .pill.cls"));
  const blockIn2 = body().querySelector('.dm-progcard input[aria-label="Block or program title"]');
  blockIn2.value = "B"; blockIn2.dispatchEvent(new w.Event("blur")); await tick(50);
  console.log("");
  check("one column, no replace/merge on screen", body().querySelectorAll(".dm-cmp-col").length === 1 && !/Replace|Merge/.test(body().textContent));
  check("old static Compare row is gone", !$("cmpOpenBtn"));

  console.log("\nAdd exercise, folded under the day");
  const addex = () => body().querySelector(".dm-addex");
  check("closed by default: just the + Add exercise button", !!addex() && !addex().classList.contains("open") && addex().querySelector(".dm-addex-toggle").textContent.trim() === "Add exercise");
  check("sits inside the day's panel, after its rows", !!body().querySelector(".dm-cmp-col.is-current .panel .dm-preview + .dm-addex"));
  addex().querySelector(".dm-addex-toggle").click();
  check("opens in place", addex().classList.contains("open"));
  const form = addex().querySelector(".dm-addform");
  const set = (sel, v) => { const i = form.querySelector(sel); i.value = v; i.dispatchEvent(new w.Event("input")); };
  set('input[aria-label="Exercise name"]', "Leg press");
  set('input[aria-label="Weight in kg"]', "100");
  set('input[aria-label="Sets"]', "3");
  set('input[aria-label="Reps"]', "10");
  set('input[aria-label^="RPE"]', "8");
  const before = rows().length;
  btn("Add to W8D1", form).click();
  await tick();
  check("adds the exercise to W8D1", rows().length === before + 1 && rows().some(r => /Leg press/.test(r.textContent)));
  check("form stays open for the next one", addex().classList.contains("open"));
  btn("Close", addex()).click();
  check("Close folds it away and remembers", !addex().classList.contains("open") && w.localStorage.getItem("spotter.dmAddOpen.v3") === "false");

  console.log("\nDays & weeks");
  const tools = () => body().querySelector(".dm-cmp-col.is-current .dm-struct");
  check("lives in the day editor, not with replace/merge", !!tools() && /Days & weeks/.test(tools().textContent));
  const dayNum = () => tools().querySelector('input[aria-label^="New day"]');
  dayNum().value = "5";
  btn("Add day", tools()).click();
  await tick();
  check("Add day adds and selects the new day", where() === "W8D5", where());
  const wkNum = tools().querySelector('input[aria-label^="New empty week"]');
  wkNum.value = "12";
  btn("Add week", tools()).click();
  await tick();
  check("Add week adds and selects the new week", (prof().weeks || []).some(x => String(x.week) === "12") && /Week 12/.test(tools().textContent));
  [...body().querySelectorAll(".dm-cmp-col.is-current select")][0].value = "9";
  [...body().querySelectorAll(".dm-cmp-col.is-current select")][0].dispatchEvent(new w.Event("change"));
  await tick();
  btn("Delete Day 1", tools()).click();
  await confirmYes();
  const wk9 = () => prof().weeks.find(x => String(x.week) === "9");
  check("Delete day removes it", wk9().days.length === 1, JSON.stringify(wk9().days.map(d => d.day)));
  const undo = body().querySelector(".dm-undo-btn");
  check("Undo is enabled beside Edit a day", !!undo && !undo.disabled);
  undo.click();
  await tick(100);
  check("Undo brings the day back", wk9().days.length === 2);

  console.log("\nImport, replace and merge");
  await loadInto("donorInput", mk("Donor", [1], [1, 2, 3], ["Pause squat", "Larsen press", "Row"]), "donor.csv");
  check("sections now include Use the imported program", caps().join(" | ") ===
    "Edit a day | Use the imported program | Imported program", caps().join(" | "));
  check("imported day shows beside the current one", body().querySelectorAll(".dm-cmp-col").length === 2);
  const swap = body().querySelector(".dm-swap");
  const swapRows = [...swap.querySelectorAll(".dm-swap-row")];
  check("all replace/merge buttons live in one card", swapRows.length === 2 &&
    body().querySelectorAll("button").length && [...body().querySelectorAll("button")].filter(b => /^(Replace|Merge)/.test(b.textContent)).every(b => swap.contains(b)));
  check("day row says what goes where", /Imported W1D1 → your W9D1/.test(swapRows[0].textContent), swapRows[0].textContent);
  check("week row says what goes where", /Imported Week 1 → your Week 9/.test(swapRows[1].textContent), swapRows[1].textContent);
  const n9d1 = () => wk9().days.find(d => String(d.day) === "1").rows.length;
  const beforeMerge = n9d1();
  btn("Merge into W9D1", swap).click();
  await confirmYes();
  check("Merge day appends the imported day", n9d1() === beforeMerge + 3, `${beforeMerge} -> ${n9d1()}`);
  btn("Replace Week 9", body().querySelector(".dm-swap")).click();
  await confirmYes();
  check("Replace week swaps in the imported week", wk9().days.length === 3 && wk9().days.every(d => d.rows.length === 3),
    JSON.stringify(wk9().days.map(d => d.rows.length)));
  const imp = [...body().querySelectorAll(".dm-sec")].find(s => /Imported program/.test(s.textContent));
  check("import controls together in one card", !!btn("Import a different program", imp) && !!btn("Build one in Program Hub", imp) && !!btn("Clear import", imp));
  btn("Clear import", imp).click();
  await tick();
  check("Clear import returns to one column", body().querySelectorAll(".dm-cmp-col").length === 1 && caps().indexOf("Use the imported program") === -1);

  console.log("\nCompare two programs");
  btn("Compare two programs", body()).click();
  await tick();
  check("opens the compare view", $("viewCompare").classList.contains("active"));

  check("no script errors along the way", real().length === 0, real().join(" | ").slice(0, 300));
  console.log(`\n${checks} checks · ${failures === 0 ? "ALL PASSED" : failures + " FAILED"}\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
