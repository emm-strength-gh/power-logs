// Supabase Edge Function "notify": the phone/computer notifications for Power Logs.
//
// The app calls it (supabase.functions.invoke("notify", ...)) right after it
// saves a message, a finished day or a "new week" alert, passing only which
// row. This function looks the row up itself, checks the caller made it and
// that it hasn't been announced yet (claiming notified_at, so a retry or a
// tampered app can't send it twice), works out who should hear about it, and
// sends a Web Push to each of their devices that wants that kind.
//
// (A new video is announced the same way, to the lifter's coaches. A coach's feedback on a video, and a coach's
// reaction to a training day or a video, are announced to the lifter.)
// Notification text never contains a message itself, only who or what:
// banners show on locked screens.
//
// Secrets (Supabase → Edge Functions → Secrets): VAPID_PUBLIC_KEY and
// VAPID_PRIVATE_KEY. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided
// by Supabase. Deploy with "Verify JWT" on (the default): only signed-in
// people can call it.
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const SITE = "https://emm-strength-gh.github.io/power-logs/";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

type Note = { to: string[]; pref: "messages" | "sessions" | "weeks" | "trophies" | "videos" | "feedback"; body: string; tag: string; url: string };
type Account = { user_id: string; role: string; coach_status: string; display_name: string; email: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const pub = Deno.env.get("VAPID_PUBLIC_KEY"), priv = Deno.env.get("VAPID_PRIVATE_KEY");
    if (!pub || !priv) return reply({ error: "VAPID keys are not set" }, 500);
    webpush.setVapidDetails(SITE, pub, priv);

    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
    const { data } = await admin.auth.getUser(token);
    const uid = data.user?.id;
    if (!uid) return reply({ error: "not signed in" }, 401);

    const body = await req.json().catch(() => ({}));
    const note = body.message_id ? await forMessage(uid, String(body.message_id))
               : (body.event_id || body.event) ? await forEvent(uid, body)
               : body.reaction ? await forReaction(uid, body.reaction)
               : null;
    return reply({ sent: note ? await deliver(note) : 0 });
  } catch (e) {
    return reply({ error: String((e as Error)?.message || e) }, 500);
  }
});

async function lifterRow(id: string) {
  const { data } = await admin.from("lifters").select("id, name, lifter_user_id, deleted_at").eq("id", id).maybeSingle();
  return data && !data.deleted_at ? data : null;
}

// Coaches who can currently act for the lifter (approved, or the owner), with
// when they started coaching them: the team thread is theirs only from then.
async function activeCoaches(lifterId: string) {
  const { data: links } = await admin.from("lifter_coaches").select("coach_id, created_at").eq("lifter_id", lifterId);
  const ids = (links || []).map((l) => l.coach_id);
  if (!ids.length) return [];
  const { data: accs } = await admin.from("accounts")
    .select("user_id, role, coach_status, display_name, email").in("user_id", ids);
  const byId = new Map((accs || []).map((a: Account) => [a.user_id, a]));
  return (links || [])
    .filter((l) => { const a = byId.get(l.coach_id); return a && (a.role === "owner" || a.coach_status === "approved"); })
    .map((l) => ({ id: l.coach_id as string, since: Date.parse(l.created_at), acc: byId.get(l.coach_id) as Account }));
}

const coachLabel = (a?: Account) => a?.display_name || (a?.email || "").split("@")[0] || "your coach";
const now = () => new Date().toISOString();

async function forMessage(uid: string, id: string): Promise<Note | null> {
  const { data: m } = await admin.from("messages").update({ notified_at: now() })
    .eq("id", id).eq("sender_id", uid).is("notified_at", null).select().maybeSingle();
  if (!m) return null;
  const lifter = await lifterRow(m.lifter_id);
  if (!lifter) return null;
  const coaches = await activeCoaches(m.lifter_id);
  const to = new Set<string>();
  if (lifter.lifter_user_id) to.add(lifter.lifter_user_id);
  if (m.thread === "team") coaches.filter((c) => c.since <= Date.parse(m.created_at)).forEach((c) => to.add(c.id));
  else if (coaches.some((c) => c.id === m.thread)) to.add(m.thread);
  to.delete(uid);
  const from = uid === lifter.lifter_user_id ? lifter.name : coachLabel(coaches.find((c) => c.id === uid)?.acc);
  return {
    to: [...to], pref: "messages", body: `New message from ${from}`,
    tag: `msg-${m.lifter_id}-${m.thread}`,
    url: `${SITE}power-logs.html?open=messages&lifter=${m.lifter_id}&thread=${m.thread}`,
  };
}

