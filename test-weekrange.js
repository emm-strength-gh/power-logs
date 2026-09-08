/* Week-range export controls — behaviour + regression across all 14 builders.
 * Run: node test-weekrange.js
 */
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const html = fs.readFileSync(path.join(__dirname, "program-hub.html"), "utf8");
let failures = 0, checks = 0;
const check = (name, cond, extra = "") => {
  checks++;
  if (!cond) failures++;
  console.log(`${cond ? "  ok  " : " FAIL "} ${name}${extra && !cond ? " — " + extra : ""}`);
};

const errors = [];
const dom = new JSDOM(html, {
  runScripts: "dangerously",
  pretendToBeVisual: true,
  url: "https://example.github.io/program-hub/program-hub.html",
  virtualConsole: new VirtualConsole()
    .on("jsdomError", e => errors.push(e.message))
    .on("error", m => errors.push(String(m))),
});
const { window } = dom;
const doc = window.document;
const $ = id => doc.getElementById(id);
/* jsdom has no layout engine; these are not app bugs. */
window.Element.prototype.scrollIntoView = function () {};
window.scrollTo = function () {};

const realErrors = errors.filter(e => !/Not implemented/i.test(e));
check("page boots with no script errors", realErrors.length === 0, realErrors.join(" | ").slice(0, 300));

/* -------------------------------------------------- markup + helpers exist */
console.log("\nControl is wired into the export phase");
check("#wk-range input exists", !!$("wk-range"));
check("#wk-range sits inside #results", !!$("results") && $("results").contains($("wk-range")));
check("#wk-range follows the export button in the DOM",
  $("wkpick").compareDocumentPosition($("btn-export")) & window.Node.DOCUMENT_POSITION_PRECEDING);
check("quick-pick host exists", !!$("wkpick-quick"));
check("scope readout exists", !!$("wkpick-note"));
["parseWeekSpec", "availableWeeks", "weeksLabel", "syncExportScope", "buildWkQuick"]
  .forEach(fn => check(`${fn}() defined`, typeof window[fn] === "function"));

/* ------------------------------------------------------------ weeksLabel() */
console.log("\nweeksLabel() collapses runs");
const wl = window.weeksLabel;
check("[3] -> 3", wl([3]) === "3", wl([3]));
check("[1,2,3,4] -> 1-4", wl([1, 2, 3, 4]) === "1-4", wl([1, 2, 3, 4]));
check("[1,2,3,4,7,9,10] -> 1-4, 7, 9-10",
  wl([1, 2, 3, 4, 7, 9, 10]) === "1-4, 7, 9-10", wl([1, 2, 3, 4, 7, 9, 10]));
check("[2,4,6] -> 2, 4, 6", wl([2, 4, 6]) === "2, 4, 6", wl([2, 4, 6]));

/* --------------------------------------------------------- parseWeekSpec() */
console.log("\nparseWeekSpec() against a 16-week block");
const A16 = Array.from({ length: 16 }, (_, i) => i + 1);
const P = s => window.parseWeekSpec(s, A16);
const listOf = s => { const r = P(s); return r.error ? "ERR:" + r.error : r.list.join(","); };

check("blank -> all weeks", P("").all === true && P("").list.length === 16);
check('"all" -> all weeks', P("all").all === true);
check("whitespace only -> all weeks", P("   ").all === true);
check("single week", listOf("7") === "7", listOf("7"));
check("simple range", listOf("1-4") === "1,2,3,4", listOf("1-4"));
check("spaces around the dash", listOf("1 - 4") === "1,2,3,4", listOf("1 - 4"));
check("en dash", listOf("1\u20134") === "1,2,3,4", listOf("1\u20134"));
check('"to"', listOf("1 to 4") === "1,2,3,4", listOf("1 to 4"));
check("double dots", listOf("1..4") === "1,2,3,4", listOf("1..4"));
check("mixed list", listOf("1-4, 7, 9-12") === "1,2,3,4,7,9,10,11,12", listOf("1-4, 7, 9-12"));
check("space separated list", listOf("3 5 8") === "3,5,8", listOf("3 5 8"));
check("reversed range normalises", listOf("12-9") === "9,10,11,12", listOf("12-9"));
check("open-ended '13-' runs to the end", listOf("13-") === "13,14,15,16", listOf("13-"));
check("open-start '-3' runs from the first week", listOf("-3") === "1,2,3", listOf("-3"));
check("duplicates collapse", listOf("3,3,2-4") === "2,3,4", listOf("3,3,2-4"));
check("full span is flagged as all", P("1-16").all === true);
check("partial span is not flagged as all", P("1-15").all === false);
check("out-of-range week is skipped, not fatal",
  !P("14-20").error && P("14-20").list.join(",") === "14,15,16" && P("14-20").unknown.join(",") === "17,18,19,20",
  JSON.stringify(P("14-20")));
