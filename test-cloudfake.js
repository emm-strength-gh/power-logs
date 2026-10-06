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
 *                 Its invoke("notify") runs supabase/functions/notify/index.ts
 *                 here (types stripped), against the same database with the
 *                 service role's view; pushes land in server.pushes.
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
    fetch: async (table) => {
      if (table === "accounts") return [{ user_id: user.id, email: user.email, role: "owner", coach_status: "none", display_name: "" }];
      // The Program Hub is in the database now: serve the file from disk, as the owner would get it.
      if (table === "owner_assets") {
        const body = fs.readFileSync(path.join(__dirname, "program-hub.html"), "utf8");
        return [{ id: "program-hub", version: "hub-" + (body.match(/build: "hub-(\d+)"/) || [])[1], body, updated_at: "2026-01-01T00:00:00Z" }];
      }
      return [];
    },
    upsert: async (t, rows) => { calls.push(["upsert", t, rows]); },
    remove: async (t, col, val) => { calls.push(["remove", t, col, val]); },
    invoke: async (fn, body) => { calls.push(["invoke", fn, body]); return { sent: 0 }; },
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
  create schema storage;
  grant usage on schema storage to anon, authenticated;
  create table storage.buckets (id text primary key, name text not null, public boolean default false, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text, owner uuid, created_at timestamptz default now());
  alter table storage.objects enable row level security;
  grant all on storage.objects to anon, authenticated;
  alter default privileges in schema public grant all on tables to anon, authenticated;
