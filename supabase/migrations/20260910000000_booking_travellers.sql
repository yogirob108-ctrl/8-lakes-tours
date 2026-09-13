-- Atomic, idempotent public booking intake and private traveller manifest.

alter table public.bookings add column if not exists submission_key uuid;
-- Immutable intake snapshot: retries compare every supplied safety/consent field,
-- even when a shared customer already exists or Ops later edits the record.
alter table public.bookings add column if not exists submission_payload jsonb;
create unique index if not exists bookings_submission_key_unique
  on public.bookings (submission_key) where submission_key is not null;

create table if not exists public.booking_travellers (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  position integer not null check (position between 1 and 8),
  is_lead boolean not null default false check (is_lead = (position = 1)),
  first_name text not null,
  last_name text not null,
  email text,
  phone text,
  nationality text,
  date_of_birth date,
  riding_experience text,
  dietary_notes text,
  details_complete boolean generated always as (
    first_name <> '' and last_name <> '' and nationality is not null and nationality <> ''
    and date_of_birth is not null and riding_experience is not null and riding_experience <> ''
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (booking_id, position)
);

alter table public.booking_travellers
  add column if not exists details_complete boolean generated always as (
    first_name <> '' and last_name <> '' and nationality is not null and nationality <> ''
    and date_of_birth is not null and riding_experience is not null and riding_experience <> ''
  ) stored;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'booking_travellers_lead_position_check') then
    alter table public.booking_travellers add constraint booking_travellers_lead_position_check
      check (is_lead = (position = 1));
  end if;
end $$;

create index if not exists booking_travellers_booking_idx
  on public.booking_travellers (booking_id, position);

create or replace function public.set_booking_traveller_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists booking_travellers_set_updated_at on public.booking_travellers;
create trigger booking_travellers_set_updated_at before update on public.booking_travellers
for each row execute function public.set_booking_traveller_updated_at();

-- Legacy bookings retain a nullable DOB and are visibly incomplete until Ops backfills them.
insert into public.booking_travellers (
  booking_id, position, is_lead, first_name, last_name, email, phone,
  nationality, date_of_birth, riding_experience, dietary_notes
)
select b.id, 1, true, c.first_name, c.last_name, c.email, c.phone,
  c.nationality, null, b.riding_experience, b.dietary_notes
from public.bookings b join public.customers c on c.id = b.customer_id
join public.tour_projects p on p.id = b.project_id and p.slug = '8-lakes-tours'
on conflict (booking_id, position) do nothing;

create table if not exists public.public_booking_rate_limits (
  key_hash text not null check (key_hash ~ '^[0-9a-f]{64}$'),
  key_kind text not null check (key_kind in ('ip', 'email')),
  bucket_start timestamptz not null,
  attempts integer not null default 1 check (attempts > 0),
  primary key (key_hash, key_kind, bucket_start)
);

alter table public.email_events add column if not exists public_submission_email_key text;
create unique index if not exists email_events_public_submission_key_unique
  on public.email_events (public_submission_email_key)
  where public_submission_email_key is not null;

create or replace function public.consume_public_booking_rate_limits(
  p_ip_key_hash text,
  p_email_key_hash text
) returns table(allowed boolean, retry_after_seconds integer)
language plpgsql security definer set search_path = '' as $$
declare
  v_bucket timestamptz := date_trunc('hour', clock_timestamp());
  v_ip_attempts integer;
  v_email_attempts integer;
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role'
     and coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role', '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_ip_key_hash !~ '^[0-9a-f]{64}$' or p_email_key_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid rate-limit key';
  end if;

  insert into public.public_booking_rate_limits(key_hash, key_kind, bucket_start, attempts)
  values (p_ip_key_hash, 'ip', v_bucket, 1)
  on conflict (key_hash, key_kind, bucket_start)
  do update set attempts = public.public_booking_rate_limits.attempts + 1
  returning attempts into v_ip_attempts;

  insert into public.public_booking_rate_limits(key_hash, key_kind, bucket_start, attempts)
  values (p_email_key_hash, 'email', v_bucket, 1)
  on conflict (key_hash, key_kind, bucket_start)
  do update set attempts = public.public_booking_rate_limits.attempts + 1
  returning attempts into v_email_attempts;

  -- Bound opportunistic cleanup; shared IPs get a generous ceiling while each
  -- normalized email is limited to five attempts per hour.
  delete from public.public_booking_rate_limits where ctid in (
    select ctid from public.public_booking_rate_limits
    where bucket_start < v_bucket - interval '48 hours'
    limit 1000
  );

  return query select (v_ip_attempts <= 60 and v_email_attempts <= 5),
    greatest(1, extract(epoch from (v_bucket + interval '1 hour' - clock_timestamp()))::integer);
end;
$$;

