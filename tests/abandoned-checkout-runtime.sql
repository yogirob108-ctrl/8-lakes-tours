\set ON_ERROR_STOP on
begin;
set request.jwt.claim.role='service_role';
do $$
declare c uuid;b uuid;p uuid;a jsonb;r jsonb;s1 timestamptz;allowed text[]:=array['Scheduled fixture'];
begin
 select id into strict p from tour_projects where slug='8-lakes-tours';
 insert into customers(first_name,last_name,email) values('Recovery','Test','recovery@example.invalid') returning id into c;
 insert into bookings(customer_id,project_id,public_reference,tour_date,status,submission_key,guest_count,online_due_usd,online_paid_usd) values(c,p,'RECOVERY-TEST','Scheduled fixture','awaiting_payment',gen_random_uuid(),1,999,0) returning id into b;
 if not exists(select 1 from abandoned_checkout_recovery where booking_id=b) then raise exception 'new intake not enrolled'; end if;
 -- Stage 1 only: stage key recorded durably on the claim payload.
 a:=claim_abandoned_checkout(b,allowed,'{"to":"recovery@example.invalid","subject":"Original","text":"private","html":"private"}');
 if (a->>'should_send')::boolean then raise exception 'sent before delay'; end if;
 update abandoned_checkout_recovery set eligible_at=now()-interval '1 minute' where booking_id=b;
 if due_abandoned_checkout_stage(b) is distinct from 'abandoned_checkout_1' then raise exception 'stage 1 not due'; end if;
 -- Unconfirmed/private dates still refused.
 a:=claim_abandoned_checkout(b,array['Other'],'{}');
 if (a->>'should_send')::boolean then raise exception 'unconfirmed/private date permitted'; end if;
 -- Paid/cancelled still refused.
 update bookings set status='cancelled' where id=b;
 a:=claim_abandoned_checkout(b,allowed,'{}');
 if (a->>'should_send')::boolean then raise exception 'cancelled permitted'; end if;
 update bookings set status='awaiting_payment',online_paid_usd=1 where id=b;
 a:=claim_abandoned_checkout(b,allowed,'{}');
 if (a->>'should_send')::boolean then raise exception 'paid permitted'; end if;
 update bookings set online_paid_usd=0 where id=b;
 insert into payments(booking_id,provider,amount_usd,status) values(b,'stripe',999,'paid');
 a:=claim_abandoned_checkout(b,allowed,'{}');
 if (a->>'should_send')::boolean then raise exception 'unreconciled paid ledger permitted'; end if;
 delete from payments where booking_id=b;
 insert into booking_checkout_ownership(booking_id,spec,expected,session_id) values(b,'{"line_items":[{"price_data":{"unit_amount":99900}}]}','{}','cs_recovery');
 insert into payments(booking_id,provider,amount_usd,status,stripe_checkout_session_id) values(b,'stripe',999,'pending','cs_recovery');
 -- Expired intake still refused.
 update abandoned_checkout_recovery set expires_at=now()-interval '1 minute' where booking_id=b;
 a:=claim_abandoned_checkout(b,allowed,'{}');
 if (a->>'should_send')::boolean then raise exception 'expired intake permitted'; end if;
 update abandoned_checkout_recovery set expires_at=now()+interval '1 day' where booking_id=b;
 perform * from list_abandoned_checkouts(allowed);
 -- Eligible claim (runtime probe of the fixture-gate allowlist; a real enable
 -- runs the same durable update): cohort booking + allowlist mode, plus stage-2
 -- cohort membership for the later stage-2 probes in this fixture.
 update abandoned_cadence_rollout set mode='test_allowlist';
 perform public.abandoned_cadence_activate_booking(b,'8L-RECOVERY-PROBE');
 insert into abandoned_cadence_stage2_cohort(booking_id,activation_ref) values(b,'8L-RECOVERY-PROBE');
 a:=claim_abandoned_checkout(b,allowed,'{"to":"recovery@example.invalid","subject":"Original","text":"private","html":"private"}');
 if not (a->>'should_send')::boolean or a#>>'{payload,stage}'<>'abandoned_checkout_1' then raise exception 'stage 1 claim missing stage key'; end if;
 if a#>>'{payload,subject}'<>'Original' then raise exception 'retry request changed'; end if;
 -- Undo the paid/cancelled status-flip probes' fence side effects (both flags
 -- churn on booking status/payment probes; the refusals themselves are enforced
 -- at authorize, with fresh readback).
 update booking_checkout_ownership set terms_invalidated=false,invalidated=false where booking_id=b;
 r:=claim_abandoned_checkout(b,allowed,'{}');
 if (r->>'should_send')::boolean then raise exception 'double claim'; end if;
 -- Same claim/stage retry after failure keeps the original request payload.
 perform finalize_abandoned_checkout_stage((a->>'email_event_id')::uuid,(a->>'claim_token')::uuid,'abandoned_checkout_1',false,null,'{"error":"provider timeout"}',false);
 r:=claim_abandoned_checkout(b,allowed,'{"subject":"Replacement"}');
 if not (r->>'should_send')::boolean or r#>>'{payload,subject}'<>'Original' or r#>>'{payload,stage}'<>'abandoned_checkout_1' then raise exception 'retry request changed'; end if;
 if not authorize_abandoned_checkout_v3(b,(r->>'claim_token')::uuid,allowed,(select generation from booking_checkout_ownership where booking_id=b),array['cs_recovery'],'abandoned_checkout_1') then raise exception 'owner denied'; end if;
 -- Paid after claim suppresses authorization.
 insert into payments(booking_id,provider,amount_usd,status) values(b,'stripe',999,'paid');
 if authorize_abandoned_checkout_v3(b,(r->>'claim_token')::uuid,allowed,(select generation from booking_checkout_ownership where booking_id=b),array['cs_recovery'],'abandoned_checkout_1') then raise exception 'paid after claim authorized'; end if;
 delete from payments where booking_id=b;
 -- Undo the ledger-churn probe's invalidation side effect (recording/removing
 -- probe money invalidates ownership); the refusal itself is proven at review-blockers.
 update booking_checkout_ownership set invalidated=false where booking_id=b;
 -- Cancelled after claim suppresses authorization.
 update bookings set status='cancelled' where id=b;
 if authorize_abandoned_checkout_v3(b,(r->>'claim_token')::uuid,allowed,(select generation from booking_checkout_ownership where booking_id=b),array['cs_recovery'],'abandoned_checkout_1') then raise exception 'cancelled after claim authorized'; end if;
 update bookings set status='awaiting_payment' where id=b;
 -- Undo the status-flip probe's fence side effects (both churn flags, same
 -- fixture-state restore as the status line above); refusals live at authorize.
 update booking_checkout_ownership set terms_invalidated=false,invalidated=false where booking_id=b;
 -- Stage 1 success writes a durable completion and stops further stage-1 sends.
 perform finalize_abandoned_checkout_stage((r->>'email_event_id')::uuid,(r->>'claim_token')::uuid,'abandoned_checkout_1',true,'local-only','{}',false);
 s1:=(stages->'abandoned_checkout_1'->>'completed_at')::timestamptz from abandoned_checkout_recovery where booking_id=b;
 if s1 is null then raise exception 'stage 1 completion not durable'; end if;
 a:=claim_abandoned_checkout(b,allowed,'{}');
 if (a->>'should_send')::boolean then raise exception 'stage 1 sent twice'; end if;
 -- No immediate catch-up: stage 2 is NOT due before 24h after stage 1.
 if due_abandoned_checkout_stage(b) is not null then raise exception 'stage 2 catch-up'; end if;
 update abandoned_checkout_recovery set stages=jsonb_set(stages,'{abandoned_checkout_1,completed_at}',to_jsonb(now()-interval '25 hours')) where booking_id=b;
 -- Stage 2 now due; its claim is distinct from stage 1 and gated the same way.
 if due_abandoned_checkout_stage(b) is distinct from 'abandoned_checkout_2' then raise exception 'stage 2 not due'; end if;
 a:=claim_abandoned_checkout(b,allowed,'{"to":"recovery@example.invalid","subject":"Original","text":"private","html":"private"}');
 if not (a->>'should_send')::boolean or a#>>'{payload,stage}'<>'abandoned_checkout_2' then raise exception 'stage 2 claim missing stage key'; end if;
 r:=claim_abandoned_checkout(b,allowed,'{}');
 if (r->>'should_send')::boolean then raise exception 'stage 2 double claim'; end if;
 if not authorize_abandoned_checkout_v3(b,(a->>'claim_token')::uuid,allowed,(select generation from booking_checkout_ownership where booking_id=b),array['cs_recovery'],'abandoned_checkout_2') then raise exception 'stage 2 owner denied'; end if;
 -- Authorizing with the wrong stage refuses.
 if authorize_abandoned_checkout_v3(b,(a->>'claim_token')::uuid,allowed,(select generation from booking_checkout_ownership where booking_id=b),array['cs_recovery'],'abandoned_checkout_1') then raise exception 'wrong stage authorized'; end if;
 -- Stage 2 success makes the booking permanently done: max two total.
 perform finalize_abandoned_checkout_stage((a->>'email_event_id')::uuid,(a->>'claim_token')::uuid,'abandoned_checkout_2',true,'local-only','{}',false);
 if due_abandoned_checkout_stage(b) is not null then raise exception 'stage 3 due'; end if;
 a:=claim_abandoned_checkout(b,allowed,'{}');
 if (a->>'should_send')::boolean then raise exception 'sent more than twice'; end if;
 -- Provider-blocked stage (e.g. unverified sending domain) suppresses instead
 -- of retrying into the wall, with the block durable in the stage journal.
 update abandoned_checkout_recovery set stages=stages-'abandoned_checkout_2' where booking_id=b;
 if due_abandoned_checkout_stage(b) is distinct from 'abandoned_checkout_2' then raise exception 'stage 2 not re-due'; end if;
 update public_booking_notifications set status='queued' where booking_id=b and template_key='abandoned_checkout_2';
 perform finalize_abandoned_checkout_stage((select email_event_id from public_booking_notifications where booking_id=b and template_key='abandoned_checkout_2'),(select claim_token from public_booking_notifications where booking_id=b and template_key='abandoned_checkout_2'),'abandoned_checkout_2',false,null,'{"error":"The 8lakestours.com domain is not verified. Please, add and verify your domain on https://resend.com/domains"}',true);
 if (select stages->'abandoned_checkout_2'->>'blocked_at' from abandoned_checkout_recovery where booking_id=b) is null then raise exception 'block not durable'; end if;
 if due_abandoned_checkout_stage(b) is not null then raise exception 'blocked stage still due'; end if;
 a:=claim_abandoned_checkout(b,allowed,'{}');
 if (a->>'should_send')::boolean then raise exception 'blocked stage claimed'; end if;
 -- No enrollment via historical update, even if submission key later appears.
 insert into bookings(customer_id,project_id,public_reference,tour_date) values(c,p,'HISTORIC-TEST','Scheduled fixture') returning id into b;
 update bookings set submission_key=gen_random_uuid() where id=b;
 if exists(select 1 from abandoned_checkout_recovery where booking_id=b) then raise exception 'historical blast'; end if;
end $$;
rollback;
