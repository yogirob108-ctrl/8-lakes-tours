-- Additive safety upgrade. Apply after 20260910050000; old recovery callers
-- fail closed. Existing generations require review: their invalidation history
-- cannot distinguish commercial edits from payment reconciliation.
alter table public.booking_checkout_ownership add column terms_invalidated boolean not null default true;
alter table public.booking_checkout_ownership alter column terms_invalidated set default false;

create function public.fence_checkout_terms_v2() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if row(new.tour_date,new.guest_count,new.online_due_usd,new.customer_id,new.total_trip_value_usd,new.family_cash_due_usd,new.public_reference,new.project_id)
 is distinct from row(old.tour_date,old.guest_count,old.online_due_usd,old.customer_id,old.total_trip_value_usd,old.family_cash_due_usd,old.public_reference,old.project_id)
 or (new.status is distinct from old.status and new.status<>'confirmed') then
  if old.payment_confirmation_token is not null and old.payment_confirmation_claimed_at>clock_timestamp()-interval '5 minutes' then
   raise exception 'Payment confirmation in progress; retry booking edit' using errcode='55P03';
  end if;
  update public.booking_checkout_ownership set terms_invalidated=true where booking_id=new.id;
 end if;
 return new;
end $$;
create trigger checkout_terms_fence_v2 before update on public.bookings for each row execute function public.fence_checkout_terms_v2();

create or replace function public.abandoned_checkout_eligible(p_booking_id uuid,p_allowed_dates text[]) returns boolean language sql security definer set search_path='' as $$
 select exists(select 1 from public.bookings b
 join public.tour_projects p on p.id=b.project_id
 join public.abandoned_checkout_recovery q on q.booking_id=b.id
 join public.booking_checkout_ownership a on a.booking_id=b.id
 where b.id=p_booking_id and p.slug='8-lakes-tours' and p.active
 and b.submission_key is not null and b.status='awaiting_payment'
 and b.online_paid_usd=0 and b.online_due_usd>0 and b.guest_count between 1 and 8
 and b.tour_date=q.tour_date and b.tour_date=any(p_allowed_dates)
 and q.eligible_at<=clock_timestamp() and q.expires_at>clock_timestamp()
 and not a.invalidated and not a.terms_invalidated and a.session_id is not null and to_jsonb(b) @> a.expected
 and exists(select 1 from public.payments pay where pay.booking_id=b.id and pay.stripe_checkout_session_id=a.session_id and pay.status='pending')
 and not exists(select 1 from public.payments pay where pay.booking_id=b.id and
  (pay.status<>'pending' or pay.stripe_checkout_session_id is null or not (pay.stripe_checkout_session_id=a.session_id or pay.stripe_checkout_session_id=any(a.expired_sessions)))));
$$;
-- Deliberately disable v1: it has no provider evidence contract.
create or replace function public.authorize_abandoned_checkout(p_booking_id uuid,p_claim_token uuid,p_allowed_dates text[]) returns boolean language plpgsql security definer set search_path='' as $$
begin perform public.checkout_service_role(); return false; end $$;

create function public.read_abandoned_checkout_evidence(p_booking_id uuid,p_allowed_dates text[]) returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.booking_checkout_ownership;b public.bookings;
begin
 perform public.checkout_service_role();
 select * into b from public.bookings where id=p_booking_id for update;
 if not public.abandoned_checkout_eligible(p_booking_id,p_allowed_dates) then return null; end if;
 select * into a from public.booking_checkout_ownership where booking_id=b.id;
 return jsonb_build_object('generation',a.generation,'session_id',a.session_id,'customer_id',b.customer_id,'guest_count',b.guest_count,'amount_cents',b.online_due_usd*100,
 'session_ids',(select jsonb_agg(distinct pay.stripe_checkout_session_id) from public.payments pay where pay.booking_id=b.id));
end $$;
create function public.authorize_abandoned_checkout_v2(p_booking_id uuid,p_claim_token uuid,p_allowed_dates text[],p_generation uuid,p_expired_sessions text[]) returns boolean language plpgsql security definer set search_path='' as $$
declare a public.booking_checkout_ownership;
begin
 perform public.checkout_service_role();
 perform 1 from public.bookings where id=p_booking_id for update;
 if not public.abandoned_checkout_eligible(p_booking_id,p_allowed_dates) then return false; end if;
 select * into a from public.booking_checkout_ownership where booking_id=p_booking_id;
 return coalesce(a.generation=p_generation and a.session_id=any(p_expired_sessions)
 and not exists(select 1 from public.payments where booking_id=p_booking_id and not (stripe_checkout_session_id=any(p_expired_sessions)))
 and exists(select 1 from public.public_booking_notifications where booking_id=p_booking_id and template_key='abandoned_checkout'
 and status='queued' and claim_token=p_claim_token and lease_until>clock_timestamp()),false);
