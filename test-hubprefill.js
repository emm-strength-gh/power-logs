/* Program Hub builders prefilled from the lifter loaded in Power Logs.
 * Run: node test-hubprefill.js
 *
 * Part 1 drives program-hub.html (embedded) with spotter-lifter messages.
 * Part 2 checks power-logs.html sends them, signed in as a coach through the
 * stand-in cloud in test-cloudfake.js (Manage Program is for coaches).
 */
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");
const { installCoach } = require("./test-cloudfake");

let failures = 0, checks = 0;
const check = (name, cond, extra = "") => {
  checks++;
  if (!cond) failures++;
  console.log(`${cond ? "  ok  " : " FAIL "} ${name}${extra && !cond ? " — " + extra : ""}`);
};
const tick = (ms = 50) => new Promise(r => setTimeout(r, ms));
function boot(file, url, setup) {
  const errors = [];
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, file), "utf8"), {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    url,
    virtualConsole: new VirtualConsole()
      .on("jsdomError", e => errors.push(e.message))
      .on("error", m => errors.push(String(m))),
    beforeParse(w) { if (setup) setup(w); },
  });
  dom.window.Element.prototype.scrollIntoView = function () {};
  dom.window.scrollTo = function () {};
  return { w: dom.window, errors, real: () => errors.filter(e => !/Not implemented|HTMLCanvasElement|getContext|Chart is not defined/i.test(e)) };
}

const SQUAT = ["in-squat", "w-squat", "e-rsquat", "sq-max", "cb-squat", "lb-squat", "ls-squat", "fm-squat", "cv-squat", "dm-squat", "gp-squat", "tp-squat"];
const BENCH = ["in-bench", "w-bench", "e-rbench", "bn-max", "b2-max", "ksb-max", "cb-bench", "ls-bench", "fm-bench", "cv-bench", "gp-bench", "tp-bench"];
const DEAD  = ["in-deadlift", "w-deadlift", "e-rdead", "d-max", "cb-dead", "lb-dead", "ls-dead", "fm-dead", "cv-dead", "dm-dead", "gp-dead", "tp-dead"];

