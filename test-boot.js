/* Smoke test: does the patched page still boot, and is the PWA wiring intact?
 * Run: npm install jsdom && node test-boot.js
 */
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const html = fs.readFileSync(path.join(__dirname, "power-logs.html"), "utf8");
let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "  ok  " : " FAIL "} ${name}${extra && !cond ? " — " + extra : ""}`);
  if (!cond) failures++;
};

/* ---- static markup checks ------------------------------------------------ */
console.log("\nHead / manifest wiring");
check("manifest link present", /<link rel="manifest" href="\.\/manifest\.webmanifest"/.test(html));
check("viewport-fit=cover", /viewport-fit=cover/.test(html));
check("apple-mobile-web-app-capable", /name="apple-mobile-web-app-capable" content="yes"/.test(html));
check("apple-touch-icon is a real file, not a data URI",
  /rel="apple-touch-icon" href="\.\/icons\/apple-touch-icon\.png"/.test(html));
check("no leftover base64 icon data URIs", !/href="data:image\/png;base64,/.test(html));
check("theme-color meta has id", /id="themeColorMeta"/.test(html));
check("sw registered on relative path", /register\("\.\/sw\.js"\)/.test(html));
check("touch fields bumped to 16px", /@media \(pointer: coarse\) and \(max-width: 900px\)/.test(html));
check("persistent storage requested", /navigator\.storage\.persist/.test(html));

console.log("\nExport routing");
check("saveFile helper defined", /function saveFile\(blob, fname, okMsg\)/.test(html));
check("no raw a.download left behind",
  (html.match(/a\.download = fname/g) || []).length === 1,
  `found ${(html.match(/a\.download = fname/g) || []).length} (expected 1, inside downloadBlob)`);
const saveCalls = (html.match(/(?<!function )\bsaveFile\(blob,/g) || []).length;
check("both exports go through saveFile", saveCalls === 2, `found ${saveCalls}`);

/* ---- referenced local files must actually exist -------------------------- */
console.log("\nReferenced files exist on disk");
const refs = [...html.matchAll(/(?:href|src)="\.\/([^"]+)"/g)].map(m => m[1]);
[...new Set(refs)].forEach(r => check(r, fs.existsSync(path.join(__dirname, r))));
check("sw.js", fs.existsSync(path.join(__dirname, "sw.js")));

/* ---- Chart.js must be cached by the worker, or charts break offline ------ */
console.log("\nService worker covers third-party deps");
const sw = fs.readFileSync(path.join(__dirname, "sw.js"), "utf8");
const chartUrl = (html.match(/https:\/\/cdnjs\.cloudflare\.com[^"']+chart[^"']+/i) || [])[0];
check("Chart.js URL found in page", !!chartUrl, "none");
check("exact Chart.js URL is precached by sw.js", !!chartUrl && sw.includes(chartUrl),
  chartUrl ? "page wants " + chartUrl : "");
["fonts.googleapis.com", "fonts.gstatic.com", "cdnjs.cloudflare.com"]
  .forEach(o => check(`vendor origin ${o} handled`, sw.includes(o)));

/* ---- manifest ----------------------------------------------------------- */
console.log("\nManifest");
const mf = JSON.parse(fs.readFileSync(path.join(__dirname, "manifest.webmanifest"), "utf8"));
check("start_url points at the app file",
  fs.existsSync(path.join(__dirname, mf.start_url.replace("./", ""))), mf.start_url);
check("display is standalone", mf.display === "standalone");
mf.icons.forEach(i =>
  check(`icon ${i.sizes} ${i.purpose}`, fs.existsSync(path.join(__dirname, i.src.replace("./", "")))));
check("has a maskable icon", mf.icons.some(i => i.purpose === "maskable"));

/* ---- boot the page ------------------------------------------------------ */
console.log("\nRuntime boot (jsdom)");
const errors = [];
const vc = new VirtualConsole()
  .on("jsdomError", e => errors.push(e.message))
  .on("error", m => errors.push(String(m)));

const dom = new JSDOM(html, {
  runScripts: "dangerously",
  pretendToBeVisual: true,
  url: "https://example.github.io/spotter/power-logs.html",
  virtualConsole: vc,
});
const { window } = dom;
const doc = window.document;

/* boot() defers to DOMContentLoaded, so wait for the document to finish before
   asserting anything about runtime state. */
function ready() {
  return new Promise(resolve => {
    if (doc.readyState === "complete") return resolve();
    window.addEventListener("load", () => resolve());
    setTimeout(resolve, 4000);   // safety net
  });
}

(async () => {
await ready();

/* jsdom lacks layout APIs (scrollTo, canvas) — those aren't app bugs. */
const ignorable = /Not implemented|HTMLCanvasElement|getContext|Chart is not defined/i;
const realErrors = errors.filter(e => !ignorable.test(e));
if (errors.length !== realErrors.length) {
  console.log(`       (ignored ${errors.length - realErrors.length} jsdom environment notice(s))`);
}
check("no script errors on load", realErrors.length === 0, realErrors.join(" | ").slice(0, 400));

check("theme applied to <html>", !!doc.documentElement.getAttribute("data-theme"),
  String(doc.documentElement.getAttribute("data-theme")));
check("file inputs present", doc.querySelectorAll('input[type="file"]').length >= 2,
  `found ${doc.querySelectorAll('input[type="file"]').length}`);
check("toast element present", !!doc.getElementById("toast"));

/* theme toggle should move the status-bar meta */
console.log("\nTheme toggle drives status bar colour");
const meta = () => doc.getElementById("themeColorMeta").getAttribute("content");
const btn = doc.getElementById("themeBtn");
check("theme button wired", !!btn && typeof btn.onclick === "function");
if (btn && btn.onclick) {
  const before = doc.documentElement.getAttribute("data-theme");
  btn.onclick();
  const after = doc.documentElement.getAttribute("data-theme");
  check("toggling changes theme", before !== after, `${before} -> ${after}`);
  check("theme-color tracks theme",
    meta() === (after === "dark" ? "#14171a" : "#f1f3ee"), `${after} gave ${meta()}`);
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}\n`);
window.close();          // app leaves timers running; close so node can exit
process.exit(failures === 0 ? 0 : 1);
})();
