\set ON_ERROR_STOP on
begin;
select set_config('request.jwt.claim.role', 'service_role', true);

do $$
declare
  v_project_id uuid;
  v_existing_customer_id uuid;
  v_first record;
  v_replay record;
  v_bad_customer_count bigint;
  v_bad_booking_count bigint;
  v_bad_traveller_count bigint;
  v_rate record;
  v_ip_hash text := encode(digest(gen_random_uuid()::text, 'sha256'), 'hex');
  v_email_hash text := encode(digest(gen_random_uuid()::text, 'sha256'), 'hex');
  v_email_claim record;
  v_group_manifest jsonb;
  v_group_pricing integer;
  v_group_online integer;
  v_manifest jsonb := jsonb_build_array(
    jsonb_build_object(
      'first_name', 'Case', 'last_name', 'Tester', 'email', 'mixed.runtime@example.com',
      'phone', '+1 555', 'nationality', 'Testland', 'date_of_birth', '1990-01-02',
      'riding_experience', 'Beginner — little to none', 'dietary_notes', 'None'
    ),
    jsonb_build_object(
      'first_name', 'Second', 'last_name', 'Guest', 'email', null,
      'phone', null, 'nationality', 'Testland', 'date_of_birth', '1992-02-03',
      'riding_experience', 'Intermediate — comfortable riding', 'dietary_notes', null
    )
  );
