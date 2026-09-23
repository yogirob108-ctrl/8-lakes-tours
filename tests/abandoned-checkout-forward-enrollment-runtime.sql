\set ON_ERROR_STOP on
begin;
set request.jwt.claim.role='service_role';
do $$
declare p uuid; c uuid; before_id uuid; after_id uuid; watermark timestamptz; v_activation_ref text := 'FORWARD-ENROLLMENT-FIXTURE';
begin
  select id into strict p from public.tour_projects where slug='8-lakes-tours';
  insert into public.customers(first_name,last_name,email) values('Forward','Fixture','forward-enrollment@example.invalid') returning id into c;

  -- A checkout created before explicit activation is not enrolled merely because
  -- a rollout may later be enabled: no historical catch-up cohort exists.
  insert into public.bookings(customer_id,project_id,public_reference,tour_date,status,submission_key,guest_count,online_due_usd,online_paid_usd)
  values(c,p,'FORWARD-BEFORE','Scheduled fixture','awaiting_payment',gen_random_uuid(),1,999,0) returning id into before_id;
  if exists(select 1 from public.abandoned_checkout_recovery where booking_id=before_id) then
    raise exception 'FORWARD-OLD: gate-off booking was enrolled';
  end if;

  perform public.abandoned_cadence_activate_forward(v_activation_ref);
  select activation_watermark into watermark from public.abandoned_cadence_rollout where one_row;
  if watermark is null or public.abandoned_cadence_gate_current() <> 'forward' then
    raise exception 'FORWARD-ACTIVATION: forward mode/watermark missing';
  end if;
  -- A retry of the same activation is safe: it must keep the original cohort
  -- boundary rather than move the watermark forward.
  if public.abandoned_cadence_activate_forward(v_activation_ref) is distinct from watermark then
    raise exception 'FORWARD-IDEMPOTENT: repeated activation moved the watermark';
  end if;
  -- A pause may be resumed only with the same audited reference and must retain
  -- that exact original watermark. A new activation cannot silently reopen a
  -- different cohort after pause.
  update public.abandoned_cadence_rollout set mode='off' where one_row;
  begin
    perform public.abandoned_cadence_activate_forward('FORWARD-DIFFERENT-REF');
    raise exception 'FORWARD-REACTIVATE: changed reference was accepted';
  exception when others then
    if sqlerrm like 'FORWARD-REACTIVATE:%' then raise; end if;
  end;
  if (select activation_ref from public.abandoned_cadence_rollout where one_row) <> v_activation_ref
     or (select activation_watermark from public.abandoned_cadence_rollout where one_row) is distinct from watermark then
    raise exception 'FORWARD-REACTIVATE: existing activation evidence changed';
  end if;
  if public.abandoned_cadence_resume_forward(v_activation_ref) is distinct from watermark then
    raise exception 'FORWARD-RESUME: resume moved the watermark';
  end if;
  -- A different reference remains forbidden even after resume.
  begin
    perform public.abandoned_cadence_activate_forward('FORWARD-DIFFERENT-REF');
    raise exception 'FORWARD-REACTIVATE: changed reference was accepted';
  exception when others then
    if sqlerrm like 'FORWARD-REACTIVATE:%' then raise; end if;
  end;
  if (select activation_ref from public.abandoned_cadence_rollout where one_row) <> v_activation_ref
     or (select activation_watermark from public.abandoned_cadence_rollout where one_row) is distinct from watermark then
    raise exception 'FORWARD-REACTIVATE: existing activation evidence changed';
  end if;

  insert into public.bookings(customer_id,project_id,public_reference,tour_date,status,submission_key,guest_count,online_due_usd,online_paid_usd)
  values(c,p,'FORWARD-AFTER','Scheduled fixture','awaiting_payment',gen_random_uuid(),1,999,0) returning id into after_id;
  if not exists(select 1 from public.abandoned_checkout_recovery where booking_id=after_id) then
    raise exception 'FORWARD-NEW: fresh checkout was not enrolled';
  end if;
  if not public.abandoned_cadence_gate_admits('forward',after_id) then
    raise exception 'FORWARD-BINDING: fresh checkout lacks activation binding';
  end if;
  if not public.abandoned_cadence_stage2_allowed(after_id) then
    raise exception 'FORWARD-STAGE2: fresh checkout lacks transaction-bound stage2 cohort';
  end if;
  if exists(select 1 from public.abandoned_cadence_booking_activation a join public.abandoned_cadence_stage2_cohort s using (booking_id)
            where a.booking_id=after_id and a.activation_ref <> s.activation_ref)
    or not exists(select 1 from public.abandoned_cadence_activation_log l where l.booking_id=after_id and l.activation_ref=v_activation_ref) then
    raise exception 'FORWARD-ATOMIC: activation/stage2 bindings disagree';
  end if;
  if public.abandoned_cadence_gate_admits('forward',before_id) or public.abandoned_cadence_stage2_allowed(before_id) then
    raise exception 'FORWARD-OLD-ADMITTED: pre-watermark checkout entered cohort';
  end if;
end $$;
rollback;
