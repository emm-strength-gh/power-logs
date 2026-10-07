-- EmmStrength Power Logs: accounts + cloud sync.
-- Paste the whole file into Supabase > SQL Editor and press Run.
-- Safe to run again later (every statement replaces or skips what exists),
-- which is how future schema changes will be delivered.
-- The copy in the app repo (supabase/schema.sql) is the one to edit; the
-- tests run it (test-cloudsql.js, test-cloudsync.js).
--
-- Who can do what is enforced HERE, by row-level security, not by the app:
-- the app's publishable key is public, so anything these rules allow, anyone
-- with an account can do from any browser.
--
--   owner   the account whose email is in private.settings, set by a
--           separate, private script so the email isn't published here.
--           Sees every lifter, approves/declines/revokes coaches.
--   coach   an account whose coach request the owner approved. Sees and
--           edits the lifters they created or were shared on.
--   lifter  an account whose confirmed email a coach put on a lifter. Sees
--           that program and logs it; can't change the program.
-- An account can be a coach and a lifter at once.

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

create table if not exists private.settings (
  id boolean primary key default true check (id),
  owner_email text not null
);
revoke all on private.settings from public, anon, authenticated;

---------------------------------------------------------------- tables

create table if not exists public.accounts (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  email        text not null default '',
  display_name text not null default '',
  role         text not null default 'member' check (role in ('owner', 'member')),
  coach_status text not null default 'none'
               check (coach_status in ('none', 'pending', 'approved', 'declined', 'revoked')),
  requested_at timestamptz,
  decided_at   timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Client-generated ids, so a lifter created offline keeps its id when it syncs.
create table if not exists public.lifters (
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  program        jsonb not null default '{}'::jsonb,
  lifter_email   text,
  -- Always derived from lifter_email by a trigger; whatever a client sends is ignored.
  lifter_user_id uuid references auth.users(id) on delete set null,
  created_by     uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  updated_by     uuid,
  deleted_at     timestamptz
);
create index if not exists lifters_updated_idx on public.lifters (updated_at);
create index if not exists lifters_user_idx on public.lifters (lifter_user_id);
create index if not exists lifters_email_idx on public.lifters (lifter_email);
-- Who entered lifter_email (set by the guard trigger), so removing a coach can
-- take back exactly the access that coach gave.
alter table public.lifters add column if not exists lifter_email_by uuid;

create table if not exists public.lifter_coaches (
  lifter_id  uuid not null references public.lifters(id) on delete cascade,
  coach_id   uuid not null references auth.users(id) on delete cascade,
  added_by   uuid,
  created_at timestamptz not null default now(),
  primary key (lifter_id, coach_id)
);
create index if not exists lifter_coaches_coach_idx on public.lifter_coaches (coach_id);

-- The log: one small row per thing, so a coach editing and a lifter ticking
-- the same program at once never overwrite each other. Rows are never
-- deleted (sync needs to see "cleared"), they're blanked instead.
create table if not exists public.lifter_marks (      -- Done / Skipped
  lifter_id  uuid not null references public.lifters(id) on delete cascade,
  rid        text not null,
  state      text not null check (state in ('done', 'skip', 'none')),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  primary key (lifter_id, rid)
);
create table if not exists public.lifter_row_notes (  -- exercise notes
  lifter_id  uuid not null references public.lifters(id) on delete cascade,
  rid        text not null,
  body       text,          -- null: no note of their own, show the program's RPE + notes
  updated_at timestamptz not null default now(),
  updated_by uuid,
  primary key (lifter_id, rid)
);
-- First version had body not null; null now means "no note of their own".
alter table public.lifter_row_notes alter column body drop not null;
alter table public.lifter_row_notes alter column body drop default;
create table if not exists public.lifter_custom (     -- added items
  lifter_id  uuid not null references public.lifters(id) on delete cascade,
  cid        text not null,
  item       jsonb not null default '{}'::jsonb,
  deleted    boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  primary key (lifter_id, cid)
);
create table if not exists public.lifter_week_notes ( -- Weekly notes
  lifter_id  uuid not null references public.lifters(id) on delete cascade,
  week       text not null,
  body       text not null default '',
  updated_at timestamptz not null default now(),
  updated_by uuid,
  primary key (lifter_id, week)
);
create table if not exists public.lifter_coach_notes ( -- Manage Program notes: coaches only
  lifter_id  uuid primary key references public.lifters(id) on delete cascade,
  body       text not null default '',
  updated_at timestamptz not null default now(),
  updated_by uuid
);
create table if not exists public.user_prefs (         -- each person's dropdown order
  user_id      uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  lifter_order jsonb not null default '[]'::jsonb,
  updated_at   timestamptz not null default now()
);

create index if not exists lifter_marks_updated_idx      on public.lifter_marks (updated_at);
create index if not exists lifter_row_notes_updated_idx  on public.lifter_row_notes (updated_at);
create index if not exists lifter_custom_updated_idx     on public.lifter_custom (updated_at);
create index if not exists lifter_week_notes_updated_idx on public.lifter_week_notes (updated_at);
create index if not exists lifter_coach_notes_updated_idx on public.lifter_coach_notes (updated_at);

---------------------------------------------------------------- access helpers
-- security definer so policies can look at other tables without tripping
-- those tables' own policies; kept in the private schema so they aren't
-- callable over the API.

create or replace function private.is_owner() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.accounts a
                 where a.user_id = auth.uid() and a.role = 'owner');
$$;

create or replace function private.is_coach() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.accounts a
                 where a.user_id = auth.uid()
                   and (a.role = 'owner' or a.coach_status = 'approved'));
$$;

