-- Reconciliation releases are fenced by the complete, exact current payment set.
-- Provider evidence is supplied only after the worker validates each named Stripe
-- session; these functions never infer or mutate payment ledger terminal states.
create function public.release_departure_capacity_if_all_expired_safe(
 p_booking_id uuid,
 p_expired_session_ids text[],
 p_provider_terminal text
) returns boolean language plpgsql security definer set search_path='' as $$
declare b public.bookings; d public.departures; a public.departure_capacity_allocations; current_ids text[]; verified_ids text[];
begin
 perform public.checkout_service_role();
 if p_provider_terminal <> 'expired' or coalesce(cardinality(p_expired_session_ids),0) < 1 or exists(select 1 from unnest(p_expired_session_ids) id where id is null or id='') then return false; end if;
 select array_agg(id order by id) into verified_ids from (select distinct id from unnest(p_expired_session_ids) id) ids;
 if cardinality(verified_ids) <> cardinality(p_expired_session_ids) then return false; end if;
 select * into b from public.bookings where id=p_booking_id for update;
 if not found then return false; end if;
 select * into d from public.departures where id=b.departure_id for update;
 if not found then return false; end if;
 select * into a from public.departure_capacity_allocations where booking_id=b.id for update;
 if not found or a.departure_id is distinct from d.id or a.state<>'payment' or not a.checkout_session_id=any(verified_ids) then return false; end if;
 perform 1 from public.payments where booking_id=b.id for update;
 if exists(select 1 from public.payments where booking_id=b.id and (provider<>'stripe' or stripe_checkout_session_id is null)) then return false; end if;
 select coalesce(array_agg(stripe_checkout_session_id order by stripe_checkout_session_id),array[]::text[]) into current_ids from public.payments where booking_id=b.id;
 if current_ids is distinct from verified_ids then return false; end if;
 delete from public.departure_capacity_allocations where booking_id=b.id and state='payment' and checkout_session_id=a.checkout_session_id;
 return found;
end $$;

create function public.release_confirmed_departure_capacity_on_cancel_if_safe(
 p_booking_id uuid,
 p_expired_session_ids text[],
 p_refunded_session_ids text[],
 p_provider_terminal text
) returns boolean language plpgsql security definer set search_path='' as $$
declare b public.bookings; d public.departures; a public.departure_capacity_allocations; current_ids text[]; verified_ids text[];
begin
 perform public.checkout_service_role();
 if p_provider_terminal <> 'cancelled_refunded' then return false; end if;
 if exists(select 1 from unnest(coalesce(p_expired_session_ids,array[]::text[]) || coalesce(p_refunded_session_ids,array[]::text[])) id where id is null or id='') then return false; end if;
 select array_agg(id order by id) into verified_ids from (select distinct id from unnest(coalesce(p_expired_session_ids,array[]::text[]) || coalesce(p_refunded_session_ids,array[]::text[])) id) ids;
 if coalesce(cardinality(verified_ids),0) < 1 or cardinality(verified_ids) <> cardinality(coalesce(p_expired_session_ids,array[]::text[]) || coalesce(p_refunded_session_ids,array[]::text[])) then return false; end if;
 select * into b from public.bookings where id=p_booking_id for update;
 if not found or b.status::text<>'cancelled' then return false; end if;
 select * into d from public.departures where id=b.departure_id for update;
 if not found then return false; end if;
 select * into a from public.departure_capacity_allocations where booking_id=b.id for update;
 if not found or a.departure_id is distinct from d.id or a.state<>'confirmed' then return false; end if;
 perform 1 from public.payments where booking_id=b.id for update;
 if exists(select 1 from public.payments where booking_id=b.id and (provider<>'stripe' or stripe_checkout_session_id is null)) then return false; end if;
 select coalesce(array_agg(stripe_checkout_session_id order by stripe_checkout_session_id),array[]::text[]) into current_ids from public.payments where booking_id=b.id;
 if current_ids is distinct from verified_ids then return false; end if;
 delete from public.departure_capacity_allocations where booking_id=b.id and state='confirmed';
 if found then insert into public.booking_events(booking_id,event_type,direction,title,body,created_by) values(b.id,'system','internal','Departure capacity released','Verified cancelled/refunded terminal outcome released confirmed departure capacity.','system'); end if;
 return found;
end $$;

revoke all on function public.release_departure_capacity_if_all_expired_safe(uuid,text[],text),public.release_confirmed_departure_capacity_on_cancel_if_safe(uuid,text[],text[],text) from public,anon,authenticated;
grant execute on function public.release_departure_capacity_if_all_expired_safe(uuid,text[],text),public.release_confirmed_departure_capacity_on_cancel_if_safe(uuid,text[],text[],text) to service_role;
