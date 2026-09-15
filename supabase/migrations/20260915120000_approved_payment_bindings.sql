-- Durable operator-approved payment bindings. One approved binding ties a
-- specific external provider payment object (for example a manually issued
-- Stripe invoice) to exactly one booking so the daily public reconciliation
-- evaluates that transaction instead of reporting unbound/ambiguous evidence.
-- Evidence gates (amount/currency/customer/refund state) are never relaxed:
-- the binding only selects which transaction is evaluated.

create table if not exists public.approved_payment_bindings (
  id uuid primary key default gen_random_uuid(),
  booking_id uuid not null references public.bookings(id) on delete cascade,
  provider text not null default 'stripe',
  provider_object_id text not null,
  approved_by text not null,
  approval_context jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp(),
  unique (provider, provider_object_id)
);
alter table public.approved_payment_bindings enable row level security;
revoke all on public.approved_payment_bindings from public, anon, authenticated;

-- Atomic, idempotent bind. Verified provider facts (canonical PaymentIntent,
-- settled amount, provider paid timestamp) are supplied by the authenticated
-- action AFTER it verified the live provider object; the ledger row is written
-- only from those verified facts. A replay returns the existing binding and
-- never duplicates payment rows, timeline events or confirmation timestamps.
create or replace function public.bind_approved_payment(
  p_booking_id uuid, p_provider_object_id text, p_approved_by text,
  p_payment_intent_id text, p_amount_usd integer, p_paid_at timestamptz,
  p_payment_evidence jsonb default '{}'::jsonb, p_approval_context jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  b public.bookings;
  v_existing public.approved_payment_bindings;
  v_payment_id uuid;
  v_event_id uuid;
begin
  perform public.checkout_service_role();
  if nullif(btrim(p_provider_object_id),'') is null or nullif(btrim(p_approved_by),'') is null
    or nullif(btrim(p_payment_intent_id),'') is null
    or p_amount_usd is null or p_amount_usd<=0 or p_paid_at is null then
    raise exception 'binding requires verified provider payment facts';
  end if;
  -- Exactly one canonical booking, project-scoped.
  select bb.* into b from public.bookings bb
  join public.tour_projects p on p.id=bb.project_id
  where bb.id=p_booking_id and p.slug='8-lakes-tours' and p.active for update of bb;
  if not found then
    return jsonb_build_object('bound',false,'reason','booking_not_found');
  end if;
  -- One approved binding per provider object: an exact replay returns the same row.
  select * into v_existing from public.approved_payment_bindings
  where provider='stripe' and provider_object_id=btrim(p_provider_object_id);
  if found and v_existing.booking_id=b.id then
    return jsonb_build_object('bound',true,'binding_id',v_existing.id,'already_bound',true);
  end if;
  if found then
    return jsonb_build_object('bound',false,'reason','bound_to_other_booking');
  end if;
  insert into public.approved_payment_bindings(booking_id,provider,provider_object_id,approved_by,approval_context)
  values (b.id,'stripe',btrim(p_provider_object_id),p_approved_by,p_approval_context)
  returning id into v_existing;
  -- Canonical ledger row keyed by the PaymentIntent (unique partial index makes
  -- concurrent replays impossible); the exact invoice id stays in raw_event.
  insert into public.payments(booking_id,provider,stripe_payment_intent_id,amount_usd,status,paid_at,raw_event)
  values (b.id,'stripe',btrim(p_payment_intent_id),p_amount_usd,'paid',p_paid_at,
    jsonb_build_object('source','approved_binding','binding_provider_object',btrim(p_provider_object_id),
      'operator_approved_by',p_approved_by,'verified_evidence',p_payment_evidence,
      'approval_context',p_approval_context))
  on conflict do nothing
  returning id into v_payment_id;
  if v_payment_id is null then
    select id into v_payment_id from public.payments
    where booking_id=b.id and stripe_payment_intent_id=btrim(p_payment_intent_id);
  end if;
  -- Confirmation timestamp is set once from the provider payment date, never
  -- overwritten by replays; reconcile_paid_booking_v2 stays authoritative for
  -- the paid balance from the ledger snapshot.
  update public.bookings set confirmed_at=coalesce(confirmed_at,p_paid_at),updated_at=clock_timestamp()
  where id=b.id;
  select id into v_event_id from public.booking_events
  where booking_id=b.id and event_type='payment' and title='Operator-approved payment binding'
    and metadata->>'provider_object_id'=btrim(p_provider_object_id);
  if v_event_id is null then
    insert into public.booking_events(booking_id,event_type,direction,title,body,metadata,created_by,occurred_at)
    values (b.id,'payment','system','Operator-approved payment binding',
      'Operator approved binding of provider payment '||btrim(p_provider_object_id)
        ||' (PaymentIntent '||btrim(p_payment_intent_id)||', $'||p_amount_usd::text
        ||') to booking '||b.public_reference,
      jsonb_build_object('provider_object_id',btrim(p_provider_object_id),
        'payment_intent_id',btrim(p_payment_intent_id),'approved_by',p_approved_by,
        'amount_usd',p_amount_usd,'approval_context',p_approval_context),
      p_approved_by,p_paid_at)
    returning id into v_event_id;
  end if;
  return jsonb_build_object('bound',true,'binding_id',v_existing.id,'payment_id',v_payment_id,'event_id',v_event_id);
end $$;
revoke all on function public.bind_approved_payment(uuid,text,text,text,integer,timestamptz,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.bind_approved_payment(uuid,text,text,text,integer,timestamptz,jsonb,jsonb) to service_role;
