-- Proves the rules in 1-schema.sql hold. Paste into the SQL Editor and Run
-- after 1-schema.sql. It invents seven throwaway accounts
-- (@selftest.invalid, an address that can never receive mail), acts as
-- each of them, then deletes them and everything they made.
-- Every row of the result should say PASS.

create temp table if not exists selftest_results (n serial, pass boolean, test text, detail text);
truncate selftest_results;

-- Run p_sql as a signed-in user (or anon when p_user is null).
-- 'ok N' = allowed and touched N rows; 'refused: ...' = blocked.
create or replace function pg_temp.act(p_user uuid, p_sql text) returns text
language plpgsql as $$
declare prev text := current_setting('role'); n bigint; r text;
begin
  begin
    perform set_config('request.jwt.claims',
      case when p_user is null then '{"role":"anon"}'
           else json_build_object('sub', p_user, 'role', 'authenticated')::text end, true);
    perform set_config('role', case when p_user is null then 'anon' else 'authenticated' end, true);
    execute p_sql;
    get diagnostics n = row_count;
    r := 'ok ' || n;
  exception when others then
    r := 'refused: ' || sqlerrm;
  end;
  perform set_config('role', prev, true);
  perform set_config('request.jwt.claims', '', true);
  return r;
end $$;

-- How many rows p_user can see from p_sql.
create or replace function pg_temp.cnt(p_user uuid, p_sql text) returns bigint
language plpgsql as $$
declare prev text := current_setting('role'); n bigint;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
  execute 'select count(*) from (' || p_sql || ') q' into n;
  perform set_config('role', prev, true);
  perform set_config('request.jwt.claims', '', true);
  return n;
end $$;

-- The single value p_sql returns for p_user (or the error).
create or replace function pg_temp.val(p_user uuid, p_sql text) returns text
language plpgsql as $$
declare prev text := current_setting('role'); v text;
begin
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
    perform set_config('role', 'authenticated', true);
    execute p_sql into v;
  exception when others then
    v := 'refused: ' || sqlerrm;
  end;
  perform set_config('role', prev, true);
  perform set_config('request.jwt.claims', '', true);
  return v;
end $$;

create or replace function pg_temp.ok(p_test text, p_pass boolean, p_detail text default '') returns void
language sql as $$
  insert into selftest_results (pass, test, detail) values (coalesce(p_pass, false), p_test, p_detail);
$$;

-- Leftovers from a run that stopped halfway.
delete from public.lifters where name like 'SELFTEST %';
delete from auth.users where email like '%@selftest.invalid';

do $$
declare
  o  uuid := '5e1f7e57-0000-4000-8000-000000000001';  -- owner
  c1 uuid := '5e1f7e57-0000-4000-8000-000000000002';  -- coach
  c2 uuid := '5e1f7e57-0000-4000-8000-000000000003';  -- second coach
  p  uuid := '5e1f7e57-0000-4000-8000-000000000004';  -- stays pending
  l  uuid := '5e1f7e57-0000-4000-8000-000000000005';  -- lifter
  x  uuid := '5e1f7e57-0000-4000-8000-000000000006';  -- stranger
  u  uuid := '5e1f7e57-0000-4000-8000-000000000007';  -- lifter who hasn't confirmed yet
  a  uuid := '5e1f7e57-0000-4000-8000-0000000000a1';
  b  uuid := '5e1f7e57-0000-4000-8000-0000000000b1';
  r text; v text;
