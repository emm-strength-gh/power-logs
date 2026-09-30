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
  if p_decision not in ('approved', 'declined', 'revoked') then raise exception 'bad decision'; end if;
  update public.accounts set coach_status = p_decision, decided_at = now()
   where user_id = p_user and role <> 'owner';
  if not found then raise exception 'no such coach'; end if;
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
  using (user_id = (select auth.uid()) or (select private.is_owner()) or private.shares_lifter_with(user_id));

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
  private.shares_lifter_with(uuid) to authenticated;
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
