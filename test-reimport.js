/* Re-importing a lifter must keep what only Manage Program holds (training maxes),
 * while the CSV stays the source of truth for everything it carries (1-rep maxes).
 * Run: node test-reimport.js
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

  const NAME = "Test Lifter";
  const CSV = `#Name,${NAME}\r\n#Block,Block 1\r\n#Max,Squat,195\r\n#Max,Bench,160\r\n#Max,Deadlift,245\r\n` +
              `Week,Day,Exercise,Weight (kg),Sets,Reps,RPE,Notes\r\n1,1,Squat,150,3,5,7,\r\n`;
  async function loadFile(text, fname) {
    const input = $("fileInput");
    Object.defineProperty(input, "files", { value: [new w.File([text], fname)], configurable: true });
    input.dispatchEvent(new w.Event("change"));
    await tick(400);
  }
  const prof = () => (JSON.parse(w.localStorage.getItem("spotter.profiles.v1") || "{}"))[NAME] || {};
  const tms = () => JSON.stringify(prof().trainingMaxes || {});
  const navTo = label => {
    const b = [...doc.querySelectorAll("#sideNav .nav-item")].find(n => (n.querySelector(".nav-label") || {}).textContent === label);
    if (b) b.click();
  };
  async function openManage() {
    navTo("Manage program");
    await tick(100);
    $("dmMaxesBtn").click();          // the maxes live in a dialog
    await tick(50);
    return $("viewDayMgr").classList.contains("active") && $("maxesScrim").classList.contains("show");
  }
  const field = label => $("dmMaxes").querySelector(`input[aria-label="${label}"]`);
  async function setField(label, value) {
    const inp = field(label);
    inp.value = value;
    inp.dispatchEvent(new w.Event("blur"));
    await tick();
  }

  await loadFile(CSV, "lifter.csv");
  check("lifter loaded with the CSV's maxes", prof().maxes && prof().maxes.Squat === "195");

  console.log("\nTraining maxes set in Manage Program");
  check("Manage Program opens", await openManage());
  await setField("Squat training max in kg", "175");
  await setField("Bench training max in kg", "145");
  check("saved on the lifter", tms() === '{"Squat":"175","Bench":"145"}', tms());
  await setField("Squat max in kg", "205");
  check("1-rep max edited in the app too", prof().maxes.Squat === "205", prof().maxes.Squat);

  console.log("\nRe-importing the program CSV");
  navTo("Overview");
  await loadFile(CSV, "lifter.csv");
  check("training maxes survive the re-import", tms() === '{"Squat":"175","Bench":"145"}', tms());
  check("1-rep maxes still follow the CSV", prof().maxes.Squat === "195", prof().maxes.Squat);
  check("Manage Program shows them again", await openManage() &&
    field("Squat training max in kg").value === "175" && field("Bench training max in kg").value === "145",
    field("Squat training max in kg") && field("Squat training max in kg").value);

  console.log("\nJSON backups");
  let blob = null;
  w.URL.createObjectURL = b => { blob = b; return "blob:test"; };
  w.URL.revokeObjectURL = () => {};
  $("saveBtn").click();
  await tick();
  const backup = blob ? JSON.parse(await blob.text()) : {};
  check("backup carries the training maxes", JSON.stringify(backup.profile && backup.profile.trainingMaxes) === '{"Squat":"175","Bench":"145"}');
  const variant = mutate => { const b = JSON.parse(JSON.stringify(backup)); mutate(b); return JSON.stringify(b); };
  navTo("Overview");
  await loadFile(variant(b => { delete b.profile.trainingMaxes; }), "older.json");
  check("an older backup without them keeps the device's", tms() === '{"Squat":"175","Bench":"145"}', tms());
  await loadFile(variant(b => { b.profile.trainingMaxes = { Squat: "180" }; }), "newer.json");
  check("a backup that has them restores them as saved", tms() === '{"Squat":"180"}', tms());
  await loadFile(variant(b => { b.profile.trainingMaxes = {}; }), "cleared.json");
  check("a backup saved with none clears them", tms() === "{}", tms());

  console.log("\nA brand-new lifter");
  await loadFile(CSV.replace(`#Name,${NAME}`, "#Name,New Lifter"), "new.csv");
  const fresh = (JSON.parse(w.localStorage.getItem("spotter.profiles.v1") || "{}"))["New Lifter"] || {};
  check("starts with no training maxes", !fresh.trainingMaxes || Object.keys(fresh.trainingMaxes).length === 0, JSON.stringify(fresh.trainingMaxes));
  check("and doesn't borrow another lifter's", tms() === "{}" && JSON.stringify(fresh.trainingMaxes || {}) === "{}");

  check("no script errors along the way", real().length === 0, real().join(" | ").slice(0, 300));
  console.log(`\n${checks} checks · ${failures === 0 ? "ALL PASSED" : failures + " FAILED"}\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
