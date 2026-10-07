/* Writes the SQL that puts rpe-calculator.html into the database, where any signed-in account can read it
 * (and nobody signed out). Run it after changing rpe-calculator.html (and bump its "rpe-N" and RPE_BUILD in
 * app.html first), then paste the output file into Supabase's SQL editor and Run.
 *
 *   node publish-rpe.js [out.sql]
 *
 * Default output: ../Power Logs Cloud Setup/rpe-upload.sql (outside this repo).
 */
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "rpe-calculator.html"), "utf8");
const version = (src.match(/build: "(rpe-\d+)"/) || [])[1];
if (!version) throw new Error('rpe-calculator.html has no build: "rpe-N" in its ready message');
const app = fs.readFileSync(path.join(__dirname, "app.html"), "utf8");
const expect = (app.match(/var RPE_BUILD = "(\d+)";/) || [])[1];
if ("rpe-" + expect !== version) throw new Error(`app.html expects rpe-${expect} but rpe-calculator.html says ${version}. Bump them together.`);
if (src.includes("$rpe$")) throw new Error("rpe-calculator.html contains the $rpe$ quote tag");
const out = process.argv[2] || path.join(__dirname, "..", "Power Logs Cloud Setup", "rpe-upload.sql");
fs.writeFileSync(out,
  "-- The RPE Calculator, " + version + ". Paste into the Supabase SQL editor and Run (\"Run without RLS\" is fine).\n" +
  "insert into public.owner_assets (id, version, body, members) values ('rpe', '" + version + "', $rpe$" + src + "$rpe$, true)\n" +
  "on conflict (id) do update set version = excluded.version, body = excluded.body, members = true, updated_at = now();\n" +
  // The SQL editor turns pasted line breaks into CRLF; put them back so the stored file is exactly this one.
  "update public.owner_assets set body = replace(body, E'\\r\\n', E'\\n') where id = 'rpe';\n" +
  "select id, version, members, length(body) as chars, md5(body) as md5 from public.owner_assets where id = 'rpe';\n");
console.log("wrote " + out + " (" + version + ", " + Math.round(src.length / 1024) + " KB)");
