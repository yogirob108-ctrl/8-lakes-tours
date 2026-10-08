-- Run after tests/rebuild-8l-test.sh. Real PostgreSQL ownership and cross-sender race proof.
begin;
set local request.jwt.claim.role='service_role';
do $$
declare b uuid:=gen_random_uuid(); c uuid:=gen_random_uuid(); project uuid:=gen_random_uuid(); legacy jsonb; modern jsonb; manual uuid:=gen_random_uuid(); queued jsonb;
begin
 insert into public.tour_projects(id,slug,name) values(project,'post-trip-owner-fixture-'||substring(project::text,1,8),'Post trip ownership fixture');
 insert into public.customers(id,first_name,last_name,email) values(c,'Owner','Fixture','owner-fixture@example.invalid');
 insert into public.bookings(id,customer_id,project_id,public_reference,tour_date,status,guest_count,online_due_usd) values(b,c,project,'OWNER-'||substring(b::text,1,8),'1–3 September 2026','completed',1,999);
 -- Missing control is not an implicit legacy authorization: SQL NULL comparisons
 -- must fail closed before either sender can queue a delivery.
 delete from public.post_trip_sender_control where singleton=true;
 legacy:=public.claim_post_trip_email_dispatch('legacy',b,c,'post_trip_followup','owner-fixture@example.invalid','Feedback','body','ops',gen_random_uuid(),clock_timestamp());
 if coalesce((legacy->>'should_send')::boolean,false) or legacy->>'reason'<>'post_trip_sender_not_owner' then raise exception 'missing owner control did not fail closed: %',legacy; end if;
 insert into public.post_trip_sender_control(singleton,active_owner) values(true,'legacy');
 -- Default is legacy. Public sender is denied and legacy reserves the shared row.
 modern:=public.claim_lifecycle_email_dispatch(b,c,'post_trip_referral','owner-fixture@example.invalid','Referral','body','public',gen_random_uuid(),clock_timestamp());
 if coalesce((modern->>'should_send')::boolean,false) or modern->>'reason'<>'post_trip_sender_not_owner' then raise exception 'public was authorized before activation: %',modern; end if;
 legacy:=public.claim_post_trip_email_dispatch('legacy',b,c,'post_trip_followup','owner-fixture@example.invalid','Feedback','body','ops',gen_random_uuid(),clock_timestamp());
 if not coalesce((legacy->>'should_send')::boolean,false) then raise exception 'legacy did not claim default owner: %',legacy; end if;
 -- An unknown queued legacy claim fences public and manual write paths.
 queued:=public.claim_lifecycle_email_dispatch(b,c,'post_trip_referral','owner-fixture@example.invalid','Referral','body','public',gen_random_uuid(),clock_timestamp());
 if coalesce((queued->>'should_send')::boolean,false) or queued->>'reason' not in ('post_trip_sender_not_owner','unresolved_lifecycle_provider_outcome') then raise exception 'queued retention broken: %',queued; end if;
 if public.complete_post_trip_email_dispatch(b,(legacy->>'event_id')::uuid,(select claim_token::uuid from public.email_events where id=(legacy->>'event_id')::uuid),false,false,null,'{}'::jsonb) is distinct from true then raise exception 'legacy unknown completion failed'; end if;
 begin
   perform public.set_post_trip_sender_owner('public');
   raise exception 'handover accepted queued unknown outcome';
 exception when others then
   if position('unresolved queued dispatch' in sqlerrm)=0 then raise; end if;
 end;
 if public.complete_post_trip_email_dispatch(b,(legacy->>'event_id')::uuid,(select claim_token::uuid from public.email_events where id=(legacy->>'event_id')::uuid),false,true,null,'{}'::jsonb) is distinct from true then raise exception 'legacy definite failure completion failed'; end if;
 -- Failed is not sent; handover explicitly switches after there is no queued ambiguity.
 perform public.set_post_trip_sender_owner('public');
 modern:=public.claim_lifecycle_email_dispatch(b,c,'post_trip_referral','owner-fixture@example.invalid','Referral','body','public',manual,clock_timestamp());
 if not coalesce((modern->>'should_send')::boolean,false) then raise exception 'public did not claim activated owner: %',modern; end if;
 if public.complete_lifecycle_email_dispatch(b,(modern->>'event_id')::uuid,manual,true,false,'provider-fixture','{}'::jsonb) is distinct from true then raise exception 'public sent completion failed'; end if;
 -- Either key, including a manual recorded legacy key, suppresses the other direction.
 insert into public.email_events(booking_id,customer_id,template_key,to_email,subject,body_snapshot,sent_by,status) values(b,c,'post_trip_followup','owner-fixture@example.invalid','manual','','gmail-manual','sent');
 legacy:=public.claim_post_trip_email_dispatch('legacy',b,c,'post_trip_followup','owner-fixture@example.invalid','Feedback','body','ops',gen_random_uuid(),clock_timestamp());
 if coalesce((legacy->>'should_send')::boolean,false) then raise exception 'manual/referral sent alias did not suppress legacy: %',legacy; end if;
end $$;
rollback;
