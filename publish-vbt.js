/* Writes the SQL that puts VBT.html into the database, where any signed-in account can read it
 * (and nobody signed out). Run it after changing VBT.html (and bump its "vbt-N" and VBT_BUILD in
 * app.html first), then paste the output file into Supabase's SQL editor and Run.
 *
 *   node publish-vbt.js [out.sql]
 *
 * Default output: ../Power Logs Cloud Setup/vbt-upload.sql (outside this repo).
 */
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "VBT.html"), "utf8");
const version = (src.match(/build: "(vbt-\d+)"/) || [])[1];
if (!version) throw new Error('VBT.html has no build: "vbt-N" in its ready message');
const app = fs.readFileSync(path.join(__dirname, "app.html"), "utf8");
const expect = (app.match(/var VBT_BUILD = "(\d+)";/) || [])[1];
if ("vbt-" + expect !== version) throw new Error(`app.html expects vbt-${expect} but VBT.html says ${version}. Bump them together.`);
if (src.includes("$vbt$")) throw new Error("VBT.html contains the $vbt$ quote tag");
const out = process.argv[2] || path.join(__dirname, "..", "Power Logs Cloud Setup", "vbt-upload.sql");
fs.writeFileSync(out,
  "-- The Velocity Tracker, " + version + ". Paste into the Supabase SQL editor and Run (\"Run without RLS\" is fine).\n" +
  "insert into public.owner_assets (id, version, body, members) values ('vbt', '" + version + "', $vbt$" + src + "$vbt$, true)\n" +
  "on conflict (id) do update set version = excluded.version, body = excluded.body, members = true, updated_at = now();\n" +
  // The SQL editor turns pasted line breaks into CRLF; put them back so the stored file is exactly this one.
  "update public.owner_assets set body = replace(body, E'\\r\\n', E'\\n') where id = 'vbt';\n" +
  "select id, version, members, length(body) as chars, md5(body) as md5 from public.owner_assets where id = 'vbt';\n");
console.log("wrote " + out + " (" + version + ", " + Math.round(src.length / 1024) + " KB)");
