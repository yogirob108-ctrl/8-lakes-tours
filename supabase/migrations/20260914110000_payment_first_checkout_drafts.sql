-- Payment-first progressive drafts. Drafts are intentionally not bookings and expire after 30 days.
create table if not exists public.public_checkout_drafts (
  id uuid primary key,
  credential_hash text not null check (credential_hash ~ '^[0-9a-f]{64}$'),
  payload jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null default clock_timestamp() + interval '30 days',
  check (jsonb_typeof(payload) = 'object'),
  check (length(coalesce(payload->>'email','')) <= 254),
  check (length(coalesce(payload->>'first_name','')) <= 100),
  check (length(coalesce(payload->>'notes','')) <= 1000)
);
alter table public.public_checkout_drafts enable row level security;
revoke all on public.public_checkout_drafts from public, anon, authenticated;
grant select, insert, update, delete on public.public_checkout_drafts to service_role;

create or replace function public.save_public_checkout_draft(p_draft_id uuid, p_credential_hash text, p_payload jsonb)
returns void language plpgsql security definer set search_path='' as $$
begin
  perform public.checkout_service_role();
  if p_draft_id is null or p_credential_hash !~ '^[0-9a-f]{64}$' or jsonb_typeof(p_payload) <> 'object'
    or coalesce(p_payload->>'email','') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or length(coalesce(p_payload->>'first_name','')) not between 1 and 100 then
    raise exception 'invalid checkout draft';
  end if;
  insert into public.public_checkout_drafts(id, credential_hash, payload)
  values (p_draft_id, p_credential_hash, p_payload)
  on conflict (id) do update set payload=excluded.payload, updated_at=clock_timestamp(), expires_at=clock_timestamp()+interval '30 days'
  where public.public_checkout_drafts.credential_hash=excluded.credential_hash and public.public_checkout_drafts.expires_at>clock_timestamp();
  if not found then raise exception 'draft ownership invalid or expired' using errcode='42501'; end if;
  delete from public.public_checkout_drafts where ctid in (
    select ctid from public.public_checkout_drafts where expires_at < clock_timestamp() limit 1000
  );
end $$;
revoke all on function public.save_public_checkout_draft(uuid,text,jsonb) from public, anon, authenticated;
grant execute on function public.save_public_checkout_draft(uuid,text,jsonb) to service_role;
