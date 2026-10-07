-- Immutable, per-rider liability waivers. This migration is additive and deliberately
-- does not backfill historical email-only signatures.
create table if not exists public.rider_waivers (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.tour_projects(id) on delete restrict,
  booking_id uuid not null references public.bookings(id) on delete cascade,
  booking_traveller_id uuid references public.booking_travellers(id) on delete restrict,
  match_status text not null check (match_status in ('matched', 'unmatched', 'ambiguous')),
  submission_key text not null check (submission_key ~ '^[0-9a-f]{64}$'),
  rider_name_snapshot text not null check (length(rider_name_snapshot) between 3 and 150),
  rider_email_snapshot text not null check (length(rider_email_snapshot) between 3 and 254),
  rider_date_of_birth_snapshot date not null,
  rider_age_at_signing integer not null check (rider_age_at_signing between 16 and 125),
  is_minor boolean not null,
  guardian_name_snapshot text,
  guardian_relationship_snapshot text,
  signature_snapshot text not null check (length(signature_snapshot) between 3 and 150),
  waiver_version text not null check (length(waiver_version) between 1 and 64),
  signed_waiver_text text not null,
  server_signed_at timestamptz not null default clock_timestamp(),
  trusted_ip_address inet,
  ip_provenance text not null check (ip_provenance in ('vercel_forwarded', 'unavailable')),
  user_agent text,
  created_at timestamptz not null default clock_timestamp(),
  check ((is_minor and guardian_name_snapshot is not null and guardian_relationship_snapshot is not null) or (not is_minor and guardian_name_snapshot is null and guardian_relationship_snapshot is null)),
  unique (submission_key)
);

create unique index if not exists rider_waivers_one_current_signature_per_traveller
  on public.rider_waivers (booking_traveller_id, waiver_version)
  where match_status = 'matched' and booking_traveller_id is not null;
create index if not exists rider_waivers_ops_booking_idx on public.rider_waivers (project_id, booking_id, server_signed_at desc);

-- Each destination has one durable, frozen dispatch claim. A provider timeout is
-- intentionally not retried: it remains reconciliation_required rather than
-- risking a second legal-record email after the provider idempotency window.
create table if not exists public.rider_waiver_email_dispatches (
  id uuid primary key default gen_random_uuid(),
  waiver_id uuid not null references public.rider_waivers(id) on delete cascade,
  destination text not null check (destination in ('internal', 'rider')),
  recipient_email text not null check (length(recipient_email) between 3 and 2000),
  status text not null check (status in ('queued', 'failed', 'sent', 'reconciliation_required')),
  claim_token uuid,
  claimed_at timestamptz,
  provider_attempted_at timestamptz,
  provider_completed_at timestamptz,
  provider_message_id text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (waiver_id, destination)
);
create index if not exists rider_waiver_email_dispatches_open_idx
  on public.rider_waiver_email_dispatches (waiver_id) where status in ('queued', 'reconciliation_required');