check("all-out-of-range is an error", !!P("20-25").error, JSON.stringify(P("20-25")));
check("garbage is an error", !!P("abc").error, JSON.stringify(P("abc")));
check("half-typed 'week ' is an error not a crash", !!P("week 3").error);
check("zero is skipped", !!P("0").error, JSON.stringify(P("0")));
check("error messages name the offender", /abc/.test(P("abc").error || ""), P("abc").error);

/* -------------------------------------------------- per-builder round trip */
const BUILDERS = [
  { view: "gustav",   fn: "buildGustav",          weeks: 16, f: { "in-name": "T", "in-block": "B", "in-squat": 205, "in-bench": 165, "in-deadlift": 242.5 } },
  { view: "wendler",  fn: "buildWendler",         weeks: 12, f: { "w-name": "T", "w-block": "B", "w-squat": 200, "w-bench": 140, "w-deadlift": 240, "w-press": 90, "w-cycles": 3 } },
  { view: "equipped", fn: "buildEquipped",        weeks: 12, f: { "e-name": "T", "e-block": "B", "e-rsquat": 200, "e-rbench": 140, "e-rdead": 240, "e-esquat": 255, "e-ebench": 185, "e-edead": 260 } },
  { view: "deadlift", fn: "buildDeadlift",        weeks: 8,  f: { "d-name": "T", "d-block": "B", "d-max": 242.5 } },
  { view: "squat",    fn: "buildSquat",           weeks: 8,  f: { "sq-name": "T", "sq-block": "B", "sq-max": 205 } },
  { view: "bench",    fn: "buildBench",           weeks: 8,  f: { "bn-name": "T", "bn-block": "B", "bn-max": 165 } },
  { view: "bench2",   fn: "buildBench2",          weeks: 14, f: { "b2-name": "T", "b2-block": "B", "b2-max": 165 } },
  { view: "combined", fn: "buildCombined",        weeks: 8,  f: { "cb-name": "T", "cb-block": "B", "cb-squat": 205, "cb-bench": 165, "cb-dead": 242.5 } },
  { view: "ksb",      fn: "buildKsb",             weeks: 4,  f: { "ksb-name": "T", "ksb-block": "B", "ksb-max": 165 } },
  { view: "lilliebridge", fn: "buildLilliebridge", weeks: 14, f: { "lb-name": "T", "lb-block": "B", "lb-squat": 205, "lb-dead": 242.5 } },
  { view: "lilliesbd", fn: "buildLillieSBD",      weeks: 14, f: { "ls-name": "T", "ls-block": "B", "ls-squat": 205, "ls-bench": 165, "ls-dead": 242.5 } },
  { view: "fmgd",     fn: "buildFatigueManaged",  weeks: null, f: { "fm-name": "T", "fm-block": "B", "fm-squat": 180, "fm-bench": 130, "fm-dead": 210 } },
  { view: "cvbt",     fn: "buildCvbt",            weeks: 10, f: { "cv-name": "T", "cv-block": "B", "cv-squat": 205, "cv-bench": 165, "cv-dead": 242.5 } },
  { view: "mdl",      fn: "buildMdl",             weeks: 8,  f: { "dm-name": "T", "dm-block": "B", "dm-dead": 242.5, "dm-squat": 205 } },
];

/* rows of a CSV body, keyed by week */
function bodyWeeks(csv) {
  const out = [];
  for (const ln of csv.split(/\r?\n/)) {
    if (!ln.trim() || ln.startsWith("#") || /^week\s*,/i.test(ln)) continue;
    out.push(+ln.split(",")[0]);
  }
  return out;
}

