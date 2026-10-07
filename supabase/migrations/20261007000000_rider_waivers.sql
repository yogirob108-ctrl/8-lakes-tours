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

  insert into public.rider_waivers(
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
  ) returning id, match_status, is_minor into waiver_id, match_status, is_minor;
  should_email := true;
  return next;
end;
$$;

alter table public.rider_waivers enable row level security;
revoke all on table public.rider_waivers from public, anon, authenticated;
grant select, insert, update, delete on table public.rider_waivers to service_role;
revoke all on function public.record_rider_waiver(text, text, text, text, date, text, text, text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.record_rider_waiver(text, text, text, text, date, text, text, text, text, text, text, text, text, text) to service_role;