begin
  insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  select '00000000-0000-0000-0000-000000000000', id, 'authenticated', 'authenticated', email,
         case when confirmed then now() end, '{}', '{}', now(), now()
  from (values (o, 'owner@selftest.invalid', true), (c1, 'c1@selftest.invalid', true),
               (c2, 'c2@selftest.invalid', true),   (p, 'p@selftest.invalid', true),
               (l, 'lifter@selftest.invalid', true), (x, 'x@selftest.invalid', true),
               (u, 'late@selftest.invalid', false)) t(id, email, confirmed);
  update public.accounts set role = 'owner' where user_id = o;  -- stand-in for 2-owner.sql

  perform pg_temp.ok('every sign-up gets an account row',
    (select count(*) from public.accounts where email like '%@selftest.invalid') = 7);

  -- Coach approval
  perform pg_temp.act(p,  $q$select public.request_coach_access('Pat')$q$);
  perform pg_temp.act(c1, $q$select public.request_coach_access('Coach One')$q$);
  perform pg_temp.act(c2, $q$select public.request_coach_access('Coach Two')$q$);
  perform pg_temp.ok('asking for coach access makes it pending',
    (select coach_status from public.accounts where user_id = p) = 'pending');
  r := pg_temp.act(p, format($q$select public.decide_coach(%L, 'approved')$q$, p));
  perform pg_temp.ok('a pending coach cannot approve themselves', r like 'refused%', r);
  r := pg_temp.act(p, format($q$update public.accounts set coach_status = 'approved' where user_id = %L$q$, p));
  perform pg_temp.ok('...nor edit their account row directly',
    (r like 'refused%' or r = 'ok 0') and (select coach_status from public.accounts where user_id = p) = 'pending', r);
  r := pg_temp.act(x, format($q$insert into public.accounts (user_id, email, role) values (%L, 'z', 'owner')$q$, x));
  perform pg_temp.ok('nobody can make themselves owner', r like 'refused%', r);
  perform pg_temp.act(o, format($q$select public.decide_coach(%L, 'approved')$q$, c1));
  perform pg_temp.act(o, format($q$select public.decide_coach(%L, 'approved')$q$, c2));
  perform pg_temp.ok('the owner approves coaches',
    (select count(*) from public.accounts where user_id in (c1, c2) and coach_status = 'approved') = 2);
  r := pg_temp.act(o, format($q$select public.decide_coach(%L, 'revoked')$q$, o));
  perform pg_temp.ok('the owner cannot be revoked', r like 'refused%', r);
  r := pg_temp.act(l, format($q$select public.decide_coach(%L, 'approved')$q$, p));
  perform pg_temp.ok('only the owner approves', r like 'refused%', r);

  -- Adding lifters
  r := pg_temp.act(p, format($q$insert into public.lifters (id, name) values (%L, 'SELFTEST P')$q$, gen_random_uuid()));
  perform pg_temp.ok('a pending coach cannot add lifters', r like 'refused%', r);
  r := pg_temp.act(x, format($q$insert into public.lifters (id, name) values (%L, 'SELFTEST X')$q$, gen_random_uuid()));
  perform pg_temp.ok('a stranger cannot add lifters', r like 'refused%', r);
  r := pg_temp.act(c1, format($q$insert into public.lifters (id, name, lifter_email, created_by, lifter_user_id)
                                values (%L, 'SELFTEST A', ' Lifter@SelfTest.invalid ', %L, %L)$q$, a, c2, x));
  perform pg_temp.ok('an approved coach adds a lifter', r = 'ok 1', r);
  perform pg_temp.ok('...recorded as theirs, whatever the app claims',
    (select created_by from public.lifters where id = a) = c1
    and exists (select 1 from public.lifter_coaches where lifter_id = a and coach_id = c1));
  perform pg_temp.ok('...and linked to the account with that email (not a spoofed id)',
    (select lifter_user_id from public.lifters where id = a) = l);
  perform pg_temp.act(c1, format($q$insert into public.lifters (id, name, lifter_email) values (%L, 'SELFTEST B', 'late@selftest.invalid')$q$, b));
  perform pg_temp.ok('an unconfirmed email does not link',
    (select lifter_user_id from public.lifters where id = b) is null);

  -- Who sees what
  perform pg_temp.ok('the lifter sees only their own program', pg_temp.cnt(l, 'select * from public.lifters') = 1);
  perform pg_temp.ok('a stranger sees no lifters', pg_temp.cnt(x, 'select * from public.lifters') = 0);
  perform pg_temp.ok('another coach does not see them unshared', pg_temp.cnt(c2, 'select * from public.lifters') = 0);
  perform pg_temp.ok('the owner sees all of them', pg_temp.cnt(o, $q$select * from public.lifters where name like 'SELFTEST %'$q$) = 2);
  r := pg_temp.act(l, format($q$update public.lifters set program = '{"hacked":1}' where id = %L$q$, a));
  perform pg_temp.ok('the lifter cannot change their program',
    (r like 'refused%' or r = 'ok 0') and (select program from public.lifters where id = a) = '{}'::jsonb, r);
  r := pg_temp.act(c2, format($q$update public.lifters set name = 'SELFTEST hacked' where id = %L$q$, a));
  perform pg_temp.ok('an unshared coach cannot change it', r = 'ok 0' or r like 'refused%', r);
  r := pg_temp.act(c1, format($q$update public.lifters set program = '{"weeks":[]}' where id = %L$q$, a));
  perform pg_temp.ok('its coach can', r = 'ok 1', r);

  -- Logging
  r := pg_temp.act(l, format($q$insert into public.lifter_marks (lifter_id, rid, state) values (%L, 'r1', 'done')$q$, a));
  perform pg_temp.ok('the lifter ticks Done', r = 'ok 1', r);
  perform pg_temp.ok('...stamped with who did it',
    (select updated_by from public.lifter_marks where lifter_id = a and rid = 'r1') = l);
  perform pg_temp.ok('the lifter writes exercise notes, added items and weekly notes',
    pg_temp.act(l, format($q$insert into public.lifter_row_notes (lifter_id, rid, body) values (%L, 'r1', 'felt good')$q$, a)) = 'ok 1'
    and pg_temp.act(l, format($q$insert into public.lifter_custom (lifter_id, cid, item) values (%L, 'c1', '{"text":"band pull-aparts"}')$q$, a)) = 'ok 1'
    and pg_temp.act(l, format($q$insert into public.lifter_week_notes (lifter_id, week, body) values (%L, '1', 'deload next')$q$, a)) = 'ok 1');
  perform pg_temp.ok('the coach sees the lifter''s ticks', pg_temp.cnt(c1, format('select * from public.lifter_marks where lifter_id = %L', a)) = 1);
  r := pg_temp.act(c1, format($q$insert into public.lifter_marks (lifter_id, rid, state) values (%L, 'r1', 'skip')
                                on conflict (lifter_id, rid) do update set state = excluded.state$q$, a));
  perform pg_temp.ok('the coach can change a tick too',
    r = 'ok 1' and (select state from public.lifter_marks where lifter_id = a and rid = 'r1') = 'skip', r);
  r := pg_temp.act(x, format($q$insert into public.lifter_marks (lifter_id, rid, state) values (%L, 'r2', 'done')$q$, a));
  perform pg_temp.ok('a stranger cannot log on someone''s program', r like 'refused%', r);
  perform pg_temp.ok('...or read it', pg_temp.cnt(x, 'select * from public.lifter_marks') = 0
                                   and pg_temp.cnt(x, 'select * from public.lifter_row_notes') = 0);

  -- Manage Program notes
  r := pg_temp.act(c1, format($q$insert into public.lifter_coach_notes (lifter_id, body) values (%L, 'watch the knee')$q$, a));
  perform pg_temp.ok('the coach writes Manage Program notes', r = 'ok 1', r);
  perform pg_temp.ok('the lifter cannot read them', pg_temp.cnt(l, 'select * from public.lifter_coach_notes') = 0);
  r := pg_temp.act(l, format($q$insert into public.lifter_coach_notes (lifter_id, body) values (%L, 'x')
                               on conflict (lifter_id) do update set body = excluded.body$q$, a));
  perform pg_temp.ok('...or write them', r like 'refused%', r);

  -- Sharing with another coach
  v := pg_temp.val(c1, format($q$select public.share_lifter(%L, 'p@selftest.invalid')$q$, a));
  perform pg_temp.ok('sharing with an unapproved coach is refused', v = 'not-a-coach', v);
  v := pg_temp.val(l, format($q$select public.share_lifter(%L, 'c2@selftest.invalid')$q$, a));
  perform pg_temp.ok('a lifter cannot share their program', v like 'refused%', v);
  v := pg_temp.val(c1, format($q$select public.share_lifter(%L, ' C2@selftest.invalid')$q$, a));
  perform pg_temp.ok('a coach shares a lifter with an approved coach', v = 'shared', v);
  perform pg_temp.ok('...who then sees and edits it',
    pg_temp.cnt(c2, 'select * from public.lifters') = 1
    and pg_temp.act(c2, format($q$update public.lifters set program = '{"weeks":[1]}' where id = %L$q$, a)) = 'ok 1'
    and pg_temp.cnt(c2, 'select * from public.lifter_coach_notes') = 1);
  perform pg_temp.ok('accounts: you see yourself, co-coaches see each other, owner sees all',
    pg_temp.cnt(p, 'select * from public.accounts') = 1
    and pg_temp.cnt(c1, 'select * from public.accounts') = 2
    and pg_temp.cnt(o, $q$select * from public.accounts where email like '%@selftest.invalid'$q$) = 7);

  -- Revoking a coach
  perform pg_temp.act(o, format($q$select public.decide_coach(%L, 'revoked')$q$, c2));
  perform pg_temp.ok('a revoked coach loses every lifter at once',
    pg_temp.cnt(c2, 'select * from public.lifters') = 0
    and pg_temp.act(c2, format($q$update public.lifters set name = 'SELFTEST hacked' where id = %L$q$, a)) in ('ok 0'));
  v := pg_temp.val(c2, $q$select public.request_coach_access('again')$q$);
  perform pg_temp.ok('...and cannot simply ask again', v = 'revoked', v);

  -- Linking later, unlinking, deleting
  update auth.users set email_confirmed_at = now() where id = u;
  perform pg_temp.ok('a lifter who confirms their email later gets linked',
    (select lifter_user_id from public.lifters where id = b) = u and pg_temp.cnt(u, 'select * from public.lifters') = 1);
  perform pg_temp.act(c1, format($q$update public.lifters set lifter_email = 'someone.else@selftest.invalid' where id = %L$q$, a));
  perform pg_temp.ok('changing a lifter''s email cuts off the old account',
    pg_temp.cnt(l, 'select * from public.lifters') = 0
    and pg_temp.act(l, format($q$insert into public.lifter_marks (lifter_id, rid, state) values (%L, 'r9', 'done')$q$, a)) like 'refused%');
  r := pg_temp.act(c1, format('update public.lifters set deleted_at = now() where id = %L', b));
  perform pg_temp.ok('the coach deletes a lifter', r = 'ok 1', r);
  perform pg_temp.ok('...their devices still see it, to learn it''s gone', pg_temp.cnt(u, 'select * from public.lifters where deleted_at is not null') = 1);
  perform pg_temp.ok('...but nobody can log on it any more',
    pg_temp.act(u, format($q$insert into public.lifter_marks (lifter_id, rid, state) values (%L, 'r1', 'done')$q$, b)) like 'refused%'
    and pg_temp.act(c1, format($q$insert into public.lifter_coach_notes (lifter_id, body) values (%L, 'x')$q$, b)) like 'refused%');

  -- Signed out, and personal settings
  r := pg_temp.act(null, 'select * from public.lifters');
  perform pg_temp.ok('signed out: no data at all', r like 'refused%', r);
  r := pg_temp.act(null, $q$select public.request_coach_access('x')$q$);
  perform pg_temp.ok('signed out: no actions', r like 'refused%', r);
  r := pg_temp.act(l, $q$insert into public.user_prefs (lifter_order) values ('["a"]')$q$);
  perform pg_temp.ok('everyone keeps their own dropdown order', r = 'ok 1', r);
  r := pg_temp.act(l, format($q$insert into public.user_prefs (user_id, lifter_order) values (%L, '[]')$q$, x));
  perform pg_temp.ok('...and only their own', r like 'refused%' and pg_temp.cnt(x, 'select * from public.user_prefs') = 0, r);
end $$;

delete from public.lifters where name like 'SELFTEST %';
delete from auth.users where email like '%@selftest.invalid';

-- Summary first, then any failures, then the passes.
select result, test, detail from (
  select 0 as s, 0 as n,
         case when bool_and(pass) then 'ALL ' || count(*) || ' PASSED'
              else count(*) filter (where not pass) || ' FAILED' end as result, '' as test, '' as detail
  from selftest_results
  union all
  select case when pass then 2 else 1 end, n, case when pass then 'PASS' else 'FAIL' end, test, detail
  from selftest_results
) q
order by s, n;