begin
  select id into strict v_project_id from public.tour_projects where slug = '8-lakes-tours';
  insert into public.customers(first_name, last_name, email, notes)
  values ('Existing', 'Customer', 'MiXeD.Runtime@Example.com', 'KEEP-EXISTING-NOTES')
  returning id into v_existing_customer_id;

  select * into strict v_first from public.create_public_booking(
    '123e4567-e89b-42d3-a456-426614174111', '8L-RUNTIME1', '8-lakes-tours',
    'September 15–23, 2026', 2, 'awaiting_payment', 3898, 1948, 1950,
    'Emergency Person', 'NEW-WAIVER-MUST-NOT-APPEND', 'Runtime booking notes', v_manifest
  );
  if not v_first.created then raise exception 'first call did not report created'; end if;
  if v_first.customer_id <> v_existing_customer_id then raise exception 'mixed-case customer was not reused'; end if;
  if (select notes from public.customers where id = v_existing_customer_id) <> 'KEEP-EXISTING-NOTES' then
    raise exception 'existing customer notes were mutated';
  end if;
  if (select count(*) from public.booking_travellers where booking_id = v_first.booking_id) <> 2 then
    raise exception 'exact manifest was not stored';
  end if;
  if exists (
    select 1 from public.booking_travellers where booking_id = v_first.booking_id
    and (position not in (1, 2) or is_lead <> (position = 1) or not details_complete)
  ) then raise exception 'manifest positions/lead/completeness are invalid'; end if;
  if (select count(*) from public.booking_events where booking_id = v_first.booking_id and title = 'Website booking submitted') <> 1 then
    raise exception 'initial booking event missing';
  end if;

  select * into strict v_replay from public.create_public_booking(
    '123e4567-e89b-42d3-a456-426614174111', '8L-DIFFERENT', '8-lakes-tours',
    'September 15–23, 2026', 2, 'awaiting_payment', 3898, 1948, 1950,
    'Emergency Person', 'NEW-WAIVER-MUST-NOT-APPEND', 'Runtime booking notes', v_manifest
  );
  if v_replay.created or v_replay.booking_id <> v_first.booking_id or v_replay.public_reference <> '8L-RUNTIME1' then
    raise exception 'idempotent replay did not return the original booking';
  end if;
  if (select count(*) from public.bookings where submission_key = '123e4567-e89b-42d3-a456-426614174111') <> 1 then
    raise exception 'idempotent replay created a duplicate';
  end if;

  begin
    perform * from public.create_public_booking(
      '123e4567-e89b-42d3-a456-426614174111', '8L-DIFFERENT', '8-lakes-tours',
      'Different date', 1, 'awaiting_payment', 1999, 999, 1000,
      null, null, null, jsonb_build_array(v_manifest->0)
    );
    raise exception 'changed replay unexpectedly succeeded';
  exception when others then
    if sqlerrm = 'changed replay unexpectedly succeeded' then raise; end if;
  end;

  -- Same submission key must not acknowledge discarded safety corrections.
  for changed in 1..7 loop
    begin
      perform * from public.create_public_booking(
        '123e4567-e89b-42d3-a456-426614174111', '8L-DIFFERENT', '8-lakes-tours',
        'September 15–23, 2026', 2, 'awaiting_payment', 3898, 1948, 1950,
        case when changed=6 then 'Different emergency' else 'Emergency Person' end,
        'NEW-WAIVER-MUST-NOT-APPEND',
        case when changed=7 then 'Changed booking notes' else 'Runtime booking notes' end,
        case when changed<=5 then jsonb_set(v_manifest, array['0', (array['date_of_birth','nationality','riding_experience','dietary_notes','phone'])[changed]],
          to_jsonb((array['2000-01-01','Otherland','Advanced — experienced rider','Allergy','+2 555'])[changed])) else v_manifest end
      );
      raise exception 'safety correction % silently discarded', changed;
    exception when others then
      if sqlerrm like 'safety correction %' then raise; end if;
    end;
  end loop;

  select count(*) into v_bad_customer_count from public.customers;
  select count(*) into v_bad_booking_count from public.bookings;
  select count(*) into v_bad_traveller_count from public.booking_travellers;
  begin
    perform * from public.create_public_booking(
      '123e4567-e89b-42d3-a456-426614174222', '8L-BAD', '8-lakes-tours',
      'September 15–23, 2026', 1, 'awaiting_payment', 1999, 999, 1000,
      null, 'new customer note', null,
      jsonb_build_array(jsonb_build_object(
        'first_name', 'Rollback', 'last_name', 'Test', 'email', 'rollback.runtime@example.com',
        'nationality', 'Testland', 'date_of_birth', '1990-01-02', 'riding_experience', 'invalid'
      ))
    );
    raise exception 'invalid manifest unexpectedly succeeded';
  exception when others then
    if sqlerrm = 'invalid manifest unexpectedly succeeded' then raise; end if;
  end;
  if (select count(*) from public.customers) <> v_bad_customer_count
     or (select count(*) from public.bookings) <> v_bad_booking_count
     or (select count(*) from public.booking_travellers) <> v_bad_traveller_count then
    raise exception 'failed RPC was not transactionally rolled back';
  end if;

  begin
    perform * from public.create_public_booking(
      gen_random_uuid(), '8L-NULLDOB', '8-lakes-tours',
      'September 15–23, 2026', 1, 'awaiting_payment', 1999, 999, 1000,
      null, null, null, jsonb_build_array((v_manifest->0) - 'date_of_birth')
    );
    raise exception 'missing DOB unexpectedly succeeded';
  exception when others then
    if sqlerrm = 'missing DOB unexpectedly succeeded' then raise; end if;
  end;

  for n in 1..8 loop
    v_group_pricing := case when n <= 2 then 1999 when n <= 4 then 1949 when n <= 6 then 1899 else 1799 end;
    v_group_online := 999 - (1999 - v_group_pricing) / 2;
    select jsonb_agg(jsonb_build_object(
      'first_name', 'Smoke', 'last_name', 'Guest' || pos,
      'email', case when pos = 1 then 'group-' || n || '@example.invalid' else null end,
      'nationality', 'Testland', 'date_of_birth', '1990-01-02',
      'riding_experience', 'Beginner — little to none'
    ) order by pos) into v_group_manifest from generate_series(1, n) pos;
    select * into strict v_replay from public.create_public_booking(
      gen_random_uuid(), '8L-GROUP' || n, '8-lakes-tours',
      'September 14 – 22, 2026', n, 'awaiting_payment', v_group_pricing * n, v_group_online * n, (v_group_pricing - v_group_online) * n,
      null, null, null, v_group_manifest
    );
    if (select count(*) from public.booking_travellers where booking_id = v_replay.booking_id) <> n then raise exception 'group % traveller count mismatch', n; end if;
    if not exists (select 1 from public.bookings where id = v_replay.booking_id and guest_count = n and online_due_usd = v_group_online * n and total_trip_value_usd = v_group_pricing * n and family_cash_due_usd = (v_group_pricing - v_group_online) * n) then raise exception 'group % stored totals mismatch', n; end if;
  end loop;

  for i in 1..6 loop
    select * into strict v_rate from public.consume_public_booking_rate_limits(v_ip_hash, v_email_hash);
    if (i <= 5 and not v_rate.allowed) or (i = 6 and v_rate.allowed) then
      raise exception 'email rate limit result wrong on attempt %', i;
    end if;
  end loop;

  select * into strict v_email_claim from public.claim_public_booking_email(
    v_first.booking_id, v_first.customer_id, 'runtime_test', 'recipient@example.com', 'Subject', 'Body'
  );
  if not v_email_claim.should_send then raise exception 'first email claim denied'; end if;
  perform public.finalize_public_booking_email(v_email_claim.email_event_id, true, 'provider-1', null, '{}'::jsonb);
  select * into strict v_email_claim from public.claim_public_booking_email(
    v_first.booking_id, v_first.customer_id, 'runtime_test', 'recipient@example.com', 'Subject', 'Body'
  );
  if v_email_claim.should_send then raise exception 'sent email was claimed twice'; end if;
end;
$$;

rollback;
