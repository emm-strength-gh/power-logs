/* Manage Program's Notes card: one note per lifter, only visible to coaches.
 * Run: node test-dmnotes.js
 *
 * Manage Program is for signed-in coaches; the page boots signed in as the
 * owner through the stand-in cloud in test-cloudfake.js.
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

  const NAME = "Test Lifter";
  const CSV = `#Name,${NAME}\r\n#Block,Block 1\r\n# Program note from the CSV\r\nWeek,Day,Exercise,Weight (kg),Sets,Reps,RPE,Notes\r\n1,1,Squat,100,3,5,7,\r\n2,1,Squat,105,3,5,7.5,\r\n`;
  async function loadFile(text, fname) {
    const input = $("fileInput");
    Object.defineProperty(input, "files", { value: [new w.File([text], fname)], configurable: true });
    input.dispatchEvent(new w.Event("change"));
    await tick(400);
  }
  const navTo = label => {
    const b = [...doc.querySelectorAll("#sideNav .nav-item")].find(n => (n.querySelector(".nav-label") || {}).textContent === label);
    if (b) b.click();
    return !!b;
  };
  const card = () => $("dmMaxes").querySelector(".dmn-sec");
  const stored = () => JSON.parse(w.localStorage.getItem("spotter.dmNotes.v1") || "{}");
  const type = text => { $("wkNoteArea").value = text; $("wkNoteArea").dispatchEvent(new w.Event("input")); };

  await loadFile(CSV, "lifter.csv");
  check("lifter loaded", $("lifterSelect").value === NAME, $("lifterSelect").value);

  console.log("\nManage Program, signed in as a coach");
  check("sidebar has Manage program", navTo("Manage program"));
  await tick(100);
  check("Manage Program opens, no PIN", $("viewDayMgr").classList.contains("active"));

  console.log("\nThe Notes section");
  const titles = [...$("dmMaxes").querySelectorAll(".pn-title")].map(t => t.textContent);
  check("lives in the one Maxes and notes card, below the maxes", titles.join(" | ") === "Maxes and notes" && !!$("dmMaxes").querySelector(".mn-grid ~ .mn-hr + .dmn-sec"), titles.join(" | "));
  check("starts empty with an Add button", !card().querySelector(".dmn-text") && card().querySelector(".dmn-edit").textContent === "Add notes");
  card().querySelector(".dmn-edit").click();
  check("opens the notes sheet", $("wkNoteScrim").classList.contains("show"));
  check("sheet is titled Notes, for this lifter", $("wkNoteTitle").textContent === "Notes" && $("wkNoteFor").textContent === NAME,
    $("wkNoteTitle").textContent + " / " + $("wkNoteFor").textContent);
  const NOTE = "Goal: 200 squat\nKnee is fine now.\nVideo: https://example.com/clip, then rest";
  type(NOTE);
  check("saves as you type", stored()[NAME] === NOTE, JSON.stringify(stored()));
  check("says Saved", $("wkNoteSaved").textContent === "Saved");
  $("wkNoteDone").click();
  check("Done closes the sheet", !$("wkNoteScrim").classList.contains("show"));
  const box = card().querySelector(".dmn-text");
  check("card shows the note", !!box && box.textContent === NOTE, box && box.textContent);
  const a = box && box.querySelector("a");
  check("links are tappable (and stop before the comma)", !!a && a.getAttribute("href") === "https://example.com/clip" && a.target === "_blank",
    a && a.outerHTML);
  check("button now says Edit", card().querySelector(".dmn-edit").textContent === "Edit notes");
  box.click();
  check("tapping the note edits it, with the text loaded", $("wkNoteScrim").classList.contains("show") && $("wkNoteArea").value === NOTE);
  doc.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape" }));
  check("Escape closes the sheet", !$("wkNoteScrim").classList.contains("show"));

  console.log("\nNever outside Manage Program");
  check("Overview doesn't show it", navTo("Overview") && !$("viewOverview").textContent.includes("Goal: 200 squat"));
  check("Overview still shows the CSV's program notes", $("viewOverview").textContent.includes("Program note from the CSV"));
  navTo("Week 1");
  await tick();
  check("week page doesn't show it", $("viewWeek").classList.contains("active") && !$("viewWeek").textContent.includes("Goal: 200 squat"));

  console.log("\nWeekly notes still work (they share the editor)");
  $("wkNotesBtn").click();
  check("weekly editor is titled for the week", $("wkNoteTitle").textContent === "Weekly notes" && $("wkNoteFor").textContent === "Week 1",
    $("wkNoteTitle").textContent + " / " + $("wkNoteFor").textContent);
  check("and opens empty for this week", $("wkNoteArea").value === "");
  type("Deload feel this week");
  $("wkNoteDone").click();
  const wk = JSON.parse(w.localStorage.getItem("spotter.weekNotes.v1") || "{}");
  check("weekly note saved to its own store", wk[NAME] && wk[NAME]["1"] === "Deload feel this week", JSON.stringify(wk));
  check("...and shown on the week page", $("wkNotes").textContent.includes("Deload feel this week"));
  check("Manage Program note untouched", stored()[NAME] === NOTE);

  console.log("\nSurvives re-imports and backups");
  await loadFile(CSV, "lifter.csv");
  check("re-importing the program CSV keeps the note", stored()[NAME] === NOTE);
  let blob = null;
  w.URL.createObjectURL = b => { blob = b; return "blob:test"; };
  w.URL.revokeObjectURL = () => {};
  $("saveBtn").click();
  await tick();
  const backup = blob ? JSON.parse(await blob.text()) : {};
  check("Save progress (JSON) includes it", backup.manageNotes === NOTE, JSON.stringify(backup.manageNotes));
  backup.manageNotes = "Restored from a backup";
  await loadFile(JSON.stringify(backup), "backup.json");
  check("loading a backup restores it", stored()[NAME] === "Restored from a backup", JSON.stringify(stored()));
  delete backup.manageNotes;
  await loadFile(JSON.stringify(backup), "older-backup.json");
  check("an older backup without notes leaves them alone", stored()[NAME] === "Restored from a backup");

  console.log("\nClearing and unloading");
  navTo("Manage program");
  await tick(100);
  check("back in Manage Program", $("viewDayMgr").classList.contains("active"));
  card().querySelector(".dmn-edit").click();
  type("   ");
  $("wkNoteDone").click();
  check("an empty note is removed", !(NAME in stored()) && !card().querySelector(".dmn-text") && card().querySelector(".dmn-edit").textContent === "Add notes");
  card().querySelector(".dmn-edit").click();
  type("Back again");
  $("wkNoteDone").click();
  check("signed in, that button signs out instead", $("unloadLabel").textContent === "Sign out & clear device");
  $("unloadBtn").click();
  await tick(200);
  $("confirmYes").click();
  await tick(200);
  check("signing out keeps a lifter that was only on this device",
    JSON.parse(w.localStorage.getItem("spotter.dmNotes.v1") || "{}")[NAME] === "Back again");
  check("...and Manage program goes with the account", !navTo("Manage program"));
  $("unloadBtn").click();
  await tick();
  $("confirmYes").click();
  await tick();
  check("Unload everything clears the notes", w.localStorage.getItem("spotter.dmNotes.v1") === null);

  check("no script errors along the way", real().length === 0, real().join(" | ").slice(0, 300));
  console.log(`\n${checks} checks · ${failures === 0 ? "ALL PASSED" : failures + " FAILED"}\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
