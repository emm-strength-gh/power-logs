/* Rearranging lifters in the dropdown: the sheet, the picker entry, persistence.
 * Run: node test-lifterorder.js
 */
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const html = fs.readFileSync(path.join(__dirname, "app.html"), "utf8");
let failures = 0, checks = 0;
const check = (name, cond, extra = "") => {
  checks++;
  if (!cond) failures++;
  console.log(`${cond ? "  ok  " : " FAIL "} ${name}${extra && !cond ? " — " + extra : ""}`);
};
const REARRANGE = "__spotter_rearrange__";
const ORDER_KEY = "spotter.lifterOrder.v1";

/* seed: optional { key: value } written to localStorage before the page's scripts run */
async function boot(seed) {
  const errors = [];
  const dom = new JSDOM(html, {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    url: "https://example.github.io/spotter/app.html",
    virtualConsole: new VirtualConsole()
      .on("jsdomError", e => errors.push(e.message))
      .on("error", m => errors.push(String(m))),
    beforeParse(w) { for (const [k, v] of Object.entries(seed || {})) w.localStorage.setItem(k, v); },
  });
  const w = dom.window;
  await new Promise(res => { if (w.document.readyState === "complete") res(); else w.addEventListener("load", res); setTimeout(res, 4000); });
  return { w, $: id => w.document.getElementById(id), errors };
}
const csv = (name, block) => `#Name,${name}\r\n#Block,${block}\r\nWeek,Day,Exercise,Weight (kg),Sets,Reps,RPE,Notes\r\n1,1,Squat,100,3,5,7,\r\n`;
async function load(app, name, block) {
  const input = app.$("fileInput");
  Object.defineProperty(input, "files", { value: [new app.w.File([csv(name, block || "B")], name + ".csv", { type: "text/csv" })], configurable: true });
  input.dispatchEvent(new app.w.Event("change"));
  for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 50));
}
const options = app => [...app.$("lifterSelect").options].map(o => o.value);
const rows = app => [...app.$("orderList").querySelectorAll(".lo-row")].map(r => r.getAttribute("data-rid"));
const stored = app => JSON.parse(app.w.localStorage.getItem(ORDER_KEY) || "null");
const moveBtn = (app, name, dir) => [...app.$("orderList").querySelectorAll(".lo-row")]
  .find(r => r.getAttribute("data-rid") === name).querySelector(`.lo-mv[data-dir="${dir}"]`);
const pickRearrange = app => {
  const sel = app.$("lifterSelect");
  sel.value = REARRANGE;
  sel.dispatchEvent(new app.w.Event("change"));
};

