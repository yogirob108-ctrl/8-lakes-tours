-- Every cancellation writer must share the lifecycle dispatch booking lock.
-- This trigger covers both the transactional Ops RPC and legacy/autosave update paths.
create or replace function public.guard_booking_cancellation_lifecycle_dispatch()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    if (old.lifecycle_email_token is not null and (old.lifecycle_email_claimed_at is null or old.lifecycle_email_claimed_at >= clock_timestamp() - interval '5 minutes'))
       or exists (select 1 from public.lifecycle_email_dispatches d where d.booking_id = old.id and d.status in ('queued','reconciliation_required')) then
      raise exception 'lifecycle dispatch is in progress or requires reconciliation' using errcode = '55000';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists bookings_guard_cancellation_lifecycle_dispatch on public.bookings;
create trigger bookings_guard_cancellation_lifecycle_dispatch
before update of status on public.bookings
for each row execute function public.guard_booking_cancellation_lifecycle_dispatch();

revoke all on function public.guard_booking_cancellation_lifecycle_dispatch() from public, anon, authenticated;
