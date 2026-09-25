-- Migration-first shared departure capacity. This is deliberately additive and
-- default-off: no historic booking is inferred from free-text tour_date.
create table public.departures (
 id uuid primary key default gen_random_uuid(),
 project_id uuid not null references public.tour_projects(id) on delete cascade,
 label text not null,
 start_date date not null,
 end_date date not null check(end_date>=start_date),
 published boolean not null default true,
 capacity integer not null default 8 check(capacity=8),
 capacity_enforced boolean not null default false,
 created_at timestamptz not null default clock_timestamp(),
 unique(project_id,label), unique(project_id,start_date,end_date)
);
alter table public.departures enable row level security;
revoke all on public.departures from public,anon,authenticated;

alter table public.bookings add column departure_id uuid references public.departures(id);
create index bookings_departure_id_idx on public.bookings(departure_id);

-- These are the only published scheduled labels. Private/custom and unknown
-- labels intentionally have no canonical identity and cannot auto-pay/recover.
insert into public.departures(project_id,label,start_date,end_date)
select p.id,v.label,v.start_date,v.end_date from public.tour_projects p cross join (values
 ('June 22 – 30, 2026',date '2026-06-22',date '2026-06-30'),('July 6 – 14, 2026',date '2026-07-06',date '2026-07-14'),('July 16 – 24, 2026',date '2026-07-16',date '2026-07-24'),('July 28 – August 5, 2026',date '2026-07-28',date '2026-08-05'),('August 4 – 12, 2026',date '2026-08-04',date '2026-08-12'),('August 24 – September 1, 2026',date '2026-08-24',date '2026-09-01'),('September 14 – 22, 2026',date '2026-09-14',date '2026-09-22'),('September 23 – October 1, 2026',date '2026-09-23',date '2026-10-01'),('October 7 – 15, 2026',date '2026-10-07',date '2026-10-15'),('October 21 – 29, 2026',date '2026-10-21',date '2026-10-29'),
 ('May 4 – 12, 2027',date '2027-05-04',date '2027-05-12'),('May 18 – 26, 2027',date '2027-05-18',date '2027-05-26'),('June 1 – 9, 2027',date '2027-06-01',date '2027-06-09'),('June 15 – 23, 2027',date '2027-06-15',date '2027-06-23'),('June 29 – July 7, 2027',date '2027-06-29',date '2027-07-07'),('July 13 – 21, 2027',date '2027-07-13',date '2027-07-21'),('July 27 – August 4, 2027',date '2027-07-27',date '2027-08-04'),('August 10 – 18, 2027',date '2027-08-10',date '2027-08-18'),('August 24 – September 1, 2027',date '2027-08-24',date '2027-09-01'),('September 7 – 15, 2027',date '2027-09-07',date '2027-09-15'),('September 21 – 29, 2027',date '2027-09-21',date '2027-09-29'),('October 5 – 13, 2027',date '2027-10-05',date '2027-10-13'),('October 19 – 27, 2027',date '2027-10-19',date '2027-10-27')
) as v(label,start_date,end_date) where p.slug='8-lakes-tours'
on conflict(project_id,label) do nothing;

create table public.departure_capacity_allocations (
 booking_id uuid primary key references public.bookings(id) on delete restrict,
 departure_id uuid not null references public.departures(id) on delete restrict,
 guest_count integer not null check(guest_count between 1 and 8),
 checkout_session_id text not null unique,
 state text not null check(state in ('payment','confirmed')),
 allocated_at timestamptz not null default clock_timestamp()
);
alter table public.departure_capacity_allocations enable row level security;
revoke all on public.departure_capacity_allocations from public,anon,authenticated;

-- New public bookings get an identity only from the published catalogue. There
-- is intentionally NO update/backfill mapping for historical free-text rows.
create function public.assign_new_booking_departure() returns trigger language plpgsql security definer set search_path='' as $$
begin
 select d.id into new.departure_id from public.departures d
 where d.project_id=new.project_id and d.label=new.tour_date and d.published;
 return new;
end $$;
create trigger a_assign_new_booking_departure before insert on public.bookings for each row execute function public.assign_new_booking_departure();

