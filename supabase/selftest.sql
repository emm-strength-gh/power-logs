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
  m  uuid := '5e1f7e57-0000-4000-8000-0000000000c1';
  n  uuid := '5e1f7e57-0000-4000-8000-0000000000d1';
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
  v := pg_temp.val(c1, format($q$select public.decide_coach(%L, 'cleared')$q$, c2));
  perform pg_temp.ok('only the owner deletes a request', v like 'refused%', v);
  v := pg_temp.val(o, format($q$select public.decide_coach(%L, 'cleared')$q$, p));
  perform pg_temp.ok('a request still pending cannot be deleted (approve or decline it)', v like 'refused%', v);
  v := pg_temp.val(o, format($q$select public.decide_coach(%L, 'cleared')$q$, c2));
  perform pg_temp.ok('the owner deletes a removed coach''s request: an ordinary account again',
    v = 'none' and (select coach_status from public.accounts where user_id = c2) = 'none'
    and (select requested_at from public.accounts where user_id = c2) is null, v);
  v := pg_temp.val(c2, $q$select public.request_coach_access('Again')$q$);
  perform pg_temp.ok('...who can ask to be a coach again', v = 'pending', v);
  perform pg_temp.val(o, format($q$select public.decide_coach(%L, 'revoked')$q$, c2));

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

  -- Messages. A fresh lifter M, coached by c1, logged by l; c2 (re-approved) joins later.
  perform pg_temp.act(o, format($q$select public.decide_coach(%L, 'approved')$q$, c2));
  perform pg_temp.act(c1, format($q$insert into public.lifters (id, name, lifter_email) values (%L, 'SELFTEST M', 'lifter@selftest.invalid')$q$, m));
  r := pg_temp.act(l, format($q$insert into public.messages (lifter_id, thread, body) values (%L, 'team', 'hi coach')$q$, m));
  perform pg_temp.ok('the lifter posts in the team thread (on by default)', r = 'ok 1', r);
  r := pg_temp.act(c1, format($q$insert into public.messages (lifter_id, thread, body, sender_id) values (%L, 'team', 'hi Sam', %L)$q$, m, l));
  perform pg_temp.ok('their coach replies there', r = 'ok 1', r);
  perform pg_temp.ok('...stamped as the coach, whatever the app claims',
    (select sender_id from public.messages where lifter_id = m and body = 'hi Sam') = c1);
  r := pg_temp.act(l, format($q$insert into public.messages (lifter_id, thread, body, reply_to) values (%L, 'team', 'replying to Sam', (select id from public.messages where lifter_id = %L and body = 'hi Sam'))$q$, m, m));
  perform pg_temp.ok('a reply points at the message it answers',
    r = 'ok 1' and (select reply_to from public.messages where lifter_id = m and body = 'replying to Sam') = (select id from public.messages where lifter_id = m and body = 'hi Sam'), r);
  r := pg_temp.act(l, format($q$insert into public.messages (lifter_id, thread, body, reply_to) values (%L, 'team', 'replying to nothing', gen_random_uuid())$q$, m));
  perform pg_temp.ok('...a pointer to a message that isn''t in the thread is dropped, not refused',
    r = 'ok 1' and (select reply_to from public.messages where lifter_id = m and body = 'replying to nothing') is null, r);
  delete from public.messages where lifter_id = m and body in ('replying to Sam', 'replying to nothing');
  r := pg_temp.act(x, format($q$insert into public.messages (lifter_id, thread, body) values (%L, 'team', 'spam')$q$, m));
  perform pg_temp.ok('a stranger cannot post', r like 'refused%', r);
  perform pg_temp.ok('...or read', pg_temp.cnt(x, 'select * from public.messages') = 0);
  r := pg_temp.act(c1, format($q$insert into public.messages (lifter_id, thread, body) values (%L, %L, 'psst')$q$, m, c1));
  perform pg_temp.ok('no private thread while the team thread is on', r like 'refused%', r);
  -- One transaction has one now(): move these messages an hour back so "before c2 joined" is real.
  update public.messages set created_at = created_at - interval '1 hour' where lifter_id = m;
  update public.lifter_coaches set created_at = created_at - interval '2 hours' where lifter_id = m;
  perform pg_temp.val(c1, format($q$select public.share_lifter(%L, 'c2@selftest.invalid')$q$, m));
  perform pg_temp.ok('a coach who joins later does not see the earlier team messages',
    pg_temp.cnt(c2, format('select * from public.messages where lifter_id = %L', m)) = 0);
  r := pg_temp.act(c2, format($q$insert into public.messages (lifter_id, thread, body) values (%L, 'team', 'welcome')$q$, m));
  perform pg_temp.ok('...but joins the conversation from then on',
    r = 'ok 1' and pg_temp.cnt(c1, format('select * from public.messages where lifter_id = %L', m)) = 3
    and pg_temp.cnt(l, format('select * from public.messages where lifter_id = %L', m)) = 3
    and pg_temp.cnt(c2, format('select * from public.messages where lifter_id = %L', m)) = 1, r);
  v := pg_temp.val(c1, format($q$select public.set_team_thread(%L, false)::text$q$, m));
  perform pg_temp.ok('only the lifter switches the team thread', v like 'refused%', v);
  v := pg_temp.val(l, format($q$select public.set_team_thread(%L, false)::text$q$, m));
  perform pg_temp.ok('the lifter switches to one thread per coach', v = 'false', v);
  r := pg_temp.act(l, format($q$insert into public.messages (lifter_id, thread, body) values (%L, 'team', 'x')$q$, m));
  perform pg_temp.ok('the team thread is then history only', r like 'refused%', r);
  r := pg_temp.act(l, format($q$insert into public.messages (lifter_id, thread, body) values (%L, %L, 'just you')$q$, m, c1));
  perform pg_temp.ok('the lifter writes to one coach privately', r = 'ok 1', r);
  r := pg_temp.act(c1, format($q$insert into public.messages (lifter_id, thread, body) values (%L, %L, 'got it')$q$, m, c1));
  perform pg_temp.ok('that coach answers in their own thread', r = 'ok 1', r);
  r := pg_temp.act(c1, format($q$insert into public.messages (lifter_id, thread, body) values (%L, %L, 'x')$q$, m, c2));
  perform pg_temp.ok('...but not in another coach''s', r like 'refused%', r);
  perform pg_temp.ok('the other coach cannot read it',
    pg_temp.cnt(c2, format('select * from public.messages where lifter_id = %L and thread = %L', m, c1)) = 0);
  r := pg_temp.act(x, format($q$insert into public.messages (lifter_id, thread, body) values (%L, %L, 'x')$q$, m, x));
  perform pg_temp.ok('nobody else gets a thread of their own', r like 'refused%', r);
  perform pg_temp.ok('the lifter sees all of it', pg_temp.cnt(l, format('select * from public.messages where lifter_id = %L', m)) = 5);
  perform pg_temp.ok('the lifter sees who coaches them',
    pg_temp.cnt(l, format('select * from public.lifter_coaches where lifter_id = %L', m)) = 2);
  perform pg_temp.ok('the lifter sees their coaches'' names',
    pg_temp.cnt(l, format('select * from public.accounts where user_id in (%L, %L)', c1, c2)) = 2);

  -- Finished sessions and new weeks
  r := pg_temp.act(l, format($q$insert into public.lifter_events (lifter_id, kind, week, day) values (%L, 'session_done', '1', '1')$q$, m));
  perform pg_temp.ok('the lifter reports a finished day', r = 'ok 1', r);
  r := pg_temp.act(l, format($q$insert into public.lifter_events (lifter_id, kind, week, day) values (%L, 'session_done', '1', '1') on conflict do nothing$q$, m));
  perform pg_temp.ok('...once: the same day again does nothing', r = 'ok 0', r);
  r := pg_temp.act(c1, format($q$insert into public.lifter_events (lifter_id, kind, week, day) values (%L, 'session_done', '1', '2')$q$, m));
  perform pg_temp.ok('a coach cannot report it for them', r like 'refused%', r);
  r := pg_temp.act(c1, format($q$insert into public.lifter_events (lifter_id, kind, week) values (%L, 'new_week', '9')$q$, m));
  perform pg_temp.ok('nobody writes a new-week alert directly', r like 'refused%', r);
  perform pg_temp.act(c1, format($q$update public.lifters set program = '{"weeks":[{"week":"1","days":[]}]}' where id = %L$q$, m));
  v := pg_temp.val(c1, format('select public.notify_new_week(%L)::text', m));
  perform pg_temp.ok('a coach notifies about a new week', v ~ '^[0-9a-f-]{36}$', v);
  v := pg_temp.val(c2, format('select coalesce(public.notify_new_week(%L)::text, %L)', m, 'none'));
  perform pg_temp.ok('...once, for all the coaches', v = 'none', v);
  v := pg_temp.val(l, format('select public.notify_new_week(%L)::text', m));
  perform pg_temp.ok('the lifter cannot send it', v like 'refused%', v);
  perform pg_temp.act(c1, format($q$update public.lifters set program = '{"weeks":[{"week":"1","days":[]},{"week":"2","days":[]}]}' where id = %L$q$, m));
  v := pg_temp.val(c2, format('select public.notify_new_week(%L)::text', m));
  perform pg_temp.ok('adding another week allows one more', v ~ '^[0-9a-f-]{36}$', v);

  -- Notification sign-ups and read markers
  r := pg_temp.act(l, $q$insert into public.push_subscriptions (endpoint, p256dh, auth) values ('https://push.example/l', 'k', 'a')$q$);
  perform pg_temp.ok('a device signs up for notifications', r = 'ok 1', r);
  r := pg_temp.act(l, format($q$insert into public.push_subscriptions (endpoint, user_id, p256dh, auth) values ('https://push.example/x', %L, 'k', 'a')$q$, x));
  perform pg_temp.ok('...only for its own account', r like 'refused%' and pg_temp.cnt(x, 'select * from public.push_subscriptions') = 0, r);
  -- Read markers ("Seen")
  r := pg_temp.act(c1, format($q$insert into public.message_reads (lifter_id, thread) values (%L, 'team')$q$, m));
  perform pg_temp.ok('a coach saves how far they''ve read', r = 'ok 1', r);
  perform pg_temp.ok('...which the lifter sees (Seen)', pg_temp.cnt(l, 'select * from public.message_reads') = 1);
  perform pg_temp.act(c1, format($q$insert into public.message_reads (lifter_id, thread) values (%L, %L)$q$, m, c1));
  perform pg_temp.ok('a private thread''s marker stays between its two people',
    pg_temp.cnt(c2, format('select * from public.message_reads where thread = %L', c1)) = 0
    and pg_temp.cnt(l, format('select * from public.message_reads where thread = %L', c1)) = 1);
  perform pg_temp.ok('...and strangers see none', pg_temp.cnt(x, 'select * from public.message_reads') = 0);
  r := pg_temp.act(l, format($q$insert into public.message_reads (user_id, lifter_id, thread) values (%L, %L, 'team')$q$, c2, m));
  perform pg_temp.ok('nobody writes someone else''s marker', r like 'refused%', r);

  -- Trophies, PRs, strength levels
  r := pg_temp.act(l, format($q$insert into public.lifter_trophies (lifter_id, trophy, cls) values (%L, 'lvl:squat:advanced', 'Men''s 83 kg')$q$, m));
  perform pg_temp.ok('a lifter records a trophy they earned', r = 'ok 1', r);
  r := pg_temp.act(l, format($q$insert into public.lifter_trophies (lifter_id, trophy) values (%L, 'lvl:squat:advanced') on conflict do nothing$q$, m));
  perform pg_temp.ok('...once: the same trophy again does nothing', r = 'ok 0', r);
  r := pg_temp.act(l, format($q$insert into public.lifter_trophies (lifter_id, trophy) values (%L, 'award:podium')$q$, m));
  perform pg_temp.ok('a lifter cannot give themselves a coach''s award', r like 'refused%', r);
  r := pg_temp.act(c1, format($q$insert into public.lifter_trophies (lifter_id, trophy) values (%L, 'lvl:bench:elite')$q$, m));
  perform pg_temp.ok('a coach cannot earn a level for them', r like 'refused%', r);
  r := pg_temp.act(c1, format($q$insert into public.lifter_trophies (lifter_id, trophy, note, awarded_by) values (%L, 'award:podium', 'Third in the 83s', %L)$q$, m, l));
  perform pg_temp.ok('a coach gives an award', r = 'ok 1', r);
  perform pg_temp.ok('...stamped as theirs, whatever the app claims',
    (select awarded_by from public.lifter_trophies where lifter_id = m and trophy = 'award:podium') = c1);
  perform pg_temp.ok('the lifter and every coach see the shelf',
    pg_temp.cnt(l, format('select * from public.lifter_trophies where lifter_id = %L', m)) = 2
    and pg_temp.cnt(c2, format('select * from public.lifter_trophies where lifter_id = %L', m)) = 2);
  perform pg_temp.ok('...and a stranger sees none', pg_temp.cnt(x, 'select * from public.lifter_trophies') = 0);
  r := pg_temp.act(x, format($q$insert into public.lifter_trophies (lifter_id, trophy) values (%L, 'award:podium')$q$, m));
  perform pg_temp.ok('a stranger cannot give one', r like 'refused%', r);
  r := pg_temp.act(l, format($q$delete from public.lifter_trophies where lifter_id = %L and trophy = 'lvl:squat:advanced'$q$, m));
  perform pg_temp.ok('a lifter cannot delete a trophy', r = 'ok 0' or r like 'refused%', r);
  r := pg_temp.act(c2, format($q$delete from public.lifter_trophies where lifter_id = %L and trophy = 'lvl:squat:advanced'$q$, m));
  perform pg_temp.ok('...nor can a coach take back an earned one', r = 'ok 0' or r like 'refused%', r);
  r := pg_temp.act(c2, format($q$delete from public.lifter_trophies where lifter_id = %L and trophy = 'award:podium'$q$, m));
  perform pg_temp.ok('a coach can take back an award', r = 'ok 1', r);
  r := pg_temp.act(l, format($q$insert into public.lifter_events (lifter_id, kind, week) values (%L, 'trophy', 'lvl:squat:advanced')$q$, m));
  perform pg_temp.ok('the lifter announces a trophy', r = 'ok 1', r);
  r := pg_temp.act(c1, format($q$insert into public.lifter_events (lifter_id, kind, week) values (%L, 'trophy', 'award:podium')$q$, m));
  perform pg_temp.ok('...and a coach announces an award', r = 'ok 1', r);
  r := pg_temp.act(x, format($q$insert into public.lifter_events (lifter_id, kind, week) values (%L, 'trophy', 'award:podium')$q$, m));
  perform pg_temp.ok('...a stranger cannot', r like 'refused%', r);
  r := pg_temp.act(l, format($q$insert into public.lifter_prs (lifter_id, lift, kg, reps, confirmed_by) values (%L, 'squat', 180, 1, %L)$q$, m, l));
  perform pg_temp.ok('a lifter logs a PR', r = 'ok 1', r);
  perform pg_temp.ok('...it waits for a coach, whatever the app claims',
    (select confirmed_by from public.lifter_prs where lifter_id = m and lift = 'squat') is null);
  r := pg_temp.act(l, format($q$update public.lifter_prs set confirmed_by = %L where lifter_id = %L$q$, l, m));
  perform pg_temp.ok('a lifter cannot confirm their own PR', r = 'ok 0' or r like 'refused%', r);
  r := pg_temp.act(c1, format($q$update public.lifter_prs set confirmed_by = %L where lifter_id = %L$q$, c1, m));
  perform pg_temp.ok('a coach confirms it', r = 'ok 1'
    and (select confirmed_by from public.lifter_prs where lifter_id = m and lift = 'squat') = c1, r);
  r := pg_temp.act(c1, format($q$update public.lifter_prs set kg = 250 where lifter_id = %L$q$, m));
  perform pg_temp.ok('a logged PR''s weight cannot be changed', r like 'refused%', r);
  r := pg_temp.act(c1, format($q$insert into public.lifter_prs (lifter_id, lift, kg) values (%L, 'bench', 120)$q$, m));
  perform pg_temp.ok('a coach can log one, already confirmed',
    r = 'ok 1' and (select confirmed_by from public.lifter_prs where lifter_id = m and lift = 'bench') = c1, r);
  r := pg_temp.act(x, format($q$insert into public.lifter_prs (lifter_id, lift, kg) values (%L, 'bench', 100)$q$, m));
  perform pg_temp.ok('a stranger cannot', r like 'refused%' and pg_temp.cnt(x, 'select * from public.lifter_prs') = 0, r);
  r := pg_temp.act(l, format($q$delete from public.lifter_prs where lifter_id = %L and lift = 'squat'$q$, m));
  perform pg_temp.ok('a lifter cannot delete a PR once it is confirmed', r = 'ok 0' or r like 'refused%', r);
  r := pg_temp.act(l, format($q$insert into public.lifter_prs (lifter_id, lift, kg) values (%L, 'deadlift', 200)$q$, m));
  r := pg_temp.act(l, format($q$delete from public.lifter_prs where lifter_id = %L and lift = 'deadlift'$q$, m));
  perform pg_temp.ok('...but can take back one still waiting', r = 'ok 1', r);
  r := pg_temp.act(l, format($q$insert into public.lifter_prs (lifter_id, lift, kg) values (%L, 'squat', 700)$q$, m));
  perform pg_temp.ok('an impossible weight is refused', r like 'refused%', r);
  v := pg_temp.val(l, format($q$select public.set_trophy_profile(%L, 'm', 83.4)::text$q$, m));
  perform pg_temp.ok('a lifter sets their standards and bodyweight', coalesce(v, '') = ''
    and (select sex from public.lifter_settings where lifter_id = m) = 'm'
    and (select bodyweight from public.lifter_settings where lifter_id = m) = 83.4, v);
  v := pg_temp.val(c2, format($q$select public.set_trophy_profile(%L, 'f', 70)::text$q$, m));
  perform pg_temp.ok('...a coach can too', coalesce(v, '') = '' and (select sex from public.lifter_settings where lifter_id = m) = 'f', v);
  v := pg_temp.val(x, format($q$select public.set_trophy_profile(%L, 'm', 70)::text$q$, m));
  perform pg_temp.ok('...a stranger cannot', v like 'refused%', v);
  v := pg_temp.val(l, format($q$select public.set_trophy_profile(%L, 'x', 70)::text$q$, m));
  perform pg_temp.ok('...and only m or f', v like 'refused%', v);

  -- The owner's private files (the Program Hub)
  insert into public.owner_assets (id, version, body) values ('selftest', 'v0', '<html></html>');
  perform pg_temp.ok('the owner reads the private files', pg_temp.cnt(o, $q$select * from public.owner_assets where id = 'selftest'$q$) = 1);
  perform pg_temp.ok('...a coach does not', pg_temp.cnt(c1, 'select * from public.owner_assets') = 0);
  perform pg_temp.ok('...nor a lifter, nor a stranger', pg_temp.cnt(l, 'select * from public.owner_assets') = 0 and pg_temp.cnt(x, 'select * from public.owner_assets') = 0);
  r := pg_temp.act(null, 'select * from public.owner_assets');
  perform pg_temp.ok('...nor anyone signed out', r like 'refused%', r);
  r := pg_temp.act(o, $q$insert into public.owner_assets (id, version, body) values ('mine', 'v1', 'x')$q$);
  perform pg_temp.ok('not even the owner writes through the API', r like 'refused%', r);
  r := pg_temp.act(o, $q$update public.owner_assets set body = 'x' where id = 'selftest'$q$);
  perform pg_temp.ok('...nor changes it', r like 'refused%', r);
  delete from public.owner_assets where id = 'selftest';

  -- Payments: the coach who created the lifter (c1 made M) keeps them; the lifter reads them
  r := pg_temp.act(c1, format($q$insert into public.lifter_payments (lifter_id, month, paid, paid_on, amount, currency, updated_by) values (%L, '2026-10', true, '2026-10-03', 2500, 'PHP', %L)$q$, m, l));
  perform pg_temp.ok('the coach who created a lifter marks a month paid', r = 'ok 1', r);
  perform pg_temp.ok('...stamped as theirs, whatever the app claims',
    (select updated_by from public.lifter_payments where lifter_id = m and month = '2026-10') = c1);
  r := pg_temp.act(c1, format($q$update public.lifter_payments set amount = 3000 where lifter_id = %L and month = '2026-10'$q$, m));
  perform pg_temp.ok('...and can change it', r = 'ok 1', r);
  perform pg_temp.ok('the lifter sees their payments', pg_temp.cnt(l, format('select * from public.lifter_payments where lifter_id = %L', m)) = 1);
  r := pg_temp.act(l, format($q$update public.lifter_payments set paid = false where lifter_id = %L$q$, m));
  perform pg_temp.ok('...but cannot change them', r = 'ok 0' or r like 'refused%', r);
  r := pg_temp.act(l, format($q$insert into public.lifter_payments (lifter_id, month, paid) values (%L, '2026-11', true)$q$, m));
  perform pg_temp.ok('...or add one', r like 'refused%', r);
  perform pg_temp.ok('another coach on the lifter does not see them', pg_temp.cnt(c2, 'select * from public.lifter_payments') = 0);
  r := pg_temp.act(c2, format($q$insert into public.lifter_payments (lifter_id, month, paid) values (%L, '2026-09', true)$q$, m));
  perform pg_temp.ok('...nor write them', r like 'refused%', r);
  perform pg_temp.ok('a stranger sees none', pg_temp.cnt(x, 'select * from public.lifter_payments') = 0);
  r := pg_temp.act(c1, format($q$update public.lifter_payments set paid = false, paid_on = null, amount = null, removed = true where lifter_id = %L and month = '2026-10'$q$, m));
  perform pg_temp.ok('the coach can delete a month from the list', r = 'ok 1', r);
  perform pg_temp.ok('...which the lifter sees as removed',
    (select removed from public.lifter_payments where lifter_id = m and month = '2026-10') is true);
  r := pg_temp.act(l, format($q$update public.lifter_payments set removed = false where lifter_id = %L$q$, m));
  perform pg_temp.ok('the lifter cannot bring it back', r = 'ok 0' or r like 'refused%', r);
  r := pg_temp.act(c1, format($q$insert into public.lifter_payments (lifter_id, month, paid, currency) values (%L, '2026-08', true, 'EUR')$q$, m));
  perform pg_temp.ok('only pesos, pounds or dollars', r like 'refused%', r);
  r := pg_temp.act(c1, format($q$insert into public.lifter_payments (lifter_id, month, paid) values (%L, '2026-13', true)$q$, m));
  perform pg_temp.ok('...and only real months', r like 'refused%', r);

  -- Reactions
  r := pg_temp.act(l, format($q$insert into public.lifter_reactions (lifter_id, target_type, target_id, emoji) select %L, 'message', id::text, 'heart' from public.messages where lifter_id = %L and body = 'hi Sam'$q$, m, m));
  perform pg_temp.ok('the lifter reacts to a message in their thread', r = 'ok 1', r);
  r := pg_temp.act(c1, format($q$insert into public.lifter_reactions (lifter_id, target_type, target_id, emoji) select %L, 'message', id::text, 'fire' from public.messages where lifter_id = %L and body = 'hi coach'$q$, m, m));
  perform pg_temp.ok('...and a coach does too', r = 'ok 1', r);
  perform pg_temp.ok('both see both reactions', pg_temp.cnt(l, format('select * from public.lifter_reactions where lifter_id = %L', m)) = 2
    and pg_temp.cnt(c1, format('select * from public.lifter_reactions where lifter_id = %L', m)) = 2);
  r := pg_temp.act(l, format($q$update public.lifter_reactions set emoji = 'up' where lifter_id = %L and user_id = %L$q$, m, l));
  perform pg_temp.ok('a reaction can be changed', r = 'ok 1' and (select emoji from public.lifter_reactions where lifter_id = m and user_id = l) = 'up', r);
  r := pg_temp.act(l, format($q$update public.lifter_reactions set emoji = null where lifter_id = %L and user_id = %L$q$, m, l));
  perform pg_temp.ok('...or taken back', r = 'ok 1' and (select emoji from public.lifter_reactions where lifter_id = m and user_id = l) is null, r);
  r := pg_temp.act(l, format($q$update public.lifter_reactions set emoji = 'devil' where lifter_id = %L and user_id = %L$q$, m, c1));
  perform pg_temp.ok('nobody changes someone else''s', r = 'ok 0' or r like 'refused%', r);
  r := pg_temp.act(l, format($q$insert into public.lifter_reactions (lifter_id, target_type, target_id, emoji, user_id) select %L, 'message', id::text, 'sleep', %L from public.messages where lifter_id = %L and body = 'hi Sam'$q$, m, c1, m));
  perform pg_temp.ok('...nor reacts as them', r like 'refused%' or (select count(*) from public.lifter_reactions where user_id = c1 and emoji = 'sleep') = 0, r);
  r := pg_temp.act(c1, format($q$insert into public.lifter_reactions (lifter_id, target_type, target_id, emoji) select %L, 'message', id::text, 'poop' from public.messages where lifter_id = %L limit 1$q$, m, m));
  perform pg_temp.ok('only the seven allowed emoji', r like 'refused%', r);
  r := pg_temp.act(x, format($q$insert into public.lifter_reactions (lifter_id, target_type, target_id, emoji) select %L, 'message', id::text, 'heart' from public.messages where lifter_id = %L limit 1$q$, m, m));
  -- (they can't even read the message to pick it from, so 0 rows go in; a direct insert is refused too)
  perform pg_temp.ok('a stranger cannot react to a message', (r = 'ok 0' or r like 'refused%')
    and pg_temp.act(x, format($q$insert into public.lifter_reactions (lifter_id, target_type, target_id, emoji) values (%L, 'message', %L, 'heart')$q$, m, (select id::text from public.messages where lifter_id = m limit 1))) like 'refused%', r);
  perform pg_temp.ok('...or see reactions', pg_temp.cnt(x, 'select * from public.lifter_reactions') = 0);
  r := pg_temp.act(c1, format($q$insert into public.lifter_reactions (lifter_id, target_type, target_id, emoji) values (%L, 'note', '1', 'heart')$q$, m));
  perform pg_temp.ok('a coach reacts to a weekly note', r = 'ok 1', r);
  r := pg_temp.act(c1, format($q$insert into public.lifter_reactions (lifter_id, target_type, target_id, emoji) values (%L, 'day', '1|2', '100')$q$, m));
  perform pg_temp.ok('...and to a day', r = 'ok 1', r);
  perform pg_temp.ok('the lifter sees those', pg_temp.cnt(l, format($q$select * from public.lifter_reactions where lifter_id = %L and target_type in ('note', 'day')$q$, m)) = 2);
  r := pg_temp.act(l, format($q$insert into public.lifter_reactions (lifter_id, target_type, target_id, emoji) values (%L, 'day', '1|1', 'heart')$q$, m));
  perform pg_temp.ok('the lifter cannot react to a note or a day (coaches only)', r like 'refused%', r);
  r := pg_temp.act(l, format($q$insert into public.lifter_reactions (lifter_id, target_type, target_id, emoji) values (%L, 'note', '1', 'heart')$q$, m));
  perform pg_temp.ok('...either kind', r like 'refused%', r);
  r := pg_temp.act(l, format($q$update public.lifter_reactions set target_type = 'day' where lifter_id = %L and user_id = %L$q$, m, l));
  perform pg_temp.ok('...nor turn a message reaction into one', (select target_type from public.lifter_reactions where lifter_id = m and user_id = l) = 'message', r);
  r := pg_temp.act(c1, format($q$insert into public.lifter_reactions (lifter_id, target_type, target_id, emoji) values (%L, 'message', gen_random_uuid()::text, 'heart')$q$, m));
  perform pg_temp.ok('a reaction to a message that isn''t there is refused', r like 'refused%', r);
  r := pg_temp.act(c1, format($q$insert into public.lifter_reactions (lifter_id, target_type, target_id, emoji) values (%L, 'note', '1', 'fire')$q$, b));
  perform pg_temp.ok('a coach cannot react on a lifter that isn''t theirs', r like 'refused%', r);

  -- Clear (owner only)
  v := pg_temp.val(c1, format($q$select public.clear_thread(%L, 'team')::text$q$, m));
  perform pg_temp.ok('a coach cannot clear a conversation', v like 'refused%', v);
  v := pg_temp.val(l, format($q$select public.clear_thread(%L, 'team')::text$q$, m));
  perform pg_temp.ok('nor can the lifter', v like 'refused%', v);
  v := pg_temp.val(o, format($q$select public.clear_thread(%L, 'team')::text$q$, m));
  perform pg_temp.ok('the owner clears only conversations they''re in', v like 'refused%', v);
  perform pg_temp.val(c1, format($q$select public.share_lifter(%L, 'owner@selftest.invalid')$q$, m));
  v := pg_temp.val(o, format($q$select public.clear_thread(%L, %L)::text$q$, m, c1));
  perform pg_temp.ok('...and never another coach''s private thread', v like 'refused%', v);
  v := pg_temp.val(o, format($q$select public.clear_thread(%L, 'team')::text$q$, m));
  perform pg_temp.ok('the owner clears the whole team thread, every coach''s messages included',
    v = '3' and not exists (select 1 from public.messages where lifter_id = m and thread = 'team')
    and exists (select 1 from public.messages where lifter_id = m and thread <> 'team'), v);
  perform pg_temp.ok('...and devices are told when (to drop their copies)',
    (select cleared ? 'team' from public.lifter_settings where lifter_id = m));

  -- Removing a coach takes back the access they gave, and only that.
  perform pg_temp.act(c2, format($q$insert into public.lifters (id, name, lifter_email) values (%L, 'SELFTEST N', 'late@selftest.invalid')$q$, n));
  perform pg_temp.ok('a lifter email records who entered it', (select lifter_email_by from public.lifters where id = n) = c2);
  perform pg_temp.ok('...and the lifter can see their program', pg_temp.cnt(u, format('select * from public.lifters where id = %L', n)) = 1);
  perform pg_temp.act(o, format($q$select public.decide_coach(%L, 'revoked')$q$, c2));
  perform pg_temp.ok('removing that coach clears the emails they entered',
    (select lifter_email from public.lifters where id = n) is null and (select lifter_user_id from public.lifters where id = n) is null);
  perform pg_temp.ok('...so that lifter loses access', pg_temp.cnt(u, format('select * from public.lifters where id = %L', n)) = 0);
  perform pg_temp.ok('...but the program stays, for the owner', (select deleted_at from public.lifters where id = n) is null
    and pg_temp.cnt(o, format('select * from public.lifters where id = %L', n)) = 1);
  perform pg_temp.ok('an email another coach entered is left alone (on a lifter they shared)',
    (select lifter_email from public.lifters where id = m) = 'lifter@selftest.invalid'
    and pg_temp.cnt(l, format('select * from public.lifters where id = %L', m)) = 1
    and pg_temp.cnt(c1, format('select * from public.lifters where id = %L', m)) = 1);

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