(async () => {
  const app = await boot();
  check("boots with no script errors", app.errors.filter(e => !/Not implemented|HTMLCanvasElement|getContext|Chart is not defined/i.test(e)).length === 0,
    app.errors.join(" | ").slice(0, 300));

  console.log("\nOne lifter: nothing to arrange");
  await load(app, "Ava", "Block 1");
  check("no Rearrange entry in the dropdown", !options(app).includes(REARRANGE), options(app).join(","));
  check("sidebar button hidden", app.$("orderBtn").style.display === "none");

  console.log("\nThree lifters, in load order");
  await load(app, "Ben", "Block 3");
  await load(app, "Cal", "Block 7");
  check("dropdown lists them in load order, then Rearrange", options(app).join(",") === `Ava,Ben,Cal,${REARRANGE}`, options(app).join(","));
  check("Rearrange entry is labelled", /Rearrange lifters/.test(app.$("lifterSelect").options[3].textContent));
  check("sidebar button shown", app.$("orderBtn").style.display === "");
  const before = app.$("lifterSelect").value;

  console.log("\nOpening the sheet from the dropdown");
  pickRearrange(app);
  check("sheet opens", app.$("orderScrim").classList.contains("show"));
  check("dropdown goes back to the current lifter", app.$("lifterSelect").value === before, app.$("lifterSelect").value);
  check("sheet lists every lifter in order", rows(app).join(",") === "Ava,Ben,Cal", rows(app).join(","));
  check("each row has a drag handle", app.$("orderList").querySelectorAll(".lo-row .dm-grip").length === 3);
  check("first row can't move up, last can't move down", moveBtn(app, "Ava", "up").disabled && moveBtn(app, "Cal", "down").disabled);
  check("current lifter is marked", !!app.$("orderList").querySelector('.lo-row[data-rid="' + before + '"] .lo-cur'));

  console.log("\nMoving with the arrows");
  moveBtn(app, "Ava", "down").click();
  check("sheet reorders", rows(app).join(",") === "Ben,Ava,Cal", rows(app).join(","));
  check("dropdown follows", options(app).join(",") === `Ben,Ava,Cal,${REARRANGE}`, options(app).join(","));
  check("order saved to this device", JSON.stringify(stored(app)) === '["Ben","Ava","Cal"]', JSON.stringify(stored(app)));
  check("current lifter unchanged", app.$("lifterSelect").value === before, app.$("lifterSelect").value);
  check("focus stays on the moved row", app.w.document.activeElement === moveBtn(app, "Ava", "down"));
  moveBtn(app, "Cal", "up").click();
  moveBtn(app, "Cal", "up").click();
  check("a row can go all the way to the top", rows(app).join(",") === "Cal,Ben,Ava", rows(app).join(","));
  check("says it saved", app.$("orderSaved").textContent === "Saved");
  app.$("orderDone").click();
  check("Done closes the sheet", !app.$("orderScrim").classList.contains("show"));

  console.log("\nNew and re-imported lifters");
  await load(app, "Dee", "Block 8");
  check("a newly loaded lifter goes to the end", options(app).slice(0, 4).join(",") === "Cal,Ben,Ava,Dee", options(app).join(","));
  await load(app, "Ben", "Block 3 Nats");
  check("re-importing a lifter keeps its place", options(app).slice(0, 4).join(",") === "Cal,Ben,Ava,Dee", options(app).join(","));
  check("...and shows its new block", app.$("lifterSelect").options[1].textContent === "Ben · Block 3 Nats", app.$("lifterSelect").options[1].textContent);

  console.log("\nSidebar button and Escape");
  app.$("orderBtn").click();
  check("sidebar button opens the sheet", app.$("orderScrim").classList.contains("show") && rows(app).length === 4);
  app.w.document.dispatchEvent(new app.w.KeyboardEvent("keydown", { key: "Escape" }));
  check("Escape closes it", !app.$("orderScrim").classList.contains("show"));

  console.log("\nSurvives a reload");
  const again = await boot({
    "spotter.profiles.v1": app.w.localStorage.getItem("spotter.profiles.v1"),
    [ORDER_KEY]: app.w.localStorage.getItem(ORDER_KEY),
  });
  check("dropdown order restored", options(again).slice(0, 4).join(",") === "Cal,Ben,Ava,Dee", options(again).join(","));
  check("with no last-used lifter, the first in your order opens", again.$("lifterSelect").value === "Cal", again.$("lifterSelect").value);
  const junk = await boot({ "spotter.profiles.v1": app.w.localStorage.getItem("spotter.profiles.v1"), [ORDER_KEY]: '{"not":"a list"}' });
  check("a corrupt saved order falls back to load order", options(junk).slice(0, 4).join(",") === "Ava,Ben,Cal,Dee", options(junk).join(","));
  const stale = await boot({ "spotter.profiles.v1": app.w.localStorage.getItem("spotter.profiles.v1"), [ORDER_KEY]: '["Nobody","Dee"]' });
  check("unknown names are skipped, the rest follow in load order", options(stale).slice(0, 4).join(",") === "Dee,Ava,Ben,Cal", options(stale).join(","));

  console.log("\nUnload everything");
  app.$("unloadBtn").click();
  await new Promise(r => setTimeout(r, 50));
  app.$("confirmYes").click();
  await new Promise(r => setTimeout(r, 50));
  check("saved order is cleared", app.w.localStorage.getItem(ORDER_KEY) === null);
  await load(app, "Zed", "Block 1");
  await load(app, "Amy", "Block 2");
  check("a fresh start uses load order again", options(app).join(",") === `Zed,Amy,${REARRANGE}`, options(app).join(","));

  console.log(`\n${checks} checks · ${failures === 0 ? "ALL PASSED" : failures + " FAILED"}\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