create or replace function public.record_rider_waiver(
  p_reference text, p_project_slug text, p_rider_name text, p_rider_email text,
  p_date_of_birth date, p_guardian_name text, p_guardian_relationship text,
  p_signature text, p_waiver_version text, p_signed_waiver_text text,
  p_submission_key text, p_trusted_ip text, p_ip_provenance text, p_user_agent text
) returns table(waiver_id uuid, match_status text, should_email boolean, is_minor boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_booking public.bookings%rowtype;
  v_project_id uuid;
  v_traveller_ids uuid[];
  v_traveller_id uuid;
  v_age integer;
  v_minor boolean;
  v_existing public.rider_waivers%rowtype;
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role'
     and coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role', '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_submission_key !~ '^[0-9a-f]{64}$' then raise exception 'invalid waiver submission key'; end if;
  if length(p_signed_waiver_text) < 100 or length(p_signed_waiver_text) > 20000 then raise exception 'invalid signed waiver text'; end if;
  if p_ip_provenance not in ('vercel_forwarded', 'unavailable') then raise exception 'invalid IP provenance'; end if;

  select p.id into v_project_id from public.tour_projects p where p.slug = p_project_slug and p.active;
  if v_project_id is null then raise exception 'waiver project is not configured'; end if;
  select b.* into v_booking from public.bookings b where b.public_reference = p_reference and b.project_id = v_project_id for update;
  if not found then raise exception 'booking not found for waiver reference'; end if;

  select array_agg(t.id order by t.position) into v_traveller_ids
  from public.booking_travellers t
  where t.booking_id = v_booking.id
    and t.date_of_birth = p_date_of_birth
    and lower(coalesce(t.email, '')) = lower(trim(p_rider_email))
    and lower(regexp_replace(concat_ws(' ', t.first_name, t.last_name), '\s+', ' ', 'g')) = lower(regexp_replace(trim(p_rider_name), '\s+', ' ', 'g'));
  if coalesce(array_length(v_traveller_ids, 1), 0) = 1 then
    v_traveller_id := v_traveller_ids[1];
  end if;
  select extract(year from age(current_date, p_date_of_birth))::integer into v_age;
  if v_age < 16 or v_age > 125 then raise exception 'invalid rider age'; end if;
  v_minor := v_age < 18;
  if v_minor and (nullif(trim(p_guardian_name), '') is null or nullif(trim(p_guardian_relationship), '') is null) then
    raise exception 'guardian required for minor';
  end if;
  if not v_minor and (p_guardian_name is not null or p_guardian_relationship is not null) then
    raise exception 'guardian only allowed for minor';
  end if;
  if v_minor and lower(regexp_replace(trim(p_signature), '\s+', ' ', 'g')) <> lower(regexp_replace(trim(p_guardian_name), '\s+', ' ', 'g')) then
    raise exception 'guardian signature must match guardian name';
  end if;
  if not v_minor and lower(regexp_replace(trim(p_signature), '\s+', ' ', 'g')) <> lower(regexp_replace(trim(p_rider_name), '\s+', ' ', 'g')) then
    raise exception 'rider signature must match rider name';
  end if;

  select w.* into v_existing from public.rider_waivers w where w.submission_key = p_submission_key;
  if found then
    return query select v_existing.id, v_existing.match_status, false, v_existing.is_minor;
    return;
  end if;
  -- Version retry behavior: an existing matched signature for this exact traveller
  -- and waiver version is success without a duplicate record or duplicate email.
  if v_traveller_id is not null then
    select w.* into v_existing from public.rider_waivers w
    where w.booking_traveller_id = v_traveller_id and w.waiver_version = p_waiver_version and w.match_status = 'matched';
    if found then
      return query select v_existing.id, v_existing.match_status, false, v_existing.is_minor;
      return;
    end if;
  end if;

  insert into public.rider_waivers as w(
    project_id, booking_id, booking_traveller_id, match_status, submission_key,
    rider_name_snapshot, rider_email_snapshot, rider_date_of_birth_snapshot, rider_age_at_signing, is_minor,
    guardian_name_snapshot, guardian_relationship_snapshot, signature_snapshot, waiver_version, signed_waiver_text,
    trusted_ip_address, ip_provenance, user_agent
  ) values (
    v_project_id, v_booking.id, v_traveller_id,
    case when v_traveller_id is not null then 'matched' when coalesce(array_length(v_traveller_ids, 1), 0) > 1 then 'ambiguous' else 'unmatched' end,
    p_submission_key, trim(p_rider_name), lower(trim(p_rider_email)), p_date_of_birth, v_age, v_minor,
    case when v_minor then trim(p_guardian_name) end, case when v_minor then trim(p_guardian_relationship) end,
    trim(p_signature), p_waiver_version, p_signed_waiver_text,
    case when p_ip_provenance = 'vercel_forwarded' and nullif(p_trusted_ip, '') is not null then p_trusted_ip::inet end,
    p_ip_provenance, nullif(left(p_user_agent, 300), '')
  ) returning w.id, w.match_status, w.is_minor into waiver_id, match_status, is_minor;
  should_email := true;
  return next;
end;
$$;

create or replace function public.claim_rider_waiver_email_dispatch(
  p_waiver_id uuid, p_destination text, p_recipient_email text, p_claim_token uuid,
  p_now timestamptz default clock_timestamp()
) returns table(should_send boolean, dispatch_id uuid, recipient_email text, idempotency_key text, reason text)
language plpgsql security definer set search_path = '' as $$
declare d public.rider_waiver_email_dispatches%rowtype;
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role'
     and coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role', '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_destination not in ('internal', 'rider') or nullif(trim(p_recipient_email), '') is null or p_claim_token is null then
    raise exception 'invalid waiver email dispatch claim';
  end if;
  perform 1 from public.rider_waivers where id=p_waiver_id and match_status='matched' for update;
  if not found then
    return query select false, null::uuid, null::text, null::text, 'waiver_not_matched';
    return;
  end if;
  select * into d from public.rider_waiver_email_dispatches
    where waiver_id=p_waiver_id and destination=p_destination for update;
  if found then
    if d.status in ('sent', 'reconciliation_required') then
      return query select false, d.id, d.recipient_email, '8l-waiver-' || d.id::text, d.status;
      return;
    end if;
    if d.status='queued' and (d.claimed_at is null or d.claimed_at >= p_now - interval '5 minutes' or d.provider_attempted_at is not null) then
      return query select false, d.id, d.recipient_email, '8l-waiver-' || d.id::text, 'dispatch_active_or_unknown';
      return;
    end if;
    -- A known provider rejection is retryable; retain the original recipient and
    -- stable provider key. A stale pre-attempt claim can also be safely reclaimed.
    update public.rider_waiver_email_dispatches set status='queued', claim_token=p_claim_token,
      claimed_at=p_now, provider_attempted_at=null, provider_completed_at=null, provider_message_id=null,
      updated_at=clock_timestamp() where id=d.id;
    return query select true, d.id, d.recipient_email, '8l-waiver-' || d.id::text, null::text;
    return;
  end if;
  insert into public.rider_waiver_email_dispatches(waiver_id,destination,recipient_email,status,claim_token,claimed_at)
    values(p_waiver_id,p_destination,trim(p_recipient_email),'queued',p_claim_token,p_now)
    returning id into dispatch_id;
  should_send := true;
  recipient_email := trim(p_recipient_email);
  idempotency_key := '8l-waiver-' || dispatch_id::text;
  reason := null;
  return next;
end;
$$;

create or replace function public.mark_rider_waiver_email_provider_attempted(
  p_dispatch_id uuid, p_claim_token uuid, p_now timestamptz default clock_timestamp()
) returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role'
     and coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role', '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  update public.rider_waiver_email_dispatches set provider_attempted_at=p_now, updated_at=clock_timestamp()
    where id=p_dispatch_id and status='queued' and claim_token=p_claim_token and provider_attempted_at is null;
  return found;
end;
$$;

create or replace function public.complete_rider_waiver_email_dispatch(
  p_dispatch_id uuid, p_claim_token uuid, p_sent boolean, p_definite_failure boolean,
  p_provider_message_id text, p_now timestamptz default clock_timestamp()
) returns boolean language plpgsql security definer set search_path = '' as $$
declare v_status text;
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role'
     and coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role', '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  v_status := case when p_sent then 'sent' when p_definite_failure then 'failed' else 'reconciliation_required' end;
  update public.rider_waiver_email_dispatches set status=v_status, provider_message_id=p_provider_message_id,
    provider_completed_at=p_now, claim_token=null, claimed_at=null, updated_at=clock_timestamp()
    where id=p_dispatch_id and status='queued' and claim_token=p_claim_token and provider_attempted_at is not null;
  return found;
end;
$$;

alter table public.rider_waivers enable row level security;
revoke all on table public.rider_waivers from public, anon, authenticated;
grant select, insert, update, delete on table public.rider_waivers to service_role;
alter table public.rider_waiver_email_dispatches enable row level security;
revoke all on table public.rider_waiver_email_dispatches from public, anon, authenticated;
grant select, insert, update, delete on table public.rider_waiver_email_dispatches to service_role;
revoke all on function public.record_rider_waiver(text, text, text, text, date, text, text, text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.record_rider_waiver(text, text, text, text, date, text, text, text, text, text, text, text, text, text) to service_role;
revoke all on function public.claim_rider_waiver_email_dispatch(uuid,text,text,uuid,timestamptz),public.mark_rider_waiver_email_provider_attempted(uuid,uuid,timestamptz),public.complete_rider_waiver_email_dispatch(uuid,uuid,boolean,boolean,text,timestamptz) from public, anon, authenticated;
grant execute on function public.claim_rider_waiver_email_dispatch(uuid,text,text,uuid,timestamptz),public.mark_rider_waiver_email_provider_attempted(uuid,uuid,timestamptz),public.complete_rider_waiver_email_dispatch(uuid,uuid,boolean,boolean,text,timestamptz) to service_role;