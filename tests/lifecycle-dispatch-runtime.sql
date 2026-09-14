\set ON_ERROR_STOP on
-- PostgreSQL runtime regression. Run after the lifecycle dispatcher migration.
begin;
set request.jwt.claim.role='service_role';
do $$
declare p uuid; c uuid; b uuid; x jsonb; y jsonb; e uuid; tok uuid:=gen_random_uuid();
begin
 select id into strict p from public.tour_projects where slug='8-lakes-tours';
 insert into public.customers(first_name,last_name,email) values('Lifecycle','Runtime','lifecycle-runtime@example.invalid') returning id into c;
 insert into public.bookings(customer_id,project_id,public_reference,tour_date,status,online_due_usd,online_paid_usd)
 values(c,p,'LIFECYCLE-RUNTIME','Scheduled fixture','confirmed',999,999) returning id into b;
 -- concurrent claim equivalent: the first durable row wins, second sender cannot claim.
 x:=public.claim_lifecycle_email_dispatch(b,c,'preparation_packing','lifecycle-runtime@example.invalid','One','body','runtime',tok,clock_timestamp());
 if not (x->>'should_send')::boolean then raise exception 'first concurrent claimant did not win'; end if;
 y:=public.claim_lifecycle_email_dispatch(b,c,'insurance_final_check','lifecycle-runtime@example.invalid','Two','body','runtime',gen_random_uuid(),clock_timestamp());
 if (y->>'should_send')::boolean or y->>'reason' not in ('booking_lifecycle_lease_active','unresolved_lifecycle_provider_outcome') then raise exception 'concurrent sender claimed a second lifecycle email: %',y; end if;
 e:=(x->>'event_id')::uuid;
 if not public.mark_lifecycle_email_provider_attempted(b,e,tok,clock_timestamp()) then raise exception 'could not record provider attempt'; end if;
 -- queued unknown after an attempted provider call blocks all later lifecycle sends.
 y:=public.claim_lifecycle_email_dispatch(b,c,'insurance_final_check','lifecycle-runtime@example.invalid','Two','body','runtime',gen_random_uuid(),clock_timestamp());
 if (y->>'should_send')::boolean then raise exception 'queued unknown permitted later lifecycle mail'; end if;
 -- a definite failure is retry-safe only for the same UTC-day/template claim.
 if not public.complete_lifecycle_email_dispatch(b,e,tok,false,true,null,'{"provider":"definite_rejection"}',clock_timestamp()) then raise exception 'definite failure completion failed'; end if;
 tok:=gen_random_uuid();
 x:=public.claim_lifecycle_email_dispatch(b,c,'preparation_packing','lifecycle-runtime@example.invalid','One','body','runtime',tok,clock_timestamp());
 if not (x->>'should_send')::boolean or (x->>'event_id')::uuid<>e then raise exception 'definite failure was not safely retried'; end if;
 if not public.mark_lifecycle_email_provider_attempted(b,e,tok,clock_timestamp()) then raise exception 'retry attempt was not persisted'; end if;
 if not public.complete_lifecycle_email_dispatch(b,e,tok,true,false,'local-only','{}',clock_timestamp()) then raise exception 'sent completion failed'; end if;
 y:=public.claim_lifecycle_email_dispatch(b,c,'insurance_final_check','lifecycle-runtime@example.invalid','Two','body','runtime',gen_random_uuid(),clock_timestamp());
 if (y->>'should_send')::boolean or y->>'reason'<>'lifecycle_already_sent_utc_day' then raise exception 'daily claim did not cap lifecycle email'; end if;
 -- cancelled booking is fenced under the same booking lock.
 update public.bookings set status='cancelled' where id=b;
 y:=public.claim_lifecycle_email_dispatch(b,c,'final_checklist','lifecycle-runtime@example.invalid','Three','body','runtime',gen_random_uuid(),clock_timestamp()+interval '1 day');
 if (y->>'should_send')::boolean or y->>'reason'<>'booking_ineligible' then raise exception 'cancelled booking claimed lifecycle email'; end if;
end $$;
rollback;
