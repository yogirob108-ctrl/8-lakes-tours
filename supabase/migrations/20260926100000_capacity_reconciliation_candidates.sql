-- Bounded service-role reconciliation candidates.  This is independent of the
-- reminder cohort: allocations with no email, ineligible dates, or exhausted
-- reminder stages still appear.  The fixed upper snapshot plus tuple cursor
-- gives a finite, stable scan without offset drift.
create function public.list_departure_capacity_reconciliation_candidates(
 p_after_allocated_at timestamptz default null,
 p_after_booking_id uuid default null,
 p_before_allocated_at timestamptz default clock_timestamp(),
 p_limit integer default 50
) returns table(
 booking_id uuid,
 public_reference text,
 customer_id uuid,
 booking_status text,
 state text,
 checkout_session_id text,
 payment_session_ids text[],
 allocated_at timestamptz
) language plpgsql security definer set search_path='' as $$
begin
 perform public.checkout_service_role();
 if p_before_allocated_at is null or p_limit is null or p_limit<1 or p_limit>50 then raise exception 'invalid reconciliation page'; end if;
 if (p_after_allocated_at is null) <> (p_after_booking_id is null) then raise exception 'invalid reconciliation cursor'; end if;
 return query
 select a.booking_id,b.public_reference,b.customer_id,b.status::text,a.state,a.checkout_session_id,
  coalesce(array_agg(p.stripe_checkout_session_id order by p.stripe_checkout_session_id) filter(where p.stripe_checkout_session_id is not null),array[]::text[]),a.allocated_at
 from public.departure_capacity_allocations a
 join public.bookings b on b.id=a.booking_id
 left join public.payments p on p.booking_id=b.id and p.provider='stripe'
 where a.allocated_at<=p_before_allocated_at
  and (p_after_allocated_at is null or (a.allocated_at,a.booking_id)>(p_after_allocated_at,p_after_booking_id))
  and (a.state='payment' or (a.state='confirmed' and b.status::text='cancelled'))
 group by a.booking_id,b.public_reference,b.customer_id,b.status,a.state,a.checkout_session_id,a.allocated_at
 order by a.allocated_at,a.booking_id
 limit p_limit;
end $$;
revoke all on function public.list_departure_capacity_reconciliation_candidates(timestamptz,uuid,timestamptz,integer) from public,anon,authenticated;
grant execute on function public.list_departure_capacity_reconciliation_candidates(timestamptz,uuid,timestamptz,integer) to service_role;
