-- Store validated attribution as durable booking metadata, not customer or operator notes.
-- New bookings only: historical submission_payload and evidence remain untouched.
-- First-touch retention is client-side 30 days; direct returns are explicit current visits.

create or replace function public.create_public_booking(
  p_submission_key uuid,
  p_public_reference text,
  p_project_slug text,
  p_tour_date text,
  p_guest_count integer,
  p_status public.booking_status,
  p_total_trip_value_usd integer,
  p_online_due_usd integer,
  p_family_cash_due_usd integer,
  p_emergency_contact text,
  p_customer_notes text,
  p_booking_notes text,
  p_travellers jsonb,
  p_attribution jsonb
)
returns table(booking_id uuid, customer_id uuid, public_reference text, created boolean)
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_result record;
begin
  if coalesce(current_setting('request.jwt.claim.role', true), '') <> 'service_role'
     and coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role', '') <> 'service_role' then
    raise exception 'service role required' using errcode = '42501';
  end if;
  if p_attribution is not null and jsonb_typeof(p_attribution) <> 'object' then
    raise exception 'attribution must be an object';
  end if;

  select * into v_result from public.create_public_booking(
    p_submission_key, p_public_reference, p_project_slug, p_tour_date, p_guest_count,
    p_status, p_total_trip_value_usd, p_online_due_usd, p_family_cash_due_usd,
    p_emergency_contact, p_customer_notes, p_booking_notes, p_travellers
  );

  -- The underlying idempotent RPC owns creation.  Only its fresh row is amended,
  -- so no old booking is backfilled or relabelled from later browser evidence.
  if v_result.created then
    update public.bookings
      set submission_payload = jsonb_set(
        coalesce(submission_payload, '{}'::jsonb),
        '{attribution}',
        coalesce(p_attribution, '{}'::jsonb),
        true
      )
      where id = v_result.booking_id;
  end if;

  return query select v_result.booking_id, v_result.customer_id, v_result.public_reference, v_result.created;
end;
$$;

revoke all on function public.create_public_booking(uuid, text, text, text, integer, public.booking_status, integer, integer, integer, text, text, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.create_public_booking(uuid, text, text, text, integer, public.booking_status, integer, integer, integer, text, text, text, jsonb, jsonb) to service_role;
