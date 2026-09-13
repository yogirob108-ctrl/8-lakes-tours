-- Both public and Ops creators MUST use this protocol. Provider calls cannot run
-- inside a database transaction. A durable frozen generation bridges that gap;
-- booking/ledger writers fence it under the same booking row lock. Invalidated
-- or ambiguous generations are never replaced by a fresh provider key.
create table public.booking_checkout_ownership (
 booking_id uuid primary key references public.bookings(id) on delete cascade,
 generation uuid not null default gen_random_uuid(),
 spec jsonb not null,
 expected jsonb not null,
 session_id text,
 expired_sessions text[] not null default '{}',
 invalidated boolean not null default false,
 created_at timestamptz not null default clock_timestamp()
);
alter table public.booking_checkout_ownership enable row level security;
revoke all on public.booking_checkout_ownership from public,anon,authenticated;

create function public.checkout_service_role() returns void
language plpgsql security definer set search_path='' as $$
begin
 if coalesce(current_setting('request.jwt.claim.role',true),'')<>'service_role'
 and coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'role','')<>'service_role' then
  raise exception 'service role required' using errcode='42501';
 end if;
end $$;

create function public.fence_booking_checkout() returns trigger
language plpgsql security definer set search_path='' as $$
declare bid uuid;
begin
 if tg_table_name='bookings' then
  if row(new.status,new.tour_date,new.guest_count,new.online_due_usd,new.online_paid_usd,new.customer_id,new.total_trip_value_usd,new.family_cash_due_usd)
   is distinct from row(old.status,old.tour_date,old.guest_count,old.online_due_usd,old.online_paid_usd,old.customer_id,old.total_trip_value_usd,old.family_cash_due_usd) then
   update public.booking_checkout_ownership set invalidated=true where booking_id=new.id;
  end if;
  return new;
 end if;
 -- Every ledger writer, including webhooks and legacy/direct service-role writes,
 -- participates. Do not block recording real money; invalidate checkout instead.
 bid:=case when tg_op='DELETE' then old.booking_id else new.booking_id end;
 if tg_op='UPDATE' and old.booking_id is distinct from new.booking_id then
  raise exception 'payment booking identity is immutable';
 end if;
 perform 1 from public.bookings where id=bid for update;
 if tg_op='DELETE' then
  update public.booking_checkout_ownership set invalidated=true where booking_id=bid;
  return old;
 end if;
 update public.booking_checkout_ownership a set invalidated=true where a.booking_id=bid
  and not (a.session_id is not null and new.status='pending' and new.stripe_checkout_session_id is not null
   and new.stripe_checkout_session_id=a.session_id
   and new.amount_usd*100=(a.spec#>>'{line_items,0,price_data,unit_amount}')::numeric
   and (tg_op='INSERT' or old.status='pending'));
 return new;
end $$;
create trigger booking_checkout_fence before update on public.bookings for each row execute function public.fence_booking_checkout();
create trigger payment_checkout_fence before insert or update or delete on public.payments for each row execute function public.fence_booking_checkout();

create function public.prepare_booking_checkout(p_booking_id uuid,p_expected jsonb,p_spec jsonb,p_expired_sessions text[],p_reuse_session text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.bookings; a public.booking_checkout_ownership; amount numeric;
begin
 perform public.checkout_service_role();
 select b1.* into b from public.bookings b1 join public.tour_projects p on p.id=b1.project_id
 where b1.id=p_booking_id and p.slug='8-lakes-tours' and p.active for update of b1;
 if not found or p_expected is null or not (to_jsonb(b) @> p_expected)
  or b.status not in ('awaiting_payment','application_received') or b.online_paid_usd<>0 then
  raise exception 'booking changed or not payable; operator review required';
 end if;
 amount:=(p_spec#>>'{line_items,0,price_data,unit_amount}')::numeric;
 if amount is null or amount<=0 or amount<>b.online_due_usd*100
  or p_spec->>'client_reference_id' is distinct from b.public_reference
  or p_spec#>>'{metadata,booking_id}' is distinct from b.id::text
  or p_spec#>>'{metadata,customer_id}' is distinct from b.customer_id::text
  or p_spec#>>'{metadata,guest_count}' is distinct from b.guest_count::text
  or p_spec#>>'{line_items,0,price_data,currency}' is distinct from 'usd'
  or p_spec#>>'{line_items,0,quantity}' is distinct from '1'
  or jsonb_array_length(p_spec->'line_items')<>1 or p_expired_sessions is null then
  raise exception 'invalid checkout specification';
 end if;
 if exists(select 1 from public.payments where booking_id=b.id and
   (status<>'pending' or stripe_checkout_session_id is null or
    not (stripe_checkout_session_id=any(p_expired_sessions) or stripe_checkout_session_id=coalesce(p_reuse_session,'')))) then
  raise exception 'payment activity changed; operator review required';
 end if;
 select * into a from public.booking_checkout_ownership where booking_id=b.id;
 if found then
  -- Advance only after actual Stripe retrieval proved the owned Session expired.
  if a.session_id is not null and a.session_id=any(p_expired_sessions) then
   delete from public.booking_checkout_ownership where booking_id=b.id;
  else
   if a.invalidated or not (to_jsonb(b) @> a.expected)
    or (a.session_id is null and a.created_at<clock_timestamp()-interval '23 hours')
    or (p_reuse_session is not null and p_reuse_session is distinct from a.session_id) then
    raise exception 'ambiguous or changed checkout generation; operator review required';
   end if;
   -- A second creator uses the FIRST creator's exact provider payload, not its
   -- own public/Ops variant with the same Stripe idempotency key.
   return jsonb_build_object('key','booking-checkout-v3:'||a.generation,'spec',a.spec,'session_id',a.session_id);
  end if;
 end if;
 insert into public.booking_checkout_ownership(booking_id,spec,expected,session_id,expired_sessions)
 values(b.id,p_spec,p_expected,p_reuse_session,p_expired_sessions) returning * into a;
 return jsonb_build_object('key','booking-checkout-v3:'||a.generation,'spec',a.spec,'session_id',a.session_id);
end $$;

create function public.finalize_booking_checkout(p_booking_id uuid,p_key text,p_session_id text,p_url text,p_expires_at bigint)
returns boolean language plpgsql security definer set search_path='' as $$
declare b public.bookings; a public.booking_checkout_ownership;
begin
 perform public.checkout_service_role();
 select * into b from public.bookings where id=p_booking_id for update;
 select * into a from public.booking_checkout_ownership where booking_id=p_booking_id;
 if a.booking_id is null or p_key is distinct from 'booking-checkout-v3:'||a.generation
  or a.invalidated or not (to_jsonb(b) @> a.expected)
  or b.status not in ('awaiting_payment','application_received') or b.online_paid_usd<>0
  or (a.session_id is not null and a.session_id<>p_session_id)
  or exists(select 1 from public.payments where booking_id=b.id and
   (status<>'pending' or stripe_checkout_session_id is null or
    not (stripe_checkout_session_id=any(a.expired_sessions) or stripe_checkout_session_id=p_session_id))) then
  return false;
 end if;
 if p_session_id is null or p_url is null then raise exception 'session required'; end if;
 -- Set identity first so our own pending insert is recognized by the universal
 -- ledger fence. Insert + generation binding commit atomically or both roll back.
 update public.booking_checkout_ownership set session_id=p_session_id where booking_id=b.id;
 insert into public.payments(booking_id,provider,stripe_checkout_session_id,amount_usd,status,raw_event)
 values(b.id,'stripe',p_session_id,(a.spec#>>'{line_items,0,price_data,unit_amount}')::numeric/100,'pending',
  jsonb_build_object('checkout_url',p_url,'checkout_expires_at',to_timestamp(p_expires_at),'source','shared_exact_checkout'))
 on conflict (stripe_checkout_session_id) where stripe_checkout_session_id is not null do nothing;
 if not exists(select 1 from public.payments where booking_id=b.id and stripe_checkout_session_id=p_session_id
  and status='pending' and amount_usd*100=(a.spec#>>'{line_items,0,price_data,unit_amount}')::numeric) then
  raise exception 'payment record identity mismatch';
 end if;
 return true;
end $$;
revoke all on function public.checkout_service_role(),public.fence_booking_checkout(),public.prepare_booking_checkout(uuid,jsonb,jsonb,text[],text),public.finalize_booking_checkout(uuid,text,text,text,bigint) from public,anon,authenticated;
grant execute on function public.prepare_booking_checkout(uuid,jsonb,jsonb,text[],text),public.finalize_booking_checkout(uuid,text,text,text,bigint) to service_role;
-- Superseded entry point cannot mint an independent public-only generation.
revoke all on function public.prepare_public_checkout(uuid,text,jsonb,jsonb) from service_role;