end $$;

-- All ledger writers already lock the booking via payment_checkout_fence.
-- Aggregate under that SAME lock; never replace the balance with one Session.
create function public.reconcile_paid_booking_v2(p_booking_id uuid) returns numeric language plpgsql security definer set search_path='' as $$
declare amount numeric;
begin
 perform public.checkout_service_role();
 perform 1 from public.bookings where id=p_booking_id for update;
 select coalesce(sum(case when status='refunded' then 0 else greatest(0,amount_usd-greatest(
 coalesce((raw_event->>'cumulative_refunded_usd')::numeric,0),
 coalesce((raw_event#>>'{latest_refund_event,cumulative_refunded_usd}')::numeric,(raw_event#>>'{latest_refund_event,refunded_usd}')::numeric,0))) end),0)
 into amount from public.payments where booking_id=p_booking_id and status in ('paid','partially_refunded','refunded');
 update public.bookings set online_paid_usd=amount,updated_at=clock_timestamp() where id=p_booking_id;
 return amount;
end $$;

create function public.confirm_paid_booking_v2(p_booking_id uuid,p_session_id text,p_expected jsonb,p_token text,p_confirmed_at timestamptz) returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.bookings;a public.booking_checkout_ownership;amount numeric;
begin
 perform public.checkout_service_role();
 select b1.* into b from public.bookings b1 join public.tour_projects p on p.id=b1.project_id where b1.id=p_booking_id and p.slug='8-lakes-tours' and p.active for update of b1;
 if not found then return jsonb_build_object('allowed',false); end if;
 amount:=public.reconcile_paid_booking_v2(b.id);
 select * into a from public.booking_checkout_ownership where booking_id=b.id;
 -- invalidated also records legitimate money updates; terms_invalidated is the
 -- persistent commercial fence and is never cleared by a webhook/replay.
 if p_expected is null or not (p_expected ?& array['customer_id','tour_date','guest_count','online_due_usd'])
 or not (to_jsonb(b) @> p_expected) or a.booking_id is null or a.terms_invalidated
 or a.session_id is distinct from p_session_id
 or not (to_jsonb(b) @> (a.expected - array['status','online_paid_usd','updated_at','payment_confirmation_token','payment_confirmation_claimed_at','confirmed_at']))
 or b.status not in ('application_received','awaiting_payment','confirmed')
 or b.online_due_usd<=0 or amount<b.online_due_usd
 or not exists(select 1 from public.payments where booking_id=b.id and stripe_checkout_session_id=p_session_id and status='paid'
 and amount_usd*100=(a.spec#>>'{line_items,0,price_data,unit_amount}')::numeric) then
  return jsonb_build_object('allowed',false,'status',b.status,'online_paid_usd',amount);
 end if;
 if p_token is null or p_token='' then raise exception 'confirmation token required'; end if;
 if b.payment_confirmation_token is not null and b.payment_confirmation_claimed_at>clock_timestamp()-interval '5 minutes' then
  raise exception 'confirmation lease active; retry' using errcode='55P03';
 end if;
 update public.bookings set status='confirmed',confirmed_at=coalesce(confirmed_at,p_confirmed_at),updated_at=clock_timestamp(),
 payment_confirmation_token=p_token,payment_confirmation_claimed_at=clock_timestamp() where id=b.id;
 return jsonb_build_object('allowed',true,'status','confirmed','online_paid_usd',amount);
end $$;
revoke all on function public.fence_checkout_terms_v2(),public.read_abandoned_checkout_evidence(uuid,text[]),public.authorize_abandoned_checkout_v2(uuid,uuid,text[],uuid,text[]),public.reconcile_paid_booking_v2(uuid),public.confirm_paid_booking_v2(uuid,text,jsonb,text,timestamptz) from public,anon,authenticated;
grant execute on function public.read_abandoned_checkout_evidence(uuid,text[]),public.authorize_abandoned_checkout_v2(uuid,uuid,text[],uuid,text[]),public.reconcile_paid_booking_v2(uuid),public.confirm_paid_booking_v2(uuid,text,jsonb,text,timestamptz) to service_role;
