/* Stand-ins for Supabase, plugged into power-logs.html as window.__spotterCloud
 * (see cloudApi() there). Not a test itself; the test-*.js files require it.
 *
 *   coachCloud()  Signed in as the owner, and a server with nothing on it. For
 *                 tests that just need Manage program open, as the PIN used to.
 *   pgServer()    A real Postgres (PGlite, in memory) running supabase/schema.sql,
 *                 with a small stand-in for Supabase's auth schema. Every call
 *                 runs as the signed-in user, so the database's row-level
 *                 security decides what each device may see and change, exactly
 *                 as it does live. server.device() gives one app its client.
 */
const fs = require("fs");
const path = require("path");

const OWNER_EMAIL = "owner@test.invalid";
const GOOD_CODE = "123456";

function coachCloud() {
  const user = { id: "00000000-0000-4000-8000-00000000c0ac", email: OWNER_EMAIL };
  const calls = [];
  return {
    calls,
    session: async () => user,
    onSessionChange() {},
    sendCode: async () => {},
    verifyCode: async () => user,
    signOut: async () => {},
    fetch: async (table) => table === "accounts"
      ? [{ user_id: user.id, email: user.email, role: "owner", coach_status: "none", display_name: "" }]
      : [],
    upsert: async (t, rows) => { calls.push(["upsert", t, rows]); },
    insert: async (t, rows) => { calls.push(["insert", t, rows]); },
    update: async (t, id, patch) => { calls.push(["update", t, id, patch]); },
    rpc: async (fn, args) => { calls.push(["rpc", fn, args]); return null; },
    listen: () => () => {},
  };
}

// For beforeParse: signed in as owner, with "Upload this device's lifters?"
// already answered (Not now), so the prompt can't take a click meant for
// something else. Lifters loaded stay on the device.
function installCoach(w) {
  w.__spotterCloud = coachCloud();
  w.localStorage.setItem("spotter.cloud.v1", JSON.stringify({ uploadAsked: true }));
  return w.__spotterCloud;
}

const AUTH_STUB = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create role supabase_auth_admin nologin;
  grant anon, authenticated to postgres;
  create schema auth;
  grant usage on schema auth to anon, authenticated;
  create table auth.users (
    instance_id uuid, id uuid primary key, aud text, role text, email text unique,
    email_confirmed_at timestamptz, raw_app_meta_data jsonb, raw_user_meta_data jsonb,
    created_at timestamptz, updated_at timestamptz);
  create function auth.uid() returns uuid language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
  create publication supabase_realtime;
  alter default privileges in schema public grant all on tables to anon, authenticated;