create function public.reserve_departure_capacity(p_booking_id uuid,p_session_id text default null) returns boolean language plpgsql security definer set search_path='' as $$
declare b public.bookings; d public.departures; used integer;
begin
 perform public.checkout_service_role();
 select * into b from public.bookings where id=p_booking_id for update;
 if not found or b.departure_id is null then return false; end if;
 select * into d from public.departures where id=b.departure_id and published and capacity_enforced for update;
 if not found then return false; end if;
 select coalesce(sum(guest_count),0) into used from public.departure_capacity_allocations where departure_id=d.id and booking_id<>b.id;
 if used+b.guest_count>d.capacity then return false; end if;
 insert into public.departure_capacity_allocations(booking_id,departure_id,guest_count,checkout_session_id,state)
 values(b.id,d.id,b.guest_count,coalesce(p_session_id,'manual:'||b.id::text),'payment')
 on conflict(booking_id) do nothing;
 return exists(select 1 from public.departure_capacity_allocations a where a.booking_id=b.id and a.departure_id=d.id and a.guest_count=b.guest_count);
end $$;

-- Every Ops edit is checked under the same departure row lock. A cancellation,
-- refund or transient provider state never deletes a payment allocation.
create function public.fence_departure_capacity_ops() returns trigger language plpgsql security definer set search_path='' as $$
declare a public.departure_capacity_allocations; d public.departures; used integer;
begin
 if tg_op='UPDATE' then
  select * into a from public.departure_capacity_allocations where booking_id=new.id for update;
  if found and (new.guest_count is distinct from old.guest_count or new.tour_date is distinct from old.tour_date or new.departure_id is distinct from old.departure_id) then
   if new.departure_id is distinct from a.departure_id then raise exception 'departure identity is immutable after checkout; operator review required'; end if;
   select * into d from public.departures where id=a.departure_id for update;
   select coalesce(sum(guest_count),0) into used from public.departure_capacity_allocations where departure_id=a.departure_id and booking_id<>new.id;
   if not d.capacity_enforced or used+new.guest_count>d.capacity then raise exception 'departure capacity exceeded; operator review required'; end if;
   update public.departure_capacity_allocations set guest_count=new.guest_count where booking_id=new.id;
  end if;
 end if;
 return new;
end $$;
create trigger z_fence_departure_capacity_ops before update on public.bookings for each row execute function public.fence_departure_capacity_ops();

-- Only a caller that has provider-terminal evidence may explicitly release an
-- expired session; cancellation/refund/processing never release automatically.
create function public.release_departure_capacity_if_safe(p_booking_id uuid,p_provider_terminal text) returns boolean language plpgsql security definer set search_path='' as $$
begin
 perform public.checkout_service_role();
 if p_provider_terminal<>'expired' then return false; end if;
 delete from public.departure_capacity_allocations where booking_id=p_booking_id and state='payment';
 return found;
end $$;

