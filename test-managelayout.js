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
    beforeParse(w) { installCoach(w); },
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

  console.log("\nLayout without an import");
  check("sections: Program, Edit a day, Import, Sharing", caps().join(" | ") === "Program | Edit a day | Import from another program | Sharing", caps().join(" | "));
  const progCard = body().querySelector(".dm-sec .dm-card");
  check("Program card holds Export CSV and Compare two programs",
    !!btn("Export CSV", progCard) && !!btn("Compare two programs", progCard));
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
    "Program | Edit a day | Use the imported program | Imported program | Sharing", caps().join(" | "));
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
