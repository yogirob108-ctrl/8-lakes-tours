-- Additive cadence correction: stage 2 is due 48 hours after stage 1 was
-- accepted and durably completed, never from initial checkout submission.
-- This changes no rollout mode, activation watermark, cohort, recovery row or
-- historical booking. Existing paid, cancelled, ambiguous and provider gates
-- remain in the canonical claim and authorization functions.

-- Keep this clock exactly aligned with lib/abandoned-checkout.mjs dueStage.
-- Stage 2 stays available for 48 hours after becoming due, so its bounded window
-- ends 96 hours after the stage-1 completion.
create or replace function public.due_abandoned_checkout_stage(p_booking_id uuid)
returns text language sql stable security definer set search_path='' as $$
 select case
  when q.stages->'abandoned_checkout_2'->>'completed_at' is not null then null
  when q.stages->'abandoned_checkout_1'->>'completed_at' is not null then
   case
    when q.stages->'abandoned_checkout_2'->>'blocked_at' is not null
     and (q.stages->'abandoned_checkout_2'->>'blocked_at')::timestamptz>clock_timestamp()-interval '24 hours' then null
    when (q.stages->'abandoned_checkout_1'->>'completed_at')::timestamptz+interval '48 hours'<=clock_timestamp()
     and clock_timestamp()<(q.stages->'abandoned_checkout_1'->>'completed_at')::timestamptz+interval '96 hours' then 'abandoned_checkout_2'
    else null end
  when q.stages->'abandoned_checkout_1'->>'blocked_at' is not null then
   case
    when (q.stages->'abandoned_checkout_1'->>'blocked_at')::timestamptz>clock_timestamp()-interval '24 hours' then null
    when clock_timestamp()<q.expires_at+interval '7 days' then 'abandoned_checkout_1'
    else null end
  when q.expires_at<=clock_timestamp() then null
  else 'abandoned_checkout_1' end
 from public.abandoned_checkout_recovery q where q.booking_id=p_booking_id;
$$;

-- A completed stage only extends eligibility through the bounded successor
-- window. Untouched rows still expire at their original intake deadline.
create or replace function public.abandoned_checkout_eligible(p_booking_id uuid,p_allowed_dates text[])
returns boolean language sql security definer set search_path='' as $$
 select exists(select 1 from public.bookings b
 join public.tour_projects p on p.id=b.project_id
 join public.abandoned_checkout_recovery q on q.booking_id=b.id
 join public.booking_checkout_ownership a on a.booking_id=b.id
 where b.id=p_booking_id and p.slug='8-lakes-tours' and p.active
 and b.submission_key is not null and b.status='awaiting_payment'
 and b.online_paid_usd=0 and b.online_due_usd>0 and b.guest_count between 1 and 8
 and b.tour_date=q.tour_date and b.tour_date=any(p_allowed_dates)
 and q.eligible_at<=clock_timestamp()
 and (q.expires_at>clock_timestamp()
   or coalesce((select bool_or(
        (v->>'completed_at' is not null
         and clock_timestamp()<(v->>'completed_at')::timestamptz+interval '96 hours')
        or (v->>'blocked_at' is not null
         and clock_timestamp()<q.expires_at+interval '7 days'))
      from jsonb_each(q.stages) as e(k,v)),false))
 and not exists(select 1 from public.payments pay where pay.booking_id=b.id and pay.status::text not in ('pending','failed')));
$$;

revoke all on function public.due_abandoned_checkout_stage(uuid),public.abandoned_checkout_eligible(uuid,text[]) from public,anon,authenticated;
grant execute on function public.due_abandoned_checkout_stage(uuid),public.abandoned_checkout_eligible(uuid,text[]) to service_role;
