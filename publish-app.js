/* Writes the SQL that puts the app (app.html) into the database. index.html, the only public page,
 * downloads it from there once a signed-in device asks (any account; nobody signed out), keeps it
 * on the device and starts it. Run it after changing app.html, then paste the output file into
 * Supabase's SQL editor and Run ("Run without RLS" is fine).
 *
 *   node publish-app.js [out.sql]
 *
 * Default output: ../Power Logs Cloud Setup/app-upload.sql (outside this repo).
 *
 * The version is APP_VERSION plus a short hash of the file, so every change is picked up, even one
 * made without bumping APP_VERSION. The file is large, so it goes up as a few pieces inside one
 * transaction: nobody can download it half-written.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const src = fs.readFileSync(path.join(__dirname, "app.html"), "utf8");
const appVersion = (src.match(/var APP_VERSION = "([^"]+)";/) || [])[1];
if (!appVersion) throw new Error("app.html has no APP_VERSION");
const version = appVersion + "-" + crypto.createHash("md5").update(src, "utf8").digest("hex").slice(0, 8);
if (src.includes("$app$")) throw new Error("app.html contains the $app$ quote tag");
const out = process.argv[2] || path.join(__dirname, "..", "Power Logs Cloud Setup", "app-upload.sql");

const PIECE = 180 * 1024;
const pieces = [];
let cur = "";
src.split(/(?<=\n)/).forEach(line => {
  if (cur.length + line.length > PIECE && cur) { pieces.push(cur); cur = ""; }
  cur += line;
});
if (cur) pieces.push(cur);

let sql = "-- Power Logs, " + version + " (" + pieces.length + " pieces). Paste into the Supabase SQL editor and Run (\"Run without RLS\" is fine).\n" +
  "begin;\n" +
  "insert into public.owner_assets (id, version, body, members) values ('app', '" + version + "', $app$" + pieces[0] + "$app$, true)\n" +
  "on conflict (id) do update set version = excluded.version, body = excluded.body, members = true, updated_at = now();\n";
pieces.slice(1).forEach(p => { sql += "update public.owner_assets set body = body || $app$" + p + "$app$ where id = 'app';\n"; });
// The SQL editor turns pasted line breaks into CRLF; put them back so the stored file is exactly this one.
sql += "update public.owner_assets set body = replace(body, E'\\r\\n', E'\\n') where id = 'app';\n" +
  "commit;\n" +
  "select id, version, members, length(body) as chars, md5(body) as md5 from public.owner_assets where id = 'app';\n";
fs.writeFileSync(out, sql);
console.log("wrote " + out + " (" + version + ", " + Math.round(src.length / 1024) + " KB in " + pieces.length + " pieces, md5 " +
  crypto.createHash("md5").update(src.replace(/\r\n/g, "\n"), "utf8").digest("hex") + ")");
