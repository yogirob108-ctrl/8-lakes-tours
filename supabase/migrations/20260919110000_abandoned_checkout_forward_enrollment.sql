-- Bounded abandoned-checkout rollout repair.
-- This migration deliberately does not enable sending, alter existing recovery rows,
-- or enroll historical bookings. It only makes a future, explicit forward rollout
-- atomically bind checkouts inserted after its activation watermark.

alter table public.abandoned_cadence_rollout
  add column if not exists activation_ref text,
  add column if not exists activation_watermark timestamptz;

-- One explicit operator action opens the forward-only cohort. The row lock makes
-- concurrent booking inserts serialize behind the watermark decision. Repeating
-- an activation or changing its reference requires an operator-reviewed rollback
-- rather than silently broadening a customer cohort.
create or replace function public.abandoned_cadence_activate_forward(p_activation_ref text)
returns timestamptz language plpgsql security definer set search_path='' as $$
declare activated_at timestamptz;
begin
  perform public.checkout_service_role();
  if coalesce(btrim(p_activation_ref),'')='' then
    raise exception 'activation_ref is required';
  end if;

  perform 1 from public.abandoned_cadence_rollout where one_row for update;
  if not found then
    raise exception 'abandoned cadence rollout row is missing';
  end if;
  if (select mode from public.abandoned_cadence_rollout where one_row) <> 'off' then
    raise exception 'abandoned cadence rollout is not off';
  end if;

  activated_at := clock_timestamp();
  update public.abandoned_cadence_rollout
     set mode='forward', activation_ref=p_activation_ref,
         activation_watermark=activated_at, updated_at=activated_at
   where one_row;
  return activated_at;
end $$;

-- Enrollment is intentionally owned by the booking INSERT trigger rather than a
-- batch job. A booking is admitted only if its insert serializes after explicit
-- forward activation. Recovery state, exact-booking activation evidence and the
-- stage-2 binding are inserted in this same transaction: a rollback leaves none.
create or replace function public.enroll_abandoned_checkout()
returns trigger language plpgsql security definer set search_path='' as $$
declare rollout public.abandoned_cadence_rollout;
begin
  if new.submission_key is null
     or not exists(select 1 from public.tour_projects where id=new.project_id and slug='8-lakes-tours') then
    return new;
  end if;

  select * into rollout from public.abandoned_cadence_rollout where one_row for update;
  if not found
     or rollout.mode <> 'forward'
     or coalesce(btrim(rollout.activation_ref),'')=''
     or rollout.activation_watermark is null
     or clock_timestamp() < rollout.activation_watermark then
    return new;
  end if;

  insert into public.abandoned_checkout_recovery(booking_id,tour_date)
  values(new.id,new.tour_date)
  on conflict (booking_id) do nothing;

  insert into public.abandoned_cadence_activation_log(activation_ref,booking_id,activated_at)
  values(rollout.activation_ref,new.id,rollout.activation_watermark)
  on conflict (activation_ref,booking_id) do nothing;
  insert into public.abandoned_cadence_booking_activation(booking_id,activation_ref,activated_at)
  values(new.id,rollout.activation_ref,rollout.activation_watermark)
  on conflict (booking_id) do nothing;
  insert into public.abandoned_cadence_stage2_cohort(booking_id,activation_ref,added_at)
  values(new.id,rollout.activation_ref,rollout.activation_watermark)
  on conflict (booking_id) do nothing;
  return new;
end $$;

-- Stage 2 is valid only when it is bound to the same forward activation evidence
-- as stage 1. This preserves legacy rows but prevents an independently inserted
-- cohort row from authorizing a second email.
create or replace function public.abandoned_cadence_stage2_allowed(p_booking_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(
    select 1
      from public.abandoned_cadence_stage2_cohort s
      join public.abandoned_cadence_booking_activation a
        on a.booking_id=s.booking_id and a.activation_ref=s.activation_ref
      join public.abandoned_cadence_activation_log l
        on l.booking_id=s.booking_id and l.activation_ref=s.activation_ref
     where s.booking_id=p_booking_id
  );
$$;

revoke all on function public.abandoned_cadence_activate_forward(text) from public,anon,authenticated;
grant execute on function public.abandoned_cadence_activate_forward(text) to service_role;
revoke all on function public.enroll_abandoned_checkout() from public,anon,authenticated;
grant execute on function public.enroll_abandoned_checkout() to service_role;
revoke all on function public.abandoned_cadence_stage2_allowed(uuid) from public,anon,authenticated;
grant execute on function public.abandoned_cadence_stage2_allowed(uuid) to service_role;