create or replace function public.create_public_booking(
  p_submission_key uuid,
  p_public_reference text,
  p_project_slug text,
  p_tour_date text,
  p_guest_count integer,
  p_status public.booking_status,
  p_total_trip_value_usd integer,
  p_online_due_usd integer,
  p_family_cash_due_usd integer,
  p_emergency_contact text,
  p_customer_notes text,
  p_booking_notes text,
  p_travellers jsonb
) returns table(booking_id uuid, customer_id uuid, public_reference text, created boolean)
language plpgsql security definer set search_path = '' as $$
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
       ) then
      raise exception 'traveller % is invalid or incomplete', v_position;
    end if;

    insert into public.booking_travellers(
      booking_id, position, is_lead, first_name, last_name, email, phone,
      nationality, date_of_birth, riding_experience, dietary_notes
    ) values (
      v_booking_id, v_position, v_position = 1, v_item->>'first_name', v_item->>'last_name',
      nullif(lower(v_item->>'email'), ''), nullif(v_item->>'phone', ''), v_item->>'nationality',
      (v_item->>'date_of_birth')::date, v_item->>'riding_experience', nullif(v_item->>'dietary_notes', '')
    );
  end loop;

  insert into public.booking_events(booking_id, event_type, direction, title, body, created_by)
  values (v_booking_id, 'system', 'system', 'Website booking submitted',
    format('%s traveller manifest saved atomically.', p_guest_count), 'website-form');

  return query select v_booking_id, v_customer_id, p_public_reference, true;
end;
$$;

create or replace function public.claim_public_booking_email(
  p_booking_id uuid,
  p_customer_id uuid,
  p_template_key text,
  p_to_email text,
  p_subject text,
  p_body_snapshot text
) returns table(email_event_id uuid, should_send boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_key text := p_booking_id::text || ':' || p_template_key;
  v_id uuid;
  v_inserted boolean := false;
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role'
     and coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role', '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  insert into public.email_events(booking_id, customer_id, template_key, to_email, subject,
    body_snapshot, sent_by, status, public_submission_email_key)
  values (p_booking_id, p_customer_id, p_template_key, p_to_email, p_subject,
    p_body_snapshot, 'website-form', 'queued', v_key)
  on conflict (public_submission_email_key) where public_submission_email_key is not null do nothing
  returning id into v_id;
  v_inserted := found;

  if not v_inserted then
    update public.email_events set status = 'queued', sent_at = now()
    where public_submission_email_key = v_key
      and (status = 'failed' or (status = 'queued' and sent_at < now() - interval '15 minutes'))
    returning id into v_id;
    v_inserted := found;
  end if;
  if v_id is null then
    select e.id into v_id from public.email_events e where e.public_submission_email_key = v_key;
  end if;
  return query select v_id, v_inserted;
end;
$$;

create or replace function public.finalize_public_booking_email(
  p_email_event_id uuid,
  p_sent boolean,
  p_provider_message_id text,
  p_error text,
  p_raw_response jsonb
) returns void language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role'
     and coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role', '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  update public.email_events set
    status = case when p_sent then 'sent'::public.email_event_status else 'failed'::public.email_event_status end,
    provider_message_id = nullif(p_provider_message_id, ''),
    raw_response = coalesce(p_raw_response, jsonb_build_object('error', left(coalesce(p_error, 'unknown'), 500))),
    sent_at = now()
  where id = p_email_event_id and status = 'queued';
end;
$$;

alter table public.booking_travellers enable row level security;
alter table public.public_booking_rate_limits enable row level security;
revoke all on table public.booking_travellers, public.public_booking_rate_limits from anon, authenticated;
grant select, insert, update, delete on table public.booking_travellers to service_role;
grant select, insert, update, delete on table public.public_booking_rate_limits to service_role;
revoke all on function public.set_booking_traveller_updated_at() from public;
revoke all on function public.consume_public_booking_rate_limits(text, text) from public;
revoke all on function public.create_public_booking(uuid, text, text, text, integer, public.booking_status, integer, integer, integer, text, text, text, jsonb) from public;
revoke all on function public.claim_public_booking_email(uuid, uuid, text, text, text, text) from public;
revoke all on function public.finalize_public_booking_email(uuid, boolean, text, text, jsonb) from public;
grant execute on function public.set_booking_traveller_updated_at() to service_role;
grant execute on function public.consume_public_booking_rate_limits(text, text) to service_role;
grant execute on function public.create_public_booking(uuid, text, text, text, integer, public.booking_status, integer, integer, integer, text, text, text, jsonb) to service_role;
grant execute on function public.claim_public_booking_email(uuid, uuid, text, text, text, text) to service_role;
grant execute on function public.finalize_public_booking_email(uuid, boolean, text, text, jsonb) to service_role;
