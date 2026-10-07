/* Writes the SQL that puts program-hub.html into the database, where only the owner can
 * read it. Run it after changing program-hub.html (and bump its "hub-N" and HUB_BUILD in
 * app.html first), then paste the output file into Supabase's SQL editor and Run.
 *
 *   node publish-hub.js [out.sql]
 *
 * Default output: ../Power Logs Cloud Setup/hub-upload.sql (outside this repo).
 */
const fs = require("fs");
const path = require("path");
const src = fs.readFileSync(path.join(__dirname, "program-hub.html"), "utf8");
const version = (src.match(/build: "(hub-\d+)"/) || [])[1];
if (!version) throw new Error('program-hub.html has no build: "hub-N" in its ready message');
const app = fs.readFileSync(path.join(__dirname, "app.html"), "utf8");
const expect = (app.match(/var HUB_BUILD = "(\d+)";/) || [])[1];
if ("hub-" + expect !== version) throw new Error(`app.html expects hub-${expect} but program-hub.html says ${version}. Bump them together.`);
if (src.includes("$hub$")) throw new Error("program-hub.html contains the $hub$ quote tag");
const out = process.argv[2] || path.join(__dirname, "..", "Power Logs Cloud Setup", "hub-upload.sql");
fs.writeFileSync(out,
  "-- The Program Hub, " + version + ". Paste into the Supabase SQL editor and Run (\"Run without RLS\" is fine).\n" +
  "insert into public.owner_assets (id, version, body) values ('program-hub', '" + version + "', $hub$" + src + "$hub$)\n" +
  "on conflict (id) do update set version = excluded.version, body = excluded.body, updated_at = now();\n" +
  // The SQL editor turns pasted line breaks into CRLF; put them back so the stored file is exactly this one.
  "update public.owner_assets set body = replace(body, E'\\r\\n', E'\\n') where id = 'program-hub';\n" +
  "select id, version, length(body) as chars, md5(body) as md5 from public.owner_assets where id = 'program-hub';\n");
console.log("wrote " + out + " (" + version + ", " + Math.round(src.length / 1024) + " KB)");
