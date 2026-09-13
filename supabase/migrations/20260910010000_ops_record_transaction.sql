-- Canonical site owns this contract; Ops must deploy only after this migration.
-- Revision covers raw financial/status/lease, customer and manifest data, not
-- updated_at alone (webhook writers do not universally bump that column).
create or replace function public.ops_booking_snapshot(p_project_id uuid, p_reference text)
returns jsonb language plpgsql security definer set search_path = '' as $$
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

create or replace function public.update_ops_booking_record(
  p_project_id uuid, p_reference text, p_revision text,
  p_booking jsonb, p_customer jsonb, p_travellers jsonb,
  p_title text, p_body text
) returns jsonb language plpgsql security definer set search_path = '' as $$
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
    if t.position=1 then
      t.first_name:=nc.first_name; t.last_name:=nc.last_name; t.email:=nc.email; t.phone:=nc.phone; t.nationality:=nc.nationality;
    end if;
    insert into public.booking_travellers(booking_id,position,is_lead,first_name,last_name,email,phone,nationality,date_of_birth,riding_experience,dietary_notes)
    values(b.id,t.position,t.position=1,t.first_name,t.last_name,t.email,t.phone,t.nationality,t.date_of_birth,t.riding_experience,t.dietary_notes)
    on conflict(booking_id,position) do update set first_name=excluded.first_name,last_name=excluded.last_name,
      email=excluded.email,phone=excluded.phone,nationality=excluded.nationality,date_of_birth=excluded.date_of_birth,
      riding_experience=excluded.riding_experience,dietary_notes=excluded.dietary_notes;
  end loop;
  -- Missing legacy companion slots and overflow rows are deliberately retained.
  insert into public.booking_events(booking_id,event_type,direction,title,body,created_by)
  values(b.id,'status','system',p_title,p_body || case when b.online_paid_usd<>n.online_paid_usd
    then format(E'\nManual online paid correction: %s -> %s USD',b.online_paid_usd,n.online_paid_usd) else '' end,'ops-pin-user');
  return public.ops_booking_snapshot(p_project_id,p_reference);
end $$;
revoke all on function public.ops_booking_snapshot(uuid,text) from public,anon,authenticated;
revoke all on function public.update_ops_booking_record(uuid,text,text,jsonb,jsonb,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.ops_booking_snapshot(uuid,text) to service_role;
grant execute on function public.update_ops_booking_record(uuid,text,text,jsonb,jsonb,jsonb,text,text) to service_role;