`;

async function pgServer() {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite();
  await db.exec(AUTH_STUB);
  await db.exec(fs.readFileSync(path.join(__dirname, "supabase", "schema.sql"), "utf8"));
  await db.exec(`insert into private.settings (owner_email) values ('${OWNER_EMAIL}')`);

  const listeners = new Set();
  const ident = s => { if (!/^[a-z_]+$/.test(s)) throw new Error("bad identifier " + s); return s; };
  // PostgREST hands timestamps back as ISO strings.
  const plain = rows => rows.map(r => {
    const o = {};
    for (const [k, v] of Object.entries(r)) o[k] = v instanceof Date ? v.toISOString() : v;
    return o;
  });
  const param = v => (v !== null && typeof v === "object") ? JSON.stringify(v) : v;

  async function asUser(uid, fn) {
    return db.transaction(async tx => {
      await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: uid, role: "authenticated" })]);
      await tx.query("set local role authenticated");
      return fn(tx);
    });
  }
  function changed(from) {
    for (const l of listeners) if (l.from !== from) setTimeout(() => l.fn("change"), 0);
  }

  // Make sure an account exists for this email (signing up), as the auth service would.
  async function userFor(email) {
    const found = await db.query("select id from auth.users where email = $1", [email]);
    if (found.rows.length) return found.rows[0].id;
    const id = crypto.randomUUID();
    await db.query("insert into auth.users (id, email, aud, role) values ($1, $2, 'authenticated', 'authenticated')", [id, email]);
    await db.query("update auth.users set email_confirmed_at = now() where id = $1", [id]);
    return id;
  }

  function device(label) {
    let user = null;
    const state = { offline: false, requests: 0 };
    const sessionFns = [];
    const online = () => {
      state.requests++;
      if (state.offline) return Promise.reject(new TypeError("Failed to fetch"));
      return Promise.resolve();
    };
    const me = () => { if (!user) throw new Error("not signed in"); return user.id; };
    const api = {
      state,
      get user() { return user; },
      session: async () => user,
      onSessionChange(fn) { sessionFns.push(fn); },
      sendCode: async (email) => { await online(); if (!/@/.test(email)) throw new Error("invalid email"); },
      verifyCode: async (email, code) => {
        await online();
        if (code !== GOOD_CODE) throw new Error("Token has expired or is invalid");
        user = { id: await userFor(email.toLowerCase()), email: email.toLowerCase() };
        return user;
      },
      signOut: async () => { user = null; sessionFns.forEach(f => f(null, "SIGNED_OUT")); },
      async fetch(table, o = {}) {
        await online();
        const where = [], args = [];
        if (o.since) { args.push(o.since); where.push(`updated_at > $${args.length}`); }
        if (o.ids) { args.push(o.ids); where.push(`id = any($${args.length}::uuid[])`); }
        if (o.lifterIds) { args.push(o.lifterIds); where.push(`lifter_id = any($${args.length}::uuid[])`); }
        const cols = (o.columns || "*").split(",").map(c => c === "*" ? c : ident(c.trim())).join(", ");
        const sql = `select ${cols} from public.${ident(table)}${where.length ? " where " + where.join(" and ") : ""} order by ${ident(o.orderBy || "updated_at")}`;
        return asUser(me(), async tx => plain((await tx.query(sql, args)).rows));
      },
      async upsert(table, rows, onConflict) {
        await online();
        const keys = onConflict.split(",").map(ident);
        await asUser(me(), async tx => {
          for (const row of rows) {
            const cols = Object.keys(row).map(ident);
            const set = cols.filter(c => !keys.includes(c)).map(c => `${c} = excluded.${c}`);
            await tx.query(`insert into public.${ident(table)} (${cols.join(", ")}) values (${cols.map((_, i) => "$" + (i + 1)).join(", ")})
              on conflict (${keys.join(", ")}) do ${set.length ? "update set " + set.join(", ") : "nothing"}`, cols.map(c => param(row[c])));
          }
        });
        changed(api);
      },
      async insert(table, rows) {
        await online();
        await asUser(me(), async tx => {
          for (const row of rows) {
            const cols = Object.keys(row).map(ident);
            await tx.query(`insert into public.${ident(table)} (${cols.join(", ")}) values (${cols.map((_, i) => "$" + (i + 1)).join(", ")})`, cols.map(c => param(row[c])));
          }
        });
        changed(api);
      },
      async update(table, id, patch) {
        await online();
        const cols = Object.keys(patch).map(ident);
        await asUser(me(), tx => tx.query(`update public.${ident(table)} set ${cols.map((c, i) => `${c} = $${i + 1}`).join(", ")} where id = $${cols.length + 1}`,
          cols.map(c => param(patch[c])).concat([id])));
        changed(api);
      },
      async rpc(fn, args = {}) {
        await online();
        const names = Object.keys(args).map(ident);
        const r = await asUser(me(), tx => tx.query(`select public.${ident(fn)}(${names.map((n, i) => `${n} => $${i + 1}`).join(", ")}) as r`, names.map(n => args[n])));
        changed(api);
        return r.rows[0].r;
      },
      listen(fn) {
        const l = { from: api, fn };
        listeners.add(l);
        return () => listeners.delete(l);
      },
    };
    api.label = label;
    return api;
  }

  // Straight to the database as the superuser, for checking what's stored.
  const sql = async (q, args) => plain((await db.query(q, args)).rows);
  return { db, device, sql, OWNER_EMAIL, GOOD_CODE };
}

module.exports = { coachCloud, installCoach, pgServer, OWNER_EMAIL, GOOD_CODE };
