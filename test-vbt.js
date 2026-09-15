/* Smoke test for VBT.html as a page inside the Spotter app.
 *
 *   node test-boot.js
 *
 * Verifies the file parses, every function it calls is defined, every element ID
 * it reaches for exists in the markup, and that it points at Spotter's manifest
 * and icons rather than declaring its own app identity.
 */
const fs = require("fs");

const FILE = "VBT.html";
if (!fs.existsSync(FILE)) { console.error("Cannot find " + FILE); process.exit(1); }
const html = fs.readFileSync(FILE, "utf8");

let failures = 0;
function check(name, ok, detail) {
  console.log("  " + (ok ? "PASS" : "FAIL") + "  " + name + (detail ? "   " + detail : ""));
  if (!ok) failures++;
}

/* ---------- 1. the script parses ---------- */
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const app = scripts[scripts.length - 1];
try {
  new (require("vm").Script)(app, { filename: "VBT.html" });
  check("script parses", true);
} catch (e) {
  check("script parses", false, e.message);
  process.exit(1);
}

/* ---------- 2. no undefined callees ---------- */
const stripped = app
  .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ")
  .replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''");
const defined = new Set();
[...stripped.matchAll(/(?:^|\s)(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)].forEach(m => defined.add(m[1]));
[...stripped.matchAll(/(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\()/g)].forEach(m => defined.add(m[1]));
[...stripped.matchAll(/function[^(]*\(([^)]*)\)/g)].forEach(m =>
  m[1].split(",").map(x => x.trim()).filter(Boolean).forEach(x => defined.add(x)));
const builtins = new Set(["if","for","while","switch","catch","return","function","typeof","new","await",
  "else","do","try","delete","void","in","of","var","let","const","parseFloat","parseInt","isFinite","isNaN",
  "Number","String","Boolean","Array","Object","Math","JSON","Promise","Date","setTimeout","clearTimeout",
  "setInterval","requestAnimationFrame","cancelAnimationFrame","URL","Blob","File","MediaRecorder","Image",
  "Audio","Uint8Array","Uint8ClampedArray","Float64Array","Error","RegExp","fetch","localStorage","Infinity"]);
const called = new Set([...stripped.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1]));
const undef = [...called].filter(n => !defined.has(n) && !builtins.has(n)).sort();
check("every callee is defined", undef.length === 0, undef.length ? undef.join(", ") : `${defined.size} defined`);

/* ---------- 3. every element ID it uses exists ---------- */
const markup = html.split("<script>")[0];
const ids = new Set([...markup.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
const used = new Set([...html.matchAll(/\$\("([^"]+)"\)/g)].map(m => m[1]));
const missing = [...used].filter(x => !ids.has(x)).sort();
check("every element ID resolves", missing.length === 0, missing.length ? missing.join(", ") : `${used.size} used`);

/* ---------- 4. balanced markup ---------- */
["div", "button", "section", "canvas", "select"].forEach(tag => {
  const o = (markup.match(new RegExp("<" + tag + "[\\s>]", "g")) || []).length;
  const c = (markup.match(new RegExp("</" + tag + ">", "g")) || []).length;
  check(`<${tag}> balanced`, o === c, `${o} open / ${c} close`);
});

/* ---------- 5. wired into Spotter, not standalone ---------- */
check("uses Spotter's manifest", html.includes('href="./manifest.webmanifest"'));
check("no private manifest.json", !html.includes('href="manifest.json"'));
check("uses Spotter's icon folder", html.includes('href="./icons/'));
check("links back to power-logs.html", html.includes('href="./power-logs.html"'));
check("registers the shared worker", /register\("\.?\/?sw\.js"\)/.test(html));
check("exports go through saveFile()", /async function saveFile\(/.test(html));
check("no bare <a download> left", !/\.download\s*=/.test(app.replace(/function saveFile[\s\S]*?\n}/, "")));
check("16px inputs on coarse pointers", html.includes("(pointer: coarse)"));
check("no external network requests", !/(src|href)="https?:\/\//.test(markup));
check("localStorage namespaced", (html.match(/localStorage\.(get|set)Item\("([^"]+)"/g) || [])
  .every(m => m.includes("barspeed.")));

console.log("");
console.log(failures ? `${failures} check(s) failed.` : "All checks passed \u2014 ready to drop into the repo.");
process.exit(failures ? 1 : 0);
