-- Persist the provider idempotency generation BEFORE contacting Stripe.
-- Stripe may forget keys after 24h. An ambiguous attempt is never retried after
-- 23h: an operator must retrieve/reconcile it rather than create a second charge.
create table public.public_checkout_attempts (
  booking_id uuid not null references public.bookings(id) on delete cascade,
  predecessor text not null,
  idempotency_key uuid not null default gen_random_uuid(),
  spec jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key(booking_id,predecessor)
);
alter table public.public_checkout_attempts enable row level security;
revoke all on public.public_checkout_attempts from anon,authenticated;

create or replace function public.prepare_public_checkout(p_booking_id uuid,p_predecessor text,p_expected jsonb,p_spec jsonb)
returns text language plpgsql security definer set search_path='' as $$
declare b public.bookings; a public.public_checkout_attempts;
begin
  if coalesce(current_setting('request.jwt.claim.role',true),'')<>'service_role'
    and coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role','')<>'service_role' then
    raise exception 'service role required' using errcode='42501';
  end if;
  select b1.* into b from public.bookings b1 join public.tour_projects p on p.id=b1.project_id
  where b1.id=p_booking_id and p.slug='8-lakes-tours' and p.active for update of b1;
  if not found or p_expected is null or not (to_jsonb(b) @> p_expected)
    or b.status<>'awaiting_payment' or b.online_paid_usd<>0 then
    raise exception 'booking changed; operator review required';
  end if;
  if p_predecessor is null or length(p_predecessor)>255 or p_spec is null then raise exception 'invalid checkout attempt'; end if;
  if exists(select 1 from public.payments where booking_id=b.id and status<>'pending') then
    raise exception 'payment activity; operator review required';
  end if;
  insert into public.public_checkout_attempts(booking_id,predecessor,spec) values(b.id,p_predecessor,p_spec)
  on conflict(booking_id,predecessor) do nothing;
  select * into a from public.public_checkout_attempts where booking_id=b.id and predecessor=p_predecessor;
  if a.spec is distinct from p_spec or a.created_at<clock_timestamp()-interval '23 hours' then
    raise exception 'ambiguous or changed checkout attempt; operator review required';
  end if;
  return 'public-checkout-v2:' || a.idempotency_key::text;
end $$;
revoke all on function public.prepare_public_checkout(uuid,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.prepare_public_checkout(uuid,text,jsonb,jsonb) to service_role;
