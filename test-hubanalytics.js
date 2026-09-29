/* Program Hub analytics: every generated program gets Power Logs' three charts.
 * Run: node test-hubanalytics.js
 *
 * jsdom doesn't load Chart.js from the CDN, so both pages get a stand-in Chart
 * class that records what each chart was asked to draw. Parity: the Hub's
 * headline numbers must equal Power Logs' Analytics view for the same CSV.
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
const tick = (ms = 50) => new Promise(r => setTimeout(r, ms));
function boot(file, url) {
  const errors = [], charts = [];
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, file), "utf8"), {
    runScripts: "dangerously",
    pretendToBeVisual: true,
    url,
    virtualConsole: new VirtualConsole()
      .on("jsdomError", e => errors.push(e.message))
      .on("error", m => errors.push(String(m))),
    beforeParse(w) {
      // Power Logs sets Chart.defaults.font at boot, so the stand-in carries defaults too.
      w.Chart = class { static defaults = { font: {} }; constructor(canvas, cfg) { this.id = canvas.id; this.cfg = cfg; this.alive = true; charts.push(this); } destroy() { this.alive = false; } };
    },
  });
  dom.window.Element.prototype.scrollIntoView = function () {};
  dom.window.scrollTo = function () {};
  return { w: dom.window, charts, errors, real: () => errors.filter(e => !/Not implemented|HTMLCanvasElement|getContext/i.test(e)) };
}

(async () => {
  const hub = boot("program-hub.html", "https://example.github.io/power-logs/program-hub.html");
  const w = hub.w, $ = id => w.document.getElementById(id);
  const live = () => hub.charts.filter(c => c.alive);
  const byId = id => live().find(c => c.id === id);
  check("hub boots with no script errors", hub.real().length === 0, hub.real().join(" | ").slice(0, 300));

  const BUILDS = [
    { view: "gpop",     fn: "buildGpop",     f: { "gp-name": "Parity GenPop", "gp-squat": 195, "gp-bench": 160, "gp-dead": 245 } },
    { view: "cvbt",     fn: "buildCvbt",     f: { "cv-name": "Parity CVBT", "cv-squat": 205, "cv-bench": 165, "cv-dead": 242.5 } },
    { view: "gustav",   fn: "buildGustav",   f: { "in-name": "Parity Gustav", "in-squat": 205, "in-bench": 165, "in-deadlift": 242.5 } },
    { view: "combined", fn: "buildCombined", f: { "cb-name": "Parity SBD", "cb-squat": 205, "cb-bench": 165, "cb-dead": 242.5 } },
    { view: "wendler",  fn: "buildWendler",  f: { "w-name": "Parity Wendler", "w-squat": 200, "w-bench": 140, "w-deadlift": 240 } },
  ];
  const hubKpis = () => ({ ton: $("an-ton-kpi").textContent, nl: $("an-nl-kpi").textContent, top: $("an-top-kpi").textContent });
  const results = [];

  for (const b of BUILDS) {
    console.log(`\n${b.view}`);
    w.showView(b.view);
    for (const [id, v] of Object.entries(b.f)) $(id).value = String(v);
    w[b.fn]();
    check("builds and shows the analytics section", $("results").style.display === "block" && !$("an-wrap").hidden);
    check("all three charts drawn", !!byId("an-ton") && !!byId("an-nl") && !!byId("an-top") && live().length === 3, `${live().length} live`);
    const k = hubKpis();
    check("headline numbers filled in", k.ton !== "0" && k.nl !== "0" && k.top !== "–", JSON.stringify(k));
    check("top-set chart has a line per lift", byId("an-top").cfg.data.datasets.map(d => d.label).join(",") === "Squat,Bench,Deadlift");
    results.push({ b, kpis: k, csv: w.variantToCSV(w.activeVariant()) });
  }

  console.log("\nControls");
  w.showView("gpop");
  const perSession = byId("an-ton").cfg.data.labels.length;
  $("an-gran").querySelector('[data-g="weekly"]').click();
  const weekly = byId("an-ton").cfg.data.labels;
  check("Per week groups by week", weekly.length === 16 && weekly[0] === "W1" && perSession > weekly.length, `${perSession} -> ${weekly.length}`);
  check("same total either way", $("an-ton-kpi").textContent === results[0].kpis.ton);
  $("an-gran").querySelector('[data-g="daily"]').click();
  check("Per session again", byId("an-ton").cfg.data.labels.length === perSession && byId("an-ton").cfg.data.labels[0] === "W1D1");
  const segs = [...w.document.querySelectorAll("#seg button")].map(x => x.dataset.v);
  w.setVariant(segs[1]);
  check("switching variant re-charts it", $("an-sub").textContent.startsWith("Clean") && live().length === 3, $("an-sub").textContent);
  w.setVariant(segs[0]);
  const before = $("an-ton-kpi").textContent;
  const cell = w.document.querySelector('.cell-in[data-k="sets"]');
  cell.value = String(+cell.value + 5);
  cell.dispatchEvent(new w.Event("input", { bubbles: true }));
  await tick(600);
  check("editing Sets in the table updates the charts", $("an-ton-kpi").textContent !== before, before + " -> " + $("an-ton-kpi").textContent);
  const drawn = hub.charts.length;
  w.applyTheme("light");
  check("a theme change redraws them in the new colours", hub.charts.length === drawn + 3 && live().length === 3);
  w.gpopReset();
  check("clearing the builder leaves no stale charts behind", w.document.getElementById("results").style.display === "none");

  console.log("\nSame numbers as Power Logs");
  const app = boot("power-logs.html", "https://example.github.io/spotter/power-logs.html");
  const aw = app.w, a$ = id => aw.document.getElementById(id);
  await new Promise(res => { if (aw.document.readyState === "complete") res(); else aw.addEventListener("load", res); setTimeout(res, 4000); });
  for (const r of results) {
    const input = a$("fileInput");
    Object.defineProperty(input, "files", { value: [new aw.File([r.csv], r.b.view + ".csv")], configurable: true });
    input.dispatchEvent(new aw.Event("change"));
    await tick(400);
    [...aw.document.querySelectorAll("#sideNav .nav-item")].find(n => /Analytics/.test(n.textContent)).click();
    await tick(100);
    const pl = { ton: a$("anTonKpi").textContent, nl: a$("anNlKpi").textContent, top: a$("anTopKpi").textContent };
    check(`${r.b.view}: tonnage, number of lifts and top sets match Power Logs`, JSON.stringify(pl) === JSON.stringify(r.kpis),
      "hub " + JSON.stringify(r.kpis) + " vs power logs " + JSON.stringify(pl));
  }

  check("no script errors in either page", hub.real().length === 0 && app.real().length === 0, hub.real().concat(app.real()).join(" | ").slice(0, 300));
  console.log(`\n${checks} checks · ${failures === 0 ? "ALL PASSED" : failures + " FAILED"}\n`);
  process.exit(failures === 0 ? 0 : 1);
})();
