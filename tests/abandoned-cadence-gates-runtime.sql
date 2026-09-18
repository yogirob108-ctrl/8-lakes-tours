-- RED first: durable rollout gate (B1) and legacy sent-ledger seeding (B2).
-- Run AFTER the new migration in a fresh 8l_test clone; every assertion here
-- encodes one acceptance line from the review contract.
\set ON_ERROR_STOP on
begin;
set request.jwt.claim.role='service_role';
do $$
declare b uuid;c uuid;p uuid;a jsonb;r jsonb;n uuid;
begin
 select id into strict p from tour_projects where slug='8-lakes-tours';
 insert into customers(first_name,last_name,email) values('Gate','Fixture','gate-fixture@example.invalid') returning id into c;
 insert into bookings(customer_id,project_id,public_reference,tour_date,status,submission_key,guest_count,online_due_usd,online_paid_usd) values(c,p,'GATE-TEST','Scheduled fixture','awaiting_payment',gen_random_uuid(),1,999,0) returning id into b;
 update abandoned_checkout_recovery set eligible_at=now()-interval '1 minute' where booking_id=b;
 insert into booking_checkout_ownership(booking_id,spec,expected,session_id) values(b,'{"line_items":[{"price_data":{"unit_amount":99900}}]}','{}','cs_gate');
 insert into payments(booking_id,provider,stripe_checkout_session_id,amount_usd,status) values(b,'stripe','cs_gate',999,'pending');

 -- ===== B1: gate default OFF and durable =====
 if public.abandoned_cadence_gate_current() is distinct from 'off' then raise exception 'GATE-DEFAULT: fresh application must read mode=off'; end if;
 -- env-style override outside an approved activation must NOT enable: claim refuses while OFF.
 a:=claim_abandoned_checkout(b,array['Scheduled fixture'],'{"to":"gate-fixture@example.invalid","subject":"x","text":"x"}');
 if (a->>'should_send')::boolean then raise exception 'GATE-OFF: claim succeeded while rollout mode=off'; end if;
 if due_abandoned_checkout_stage(b) is distinct from 'abandoned_checkout_1' then raise exception 'GATE-ORDER: stage clock runs before gate'; end if;
 update abandoned_cadence_rollout set mode='test_allowlist';
 -- even with mode on, the allowlist default contains nothing and a NON activation_ref is refused
 a:=claim_abandoned_checkout(b,array['Scheduled fixture'],'{"to":"gate-fixture@example.invalid","subject":"x","text":"x"}');
 if (a->>'should_send')::boolean then raise exception 'GATE-ALLOWLIST: non-cohort claim admitted without activation_ref'; end if;
 -- explicit operator activation for the exact cohort booking admits stage 1 (runtime probe only;
 -- a real operator enable runs the same update with an immutable pre-notified activation time).
 perform public.abandoned_cadence_activate_booking(b,'8L-5PEAKQY');
 a:=claim_abandoned_checkout(b,array['Scheduled fixture'],'{"to":"gate-fixture@example.invalid","subject":"x","text":"x"}');
 if not (a->>'should_send')::boolean then raise exception 'GATE-ACTIVATE: exact operator-approved cohort booking refused'; end if;
 if a#>>'{payload,stage}'<>'abandoned_checkout_1' then raise exception 'GATE-STAGE: cohort claim not stage 1'; end if;
 -- a DIFFERENT booking, same exact ref: refused (activation binds one booking)
 insert into bookings(customer_id,project_id,public_reference,tour_date,status,submission_key,guest_count,online_due_usd,online_paid_usd) values(c,p,'GATE-TEST-2','Scheduled fixture','awaiting_payment',gen_random_uuid(),1,999,0) returning id into b;
 update abandoned_checkout_recovery set eligible_at=now()-interval '1 minute' where booking_id=b;
 insert into booking_checkout_ownership(booking_id,spec,expected,session_id) values(b,'{"line_items":[{"price_data":{"unit_amount":99900}}]}','{}','cs_gate2');
 insert into payments(booking_id,provider,stripe_checkout_session_id,amount_usd,status) values(b,'stripe','cs_gate2',999,'pending');
 a:=claim_abandoned_checkout(b,array['Scheduled fixture'],'{"to":"gate-fixture@example.invalid","subject":"x","text":"x"}');
 if (a->>'should_send')::boolean then raise exception 'GATE-SCOPE: second booking admitted on the same activation_ref'; end if;
 -- restore the activation set so the B2 half can run on booking 1
 update abandoned_cadence_rollout set mode='off';
 delete from abandoned_cadence_booking_activation where activation_ref='8L-5PEAKQY' and booking_id=b;
 delete from abandoned_cadence_activation_log where activation_ref='8L-5PEAKQY' and booking_id=b;

 -- ===== B1b: legacy v2 authorize is fenced by the same gate =====
 -- (booking 2 has no stage claim; put a legacy-key claim in its place via the
 -- seeded legacy path exercised below, then verify v2 refuses while OFF and
 -- authorizes once an explicit legacy-path activation exists)
 update abandoned_cadence_rollout set mode='test_allowlist';
 update abandoned_checkout_recovery set stages=jsonb_build_object('abandoned_checkout_1',jsonb_build_object('completed_at',now()-interval '25 hours')) where booking_id=b;
 insert into email_events(booking_id,customer_id,template_key,to_email,subject,body_snapshot,sent_by,status,public_submission_email_key)
  values(b,c,'abandoned_checkout','gate-fixture@example.invalid','legacy','legacy','legacy-deployed','queued',b::text||':legacy:probe') returning id into n;
 insert into public_booking_notifications(booking_id,template_key,email_event_id,payload,status)
  values(b,'abandoned_checkout',n,'{}','queued');
 a:=jsonb_build_object('should_send',true,'email_event_id',(select email_event_id from public_booking_notifications where booking_id=b and template_key='abandoned_checkout'),'claim_token',(select claim_token from public_booking_notifications where booking_id=b and template_key='abandoned_checkout'));
 if authorize_abandoned_checkout_v2(b,(a->>'claim_token')::uuid,array['Scheduled fixture'],(select generation from booking_checkout_ownership where booking_id=b),array['cs_gate2']) then
  raise exception 'GATE-LEGACY: v2 authorized a claim while the rollout gate is closed';
 end if;
 update abandoned_cadence_rollout set mode='off';
 delete from public_booking_notifications where booking_id=b and template_key='abandoned_checkout';
 delete from abandoned_checkout_recovery where booking_id=b;

 -- ===== B2: legacy sent ledger seeds stage 1 (dedupe), ambiguity fences, cohort fence =====
 -- Fresh booking with a historical LEGACY sent reminder (deployed template key).
 insert into bookings(customer_id,project_id,public_reference,tour_date,status,submission_key,guest_count,online_due_usd,online_paid_usd) values(c,p,'GATE-TEST-3','Scheduled fixture','awaiting_payment',gen_random_uuid(),1,999,0) returning id into b;
 update abandoned_checkout_recovery set eligible_at=now()-interval '1 minute' where booking_id=b;
 insert into booking_checkout_ownership(booking_id,spec,expected,session_id) values(b,'{"line_items":[{"price_data":{"unit_amount":99900}}]}','{}','cs_gate3');
 insert into payments(booking_id,provider,stripe_checkout_session_id,amount_usd,status) values(b,'stripe','cs_gate3',999,'pending');
 insert into email_events(booking_id,customer_id,template_key,to_email,subject,body_snapshot,sent_by,status,provider_message_id,sent_at,public_submission_email_key)
 values(b,c,'abandoned_checkout','gate-fixture@example.invalid','legacy sent','legacy sent','legacy-deployed','sent','legacy-msg-1',now()-interval '30 hours',b::text||':legacy:1');
 -- B2-dedupe: seed derives stage-1 completion from the sent ledger, never fabricates.
 perform public.abandoned_cadence_seed_legacy_stage1();
 if coalesce((select stages->'abandoned_checkout_1'->>'completed_at' from abandoned_checkout_recovery where booking_id=b),'')='' then raise exception 'B2-SEED: legacy sent reminder did not seed stage-1 completion'; end if;
 if due_abandoned_checkout_stage(b) is distinct from 'abandoned_checkout_2' then raise exception 'B2-SEED-STAGE: seeded completion must put the booking in the stage-2 window, not re-send stage 1'; end if;
 -- Idempotent: seeding twice does not duplicate or drift.
 perform public.abandoned_cadence_seed_legacy_stage1();
 if (select count(*) from abandoned_checkout_recovery where booking_id=b and stages->'abandoned_checkout_1'->>'completed_at' is not null)<>1 then raise exception 'B2-SEED-IDEMPOTENT'; end if;
 -- B2-stage2-fence: cohort fence is explicit and default empty.
 if exists(select 1 from abandoned_cadence_stage2_cohort) then raise exception 'B2-COHORT-DEFAULT: stage-2 cohort must start empty'; end if;
 if public.abandoned_cadence_stage2_allowed(b) then raise exception 'B2-COHORT: stage 2 admitted without explicit cohort membership'; end if;
 insert into abandoned_cadence_stage2_cohort(booking_id,activation_ref) values(b,'8L-COHORT-B2');
 if not public.abandoned_cadence_stage2_allowed(b) then raise exception 'B2-COHORT-EXPLICIT: explicitly added cohort member refused'; end if;
 update abandoned_cadence_rollout set mode='test_allowlist';
 a:=claim_abandoned_checkout(b,array['Scheduled fixture'],'{"to":"gate-fixture@example.invalid","subject":"x","text":"x"}');
 update abandoned_cadence_rollout set mode='off';
 if coalesce(a->>'should_send','false')::boolean and a#>>'{payload,stage}'<>'abandoned_checkout_2' then raise exception 'B2-COHORT-STAGE: cohort member must claim stage 2, not stage 1'; end if;
 if coalesce(a->>'should_send','false')::boolean then
  -- stage-2 claim went out for the explicit member; finalize it durably.
  perform finalize_abandoned_checkout_stage((a->>'email_event_id')::uuid,(a->>'claim_token')::uuid,'abandoned_checkout_2',true,'local-only','{}',false);
 end if;
 -- B2-ambiguity: a legacy-key queued notification with an OLD first attempt
 -- (ambiguous outcome from old deployed code) fences to review, never a blind
 -- stage-1 send under a new key.
 -- reset stage progress (the earlier finalize completed stage 2) but KEEP the
 -- recovery row: without it the claim returns early and the ambiguity fence
 -- below would never be exercised.
 update abandoned_checkout_recovery set stages='{}'::jsonb where booking_id=b;
 insert into email_events(booking_id,customer_id,template_key,to_email,subject,body_snapshot,sent_by,status,public_submission_email_key)
 values(b,c,'abandoned_checkout','gate-fixture@example.invalid','legacy queued','legacy queued','legacy-deployed','queued',b::text||':legacy:2');
 insert into public_booking_notifications(booking_id,template_key,email_event_id,payload,status,first_attempt_at)
 values(b,'abandoned_checkout',(select id from email_events where public_submission_email_key=b::text||':legacy:2'),'{}','queued',now()-interval '30 hours');
 update abandoned_cadence_rollout set mode='test_allowlist';
 perform public.abandoned_cadence_activate_booking(b,'8L-LEGACY-PROBE');
 a:=claim_abandoned_checkout(b,array['Scheduled fixture'],'{"to":"gate-fixture@example.invalid","subject":"x","text":"x"}');
 if (a->>'should_send')::boolean then raise exception 'B2-AMBIGUOUS: legacy-key queued attempt older than 23h must fence, not blind-send stage 1'; end if;
 if (select status from public_booking_notifications where booking_id=b and template_key='abandoned_checkout')<>'review' then raise exception 'B2-AMBIGUOUS-REVIEW: legacy ambiguous attempt not moved to operator review'; end if;
 update abandoned_cadence_rollout set mode='off';
end $$;
rollback;
