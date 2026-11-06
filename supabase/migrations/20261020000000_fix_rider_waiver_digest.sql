-- Fix: record_rider_waiver called public.digest() from pgcrypto, which lives in the
-- extensions schema on Supabase, so every waiver signature failed (42883).
-- Use Postgres's built-in pg_catalog.sha256() instead; the function is otherwise unchanged.

create or replace function public.record_rider_waiver(
  p_reference text, p_project_slug text, p_rider_name text, p_rider_email text,
  p_date_of_birth date, p_guardian_name text, p_guardian_relationship text,
  p_signature text, p_waiver_version text, p_signed_waiver_text text,
  p_signed_waiver_text_sha256 text, p_submission_key text, p_trusted_ip text, p_ip_provenance text, p_user_agent text
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
  v_snapshot_matches boolean;
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role'
     and coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role', '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_submission_key !~ '^[0-9a-f]{64}$' then raise exception 'invalid waiver submission key'; end if;
  if length(p_signed_waiver_text) < 100 or length(p_signed_waiver_text) > 20000 then raise exception 'invalid signed waiver text'; end if;
  if p_signed_waiver_text_sha256 !~ '^[0-9a-f]{64}$' or p_signed_waiver_text_sha256 <> encode(pg_catalog.sha256(pg_catalog.convert_to(p_signed_waiver_text, 'UTF8')), 'hex') then
    raise exception 'signed waiver text hash mismatch';
  end if;
  if p_ip_provenance not in ('vercel_forwarded', 'unavailable') then raise exception 'invalid IP provenance'; end if;

  select p.id into v_project_id from public.tour_projects p where p.slug = p_project_slug and p.active;
  if v_project_id is null then raise exception 'waiver project is not configured'; end if;
  select b.* into v_booking from public.bookings b where b.public_reference = p_reference and b.project_id = v_project_id for update;
  if not found then raise exception 'booking not found for waiver reference' using errcode = 'P0002'; end if;

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
    v_snapshot_matches := v_existing.project_id = v_project_id
      and v_existing.booking_id = v_booking.id
      and v_existing.rider_name_snapshot = trim(p_rider_name)
      and v_existing.rider_email_snapshot = lower(trim(p_rider_email))
      and v_existing.rider_date_of_birth_snapshot = p_date_of_birth
      and v_existing.guardian_name_snapshot is not distinct from case when v_minor then trim(p_guardian_name) end
      and v_existing.guardian_relationship_snapshot is not distinct from case when v_minor then trim(p_guardian_relationship) end
      and v_existing.signature_snapshot = trim(p_signature)
      and v_existing.waiver_version = p_waiver_version
      and v_existing.signed_waiver_text = p_signed_waiver_text
      and v_existing.signed_waiver_text_sha256 = p_signed_waiver_text_sha256;
    if not v_snapshot_matches then
      raise exception 'waiver snapshot conflicts with existing submission key' using errcode = 'P0003';
    end if;
    return query select v_existing.id, v_existing.match_status, false, v_existing.is_minor;
    return;
  end if;
  -- Version retry behavior: an existing matched signature for this exact traveller
  -- and waiver version is success only if every immutable signed field matches.
  if v_traveller_id is not null then
    select w.* into v_existing from public.rider_waivers w
    where w.booking_traveller_id = v_traveller_id and w.waiver_version = p_waiver_version and w.match_status = 'matched';
    if found then
      v_snapshot_matches := v_existing.project_id = v_project_id
        and v_existing.booking_id = v_booking.id
        and v_existing.rider_name_snapshot = trim(p_rider_name)
        and v_existing.rider_email_snapshot = lower(trim(p_rider_email))
        and v_existing.rider_date_of_birth_snapshot = p_date_of_birth
        and v_existing.guardian_name_snapshot is not distinct from case when v_minor then trim(p_guardian_name) end
        and v_existing.guardian_relationship_snapshot is not distinct from case when v_minor then trim(p_guardian_relationship) end
        and v_existing.signature_snapshot = trim(p_signature)
        and v_existing.waiver_version = p_waiver_version
        and v_existing.signed_waiver_text = p_signed_waiver_text
        and v_existing.signed_waiver_text_sha256 = p_signed_waiver_text_sha256;
      if not v_snapshot_matches then
        raise exception 'waiver snapshot conflicts with existing traveller/version signature' using errcode = 'P0003';
      end if;
      return query select v_existing.id, v_existing.match_status, false, v_existing.is_minor;
      return;
    end if;
  end if;

  insert into public.rider_waivers as w(
    project_id, booking_id, booking_traveller_id, match_status, submission_key,
    rider_name_snapshot, rider_email_snapshot, rider_date_of_birth_snapshot, rider_age_at_signing, is_minor,
    guardian_name_snapshot, guardian_relationship_snapshot, signature_snapshot, waiver_version, signed_waiver_text, signed_waiver_text_sha256,
    trusted_ip_address, ip_provenance, user_agent
  ) values (
    v_project_id, v_booking.id, v_traveller_id,
    case when v_traveller_id is not null then 'matched' when coalesce(array_length(v_traveller_ids, 1), 0) > 1 then 'ambiguous' else 'unmatched' end,
    p_submission_key, trim(p_rider_name), lower(trim(p_rider_email)), p_date_of_birth, v_age, v_minor,
    case when v_minor then trim(p_guardian_name) end, case when v_minor then trim(p_guardian_relationship) end,
    trim(p_signature), p_waiver_version, p_signed_waiver_text, p_signed_waiver_text_sha256,
    case when p_ip_provenance = 'vercel_forwarded' and nullif(p_trusted_ip, '') is not null then p_trusted_ip::inet end,
    p_ip_provenance, nullif(left(p_user_agent, 300), '')
  ) returning w.id, w.match_status, w.is_minor into waiver_id, match_status, is_minor;
  should_email := true;
  return next;
end;
$$;
