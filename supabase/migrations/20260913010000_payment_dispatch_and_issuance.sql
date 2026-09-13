-- Additive: money is never blocked by an email lease. Dispatch authorization,
-- not confirmation, is the local linearization point. Network acceptance is NOT
-- atomic with this transaction: a later refund is journalled as in-flight risk.
create table public.payment_confirmation_dispatch (
 booking_id uuid not null references public.bookings(id) on delete cascade,
 session_id text not null,
 destination text not null check(destination in ('customer','internal')),
 token text not null,
 authorized_at timestamptz not null default clock_timestamp(),
 status text not null default 'dispatching' check(status in ('dispatching','accepted','failed','suppressed')),
 provider_message_id text,
 refund_observed_at timestamptz,
 primary key(booking_id,session_id,destination)
);
alter table public.payment_confirmation_dispatch enable row level security;
revoke all on public.payment_confirmation_dispatch from public,anon,authenticated;
grant select,update on public.payment_confirmation_dispatch to service_role;

-- Persist per-payment issuance, since the mutable ownership generation can later
-- move on. Backfill only an exact Session match; never invent missing history.
update public.payments p set raw_event=coalesce(p.raw_event,'{}'::jsonb)||jsonb_build_object('checkout_issuance',jsonb_build_object('expected',a.expected,'spec',a.spec,'generation',a.generation))
from public.booking_checkout_ownership a where p.booking_id=a.booking_id and p.stripe_checkout_session_id=a.session_id
and not(coalesce(p.raw_event,'{}'::jsonb)?'checkout_issuance');
create function public.payment_issuance_and_refund_fence_v3() returns trigger language plpgsql security definer set search_path='' as $$
declare a public.booking_checkout_ownership; bid uuid;
begin
 bid:=case when tg_op='DELETE' then old.booking_id else new.booking_id end;
 perform 1 from public.bookings where id=bid for update;
 if tg_op='UPDATE' and old.raw_event?'checkout_issuance' then
  new.raw_event:=coalesce(new.raw_event,'{}'::jsonb)||jsonb_build_object('checkout_issuance',old.raw_event->'checkout_issuance');
 elsif tg_op<>'DELETE' then
  select * into a from public.booking_checkout_ownership where booking_id=bid and session_id=new.stripe_checkout_session_id;
  if found then new.raw_event:=coalesce(new.raw_event,'{}'::jsonb)||jsonb_build_object('checkout_issuance',jsonb_build_object('expected',a.expected,'spec',a.spec,'generation',a.generation)); end if;
 end if;
 -- Revoke on ledger loss, including direct writers. Keep the refund itself.
 -- Metadata-only processing/completion writes must not revoke the owner.
 if tg_op='DELETE' or (tg_op='UPDATE' and
  (new.status is distinct from old.status and new.status<>'paid'
   or new.amount_usd<old.amount_usd
   or coalesce(new.raw_event->'cumulative_refunded_usd','0'::jsonb) is distinct from coalesce(old.raw_event->'cumulative_refunded_usd','0'::jsonb)
   or new.raw_event->'latest_refund_event' is distinct from old.raw_event->'latest_refund_event')) then
  update public.bookings set payment_confirmation_token=null,payment_confirmation_claimed_at=null where id=bid;
  update public.payment_confirmation_dispatch set refund_observed_at=coalesce(refund_observed_at,clock_timestamp()) where booking_id=bid;
 end if;
 if tg_op='DELETE' then return old; end if;
 return new;
end $$;
create trigger payment_issuance_refund_v3 before insert or update or delete on public.payments for each row execute function public.payment_issuance_and_refund_fence_v3();

create function public.authorize_payment_dispatch_v3(p_booking_id uuid,p_session_id text,p_token text,p_destination text) returns boolean language plpgsql security definer set search_path='' as $$
declare b public.bookings;a public.booking_checkout_ownership;amount numeric;written integer;
begin
 perform public.checkout_service_role();
 select * into b from public.bookings where id=p_booking_id for update;
 if not found or p_token is null or b.payment_confirmation_token is distinct from p_token
 or b.payment_confirmation_claimed_at<=clock_timestamp()-interval '5 minutes' or b.status<>'confirmed' then return false; end if;
 amount:=public.reconcile_paid_booking_v2(b.id);
 select * into a from public.booking_checkout_ownership where booking_id=b.id;
 if a.booking_id is null or a.terms_invalidated or a.session_id is distinct from p_session_id
 or not(to_jsonb(b) @> (a.expected-array['status','online_paid_usd','updated_at','payment_confirmation_token','payment_confirmation_claimed_at','confirmed_at']))
 or b.online_due_usd<=0 or amount<b.online_due_usd
 or not exists(select 1 from public.payments where booking_id=b.id and stripe_checkout_session_id=p_session_id and status='paid'
 and coalesce((raw_event->>'cumulative_refunded_usd')::numeric,0)=0) then return false; end if;
 -- Ambiguous dispatch is review-only, not an unbounded provider-idempotency retry.
 insert into public.payment_confirmation_dispatch(booking_id,session_id,destination,token) values(b.id,p_session_id,p_destination,p_token) on conflict do nothing;
 get diagnostics written=row_count;
 return written=1;
end $$;
revoke all on function public.payment_issuance_and_refund_fence_v3(),public.authorize_payment_dispatch_v3(uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.authorize_payment_dispatch_v3(uuid,text,text,text) to service_role;
