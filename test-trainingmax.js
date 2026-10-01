/* Training maxes: default to 90% of the 1-rep maxes, 100/95/90/85/80% buttons,
 * hand-typed numbers still win.
 * Run: node test-trainingmax.js
 *
 * Signed in as a coach through the stand-in cloud (Manage Program is for coaches).
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
    runScripts: "dangerously", pretendToBeVisual: true,
    url: "https://example.github.io/power-logs/power-logs.html",
    virtualConsole: new VirtualConsole().on("jsdomError", e => errors.push(e.message)).on("error", m => errors.push(String(m))),
    beforeParse(w) { installCoach(w); },
  });
  const w = dom.window, doc = w.document, $ = id => doc.getElementById(id);
  w.Element.prototype.scrollIntoView = function () {};
  w.scrollTo = function () {};
  await new Promise(res => { if (doc.readyState === "complete") res(); else w.addEventListener("load", res); setTimeout(res, 4000); });
  const real = () => errors.filter(e => !/Not implemented|HTMLCanvasElement|getContext|Chart is not defined/i.test(e));
  check("boots with no script errors", real().length === 0, real().join(" | ").slice(0, 300));

  const NAME = "Test Lifter";
  const csv = (maxes) => `#Name,${NAME}\r\n#Block,B\r\n${maxes.map(([l, v]) => `#Max,${l},${v}\r\n`).join("")}Week,Day,Exercise,Weight (kg),Sets,Reps,RPE,Notes\r\n1,1,Squat,150,3,5,7,\r\n`;
  async function load(text, name = "t.csv") {
    const input = $("fileInput");
    Object.defineProperty(input, "files", { value: [new w.File([text], name)], configurable: true });
    input.dispatchEvent(new w.Event("change"));
    await tick(300);
  }
  const prof = () => JSON.parse(w.localStorage.getItem("spotter.profiles.v1"))[NAME];
  const nav = label => { const b = [...doc.querySelectorAll("#sideNav .nav-item")].find(n => (n.querySelector(".nav-label") || {}).textContent === label); if (b) b.click(); };
  const tm = lift => $("dmMaxes").querySelector(`input[aria-label="${lift} training max in kg"]`);
  const oneRm = lift => $("dmMaxes").querySelector(`input[aria-label="${lift} max in kg"]`);
  const vals = () => ["Squat", "Bench", "Deadlift"].map(l => tm(l).value).join(" / ");
  const chips = () => [...$("dmMaxes").querySelectorAll(".mx-pcts button")];
  const chip = pc => chips().find(b => b.textContent === pc + "%");
  const active = () => chips().filter(b => b.classList.contains("primary")).map(b => b.textContent).join();
  async function edit(inp, v) { inp.value = v; inp.dispatchEvent(new w.Event("blur")); await tick(80); }
  const sent = [];
  const lastHub = () => sent.filter(m => m.type === "spotter-lifter").slice(-1)[0] || {};

  /* ---------------------------------------------------------- no 1RMs */
  console.log("No 1-rep maxes");
  await load(csv([]));
  nav("Manage program"); await tick(100);
  check("Manage Program opens", $("viewDayMgr").classList.contains("active"));
  $("dmMaxesBtn").click(); await tick(50);
  check("the maxes open in a dialog", $("maxesScrim").classList.contains("show"));
  check("training maxes are empty too", vals() === " /  / ");
  check("the five buttons are 100, 95, 90, 85, 80 in that order", chips().map(b => b.textContent).join() === "100%,95%,90%,85%,80%");
  check("90% is the one selected", active() === "90%");
  check("nothing is stored for a default", !prof().trainingMaxes || Object.keys(prof().trainingMaxes).length === 0);

  /* ---------------------------------------------------------- default 90% */
  console.log("\nWith 1-rep maxes: 90% by default");
  await edit(oneRm("Squat"), "195"); await edit(oneRm("Bench"), "160"); await edit(oneRm("Deadlift"), "245");
  check("each is 90% of its 1RM", vals() === "175.5 / 144 / 220.5", vals());
  check("still nothing stored: they follow the 1RMs", !prof().trainingMaxes || Object.keys(prof().trainingMaxes).length === 0);
  check("the button on the page summarises the 1-rep maxes and the percentage", /1RM 195 · 160 · 245\s+Training maxes at 90%/.test($("dmMaxesBtn").querySelector(".dm-tool-tx span").textContent), $("dmMaxesBtn").textContent);
  check("they're marked as following the percentage", ["Squat", "Bench", "Deadlift"].every(l => tm(l).closest(".mn-cell").classList.contains("auto")));
  await edit(oneRm("Squat"), "200");
  check("changing a 1RM moves its training max with it", tm("Squat").value === "180", tm("Squat").value);
  await edit(oneRm("Deadlift"), "");
  check("clearing a 1RM clears its training max", tm("Deadlift").value === "" && tm("Squat").value === "180");
  await edit(oneRm("Deadlift"), "245");

  /* ---------------------------------------------------------- buttons */
  console.log("\nThe percentage buttons");
  const want = { 100: "200 / 160 / 245", 95: "190 / 152 / 233", 90: "180 / 144 / 220.5", 85: "170 / 136 / 208.5", 80: "160 / 128 / 196" };
  for (const pc of [100, 95, 85, 80, 90]) {
    chip(pc).click(); await tick(80);
    check(`${pc}% fills each training max`, vals() === want[pc], vals());
    check(`...and ${pc}% is the one selected`, active() === pc + "%", active());
  }
  chip(80).click(); await tick(80);
  check("the choice is saved on the lifter", prof().tmPct === 80);
  check("the summary names the percentage", /Training maxes at 80%/.test($("dmMaxesBtn").textContent));
  check("the 1-rep maxes themselves are untouched", oneRm("Squat").value === "200" && oneRm("Bench").value === "160" && oneRm("Deadlift").value === "245");
  [...doc.querySelectorAll("button")].find(b => b.id === "toastUndoBtn").click(); await tick(100);
  check("Undo goes back to the previous percentage", vals() === want[90] && active() === "90%", vals() + " / " + active());

  /* ---------------------------------------------------------- by hand */
  console.log("\nTyping your own numbers");
  await edit(tm("Squat"), "172.5");
  check("a typed number is kept", tm("Squat").value === "172.5" && prof().trainingMaxes.Squat === "172.5");
  check("...it's no longer marked as automatic, the others still are", !tm("Squat").closest(".mn-cell").classList.contains("auto") && tm("Bench").closest(".mn-cell").classList.contains("auto"));
  check("the others keep following the percentage", tm("Bench").value === "144" && tm("Deadlift").value === "220.5");
  await edit(oneRm("Squat"), "210");
  check("a typed number doesn't move when the 1RM does", tm("Squat").value === "172.5");
  await edit(oneRm("Squat"), "200");
  await edit(tm("Squat"), "");
  check("clearing a typed number goes back to the percentage", tm("Squat").value === "180" && !(prof().trainingMaxes || {}).Squat, tm("Squat").value);
  await edit(tm("Bench"), "150");
  await edit(tm("Deadlift"), "230");
  check("every lift can be typed", vals() === "180 / 150 / 230");
  chip(85).click(); await tick(80);
  check("a percentage button replaces the typed numbers", vals() === want[85] && Object.keys(prof().trainingMaxes || {}).length === 0, vals());
  [...doc.querySelectorAll("button")].find(b => b.id === "toastUndoBtn").click(); await tick(100);
  check("...and Undo brings them back, percentage and all", vals() === "180 / 150 / 230" && active() === "90%" && prof().trainingMaxes.Bench === "150", vals() + " / " + active());
  await edit(tm("Bench"), "abc");
  check("something that isn't a number is refused", tm("Bench").value === "150");

  /* ---------------------------------------------------------- other lifts */
  console.log("\nOther lifts");
  const addLift = async (name, max, trainingMax) => {
    $("dmMaxes").querySelector(".mn-add").click();
    $("dmMaxes").querySelector(".mn-newname").value = name;
    $("dmMaxes").querySelector(".mn-newmax").value = max;
    $("dmMaxes").querySelector(".mn-newtm").value = trainingMax;
    [...$("dmMaxes").querySelectorAll(".mn-addform button")].find(b => b.textContent === "Add lift").click();
    await tick(100);
  };
  const tmOf = name => $("dmMaxes").querySelector(`input[aria-label="${name} training max in kg"]`);
  check("the add form starts hidden and opens from Add another lift", $("dmMaxes").querySelector(".mn-addform").classList.contains("hidden") &&
    ($("dmMaxes").querySelector(".mn-add").click(), !$("dmMaxes").querySelector(".mn-addform").classList.contains("hidden")));
  $("dmMaxes").querySelector(".mn-add").click();
  await addLift("Squat equipped", "250", "");
  check("a 1RM for another lift gets a training max too", tmOf("Squat equipped").value === "225");
  check("...and the lift can be removed from its row", !!tmOf("Squat equipped").closest(".mn-grid").querySelector('button[aria-label="Remove Squat equipped"]'));
  await addLift("OHP", "", "80");
  check("a lift can be added with just a training max (e.g. OHP for Wendler)", tmOf("OHP") && tmOf("OHP").value === "80" && prof().trainingMaxes.OHP === "80");
  await addLift("Squat", "100", "");
  check("a lift that's already there is refused", /already a/.test($("toastMsg").textContent), $("toastMsg").textContent);
  await addLift("Pin squat", "", "");
  check("...and so is a lift with no numbers", /Enter a 1-rep max, a training max, or both/.test($("toastMsg").textContent), $("toastMsg").textContent);
  chip(95).click(); await tick(80);
  check("a percentage button leaves OHP alone (nothing to take a percentage of)", tmOf("OHP").value === "80");
  check("...and sets the others", tm("Squat").value === "190" && tmOf("Squat equipped").value === "237.5");
  $("dmMaxes").querySelector('button[aria-label="Remove OHP"]').click(); await tick(100);
  check("removing a lift takes its row away", !tmOf("OHP") && !(prof().trainingMaxes || {}).OHP);
  [...doc.querySelectorAll("button")].find(b => b.id === "toastUndoBtn").click(); await tick(100);
  check("...and Undo brings it back", tmOf("OHP") && tmOf("OHP").value === "80");
  $("dmMaxes").querySelector('button[aria-label="Remove OHP"]').click(); await tick(100);
  $("dmMaxes").querySelector('button[aria-label="Remove Squat equipped"]').click(); await tick(100);

  /* ---------------------------------------------------------- one card */
  console.log("\nOne dialog");
  check("the 1-rep maxes, training maxes and notes are one dialog", $("dmMaxes").querySelectorAll(".mn-grid").length === 1 && !!$("dmMaxes").querySelector(".dmn-sec"));
  check("...with a row per lift, 1-rep max beside training max", [...$("dmMaxes").querySelectorAll(".mn-lname")].map(n => n.textContent).join() === "Squat,Bench,Deadlift");
  chip(90).click(); await tick(80);
  await edit(tm("Squat"), "172.5");
  const reset = $("dmMaxes").querySelector('button[aria-label^="Put the Squat training max back"]');
  check("a typed training max has a back-arrow, the automatic ones don't", !!reset && !$("dmMaxes").querySelector('button[aria-label^="Put the Bench training max back"]'));
  reset.click(); await tick(100);
  check("the arrow puts it back on the percentage", tm("Squat").value === "180" && !(prof().trainingMaxes || {}).Squat && tm("Squat").closest(".mn-cell").classList.contains("auto"));
  [...doc.querySelectorAll("button")].find(b => b.id === "toastUndoBtn").click(); await tick(100);
  check("...and Undo brings the typed number back", tm("Squat").value === "172.5");
  $("maxesClose").click();
  check("the close button closes it", !$("maxesScrim").classList.contains("show"));
  check("the page keeps just the button, with the summary", !!$("dmMaxesBtn") && /Training maxes at 90%/.test($("dmMaxesBtn").textContent), $("dmMaxesBtn") && $("dmMaxesBtn").textContent);
  $("dmMaxesBtn").click(); await tick(50);
  check("...and it opens again with everything in it", $("maxesScrim").classList.contains("show") && !!tm("Squat") && !!$("dmMaxes").querySelector(".dmn-sec"));
  doc.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape" })); await tick(30);
  check("Escape closes it", !$("maxesScrim").classList.contains("show"));
  $("dmMaxesBtn").click(); await tick(50);
  check("an edit inside the dialog shows on the button behind it", (await edit(tm("Bench"), "151"), /Training maxes at 90%/.test($("dmMaxesBtn").textContent)) && tm("Bench").value === "151");
  await edit(tm("Bench"), "");

  /* ---------------------------------------------------------- hub + keeping it */
  console.log("\nProgram Hub, re-imports and backups");
  nav("Manage program");
  $("dmTabs").querySelector('[data-tab="hub"]').click(); await tick();
  const f = $("hubFrame");
  f.contentWindow.postMessage = m => sent.push(JSON.parse(JSON.stringify(m)));
  w.dispatchEvent(new w.MessageEvent("message", { data: { type: "spotter-hub-ready", features: ["send", "height", "theme", "prefill"] } }));
  check("the Hub is sent the training maxes as shown, defaults included",
    lastHub().trainingMaxes && lastHub().trainingMaxes.Squat === "172.5" && lastHub().trainingMaxes.Bench === "144" && lastHub().trainingMaxes.Deadlift === "220.5" && !("OHP" in lastHub().trainingMaxes),
    JSON.stringify(lastHub().trainingMaxes));
  $("dmTabs").querySelector('[data-tab="manage"]').click(); await tick(50);
  chip(80).click(); await tick(100);
  check("...and the new percentage goes straight over", lastHub().trainingMaxes.Squat === "160", JSON.stringify(lastHub().trainingMaxes));
  await load(csv([["Squat", "200"], ["Bench", "160"], ["Deadlift", "245"]]));
  check("re-importing the program keeps the percentage", prof().tmPct === 80);
  let blob = null;
  w.URL.createObjectURL = b => { blob = b; return "blob:t"; };
  w.URL.revokeObjectURL = () => {};
  $("saveBtn").click(); await tick();
  const backup = blob ? JSON.parse(await blob.text()) : {};
  check("a JSON backup carries it", backup.profile && backup.profile.tmPct === 80);
  delete backup.profile.tmPct;
  await load(JSON.stringify(backup), "older.json");
  check("an older backup without one keeps the device's", prof().tmPct === 80);
  backup.profile.tmPct = 95;
  await load(JSON.stringify(backup), "newer.json");
  check("a backup that has one restores it", prof().tmPct === 95);
  nav("Manage program"); await tick(100);
  check("...and the buttons show it", active() === "95%");

  check("no script errors", real().length === 0, real().join(" | ").slice(0, 300));
  console.log(`\n${checks} checks · ${failures === 0 ? "ALL PASSED" : failures + " FAILED"}\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