create or replace function private.coaches(lid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_owner()
      or (private.is_coach() and exists (select 1 from public.lifter_coaches c
                                         where c.lifter_id = lid and c.coach_id = auth.uid()));
$$;

create or replace function private.can_see(lid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.coaches(lid)
      or exists (select 1 from public.lifters l
                 where l.id = lid and l.lifter_user_id = auth.uid());
$$;

-- Deleted lifters stay readable (so every device learns they're gone) but take no new writes.
create or replace function private.can_log(lid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.can_see(lid)
     and exists (select 1 from public.lifters l where l.id = lid and l.deleted_at is null);
$$;

create or replace function private.can_coach_live(lid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.coaches(lid)
     and exists (select 1 from public.lifters l where l.id = lid and l.deleted_at is null);
$$;

-- A lifter can see their own coaches' names (as message senders).
create or replace function private.coaches_me(uid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.lifters l join public.lifter_coaches c on c.lifter_id = l.id
    where l.lifter_user_id = auth.uid() and l.deleted_at is null and c.coach_id = uid);
$$;

-- Coaches of the same lifter can see each other's names in the share list.
create or replace function private.shares_lifter_with(uid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_coach() and exists (
    select 1 from public.lifter_coaches mine
    join public.lifter_coaches theirs on theirs.lifter_id = mine.lifter_id
    where mine.coach_id = auth.uid() and theirs.coach_id = uid);
$$;

---------------------------------------------------------------- triggers

-- Server clock and signed-in user, never the client's say-so: sync compares
-- these timestamps across devices whose clocks disagree.
create or replace function private.touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;

create or replace function private.touch_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

create or replace function private.lifters_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.created_at := now();
  else
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  new.lifter_email := nullif(lower(btrim(coalesce(new.lifter_email, ''))), '');
  if tg_op = 'INSERT' then
    new.lifter_email_by := case when new.lifter_email is not null then auth.uid() end;
  elsif new.lifter_email is distinct from old.lifter_email then
    new.lifter_email_by := case when new.lifter_email is not null then auth.uid() end;
  else
    new.lifter_email_by := old.lifter_email_by;
  end if;
  -- Only a confirmed email links, so nobody can sign up as someone else's
  -- address and see their program.
  new.lifter_user_id := (select u.id from auth.users u
                         where lower(u.email) = new.lifter_email
                           and u.email_confirmed_at is not null
                         limit 1);
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;

create or replace function private.lifters_add_creator() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.created_by is not null then
    insert into public.lifter_coaches (lifter_id, coach_id, added_by)
    values (new.id, new.created_by, new.created_by)
    on conflict do nothing;
  end if;
  return new;
end $$;

-- Runs when someone signs up or confirms their email: makes their account
-- row, makes the owner the owner, and links any lifter carrying that email
-- (touching the row re-runs lifters_guard, which does the linking).
create or replace function private.on_auth_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.accounts (user_id, email)
  values (new.id, lower(coalesce(new.email, '')))
  on conflict (user_id) do update set email = excluded.email;

  if new.email_confirmed_at is not null and exists (
       select 1 from private.settings s where lower(s.owner_email) = lower(new.email)) then
    update public.accounts set role = 'owner' where user_id = new.id;
  end if;

  -- Invited as a coach by the owner (public.invites, below): approved straight away. Only from 'none',
  -- so a coach the owner later removes stays removed.
  update public.accounts a set coach_status = 'approved', requested_at = coalesce(a.requested_at, now()), decided_at = now()
   where a.user_id = new.id and a.coach_status = 'none'
     and exists (select 1 from public.invites i where i.email = lower(new.email) and i.coach);

  update public.lifters set updated_at = now()
  where lifter_email = lower(new.email) or lifter_user_id = new.id;
  return new;
end $$;

drop trigger if exists spotter_on_auth_user on auth.users;
create trigger spotter_on_auth_user
  after insert or update of email, email_confirmed_at on auth.users
  for each row execute function private.on_auth_user();

drop trigger if exists lifters_guard on public.lifters;
create trigger lifters_guard before insert or update on public.lifters
  for each row execute function private.lifters_guard();
drop trigger if exists lifters_add_creator on public.lifters;
create trigger lifters_add_creator after insert on public.lifters
  for each row execute function private.lifters_add_creator();

drop trigger if exists touch on public.accounts;
create trigger touch before update on public.accounts
  for each row execute function private.touch_at();
drop trigger if exists touch on public.user_prefs;
create trigger touch before insert or update on public.user_prefs
  for each row execute function private.touch_at();

do $$
declare t text;
begin
  foreach t in array array['lifter_marks', 'lifter_row_notes', 'lifter_custom',
                           'lifter_week_notes', 'lifter_coach_notes'] loop
    execute format('drop trigger if exists touch on public.%I', t);
    execute format('create trigger touch before insert or update on public.%I
                    for each row execute function private.touch()', t);
  end loop;
end $$;

---------------------------------------------------------------- actions (called from the app)

create or replace function public.request_coach_access(p_name text default '') returns text
language plpgsql security definer set search_path = '' as $$
declare s text;
begin
  update public.accounts
     set coach_status = 'pending', requested_at = now(), decided_at = null,
         display_name = coalesce(nullif(btrim(p_name), ''), display_name)
   where user_id = auth.uid() and role <> 'owner' and coach_status in ('none', 'declined');
  select coach_status into s from public.accounts where user_id = auth.uid();
  return s;
end $$;

create or replace function public.set_display_name(p_name text) returns void
language sql security definer set search_path = '' as $$
  update public.accounts set display_name = left(btrim(coalesce(p_name, '')), 80)
  where user_id = auth.uid();
$$;

create or replace function public.decide_coach(p_user uuid, p_decision text) returns text
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_owner() then raise exception 'only the owner can approve coaches'; end if;
  if p_decision not in ('approved', 'declined', 'revoked', 'cleared') then raise exception 'bad decision'; end if;
  -- 'cleared': a declined or removed request is deleted. The account is an ordinary
  -- one again (a lifter, if they have a program) and may ask to be a coach again.
  if p_decision = 'cleared' then
    update public.accounts set coach_status = 'none', requested_at = null, decided_at = null
     where user_id = p_user and role <> 'owner' and coach_status in ('declined', 'revoked');
    if not found then raise exception 'only a declined or removed request can be deleted'; end if;
    return 'none';
  end if;
  update public.accounts set coach_status = p_decision, decided_at = now()
   where user_id = p_user and role <> 'owner';
  if not found then raise exception 'no such coach'; end if;
  -- Removed or declined: the lifters this coach gave access to lose it (their
  -- sign-in email is cleared). The programs stay, with the owner and any other
  -- coaches. Emails entered by someone else are left alone. (Rows from before
  -- lifter_email_by existed count as entered by whoever created the lifter.)
  if p_decision in ('revoked', 'declined') then
    update public.lifters set lifter_email = null
     where deleted_at is null and lifter_email is not null
       and (lifter_email_by = p_user or (lifter_email_by is null and created_by = p_user));
  end if;
  return p_decision;
end $$;

create or replace function public.share_lifter(p_lifter uuid, p_email text) returns text
language plpgsql security definer set search_path = '' as $$
declare c uuid;
begin
  if not private.can_coach_live(p_lifter) then raise exception 'not your lifter'; end if;
  select a.user_id into c from public.accounts a
   where a.email = lower(btrim(p_email)) and (a.role = 'owner' or a.coach_status = 'approved');
  if c is null then return 'not-a-coach'; end if;
  insert into public.lifter_coaches (lifter_id, coach_id, added_by)
  values (p_lifter, c, auth.uid()) on conflict do nothing;
  update public.lifters set updated_at = now() where id = p_lifter;  -- so the new coach's devices pick it up
  return 'shared';
end $$;

create or replace function public.unshare_lifter(p_lifter uuid, p_coach uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.coaches(p_lifter) then raise exception 'not your lifter'; end if;
  delete from public.lifter_coaches where lifter_id = p_lifter and coach_id = p_coach;
end $$;

---------------------------------------------------------------- privileges + policies

do $$
declare t text;
begin
  foreach t in array array['accounts', 'lifters', 'lifter_coaches', 'lifter_marks',
                           'lifter_row_notes', 'lifter_custom', 'lifter_week_notes',
                           'lifter_coach_notes', 'user_prefs'] loop
    execute format('alter table public.%I enable row level security', t);
    -- Supabase grants new tables to everyone by default; start from nothing.
    execute format('revoke all on public.%I from public, anon, authenticated', t);
  end loop;
end $$;

grant select on public.accounts, public.lifter_coaches to authenticated;
grant select, insert, update on public.lifters, public.lifter_marks, public.lifter_row_notes,
  public.lifter_custom, public.lifter_week_notes, public.lifter_coach_notes,
  public.user_prefs to authenticated;

-- accounts: yourself; the owner sees everyone (for approvals); coaches see
-- their co-coaches. Nobody writes it directly: only the functions above.
drop policy if exists read on public.accounts;
create policy read on public.accounts for select to authenticated
  using (user_id = (select auth.uid()) or (select private.is_owner()) or private.shares_lifter_with(user_id)
         or private.coaches_me(user_id));

-- lifters: coaches create and edit; the lifter only reads. No deletes:
-- deleting is setting deleted_at, so other devices hear about it.
drop policy if exists read on public.lifters;
create policy read on public.lifters for select to authenticated
  using (private.can_see(id));
drop policy if exists add on public.lifters;
create policy add on public.lifters for insert to authenticated
  with check ((select private.is_coach()));
drop policy if exists edit on public.lifters;
create policy edit on public.lifters for update to authenticated
  using (private.coaches(id)) with check (private.coaches(id));

drop policy if exists read on public.lifter_coaches;
create policy read on public.lifter_coaches for select to authenticated
  using (coach_id = (select auth.uid()) or private.coaches(lifter_id));

do $$
declare t text;
begin
  -- The log: the lifter and their coaches.
  foreach t in array array['lifter_marks', 'lifter_row_notes', 'lifter_custom', 'lifter_week_notes'] loop
    execute format('drop policy if exists read on public.%I', t);
    execute format('create policy read on public.%I for select to authenticated using (private.can_see(lifter_id))', t);
    execute format('drop policy if exists add on public.%I', t);
    execute format('create policy add on public.%I for insert to authenticated with check (private.can_log(lifter_id))', t);
    execute format('drop policy if exists edit on public.%I', t);
    execute format('create policy edit on public.%I for update to authenticated using (private.can_see(lifter_id)) with check (private.can_log(lifter_id))', t);
  end loop;
end $$;

-- Manage Program notes: coaches only, never the lifter.
drop policy if exists read on public.lifter_coach_notes;
create policy read on public.lifter_coach_notes for select to authenticated
  using (private.coaches(lifter_id));
drop policy if exists add on public.lifter_coach_notes;
create policy add on public.lifter_coach_notes for insert to authenticated
  with check (private.can_coach_live(lifter_id));
drop policy if exists edit on public.lifter_coach_notes;
create policy edit on public.lifter_coach_notes for update to authenticated
  using (private.coaches(lifter_id)) with check (private.can_coach_live(lifter_id));

drop policy if exists own on public.user_prefs;
create policy own on public.user_prefs for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Functions: Postgres lets everyone execute new functions; narrow that.
revoke execute on all functions in schema private from public, anon;
grant execute on function private.is_owner(), private.is_coach(), private.coaches(uuid),
  private.can_see(uuid), private.can_log(uuid), private.can_coach_live(uuid),
  private.shares_lifter_with(uuid), private.coaches_me(uuid) to authenticated;
revoke execute on function public.request_coach_access(text), public.set_display_name(text),
  public.decide_coach(uuid, text), public.share_lifter(uuid, text),
  public.unshare_lifter(uuid, uuid) from public, anon;
grant execute on function public.request_coach_access(text), public.set_display_name(text),
  public.decide_coach(uuid, text), public.share_lifter(uuid, text),
  public.unshare_lifter(uuid, uuid) to authenticated;

-- Supabase's auth service creates the users that fire on_auth_user.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    grant usage on schema private to supabase_auth_admin;
  end if;
end $$;

---------------------------------------------------------------- live updates

do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['lifters', 'lifter_coaches', 'lifter_marks', 'lifter_row_notes',
                             'lifter_custom', 'lifter_week_notes', 'lifter_coach_notes',
                             'accounts'] loop
      if not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;

---------------------------------------------------------------- messages + notifications
-- One conversation per lifter. The lifter chooses (lifter_settings.team_thread):
--   on  (default) one thread, 'team', with the lifter and all their coaches;
--   off           one private thread per coach, keyed by that coach's user id.
-- Whichever kind is switched off stays readable as history but takes no posts.
-- A coach sees the team thread only from when they started coaching the
-- lifter (lifter_coaches.created_at). The owner takes part only in lifters
-- they coach, like anyone else: seeing every program isn't reading every chat.

create table if not exists public.lifter_settings (
  lifter_id      uuid primary key references public.lifters(id) on delete cascade,
  team_thread    boolean not null default true,
  -- Week labels the lifter has been told about ("Notify" in Manage program).
  notified_weeks jsonb not null default '[]'::jsonb,
  notified_by    uuid,
  notified_at    timestamptz,
  updated_at     timestamptz not null default now()
);
-- When the owner last cleared each thread ({ thread: time }): devices drop
-- their cached copies of anything older.
alter table public.lifter_settings add column if not exists cleared jsonb not null default '{}'::jsonb;

-- Ids come from the app, so a message queued offline can be retried safely.
create table if not exists public.messages (
  id          uuid primary key default gen_random_uuid(),
  lifter_id   uuid not null references public.lifters(id) on delete cascade,
  thread      text not null check (thread = 'team' or thread ~ '^[0-9a-f-]{36}$'),
  sender_id   uuid not null default auth.uid() references auth.users(id) on delete cascade,
  body        text not null check (length(btrim(body)) between 1 and 4000),
  created_at  timestamptz not null default now(),
  notified_at timestamptz
);
create index if not exists messages_thread_idx on public.messages (lifter_id, thread, created_at);
create index if not exists messages_created_idx on public.messages (created_at);

create table if not exists public.message_reads (
  user_id   uuid not null default auth.uid() references auth.users(id) on delete cascade,
  lifter_id uuid not null references public.lifters(id) on delete cascade,
  thread    text not null,
  read_at   timestamptz not null default now(),
  primary key (user_id, lifter_id, thread)
);

-- Things worth a notification besides messages. Unique, so each finished day
-- (and each batch of new weeks) notifies once however often it's re-ticked.
create table if not exists public.lifter_events (
  id          uuid primary key default gen_random_uuid(),
  lifter_id   uuid not null references public.lifters(id) on delete cascade,
  kind        text not null check (kind in ('session_done', 'new_week')),
  week        text not null default '',
  day         text not null default '',
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now(),
  notified_at timestamptz,
  unique (lifter_id, kind, week, day)
);
create index if not exists lifter_events_created_idx on public.lifter_events (created_at);

-- One row per device that turned notifications on. prefs: which kinds it wants.
create table if not exists public.push_subscriptions (
  endpoint   text primary key,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  p256dh     text not null,
  auth       text not null,
  prefs      jsonb not null default '{"messages": true, "sessions": true, "weeks": true}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function private.is_athlete(lid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.lifters l
                 where l.id = lid and l.lifter_user_id = auth.uid() and l.deleted_at is null);
$$;
-- When this coach started coaching the lifter; null if they don't (or aren't a coach now).
create or replace function private.coach_since(lid uuid) returns timestamptz
language sql stable security definer set search_path = '' as $$
  select c.created_at from public.lifter_coaches c
  where c.lifter_id = lid and c.coach_id = auth.uid() and private.is_coach();
$$;
create or replace function private.team_on(lid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select s.team_thread from public.lifter_settings s where s.lifter_id = lid), true);
$$;
create or replace function private.can_read_msg(lid uuid, th text, sent timestamptz) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_athlete(lid)
      or (private.coach_since(lid) is not null
          and ((th = 'team' and sent >= private.coach_since(lid)) or th = auth.uid()::text));
$$;
create or replace function private.can_post(lid uuid, th text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.lifters l where l.id = lid and l.deleted_at is null)
     and case
       when th = 'team' then private.team_on(lid)
            and (private.is_athlete(lid) or private.coach_since(lid) is not null)
       else not private.team_on(lid)
            and ((private.is_athlete(lid) and exists (select 1 from public.lifter_coaches c
                                                      where c.lifter_id = lid and c.coach_id::text = th))
              or (private.coach_since(lid) is not null and th = auth.uid()::text))
     end;
$$;

-- A reply points at the message it answers (when that message is gone, say
-- after the owner clears a thread, the pointer simply empties).
alter table public.messages add column if not exists reply_to uuid references public.messages(id) on delete set null;

-- The server decides who sent it and when, not the app. A reply only points at a
-- message in the same thread that the sender can read; anything else is dropped.
create or replace function private.messages_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.sender_id := auth.uid();
  new.created_at := now();
  new.notified_at := null;
  new.body := btrim(new.body);
  if new.reply_to is not null and not exists (
    select 1 from public.messages m
    where m.id = new.reply_to and m.lifter_id = new.lifter_id and m.thread = new.thread) then
    new.reply_to := null;
  end if;
  return new;
end $$;
drop trigger if exists messages_guard on public.messages;
create trigger messages_guard before insert on public.messages
  for each row execute function private.messages_guard();

create or replace function private.events_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.created_by := auth.uid();
  new.created_at := now();
  new.notified_at := null;
  return new;
end $$;
drop trigger if exists events_guard on public.lifter_events;
create trigger events_guard before insert on public.lifter_events
  for each row execute function private.events_guard();

drop trigger if exists touch on public.push_subscriptions;
create trigger touch before insert or update on public.push_subscriptions
  for each row execute function private.touch_at();

-- Weeks already in a program aren't "new": settle them when a lifter appears,
-- and for lifters that existed before this section was added.
create or replace function private.program_weeks(p jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_agg(w ->> 'week'), '[]'::jsonb)
  from jsonb_array_elements(case when jsonb_typeof(p -> 'weeks') = 'array' then p -> 'weeks' else '[]'::jsonb end) w;
$$;
create or replace function private.lifters_settings() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.lifter_settings (lifter_id, notified_weeks)
  values (new.id, private.program_weeks(new.program)) on conflict do nothing;
  return new;
end $$;
drop trigger if exists lifters_settings on public.lifters;
create trigger lifters_settings after insert on public.lifters
  for each row execute function private.lifters_settings();
insert into public.lifter_settings (lifter_id, notified_weeks)
select id, private.program_weeks(program) from public.lifters
on conflict do nothing;

-- The lifter's own choice.
create or replace function public.set_team_thread(p_lifter uuid, p_on boolean) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_athlete(p_lifter) then raise exception 'only the lifter chooses this'; end if;
  insert into public.lifter_settings (lifter_id, team_thread) values (p_lifter, p_on)
  on conflict (lifter_id) do update set team_thread = excluded.team_thread, updated_at = now();
  return p_on;
end $$;

-- Who may read a thread's messages at all (for its read markers, "Seen").
create or replace function private.in_thread(lid uuid, th text) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_athlete(lid)
      or (private.coach_since(lid) is not null and (th = 'team' or th = auth.uid()::text));
$$;

-- "Clear" (the owner only): deletes every message in one thread, for
-- everyone. The team thread goes whole, all coaches' messages included; a
-- private thread only if it's the owner's own. Can't be undone.
create or replace function public.clear_thread(p_lifter uuid, p_thread text) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  if not private.is_owner() then raise exception 'only the owner can clear a conversation'; end if;
  if private.coach_since(p_lifter) is null then raise exception 'you are not in this conversation'; end if;
  if p_thread <> 'team' and p_thread <> auth.uid()::text then raise exception 'not your conversation'; end if;
  delete from public.messages where lifter_id = p_lifter and thread = p_thread;
  get diagnostics n = row_count;
  delete from public.message_reads where lifter_id = p_lifter and thread = p_thread;
  insert into public.lifter_settings (lifter_id, cleared)
  values (p_lifter, jsonb_build_object(p_thread, now()))
  on conflict (lifter_id) do update
    set cleared = public.lifter_settings.cleared || jsonb_build_object(p_thread, now()), updated_at = now();
  return n;
end $$;

-- "Notify [lifter]" after adding weeks: at most once per batch of new weeks,
-- shared by all their coaches, whatever the app sends.
create or replace function public.notify_new_week(p_lifter uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare cur jsonb; told jsonb; fresh text; ev uuid;
begin
  if not private.can_coach_live(p_lifter) then raise exception 'not your lifter'; end if;
  select private.program_weeks(l.program) into cur from public.lifters l where l.id = p_lifter;
  select s.notified_weeks into told from public.lifter_settings s where s.lifter_id = p_lifter;
  select string_agg(w, ', ') into fresh
  from jsonb_array_elements_text(cur) w where not coalesce(told, '[]'::jsonb) ? w;
  if fresh is null then return null; end if;
  insert into public.lifter_settings (lifter_id, notified_weeks, notified_by, notified_at)
  values (p_lifter, cur, auth.uid(), now())
  on conflict (lifter_id) do update
    set notified_weeks = excluded.notified_weeks, notified_by = excluded.notified_by,
        notified_at = excluded.notified_at, updated_at = now();
  insert into public.lifter_events (lifter_id, kind, week)
  values (p_lifter, 'new_week', fresh)
  on conflict (lifter_id, kind, week, day) do nothing
  returning id into ev;
  return ev;
end $$;

do $$
declare t text;
begin
  foreach t in array array['lifter_settings', 'messages', 'message_reads', 'lifter_events', 'push_subscriptions'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
  end loop;
end $$;
grant select on public.lifter_settings to authenticated;
grant select, insert on public.messages, public.lifter_events to authenticated;
grant select, insert, update on public.message_reads to authenticated;
grant select, insert, update, delete on public.push_subscriptions to authenticated;

-- Lifters also see who coaches them (to pick a coach to message). Replaces the
-- coaches-only version above, which runs before is_athlete() exists.
drop policy if exists read on public.lifter_coaches;
create policy read on public.lifter_coaches for select to authenticated
  using (coach_id = (select auth.uid()) or private.coaches(lifter_id) or private.is_athlete(lifter_id));

drop policy if exists read on public.lifter_settings;
create policy read on public.lifter_settings for select to authenticated using (private.can_see(lifter_id));

drop policy if exists read on public.messages;
create policy read on public.messages for select to authenticated
  using (private.can_read_msg(lifter_id, thread, created_at));
drop policy if exists add on public.messages;
create policy add on public.messages for insert to authenticated
  with check (sender_id = (select auth.uid()) and private.can_post(lifter_id, thread));

-- Everyone in a thread sees how far the others have read it ("Seen").
drop policy if exists seen on public.message_reads;
create policy seen on public.message_reads for select to authenticated
  using (private.in_thread(lifter_id, thread));
drop policy if exists own on public.message_reads;
create policy own on public.message_reads for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and private.can_see(lifter_id));

drop policy if exists read on public.lifter_events;
create policy read on public.lifter_events for select to authenticated using (private.can_see(lifter_id));
-- Only the lifter reports finishing a day; new weeks go through notify_new_week().
-- A trophy is announced by the lifter who earned it, or by a coach who awarded it.
drop policy if exists add on public.lifter_events;
create policy add on public.lifter_events for insert to authenticated
  with check ((kind = 'session_done' and private.is_athlete(lifter_id))
           or (kind = 'trophy' and (private.is_athlete(lifter_id) or private.can_coach_live(lifter_id))));

drop policy if exists own on public.push_subscriptions;
create policy own on public.push_subscriptions for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

revoke execute on all functions in schema private from public, anon;
grant execute on function private.is_athlete(uuid), private.coach_since(uuid), private.team_on(uuid),
  private.can_read_msg(uuid, text, timestamptz), private.can_post(uuid, text), private.in_thread(uuid, text) to authenticated;
revoke execute on function public.set_team_thread(uuid, boolean), public.notify_new_week(uuid), public.clear_thread(uuid, text) from public, anon;
grant execute on function public.set_team_thread(uuid, boolean), public.notify_new_week(uuid), public.clear_thread(uuid, text) to authenticated;

---------------------------------------------------------------- trophies and levels
-- What a lifter has earned (kept for good), their logged PRs, and the two
-- facts the strength levels need (which standards, and bodyweight).
-- Trophies the app works out itself (levels, clubs, consistency) are written by
-- the lifter's own device; "award:" ones are a coach's to give, and to take back.

alter table public.lifter_events drop constraint if exists lifter_events_kind_check;
alter table public.lifter_events add constraint lifter_events_kind_check
  check (kind in ('session_done', 'new_week', 'trophy', 'video'));

alter table public.lifter_settings add column if not exists sex text check (sex in ('m', 'f'));
alter table public.lifter_settings add column if not exists bodyweight numeric(5, 1) check (bodyweight between 20 and 300);

create table if not exists public.lifter_trophies (
  id         uuid primary key default gen_random_uuid(),
  lifter_id  uuid not null references public.lifters(id) on delete cascade,
  trophy     text not null check (trophy ~ '^[a-z0-9:_.-]{3,80}$'),
  earned_on  date not null default current_date,
  cls        text not null default '' check (length(cls) <= 40),
  title      text not null default '' check (length(title) <= 60),   -- a coach's own award
  note       text not null default '' check (length(note) <= 200),
  awarded_by uuid,
  created_at timestamptz not null default now(),
  unique (lifter_id, trophy)
);
create index if not exists lifter_trophies_created_idx on public.lifter_trophies (created_at);

create table if not exists public.lifter_prs (
  id           uuid primary key default gen_random_uuid(),
  lifter_id    uuid not null references public.lifters(id) on delete cascade,
  lift         text not null check (lift in ('squat', 'bench', 'deadlift')),
  kg           numeric(6, 2) not null check (kg > 0 and kg <= 600),
  reps         integer not null default 1 check (reps between 1 and 30),
  on_date      date not null default current_date,
  created_by   uuid default auth.uid(),
  confirmed_by uuid,
  confirmed_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists lifter_prs_updated_idx on public.lifter_prs (updated_at);

-- The server says who gave an award and when; a lifter's own PR starts
-- unconfirmed, and one a coach logs is confirmed by them.
create or replace function private.trophies_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.awarded_by := case when new.trophy like 'award:%' then auth.uid() else null end;
  new.created_at := now();
  return new;
end $$;
drop trigger if exists trophies_guard on public.lifter_trophies;
create trigger trophies_guard before insert on public.lifter_trophies
  for each row execute function private.trophies_guard();

create or replace function private.prs_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.created_at := now();
    if private.is_athlete(new.lifter_id) then
      new.confirmed_by := null; new.confirmed_at := null;
    else
      new.confirmed_by := auth.uid(); new.confirmed_at := now();
    end if;
  else
    -- Only a coach's confirmation can change on a PR already logged.
    if new.lifter_id <> old.lifter_id or new.lift <> old.lift or new.kg <> old.kg
       or new.reps <> old.reps or new.on_date <> old.on_date then
      raise exception 'a logged PR cannot be edited';
    end if;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    if new.confirmed_by is not null then new.confirmed_by := auth.uid(); new.confirmed_at := now();
    else new.confirmed_at := null; end if;
  end if;
  return new;
end $$;
drop trigger if exists prs_guard on public.lifter_prs;
create trigger prs_guard before insert or update on public.lifter_prs
  for each row execute function private.prs_guard();
drop trigger if exists touch on public.lifter_prs;
create trigger touch before insert or update on public.lifter_prs
  for each row execute function private.touch_at();

-- Standards (men's / women's) and bodyweight: the lifter's, or a coach's for them.
create or replace function public.set_trophy_profile(p_lifter uuid, p_sex text, p_bw numeric) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not (private.is_athlete(p_lifter) or private.can_coach_live(p_lifter)) then raise exception 'not your lifter'; end if;
  if p_sex is not null and p_sex not in ('m', 'f') then raise exception 'standards are m or f'; end if;
  insert into public.lifter_settings (lifter_id, sex, bodyweight) values (p_lifter, p_sex, p_bw)
  on conflict (lifter_id) do update set sex = excluded.sex, bodyweight = excluded.bodyweight, updated_at = now();
end $$;

do $$
declare t text;
begin
  foreach t in array array['lifter_trophies', 'lifter_prs'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
  end loop;
end $$;
grant select, insert, delete on public.lifter_trophies to authenticated;
grant select, insert, update, delete on public.lifter_prs to authenticated;

drop policy if exists read on public.lifter_trophies;
create policy read on public.lifter_trophies for select to authenticated using (private.can_see(lifter_id));
drop policy if exists add on public.lifter_trophies;
create policy add on public.lifter_trophies for insert to authenticated
  with check ((trophy not like 'award:%' and private.is_athlete(lifter_id))
           or (trophy like 'award:%' and private.can_coach_live(lifter_id)));
drop policy if exists take_back on public.lifter_trophies;
create policy take_back on public.lifter_trophies for delete to authenticated
  using (trophy like 'award:%' and private.can_coach_live(lifter_id));

drop policy if exists read on public.lifter_prs;
create policy read on public.lifter_prs for select to authenticated using (private.can_see(lifter_id));
drop policy if exists add on public.lifter_prs;
create policy add on public.lifter_prs for insert to authenticated
  with check (private.is_athlete(lifter_id) or private.can_coach_live(lifter_id));
drop policy if exists confirm on public.lifter_prs;
create policy confirm on public.lifter_prs for update to authenticated
  using (private.can_coach_live(lifter_id)) with check (private.can_coach_live(lifter_id));
drop policy if exists remove on public.lifter_prs;
create policy remove on public.lifter_prs for delete to authenticated
  using (private.can_coach_live(lifter_id)
         or (created_by = (select auth.uid()) and confirmed_by is null and private.is_athlete(lifter_id)));

revoke execute on function private.trophies_guard(), private.prs_guard() from public, anon;
revoke execute on function public.set_trophy_profile(uuid, text, numeric) from public, anon;
grant execute on function public.set_trophy_profile(uuid, text, numeric) to authenticated;

do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['messages', 'lifter_settings', 'lifter_events', 'message_reads', 'lifter_trophies', 'lifter_prs'] loop
      if not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;

---------------------------------------------------------------- the owner's private files
-- Files only the owner may read: the Program Hub (program-hub.html) lives here
-- instead of on the public site. The app downloads it to the owner's device.
-- Nobody can write through the API; the owner uploads with the SQL editor
-- (node publish-hub.js writes that SQL).
create table if not exists public.owner_assets (
  id         text primary key,
  version    text not null default '',
  body       text not null default '',
  updated_at timestamptz not null default now()
);
drop trigger if exists touch on public.owner_assets;
create trigger touch before insert or update on public.owner_assets
  for each row execute function private.touch_at();
-- members: also readable by every signed-in account, not just the owner (the Velocity Tracker).
alter table public.owner_assets add column if not exists members boolean not null default false;
alter table public.owner_assets enable row level security;
revoke all on public.owner_assets from public, anon, authenticated;
grant select on public.owner_assets to authenticated;
drop policy if exists read on public.owner_assets;
create policy read on public.owner_assets for select to authenticated using (private.is_owner() or members);

---------------------------------------------------------------- payments
-- A coach's record of each month's payment from a lifter they created. Unpaid
-- unless marked; the day it was paid and the amount (pesos, pounds or dollars) are
-- optional. Only the coach who created the lifter reads and writes them; the lifter
-- reads their own. Other coaches on the same lifter don't see them.
create table if not exists public.lifter_payments (
  lifter_id  uuid not null references public.lifters(id) on delete cascade,
  month      text not null check (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  paid       boolean not null default false,
  paid_on    date,
  amount     numeric(12, 2) check (amount is null or (amount >= 0 and amount < 10000000)),
  currency   text not null default 'PHP' check (currency in ('PHP', 'GBP', 'USD')),
  updated_at timestamptz not null default now(),
  updated_by uuid,
  primary key (lifter_id, month)
);
-- A month the coach deleted from the list. A row, not a real delete, so other devices
-- learn of it through the same updated_at cursor as every other change.
alter table public.lifter_payments add column if not exists removed boolean not null default false;
create index if not exists lifter_payments_updated_idx on public.lifter_payments (updated_at);

create or replace function private.made_lifter(lid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_coach() and exists (select 1 from public.lifters l
    where l.id = lid and l.created_by = auth.uid() and l.deleted_at is null);
$$;
create or replace function private.payments_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists payments_guard on public.lifter_payments;
create trigger payments_guard before insert or update on public.lifter_payments
  for each row execute function private.payments_guard();

alter table public.lifter_payments enable row level security;
revoke all on public.lifter_payments from public, anon, authenticated;
grant select, insert, update on public.lifter_payments to authenticated;
drop policy if exists read on public.lifter_payments;
create policy read on public.lifter_payments for select to authenticated
  using (private.made_lifter(lifter_id) or private.is_athlete(lifter_id));
drop policy if exists add on public.lifter_payments;
create policy add on public.lifter_payments for insert to authenticated
  with check (private.made_lifter(lifter_id));
drop policy if exists edit on public.lifter_payments;
create policy edit on public.lifter_payments for update to authenticated
  using (private.made_lifter(lifter_id)) with check (private.made_lifter(lifter_id));
revoke execute on function private.made_lifter(uuid), private.payments_guard() from public, anon;
grant execute on function private.made_lifter(uuid) to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'lifter_payments') then
    alter publication supabase_realtime add table public.lifter_payments;
  end if;
end $$;

---------------------------------------------------------------- reactions
-- One emoji reaction per person per thing (Instagram style): to a message (the lifter
-- and their coaches, whoever can read it), or, coaches only, to a weekly note or a
-- training day. Removing one sets emoji to null, so it syncs like any change.
-- target_id: the message's id, the week ('2'), or the day ('2|1').
create table if not exists public.lifter_reactions (
  id          uuid primary key default gen_random_uuid(),
  lifter_id   uuid not null references public.lifters(id) on delete cascade,
  target_type text not null check (target_type in ('message', 'note', 'day')),
  target_id   text not null check (length(target_id) between 1 and 64),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  emoji       text check (emoji is null or emoji in ('heart', 'up', '100', 'fire', 'sleep', 'tired', 'devil', 'sad', 'cry', 'happy', 'worried')),
  updated_at  timestamptz not null default now(),
  unique (lifter_id, target_type, target_id, user_id)
);
-- Four more (sad, crying, happy, worried) than the first release: widen the list on a database made before.
alter table public.lifter_reactions drop constraint if exists lifter_reactions_emoji_check;
alter table public.lifter_reactions add constraint lifter_reactions_emoji_check
  check (emoji is null or emoji in ('heart', 'up', '100', 'fire', 'sleep', 'tired', 'devil', 'sad', 'cry', 'happy', 'worried'));
create index if not exists lifter_reactions_updated_idx on public.lifter_reactions (updated_at);

create or replace function private.reactions_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.user_id := auth.uid();
  else
    new.user_id := old.user_id; new.lifter_id := old.lifter_id;
    new.target_type := old.target_type; new.target_id := old.target_id;
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists reactions_guard on public.lifter_reactions;
create trigger reactions_guard before insert or update on public.lifter_reactions
  for each row execute function private.reactions_guard();

alter table public.lifter_reactions enable row level security;
revoke all on public.lifter_reactions from public, anon, authenticated;
grant select, insert, update on public.lifter_reactions to authenticated;
drop policy if exists read on public.lifter_reactions;
create policy read on public.lifter_reactions for select to authenticated
  using (private.can_see(lifter_id)
         and (target_type <> 'message' or exists (
           select 1 from public.messages m where m.id::text = target_id and m.lifter_id = lifter_reactions.lifter_id)));
drop policy if exists add on public.lifter_reactions;
create policy add on public.lifter_reactions for insert to authenticated
  with check (user_id = (select auth.uid())
    and ((target_type in ('note', 'day') and private.can_coach_live(lifter_id))
      or (target_type = 'message' and private.can_log(lifter_id) and exists (
           select 1 from public.messages m where m.id::text = target_id and m.lifter_id = lifter_reactions.lifter_id))));
drop policy if exists change on public.lifter_reactions;
create policy change on public.lifter_reactions for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid())
    and ((target_type in ('note', 'day') and private.can_coach_live(lifter_id))
      or (target_type = 'message' and private.can_log(lifter_id))));
revoke execute on function private.reactions_guard() from public, anon;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'lifter_reactions') then
    alter publication supabase_realtime add table public.lifter_reactions;
  end if;
end $$;

---------------------------------------------------------------- vid review
-- Videos a lifter or a coach uploads for review: the file in the private storage bucket
-- 'vid-review' (named <lifter id>/<video id>.mp4), its details and a tiny thumbnail here.
-- The lifter and their coaches add and watch; only coaches delete (file and row).
-- 30 MB is the most one file may be (the app also refuses before uploading).
create table if not exists public.lifter_videos (
  id          uuid primary key default gen_random_uuid(),
  lifter_id   uuid not null references public.lifters(id) on delete cascade,
  uploaded_by uuid,
  lift        text not null check (length(btrim(lift)) between 1 and 60),
  reps        text check (reps is null or length(reps) <= 20),
  set_label   text check (set_label is null or length(set_label) <= 40),
  size_bytes  integer not null check (size_bytes between 1 and 31457280),
  duration    numeric(7, 1) check (duration is null or (duration >= 0 and duration < 100000)),
  thumb       text check (thumb is null or length(thumb) <= 60000),
  created_at  timestamptz not null default now()
);
-- The weight on the bar, as typed ("140 kg", "bodyweight"): added after the first release, so an alter for a database made before.
alter table public.lifter_videos add column if not exists weight text;
-- Notes from whoever uploaded it (free text, emoji included).
alter table public.lifter_videos add column if not exists notes text;
alter table public.lifter_videos drop constraint if exists lifter_videos_notes_check;
alter table public.lifter_videos add constraint lifter_videos_notes_check check (notes is null or length(notes) <= 1000);
alter table public.lifter_videos drop constraint if exists lifter_videos_weight_check;
alter table public.lifter_videos add constraint lifter_videos_weight_check check (weight is null or length(weight) <= 20);
create index if not exists lifter_videos_lifter_idx on public.lifter_videos (lifter_id, created_at);

create or replace function private.videos_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.uploaded_by := auth.uid();
  new.created_at := now();
  return new;
end $$;
drop trigger if exists videos_guard on public.lifter_videos;
create trigger videos_guard before insert on public.lifter_videos
  for each row execute function private.videos_guard();

alter table public.lifter_videos enable row level security;
revoke all on public.lifter_videos from public, anon, authenticated;
grant select, insert, delete on public.lifter_videos to authenticated;
drop policy if exists read on public.lifter_videos;
create policy read on public.lifter_videos for select to authenticated using (private.can_see(lifter_id));
drop policy if exists add on public.lifter_videos;
create policy add on public.lifter_videos for insert to authenticated with check (private.can_log(lifter_id));
drop policy if exists remove on public.lifter_videos;
create policy remove on public.lifter_videos for delete to authenticated using (private.coaches(lifter_id));

-- Which lifter does a file name belong to? Only names shaped <uuid>/<uuid>.mp4 count.
create or replace function private.vid_lifter(name text) returns uuid
language plpgsql immutable set search_path = '' as $$
begin
  if name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.mp4$' then
    return split_part(name, '/', 1)::uuid;
  end if;
  return null;
end $$;
create or replace function private.vid_can_see(name text) returns boolean
language sql stable set search_path = '' as $$ select coalesce(private.can_see(private.vid_lifter(name)), false) $$;
create or replace function private.vid_can_add(name text) returns boolean
language sql stable set search_path = '' as $$ select coalesce(private.can_log(private.vid_lifter(name)), false) $$;
create or replace function private.vid_can_delete(name text) returns boolean
language sql stable set search_path = '' as $$ select coalesce(private.coaches(private.vid_lifter(name)), false) $$;
revoke execute on function private.videos_guard(), private.vid_lifter(text), private.vid_can_see(text), private.vid_can_add(text), private.vid_can_delete(text) from public, anon;
grant execute on function private.vid_lifter(text), private.vid_can_see(text), private.vid_can_add(text), private.vid_can_delete(text) to authenticated;

-- The bucket: private, mp4 only, 30 MB a file.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('vid-review', 'vid-review', false, 31457280, array['video/mp4'])
on conflict (id) do update set public = false, file_size_limit = 31457280, allowed_mime_types = array['video/mp4'];
drop policy if exists vid_read on storage.objects;
create policy vid_read on storage.objects for select to authenticated
  using (bucket_id = 'vid-review' and private.vid_can_see(name));
drop policy if exists vid_add on storage.objects;
create policy vid_add on storage.objects for insert to authenticated
  with check (bucket_id = 'vid-review' and private.vid_can_add(name));
drop policy if exists vid_remove on storage.objects;
create policy vid_remove on storage.objects for delete to authenticated
  using (bucket_id = 'vid-review' and private.vid_can_delete(name));

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'lifter_videos') then
    alter publication supabase_realtime add table public.lifter_videos;
  end if;
end $$;

-- A new video is announced to the lifter's coaches: a lifter_events row (week = the video's id, so once per
-- video) that the notify function turns into a push. Anyone who can add to the lifter's log may announce.
alter table public.lifter_events drop constraint if exists lifter_events_kind_check;
alter table public.lifter_events add constraint lifter_events_kind_check
  check (kind in ('session_done', 'new_week', 'trophy', 'video'));
drop policy if exists add on public.lifter_events;
create policy add on public.lifter_events for insert to authenticated
  with check ((kind = 'session_done' and private.is_athlete(lifter_id))
           or (kind = 'trophy' and (private.is_athlete(lifter_id) or private.can_coach_live(lifter_id)))
           or (kind = 'video' and private.can_log(lifter_id)));

---------------------------------------------------------------- storage meter
-- For the owner's Home page: how full the free plan is. The database's size and the video
-- files' total (the free plan allows 500 MB of database and 1 GB of files). Null for anyone else.
create or replace function public.owner_storage_usage() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.is_owner() then return null; end if;
  return jsonb_build_object(
    'db_bytes', pg_database_size(current_database()),
    'video_bytes', coalesce((select sum(size_bytes) from public.lifter_videos), 0)::bigint,
    'video_count', (select count(*) from public.lifter_videos));
end $$;
revoke execute on function public.owner_storage_usage() from public, anon;
grant execute on function public.owner_storage_usage() to authenticated;

---------------------------------------------------------------- announcements
-- A pop-up on the Home page. The owner announces to everyone (scope 'all', the owner included);
-- a coach announces to the lifters they coach (scope 'lifters'). Each person closes it for
-- themselves (announcement_closed), and a person only ever sees what was announced after they
-- joined (everyone) or after their coach started coaching them.
create table if not exists public.announcements (
  id         uuid primary key default gen_random_uuid(),
  author_id  uuid not null default auth.uid() references auth.users(id) on delete cascade,
  scope      text not null check (scope in ('lifters', 'all')),
  body       text not null check (length(btrim(body)) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index if not exists announcements_created_idx on public.announcements (created_at);

create or replace function private.announcements_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.author_id := auth.uid();
  new.created_at := now();
  new.body := btrim(new.body);
  return new;
end $$;
drop trigger if exists announcements_guard on public.announcements;
create trigger announcements_guard before insert on public.announcements
  for each row execute function private.announcements_guard();

-- May this person read it? Its author; everyone, for one to all (if it came after they joined);
-- the lifters of a coach, for one to lifters (if it came after that coach started coaching them).
create or replace function private.can_read_announcement(a_author uuid, a_scope text, a_at timestamptz) returns boolean
language sql stable security definer set search_path = '' as $$
  select a_author = auth.uid()
      or (a_scope = 'all' and exists (select 1 from public.accounts x where x.user_id = auth.uid() and x.created_at <= a_at))
      or (a_scope = 'lifters' and exists (
            select 1 from public.lifters l join public.lifter_coaches c on c.lifter_id = l.id
            where l.lifter_user_id = auth.uid() and l.deleted_at is null
              and c.coach_id = a_author and c.created_at <= a_at));
$$;

alter table public.announcements enable row level security;
revoke all on public.announcements from public, anon, authenticated;
grant select, insert, delete on public.announcements to authenticated;
drop policy if exists read on public.announcements;
create policy read on public.announcements for select to authenticated
  using (private.can_read_announcement(author_id, scope, created_at));
drop policy if exists add on public.announcements;
create policy add on public.announcements for insert to authenticated
  with check ((scope = 'all' and private.is_owner()) or (scope = 'lifters' and private.is_coach()));
drop policy if exists remove on public.announcements;
create policy remove on public.announcements for delete to authenticated
  using (author_id = (select auth.uid()) or private.is_owner());

create table if not exists public.announcement_closed (
  announcement_id uuid not null references public.announcements(id) on delete cascade,
  user_id         uuid not null default auth.uid() references auth.users(id) on delete cascade,
  closed_at       timestamptz not null default now(),
  primary key (announcement_id, user_id)
);
alter table public.announcement_closed enable row level security;
revoke all on public.announcement_closed from public, anon, authenticated;
grant select, insert, delete on public.announcement_closed to authenticated;
drop policy if exists own on public.announcement_closed;
create policy own on public.announcement_closed for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid())
    and exists (select 1 from public.announcements a where a.id = announcement_id));

revoke execute on function private.announcements_guard(), private.can_read_announcement(uuid, text, timestamptz) from public, anon;
grant execute on function private.can_read_announcement(uuid, text, timestamptz) to authenticated;

do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['announcements'] loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
        execute format('alter publication supabase_realtime add table public.%I', t);
      end if;
    end loop;
  end if;
end $$;

---------------------------------------------------------------- invite-only sign-up
-- New accounts are by invitation. Supabase Auth asks public.hook_before_user_created before it creates
-- any user (Authentication > Hooks > "Before User Created", Postgres function public.hook_before_user_created;
-- turned on once, in the dashboard). Let in: an email a coach put on a lifter (lifters.lifter_email), one the
-- owner invited here, and the owner's own. Accounts that already exist sign in as before: the hook only runs
-- when an account would be created.
create table if not exists public.invites (
  email      text primary key check (email = lower(btrim(email)) and email like '%_@_%'),
  coach      boolean not null default false,   -- approved as a coach the moment they sign up (private.on_auth_user)
  invited_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
drop trigger if exists touch on public.invites;
create trigger touch before update on public.invites
  for each row execute function private.touch_at();
alter table public.invites enable row level security;
revoke all on public.invites from public, anon, authenticated;
grant select, insert, update, delete on public.invites to authenticated;
drop policy if exists owner_only on public.invites;
create policy owner_only on public.invites for all to authenticated
  using ((select private.is_owner())) with check ((select private.is_owner()));

create or replace function private.invited(p_email text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(p_email, '') <> '' and (
    exists (select 1 from public.invites i where i.email = p_email)
    or exists (select 1 from public.lifters l where l.lifter_email = p_email and l.deleted_at is null)
    or exists (select 1 from private.settings s where lower(s.owner_email) = p_email))
$$;

create or replace function public.hook_before_user_created(event jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare em text := lower(btrim(coalesce(event -> 'user' ->> 'email', '')));
begin
  if private.invited(em) then return '{}'::jsonb; end if;
  return jsonb_build_object('error', jsonb_build_object('http_code', 403,
    'message', 'This email hasn''t been invited to Power Logs yet. Ask your coach to add it, then try again.'));
end $$;
-- Only the auth service runs it (a client can't use it to test which emails are invited).
revoke execute on function public.hook_before_user_created(jsonb) from public, anon, authenticated;
revoke execute on function private.invited(text) from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    grant execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin;
  end if;
end $$;

---------------------------------------------------------------- lifter limits
-- The owner can cap how many lifters a coach has (Account > Coaches, a number per coach). null = no limit.
-- Counted as the live lifters linked to the coach in lifter_coaches, so it covers every way of getting one:
-- creating or importing (the creator's link is added by lifters_add_creator) and being shared one. Refused
-- once the coach is at the limit; a lower limit leaves the lifters they already have alone. The owner has none.
alter table public.accounts add column if not exists lifter_limit integer;
alter table public.accounts drop constraint if exists accounts_lifter_limit_check;
alter table public.accounts add constraint accounts_lifter_limit_check check (lifter_limit is null or lifter_limit >= 0);

create or replace function private.coach_lifter_count(p_coach uuid) returns integer
language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.lifter_coaches lc join public.lifters l on l.id = lc.lifter_id
   where lc.coach_id = p_coach and l.deleted_at is null
$$;

create or replace function private.lifter_coaches_limit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare lim integer;
begin
  -- Already linked (sharing again): nothing is added.
  if exists (select 1 from public.lifter_coaches where lifter_id = new.lifter_id and coach_id = new.coach_id) then return new; end if;
  select a.lifter_limit into lim from public.accounts a where a.user_id = new.coach_id and a.role <> 'owner';
  if lim is not null and private.coach_lifter_count(new.coach_id) >= lim then
    raise exception 'lifter limit reached: % lifter% at most for this coach', lim, case when lim = 1 then '' else 's' end;
  end if;
  return new;
end $$;
drop trigger if exists lifter_limit on public.lifter_coaches;
create trigger lifter_limit before insert on public.lifter_coaches
  for each row execute function private.lifter_coaches_limit();

create or replace function public.set_lifter_limit(p_user uuid, p_limit integer) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_owner() then raise exception 'only the owner sets lifter limits'; end if;
  if p_limit is not null and p_limit < 0 then raise exception 'a lifter limit can''t be negative'; end if;
  update public.accounts set lifter_limit = p_limit where user_id = p_user;
end $$;
revoke execute on function private.coach_lifter_count(uuid), private.lifter_coaches_limit() from public, anon, authenticated;
revoke execute on function public.set_lifter_limit(uuid, integer) from public, anon;
grant execute on function public.set_lifter_limit(uuid, integer) to authenticated;