-- Checkout preparation checks canonical published capacity. Finalization below
-- takes the allocation; a concurrent full race leaves the second Session
-- unfinalized and the caller expires it, preserving all real ledger funds.
create or replace function public.prepare_booking_checkout(p_booking_id uuid,p_expected jsonb,p_spec jsonb,p_expired_sessions text[],p_reuse_session text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.bookings; a public.booking_checkout_ownership; amount numeric; d public.departures; used integer;
begin
 perform public.checkout_service_role();
 select b1.* into b from public.bookings b1 join public.tour_projects p on p.id=b1.project_id where b1.id=p_booking_id and p.slug='8-lakes-tours' and p.active for update of b1;
 if not found or p_expected is null or not(to_jsonb(b)@>p_expected) or b.status not in ('awaiting_payment','application_received') or b.online_paid_usd<>0 then raise exception 'booking changed or not payable; operator review required'; end if;
 if public.departure_capacity_is_active(b.project_id,b.departure_id) then
  select * into d from public.departures where id=b.departure_id for update;
  select public.departure_capacity_used(d.id,b.id) into used;
  if used+b.guest_count>d.capacity then raise exception 'departure is full; operator review required'; end if;
 end if;
 amount:=(p_spec#>>'{line_items,0,price_data,unit_amount}')::numeric;
 if amount is null or amount<=0 or amount<>b.online_due_usd*100 or p_spec->>'client_reference_id' is distinct from b.public_reference or p_spec#>>'{metadata,booking_id}' is distinct from b.id::text or p_spec#>>'{metadata,customer_id}' is distinct from b.customer_id::text or p_spec#>>'{metadata,guest_count}' is distinct from b.guest_count::text or p_spec#>>'{line_items,0,price_data,currency}' is distinct from 'usd' or p_spec#>>'{line_items,0,quantity}' is distinct from '1' or jsonb_array_length(p_spec->'line_items')<>1 or p_expired_sessions is null then raise exception 'invalid checkout specification'; end if;
 if exists(select 1 from public.payments where booking_id=b.id and (status<>'pending' or stripe_checkout_session_id is null or not(stripe_checkout_session_id=any(p_expired_sessions) or stripe_checkout_session_id=coalesce(p_reuse_session,'')))) then raise exception 'payment activity changed; operator review required'; end if;
 select * into a from public.booking_checkout_ownership where booking_id=b.id;
 if found then
  if a.session_id is not null and a.session_id=any(p_expired_sessions) then delete from public.booking_checkout_ownership where booking_id=b.id;
  else
   if a.invalidated or not(to_jsonb(b)@>a.expected) or (a.session_id is null and a.created_at<clock_timestamp()-interval '23 hours') or (p_reuse_session is not null and p_reuse_session is distinct from a.session_id) then raise exception 'ambiguous or changed checkout generation; operator review required'; end if;
   return jsonb_build_object('key','booking-checkout-v3:'||a.generation,'spec',a.spec,'session_id',a.session_id);
  end if;
 end if;
 insert into public.booking_checkout_ownership(booking_id,spec,expected,session_id,expired_sessions) values(b.id,p_spec,p_expected,p_reuse_session,p_expired_sessions) returning * into a;
 return jsonb_build_object('key','booking-checkout-v3:'||a.generation,'spec',a.spec,'session_id',a.session_id);
end $$;

create or replace function public.finalize_booking_checkout(p_booking_id uuid,p_key text,p_session_id text,p_url text,p_expires_at bigint) returns boolean language plpgsql security definer set search_path='' as $$
declare b public.bookings; a public.booking_checkout_ownership;
begin
 perform public.checkout_service_role(); select * into b from public.bookings where id=p_booking_id for update; select * into a from public.booking_checkout_ownership where booking_id=p_booking_id;
 if a.booking_id is null or p_key is distinct from 'booking-checkout-v3:'||a.generation or a.invalidated or not(to_jsonb(b)@>a.expected) or b.status not in ('awaiting_payment','application_received') or b.online_paid_usd<>0 or (a.session_id is not null and a.session_id<>p_session_id) then return false; end if;
 if p_session_id is null or p_url is null then raise exception 'session required'; end if;
 if public.departure_capacity_is_active(b.project_id,b.departure_id) and not public.reserve_departure_capacity(b.id,p_session_id) then return false; end if;
 update public.booking_checkout_ownership set session_id=p_session_id where booking_id=b.id;
 insert into public.payments(booking_id,provider,stripe_checkout_session_id,amount_usd,status,raw_event) values(b.id,'stripe',p_session_id,(a.spec#>>'{line_items,0,price_data,unit_amount}')::numeric/100,'pending',jsonb_build_object('checkout_url',p_url,'checkout_expires_at',to_timestamp(p_expires_at),'source','shared_exact_checkout')) on conflict(stripe_checkout_session_id) where stripe_checkout_session_id is not null do nothing;
 if not exists(select 1 from public.payments where booking_id=b.id and stripe_checkout_session_id=p_session_id and status='pending') then raise exception 'payment record identity mismatch'; end if;
 return true;
end $$;

-- Reminders are suppressed for unknown/unactivated/full departures even after
-- they were listed. The final authorize path consumes this same predicate.
create or replace function public.abandoned_checkout_eligible(p_booking_id uuid,p_allowed_dates text[]) returns boolean language sql security definer set search_path='' as $$
 select exists(select 1 from public.bookings b join public.tour_projects p on p.id=b.project_id join public.abandoned_checkout_recovery q on q.booking_id=b.id join public.booking_checkout_ownership o on o.booking_id=b.id join public.departures d on d.id=b.departure_id and d.published and d.capacity_enforced where b.id=p_booking_id and p.slug='8-lakes-tours' and p.active and b.submission_key is not null and b.status='awaiting_payment' and b.online_paid_usd=0 and b.online_due_usd>0 and b.guest_count between 1 and 8 and b.tour_date=q.tour_date and b.tour_date=any(p_allowed_dates) and q.eligible_at<=clock_timestamp() and not exists(select 1 from public.payments pay where pay.booking_id=b.id and pay.status::text not in ('pending','failed')) and (select coalesce(sum(a.guest_count),0) from public.departure_capacity_allocations a where a.departure_id=d.id)<d.capacity);
$$;

-- Webhook confirmation uses the same booking/departure lock and returns a
-- review-only refusal (rather than throwing after funds were recorded) when no
-- current provider-owned allocation exists.
create or replace function public.confirm_paid_booking_v2(p_booking_id uuid,p_session_id text,p_expected jsonb,p_token text,p_confirmed_at timestamptz) returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.bookings; o public.booking_checkout_ownership; amount numeric;
begin
 perform public.checkout_service_role();
 select b1.* into b from public.bookings b1 join public.tour_projects p on p.id=b1.project_id where b1.id=p_booking_id and p.slug='8-lakes-tours' and p.active for update of b1;
 if not found then return jsonb_build_object('allowed',false); end if;
 amount:=public.reconcile_paid_booking_v2(b.id); select * into o from public.booking_checkout_ownership where booking_id=b.id;
 if p_expected is null or not(p_expected ?& array['customer_id','tour_date','guest_count','online_due_usd']) or not(to_jsonb(b)@>p_expected) or o.booking_id is null or o.terms_invalidated or o.session_id is distinct from p_session_id or not(to_jsonb(b) @> (o.expected-array['status','online_paid_usd','updated_at','payment_confirmation_token','payment_confirmation_claimed_at','confirmed_at'])) or b.status not in ('application_received','awaiting_payment','confirmed') or b.online_due_usd<=0 or amount<b.online_due_usd or not exists(select 1 from public.payments where booking_id=b.id and stripe_checkout_session_id=p_session_id and status='paid' and amount_usd*100=(o.spec#>>'{line_items,0,price_data,unit_amount}')::numeric) or not exists(select 1 from public.departure_capacity_allocations a where a.booking_id=b.id and a.departure_id=b.departure_id and a.guest_count=b.guest_count and a.checkout_session_id=p_session_id) then return jsonb_build_object('allowed',false,'status',b.status,'online_paid_usd',amount); end if;
 if p_token is null or p_token='' then raise exception 'confirmation token required'; end if;
 if b.payment_confirmation_token is not null and b.payment_confirmation_claimed_at>clock_timestamp()-interval '5 minutes' then raise exception 'confirmation lease active; retry' using errcode='55P03'; end if;
 update public.bookings set status='confirmed',confirmed_at=coalesce(confirmed_at,p_confirmed_at),updated_at=clock_timestamp(),payment_confirmation_token=p_token,payment_confirmation_claimed_at=clock_timestamp() where id=b.id;
 update public.departure_capacity_allocations set state='confirmed' where booking_id=b.id;
 return jsonb_build_object('allowed',true,'status','confirmed','online_paid_usd',amount);
end $$;

-- Rollout is project-scoped and default OFF. `capacity_enforced` alone is never
-- an authorization to replace the established checkout functions; both switches
-- must be set in one reviewed operator transaction after mapping review.
create table public.departure_capacity_rollouts (
 project_id uuid primary key references public.tour_projects(id) on delete cascade,
 enabled boolean not null default false,
 enabled_at timestamptz,
 check(enabled is false or enabled_at is not null)
);
alter table public.departure_capacity_rollouts enable row level security;
revoke all on public.departure_capacity_rollouts from public,anon,authenticated;

create function public.departure_capacity_is_active(p_project_id uuid,p_departure_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.departure_capacity_rollouts r
  join public.departures d on d.id=p_departure_id and d.project_id=r.project_id
  where r.project_id=p_project_id and r.enabled and d.published and d.capacity_enforced);
$$;

-- A committed booking is canonical even if it predates allocations or an Ops
-- operator set its commercial status manually. An allocation is counted for
-- pending payment; committed rows are counted once via EXISTS, never joined.
create function public.departure_capacity_used(p_departure_id uuid,p_exclude_booking_id uuid default null)
returns integer language sql stable security definer set search_path='' as $$
 select coalesce(sum(b.guest_count),0)::integer from public.bookings b
 where b.departure_id=p_departure_id and b.id is distinct from p_exclude_booking_id
 and (exists(select 1 from public.departure_capacity_allocations a where a.booking_id=b.id)
      or b.status::text in ('confirmed','prep_sent','ready'));
$$;

create or replace function public.reserve_departure_capacity(p_booking_id uuid,p_session_id text default null) returns boolean language plpgsql security definer set search_path='' as $$
declare b public.bookings; d public.departures; used integer; sid text:=coalesce(p_session_id,'manual:'||p_booking_id::text); a public.departure_capacity_allocations;
begin
 perform public.checkout_service_role();
 select * into b from public.bookings where id=p_booking_id for update;
 if not found or b.departure_id is null or not public.departure_capacity_is_active(b.project_id,b.departure_id) then return false; end if;
 select * into d from public.departures where id=b.departure_id for update;
 select * into a from public.departure_capacity_allocations where booking_id=b.id for update;
 if found then return a.departure_id=b.departure_id and a.guest_count=b.guest_count and a.checkout_session_id=sid; end if;
 used:=public.departure_capacity_used(d.id,b.id);
 if used+b.guest_count>d.capacity then return false; end if;
 insert into public.departure_capacity_allocations(booking_id,departure_id,guest_count,checkout_session_id,state) values(b.id,d.id,b.guest_count,sid,'payment');
 return true;
end $$;

-- Prevent a tour-date/departure mismatch and apply the identical row lock to
-- manual inserts/status edits, not only edits that happen to have allocations.
create or replace function public.fence_departure_capacity_ops() returns trigger language plpgsql security definer set search_path='' as $$
declare d public.departures; used integer;
begin
 if tg_op='UPDATE' and new.departure_id is not null and new.tour_date is distinct from old.tour_date then
  raise exception 'tour date is immutable once a departure is assigned; operator transfer required';
 end if;
 if new.departure_id is null or not public.departure_capacity_is_active(new.project_id,new.departure_id) then return new; end if;
 select * into d from public.departures where id=new.departure_id for update;
 if new.guest_count is not null and (exists(select 1 from public.departure_capacity_allocations a where a.booking_id=new.id) or new.status::text in ('confirmed','prep_sent','ready')) then
  used:=public.departure_capacity_used(d.id,new.id);
  if used+new.guest_count>d.capacity then raise exception 'departure capacity exceeded; operator review required'; end if;
 end if;
 return new;
end $$;
drop trigger if exists z_fence_departure_capacity_ops on public.bookings;
create trigger z_fence_departure_capacity_ops before insert or update on public.bookings for each row execute function public.fence_departure_capacity_ops();

-- Release requires Stripe terminal evidence bound to this allocation's exact
-- session. Clock age, cancelled/refunded booking state and unknown/processing
-- provider outcomes cannot release inventory.
create function public.release_departure_capacity_if_safe(p_booking_id uuid,p_session_id text,p_provider_terminal text) returns boolean language plpgsql security definer set search_path='' as $$
declare b public.bookings; a public.departure_capacity_allocations; d public.departures;
begin
 perform public.checkout_service_role();
 if p_provider_terminal<>'expired' or coalesce(p_session_id,'')='' then return false; end if;
 select * into b from public.bookings where id=p_booking_id for update;
 select * into a from public.departure_capacity_allocations where booking_id=p_booking_id for update;
 if not found or a.state<>'payment' or a.checkout_session_id is distinct from p_session_id then return false; end if;
 select * into d from public.departures where id=a.departure_id for update;
 if b.departure_id is distinct from a.departure_id then raise exception 'allocation/booking departure mismatch'; end if;
 delete from public.departure_capacity_allocations where booking_id=p_booking_id and checkout_session_id=p_session_id and state='payment';
 return found;
end $$;

-- Keep the old public shape fail-closed: no caller can release a newly-created
-- generation merely by naming a booking and a clock-derived status.
create or replace function public.release_departure_capacity_if_safe(p_booking_id uuid,p_provider_terminal text) returns boolean language plpgsql security definer set search_path='' as $$
begin perform public.checkout_service_role(); return false; end $$;

revoke all on function public.assign_new_booking_departure(),public.departure_capacity_is_active(uuid,uuid),public.departure_capacity_used(uuid,uuid),public.reserve_departure_capacity(uuid,text),public.fence_departure_capacity_ops(),public.release_departure_capacity_if_safe(uuid,text),public.release_departure_capacity_if_safe(uuid,text,text) from public,anon,authenticated;
grant execute on function public.reserve_departure_capacity(uuid,text),public.release_departure_capacity_if_safe(uuid,text,text) to service_role;