let captured = null;
window.downloadBlob = (blob, fname) => { captured = { fname, size: blob.size }; };

for (const b of BUILDERS) {
  console.log(`\n${b.view}`);
  window.showView(b.view);
  for (const [id, v] of Object.entries(b.f)) $(id).value = String(v);
  window[b.fn]();

  const built = !!$("results") && $("results").style.display === "block";
  check("built", built);
  if (!built) continue;

  const avail = window.availableWeeks();
  const nWeeks = b.weeks == null ? avail.length : b.weeks;
  check(`week list is 1..${nWeeks}`,
    avail.length === nWeeks && avail[0] === 1 && avail[avail.length - 1] === nWeeks, avail.join(","));

  const variant = () => window.ctxVariantForTest ? window.ctxVariantForTest() : null;
  const full = window.variantToCSV(window.activeVariant());
  const fullRows = bodyWeeks(full);
  check("unfiltered export unchanged (all weeks present)",
    new Set(fullRows).size === nWeeks && fullRows.length > 0, `${fullRows.length} rows`);

  /* --- single week */
  const mid = Math.max(1, Math.ceil(nWeeks / 2));
  $("wk-range").value = String(mid);
  $("wk-range").dispatchEvent(new window.Event("input", { bubbles: true }));
  const one = bodyWeeks(window.variantToCSV(window.activeVariant(), new Set([mid])));
  check(`week ${mid} only`, one.length > 0 && one.every(w => w === mid), `${one.length} rows`);
  check("readout names the single week",
    $("wkpick-note").textContent.startsWith(`Week ${mid} ·`), $("wkpick-note").textContent);
  check("readout shows rows out of total",
    /\d+ of \d+ rows/.test($("wkpick-note").textContent), $("wkpick-note").textContent);
  check("export enabled", $("btn-export").disabled === false);
  captured = null; window.exportActive();
  check("filename carries the week", captured && captured.fname.includes(`_w${mid}.csv`),
    captured && captured.fname);

  /* --- a range */
  const hi = Math.min(nWeeks, mid + 2);
  $("wk-range").value = `${mid}-${hi}`;
  $("wk-range").dispatchEvent(new window.Event("input", { bubbles: true }));
  const span = new Set();
  for (let w = mid; w <= hi; w++) span.add(w);
  const rng = bodyWeeks(window.variantToCSV(window.activeVariant(), span));
  check(`weeks ${mid}-${hi}`, rng.length > 0 && rng.every(w => span.has(w)) &&
    new Set(rng).size === span.size, `${rng.length} rows / ${new Set(rng).size} weeks`);
  captured = null; window.exportActive();
  check("filename carries the range",
    captured && captured.fname.includes(mid === hi ? `_w${mid}.csv` : `_w${mid}-${hi}.csv`),
    captured && captured.fname);

  /* --- header + metadata survive filtering */
  const part = window.variantToCSV(window.activeVariant(), new Set([1]));
  const fullMeta = full.split(/\r?\n/).filter(l => l.startsWith("#"));
  const partMeta = part.split(/\r?\n/).filter(l => l.startsWith("#"));
  check("# metadata preserved in a partial export",
    fullMeta.length > 0 && partMeta.join("|") === fullMeta.join("|"));
  check("column header preserved",
    /(^|\n)Week,/.test(part.replace(/\r/g, "")), part.split("\n").slice(0, 8).join(" / "));
  check("weeks keep their original numbers (no renumbering)",
    bodyWeeks(window.variantToCSV(window.activeVariant(), new Set([nWeeks]))).every(w => w === nWeeks));

  /* --- bad spec blocks export */
  $("wk-range").value = "nope";
  $("wk-range").dispatchEvent(new window.Event("input", { bubbles: true }));
  check("bad spec disables export", $("btn-export").disabled === true);
  check("bad spec flags the field", $("wkpick").classList.contains("bad"));
  captured = null; window.exportActive();
  check("bad spec exports nothing", captured === null, captured && captured.fname);

  /* --- back to all */
  $("wk-range").value = "";
  $("wk-range").dispatchEvent(new window.Event("input", { bubbles: true }));
  check("blank re-enables export", $("btn-export").disabled === false);
  check("readout says all weeks",
    $("wkpick-note").textContent.startsWith(`All ${nWeeks} week`), $("wkpick-note").textContent);
  captured = null; window.exportActive();
  check("full export filename has no week tag", captured && !/_w[\d-]/.test(captured.fname),
    captured && captured.fname);

  /* --- every variant respects the filter */
  const segs = [...doc.querySelectorAll("#seg button")].map(b => b.dataset.v);
  let allOk = true, detail = "";
  for (const id of segs) {
    window.setVariant(id);
    const rows = bodyWeeks(window.variantToCSV(window.activeVariant(), new Set([1])));
    if (rows.length && !rows.every(w => w === 1)) { allOk = false; detail = id; }
  }
  check(`filter holds across all ${segs.length} variant(s)`, allOk, detail);
  window.setVariant(segs[0]);

  /* --- quick picks */
  const chips = [...$("wkpick-quick").querySelectorAll(".chip")];
  check("quick picks rendered (All + phases)", chips.length >= 1, `${chips.length}`);
  check('"All" chip is on when the field is blank',
    chips[0].textContent === "All" && chips[0].classList.contains("on"));
  if (chips.length > 1) {
    chips[1].click();
    const r = window.parseWeekSpec($("wk-range").value, window.availableWeeks());
    check(`phase chip "${chips[1].textContent}" sets a valid range`, !r.error && r.list.length > 0,
      $("wk-range").value + " -> " + JSON.stringify(r));
    $("wk-range").value = "";
    $("wk-range").dispatchEvent(new window.Event("input", { bubbles: true }));
  }

  /* --- ribbon interaction */
  window.selectWeek(2);
  const shown = [...$("wkpick-quick").querySelectorAll(".chip")].map(c => c.textContent);
  check("selecting a week offers a 'Week 2 shown' quick pick",
    shown.includes("Week 2 shown"), shown.join(" | "));
  check("preview filter alone does not narrow the export",
    $("wkpick-note").textContent.startsWith(`All ${nWeeks} week`), $("wkpick-note").textContent);
  window.selectWeek(2);

  /* --- spec survives a trip to the hub and back */
  $("wk-range").value = "1-2";
  $("wk-range").dispatchEvent(new window.Event("input", { bubbles: true }));
  window.showView("hub");
  window.showView(b.view);
  check("week spec remembered per program", $("wk-range").value === "1-2", $("wk-range").value);
  $("wk-range").value = "";
  $("wk-range").dispatchEvent(new window.Event("input", { bubbles: true }));
}

