/* The database rules (supabase/schema.sql) on a real Postgres, in memory.
 * Run: node test-cloudsql.js
 *
 * Runs supabase/selftest.sql, the same 47 checks you paste into Supabase's SQL
 * editor, against PGlite with a stand-in for Supabase's auth schema. Also: the
 * schema can be run twice (that's how updates reach the live database), signed
 * out gets nothing, and the owner is set from private.settings.
 */
const fs = require("fs");
const path = require("path");
const { pgServer, OWNER_EMAIL } = require("./test-cloudfake");

let failures = 0, checks = 0;
const check = (name, cond, extra = "") => {
  checks++;
  if (!cond) failures++;
  console.log(`${cond ? "  ok  " : " FAIL "} ${name}${extra && !cond ? " — " + extra : ""}`);
};

(async () => {
  const server = await pgServer();
  const { db, sql } = server;
  const schema = fs.readFileSync(path.join(__dirname, "supabase", "schema.sql"), "utf8");

  let again = null;
  try { await db.exec(schema); } catch (e) { again = e.message; }
  check("the schema runs a second time cleanly", again === null, again);
  check("no owner email in the public schema file", !/@(?!selftest\.invalid|example\.com)[a-z0-9-]+\.[a-z]/i.test(schema.replace(/--[^\n]*/g, "")));

  const out = await db.exec(fs.readFileSync(path.join(__dirname, "supabase", "selftest.sql"), "utf8"));
  const rows = out[out.length - 1].rows;
  console.log("\nselftest.sql");
  rows.slice(1).forEach(r => check(r.test, r.result === "PASS", r.detail));
  check("selftest summary says all passed", /^ALL \d+ PASSED$/.test(rows[0].result), rows[0].result);
  check("selftest cleaned up after itself", (await sql("select count(*)::int n from auth.users where email like '%@selftest.invalid'"))[0].n === 0);

  console.log("\nOwner, and signed out");
  const dev = server.device("x");
  await dev.verifyCode(OWNER_EMAIL, server.GOOD_CODE);
  const acc = await dev.fetch("accounts", { orderBy: "created_at" });
  check("signing in with the owner email makes the owner", acc.length === 1 && acc[0].role === "owner", JSON.stringify(acc));
  await dev.verifyCode("someone@test.invalid", server.GOOD_CODE);
  const other = await dev.fetch("accounts", { orderBy: "created_at" });
  check("anyone else is an ordinary member", other.length === 1 && other[0].role === "member" && other[0].coach_status === "none");
  let anon = null;
  try {
    await db.transaction(async tx => { await tx.query("set local role anon"); await tx.query("select * from public.lifters"); });
  } catch (e) { anon = e.message; }
  check("signed out: permission denied", /permission denied/.test(anon || ""), anon);

  console.log("\nInvite-only sign-up, through the auth service stand-in");
  const inv = await pgServer({ inviteOnly: true });
  const stranger = inv.device("s");
  let refused = null;
  try { await stranger.sendCode("stranger@test.invalid"); } catch (e) { refused = e; }
  check("a stranger's email gets no code, and is told why", !!refused && /hasn.t been invited/.test(refused.message) && refused.status === 403, refused && refused.message);
  check("...and no account is made", (await inv.sql("select count(*)::int n from auth.users where email = 'stranger@test.invalid'"))[0].n === 0);
  const own = inv.device("o");
  await own.sendCode(OWNER_EMAIL);
  await own.verifyCode(OWNER_EMAIL, inv.GOOD_CODE);
  check("the owner's own email is always let in", !!own.user);
  await own.upsert("invites", [{ email: "newcoach@test.invalid", coach: true }], "email");
  const nc = inv.device("n");
  await nc.sendCode("NewCoach@test.invalid");
  await nc.verifyCode("NewCoach@test.invalid", inv.GOOD_CODE);
  const ncAcc = await nc.fetch("accounts", { orderBy: "created_at" });
  check("someone the owner invites as a coach signs up, already a coach", ncAcc.length === 1 && ncAcc[0].coach_status === "approved", JSON.stringify(ncAcc));
  const listed = await own.fetch("invites", { orderBy: "created_at" });
  check("the owner sees the invite list", listed.length === 1 && listed[0].email === "newcoach@test.invalid");
  check("...the new coach does not", (await nc.fetch("invites", { orderBy: "created_at" })).length === 0);
  await own.remove("invites", "email", "newcoach@test.invalid");
  check("taking an invite back leaves the account alone", (await own.fetch("invites", { orderBy: "created_at" })).length === 0
    && (await inv.sql("select coach_status from public.accounts where email = 'newcoach@test.invalid'"))[0].coach_status === "approved");
  const back = inv.device("b");
  await back.sendCode("stranger@test.invalid").catch(() => {});
  await inv.sql("insert into public.invites (email) values ('stranger@test.invalid')");
  let later = null;
  try { await back.sendCode("stranger@test.invalid"); await back.verifyCode("stranger@test.invalid", inv.GOOD_CODE); } catch (e) { later = e.message; }
  check("once invited, the same email gets in", later === null && !!back.user, later);

  console.log(`\n${checks} checks · ${failures === 0 ? "ALL PASSED" : failures + " FAILED"}\n`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