`;

async function pgServer() {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite();
  await db.exec(AUTH_STUB);
  await db.exec(fs.readFileSync(path.join(__dirname, "supabase", "schema.sql"), "utf8"));
  await db.exec(`insert into private.settings (owner_email) values ('${OWNER_EMAIL}')`);

  const listeners = new Set();
  const files = new Map();   // the stored files themselves: "bucket/name" -> Blob (the rules are on storage.objects)
  const invocations = [], pushes = [];

  // ---- supabase/functions/notify, run here. The admin client is a small
  // query builder over the same database as the superuser (which, like the
  // service role, isn't bound by row-level security); web-push just records.
  function adminBuilder(table) {
    const st = { op: "select", cols: "*", where: [], args: [], patch: null, single: false };
    const b = {
      select(cols) { if (st.op === "select") st.cols = cols || "*"; else st.returning = true; return b; },
      update(patch) { st.op = "update"; st.patch = patch; return b; },
      delete() { st.op = "delete"; return b; },
      eq(c, v) { st.args.push(v); st.where.push(`${ident(c)} = $${st.args.length}`); return b; },
      in(c, arr) { st.args.push(arr); st.where.push(`${ident(c)}::text = any($${st.args.length}::text[])`); return b; },
      is(c, v) { st.where.push(`${ident(c)} is ${v === null ? "null" : "not null"}`); return b; },
      maybeSingle() { st.single = true; return b; },
      then(ok, bad) {
        const w = st.where.length ? " where " + st.where.join(" and ") : "";
        let sql;
        if (st.op === "select") sql = `select ${st.cols.split(",").map(c => c.trim() === "*" ? "*" : ident(c.trim())).join(", ")} from public.${ident(table)}${w}`;
        else if (st.op === "update") {
          const cols = Object.keys(st.patch).map(ident), base = st.args.length;
          st.args.push(...cols.map(c => param(st.patch[c])));
          sql = `update public.${ident(table)} set ${cols.map((c, i) => `${c} = $${base + i + 1}`).join(", ")}${w} returning *`;
        } else sql = `delete from public.${ident(table)}${w}`;
        return db.query(sql, st.args).then(r => {
          const rows = plain(r.rows);
          return { data: st.single ? (rows[0] || null) : rows, error: null };
        }).then(ok, bad);
      },
    };
    return b;
  }
  let notifyHandler = null;
  function loadNotify() {
    const { stripTypeScriptTypes } = require("node:module");
    const src = fs.readFileSync(path.join(__dirname, "supabase", "functions", "notify", "index.ts"), "utf8")
      .replace(/^import .*$/gm, "");
    // Node flags this API as experimental on every call; the tests don't need telling.
    const warn = process.emitWarning;
    process.emitWarning = () => {};
    const js = stripTypeScriptTypes(src);
    process.emitWarning = warn;
    const env = { SUPABASE_URL: "http://local", SUPABASE_SERVICE_ROLE_KEY: "service", VAPID_PUBLIC_KEY: "pub", VAPID_PRIVATE_KEY: "priv" };
    const Deno = { env: { get: k => env[k] }, serve: fn => { notifyHandler = fn; } };
    const webpush = {
      setVapidDetails() {},
      async sendNotification(sub, payload) {
        if (/gone/.test(sub.endpoint)) { const e = new Error("gone"); e.statusCode = 410; throw e; }
        pushes.push({ endpoint: sub.endpoint, ...JSON.parse(payload) });
      },
    };
    const createClient = () => ({
      from: adminBuilder,
      auth: { getUser: async token => ({ data: { user: token ? { id: token } : null } }) },
    });
    new Function("Deno", "webpush", "createClient", js)(Deno, webpush, createClient);
  }
  async function runNotify(uid, body) {
    if (!notifyHandler) loadNotify();
    const res = await notifyHandler(new Request("http://local/notify", {
      method: "POST", headers: { Authorization: "Bearer " + uid, "Content-Type": "application/json" }, body: JSON.stringify(body),
    }));
    return res.json();
  }
  const ident = s => { if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error("bad identifier " + s); return s; };
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
  // (the real realtime channel says which table changed)
  function changed(from, table) {
    for (const l of listeners) if (l.from !== from) setTimeout(() => l.fn(table || "change"), 0);
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
        if (o.since) { args.push(o.since); where.push(`${ident(o.sinceCol || "updated_at")} > $${args.length}`); }
        if (o.ids) { args.push(o.ids); where.push(`id = any($${args.length}::uuid[])`); }
        if (o.lifterIds) { args.push(o.lifterIds); where.push(`lifter_id = any($${args.length}::uuid[])`); }
        const cols = (o.columns || "*").split(",").map(c => c === "*" ? c : ident(c.trim())).join(", ");
        const sql = `select ${cols} from public.${ident(table)}${where.length ? " where " + where.join(" and ") : ""} order by ${ident(o.orderBy || "updated_at")}`;
        return asUser(me(), async tx => plain((await tx.query(sql, args)).rows));
      },
      async upsert(table, rows, onConflict, skipExisting) {
        await online();
        const keys = onConflict.split(",").map(ident);
        await asUser(me(), async tx => {
          for (const row of rows) {
            const cols = Object.keys(row).map(ident);
            const set = cols.filter(c => !keys.includes(c)).map(c => `${c} = excluded.${c}`);
            await tx.query(`insert into public.${ident(table)} (${cols.join(", ")}) values (${cols.map((_, i) => "$" + (i + 1)).join(", ")})
              on conflict (${keys.join(", ")}) do ${set.length && !skipExisting ? "update set " + set.join(", ") : "nothing"}`, cols.map(c => param(row[c])));
          }
        });
        changed(api, table);
      },
      async insert(table, rows) {
        await online();
        await asUser(me(), async tx => {
          for (const row of rows) {
            const cols = Object.keys(row).map(ident);
            await tx.query(`insert into public.${ident(table)} (${cols.join(", ")}) values (${cols.map((_, i) => "$" + (i + 1)).join(", ")})`, cols.map(c => param(row[c])));
          }
        });
        changed(api, table);
      },
      async update(table, id, patch) {
        await online();
        const cols = Object.keys(patch).map(ident);
        await asUser(me(), tx => tx.query(`update public.${ident(table)} set ${cols.map((c, i) => `${c} = $${i + 1}`).join(", ")} where id = $${cols.length + 1}`,
          cols.map(c => param(patch[c])).concat([id])));
        changed(api, table);
      },
      async rpc(fn, args = {}) {
        await online();
        const names = Object.keys(args).map(ident);
        const r = await asUser(me(), tx => tx.query(`select public.${ident(fn)}(${names.map((n, i) => `${n} => $${i + 1}`).join(", ")}) as r`, names.map(n => args[n])));
        changed(api);
        return r.rows[0].r;
      },
      async remove(table, col, val) {
        await online();
        await asUser(me(), tx => tx.query(`delete from public.${ident(table)} where ${ident(col)} = $1`, [val]));
      },
      async invoke(fn, body) {
        await online();
        const r = await runNotify(me(), body);
        invocations.push({ from: label, body, result: r });
        return r;
      },
      // Storage: the same rules as the real thing, on storage.objects; the bytes are kept here.
      async storageUpload(bucket, name, blob) {
        await online();
        await asUser(me(), tx => tx.query("insert into storage.objects (bucket_id, name, owner) values ($1, $2, $3)", [bucket, name, me()]));
        files.set(bucket + "/" + name, blob);
      },
      async storageDownload(bucket, name) {
        await online();
        const r = await asUser(me(), tx => tx.query("select 1 from storage.objects where bucket_id = $1 and name = $2", [bucket, name]));
        if (!r.rows.length) throw new Error("Object not found");
        return files.get(bucket + "/" + name);
      },
      async storageHas(bucket, name) {
        await online();
        const r = await asUser(me(), tx => tx.query("select 1 from storage.objects where bucket_id = $1 and name = $2", [bucket, name]));
        return r.rows.length > 0;
      },
      async storageRemove(bucket, names) {
        await online();
        const r = await asUser(me(), tx => tx.query("delete from storage.objects where bucket_id = $1 and name = any($2::text[]) returning name", [bucket, names]));
        r.rows.forEach(x => files.delete(bucket + "/" + x.name));
        return r.rows.map(x => x.name);
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
  return { db, device, sql, invocations, pushes, runNotify, OWNER_EMAIL, GOOD_CODE };
}

module.exports = { coachCloud, installCoach, pgServer, OWNER_EMAIL, GOOD_CODE };