/* ------------------------------------------------ cross-program isolation */
console.log("\nIsolation between programs");
window.showView("squat");
$("wk-range").value = "3-5";
$("wk-range").dispatchEvent(new window.Event("input", { bubbles: true }));
window.showView("bench");
check("bench keeps its own (blank) spec", $("wk-range").value === "", $("wk-range").value);
window.showView("squat");
check("squat still remembers 3-5", $("wk-range").value === "3-5", $("wk-range").value);

/* ------------------------------------------------------------- edits ride along */
console.log("\nInline Sets/Reps edits survive a filtered export");
window.showView("squat");
$("wk-range").value = "";
$("wk-range").dispatchEvent(new window.Event("input", { bubbles: true }));
const p = window.activeVariant().parsed;
const target = p.body.findIndex(c => +c[p.idx.week] === 3);
if (target >= 0) {
  const inp = doc.querySelector(`.cell-in[data-ri="${target}"][data-k="sets"]`);
  if (inp) {
    inp.value = "9";
    inp.dispatchEvent(new window.Event("input", { bubbles: true }));
    const csv = window.variantToCSV(window.activeVariant(), new Set([3]));
    const line = csv.split(/\r?\n/).find(l => /^3,/.test(l) && l.split(",")[4] === "9");
    check("edited Sets value appears in the week-3 export", !!line, csv.split("\n").slice(2, 5).join(" / "));
  } else check("edit cell found", false);
} else check("week 3 row found", false);

console.log(`\n${checks} checks · ${failures === 0 ? "ALL PASSED" : failures + " FAILED"}\n`);
process.exit(failures === 0 ? 0 : 1);