(async () => {
  /* ------------------------------------------------------------ part 1: hub */
  console.log("Program Hub, embedded");
  const hub = boot("program-hub.html", "https://example.github.io/power-logs/program-hub.html?embed=1&theme=light");
  const w = hub.w, $ = id => w.document.getElementById(id);
  const send = (d, source) => w.dispatchEvent(new w.MessageEvent("message", { data: Object.assign({ type: "spotter-lifter" }, d), source: source === undefined ? w : source }));
  const vals = ids => ids.map(id => $(id).value);
  const all = (ids, v) => vals(ids).every(x => x === v);
  const typeInto = (id, v) => { $(id).value = v; $(id).dispatchEvent(new w.Event("input", { bubbles: true })); };
  const lifterInputs = suffix => [...w.document.querySelectorAll(`.view:not(#view-hub) input[id$="-${suffix}"]`)];
  check("hub boots embedded with no script errors", hub.real().length === 0, hub.real().join(" | ").slice(0, 300));
  check("announces the prefill feature", /features: \["send", "height", "theme", "prefill"\]/.test(fs.readFileSync(path.join(__dirname, "program-hub.html"), "utf8")));

  send({ name: "Test Lifter", block: "Block 9", cls: "74", bodyweight: "74kg",
         trainingMaxes: { Squat: "175", Bench: "145", Deadlift: "220", OHP: "80", "Squat equipped": "205" } });
  check("every builder's name filled (16)", lifterInputs("name").length === 16 && lifterInputs("name").every(i => i.value === "Test Lifter"));
  check("every builder's block filled", lifterInputs("block").every(i => i.value === "Block 9"));
  check("every builder's class filled", lifterInputs("class").every(i => i.value === "74"));
  check("squat fields take the squat training max", all(SQUAT, "175"), vals(SQUAT).join(","));
  check("bench fields take the bench training max", all(BENCH, "145"), vals(BENCH).join(","));
  check("deadlift fields take the deadlift training max", all(DEAD, "220"), vals(DEAD).join(","));
  check("Wendler's press takes an OHP training max", $("w-press").value === "80");
  check("an extra 'Squat equipped' max fills the equipped squat", $("e-esquat").value === "205" && $("e-ebench").value === "");
  check("bodyweight filled as a number", $("e-bw").value === "74", $("e-bw").value);
  check("Wendler and Massthetics use them as-is (TM 100%)", $("w-tm").value === "100" && $("dm-tm").value === "100", $("w-tm").value + " / " + $("dm-tm").value);
  const notes = [...w.document.querySelectorAll(".view:not(#view-hub) > .card .prefill-note")];
  check("each builder says where the numbers came from", notes.length === 16 && notes.every(n => !n.hidden && /Filled from Test Lifter/.test(n.textContent)));
  check("the two TM builders explain the 100%", /TM % is set to 100%/.test($("view-wendler").querySelector(".prefill-note").textContent) &&
    /TM % is set to 100%/.test($("view-mdl").querySelector(".prefill-note").textContent) &&
    !/TM %/.test($("view-gpop").querySelector(".prefill-note").textContent));

  console.log("\nTyped values are never overwritten");
  typeInto("gp-squat", "200");
  typeInto("gp-name", "Custom");
  send({ name: "Other", block: "", cls: "", trainingMaxes: { Squat: "150", Bench: "100" } });
  check("a typed max stays", $("gp-squat").value === "200");
  check("a typed name stays", $("gp-name").value === "Custom");
  check("untouched fields follow the new lifter", $("gp-bench").value === "100" && $("in-squat").value === "150" && $("cb-name").value === "Other");
  check("values the new lifter lacks are cleared, not left over", $("gp-dead").value === "" && $("in-block").value === "" && $("w-press").value === "");

  console.log("\nWendler / Massthetics TM %");
  typeInto("w-squat", "190");
  check("typing a Wendler max puts TM % back to 90", $("w-tm").value === "90");
  check("...and its note stops mentioning 100%", !/TM % is set to 100%/.test($("view-wendler").querySelector(".prefill-note").textContent));
  $("dm-tm").value = "85";
  $("dm-tm").dispatchEvent(new w.Event("change", { bubbles: true }));
  send({ name: "Other", trainingMaxes: { Squat: "150", Bench: "100", Deadlift: "210" } });
  check("a TM % chosen by hand is kept", $("dm-tm").value === "85");
  check("the typed Wendler max and its 90% stay", $("w-squat").value === "190" && $("w-tm").value === "90");

  console.log("\nNo training maxes / no lifter");
  send({ name: "No TMs", trainingMaxes: {} });
  check("filled maxes are cleared", $("cv-squat").value === "" && $("in-bench").value === "", $("cv-squat").value);
  check("the note says to add them in Manage Program", /No TMs has no training maxes yet/.test($("view-cvbt").querySelector(".prefill-note").textContent));
  send({ name: "Stranger" }, null);
  check("messages not from the host are ignored", $("cb-name").value === "No TMs");
  send({});
  check("with no lifter loaded, notes hide and filled names clear", notes.every(n => n.hidden) && $("cb-name").value === "" && $("gp-name").value === "Custom");

  console.log("\nBuilding from prefilled fields");
  send({ name: "Test Lifter", block: "Block 9", cls: "74", trainingMaxes: { Squat: "175", Bench: "145", Deadlift: "220" } });
  w.showView("combined");
  w.buildCombined();
  const csv = w.variantToCSV(w.activeVariant());
  check("a builder runs straight off the prefill", /^#Name,Test Lifter/m.test(csv) && /#Max,Squat,175/.test(csv) && /#Class,74/.test(csv), csv.split("\n").slice(0, 7).join(" / "));

  const solo = boot("program-hub.html", "https://example.github.io/power-logs/program-hub.html");
  solo.w.dispatchEvent(new solo.w.MessageEvent("message", { data: { type: "spotter-lifter", name: "Test Lifter", trainingMaxes: { Squat: "175" } }, source: solo.w }));
  check("opened on its own (not embedded), the Hub ignores it", solo.w.document.getElementById("gp-name").value === "" && solo.w.document.getElementById("gp-squat").value === "");

  /* ---------------------------------------------------- part 2: power logs */
  console.log("\nPower Logs sends the lifter");
  const app = boot("power-logs.html", "https://example.github.io/spotter/power-logs.html", installCoach);
  const aw = app.w, a$ = id => aw.document.getElementById(id);
  await new Promise(res => { if (aw.document.readyState === "complete") res(); else aw.addEventListener("load", res); setTimeout(res, 4000); });
  const input = a$("fileInput");
  Object.defineProperty(input, "files", { value: [new aw.File(["#Name,Test Lifter\r\n#Block,Block 9\r\n#Class,74\r\n#Bodyweight,74\r\nWeek,Day,Exercise,Weight (kg),Sets,Reps,RPE,Notes\r\n1,1,Squat,150,3,5,7,\r\n"], "t.csv")], configurable: true });
  input.dispatchEvent(new aw.Event("change"));
  await tick(400);
  [...aw.document.querySelectorAll("#sideNav .nav-item")].find(n => /Manage program/.test(n.textContent)).click();
  await tick(100);
  check("Manage Program opens", a$("viewDayMgr").classList.contains("active"));
  a$("dmMaxesBtn").click(); await tick(50);   // the maxes live in a dialog
  async function setTM(label, v) {
    const i = a$("dmMaxes").querySelector(`input[aria-label="${label}"]`);
    i.value = v; i.dispatchEvent(new aw.Event("blur")); await tick();
  }
  await setTM("Squat training max in kg", "175");
  await setTM("Bench training max in kg", "145");
  const sent = [];
  aw.document.querySelector('#dmTabs .seg-btn[data-tab="hub"]').click();
  await tick();
  const f = a$("hubFrame");
  check("opening the Program Hub tab loads it", !!f.getAttribute("data-src"));
  f.contentWindow.postMessage = m => sent.push(JSON.parse(JSON.stringify(m)));
  aw.dispatchEvent(new aw.MessageEvent("message", { data: { type: "spotter-hub-ready", features: ["send", "height", "theme", "prefill"] } }));
  const last = () => sent.filter(m => m.type === "spotter-lifter").slice(-1)[0] || {};
  check("replies to the Hub's ready with the lifter", last().name === "Test Lifter" && last().block === "Block 9" && last().cls === "74" && last().bodyweight === "74",
    JSON.stringify(last()));
  check("...carrying the training maxes", JSON.stringify(last().trainingMaxes) === '{"Squat":"175","Bench":"145"}', JSON.stringify(last().trainingMaxes));
  await setTM("Deadlift training max in kg", "220");
  check("a training-max edit is sent straight away", last().trainingMaxes && last().trainingMaxes.Deadlift === "220");
  const n = sent.length;
  aw.document.querySelector('#dmTabs .seg-btn[data-tab="manage"]').click();
  aw.document.querySelector('#dmTabs .seg-btn[data-tab="hub"]').click();
  check("re-opening the Hub tab re-sends", sent.length > n);

  check("no script errors in either page", hub.real().length === 0 && app.real().length === 0, hub.real().concat(app.real()).join(" | ").slice(0, 300));
  console.log(`\n${checks} checks · ${failures === 0 ? "ALL PASSED" : failures + " FAILED"}\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