// A coach's reaction to a training day or a video, to the lifter. Announced once per change of emoji: the row's
// notified_at is cleared by the database whenever the emoji changes, and claimed here. Names only, never the emoji's target.
async function forReaction(uid: string, r: { lifter_id?: string; target_type?: string; target_id?: string }): Promise<Note | null> {
  if (!r || (r.target_type !== "day" && r.target_type !== "video")) return null;
  const { data: row } = await admin.from("lifter_reactions").update({ notified_at: now() })
    .eq("lifter_id", String(r.lifter_id)).eq("target_type", r.target_type).eq("target_id", String(r.target_id))
    .eq("user_id", uid).is("notified_at", null).select().maybeSingle();
  if (!row || !row.emoji) return null;
  const lifter = await lifterRow(row.lifter_id);
  if (!lifter || !lifter.lifter_user_id || lifter.lifter_user_id === uid) return null;
  const giver = (await activeCoaches(row.lifter_id)).find((c) => c.id === uid);
  if (!giver) return null;
  const video = row.target_type === "video";
  const week = String(row.target_id).split("|")[0];
  return {
    to: [lifter.lifter_user_id], pref: "feedback",
    body: `${coachLabel(giver.acc)} reacted to your ${video ? "video" : "training day"}`,
    tag: `react-${row.lifter_id}-${row.target_type}`,
    url: video ? `${SITE}power-logs.html?open=videos&lifter=${row.lifter_id}`
               : `${SITE}power-logs.html?open=week&lifter=${row.lifter_id}&week=${encodeURIComponent(week)}`,
  };
}

async function forEvent(uid: string, body: { event_id?: string; event?: Record<string, string> }): Promise<Note | null> {
  let q = admin.from("lifter_events").update({ notified_at: now() }).eq("created_by", uid).is("notified_at", null);
  if (body.event_id) q = q.eq("id", body.event_id);
  else {
    const e = body.event || {};
    q = q.eq("lifter_id", e.lifter_id).eq("kind", e.kind).eq("week", String(e.week ?? "")).eq("day", String(e.day ?? ""));
  }
  const { data: ev } = await q.select().maybeSingle();
  if (!ev) return null;
  const lifter = await lifterRow(ev.lifter_id);
  if (!lifter) return null;
  if (ev.kind === "session_done") {
    const coaches = await activeCoaches(ev.lifter_id);
    return {
      to: coaches.map((c) => c.id).filter((c) => c !== uid), pref: "sessions",
      body: `${lifter.name} finished week ${ev.week} · day ${ev.day}`, tag: `done-${ev.id}`,
      url: `${SITE}power-logs.html?open=week&lifter=${ev.lifter_id}&week=${encodeURIComponent(ev.week)}`,
    };
  }
  if (ev.kind === "video") {
    // Names only, never the lift or the notes: banners show on locked screens.
    const coaches = await activeCoaches(ev.lifter_id);
    const from = uid === lifter.lifter_user_id ? lifter.name : coachLabel(coaches.find((c) => c.id === uid)?.acc);
    return {
      to: coaches.map((c) => c.id).filter((c) => c !== uid), pref: "videos",
      body: `${from} uploaded a video`, tag: `video-${ev.lifter_id}`,
      url: `${SITE}power-logs.html?open=videos&lifter=${ev.lifter_id}`,
    };
  }
  if (ev.kind === "videofb") {
    // Names only, never the feedback: banners show on locked screens.
    if (!lifter.lifter_user_id || lifter.lifter_user_id === uid) return null;
    const giver = (await activeCoaches(ev.lifter_id)).find((c) => c.id === uid);
    if (!giver) return null;
    return {
      to: [lifter.lifter_user_id], pref: "feedback",
      body: `${coachLabel(giver.acc)} left feedback on your video`, tag: `videofb-${ev.lifter_id}`,
      url: `${SITE}power-logs.html?open=videos&lifter=${ev.lifter_id}`,
    };
  }
  if (ev.kind === "trophy") {
    // Names only, never the trophy: banners show on locked screens, and
    // trophies are the lifter's to share.
    if (uid === lifter.lifter_user_id) {
      const coaches = await activeCoaches(ev.lifter_id);
      return {
        to: coaches.map((c) => c.id).filter((c) => c !== uid), pref: "trophies",
        body: `${lifter.name} earned a trophy`, tag: `trophy-${ev.lifter_id}`,
        url: `${SITE}power-logs.html?open=trophies&lifter=${ev.lifter_id}`,
      };
    }
    if (!lifter.lifter_user_id) return null;
    const giver = (await activeCoaches(ev.lifter_id)).find((c) => c.id === uid);
    return {
      to: [lifter.lifter_user_id], pref: "trophies",
      body: `${coachLabel(giver?.acc)} gave you a trophy`, tag: `trophy-${ev.lifter_id}`,
      url: `${SITE}power-logs.html?open=trophies&lifter=${ev.lifter_id}`,
    };
  }
  if (ev.kind === "new_week" && lifter.lifter_user_id) {
    const first = String(ev.week).split(",")[0].trim();
    return {
      to: [lifter.lifter_user_id], pref: "weeks", body: "A new week is in your program", tag: `week-${ev.id}`,
      url: `${SITE}power-logs.html?open=week&lifter=${ev.lifter_id}&week=${encodeURIComponent(first)}`,
    };
  }
  return null;
}

async function deliver(n: Note) {
  if (!n.to.length) return 0;
  const { data: subs } = await admin.from("push_subscriptions").select("endpoint, p256dh, auth, prefs").in("user_id", n.to);
  let sent = 0;
  await Promise.all((subs || []).filter((s) => (s.prefs || {})[n.pref] !== false).map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify({ title: "Power Logs", body: n.body, tag: n.tag, url: n.url }),
        { TTL: 86400 },
      );
      sent++;
    } catch (e) {
      // Gone (app deleted, notifications turned off in settings): forget the device.
      const code = (e as { statusCode?: number })?.statusCode;
      if (code === 404 || code === 410) await admin.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
    }
  }));
  return sent;
}
