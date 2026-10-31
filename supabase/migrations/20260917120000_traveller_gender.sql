-- Traveller gender: optional, allowlisted value persisted end to end.
-- Canonical site repo owns this contract; Ops deploys only after this migration.
-- Allowlist mirrors the public booking form exactly (Male, Female, Non-binary).
-- Historical travellers stay NULL ("not provided"); no fabricated backfill.
-- Function bodies are the LIVE production definitions (verified byte-identical
-- to canonical 20260910000000/20260910010000 at commit e226fa1) with surgical
-- gender additions, so every later payment/ACL/cancellation change is preserved.
-- Absent 'gender' key in an Ops traveller item NEVER clears a saved value;
-- an explicit null clears it. Older clients that omit the key keep working.

alter table public.booking_travellers add column if not exists gender text;

do $$
begin
  if not exists (select 1 from pg_constraint
    where conname = 'traveller_gender_allowlist'
      and conrelid = 'public.booking_travellers'::regclass) then
    alter table public.booking_travellers
      add constraint traveller_gender_allowlist
      check (gender is null or gender in ('Male', 'Female', 'Non-binary'));
  end if;
end $$;

-- ============================================================
-- public.create_public_booking (live body + gender)
-- ============================================================
CREATE OR REPLACE FUNCTION public.create_public_booking(p_submission_key uuid, p_public_reference text, p_project_slug text, p_tour_date text, p_guest_count integer, p_status booking_status, p_total_trip_value_usd integer, p_online_due_usd integer, p_family_cash_due_usd integer, p_emergency_contact text, p_customer_notes text, p_booking_notes text, p_travellers jsonb)
 RETURNS TABLE(booking_id uuid, customer_id uuid, public_reference text, created boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $$
declare
  v_existing public.bookings%rowtype;
  v_customer_id uuid;
  v_booking_id uuid;
  v_project_id uuid;
  v_lead jsonb;
  v_item jsonb;
  v_position integer;
  v_payload jsonb;
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role'
     and coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role', '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_submission_key is null then raise exception 'submission key required'; end if;

  v_payload := jsonb_build_object('project',p_project_slug,'tour_date',p_tour_date,
    'guest_count',p_guest_count,'status',p_status,'total',p_total_trip_value_usd,
    'online',p_online_due_usd,'cash',p_family_cash_due_usd,
    'emergency_contact',p_emergency_contact,'customer_notes',p_customer_notes,
    'booking_notes',p_booking_notes,'travellers',p_travellers);
  -- Serialize the same submission key before any customer mutation so concurrent
  -- retries cannot create duplicate bookings or orphan customers.
  perform pg_advisory_xact_lock(hashtextextended(p_submission_key::text, 0));
  select b.* into v_existing from public.bookings b where b.submission_key = p_submission_key;
  if found then
    if v_existing.submission_payload is distinct from v_payload
       or v_existing.tour_date is distinct from p_tour_date
       or v_existing.guest_count is distinct from p_guest_count
       or v_existing.total_trip_value_usd is distinct from p_total_trip_value_usd
       or v_existing.online_due_usd is distinct from p_online_due_usd
       or v_existing.family_cash_due_usd is distinct from p_family_cash_due_usd
       or not exists (select 1 from public.tour_projects p where p.id = v_existing.project_id and p.slug = p_project_slug)
       or exists (
         select 1 from jsonb_array_elements(p_travellers) with ordinality as incoming(item, pos)
         left join public.booking_travellers t on t.booking_id = v_existing.id and t.position = incoming.pos
         where t.id is null
           or t.first_name is distinct from incoming.item->>'first_name'
           or t.last_name is distinct from incoming.item->>'last_name'
           or t.email is distinct from nullif(lower(incoming.item->>'email'), '')
       ) then
      raise exception 'submission key already belongs to a different booking payload';
    end if;
    return query select v_existing.id, v_existing.customer_id, v_existing.public_reference, false;
    return;
  end if;

  if p_guest_count < 1 or p_guest_count > 8
     or jsonb_typeof(p_travellers) <> 'array'
     or jsonb_array_length(p_travellers) <> p_guest_count then
    raise exception 'traveller manifest must exactly match guest count';
  end if;
  if length(p_public_reference) > 32 or length(p_tour_date) > 160
     or length(coalesce(p_emergency_contact, '')) > 200
     or length(coalesce(p_customer_notes, '')) > 2500
     or length(coalesce(p_booking_notes, '')) > 6000 then
    raise exception 'booking field too long';
  end if;

  v_lead := p_travellers -> 0;
  if lower(coalesce(v_lead->>'email', '')) !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'valid lead email required';
  end if;

  select p.id into v_project_id from public.tour_projects p where p.slug = p_project_slug and p.active;
  if v_project_id is null then raise exception 'booking project is not configured'; end if;

  -- Match mixed-case legacy email addresses. Existing customers are intentionally
  -- left unchanged; waiver/attribution notes apply only on first creation.
  select c.id into v_customer_id from public.customers c
  where lower(c.email) = lower(v_lead->>'email')
  order by c.created_at limit 1 for update;
  if v_customer_id is null then
    insert into public.customers(first_name, last_name, email, phone, nationality, emergency_contact, notes)
    values (v_lead->>'first_name', v_lead->>'last_name', lower(v_lead->>'email'),
      nullif(v_lead->>'phone', ''), v_lead->>'nationality', nullif(p_emergency_contact, ''), nullif(p_customer_notes, ''))
    on conflict (lower(email)) do nothing
    returning id into v_customer_id;
    if v_customer_id is null then
      select c.id into strict v_customer_id from public.customers c
      where lower(c.email) = lower(v_lead->>'email');
    end if;
  end if;

  insert into public.bookings(
    submission_key, submission_payload, public_reference, project_id, customer_id, tour_date, guest_count,
    status, riding_experience, dietary_notes, notes, form_source,
    total_trip_value_usd, online_due_usd, online_paid_usd, family_cash_due_usd
  ) values (
    p_submission_key, v_payload, p_public_reference, v_project_id, v_customer_id, p_tour_date, p_guest_count,
    p_status, v_lead->>'riding_experience', nullif(v_lead->>'dietary_notes', ''), nullif(p_booking_notes, ''), 'website',
    p_total_trip_value_usd, p_online_due_usd, 0, p_family_cash_due_usd
  ) returning id into v_booking_id;

  for v_item, v_position in
    select value, ordinality::integer from jsonb_array_elements(p_travellers) with ordinality
  loop
    if length(coalesce(v_item->>'first_name', '')) not between 1 and 100
       or length(coalesce(v_item->>'last_name', '')) not between 1 and 100
       or length(coalesce(v_item->>'nationality', '')) not between 1 and 80
       or length(coalesce(v_item->>'email', '')) > 254
       or length(coalesce(v_item->>'phone', '')) > 40
       or length(coalesce(v_item->>'dietary_notes', '')) > 1000
       or nullif(v_item->>'date_of_birth', '') is null
       or nullif(v_item->>'riding_experience', '') is null
       or (v_item->>'date_of_birth')::date < date '1900-01-01'
       or (v_item->>'date_of_birth')::date > current_date
       or v_item->>'riding_experience' not in (
         'Beginner — little to none', 'Intermediate — comfortable riding', 'Advanced — experienced rider'
       )
       or (nullif(v_item->>'gender', '') is not null
           and nullif(v_item->>'gender', '') not in ('Male', 'Female', 'Non-binary')) then
      raise exception 'traveller % is invalid or incomplete', v_position;
    end if;

    insert into public.booking_travellers(
      booking_id, position, is_lead, first_name, last_name, email, phone,
      nationality, gender, date_of_birth, riding_experience, dietary_notes
    ) values (
      v_booking_id, v_position, v_position = 1, v_item->>'first_name', v_item->>'last_name',
      nullif(lower(v_item->>'email'), ''), nullif(v_item->>'phone', ''), v_item->>'nationality',
      nullif(v_item->>'gender', ''),
      (v_item->>'date_of_birth')::date, v_item->>'riding_experience', nullif(v_item->>'dietary_notes', '')
    );
  end loop;

  insert into public.booking_events(booking_id, event_type, direction, title, body, created_by)
  values (v_booking_id, 'system', 'system', 'Website booking submitted',
    format('%s traveller manifest saved atomically.', p_guest_count), 'website-form');

  return query select v_booking_id, v_customer_id, p_public_reference, true;
end;
$$;


-- ============================================================
-- public.update_ops_booking_record (live body + gender)
-- ============================================================
CREATE OR REPLACE FUNCTION public.update_ops_booking_record(p_project_id uuid, p_reference text, p_revision text, p_booking jsonb, p_customer jsonb, p_travellers jsonb, p_title text, p_body text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $$
declare b public.bookings; c public.customers; n public.bookings;
  nc public.customers; t public.booking_travellers; item jsonb; snap jsonb;
begin
  -- snapshot also enforces the service role and canonical project contract.
  perform public.ops_booking_snapshot(p_project_id,p_reference);
  select * into b from public.bookings where project_id=p_project_id and public_reference=p_reference for update;
  if not found then raise exception 'booking not found' using errcode='P0002'; end if;
  select * into c from public.customers where id=b.customer_id for update;
  perform 1 from public.booking_travellers where booking_id=b.id order by position for update;
  snap := public.ops_booking_snapshot(p_project_id,p_reference);
  if p_revision is null or p_revision is distinct from snap->>'revision' then
    raise exception 'stale booking record; reload before saving' using errcode='40001';
  end if;
  n := jsonb_populate_record(b,p_booking);
  nc := jsonb_populate_record(c,p_customer);
  if n.guest_count not between 1 and 8 or n.guest_count is null
    or least(n.online_due_usd,n.online_paid_usd,n.family_cash_due_usd,n.total_trip_value_usd)<0
    or n.online_due_usd is null or n.online_paid_usd is null or n.family_cash_due_usd is null or n.total_trip_value_usd is null then
    raise exception 'invalid guest count or amounts';
  end if;
  if n.status='cancelled' and b.payment_confirmation_token is not null
     and (b.payment_confirmation_claimed_at is null or b.payment_confirmation_claimed_at >= clock_timestamp()-interval '5 minutes') then
    raise exception 'payment confirmation is in progress';
  end if;
  if jsonb_typeof(p_travellers) is distinct from 'array' or jsonb_array_length(p_travellers)>8
    or not exists(select 1 from jsonb_array_elements(p_travellers) x where x->>'position'='1') then
    raise exception 'invalid traveller manifest';
  end if;
  if nullif(trim(nc.first_name),'') is null or nullif(trim(nc.last_name),'') is null or nullif(trim(nc.email),'') is null then
    raise exception 'customer identity required';
  end if;
  -- Explicit allowlists: never update IDs, scope, cash-paid history or leases
  -- from a caller payload. A manual paid-total edit remains explicit and audited.
  update public.bookings set tour_date=n.tour_date, guest_count=n.guest_count, status=n.status,
    riding_experience=n.riding_experience,dietary_notes=n.dietary_notes,notes=n.notes,
    total_trip_value_usd=n.total_trip_value_usd,online_due_usd=n.online_due_usd,
    online_paid_usd=n.online_paid_usd,family_cash_due_usd=n.family_cash_due_usd,updated_at=clock_timestamp(),
    payment_confirmation_token=case when n.status='cancelled' then null else b.payment_confirmation_token end,
    payment_confirmation_claimed_at=case when n.status='cancelled' then null else b.payment_confirmation_claimed_at end
  where id=b.id and project_id=p_project_id;
  update public.customers set first_name=nc.first_name,last_name=nc.last_name,email=nc.email,
    phone=nc.phone,whatsapp=nc.whatsapp,nationality=nc.nationality,emergency_contact=nc.emergency_contact,
    notes=nc.notes,updated_at=clock_timestamp() where id=b.customer_id;
  for item in select value from jsonb_array_elements(p_travellers) loop
    t := jsonb_populate_record(null::public.booking_travellers,item);
    if nullif(trim(t.first_name),'') is null or nullif(trim(t.last_name),'') is null then
      raise exception 'traveller name required';
    end if;
    if t.gender is not null and t.gender not in ('Male', 'Female', 'Non-binary') then
      raise exception 'traveller % gender is invalid', t.position;
    end if;
    if t.position=1 then
      t.first_name:=nc.first_name; t.last_name:=nc.last_name; t.email:=nc.email; t.phone:=nc.phone; t.nationality:=nc.nationality;
    end if;
    insert into public.booking_travellers(booking_id,position,is_lead,first_name,last_name,email,phone,nationality,gender,date_of_birth,riding_experience,dietary_notes)
    values(b.id,t.position,t.position=1,t.first_name,t.last_name,t.email,t.phone,t.nationality,t.gender,t.date_of_birth,t.riding_experience,t.dietary_notes)
    on conflict(booking_id,position) do update set first_name=excluded.first_name,last_name=excluded.last_name,
      email=excluded.email,phone=excluded.phone,nationality=excluded.nationality,date_of_birth=excluded.date_of_birth,
      riding_experience=excluded.riding_experience,dietary_notes=excluded.dietary_notes,
      gender=case when item ? 'gender' then excluded.gender else public.booking_travellers.gender end;
  end loop;
  -- Missing legacy companion slots and overflow rows are deliberately retained.
  insert into public.booking_events(booking_id,event_type,direction,title,body,created_by)
  values(b.id,'status','system',p_title,p_body || case when b.online_paid_usd<>n.online_paid_usd
    then format(E'\nManual online paid correction: %s -> %s USD',b.online_paid_usd,n.online_paid_usd) else '' end,'ops-pin-user');
  return public.ops_booking_snapshot(p_project_id,p_reference);
end $$;


-- ============================================================
-- public.ops_booking_snapshot (live body, unchanged: to_jsonb
-- already includes gender and the revision hash covers it)
-- ============================================================
CREATE OR REPLACE FUNCTION public.ops_booking_snapshot(p_project_id uuid, p_reference text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $$
declare v jsonb;
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role'
     and coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role', '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  select jsonb_build_object('booking', to_jsonb(b), 'customer', to_jsonb(c),
    'travellers', coalesce((select jsonb_agg(to_jsonb(t) order by t.position)
      from public.booking_travellers t where t.booking_id=b.id), '[]'::jsonb)) into v
  from public.bookings b join public.customers c on c.id=b.customer_id
  join public.tour_projects p on p.id=b.project_id and p.slug='8-lakes-tours'
  where b.project_id=p_project_id and b.public_reference=p_reference;
  if v is null then raise exception 'booking not found' using errcode='P0002'; end if;
  return v || jsonb_build_object('revision', md5(v::text));
end $$;


-- Idempotent re-issue of the unchanged ACL contract (no new exposure).
revoke all on function public.create_public_booking(uuid, text, text, text, integer, public.booking_status, integer, integer, integer, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.update_ops_booking_record(uuid, text, text, jsonb, jsonb, jsonb, text, text) from public, anon, authenticated;
revoke all on function public.ops_booking_snapshot(uuid, text) from public, anon, authenticated;
grant execute on function public.create_public_booking(uuid, text, text, text, integer, public.booking_status, integer, integer, integer, text, text, text, jsonb) to service_role;
grant execute on function public.update_ops_booking_record(uuid, text, text, jsonb, jsonb, jsonb, text, text) to service_role;
grant execute on function public.ops_booking_snapshot(uuid, text) to service_role;
